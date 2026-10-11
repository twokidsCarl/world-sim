"""Import the University of Denver Visible Human Female lower-extremity STLs (same donor,
segmented from the cryosections; millimetres, cryosection image frame) into the CT anchor frame.

Andreassen T.E. et al., Three-dimensional lower extremity musculoskeletal geometry of the Visible
Human Female and Male. Sci Data 10, 34 (2023). doi:10.1038/s41597-022-01905-2. CC BY 4.0.

The cadaver was not in exactly the same posture for the CT and for the cryosectioning, so one
rigid transform is not enough. Each Denver bone is fitted rigidly (trimmed ICP) to the CT-derived
bone; bones are exported with their own rigid fit (shape untouched), and soft tissue (muscles,
ligaments, cartilage) is carried by a thin-plate-spline field built from all bone fits of that leg.

Everything is delivered in the SCANNED (CT) pose. Each item lists the bones it follows when the
skeleton is re-posed (`follows`: origin and insertion bones for muscles).
"""
import os
import re
from collections import Counter

import nibabel as nib
import numpy as np
import trimesh
from scipy.interpolate import RBFInterpolator
from scipy.spatial import cKDTree

from anchorlib import apply, decimate, icp, kabsch, pca_axis, rot_angle_deg, sample_surface, signed_volume

SUBDIR = "Final 3D STL Models-stl"
ATTR = ("University of Denver Center for Orthopaedic Biomechanics, Visible Human lower-extremity geometry, CC BY 4.0: "
        "Andreassen T.E. et al., Sci Data 10, 34 (2023), doi:10.1038/s41597-022-01905-2; derived from the Visible Human "
        "Female, Courtesy of the U.S. National Library of Medicine")
SIDE = {"Left": ("L", "left"), "Right": ("R", "right")}

# Denver name -> (anchor name, male-name regex without side, origin bones, insertion bones)
# bone keys: hip sacrum lumbar femur patella tibia fibula tarsal metatarsal toes
MUSCLES = {
    "AdductorBrevis": ("adductor brevis", r"^adductor brevis$", ["hip"], ["femur"]),
    "AdductorLongus": ("adductor longus", r"^adductor longus$", ["hip"], ["femur"]),
    "AdductorMagnus": ("adductor magnus", r"^adductor (magnus|minimus)$", ["hip"], ["femur"]),
    "BicepsFemorisLong": ("biceps femoris, long head", r"^long head of {side} biceps femoris$", ["hip"], ["fibula", "tibia"]),
    "BicepsFemorisShort": ("biceps femoris, short head", r"^short head of {side} biceps femoris$", ["femur"], ["fibula", "tibia"]),
    "ExtensorDigitorumLongus": ("extensor digitorum longus", r"^extensor digitorum longus$", ["tibia", "fibula"], ["toes"]),
    "ExtensorHallucisLongus": ("extensor hallucis longus", r"^extensor hallucis longus$", ["fibula"], ["toes"]),
    "FlexorDigitorumLongus": ("flexor digitorum longus", r"^flexor digitorum longus$", ["tibia"], ["toes"]),
    "FlexorHallucisLongus": ("flexor hallucis longus", r"^flexor hallucis longus$", ["fibula"], ["toes"]),
    "GastrocnemiusLateral": ("gastrocnemius, lateral head", r"^lateral head of {side} gastrocnemius$", ["femur"], ["tarsal"]),
    "GastrocnemiusMedial": ("gastrocnemius, medial head", r"^medial head of {side} gastrocnemius$", ["femur"], ["tarsal"]),
    "GluteusMaximus": ("gluteus maximus", r"^gluteus maximus$", ["hip", "sacrum"], ["femur", "tibia"]),
    "GluteusMedius": ("gluteus medius", r"^gluteus medius$", ["hip"], ["femur"]),
    "GluteusMinimus": ("gluteus minimus", r"^gluteus minimus$", ["hip"], ["femur"]),
    "Gracilis": ("gracilis", r"^gracilis$", ["hip"], ["tibia"]),
    "Illiacus": ("iliacus", r"^iliacus$", ["hip"], ["femur"]),
    "InferiorGemellus": ("gemellus inferior", r"^gemellus inferior$", ["hip"], ["femur"]),
    "ObturatorExternus": ("obturator externus", r"^obturator externus$", ["hip"], ["femur"]),
    "ObturatorInternus": ("obturator internus", r"^obturator internus$", ["hip"], ["femur"]),
    "Pectineus": ("pectineus", r"^pectineus$", ["hip"], ["femur"]),
    "PeroneusLongus": ("fibularis (peroneus) longus", r"^fibularis longus$", ["fibula"], ["tarsal", "metatarsal"]),
    "Piriformis": ("piriformis", r"^piriformis$", ["sacrum"], ["femur"]),
    "Plantaris": ("plantaris", r"^plantaris$", ["femur"], ["tarsal"]),
    "Popliteus": ("popliteus", r"^popliteus$", ["femur"], ["tibia"]),
    "PsoasMajor": ("psoas major", r"^psoas major$", ["lumbar"], ["femur"]),
    "QuadratusFemoris": ("quadratus femoris", r"^quadratus femoris$", ["hip"], ["femur"]),
    "RectusFemoris": ("rectus femoris", r"^rectus femoris$", ["hip"], ["patella", "tibia"]),
    "Sartorius": ("sartorius", r"^sartorius$", ["hip"], ["tibia"]),
    "Semimembranosus": ("semimembranosus", r"^semimembranosus$", ["hip"], ["tibia"]),
    "Semitendinosus": ("semitendinosus", r"^semitendinosus$", ["hip"], ["tibia"]),
    "Soleus": ("soleus", r"^soleus$", ["tibia", "fibula"], ["tarsal"]),
    "SuperiorGemellus": ("gemellus superior", r"^gemellus superior$", ["hip"], ["femur"]),
    "TensorFasciaeLatae": ("tensor fasciae latae", r"^tensor fasciae latae$", ["hip"], ["tibia"]),
    "TibialisAnterior": ("tibialis anterior", r"^tibialis anterior$", ["tibia"], ["tarsal", "metatarsal"]),
    "TibialisPosterior": ("tibialis posterior", r"^tibialis posterior$", ["tibia", "fibula"], ["tarsal", "metatarsal"]),
    "VastusIntermedius": ("vastus intermedius", r"^vastus intermedius$", ["femur"], ["patella", "tibia"]),
    "VastusLateralis": ("vastus lateralis", r"^vastus lateralis$", ["femur"], ["patella", "tibia"]),
    "VastusMedialis": ("vastus medialis", r"^vastus medialis$", ["femur"], ["patella", "tibia"]),
}
ALIASES = {"BicepsFemorisLongHead": "BicepsFemorisLong", "BicepsFemorisShortHead": "BicepsFemorisShort",
           "QuadratisFemoris": "QuadratusFemoris", "Semitendonosus": "Semitendinosus"}
