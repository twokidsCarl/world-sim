"""把 Wu 等（2015，PLoS ONE，CC BY）的女性盆底三维模型配准到 CT 锚定坐标系，生成 WU_ 条目。

来源：Wu Y, Dabhoiwala NF, Hagoort J, 等. 3D Topography of the Young Adult Anal Sphincter Complex
Reconstructed from Undeformed Serial Anatomical Sections. PLoS ONE 10(8): e0132226 (2015)；
交互式 3D-PDF 取自更正文章 doi:10.1371/journal.pone.0140736 的 S3 Fig。标本为中国可视化人
CVH5（年轻成年女性，冷冻切片，表面经过重建和平滑），与本项目的供体不是同一个人。

做法：
  1. 用 rh_mesh.py 解码 U3D 中的 47 个网格（单位按毫米处理；文件本身没有写明单位）。
  2. 模型只含小骨盆的下半部分。先在 24 个正交朝向中，用带缩放的截断 ICP 把“Pelvic bone”和
     “Sacral and coccygeal bone”对到 CT 的髋骨与骶骨上，取残差最小的朝向（只允许纯旋转，
     不允许镜像）。得到的缩放系数就是两个个体骨盆大小之比。
  3. 把 Pelvic bone 拆成左右两块，连同骶尾骨各做一次刚性 ICP，再用薄板样条把三块骨的位移
     插值成平滑位移场，软组织随位移场移动（与 HRA、Denver 的做法相同）。
  4. 与本项目已有的器官（HRA 子宫/阴道、CT 膀胱/直肠、Denver 闭孔内肌、CT 体表）比较位置。
所有条目都是 curated（另一个体、经过重建），不是 scanned。

Register the female pelvic floor model of Wu et al. (2015, PLoS ONE, CC BY) into the CT anchor
frame and produce WU_ items.

Source: Wu Y, Dabhoiwala NF, Hagoort J, et al. 3D Topography of the Young Adult Anal Sphincter
Complex Reconstructed from Undeformed Serial Anatomical Sections. PLoS ONE 10(8): e0132226 (2015);
the interactive 3D-PDF is S3 Fig of the correction, doi:10.1371/journal.pone.0140736. The specimen
is Chinese Visible Human CVH5 (young adult female, cryosections, surfaces reconstructed and
smoothed) - a different individual from this project's donor.

Method:
  1. Decode the 47 meshes of the U3D stream with rh_mesh.py (treated as millimetres; the file
     states no unit).
  2. The model covers only the lower half of the lesser pelvis. Among the 24 axis-aligned
     orientations, fit "Pelvic bone" and "Sacral and coccygeal bone" to the CT hip bones and
     sacrum by trimmed ICP with scale and keep the orientation with the lowest residual (proper
     rotations only, no mirroring). The fitted scale is the pelvis size ratio of the two people.
  3. Split the pelvic bone into its left and right pieces; fit each, and the sacrococcygeal
     piece, rigidly; interpolate the three bone displacements with a thin-plate spline; soft
     tissue rides that field (as for HRA and Denver).
  4. Compare positions with organs the package already has (HRA uterus / vagina, CT bladder /
     rectum, Denver obturator internus, CT body surface).
Every item is `curated` (another individual, remodelled), never `scanned`.
"""
import itertools
import os
import re

import numpy as np
import trimesh
from scipy.interpolate import RBFInterpolator
from scipy.spatial import ConvexHull, Delaunay, cKDTree

import rh_mesh
from anchorlib import apply, decimate, icp, rot_angle_deg, sample_surface, signed_volume

U3D = "wu2015_corr_pone.0140736.s004.u3d"
ATTR = ("Wu Y, Dabhoiwala NF, Hagoort J, et al. (2015) 3D Topography of the Young Adult Anal Sphincter Complex Reconstructed from "
        "Undeformed Serial Anatomical Sections. PLoS ONE 10(8): e0132226, doi:10.1371/journal.pone.0132226 "
        "(3D-PDF: S3 Fig of the correction, doi:10.1371/journal.pone.0140736), CC BY 4.0")

