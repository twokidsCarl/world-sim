#!/usr/bin/env python3
"""Step 3 of the anchor package: meshes -> soma convention, kinematics and arm re-posing,
male correspondences, HRA female organs placed in the CT frame, manifest + binaries + reports.

Usage (from the repository root):
  python -I tools/register/build_package.py WORK_DIR OUT_DIR MALE_DIR BP3D_DIR HRA_DIR
    WORK_DIR  output of fix_volume.py + build_meshes.py
    OUT_DIR   package directory (manifest.json, scanned.bin, reposed.bin, README.md, SANITY.md, preview/)
    MALE_DIR  public/anatomy/male (anatomy.json)
    BP3D_DIR  data/raw/bodyparts3d (male OBJ geometry for landmarks and size ratios)
    HRA_DIR   data/raw/female/hra (3d-vh-f-united.glb, crosswalk.united-female.csv)
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

import nibabel as nib
import numpy as np
import trimesh
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anchor_spec  # noqa: E402
import denver_import  # noqa: E402
import hra_place  # noqa: E402
import wu_place  # noqa: E402
from anchorlib import (BinWriter, apply, ct_edge_offset, end_slab, frame, kabsch, load_bp3d_obj, pca_axis, ransac_sphere,  # noqa: E402
                       render, rigid_about, rot_angle_deg, sample_surface, unit)

NLM = "Courtesy of the U.S. National Library of Medicine"
SIDES = {"L": "left", "R": "right"}
DENVER_DIR = "data/raw/female/denver"       # hook: see README section "Denver hook"
PELVIC_FLOOR_DIR = "data/raw/female/pelvic_floor"   # Wu 等 2015 盆底模型（由 pelvic_floor_refs.py 下载）/ Wu et al. 2015 pelvic floor model (fetched by pelvic_floor_refs.py)


# ── male model ───────────────────────────────────────────────────────────────────────────────


class Male:
    def __init__(self, male_dir, bp3d_dir):
        self.doc = json.load(open(os.path.join(male_dir, "anatomy.json")))
        self.parts = self.doc["parts"]
        self.bp3d = bp3d_dir
        self._mesh = {}
        for p in self.parts:
            p["_base"] = re.sub(r"^(right|left) ", "", p["name"].lower())

    def select(self, system, regex, side, full_name=False):
        if regex is None:
            return []
        out = []
        for p in self.parts:
            if system and p["system"] != system:
                continue
            if regex.startswith("@tissue="):
                ok = p["tissue"] == regex.split("=")[1]
            else:
                ok = re.search(regex, p["name"].lower() if full_name else p["_base"]) is not None
            if ok and (full_name or side == "M" or p["side"] == side):
                out.append(p)
        return out

    def mesh(self, pid):
        if pid not in self._mesh:
            for sub in ("isa_BP3D_4.0_obj_99", "partof_BP3D_4.0_obj_99"):
                path = os.path.join(self.bp3d, sub, pid + ".obj")
                if os.path.exists(path):
                    self._mesh[pid] = load_bp3d_obj(path)
                    break
            else:
                self._mesh[pid] = None
        return self._mesh[pid]

    def points(self, parts, n=6000):
        pts = []
        for p in parts:
            m = self.mesh(p["id"])
            if m is not None and len(m[1]):
                pts.append(sample_surface(m[0], m[1], max(300, n // max(1, len(parts)))))
        return np.vstack(pts) if pts else np.zeros((0, 3))


# ── landmarks, frames, re-posing ─────────────────────────────────────────────────────────────


def limb_landmarks(get, s):
    """joint centres and bone frames for one side; get(key) -> surface sample points (metres)"""
    L = {}
    fem, hipb, tib, fib = get(f"femur_{s}"), get(f"hip_{s}"), get(f"tibia_{s}"), get(f"fibula_{s}")
    c, vt = pca_axis(fem)
    L["hip"], L["femoral_head_radius"], _ = ransac_sphere(end_slab(fem, vt[0], c, 0.22, near_to=hipb.mean(0)), 0.017, 0.029)
    dist = end_slab(fem, vt[0], c, 0.10, far_from=L["hip"])
    L["knee"] = dist.mean(0)
    L["femur_length"] = float(np.ptp((fem - c) @ vt[0]))
    ct_, vtt = pca_axis(tib)
    L["tibia_distal"] = end_slab(tib, vtt[0], ct_, 0.04, far_from=L["knee"]).mean(0)
    cf, vtf = pca_axis(fib)
    L["fibula_distal"] = end_slab(fib, vtf[0], cf, 0.04, far_from=L["knee"]).mean(0)
    L["ankle"] = (L["tibia_distal"] + L["fibula_distal"]) / 2
    tars, mtt = get(f"tarsal_{s}"), get(f"metatarsal_{s}")
    _, vm = pca_axis(mtt)
    a1 = mtt.mean(0) - tars.mean(0)
    a2 = vm[1] if abs(unit(a1) @ vm[1]) < abs(unit(a1) @ vm[0]) else vm[0]
    medial = L["tibia_distal"] - L["fibula_distal"]
    L["F_foot"] = frame(a1, a2 * np.sign(a2 @ medial))
    # condylar axis of the femur for a thigh frame (reported, not applied)
    _, vd = pca_axis(dist)
    head_off = L["hip"] - (c + ((L["hip"] - c) @ vt[0]) * vt[0])
    L["F_femur"] = frame(L["knee"] - L["hip"], vd[0] * np.sign(vd[0] @ head_off))
    L["F_shank"] = frame(L["ankle"] - L["knee"], medial)

    hum, scap, rad, uln = get(f"humerus_{s}"), get(f"scapula_{s}"), get(f"radius_{s}"), get(f"ulna_{s}")
    ch, vh = pca_axis(hum)
    L["shoulder"], L["humeral_head_radius"], _ = ransac_sphere(end_slab(hum, vh[0], ch, 0.18, near_to=scap.mean(0)), 0.016, 0.028)
    dslab = end_slab(hum, vh[0], ch, 0.09, far_from=L["shoulder"])
    L["elbow"] = dslab.mean(0)
    L["elbow_source"] = "centroid of the distal 9 % of the humerus"
    # Better when the joint is intact: the flexion axis runs through the centre of the capitulum
    # (sphere fitted to the humeral surface facing the radial head) and of the trochlea (sphere
    # fitted to the surface facing the ulna). Falls back to the centroid when a fit is implausible.
    L["elbow_axis"] = None
    try:
        dist_h = end_slab(hum, vh[0], ch, 0.14, far_from=L["shoulder"])
        cap_pts = dist_h[cKDTree(rad).query(dist_h)[0] < 0.004]
        tro_pts = dist_h[cKDTree(uln).query(dist_h)[0] < 0.004]
        if len(cap_pts) > 60 and len(tro_pts) > 60:
            cc_, rc, _ = ransac_sphere(cap_pts, 0.007, 0.016, tol=0.0008)
            tc_, rt, _ = ransac_sphere(tro_pts, 0.007, 0.020, tol=0.0010)
            sep = float(np.linalg.norm(cc_ - tc_))
            mid_ = (cc_ + tc_) / 2
            if np.isfinite(rc) and np.isfinite(rt) and 0.012 < sep < 0.040 and np.linalg.norm(mid_ - L["elbow"]) < 0.02:
                L["elbow"], L["elbow_axis"] = mid_, unit(tc_ - cc_)       # lateral (capitulum) -> medial (trochlea)
                L["elbow_source"] = f"midpoint of capitulum (r {rc * 1000:.1f} mm) and trochlea (r {rt * 1000:.1f} mm) sphere centres"
    except Exception:  # noqa: BLE001
        pass
    L["humerus_length"] = float(np.ptp((hum - ch) @ vh[0]))
    cr, vr = pca_axis(rad)
    cu, vu = pca_axis(uln)
    L["radial_head"] = end_slab(rad, vr[0], cr, 0.06, near_to=L["elbow"]).mean(0)
    L["radius_distal"] = end_slab(rad, vr[0], cr, 0.05, far_from=L["elbow"]).mean(0)
    L["ulna_proximal"] = end_slab(uln, vu[0], cu, 0.10, near_to=L["elbow"]).mean(0)
    L["ulna_distal"] = end_slab(uln, vu[0], cu, 0.05, far_from=L["elbow"]).mean(0)
    L["wrist"] = (L["radius_distal"] + L["ulna_distal"]) / 2
    # humerus: long axis shoulder -> elbow; second axis = epicondylar direction (widest direction of
    # the distal end), signed medially by the offset of the head centre from the shaft line
    mid = hum[np.abs((hum - ch) @ vh[0]) < 0.2 * L["humerus_length"]]
    cm_, vm_ = pca_axis(mid)
    head_off = L["shoulder"] - (cm_ + ((L["shoulder"] - cm_) @ vm_[0]) * vm_[0])
    _, ve = pca_axis(dslab)
    a1 = unit(L["elbow"] - L["shoulder"])
    a1 = unit(L["elbow"] - L["shoulder"])
    # the twist reference is the same construction on both bodies (widest direction of the distal end);
    # the articular-sphere axis is used for the pivot only, because the male bones rarely qualify for it
    epi = unit(ve[0] - (ve[0] @ a1) * a1)
    epi *= np.sign(epi @ head_off)
    L["F_humerus"] = frame(a1, epi)
    ho = unit(head_off - (head_off @ a1) * a1)
    L["humeral_head_vs_epicondylar_deg"] = float(np.degrees(np.arccos(np.clip(ho @ epi, -1, 1))))
    L["F_humerus_headref"] = frame(a1, ho)
    L["F_ulna"] = frame(L["ulna_distal"] - L["ulna_proximal"], L["radial_head"] - L["ulna_proximal"])
    L["F_radius"] = frame(L["radius_distal"] - L["radial_head"], L["ulna_distal"] - L["radius_distal"])
    mc = get(f"metacarpal_{s}")
    _, vmc = pca_axis(mc)
    a1 = mc.mean(0) - L["wrist"]
    a2 = vmc[1] if abs(unit(a1) @ vmc[1]) < abs(unit(a1) @ vmc[0]) else vmc[0]
    L["F_hand"] = frame(a1, a2 * np.sign(a2 @ (L["radius_distal"] - L["ulna_distal"])))
    L["elbow_flexion_deg"] = float(np.degrees(np.arccos(np.clip(
        unit(L["elbow"] - L["shoulder"]) @ unit(L["wrist"] - L["elbow"]), -1, 1))))
    L["radius_length"] = float(np.linalg.norm(L["radius_distal"] - L["radial_head"]))
    L["ulna_length"] = float(np.ptp((uln - cu) @ vu[0]))
    L["tibia_length"] = float(np.ptp((tib - ct_) @ vtt[0]))
    return L


MALE_KEYS = {
    "femur": r"^femur$", "hip": r"^hip bone$", "tibia": r"^tibia$", "fibula": r"^fibula$", "humerus": r"^humerus$",
    "scapula": r"^scapula$", "radius": r"^radius$", "ulna": r"^ulna$", "metacarpal": r"metacarpal bone$",
    "tarsal": r"^(calcaneus|talus|cuboid bone|navicular bone of .* foot|.* cuneiform bone)$",
    "metatarsal": r"metatarsal bone$", "carpal": r"^(scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate)$",
}


def trunk_points(get, lm):
    return np.array([lm["L"]["shoulder"], lm["R"]["shoulder"], lm["L"]["hip"], lm["R"]["hip"],
                     get("C7").mean(0), get("T12").mean(0), get("sacrum").mean(0)])


def joint_gap(a_pts, b_pts, b_mesh=None):
    d, _ = cKDTree(b_pts).query(a_pts)
    near = a_pts[d < 0.02]
    out = {"min_mm": round(float(d.min()) * 1000, 2), "p05_mm": round(float(np.quantile(d, 0.05)) * 1000, 2)}
    if b_mesh is not None and len(near):
        try:
            inside = b_mesh.contains(near[:4000])
            out["fraction_of_near_points_inside_other_bone"] = round(float(inside.mean()), 3)
        except Exception as ex:  # noqa: BLE001
            out["inside_test"] = f"unavailable ({type(ex).__name__})"
    return out


# ── main ─────────────────────────────────────────────────────────────────────────────────────


def main():
    work, out, male_dir, bp3d_dir, hra_dir = sys.argv[1:6]
    os.makedirs(os.path.join(out, "preview"), exist_ok=True)
    cache = np.load(os.path.join(work, "meshes.npz"))
    mstats = json.load(open(os.path.join(work, "meshes.json")))
    fix = json.load(open(os.path.join(work, "fix_report.json")))
    spec = anchor_spec.build()
    male = Male(male_dir, bp3d_dir)

    # provisional frame: (X, Y, Z) = (-x, z, y) / 1000 from scanner RAS millimetres
    prov = lambda v: np.c_[-v[:, 0], v[:, 2], v[:, 1]] / 1000.0
    items = {}
    for e in spec:
        lab0 = e["labels"][0]
        key = "vertebrae_L6" if lab0 == anchor_spec.L6_ID else str(lab0)
        iid = "VF_" + key
        if iid + "/v" not in cache:
            continue
        items[iid] = dict(e, id=iid, key=key, v=prov(cache[iid + "/v"].astype(np.float64)),
                          f=cache[iid + "/f"].astype(np.int64), stats=mstats[iid])
    samples = {}

    def fget(k):
        """female surface samples by short key, e.g. femur_L, C7, sacrum"""
        if k not in samples:
            if k in ("C7", "T12", "T1"):
                iid = f"VF_vertebrae_{k}"
            elif k == "sacrum":
                iid = "VF_sacrum"
            else:
                stem, s = k.rsplit("_", 1)
                stem = {"hip": "hip", "scapula": "scapula", "humerus": "humerus", "femur": "femur"}.get(stem, stem)
                iid = f"VF_{stem}_{SIDES[s]}"
            it = items[iid]
            samples[k] = sample_surface(it["v"], it["f"], 12000)
        return samples[k]

    msamples = {}

    def mget(k):
        if k not in msamples:
            if k in ("C7", "T12", "T1", "sacrum"):
                rx = {"C7": r"^seventh cervical vertebra$", "T12": r"^twelfth thoracic vertebra$",
                      "T1": r"^first thoracic vertebra$", "sacrum": r"^sacrum$"}[k]
                parts = male.select("skeletal", rx, "M")
            else:
                stem, s = k.rsplit("_", 1)
                parts = male.select("skeletal", MALE_KEYS[stem], s)
            msamples[k] = male.points(parts, 12000)
        return msamples[k]

    lmF = {s: limb_landmarks(fget, s) for s in "LR"}
    lmM = {s: limb_landmarks(mget, s) for s in "LR"}

    # final frame: X = 0 at the midpoint of the hip-joint centres, Z offset so that this midpoint
    # has the male model's hip-midpoint Z; Y = height above the lowest CT slice.
    hipF = (lmF["L"]["hip"] + lmF["R"]["hip"]) / 2
    hipM = (lmM["L"]["hip"] + lmM["R"]["hip"]) / 2
    shift = np.array([-hipF[0], 0.0, hipM[2] - hipF[2]])
    for it in items.values():
        it["v"] = it["v"] + shift
    for k in samples:
        samples[k] = samples[k] + shift
    lmF = {s: limb_landmarks(fget, s) for s in "LR"}
    # voxel (i, j, k) -> anchor frame, 4x4 row-major
    V2A = np.array([[-0.001, 0, 0, 0.2395 + shift[0]], [0, 0, 0.001, 0.0], [0, 0.001, 0, -0.2395 + shift[2]], [0, 0, 0, 1]])
    chk = items["VF_femur_left"]
    assert np.allclose(apply(V2A, cache["VF_femur_left/v"][:5] + [239.5, 239.5, 0]), chk["v"][:5], atol=1e-6)

    # ── re-posing: female arm bones to the male arms-down configuration ──────────────────────
    Rtr, _ = kabsch(trunk_points(fget, lmF), trunk_points(mget, lmM))      # female trunk -> male orientation
    pose = {"trunk_alignment_female_to_male_deg": round(rot_angle_deg(Rtr), 2), "sides": {}}
    T_items = {}
    use_headref = {}
    for s in "LR":
        F, M = lmF[s], lmM[s]
        tgt = lambda name: Rtr.T @ M[name]           # male frame expressed in the female trunk orientation
        # Both elbows touch the field-of-view edge; the epicondylar axis of a clipped distal humerus is
        # unreliable, so when the head-vs-epicondyle angle departs from the male's by > 15 degrees the
        # humeral twist is taken from the head offset (intact proximal end) instead.
        dev = abs(F["humeral_head_vs_epicondylar_deg"] - M["humeral_head_vs_epicondylar_deg"])
        use_headref[s] = bool(dev > 15)
        hk = "F_humerus_headref" if use_headref[s] else "F_humerus"
        R_h = tgt(hk) @ F[hk].T
        T_h = rigid_about(R_h, F["shoulder"])
        E2 = apply(T_h, F["elbow"][None])[0]
        R_u = tgt("F_ulna") @ F["F_ulna"].T
        T_u = rigid_about(R_u, F["elbow"], E2)
        R_r = tgt("F_radius") @ F["F_radius"].T
        T_r = rigid_about(R_r, F["radial_head"], apply(T_u, F["radial_head"][None])[0])
        W2 = (apply(T_r, F["radius_distal"][None])[0] + apply(T_u, F["ulna_distal"][None])[0]) / 2
        R_ha = tgt("F_hand") @ F["F_hand"].T
        T_ha = rigid_about(R_ha, F["wrist"], W2)
        side = SIDES[s]
        T_items.update({f"VF_humerus_{side}": T_h, f"VF_ulna_{side}": T_u, f"VF_radius_{side}": T_r,
                        f"VF_carpal_{side}": T_ha, f"VF_metacarpal_{side}": T_ha, f"VF_fingers_{side}": T_ha})
        pose["sides"][side] = {
            "as_scanned": {"elbow_flexion_deg": round(F["elbow_flexion_deg"], 1),
                           "humerus_to_male_direction_deg": round(float(np.degrees(np.arccos(np.clip(
                               F["F_humerus"][:, 0] @ tgt("F_humerus")[:, 0], -1, 1)))), 1),
                           "humeral_head_vs_epicondylar_deg": round(F["humeral_head_vs_epicondylar_deg"], 1),
                           "elbow_centre_from": F["elbow_source"]},
            "male": {"elbow_flexion_deg": round(M["elbow_flexion_deg"], 1), "elbow_centre_from": M["elbow_source"],
                     "humeral_head_vs_epicondylar_deg": round(M["humeral_head_vs_epicondylar_deg"], 1)},
            "humerus_twist_reference": "head offset" if use_headref[s] else "epicondylar axis",
            "rotation_applied_deg": {"humerus": round(rot_angle_deg(R_h), 1), "ulna": round(rot_angle_deg(R_u), 1),
                                     "radius": round(rot_angle_deg(R_r), 1), "hand": round(rot_angle_deg(R_ha), 1)},
            "lower_limb_difference_to_male_deg (not applied)": {
                "femur": round(rot_angle_deg(tgt("F_femur") @ F["F_femur"].T), 1),
                "shank": round(rot_angle_deg(tgt("F_shank") @ F["F_shank"].T), 1),
                "foot": round(rot_angle_deg(tgt("F_foot") @ F["F_foot"].T), 1),
                "femur_long_axis_only": round(float(np.degrees(np.arccos(np.clip(F["F_femur"][:, 0] @ tgt("F_femur")[:, 0], -1, 1)))), 1),
                "shank_long_axis_only": round(float(np.degrees(np.arccos(np.clip(F["F_shank"][:, 0] @ tgt("F_shank")[:, 0], -1, 1)))), 1),
                "foot_long_axis_only": round(float(np.degrees(np.arccos(np.clip(F["F_foot"][:, 0] @ tgt("F_foot")[:, 0], -1, 1)))), 1)},
        }
        # joint congruency before / after
        P = lambda iid, T=None: (lambda p: p if T is None else apply(T, p))(sample_surface(items[iid]["v"], items[iid]["f"], 15000))
        mesh_h = trimesh.Trimesh(items[f"VF_humerus_{side}"]["v"], items[f"VF_humerus_{side}"]["f"], process=False)
        mesh_h2 = mesh_h.copy()
        mesh_h2.apply_transform(T_h)
        mesh_r = trimesh.Trimesh(apply(T_r, items[f"VF_radius_{side}"]["v"]), items[f"VF_radius_{side}"]["f"], process=False)
        pose["sides"][side]["joint_gaps"] = {
            "elbow_ulna_to_humerus": {"scanned": joint_gap(P(f"VF_ulna_{side}"), P(f"VF_humerus_{side}"), mesh_h),
                                      "reposed": joint_gap(P(f"VF_ulna_{side}", T_u), P(f"VF_humerus_{side}", T_h), mesh_h2)},
            "elbow_radius_to_humerus": {"scanned": joint_gap(P(f"VF_radius_{side}"), P(f"VF_humerus_{side}"), mesh_h),
                                        "reposed": joint_gap(P(f"VF_radius_{side}", T_r), P(f"VF_humerus_{side}", T_h), mesh_h2)},
            "ulna_to_radius": {"scanned": joint_gap(P(f"VF_ulna_{side}"), P(f"VF_radius_{side}")),
                               "reposed": joint_gap(P(f"VF_ulna_{side}", T_u), P(f"VF_radius_{side}", T_r), mesh_r)},
            "wrist_carpals_to_radius": {"scanned": joint_gap(P(f"VF_carpal_{side}"), P(f"VF_radius_{side}")),
                                        "reposed": joint_gap(P(f"VF_carpal_{side}", T_ha), P(f"VF_radius_{side}", T_r), mesh_r)},
            "shoulder_humerus_to_scapula": {"scanned": joint_gap(P(f"VF_humerus_{side}"), P(f"VF_scapula_{side}")),
                                            "reposed": joint_gap(P(f"VF_humerus_{side}", T_h), P(f"VF_scapula_{side}"))},
        }
        # does the re-posed arm clear the trunk? distance of re-posed arm bones to pelvis / ribs
        trunk_pts = np.vstack([P(f"VF_hip_{side}"), P(f"VF_femur_{side}")] + [P(f"VF_rib_{side}_{n}") for n in (8, 9, 10, 11)])
        arm = np.vstack([P(f"VF_radius_{side}", T_r), P(f"VF_ulna_{side}", T_u), P(f"VF_metacarpal_{side}", T_ha),
                         P(f"VF_fingers_{side}", T_ha)])
        d, _ = cKDTree(trunk_pts).query(arm)
        pose["sides"][side]["reposed_forearm_hand_to_trunk_bone_min_mm"] = round(float(d.min()) * 1000, 1)
        arm0 = np.vstack([P(f"VF_radius_{side}"), P(f"VF_ulna_{side}"), P(f"VF_metacarpal_{side}"), P(f"VF_fingers_{side}")])
        pose["sides"][side]["scanned_forearm_hand_to_trunk_bone_min_mm"] = round(float(cKDTree(trunk_pts).query(arm0)[0].min()) * 1000, 1)

    joints = {}
    for s in "LR":
        for j in ("shoulder", "elbow", "wrist", "hip", "knee", "ankle"):
            p0 = lmF[s][j]
            T = {"elbow": T_items[f"VF_humerus_{SIDES[s]}"], "wrist": None}.get(j)
            p1 = p0
            if j == "elbow":
                p1 = apply(T, p0[None])[0]
            if j == "wrist":
                side = SIDES[s]
                p1 = (apply(T_items[f"VF_radius_{side}"], lmF[s]["radius_distal"][None])[0] +
                      apply(T_items[f"VF_ulna_{side}"], lmF[s]["ulna_distal"][None])[0]) / 2
            joints[f"{j}_{SIDES[s]}"] = {"scanned": p0.round(5).tolist(), "reposed": np.asarray(p1).round(5).tolist(),
                                         "male": lmM[s][j].round(5).tolist()}
    radii = {f"{k}_{SIDES[s]}_mm": round(lmF[s][k] * 1000, 1) for s in "LR" for k in ("femoral_head_radius", "humeral_head_radius")}

    kin = [("VF_sacrum", None, None)]
    for s, side in SIDES.items():
        kin += [(f"VF_hip_{side}", "VF_sacrum", "sacro-iliac (fixed)"), (f"VF_femur_{side}", f"VF_hip_{side}", f"hip_{side}"),
                (f"VF_patella_{side}", f"VF_femur_{side}", f"knee_{side}"), (f"VF_tibia_{side}", f"VF_femur_{side}", f"knee_{side}"),
                (f"VF_fibula_{side}", f"VF_tibia_{side}", "tibio-fibular (fixed)"), (f"VF_tarsal_{side}", f"VF_tibia_{side}", f"ankle_{side}"),
                (f"VF_metatarsal_{side}", f"VF_tarsal_{side}", "tarso-metatarsal (fixed)"), (f"VF_toes_{side}", f"VF_metatarsal_{side}", "metatarso-phalangeal (not estimated)"),
                (f"VF_clavicula_{side}", "VF_sternum", "sterno-clavicular (not estimated)"), (f"VF_scapula_{side}", f"VF_clavicula_{side}", "acromio-clavicular (not estimated)"),
                (f"VF_humerus_{side}", f"VF_scapula_{side}", f"shoulder_{side}"), (f"VF_ulna_{side}", f"VF_humerus_{side}", f"elbow_{side}"),
                (f"VF_radius_{side}", f"VF_ulna_{side}", f"elbow_{side} (radial head follows the ulna; pronation about the ulna)"),
                (f"VF_carpal_{side}", f"VF_radius_{side}", f"wrist_{side}"), (f"VF_metacarpal_{side}", f"VF_carpal_{side}", "carpo-metacarpal (fixed)"),
                (f"VF_fingers_{side}", f"VF_metacarpal_{side}", "metacarpo-phalangeal (not estimated; moved rigidly with the hand)")]
    pose["kinematic_tree"] = [{"bone": b, "parent": p, "joint": j} for b, p, j in kin]
    pose["joint_centres"] = joints
    pose["head_radii"] = radii
    pose["method"] = ("Per-bone rigid transforms. Trunk orientation female->male by Kabsch on shoulder and hip centres, C7, T12 "
                      "and sacrum centroids. Each upper-limb bone gets the rotation that makes its anatomical frame equal to "
                      "the male bone's frame (expressed in the female trunk orientation); the humerus turns about the humeral "
                      "head centre, the ulna about the elbow centre carried by the humerus, the radius about the radial head "
                      "carried by the ulna, the hand block about the wrist centre carried by radius and ulna. Bone shapes and "
                      "lengths are untouched.")

    # ── male correspondences, quality, item records ──────────────────────────────────────────
    claimed = defaultdict(list)
    recs = []
    for iid, it in items.items():
        parts = male.select(it["male_system"], it["male_regex"], it["side"], it.get("full_name_regex", False))
        ids = sorted(p["id"] for p in parts)
        corr = "none" if not ids else "one-to-one" if len(ids) == 1 else "group"
        for i in ids:
            claimed[i].append(iid)
        st = it["stats"]
        q, reasons = "good", []
        o = anchor_spec.quality_for(it["key"])
        if o:
            q = o[0]
            reasons.append(o[1])
        if st["fov_edge_voxels"] and it["key"] != "body_surface":
            reasons.append(f"touches the CT field-of-view edge on {round(100 * st['fov_edge_slice_fraction'])} % of its slices (clipped)")
            if q == "good":
                q = "usable"
        if st["removed_stray_fraction"] > 0.1:
            reasons.append(f"{round(100 * st['removed_stray_fraction'])} % of the label volume was stray components (removed)")
            q = "usable" if q == "good" else q
        if it.get("relabelled"):
            reasons.append("lumbar/sacral label reassigned (six lumbar vertebrae)")
        seg_tool = ("MOOSE 3.2.2 clin_ct_peripheral_bones" if it["task"] == "moose_peripheral_bones"
                    else "TotalSegmentator 2.18.0 (combined labels)" if it["task"] == "derived"
                    else f"TotalSegmentator 2.18.0 {it['task']}")
        T = T_items.get(iid)
        pose_valid = it.get("pose", "both")
        v = it["v"]
        fma = parts[0].get("fma") if corr == "one-to-one" else None
        recs.append({
            "id": iid, "name": it["name"], "side": it["side"], "kind": it["kind"], "provenance": "scanned",
            "source": "vhf-ct", "segmentation": {"tool": seg_tool, "task": it["task"],
                                                 "labels": [("vertebrae_L6 (id 118, relabelled)" if l == anchor_spec.L6_ID else l) for l in it["labels"]]},
            "fma": fma, "ontology_id": fma.replace("FMA", "FMA:") if fma else None,
            "male_parts": ids, "correspondence": corr,
            "quality": q, "quality_reasons": reasons, "note": it.get("note"),
            "triangles": int(len(it["f"])), "bbox": np.r_[v.min(0), v.max(0)].round(5).tolist(),
            "centroid": v.mean(0).round(5).tolist(), "volume_ml": st["volume_final_ml"],
            "volume_voxel_ml": st["volume_voxel_ml"], "pose": pose_valid,
            "repose": None if T is None else T.round(7).ravel().tolist(),
            "license": "NLM Terms and Conditions (attribution required); redistributed within this CC BY-SA 4.0 dataset",
            "attribution": NLM, "_v": v, "_f": it["f"], "_T": T,
        })

    # ── HRA female-specific organs ───────────────────────────────────────────────────────────
    hra_recs, hra_report, hra_bones = hra_place.place(hra_dir, items, work, V2A)
    recs += hra_recs

    # ── Denver lower-extremity set (same donor, cryosections) ────────────────────────────────
    den_report = {"present": False}
    if denver_import.available(DENVER_DIR):
        den_recs, den_report = denver_import.place(DENVER_DIR, items, work, V2A, male, raw_seg_dir=sys.argv[6] if len(sys.argv) > 6 else None)
        den_report["present"] = True
        recs += den_recs
        for r in den_recs:
            for i in r["male_parts"]:
                claimed[i].append(r["id"])
    # which of two sources to use when both cover a structure
    ids = {r["id"] for r in recs}
    alt = defaultdict(list)
    for r in recs:
        r.setdefault("follows", None)
        r.setdefault("duplicates", None)
    for r in recs:
        if r["source"] != "denver":
            continue
        cands = [x for x in (r["duplicates"] or "").split(" + ") if x in ids] if r["kind"] in ("bone", "bone-group") else \
                [r["id"].replace("VD_", "VF_")] if r["id"].replace("VD_", "VF_") in ids else []
        for x in cands:
            alt[x].append(r["id"])
            alt[r["id"]].append(x)
    for r in recs:
        r["alternatives"] = sorted(set(alt.get(r["id"], [])))
    rec_by = {r["id"]: r for r in recs}
    for r in recs:
        if "preferred" not in r:
            # a CT item stays preferred unless every part of it is covered by a preferred Denver item
            r["preferred"] = not any(rec_by[o].get("preferred") for o in r["alternatives"])

    # ── Wu 等 2015 女性盆底（另一个体，CC BY）/ Wu et al. 2015 female pelvic floor (another individual, CC BY) ──
    wu_report = {"present": False}
    if wu_place.available(PELVIC_FLOOR_DIR):
        wu_recs, wu_report = wu_place.place(PELVIC_FLOOR_DIR, items, male, V2A, recs)
        for r in wu_recs:
            for i in r["male_parts"]:
                claimed[i].append(r["id"])
            for a in r["alternatives"]:               # 反向登记，既有条目仍为首选 / back-link; the existing item stays preferred
                rec_by[a]["alternatives"] = sorted(set(rec_by[a]["alternatives"]) | {r["id"]})
        recs += wu_recs

    # ── optional alternative: CT limb bones moved onto the CT's own cortical edge ─────────────
    # TotalSegmentator / MOOSE label surfaces (plus the volume-restoring offset) lie 0.3-1.0 mm outside
    # the cortical edge seen in the CT. For the limb and hip bones a per-bone uniform normal offset
    # equal to the measured edge position is offered as a separate mesh set; defaults are unchanged.
    ctvol = np.asarray(nib.load(os.path.join(work, "ct_fixed.nii.gz")).dataobj)
    A2V = np.linalg.inv(V2A)
    edge_alt, edge_report = {}, []
    for r in recs:
        if r["source"] != "vhf-ct" or not re.match(r"VF_(hip|femur|patella|tibia|fibula|humerus|radius|ulna|clavicula|scapula)_", r["id"]):
            continue
        v, f = r["_v"], r["_f"]
        e0 = ct_edge_offset(ctvol, A2V, v, f)
        if e0 is None or abs(e0) > 1.5:
            edge_report.append({"id": r["id"], "edge_mm": None if e0 is None else round(e0, 2), "applied": False})
            continue
        tm = trimesh.Trimesh(v, f, process=False)
        v2 = v + (e0 / 1000.0) * np.asarray(tm.vertex_normals)
        e1 = ct_edge_offset(ctvol, A2V, v2, f)
        vol2 = abs(float(np.einsum("ij,ij->i", v2[f[:, 0]], np.cross(v2[f[:, 1]], v2[f[:, 2]])).sum() / 6.0)) * 1e6
        edge_alt[r["id"]] = v2
        r["edge_correction"] = {"offset_mm": round(e0, 2), "residual_edge_mm": None if e1 is None else round(e1, 2),
                                "volume_ml": round(vol2, 2), "volume_change": round(vol2 / r["volume_ml"] - 1, 3)}
        edge_report.append({"id": r["id"], "edge_mm": round(e0, 2), "applied": True, **r["edge_correction"]})
    del ctvol

    # ── binaries ──────────────────────────────────────────────────────────────────────────────
    wS, wR = BinWriter(os.path.join(out, "scanned.bin")), BinWriter(os.path.join(out, "reposed.bin"))
    for r in recs:
        v, f, T = r.pop("_v"), r.pop("_f"), r.pop("_T")
        r["mesh"] = {"scanned": wS.add(v, f)}
        if r.get("_w") is not None:
            r["mesh"]["scanned"]["vertex_weight"] = wS.add_array(r.pop("_w"))
        r["mesh"]["reposed"] = wR.add(v if T is None else apply(T, v), f) if r["pose"] == "both" else None
        if T is not None:
            vr = apply(T, v)
            r["bbox_reposed"] = np.r_[vr.min(0), vr.max(0)].round(5).tolist()
        r["_v"], r["_f"], r["_T"] = v, f, T
    wS.close()
    wR.close()
    wE = BinWriter(os.path.join(out, "alt_edge_corrected.bin"))
    for r in recs:
        if r["id"] in edge_alt:
            r["mesh"]["scanned_edge_corrected"] = wE.add(edge_alt[r["id"]], r["_f"])
    wE.close()

    # ── sanity numbers ───────────────────────────────────────────────────────────────────────
    by_id = {r["id"]: r for r in recs}
    S = lambda iid, n=8000: sample_surface(by_id[iid]["_v"], by_id[iid]["_f"], n)

    def ext(pts, k=0):
        c, vt = pca_axis(pts)
        return float(np.ptp((pts - c) @ vt[k]))

    sizes = []
    for r in recs:
        if r["source"] != "vhf-ct" or r["correspondence"] == "none" or r["kind"] not in ("bone", "bone-group", "cartilage"):
            continue
        mp = male.points([p for p in male.parts if p["id"] in r["male_parts"]], 8000)
        if not len(mp):
            continue
        fe, me = ext(S(r["id"])), ext(mp)
        sizes.append({"id": r["id"], "female_mm": round(fe * 1000, 1), "male_mm": round(me * 1000, 1), "ratio": round(fe / me, 3),
                      "correspondence": r["correspondence"]})
    med = float(np.median([s["ratio"] for s in sizes]))
    for s in sizes:
        s["outlier"] = bool(abs(s["ratio"] / med - 1) > 0.15)

    def width(pts_list, axis=0):
        p = np.vstack(pts_list)
        return float(np.ptp(p[:, axis]))

    mpart = lambda rx, side="M": male.points(male.select("skeletal", rx, side), 8000)
    pelvis = {
        "bi-iliac breadth (max width of both hip bones)": (width([S("VF_hip_left"), S("VF_hip_right")]), width([mpart(r"^hip bone$", "L"), mpart(r"^hip bone$", "R")])),
        "hip-joint centre distance": (float(np.linalg.norm(lmF["L"]["hip"] - lmF["R"]["hip"])), float(np.linalg.norm(lmM["L"]["hip"] - lmM["R"]["hip"]))),
        "hip bone height": (width([S("VF_hip_left")], 1), width([mpart(r"^hip bone$", "L")], 1)),
        "sacrum width": (width([S("VF_sacrum")]), width([mpart(r"^sacrum$")])),
        "shoulder-joint centre distance": (float(np.linalg.norm(lmF["L"]["shoulder"] - lmF["R"]["shoulder"])), float(np.linalg.norm(lmM["L"]["shoulder"] - lmM["R"]["shoulder"]))),
        "femoral head radius (left)": (lmF["L"]["femoral_head_radius"], lmM["L"]["femoral_head_radius"]),
        "humeral head radius (left)": (lmF["L"]["humeral_head_radius"], lmM["L"]["humeral_head_radius"]),
        "cranium length (antero-posterior)": (width([S("VF_cranium")], 2), width([mpart(anchor_spec.CRANIAL, "M"), mpart(anchor_spec.CRANIAL, "L"), mpart(anchor_spec.CRANIAL, "R")], 2)),
        "cranium breadth": (width([S("VF_cranium")]), width([mpart(anchor_spec.CRANIAL, "M"), mpart(anchor_spec.CRANIAL, "L"), mpart(anchor_spec.CRANIAL, "R")])),
        "C7 centroid to sacrum centroid (trunk length)": (float(np.linalg.norm(fget("C7").mean(0) - fget("sacrum").mean(0))), float(np.linalg.norm(mget("C7").mean(0) - mget("sacrum").mean(0)))),
        "hip-joint centre height above ankle centre (left)": (float(lmF["L"]["hip"][1] - lmF["L"]["ankle"][1]), float(lmM["L"]["hip"][1] - lmM["L"]["ankle"][1])),
    }
    pelvis = {k: {"female_mm": round(a * 1000, 1), "male_mm": round(b * 1000, 1), "ratio": round(a / b, 3)} for k, (a, b) in pelvis.items()}
    pelvis["bi-iliac breadth / hip bone height (shape index)"] = {
        "female": round(pelvis["bi-iliac breadth (max width of both hip bones)"]["female_mm"] / pelvis["hip bone height"]["female_mm"], 3),
        "male": round(pelvis["bi-iliac breadth (max width of both hip bones)"]["male_mm"] / pelvis["hip bone height"]["male_mm"], 3)}

    sym = []
    for r in recs:
        if r["source"] == "vhf-ct" and r["side"] == "L":
            rid = r["id"].replace("_left", "_right")
            if rid in by_id:
                a, b = r, by_id[rid]
                isbone = a["kind"] in ("bone", "bone-group")
                sym.append({"pair": r["id"].replace("VF_", "").replace("_left", ""), "kind": a["kind"], "volume_L_ml": a["volume_ml"], "volume_R_ml": b["volume_ml"],
                            "volume_ratio_L_over_R": round(a["volume_ml"] / b["volume_ml"], 3),
                            "length_ratio_L_over_R": round(ext(S(a["id"])) / ext(S(b["id"])), 3) if isbone else None})

    # Denver muscles: left/right symmetry and female/male volume
    def male_volume(parts):
        tot = 0.0
        for p in parts:
            mm_ = male.mesh(p["id"])
            if mm_ is not None and len(mm_[1]):
                tot += abs(float(np.einsum("ij,ij->i", mm_[0][mm_[1][:, 0]], np.cross(mm_[0][mm_[1][:, 1]], mm_[0][mm_[1][:, 2]])).sum() / 6.0)) * 1e6
            elif p.get("volume"):
                tot += float(p["volume"])
            else:
                return None
        return tot or None

    muscles = []
    for r in recs:
        if r["source"] == "denver" and r["kind"] == "muscle" and r["side"] == "L":
            o = by_id[r["id"].replace("_left", "_right")]
            mvL = male_volume([p for p in male.parts if p["id"] in r["male_parts"]]) if r["male_parts"] else None
            mvR = male_volume([p for p in male.parts if p["id"] in o["male_parts"]]) if o["male_parts"] else None
            fm = (r["volume_ml"] + o["volume_ml"]) / (mvL + mvR) if mvL and mvR else None
            muscles.append({"muscle": r["id"].replace("VD_", "").replace("_left", ""), "left_ml": r["volume_ml"], "right_ml": o["volume_ml"],
                            "L_over_R": round(r["volume_ml"] / o["volume_ml"], 3), "male_left_ml": round(mvL, 1) if mvL else None,
                            "male_right_ml": round(mvR, 1) if mvR else None, "female_over_male": round(fm, 3) if fm else None,
                            "male_parts": len(r["male_parts"])})
    fmr = [m_["female_over_male"] for m_ in muscles if m_["female_over_male"]]
    fm_med = float(np.median(fmr)) if fmr else None
    for m_ in muscles:
        m_["outlier"] = bool(m_["female_over_male"] and fm_med and not (0.5 < m_["female_over_male"] / fm_med < 2.0)) or abs(m_["L_over_R"] - 1) > 0.25

    # coverage: male parts with a female anchor, by system and by body region
    reg_rx = [("head", anchor_spec.CRANIAL[:-2] + r"|mandible|hyoid bone)$"), ("neck", r"cervical vertebra$|^atlas$|^axis$"),
              ("thorax", r"thoracic vertebra$| rib$|sternum|manubrium|xiphoid|costal cartilage$|^clavicle$|^scapula$"),
              ("abdomen", r"lumbar vertebra$"), ("pelvis", r"^hip bone$|^sacrum$"), ("upper arm", r"^humerus$"),
              ("forearm", r"^(radius|ulna)$"), ("hand", MALE_KEYS["carpal"][:-1] + r"|metacarpal bone$|phalanx of .*(finger|thumb)$"),
              ("thigh", r"^(femur|patella)$"), ("leg", r"^(tibia|fibula)$"), ("foot", MALE_KEYS["tarsal"][:-1] + r"|metatarsal bone$|phalanx of .* toe$")]
    rp, rl = [], []
    for name, rx in reg_rx:
        for p in male.select("skeletal", rx, "M"):
            m = male.mesh(p["id"])
            if m is not None:
                rp.append(m[0][:: max(1, len(m[0]) // 400)])
                rl += [name] * len(rp[-1])
    rtree = cKDTree(np.vstack(rp))
    rl = np.array(rl)
    cov_sys, cov_reg = defaultdict(Counter), defaultdict(Counter)
    for p in male.parts:
        region = rl[rtree.query(np.array(p["centroid"]))[1]]
        kinds = sorted({by_id[i]["correspondence"] for i in claimed.get(p["id"], [])})
        state = "none" if not kinds else "one-to-one" if "one-to-one" in kinds else "group"
        cov_sys[p["system"]][state] += 1
        cov_reg[region][state] += 1
        cov_reg[region]["anchored " + p["tissue"]] += state != "none"
    counts = Counter((r["source"], r["kind"], r["quality"]) for r in recs)

    # ── manifest ─────────────────────────────────────────────────────────────────────────────
    manifest = {
        "schema": 1, "name": "soma female anchor set (Visible Human Female)", "license": "CC BY-SA 4.0",
        "frame": {"units": "metre", "axes": "+X patient left, +Y up (superior), +Z anterior",
                  "origin": "X = 0 at the midpoint of the hip-joint centres; Y = 0 at the most inferior CT slice (toe tips; feet are plantar-flexed); "
                            "Z offset chosen so the hip-centre midpoint has the male model's hip-midpoint Z",
                  "voxel_to_anchor": V2A.round(7).ravel().tolist(),
                  "voxel_to_anchor_doc": "row-major 4x4; maps voxel index (i, j, k) of the fixed 480x480x1734 1 mm volume to metres. "
                                         "i increases to patient right, j to anterior, k to superior; k = 2734 - NLM file number.",
                  "volume_fix": "slices k <= 748 (exam 371, legs) were moved rigidly in-plane to remove the seam; see fixes.seam"},
        "sources": [
            {"id": "vhf-ct", "name": "Visible Human Female, normal CT", "provider": "U.S. National Library of Medicine",
             "url": "https://data.lhncbc.nlm.nih.gov/public/Visible-Human/Female-Images/radiological/normalCT/",
             "license": "NLM Terms and Conditions", "license_url": "https://www.nlm.nih.gov/databases/download/terms_and_conditions.html",
             "attribution": NLM, "provenance": "scanned"},
            {"id": "hra", "name": "Human Reference Atlas 3D Reference Object Library, united female v1.10", "provider": "HuBMAP / HRA",
             "url": "https://cdn.humanatlas.io/digital-objects/ref-organ/united-female/latest/assets/3d-vh-f-united.glb",
             "license": "CC BY 4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
             "attribution": hra_place.HRA_ATTR, "provenance": "curated"},
            {"id": "denver", "name": "Three-dimensional lower extremity musculoskeletal geometry of the Visible Human Female (Final 3D STL Models)",
             "provider": "University of Denver, Center for Orthopaedic Biomechanics", "url": "https://digitalcommons.du.edu/visiblehuman/1",
             "doi": "10.56902/COB.vh.2022.1", "license": "CC BY 4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
             "attribution": denver_import.ATTR, "provenance": "scanned (manual segmentation of the donor's cryosections)"},
            {"id": "wu2015", "name": "3D Topography of the Young Adult Anal Sphincter Complex (interactive 3D-PDF of the female pelvic floor, specimen CVH5)",
             "provider": "Wu Y. et al., Academic Medical Center Amsterdam / Maastricht University", "url": "https://doi.org/10.1371/journal.pone.0140736.s004",
             "doi": "10.1371/journal.pone.0132226", "license": "CC BY 4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
             "attribution": wu_place.ATTR, "provenance": "curated (a different individual; remodelled surfaces)"}],
        "tools": [
            {"name": "TotalSegmentator 2.18.0", "license": "Apache-2.0 (open tasks only were used)",
             "cite": "Wasserthal J. et al. TotalSegmentator: Robust Segmentation of 104 Anatomic Structures in CT Images. Radiology: Artificial Intelligence 2023;5(5):e230024."},
            {"name": "MOOSE 3.2.2 (clin_ct_peripheral_bones)", "license": "code Apache-2.0, model CC BY 4.0",
             "cite": "Sundar L.K.S. et al. Fully Automated, Semantic Segmentation of Whole-Body 18F-FDG PET/CT Images Based on Data-Centric Artificial Intelligence. J Nucl Med 2022;63(12):1941-1948."}],
        "male_model": {"path": "public/anatomy/male/anatomy.json", "parts_at_build": len(male.parts),
                       "sources": [x["name"] for x in male.doc.get("sources", [])],
                       "note": "male_parts are resolved by name at build time; rebuild after the male model changes"},
        "fixes": fix,
        "lumbar_mapping": {"female": "six lumbar vertebrae L1..L6", "male": "five",
                           "rule": "female L(n+1) <-> male L(n) for n = 1..5, counted upward from the sacrum; female L1 has no male counterpart; "
                                   "T12 (bears the 12th ribs) and the sacrum keep their identity",
                           "consequence": "between male T12 and male L1 the deformation must open one vertebral height (~33 mm)"},
        "meshes": {"format": "little-endian; per item float32 xyz positions (count = vertices) followed by uint32 triangle indices (count = 3 x triangles), "
                             "outward counter-clockwise winding",
                   "scanned": "scanned.bin", "reposed": "reposed.bin",
                   "alternatives": {"scanned_edge_corrected": {
                       "file": "alt_edge_corrected.bin", "default": False,
                       "doc": "OPTIONAL. CT hip and limb bones in the scanned pose with a per-bone uniform normal offset that puts the surface on the "
                              "CT's own cortical edge (item.edge_correction; item.mesh.scanned_edge_corrected). Same triangles as the default mesh. "
                              "Apply item.repose yourself for the re-posed arm bones.", "items": edge_report}},
                   "reposed_doc": "same items as scanned minus pose == 'scanned-only'; upper-limb bones have their `repose` transform applied"},
        "pose": pose,
        "hra_placement": hra_report,
        "denver_import": den_report,
        "wu_import": wu_report,
        "fat": json.load(open(os.path.join(work, "fat_report.json"))) if os.path.exists(os.path.join(work, "fat_report.json")) else None,
        "hooks": {"denver": {"present": bool(den_report["present"]), "expected_directory": DENVER_DIR + "/" + denver_import.SUBDIR,
                             "import_status": "implemented (denver_import.py); items VD_*" if den_report["present"] else
                             "directory not found at build time; package built without VD_* items"}},
        "counts": {f"{a}/{b}/{c}": n for (a, b, c), n in sorted(counts.items())},
        "items": [{k: v for k, v in r.items() if not k.startswith("_")} for r in recs],
    }
    json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=1)

    sanity = {"bone_size_ratio_female_over_male": {"median": round(med, 3), "items": sizes}, "skeleton_measures": pelvis,
              "left_right_symmetry": sym, "denver_muscles": {"median_female_over_male": round(fm_med, 3) if fm_med else None, "items": muscles},
              "coverage_by_system": {k: dict(v) for k, v in cov_sys.items()},
              "coverage_by_region": {k: dict(v) for k, v in cov_reg.items()},
              "male_parts_total": len(male.parts), "male_parts_with_anchor": len(claimed)}
    json.dump(sanity, open(os.path.join(out, "sanity.json"), "w"), indent=1)

    # ── previews ─────────────────────────────────────────────────────────────────────────────
    dense = lambda r, n=None, T=False: (lambda p: apply(r["_T"], p) if (T and r["_T"] is not None) else p)(
        sample_surface(r["_v"], r["_f"], n or int(np.clip(len(r["_f"]) * 6, 4000, 300000))))
    G = lambda pred, col, dim=False, T=False: (np.vstack([dense(r, T=T) for r in recs if pred(r)] or [np.zeros((0, 3))]), col, dim)
    bone = lambda r: r["kind"] in ("bone", "bone-group", "cartilage", "tooth") and r["source"] == "vhf-ct"
    skin = lambda r: r["id"] == "VF_body_surface"
    render([G(skin, (110, 110, 110), True), G(lambda r: bone(r) and r["quality"] == "good", (255, 235, 170)),
            G(lambda r: bone(r) and r["quality"] == "usable", (255, 170, 60)), G(lambda r: bone(r) and r["quality"] == "poor", (255, 60, 60))],
           os.path.join(out, "preview", "skeleton_scanned.png"))
    render([G(skin, (110, 110, 110), True), G(bone, (90, 90, 80)),
            G(lambda r: r["kind"] == "organ" and r["source"] == "vhf-ct", (110, 220, 130)),
            G(lambda r: r["kind"] == "vessel" and r["source"] == "vhf-ct", (90, 160, 255)),
            G(lambda r: r["source"] == "hra", (255, 80, 120))],
           os.path.join(out, "preview", "organs_and_hra.png"), crop=([-0.26, 0.75, -0.2], [0.26, 1.50, 0.25]))
    render([G(lambda r: bone(r) and r["id"] in ("VF_hip_left", "VF_hip_right", "VF_sacrum", "VF_femur_left", "VF_femur_right", "VF_vertebrae_L6", "VF_vertebrae_L5"), (120, 120, 100)),
            G(lambda r: r["id"] in ("VF_urinary_bladder",), (240, 220, 80)), G(lambda r: r["id"] == "VF_colon", (150, 110, 70)),
            G(lambda r: r["source"] == "hra" and "mammary" not in r.get("hra_path", ""), (255, 80, 120))],
           os.path.join(out, "preview", "pelvis_hra_organs.png"), height=900, crop=([-0.2, 0.80, -0.14], [0.2, 1.08, 0.16]))
    if den_report["present"]:
        den = lambda kind: (lambda r: r["source"] == "denver" and r["kind"] == kind)
        render([G(lambda r: bone(r) and re.match(r"VF_(hip|sacrum|femur|tibia|fibula|patella|tarsal|metatarsal|toes|vertebrae_L)", r["id"]) is not None, (120, 120, 100)),
                G(den("muscle"), (220, 90, 80)), G(den("ligament"), (90, 220, 255)), G(den("cartilage"), (120, 255, 160))],
               os.path.join(out, "preview", "denver_legs.png"), crop=([-0.3, 0.0, -0.2], [0.3, 1.2, 0.25]))
        render([G(lambda r: r["id"].startswith("VF_tarsal") or r["id"].startswith("VF_metatarsal") or r["id"].startswith("VF_toes"), (255, 120, 60)),
                G(lambda r: r["source"] == "denver" and r["kind"] in ("bone", "bone-group") and re.search(r"talus|calcaneus|navicular|cuboid|cuneiform", r["id"]) is not None, (120, 220, 255))],
               os.path.join(out, "preview", "denver_tarsals_vs_ct.png"), height=700, crop=([-0.2, 0.0, -0.12], [0.2, 0.2, 0.2]))
    if wu_report["present"]:
        wu = lambda rx: (lambda r: r["source"] == "wu2015" and re.search(rx, r["id"]) is not None)
        render([G(lambda r: r["id"] in ("VF_hip_left", "VF_hip_right", "VF_sacrum"), (110, 110, 95)),
                G(wu(r"pubovisceral|puborectal|coccygeal"), (230, 90, 80)), G(wu(r"anal_sphincter|rectococc|rectoperineal|conjoint"), (255, 190, 80)),
                G(wu(r"urethra|bulbospong|ischiocavern|perineal"), (120, 200, 255)), G(wu(r"clitoris|vestibular|bartholin"), (255, 110, 220)),
                G(lambda r: r["id"] in ("HRA_vagina", "HRA_body_of_uterus", "HRA_cervix", "VF_urinary_bladder"), (120, 255, 150))],
               os.path.join(out, "preview", "wu_pelvic_floor.png"), height=900, crop=([-0.17, 0.78, -0.12], [0.17, 1.0, 0.16]))
    render([G(skin, (150, 150, 150), True), G(lambda r: r["id"] == "HRA_skin", (255, 120, 170))],
           os.path.join(out, "preview", "skin_ct_vs_hra.png"))
    # re-posed arms against the male (male drawn after rigid trunk alignment + translation to the female shoulders' midpoint)
    arm_rx = r"VF_(humerus|radius|ulna|carpal|metacarpal|fingers|scapula|clavicula)_"
    armF = lambda r: re.match(arm_rx, r["id"]) is not None
    shF = (lmF["L"]["shoulder"] + lmF["R"]["shoulder"]) / 2
    shM = (lmM["L"]["shoulder"] + lmM["R"]["shoulder"]) / 2
    mparts = [p for k in ("humerus", "radius", "ulna", "carpal", "metacarpal", "scapula") for s in "LR" for p in male.select("skeletal", MALE_KEYS[k], s)]
    mparts += [p for s in "LR" for p in male.select("skeletal", r"phalanx of .*(finger|thumb)$|^clavicle$", s)]
    mpts = (male.points(mparts, 120000) - shM) @ Rtr + shF       # rows: Rtr^T applied
    trunk = lambda r: bone(r) and re.match(r"VF_(rib_|vertebrae_|sternum|sacrum|hip_)", r["id"]) is not None
    box = ([-0.36, 0.78, -0.2], [0.36, 1.52, 0.25])
    render([G(trunk, (70, 70, 60)), (mpts, (80, 170, 255), False), G(armF, (255, 200, 90), T=True)],
           os.path.join(out, "preview", "arms_reposed_vs_male.png"), crop=box)
    render([G(trunk, (70, 70, 60)), G(armF, (255, 110, 90)), G(armF, (255, 200, 90), T=True)],
           os.path.join(out, "preview", "arms_scanned_vs_reposed.png"), crop=box)
    print(json.dumps({"counts": manifest["counts"], "pose": pose["sides"], "trunk_deg": pose["trunk_alignment_female_to_male_deg"],
                      "pelvis": pelvis, "median_ratio": med, "outliers": [s for s in sizes if s["outlier"]],
                      "coverage_by_system": sanity["coverage_by_system"], "hra": hra_report.get("summary"), "denver": den_report.get("summary"),
                      "wu": {k: wu_report.get(k) for k in ("decoded", "scale_applied", "bones", "orientation_search")}}, indent=1))


if __name__ == "__main__":
    main()