# Denver bone -> (anchor name, male regex, CT anchor it is fitted to, CT anchor(s) it duplicates or refines)
BONES = {
    "Pelvis": ("hip bone", r"^hip bone$", "hip"), "Femur": ("femur", r"^femur$", "femur"), "Patella": ("patella", r"^patella$", "patella"),
    "Tibia": ("tibia", r"^tibia$", "tibia"), "Fibula": ("fibula", r"^fibula$", "fibula"),
    "Talus": ("talus", r"^talus$", "tarsal"), "Calcaneous": ("calcaneus", r"^calcaneus$", "tarsal"),
    "Navicular": ("navicular bone", r"^navicular bone of .* foot$", "tarsal"), "Cuboid": ("cuboid bone", r"^cuboid bone$", "tarsal"),
    "MedialCuneiform": ("medial cuneiform bone", r"^medial cuneiform bone$", "tarsal"),
    "IntermediateCuneiform": ("intermediate cuneiform bone", r"^intermediate cuneiform bone$", "tarsal"),
    "LateralCuneiform": ("lateral cuneiform bone", r"^lateral cuneiform bone$", "tarsal"),
    "Phalanges": ("metatarsals and phalanges of foot", r"metatarsal bone$|phalanx of .* toe$", "forefoot"),
    "Sacrum": ("sacrum", r"^sacrum$", "sacrum"), "Coccyx": ("coccyx", r"^coccyx$", "sacrum"),
}
TARSALS = ["Talus", "Calcaneous", "Navicular", "Cuboid", "MedialCuneiform", "IntermediateCuneiform", "LateralCuneiform"]
LIGAMENTS = {"ACL": ("anterior cruciate ligament", r"^anterior cruciate ligament$"), "PCL": ("posterior cruciate ligament", r"^posterior cruciate ligament$"),
             "MCL": ("tibial (medial) collateral ligament", r"part of tibial collateral ligament$|^tibial collateral ligament$"),
             "LCL": ("fibular (lateral) collateral ligament", r"^fibular collateral ligament$")}