# 结构名 -> (类别, 男性模型中对应部件名的正则, 是否与包内已有条目重复[正则])
# structure -> (kind, regex over male part names, regex of an existing anchor it duplicates)
SPEC = {
    "Internal obturator muscle": ("muscle", r"^obturator internus$", r"^VD_obturator_internus_"),
    "Coccygeal muscle": ("muscle", r"^coccygeus$", None),
    "Pubovisceral muscle (inner layer)": ("muscle", r"^pubococcygeus$", None),
    "Pubovisceral muscle (external layer)": ("muscle", r"^pubococcygeus$", None),
    "Puborectal muscle (deep part)": ("muscle", r"^puborectalis$", None),
    "Puborectal muscle (superficial part)": ("muscle", r"^puborectalis$", None),
    "Rectal lumen": ("organ", None, None),
    "Smooth muscle of rectum": ("organ", r"^rectum$", r"^VF_colon$"),
    "Mesorectum": ("organ", None, None),
    "Rectococcygeal muscle": ("muscle", None, None),
    "Rectoperineal muscle": ("muscle", None, None),
    "Internal anal sphincter": ("muscle", r"^internal anal sphincter$", None),
    "Conjoint longitudinal muscle of rectum": ("muscle", None, None),
    "External anal sphincter": ("muscle", r"^external anal sphincter$", None),
    "Anal intermuscular septum": ("ligament", None, None),
    "Anococcygeal ligament": ("ligament", r"^anococcygeal (ligament|body|raphe)$", None),
    "Ovary": ("organ", None, r"^HRA_(left|right)_ovary$"),
    "Uterine wall": ("organ", None, r"^HRA_(body_of_uterus|fundus_of_uterus|cervix)$"),
    "Uterine tube": ("organ", None, r"^HRA_.*(uterine_tube|fallopian_tube)"),
    "Uterine and vaginal lumen": ("organ", None, None),
    "Round ligament of uterus": ("ligament", None, r"^HRA_(left|right)_round_ligament_of_uterus$"),
    "Vaginal wall": ("organ", None, r"^HRA_vagina$"),
    "Bartholin’s gland": ("organ", None, None),
    "Denonvillier’s fascia": ("ligament", None, None),
    "Perineal body": ("ligament", r"^perineal body$", None),
    "Deep perineal muscle": ("muscle", r"^deep transverse perineal( muscle)?$", None),
    "Superficial transverse perineal muscle": ("muscle", r"^superficial transverse perineal( muscle)?$", None),
    "Bladder wall": ("organ", r"^urinary bladder$", r"^VF_urinary_bladder$"),
    "Ureter": ("organ", r"^ureter$", None),
    "Pubovesical ligament": ("ligament", None, None),
    "Bladder and urethral lumen": ("organ", None, None),
    "Urethral sphincter proper": ("muscle", r"^(external urethral sphincter|sphincter urethrae)$", None),
    "Raphe of urethral sphincter": ("ligament", None, None),
    "Urethral compressor muscle": ("muscle", None, None),
    "Urethro-vaginal sphincter": ("muscle", None, None),
    "Submucous layer of urethra": ("organ", None, None),
    "Ischiocavernous muscle": ("muscle", r"^ischiocavernosus$", None),
    "Bulbospongiosus muscle": ("muscle", r"^bulbospongiosus$", None),
    "Vestibular bulb": ("organ", None, None),
    "Cavernous body of clitoris": ("organ", None, None),
    "Peritoneum": ("surface", None, None),
    "Fat tissue": ("surface", None, None),
    "Arteries": ("vessel", None, None),
    "Veins": ("vessel", None, None),
    "Pelvic bone": ("bone", r"^hip bone$", r"^VF_hip_"),
    "Sacral and coccygeal bone": ("bone", r"^(sacrum|coccyx)$", r"^VF_sacrum$"),
    "Skin": ("surface", None, None),
}
# 包内其他来源都没有的结构 / structures no other source in the package provides
NEW = ["Coccygeal muscle", "Pubovisceral muscle (inner layer)", "Pubovisceral muscle (external layer)", "Puborectal muscle (deep part)",
       "Puborectal muscle (superficial part)", "Rectococcygeal muscle", "Rectoperineal muscle", "Internal anal sphincter",
       "Conjoint longitudinal muscle of rectum", "External anal sphincter", "Anal intermuscular septum", "Anococcygeal ligament",
       "Bartholin’s gland", "Denonvillier’s fascia", "Perineal body", "Deep perineal muscle", "Superficial transverse perineal muscle",
       "Pubovesical ligament", "Bladder and urethral lumen", "Urethral sphincter proper", "Raphe of urethral sphincter",
       "Urethral compressor muscle", "Urethro-vaginal sphincter", "Submucous layer of urethra", "Ischiocavernous muscle",
       "Bulbospongiosus muscle", "Vestibular bulb", "Cavernous body of clitoris", "Mesorectum", "Rectal lumen", "Skin"]


