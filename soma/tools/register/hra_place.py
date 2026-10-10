"""Place the HRA female-specific organs into the CT anchor frame.

HRA "united female" is an artist-remodelled, A-posed model of the same donor. Its bones are
fitted rigidly (trimmed ICP) one by one onto the CT-derived bones; the per-bone motions are then
blended into a smooth displacement field (thin-plate-spline RBF over points sampled on the HRA
bones) which carries the soft organs. Two fields are built: pelvis (L4-L6, sacrum + coccyx,
ilia, proximal femora) for the reproductive organs, ligaments and uterine vessels, and chest
(sternum, manubrium, T1-T10) for the mammary glands.

Everything exported here is `curated` (remodelled geometry, placed by bones), never `scanned`.
"""
import csv
import os
import re
from collections import Counter

import nibabel as nib
import numpy as np
import trimesh
from scipy.interpolate import RBFInterpolator
from scipy.spatial import ConvexHull, Delaunay, cKDTree

from anchorlib import apply, decimate, icp, kabsch, pca_axis, rot_angle_deg, sample_surface, signed_volume

HRA_ATTR = ("Human Reference Atlas 3D Reference Object Library (HuBMAP / HRA), CC BY 4.0; "
            "modelled from the Visible Human Female, " "Courtesy of the U.S. National Library of Medicine")
ORD = ["cervical", "thoracic", "lumbar"]


def bone_pairs():
    P = {}
    for n in range(1, 8):
        P[f"VH_F_cervical_vertebra_{n}"] = f"VF_vertebrae_C{n}"
    for n in range(1, 13):
        P[f"VH_F_thoracic_vertebra_{n}"] = f"VF_vertebrae_T{n}"
    for n in range(1, 7):
        P[f"VH_F_lumbar_vertebra_{n}"] = f"VF_vertebrae_L{n}"
    P["VH_F_sacrum+VH_F_coccyx"] = "VF_sacrum"
    P["VH_F_sternum+VH_F_manubrium"] = "VF_sternum"
    for s, side in (("L", "left"), ("R", "right")):
        P[f"VH_F_ilium_compact_bone_{s}"] = f"VF_hip_{side}"
        for b in ("femur", "tibia", "fibula", "patella"):
            P[f"VH_F_{b}_{s}"] = f"VF_{b}_{side}"
    return P


def load_scene(path):
    sc = trimesh.load(path, force="scene", process=False)
    parents = sc.graph.transforms.parents
    nodes = {}
    for node in sc.graph.nodes_geometry:
        tf, g = sc.graph[node]
        m = sc.geometry[g]
        chain, cur = [], node
        while cur in parents:
            cur = parents[cur]
            chain.append(cur)
        nodes[node] = (trimesh.transformations.transform_points(np.asarray(m.vertices), tf), np.asarray(m.faces), "/".join(reversed(chain)))
    return nodes


def export_group(path, name):
    if "placenta" in path or "placenta" in name:
        return None
    if "VH_F_reproductive_system" in path:
        if "ligament" in path or "ligament" in name or re.search(r"meso(salpinx|varium)|broad_ligament", name):
            return "ligament"
        return "organ"
    if "VH_F_mammary_gland" in path:
        return "breast"
    if re.search(r"uterine_(artery|vein)", name):
        return "vessel"
    return None


def tps(ctrl, disp, smoothing):
    return RBFInterpolator(ctrl, disp, kernel="thin_plate_spline", smoothing=smoothing)