CARTILAGE = {"FemurHead": ("articular cartilage of head of femur", ["femur"]), "PelvisAcetabulum": ("articular cartilage of acetabulum", ["hip"]),
             "FemurDistal": ("articular cartilage of distal femur", ["femur"]), "Patella": ("articular cartilage of patella", ["patella"]),
             "TibiaMedial": ("articular cartilage of medial tibial condyle", ["tibia"]), "TibiaLateral": ("articular cartilage of lateral tibial condyle", ["tibia"]),
             "TibiaDistal": ("articular cartilage of distal tibia", ["tibia"]), "Talus": ("articular cartilage of talus", ["tarsal"])}
LIG_BONES = {"ACL": (["femur"], ["tibia"]), "PCL": (["femur"], ["tibia"]), "MCL": (["femur"], ["tibia"]), "LCL": (["femur"], ["fibula"])}


def available(denver_dir):
    d = os.path.join(denver_dir, SUBDIR)
    return os.path.isdir(d) and any(f.lower().endswith(".stl") for _, _, fs in os.walk(d) for f in fs)


def load(denver_dir):
    out = {}
    for folder in ("Left", "Right"):
        d = os.path.join(denver_dir, SUBDIR, folder)
        for fn in sorted(os.listdir(d)):
            m = re.match(r"VHF_(Left|Right)_(Bone|Muscle|Ligament|Cartilage|Fat)_(.+?)_smooth\.stl$", fn)
            if not m:
                continue
            side, cat, name = m.groups()
            name = ALIASES.get(name, name)
            mesh = trimesh.load(os.path.join(d, fn), process=False)
            mesh.merge_vertices()
            out[(cat, name, side)] = (np.asarray(mesh.vertices, dtype=float), np.asarray(mesh.faces))
    return out


def bone_ids(keys, side):
    """anchor ids a soft-tissue item follows"""
    m = {"hip": [f"VF_hip_{side}"], "sacrum": ["VF_sacrum"], "femur": [f"VF_femur_{side}"], "patella": [f"VF_patella_{side}"],
         "tibia": [f"VF_tibia_{side}"], "fibula": [f"VF_fibula_{side}"], "tarsal": [f"VF_tarsal_{side}"],
         "metatarsal": [f"VF_metatarsal_{side}"], "toes": [f"VF_toes_{side}"],
         "lumbar": ["VF_vertebrae_T12"] + [f"VF_vertebrae_L{n}" for n in range(1, 7)]}
    return [i for k in keys for i in m[k]]