def available(pf_dir):
    return os.path.exists(os.path.join(pf_dir, U3D))


def rotations24():
    out = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1, -1), repeat=3):
            R = np.zeros((3, 3))
            for i, (p, s) in enumerate(zip(perm, signs)):
                R[i, p] = s
            if np.linalg.det(R) > 0:
                out.append(R)
    return out


def similarity_icp(src, dst, R0, t0, s0=1.0, iters=60, trim=0.85):
    """带缩放的截断 ICP（Umeyama）；返回 s, R, t, rms。Trimmed ICP with scale (Umeyama)."""
    tree = cKDTree(dst)
    s, R, t = s0, R0, t0
    for _ in range(iters):
        cur = s * src @ R.T + t
        d, idx = tree.query(cur)
        keep = d <= np.quantile(d, trim)
        P, Q = src[keep], dst[idx[keep]]
        pc, qc = P.mean(0), Q.mean(0)
        H = (P - pc).T @ (Q - qc)
        U, S, Vt = np.linalg.svd(H)
        D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
        R = Vt.T @ D @ U.T
        s = float((S * np.diag(D)).sum() / ((P - pc) ** 2).sum())
        t = qc - s * R @ pc
    d, _ = tree.query(s * src @ R.T + t)
    keep = d <= np.quantile(d, trim)
    return s, R, t, float(np.sqrt((d[keep] ** 2).mean()))