def place(hra_dir, items, work, V2A):
    nodes = load_scene(os.path.join(hra_dir, "3d-vh-f-united.glb"))
    cw = {r["node_name"]: r for r in csv.DictReader(open(os.path.join(hra_dir, "crosswalk.united-female.csv")))}

    def hra_pts(key, n=5000):
        vs = [sample_surface(nodes[k][0], nodes[k][1], n) for k in key.split("+")]
        return np.vstack(vs)

    pairs = bone_pairs()
    tgt = {v: sample_surface(items[v]["v"], items[v]["f"], 30000) for v in set(pairs.values())}
    src = {k: hra_pts(k) for k in pairs}
    # global start: Kabsch on the centroids of the axial bones (pose-independent part of the skeleton)
    axial = [k for k in pairs if re.search(r"vertebra|sacrum|sternum", k)]
    R0, t0 = kabsch(np.array([src[k].mean(0) for k in axial]), np.array([tgt[pairs[k]].mean(0) for k in axial]))
    T0 = np.eye(4)
    T0[:3, :3], T0[:3, 3] = R0, t0
    fits, bones_report = {}, []
    for k, v in pairs.items():
        T, rms = icp(src[k], tgt[v], init=T0, trim=0.8 if "ilium" in k else 0.9)
        fits[k] = T
        ext = lambda p: float(np.ptp((p - p.mean(0)) @ pca_axis(p)[1][0]))
        rel = T @ np.linalg.inv(T0)
        bones_report.append({"hra": k, "anchor": v, "icp_rms_mm": round(rms * 1000, 2),
                             "rotation_vs_global_fit_deg": round(rot_angle_deg(rel[:3, :3]), 1),
                             "length_ratio_hra_over_ct": None if "ilium" in k else round(ext(src[k]) / ext(tgt[v]), 3)})

    def field(keys, proximal_femur=True, per=220, smoothing=1e-5):
        C, D = [], []
        for k in keys:
            p = src[k]
            if "femur" in k and proximal_femur:           # only the head / neck region: the thigh is posed differently
                y = p[:, 1]
                p = p[y > y.max() - 0.09]
            idx = np.random.default_rng(1).choice(len(p), min(per, len(p)), replace=False)
            C.append(p[idx])
            D.append(apply(fits[k], p[idx]) - p[idx])
        C, D = np.vstack(C), np.vstack(D)
        f = tps(C, D, smoothing)
        Rr, tr = kabsch(C, C + D)
        return (lambda x: x + f(x)), (lambda x: x @ Rr.T + tr), C, D

    pelvis_keys = [f"VH_F_lumbar_vertebra_{n}" for n in (4, 5, 6)] + ["VH_F_sacrum+VH_F_coccyx", "VH_F_ilium_compact_bone_L",
                                                                       "VH_F_ilium_compact_bone_R", "VH_F_femur_L", "VH_F_femur_R"]
    chest_keys = ["VH_F_sternum+VH_F_manubrium"] + [f"VH_F_thoracic_vertebra_{n}" for n in range(1, 11)]
    warp_p, rigid_p, Cp, Dp = field(pelvis_keys)
    warp_c, rigid_c, Cc, Dc = field(chest_keys)

    # control residual: how far the smooth field is from the per-bone rigid motions it was built from
    def ctrl_res(warp, keys):
        d = []
        for k in keys:
            p = src[k][:1500]
            if "femur" in k:
                p = p[p[:, 1] > src[k][:, 1].max() - 0.09]
            d.append(np.linalg.norm(warp(p) - apply(fits[k], p), axis=1))
        d = np.concatenate(d)
        return {"mean_mm": round(float(d.mean()) * 1000, 2), "p95_mm": round(float(np.quantile(d, 0.95)) * 1000, 2)}

    recs, placed = [], {}
    nonrigid = {"pelvis": [], "chest": []}
    for name, (v, f, path) in sorted(nodes.items()):
        kind = export_group(path, name)
        if kind is None:
            continue
        which = "chest" if kind == "breast" else "pelvis"
        warp, rigid = (warp_c, rigid_c) if which == "chest" else (warp_p, rigid_p)
        m = trimesh.Trimesh(v, f, process=False)
        m.merge_vertices()
        m = decimate(m, int(np.clip(m.area * 1e6 / 1.5, 300, 20000)))
        v0, f0 = np.asarray(m.vertices), np.asarray(m.faces)
        v1 = warp(v0)
        nonrigid[which].append(np.linalg.norm(v1 - rigid(v0), axis=1))
        if signed_volume(v1, f0) < 0:
            f0 = f0[:, ::-1]
        row = cw.get(name, {})
        oid = row.get("OntologyID") or None
        side = "L" if re.search(r"(_L$|left)", name) else "R" if re.search(r"(_R$|right)", name) else "M"
        placed[name] = (v1, f0)
        recs.append({
            "id": "HRA_" + name.replace("VH_F_", ""), "name": (row.get("label") or name.replace("VH_F_", "").replace("_", " ")),
            "side": side, "kind": "organ" if kind == "breast" else kind, "provenance": "curated", "source": "hra",
            "hra_node": name, "hra_path": path, "segmentation": None,
            "ontology_id": oid, "fma": oid.replace("FMA:", "FMA") if oid and oid.startswith("FMA:") else None,
            "male_parts": [], "correspondence": "none",
            "quality": "usable",
            "quality_reasons": ["artist-remodelled HRA geometry placed by a bone-driven field; not this donor's scanned organ"] +
                               (["standing A-pose breast shape: protrudes about 40 mm beyond the supine CT skin (VF_body_surface); "
                                 "the donor's own supine breast is VF_breast_*"] if kind == "breast" else []),
            "note": f"{which} field", "triangles": int(len(f0)), "bbox": np.r_[v1.min(0), v1.max(0)].round(5).tolist(),
            "centroid": v1.mean(0).round(5).tolist(), "volume_ml": round(abs(signed_volume(v1, f0)) * 1e6, 2), "volume_voxel_ml": None,
            "pose": "both", "repose": None, "license": "CC BY 4.0", "attribution": HRA_ATTR, "_v": v1, "_f": f0, "_T": None,
        })

    # ── plausibility against the CT ───────────────────────────────────────────────────────────
    from totalsegmentator.map_to_binary import class_map
    cm = {v: k for k, v in class_map["total"].items()}
    names = {k: v for v, k in cm.items()}
    total = np.asarray(nib.load(os.path.join(work, "seg", "total.nii.gz")).dataobj)
    ct = np.asarray(nib.load(os.path.join(work, "ct_fixed.nii.gz")).dataobj)
    body = np.asarray(nib.load(os.path.join(work, "seg", "body.nii.gz")).dataobj)
    breasts = np.asarray(nib.load(os.path.join(work, "seg", "breasts.nii.gz")).dataobj)
    A2V = np.linalg.inv(V2A)

    def vox(p):
        ijk = np.rint(apply(A2V, p)).astype(int)
        ok = np.all((ijk >= 0) & (ijk < np.array(total.shape)), axis=1)
        return ijk[ok]

    def interior(keys, shrink=(0.0, 0.3, 0.6, 0.85)):
        pts = []
        for k in keys:
            v, _ = placed[k]
            c = v.mean(0)
            pts += [c + (1 - s) * (v - c) for s in shrink]
        return np.vstack(pts)

    def composition(keys):
        ijk = vox(interior(keys))
        lab = total[ijk[:, 0], ijk[:, 1], ijk[:, 2]]
        hu = ct[ijk[:, 0], ijk[:, 1], ijk[:, 2]]
        cnt = Counter(names.get(int(l), "unlabelled") for l in lab)
        top = {k: round(v / len(lab), 3) for k, v in cnt.most_common(6)}
        bone = sum(v for k, v in cnt.items() if re.search(r"hip|sacrum|femur|vertebra|rib|sternum", k)) / len(lab)
        return {"label_fractions": top, "inside_bone_fraction": round(bone, 4),
                "HU": {"median": int(np.median(hu)), "soft_tissue_0_to_100": round(float(((hu >= 0) & (hu <= 100)).mean()), 3),
                       "fat_below_-30": round(float(((hu < -30) & (hu > -300)).mean()), 3), "gas_below_-300": round(float((hu < -300).mean()), 3),
                       "bone_above_200": round(float((hu > 200).mean()), 3)}}

    mm = lambda a: (np.asarray(a) * 1000).round(1).tolist()
    S = lambda iid, n=20000: sample_surface(items[iid]["v"], items[iid]["f"], n)
    ut_keys = [k for k in placed if re.search(r"VH_F_(body_of_uterus|fundus_of_uterus|cervix|lower_uterine_segment|anterior_wall_of_uterus|posterior_wall_of_uterus|cornua)$", k)]
    ut = np.vstack([placed[k][0] for k in ut_keys])
    bl = S("VF_urinary_bladder")
    col = S("VF_colon", 60000)
    sac = S("VF_sacrum")
    hips = np.vstack([S("VF_hip_left"), S("VF_hip_right")])
    rectum = col[(np.abs(col[:, 0] - sac[:, 0].mean()) < 0.045) & (col[:, 1] < sac[:, 1].mean() + 0.02) & (col[:, 1] > hips[:, 1].min())]
    symph = hips[np.abs(hips[:, 0] - sac[:, 0].mean()) < 0.012]          # hip-bone surface next to the midline = pubic symphysis
    rep = {"uterus": {
        "centroid_mm": mm(ut.mean(0)), "bladder_centroid_mm": mm(bl.mean(0)),
        "rectum_centroid_mm": mm(rectum.mean(0)) if len(rectum) else None,
        "anteroposterior_order_bladder>uterus>rectum": bool(len(rectum) and bl[:, 2].mean() > ut[:, 2].mean() > rectum[:, 2].mean()),
        "gap_to_bladder_mm": round(float(cKDTree(bl).query(ut)[0].min()) * 1000, 1),
        "gap_to_rectum_mm": round(float(cKDTree(rectum).query(ut)[0].min()) * 1000, 1) if len(rectum) else None,
        "midline_offset_mm": round(float(ut[:, 0].mean() - sac[:, 0].mean()) * 1000, 1),
        "centroid_above_pubic_symphysis_top_mm": round(float(ut[:, 1].mean() - symph[:, 1].max()) * 1000, 1),
        "centroid_below_sacral_promontory_mm": round(float(sac[:, 1].max() - ut[:, 1].mean()) * 1000, 1),
        "centroid_behind_pubic_symphysis_mm": round(float(symph[:, 2].mean() - ut[:, 2].mean()) * 1000, 1),
        "content_at_placed_position": composition(ut_keys)}}
    hull = Delaunay(np.vstack([hips, sac])[ConvexHull(np.vstack([hips, sac])).vertices])
    rep["ovaries"] = {}
    for side, key in (("left", "VH_F_left_ovary"), ("right", "VH_F_right_ovary")):
        v = placed[key][0]
        c = v.mean(0)
        hb = S(f"VF_hip_{side}")
        rep["ovaries"][side] = {
            "centroid_mm": mm(c), "inside_convex_hull_of_pelvic_bones": bool(hull.find_simplex(c[None])[0] >= 0),
            "fraction_of_vertices_inside_hull": round(float((hull.find_simplex(v) >= 0).mean()), 3),
            "height_between_ischium(0)_and_iliac_crest(1)": round(float((c[1] - hb[:, 1].min()) / np.ptp(hb[:, 1])), 2),
            "distance_to_same_side_hip_bone_mm": round(float(cKDTree(hb).query(v)[0].min()) * 1000, 1),
            "lateral_offset_from_midline_mm": round(float(c[0] - sac[:, 0].mean()) * 1000, 1),
            "content_at_placed_position": composition([key])}
    vg = [k for k in placed if re.search(r"VH_F_vagina$", k)]
    if vg:
        v = placed[vg[0]][0]
        rep["vagina"] = {"centroid_mm": mm(v.mean(0)), "gap_to_bladder_mm": round(float(cKDTree(bl).query(v)[0].min()) * 1000, 1),
                         "content_at_placed_position": composition(vg)}
    rep["breasts"] = {}
    skin = S("VF_body_surface", 200000)
    for s, side in (("L", "left"), ("R", "right")):
        keys = [k for k in placed if re.search(rf"VH_F_(fat|mammary_lobes|main_lactiferous_ducts|suspensory_ligaments)_{s}$", k)]
        v = np.vstack([placed[k][0] for k in keys])
        nip = placed[f"VH_F_nipple_{s}"][0].mean(0)
        ctb = S(f"VF_breast_{side}")
        ijk = vox(v)
        nv = vox(nip[None])
        d_skin = float(cKDTree(skin).query(nip)[0])
        rep["breasts"][side] = {
            "hra_centroid_mm": mm(v.mean(0)), "ct_breast_centroid_mm": mm(ctb.mean(0)),
            "offset_hra_minus_ct_mm (x=left, y=up, z=anterior)": mm(v.mean(0) - ctb.mean(0)),
            "offset_norm_mm": round(float(np.linalg.norm(v.mean(0) - ctb.mean(0))) * 1000, 1),
            "fraction_of_hra_breast_inside_ct_body": round(float((body[ijk[:, 0], ijk[:, 1], ijk[:, 2]] > 0).mean()), 3),
            "fraction_of_hra_breast_inside_ct_breast_label": round(float((breasts[ijk[:, 0], ijk[:, 1], ijk[:, 2]] > 0).mean()), 3),
            "nipple_mm": mm(nip), "nipple_to_ct_skin_mm": round(d_skin * 1000, 1),
            "nipple_inside_ct_body": bool(len(nv) and body[nv[0, 0], nv[0, 1], nv[0, 2]] > 0),
            "hra_volume_ml": round(sum(abs(signed_volume(*placed[k])) for k in keys if re.search(r"_fat_", k)) * 1e6, 0),
            "ct_breast_volume_ml": items[f"VF_breast_{side}"]["stats"]["volume_voxel_ml"]}
    nr = lambda a: {"mean_mm": round(float(np.concatenate(a).mean()) * 1000, 1), "max_mm": round(float(np.concatenate(a).max()) * 1000, 1)}
    # what else HRA has that is in neither the CT anchors nor BodyParts3D (candidates, not exported)
    groups = Counter()
    for name, (_, _, path) in nodes.items():
        if export_group(path, name) or "placenta" in path or "Allen_brain" in path or name == "VH_F_skin":
            continue
        parts = path.split("/")
        groups["/".join(p.replace("VH_F_", "") for p in parts[1:3])] += 1
    rms = np.array([b["icp_rms_mm"] for b in bones_report])
    report = {
        "method": "per-bone trimmed ICP (HRA bone -> CT bone), then thin-plate-spline displacement field over HRA bone samples",
        "global_fit_rotation_deg": round(rot_angle_deg(T0[:3, :3]), 2),
        "bones": bones_report,
        "fields": {"pelvis": {"control_bones": pelvis_keys, "control_points": int(len(Cp)), "residual_vs_bone_fits": ctrl_res(warp_p, pelvis_keys),
                              "deviation_from_single_rigid_at_organs": nr(nonrigid["pelvis"])},
                   "chest": {"control_bones": chest_keys, "control_points": int(len(Cc)), "residual_vs_bone_fits": ctrl_res(warp_c, chest_keys),
                             "deviation_from_single_rigid_at_organs": nr(nonrigid["chest"])}},
        "checks": rep,
        "not_exported_candidates": dict(sorted(groups.items(), key=lambda kv: -kv[1])),
        "summary": {"exported": len(recs), "by_kind": dict(Counter(r["kind"] for r in recs)),
                    "bone_icp_rms_mm": {"median": round(float(np.median(rms)), 2), "max": round(float(rms.max()), 2),
                                        "worst": max(bones_report, key=lambda b: b["icp_rms_mm"])["hra"]}},
    }
    return recs, report, fits