def place(denver_dir, items, work, V2A, male, raw_seg_dir=None):
    D = load(denver_dir)
    cats = Counter(k[0] for k in D)
    S = lambda iid, n=30000: sample_surface(items[iid]["v"], items[iid]["f"], n)
    P = lambda k, n=8000: sample_surface(D[k][0], D[k][1], n)

    # ── frame: millimetre cryosection coordinates -> anchor frame, from bone centroids ────────
    cen_pairs = []
    for folder, (s, side) in SIDE.items():
        for dn, an in (("Pelvis", "hip"), ("Femur", "femur"), ("Tibia", "tibia"), ("Fibula", "fibula"), ("Patella", "patella")):
            cen_pairs.append((P(("Bone", dn, folder)).mean(0) / 1000.0, S(f"VF_{an}_{side}", 8000).mean(0)))
    A_, B_ = np.array([a for a, _ in cen_pairs]), np.array([b for _, b in cen_pairs])
    best = None
    for refl in (False, True):
        M = np.diag([-1.0, 1, 1]) if refl else np.eye(3)
        R, t = kabsch(A_ @ M.T, B_)
        res = float(np.sqrt((((A_ @ M.T) @ R.T + t - B_) ** 2).sum(1).mean()))
        if best is None or res < best[0]:
            best = (res, refl, R @ M, t)
    res0, mirrored, R0, t0 = best
    T0 = np.eye(4)
    T0[:3, :3], T0[:3, 3] = R0 * 0.001, t0            # includes mm -> m
    to_m = lambda v: v @ (R0.T) * 0.001 + t0           # Denver mm -> anchor frame, global fit
    G = {k: (to_m(v), f[:, ::-1] if mirrored else f) for k, (v, f) in D.items()}       # globally placed geometry
    Pg = lambda k, n=8000: sample_surface(G[k][0], G[k][1], n)

    # ── per-bone rigid fits ──────────────────────────────────────────────────────────────────
    fits, rep_bones = {}, []
    tgt_cache = {}

    def target(ids):
        key = "+".join(ids)
        if key not in tgt_cache:
            tgt_cache[key] = np.vstack([S(i) for i in ids])
        return tgt_cache[key]

    def fit(label, keys, ids, trim=0.9):
        src = np.vstack([Pg(k) for k in keys])
        T, rms = icp(src, target(ids), trim=trim)
        back = cKDTree(apply(T, src)).query(target(ids))[0]
        ext = lambda p: float(np.ptp((p - p.mean(0)) @ pca_axis(p)[1][0]))
        vol_d = sum(abs(signed_volume(*G[k])) for k in keys) * 1e6
        vol_c = sum(items[i]["stats"]["volume_voxel_ml"] for i in ids)
        rep_bones.append({"denver": label, "anchor": ids, "icp_rms_mm": round(rms * 1000, 2),
                          "ct_to_denver_mean_mm": round(float(back.mean()) * 1000, 2), "ct_to_denver_p95_mm": round(float(np.quantile(back, 0.95)) * 1000, 2),
                          "rotation_vs_global_deg": round(rot_angle_deg(T[:3, :3]), 2), "translation_vs_global_mm": round(float(np.linalg.norm(T[:3, 3])) * 1000, 1),
                          "length_ratio_denver_over_ct": round(ext(src) / ext(target(ids)), 3), "volume_denver_ml": round(vol_d, 1),
                          "volume_ct_ml": round(vol_c, 1), "volume_ratio_denver_over_ct": round(vol_d / vol_c, 3)})
        return T

    fits[("Sacrum", "M")] = fit("Sacrum+Coccyx", [("Bone", "Sacrum", "Left"), ("Bone", "Coccyx", "Left")], ["VF_sacrum"])
    for folder, (s, side) in SIDE.items():
        for dn, an in (("Pelvis", "hip"), ("Femur", "femur"), ("Patella", "patella"), ("Tibia", "tibia"), ("Fibula", "fibula")):
            fits[(dn, s)] = fit(f"{dn} {side}", [("Bone", dn, folder)], [f"VF_{an}_{side}"])
        fits[("Tarsals", s)] = fit(f"7 tarsals {side} (as one block)", [("Bone", n, folder) for n in TARSALS], [f"VF_tarsal_{side}"])
        fits[("Phalanges", s)] = fit(f"Phalanges {side} (metatarsals + phalanges)", [("Bone", "Phalanges", folder)],
                                     [f"VF_metatarsal_{side}", f"VF_toes_{side}"], trim=0.8)
    # posture difference between the two acquisitions: each bone's fit relative to its pelvis fit
    posture = {}
    for s, side in SIDE.values():
        base = fits[("Pelvis", s)]
        posture[side] = {dn.lower(): round(rot_angle_deg((fits[(dn, s)] @ np.linalg.inv(base))[:3, :3]), 2)
                         for dn in ("Femur", "Tibia", "Fibula", "Patella", "Tarsals", "Phalanges")}
    posture["sacrum_vs_left_hip_deg"] = round(rot_angle_deg((fits[("Sacrum", "M")] @ np.linalg.inv(fits[("Pelvis", "L")]))[:3, :3]), 2)
    posture["right_hip_vs_left_hip_deg"] = round(rot_angle_deg((fits[("Pelvis", "R")] @ np.linalg.inv(fits[("Pelvis", "L")]))[:3, :3]), 2)

    # ── seam check ───────────────────────────────────────────────────────────────────────────
    # The Denver femur comes from continuous cryosections. Fit it to the CT femur twice, once on
    # the part above the mid-thigh seam and once on the part below; if the CT is consistent across
    # the seam both fits put the seam cross-section of the Denver femur in the same place.
    seam_y = 0.7485
    seam = {}
    for folder, (s, side) in SIDE.items():
        src = Pg(("Bone", "Femur", folder), 40000)
        variants = {"seam_corrected_ct": S(f"VF_femur_{side}", 80000)}
        raw = raw_femur(raw_seg_dir, side, V2A) if raw_seg_dir else None
        if raw is not None:
            variants["uncorrected_ct"] = raw
        entry = {}
        for name, ct_pts in variants.items():
            Ts = {}
            for part, keep in (("above", lambda p: p[:, 1] > seam_y + 0.005), ("below", lambda p: p[:, 1] < seam_y - 0.005)):
                pre = apply(fits[("Femur", s)], src)
                Ts[part], rms_ = icp(src[keep(pre)], ct_pts[keep(ct_pts)], init=fits[("Femur", s)], trim=0.9)
                entry.setdefault(name, {})[f"rms_{part}_mm"] = round(rms_ * 1000, 2)
            pre = apply(fits[("Femur", s)], src)
            ring = src[np.abs(pre[:, 1] - seam_y) < 0.004]           # Denver femur cross-section at the seam
            dvec = (apply(Ts["below"], ring) - apply(Ts["above"], ring)).mean(0) * 1000
            entry[name]["mismatch_at_seam_mm (x=left, y=up, z=anterior)"] = dvec.round(2).tolist()
            entry[name]["mismatch_in_plane_mm"] = round(float(np.hypot(dvec[0], dvec[2])), 2)
            entry[name]["relative_rotation_deg"] = round(rot_angle_deg((Ts["below"] @ np.linalg.inv(Ts["above"]))[:3, :3]), 2)
        seam[side] = entry

    # ── soft-tissue field per leg ────────────────────────────────────────────────────────────
    rng = np.random.default_rng(3)

    def ctrl(keys_fit, per=260):
        C, Dv = [], []
        for keys, T in keys_fit:
            p = np.vstack([Pg(k, 3000) for k in keys])
            p = p[rng.choice(len(p), min(per, len(p)), replace=False)]
            C.append(p)
            Dv.append(apply(T, p) - p)
        return np.vstack(C), np.vstack(Dv)

    fields = {}
    for folder, (s, side) in SIDE.items():
        kf = [([("Bone", "Sacrum", "Left"), ("Bone", "Coccyx", "Left")], fits[("Sacrum", "M")])]
        for dn in ("Pelvis", "Femur", "Patella", "Tibia", "Fibula"):
            kf.append(([("Bone", dn, folder)], fits[(dn, s)]))
        kf.append(([("Bone", n, folder) for n in TARSALS], fits[("Tarsals", s)]))
        kf.append(([("Bone", "Phalanges", folder)], fits[("Phalanges", s)]))
        other = "Right" if folder == "Left" else "Left"
        kf.append(([("Bone", "Pelvis", other)], fits[("Pelvis", SIDE[other][0])]))
        C, Dv = ctrl(kf)
        f = RBFInterpolator(C, Dv, kernel="thin_plate_spline", smoothing=1e-5)
        fields[s] = (lambda x, f=f: x + f(x))

    # ── records ──────────────────────────────────────────────────────────────────────────────
    recs, placed = [], {}

    def rec(iid, name, s, kind, v, f, male_parts, follows, note, quality="good", reasons=(), duplicates=None, raw_key=None):
        corr = "none" if not male_parts else "one-to-one" if len(male_parts) == 1 else "group"
        fma = male_parts[0].get("fma") if corr == "one-to-one" else None
        if signed_volume(v, f) < 0:
            f = f[:, ::-1]
        placed[iid] = (v, f)
        recs.append({
            "id": iid, "name": name, "side": s, "kind": kind, "provenance": "scanned", "source": "denver",
            "segmentation": {"tool": "manual segmentation of cryosections (ScanIP), University of Denver", "task": "Final 3D STL Models",
                             "labels": [raw_key]},
            "fma": fma, "ontology_id": fma.replace("FMA", "FMA:") if fma else None,
            "male_parts": sorted(p["id"] for p in male_parts), "correspondence": corr,
            "quality": quality, "quality_reasons": list(reasons), "note": note, "follows": follows, "duplicates": duplicates,
            "triangles": int(len(f)), "bbox": np.r_[v.min(0), v.max(0)].round(5).tolist(), "centroid": v.mean(0).round(5).tolist(),
            "volume_ml": round(abs(signed_volume(v, f)) * 1e6, 2), "volume_voxel_ml": None, "pose": "both", "repose": None,
            "license": "CC BY 4.0", "attribution": ATTR, "_v": v, "_f": f, "_T": None})

    budget = {"Bone": (2.0, 30000), "Muscle": (6.0, 20000), "Ligament": (1.0, 4000), "Cartilage": (2.0, 8000), "Fat": (25.0, 60000)}
    for (cat, name, folder), (v, f) in sorted(G.items()):
        s, side = SIDE[folder]
        m = trimesh.Trimesh(v, f, process=False)
        per, cap = budget[cat]
        m = decimate(m, int(np.clip(m.area * 1e6 / per, 200, cap)))
        v, f = np.asarray(m.vertices), np.asarray(m.faces)
        raw_key = f"VHF_{folder}_{cat}_{name}"
        if cat == "Bone":
            an, rx, fitkey = BONES[name]
            if name in ("Sacrum", "Coccyx"):
                T, sd, sidew, iid = fits[("Sacrum", "M")], "M", "", f"VD_{an.split()[0]}"
            else:
                T = fits[("Tarsals" if name in TARSALS else name, s)]
                sd, sidew, iid = s, side + " ", f"VD_{name.lower().replace('calcaneous', 'calcaneus').replace('pelvis', 'hip')}_{side}"
            mp = male.select("skeletal", rx, sd)
            dup = {"hip": f"VF_hip_{side}", "femur": f"VF_femur_{side}", "patella": f"VF_patella_{side}", "tibia": f"VF_tibia_{side}",
                   "fibula": f"VF_fibula_{side}", "tarsal": f"VF_tarsal_{side}", "forefoot": f"VF_metatarsal_{side} + VF_toes_{side}",
                   "sacrum": "VF_sacrum"}[fitkey]
            follows = {"bones": [dup] if "+" not in dup else dup.split(" + ")}
            rec(iid, sidew + an, sd, "bone-group" if name == "Phalanges" else "bone", apply(T, v), f, mp, follows,
                "rigid fit of the Denver bone to the CT bone" + (" (all seven tarsals moved as one block)" if name in TARSALS else ""),
                duplicates=dup, raw_key=raw_key)
            recs[-1]["_fitlabel"] = ("Sacrum+Coccyx" if name in ("Sacrum", "Coccyx") else f"7 tarsals {side} (as one block)" if name in TARSALS
                                     else f"Phalanges {side} (metatarsals + phalanges)" if name == "Phalanges" else f"{name} {side}")
        elif cat == "Muscle":
            an, rx, org, ins = MUSCLES[name]
            mp = male.select("muscular", rx.format(side=side), s, full_name="{side}" in rx)
            follows = {"origin": bone_ids(org, side), "insertion": bone_ids(ins, side), "bones": bone_ids(org + ins, side)}
            rec(f"VD_{re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower().replace('illiacus', 'iliacus')}_{side}", f"{side} {an}", s, "muscle",
                fields[s](v), f, mp, follows, "carried by the bone-driven field of this leg", raw_key=raw_key)
        elif cat == "Ligament":
            an, rx = LIGAMENTS[name]
            mp = male.select(None, rx, s)
            o, i = LIG_BONES[name]
            rec(f"VD_{name.lower()}_{side}", f"{side} {an}", s, "ligament", fields[s](v), f, mp,
                {"origin": bone_ids(o, side), "insertion": bone_ids(i, side), "bones": bone_ids(o + i, side)},
                "carried by the bone-driven field of this leg", raw_key=raw_key)
        elif cat == "Cartilage":
            an, b = CARTILAGE[name]
            T = fits[({"hip": "Pelvis", "femur": "Femur", "patella": "Patella", "tibia": "Tibia", "tarsal": "Tarsals"}[b[0]], s)]
            rec(f"VD_cartilage_{re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()}_{side}", f"{side} {an}", s, "cartilage", apply(T, v), f, [],
                {"bones": bone_ids(b, side)}, "moves rigidly with its bone's fit", raw_key=raw_key)
        else:
            rec(f"VD_fat_{name.lower()}_{side}", f"{side} {name}", s, "surface", fields[s](v), f, [], {"bones": []}, "fat component", raw_key=raw_key)

    # ── checks against the CT ────────────────────────────────────────────────────────────────
    ct = np.asarray(nib.load(os.path.join(work, "ct_fixed.nii.gz")).dataobj)
    body = np.asarray(nib.load(os.path.join(work, "seg", "body.nii.gz")).dataobj)
    A2V = np.linalg.inv(V2A)

    def hu_inside(iid):
        v, f = placed[iid]
        m = trimesh.Trimesh(v, f, process=False)
        lo, hi = v.min(0), v.max(0)
        pts = lo + np.random.default_rng(5).random((6000, 3)) * (hi - lo)
        try:
            pts = pts[m.contains(pts)]
        except Exception:  # noqa: BLE001
            pts = pts[:0]
        if len(pts) < 30:
            pts = v
        ijk = np.rint(apply(A2V, pts)).astype(int)
        ok = np.all((ijk >= 0) & (ijk < np.array(ct.shape)), axis=1)
        ijk = ijk[ok]
        hu = ct[ijk[:, 0], ijk[:, 1], ijk[:, 2]]
        b = body[ijk[:, 0], ijk[:, 1], ijk[:, 2]] > 0
        return {"muscle_0_to_100_HU": round(float(((hu >= 0) & (hu <= 100)).mean()), 3), "fat_-190_to_-30_HU": round(float(((hu < -30) & (hu > -190)).mean()), 3),
                "bone_above_200_HU": round(float((hu > 200).mean()), 3), "outside_body": round(float((~b).mean()), 3), "median_HU": int(np.median(hu))}

    # where is the bone edge in the CT itself? mean HU profile along the outward normal of each surface;
    # the edge is the half-height crossing between the cortical peak and the soft tissue outside
    from scipy import ndimage as ndi

    def edge_offset(v, f, n=6000):
        m = trimesh.Trimesh(v, f, process=False)
        pts, fid = trimesh.sample.sample_surface(m, n, seed=2)
        nrm = m.face_normals[fid]
        steps = np.arange(-4.0, 4.01, 0.25) / 1000.0
        prof = []
        for t_ in steps:
            q = apply(A2V, pts + t_ * nrm)
            prof.append(ndi.map_coordinates(ct, q.T, order=1, mode="nearest"))
        prof = np.array(prof)                                    # steps x points
        mean = prof.mean(1)
        k = int(np.argmax(mean))
        outside = mean[-4:].mean()
        half = (mean[k] + outside) / 2
        for j in range(k, len(steps) - 1):
            if mean[j] >= half > mean[j + 1]:
                return round(float((steps[j] + (mean[j] - half) / (mean[j] - mean[j + 1]) * 0.00025) * 1000), 2)
        return None

    edges = []
    for folder, (s, side) in SIDE.items():
        for dn, an in (("Pelvis", "hip"), ("Femur", "femur"), ("Patella", "patella"), ("Tibia", "tibia"), ("Fibula", "fibula")):
            vd, fd = G[("Bone", dn, folder)]
            vd = apply(fits[(dn, s)], vd)
            if signed_volume(vd, fd) < 0:
                fd = fd[:, ::-1]
            it = items[f"VF_{an}_{side}"]
            edges.append({"bone": f"{dn} {side}", "ct_edge_relative_to_denver_surface_mm": edge_offset(vd, fd),
                          "ct_edge_relative_to_ct_label_surface_mm": edge_offset(it["v"], it["f"])})

    mus = [r for r in recs if r["kind"] == "muscle"]
    hu = {r["id"]: hu_inside(r["id"]) for r in mus}
    musc_frac = np.array([h["muscle_0_to_100_HU"] for h in hu.values()])
    worst = sorted(hu.items(), key=lambda kv: kv[1]["muscle_0_to_100_HU"])[:6]
    vs_ct = []
    for dn, vf in (("gluteus_maximus", "gluteus_maximus"), ("gluteus_medius", "gluteus_medius"), ("gluteus_minimus", "gluteus_minimus"),
                   ("iliacus", "iliacus"), ("psoas_major", "psoas_major")):
        for side in ("left", "right"):
            a, b = placed[f"VD_{dn}_{side}"], (items[f"VF_{vf}_{side}"]["v"], items[f"VF_{vf}_{side}"]["f"])
            pa, pb = sample_surface(*a, 8000), sample_surface(*b, 8000)
            d1, d2 = cKDTree(pb).query(pa)[0], cKDTree(pa).query(pb)[0]
            vs_ct.append({"muscle": f"{dn}_{side}", "denver_ml": round(abs(signed_volume(*a)) * 1e6, 1), "ct_ml": items[f"VF_{vf}_{side}"]["stats"]["volume_voxel_ml"],
                          "denver_to_ct_mean_mm": round(float(d1.mean()) * 1000, 1), "ct_to_denver_mean_mm": round(float(d2.mean()) * 1000, 1),
                          "centroid_distance_mm": round(float(np.linalg.norm(a[0].mean(0) - b[0].mean(0))) * 1000, 1)})

    # ── which bone source to prefer ──────────────────────────────────────────────────────────
    edge_by = {e["bone"]: e for e in edges}
    prefer = []
    for b in rep_bones:
        lab = b["denver"]
        e = edge_by.get(lab)
        if "Phalanges" in lab:
            choice, why = "CT", "Denver lumps metatarsals and phalanges into one mesh; MOOSE separates metatarsals from toes"
        elif "7 tarsals" in lab:
            choice, why = "Denver", "seven individual tarsal bones against one CT group label"
        elif "Sacrum" in lab:
            choice, why = "CT", "CT bone is continuous with the lumbar spine anchors; Denver adds a separate coccyx"
        elif e and e["ct_edge_relative_to_denver_surface_mm"] is not None and e["ct_edge_relative_to_ct_label_surface_mm"] is not None:
            dd, dc = e["ct_edge_relative_to_denver_surface_mm"], e["ct_edge_relative_to_ct_label_surface_mm"]
            # Both are within about a millimetre of the edge, with opposite bias (CT label slightly fat, Denver slightly
            # thin). That is not enough to justify mixing sources bone by bone, which would break joint congruency.
            choice = "CT"
            why = (f"sub-millimetre disagreement with opposite bias: the CT's own cortical edge lies {dd:+.2f} mm from the Denver surface "
                   f"and {dc:+.2f} mm from the CT label surface (positive = edge outside the surface); CT keeps one consistent skeleton")
        else:
            choice, why = "CT", "no edge estimate; CT keeps the bone consistent with the rest of the scanned skeleton"
        prefer.append({"bone": lab, "prefer": choice, "reason": why, "rms_mm": b["icp_rms_mm"], "volume_ratio_denver_over_ct": b["volume_ratio_denver_over_ct"]})
    for r in recs:                                             # quality flags
        why = None
        if r["kind"] == "bone" and re.search(r"talus|calcaneus|navicular|cuboid|cuneiform", r["id"]):
            why = "the seven tarsals were fitted to the CT tarsal group as one rigid block (3.2 mm RMS); no individual fit"
        elif r["id"].startswith("VD_psoas_major"):
            why = "upper part lies above the Denver bones: placed by extrapolating the leg field along the lumbar spine"
        elif r["kind"] == "muscle" and r["volume_ml"] < 5:
            why = "very small structure (under 5 ml)"
        elif r["kind"] == "muscle" and hu[r["id"]]["muscle_0_to_100_HU"] < 0.65:
            why = (f"only {round(100 * hu[r['id']]['muscle_0_to_100_HU'])} % of its interior is at muscle density in the CT "
                   f"({round(100 * hu[r['id']]['fat_-190_to_-30_HU'])} % fat density): fatty muscle or a few millimetres of misplacement")
        elif r["kind"] == "ligament":
            why = "thin structure carried by the field; a few millimetres of placement error is a large fraction of its width"
        if why:
            r["quality"] = "usable"
            r["quality_reasons"].append(why)
    choice = {p["bone"]: p["prefer"] == "Denver" for p in prefer}
    for r in recs:
        lab = r.pop("_fitlabel", None)
        if r["kind"] in ("bone", "bone-group"):
            r["preferred"] = bool(choice.get(lab, False)) and r["id"] != "VD_coccyx"
        elif r["kind"] == "muscle":
            r["preferred"] = True           # one consistent, non-overlapping manual set for the whole leg
    rms = np.array([b["icp_rms_mm"] for b in rep_bones])
    report = {
        "files": {"stl": len(D), "by_category": dict(cats)},
        "frame": {"units_in": "millimetre", "mirrored_axis_needed": bool(mirrored), "global_fit_rms_on_bone_centroids_mm": round(res0 * 1000, 2),
                  "global_transform_mm_to_anchor_m": T0.round(8).ravel().tolist()},
        "bones": rep_bones,
        "posture_difference_cryosection_vs_ct_deg (bone fit relative to same-side hip bone fit)": posture,
        "seam_check_femur": seam,
        "muscles_interior_HU": {"median_fraction_in_muscle_range": round(float(np.median(musc_frac)), 3), "min": round(float(musc_frac.min()), 3),
                                "lowest": [{"id": k, **v} for k, v in worst]},
        "muscles_vs_ct_segmentation": vs_ct,
        "bone_edge_check": edges,
        "bone_preference": prefer,
        "absent": ["fat components (intermuscular and outer fat are not in the 'Final 3D STL Models' archive: no *_Fat_* file)",
                   "menisci", "pubis / ischium / ilium as separate meshes (the hip bone is one mesh)", "individual metatarsals and phalanges"],
        "summary": {"exported": len(recs), "by_kind": dict(Counter(r["kind"] for r in recs)),
                    "bone_icp_rms_mm": {"median": round(float(np.median(rms)), 2), "max": round(float(rms.max()), 2)}},
    }
    return recs, report


def raw_femur(seg_dir, side, V2A):
    """surface points of the femur from the label map BEFORE the seam correction"""
    from scipy import ndimage as ndi
    from skimage import measure
    from totalsegmentator.map_to_binary import class_map
    path = os.path.join(seg_dir, "total.nii.gz")
    if not os.path.exists(path):
        return None
    lab = np.asarray(nib.load(path).dataobj)
    i = {v: k for k, v in class_map["total"].items()}[f"femur_{side}"]
    sl = ndi.find_objects((lab == i).astype(np.uint8))[0]
    m = np.pad(lab[sl] == i, 2)
    v, f, _, _ = measure.marching_cubes(ndi.gaussian_filter(m.astype(np.float32), 0.7), 0.5)
    v = v - 2 + np.array([s.start for s in sl])
    return sample_surface(apply(V2A, v), f, 60000)