def place(pf_dir, items, male, V2A, recs_so_far):
    # 有四个节点名带尾随空格 / four node names carry a trailing space
    meshes = {name.strip(): (v / 1000.0, f, info) for name, v, f, info in rh_mesh.read_u3d(open(os.path.join(pf_dir, U3D), "rb").read())}
    S = lambda iid, n=30000: sample_surface(items[iid]["v"], items[iid]["f"], n)
    P = lambda name, n=12000: sample_surface(meshes[name][0], meshes[name][1], n)
    hipL, hipR, sac = S("VF_hip_left"), S("VF_hip_right"), S("VF_sacrum")
    dst = np.vstack([hipL, hipR, sac])
    src = np.vstack([P("Pelvic bone", 20000), P("Sacral and coccygeal bone", 5000)])
    # 目标的下半部分用于初始平移 / lower part of the target, for the initial translation
    low = dst[dst[:, 1] < np.vstack([hipL, hipR])[:, 1].min() + 0.11]
    trials = []
    for R0 in rotations24():
        t0 = low.mean(0) - src.mean(0) @ R0.T
        s, R, t, rms = similarity_icp(src, dst, R0, t0)
        trials.append((rms, s, R, t))
    trials.sort(key=lambda x: x[0])
    rms0, s, R, t = trials[0]
    T0 = np.eye(4)
    T0[:3, :3], T0[:3, 3] = s * R, t
    G = {k: (apply(T0, v), f) for k, (v, f, _) in meshes.items()}        # 全局相似变换后的几何 / geometry after the global similarity fit

    # 每块骨一次刚性拟合 / one rigid fit per bone piece
    pb = trimesh.Trimesh(*G["Pelvic bone"], process=False)
    comps = sorted(pb.split(only_watertight=False), key=lambda m: -len(m.faces))[:2]
    pieces = {}
    for c in comps:
        side = "left" if c.vertices[:, 0].mean() > sac[:, 0].mean() else "right"
        pieces[f"pelvic bone, {side}"] = (sample_surface(np.asarray(c.vertices), np.asarray(c.faces), 8000), hipL if side == "left" else hipR)
    pieces["sacral and coccygeal bone"] = (sample_surface(*G["Sacral and coccygeal bone"], 5000), sac)
    fits, bones = {}, []
    for name, (p, target) in pieces.items():
        T, rms = icp(p, target, trim=0.85)
        fits[name] = (p, T)
        bones.append({"piece": name, "icp_rms_mm": round(rms * 1000, 2), "rotation_vs_global_deg": round(rot_angle_deg(T[:3, :3]), 2),
                      "translation_vs_global_mm": round(float(np.linalg.norm(T[:3, 3])) * 1000, 1)})
    rng = np.random.default_rng(4)
    C, D = [], []
    for p, T in fits.values():
        q = p[rng.choice(len(p), min(500, len(p)), replace=False)]
        C.append(q)
        D.append(apply(T, q) - q)
    C, D = np.vstack(C), np.vstack(D)
    tps = RBFInterpolator(C, D, kernel="thin_plate_spline", smoothing=1e-5)
    warp = lambda x: x + np.vstack([tps(x[i:i + 20000]) for i in range(0, len(x), 20000)])

    ids = {r["id"] for r in recs_so_far}
    recs, placed = [], {}
    for name, (v, f) in G.items():
        kind, rx, dup = SPEC.get(name, ("organ", None, None))
        m = trimesh.Trimesh(v, f, process=False)
        m.merge_vertices()
        per = {"bone": 2.0, "muscle": 2.0, "organ": 2.0, "ligament": 1.5, "vessel": 1.5, "surface": 8.0}[kind]
        m = decimate(m, int(np.clip(m.area * 1e6 / per, 200, 30000)))
        v1, f1 = warp(np.asarray(m.vertices)), np.asarray(m.faces)
        # 源网格各片的三角形绕向不一致（多壳体、经过重建），先统一绕向并使法线朝外；仍不一致时体积记为空
        # the source shells have inconsistent triangle winding (multi-shell, remodelled): make it consistent
        # and outward first; where that fails the volume is reported as null
        tm = trimesh.Trimesh(v1, f1, process=False)
        trimesh.repair.fix_normals(tm, multibody=True)
        f1 = np.asarray(tm.faces)
        volume = round(sum(abs(float(c.volume)) for c in tm.split(only_watertight=False)) * 1e6, 2) if tm.is_winding_consistent else None
        placed[name] = (v1, f1)
        mp = male.select(None, rx, "M") if rx else []
        corr = "none" if not mp else "one-to-one" if len(mp) == 1 else "group"
        alts = sorted(i for i in ids if dup and re.search(dup, i))
        why = ["different individual (young adult female, specimen CVH5), surfaces remodelled; placed by a similarity fit of the "
               "lower pelvis plus a bone-driven field, not this donor's own anatomy", "left and right sides are one mesh"]
        if alts:
            why.append("duplicates " + ", ".join(alts) + ", which stay preferred")
        if kind in ("vessel", "surface") or name in ("Mesorectum", "Rectal lumen", "Uterine and vaginal lumen", "Bladder and urethral lumen"):
            why.append("context structure (vessel tree, fat, peritoneum, lumen or skin patch) of limited use as an anchor")
        iid = "WU_" + re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", name.lower().replace("’s", ""))).strip("_")
        recs.append({
            "id": iid, "name": name, "side": "M", "kind": kind, "provenance": "curated", "source": "wu2015",
            "segmentation": {"tool": "manual reconstruction from cryosections (Amira), remodelled; decoded from the 3D-PDF with rh_mesh.py",
                             "task": "PLoS ONE e0132226 S3 Fig", "labels": [name]},
            "fma": None, "ontology_id": None, "male_parts": sorted(p["id"] for p in mp), "correspondence": corr,
            "quality": "usable", "quality_reasons": why, "note": "new structure: no other source in this package has it" if name in NEW else None,
            "follows": {"bones": ["VF_hip_left", "VF_hip_right", "VF_sacrum"]}, "duplicates": ", ".join(alts) or None,
            "alternatives": alts, "preferred": not alts,
            "triangles": int(len(f1)), "bbox": np.r_[v1.min(0), v1.max(0)].round(5).tolist(), "centroid": v1.mean(0).round(5).tolist(),
            "volume_ml": volume, "volume_voxel_ml": None, "pose": "both", "repose": None,
            "winding_consistent": bool(tm.is_winding_consistent), "watertight": bool(tm.is_watertight),
            "license": "CC BY 4.0", "attribution": ATTR, "_v": v1, "_f": f1, "_T": None})
        if not tm.is_winding_consistent:
            recs[-1]["quality_reasons"].append("triangle winding could not be made consistent (non-manifold source shell): do not rely on normals or volume")

    # ── 数值核对 / numeric checks ─────────────────────────────────────────────────────────────
    by = {r["id"]: r for r in recs_so_far}
    mm = lambda a: (np.asarray(a) * 1000).round(1).tolist()
    pts = lambda name, n=8000: sample_surface(*placed[name], n)
    ext = lambda iid, n=8000: sample_surface(by[iid]["_v"], by[iid]["_f"], n) if iid in by else None

    def pair(a_pts, b_pts):
        d1, d2 = cKDTree(b_pts).query(a_pts)[0], cKDTree(a_pts).query(b_pts)[0]
        return {"centroid_distance_mm": round(float(np.linalg.norm(a_pts.mean(0) - b_pts.mean(0))) * 1000, 1),
                "centroid_offset_mm (x=left, y=up, z=anterior)": mm(a_pts.mean(0) - b_pts.mean(0)),
                "mean_surface_distance_mm": round(float((d1.mean() + d2.mean()) / 2) * 1000, 1)}

    checks = {}
    vd = [ext(i) for i in ("VD_obturator_internus_left", "VD_obturator_internus_right") if i in by]
    if vd:
        checks["obturator internus vs Denver (same muscle, donor)"] = pair(pts("Internal obturator muscle"), np.vstack(vd))
    hu = [ext(i) for i in by if re.match(r"HRA_(body_of_uterus|fundus_of_uterus|cervix)$", i)]
    if hu:
        checks["uterine wall vs HRA uterus"] = pair(pts("Uterine wall"), np.vstack(hu))
    if "HRA_vagina" in by:
        checks["vaginal wall vs HRA vagina"] = pair(pts("Vaginal wall"), ext("HRA_vagina"))
    if "VF_urinary_bladder" in by:
        checks["bladder wall vs CT bladder"] = pair(pts("Bladder wall"), ext("VF_urinary_bladder"))
    ho = [ext(i) for i in by if re.match(r"HRA_(left|right)_ovary$", i)]
    if ho:
        checks["ovaries vs HRA ovaries"] = pair(pts("Ovary"), np.vstack(ho))
    if "VF_colon" in by:
        col = ext("VF_colon", 60000)
        rect = pts("Smooth muscle of rectum")
        near = col[(col[:, 1] < rect[:, 1].max()) & (np.abs(col[:, 0] - sac[:, 0].mean()) < 0.05)]
        if len(near) > 200:
            checks["rectum vs CT colon label below the top of the Wu rectum"] = pair(rect, near)
    if "VF_body_surface" in by:
        sk, body = pts("Skin"), ext("VF_body_surface", 200000)
        d = cKDTree(body).query(sk)[0]
        checks["perineal skin vs CT body surface"] = {"median_mm": round(float(np.median(d)) * 1000, 1), "p90_mm": round(float(np.quantile(d, 0.9)) * 1000, 1),
                                                      "note": "the donor is supine with thighs together and is far heavier; the Wu skin patch is a slab outline"}
    # 提肛肌裂孔是否包住本项目的尿道口/阴道/肛直肠：在裂孔高度的水平面上做二维凸包
    # does the levator hiatus enclose our urethra / vagina / anorectum: 2-D convex hull in the axial plane at hiatus height
    lev = np.vstack([pts(n, 6000) for n in ("Puborectal muscle (deep part)", "Puborectal muscle (superficial part)",
                                             "Pubovisceral muscle (inner layer)", "Pubovisceral muscle (external layer)")])
    pr = pts("Puborectal muscle (deep part)")
    y0, y1 = np.quantile(pr[:, 1], [0.2, 0.8])
    band = lev[(lev[:, 1] > y0) & (lev[:, 1] < y1)]
    hull = Delaunay(band[:, [0, 2]][ConvexHull(band[:, [0, 2]]).vertices])
    inside = lambda p: bool(hull.find_simplex(np.asarray(p)[[0, 2]][None])[0] >= 0)
    hiatus = {"plane_height_mm": mm([y0, y1]), "hull_width_mm": round(float(np.ptp(band[:, 0])) * 1000, 1), "hull_depth_mm": round(float(np.ptp(band[:, 2])) * 1000, 1)}

    def at_level(p):
        q = p[(p[:, 1] > y0 - 0.01) & (p[:, 1] < y1 + 0.01)]
        return q.mean(0) if len(q) > 20 else None

    probes = {"Wu urethra (submucous layer)": at_level(pts("Submucous layer of urethra")), "Wu vaginal wall": at_level(pts("Vaginal wall")),
              "Wu anorectum (internal anal sphincter / rectum)": at_level(np.vstack([pts("Internal anal sphincter"), pts("Smooth muscle of rectum")]))}
    if "HRA_vagina" in by:
        probes["HRA vagina (ours)"] = at_level(ext("HRA_vagina", 20000))
    if "VF_colon" in by:
        probes["CT colon / rectum label (ours)"] = at_level(ext("VF_colon", 80000))
    if "VF_urinary_bladder" in by:
        b = ext("VF_urinary_bladder", 20000)
        probes["CT bladder, lowest point (ours)"] = b[np.argmin(b[:, 1])]
    hiatus["structures_at_hiatus_level"] = {
        k: (None if v is None else {"position_mm": mm(v), "inside_levator_hull": inside(v),
                                    "height_relative_to_plane_mm": round(float(v[1] - (y0 + y1) / 2) * 1000, 1)}) for k, v in probes.items()}
    checks["levator hiatus"] = hiatus

    report = {
        "present": True, "decoded": {"structures": len(meshes), "vertices": int(sum(len(v) for v, _, _ in meshes.values())),
                                     "triangles": int(sum(len(f) for _, f, _ in meshes.values())),
                                     "all_payloads_consumed_exactly": all(i["consumed"] == i["size"] for _, _, i in meshes.values()),
                                     "node_transforms_identity": all(i["identity_transform"] for _, _, i in meshes.values())},
        "units_in": "millimetre (assumed from sizes; not stated in the file)",
        "native_to_anchor": {"matrix_row_major_mm_to_m": (T0 @ np.diag([0.001, 0.001, 0.001, 1.0])).round(8).ravel().tolist(),
                             "doc": "similarity transform of the global fit (before the bone-driven field): anchor_m = M * native_mm"},
        "orientation_search": {"best_rms_mm": round(rms0 * 1000, 2), "second_best_rms_mm": round(trials[1][0] * 1000, 2),
                               "mirroring": "not allowed; left/right of the source cannot be verified independently on a near-symmetric pelvis"},
        "scale_applied": round(s, 4), "subject_over_donor_pelvis_size": round(1 / s, 4),
        "bones": bones, "field_control_points": int(len(C)),
        "checks": checks,
        "new_structures": [n for n in NEW if n in meshes],
        "structures": [{"id": r["id"], "name": r["name"], "kind": r["kind"], "triangles_source": int(len(meshes[r["name"]][1])),
                        "triangles": r["triangles"], "volume_ml": r["volume_ml"], "male_parts": len(r["male_parts"]),
                        "preferred": r["preferred"]} for r in recs],
    }
    return recs, report
