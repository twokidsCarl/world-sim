"""Feasibility test: register Z-Anatomy (ZA) to BodyParts3D 4.0 using shared bones.

Usage: .venv/bin/python -I register_test.py <export dir> <bp3d obj dir> [out.json]

1. Pair every ZA skeletal object with the BP3D element of the same name.
2. Per-bone rigid ICP (ZA -> BP3D).  Residual tells whether the bone is the same shape
   (only moved) or re-sculpted.
3. Build a smooth warp (thin-plate-spline RBF on bone-surface control points carrying the
   per-bone rigid motion) and evaluate it on structures NOT used to build it:
   (a) soft tissue present in both atlases, (b) 5-fold held-out bones.
"""
import glob
import json
import re
import sys

import numpy as np
from scipy.interpolate import RBFInterpolator
from scipy.spatial import cKDTree

exp, bpdir = sys.argv[1], sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else None
rng = np.random.default_rng(0)
idx = json.load(open(f"{exp}/index.json"))
npz = np.load(f"{exp}/meshes.npz")

bp = {}
for p in glob.glob(f"{bpdir}/*.obj"):
    with open(p, errors="replace") as fh:
        for line in fh:
            if line.startswith("# English name"):
                bp[line.split(":", 1)[1].strip().lower()] = p
                break
            if not line.startswith("#"):
                break


def load_obj(p):
    v, f = [], []
    for line in open(p, errors="replace"):
        if line.startswith("v "):
            v.append(line.split()[1:4])
        elif line.startswith("f "):
            f.append([t.split("/")[0] for t in line.split()[1:4]])
    return np.array(v, float) * 1e-3, np.array(f, int) - 1


def sample(v, f, n):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    t = rng.choice(len(f), n, p=area / area.sum())
    r1, r2 = np.sqrt(rng.random(n))[:, None], rng.random(n)[:, None]
    return (1 - r1) * a[t] + r1 * (1 - r2) * b[t] + r1 * r2 * c[t]


def surf(A, B):
    d = np.concatenate([cKDTree(B).query(A)[0], cKDTree(A).query(B)[0]])
    return float(d.mean() * 1e3), float(np.percentile(d, 95) * 1e3)


def rigid(X, Y):
    mx, my = X.mean(0), Y.mean(0)
    U, _, Vt = np.linalg.svd((Y - my).T @ (X - mx))
    D = np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))])
    R = U @ D @ Vt
    return R, my - R @ mx


def icp(X, Y, iters=40):
    R, t = np.eye(3), Y.mean(0) - X.mean(0)
    tree = cKDTree(Y)
    for _ in range(iters):
        Xt = X @ R.T + t
        d, j = tree.query(Xt)
        keep = d <= np.percentile(d, 90)
        R, t = rigid(X[keep], Y[j[keep]])
    return R, t


def bp_name(zn):
    m = re.match(r"(.*)\.(l|r)$", zn)
    base, side = (m.group(1), {"l": "left ", "r": "right "}[m.group(2)]) if m else (zn, "")
    b = re.sub(r"\s*\(.*\)$", "", base.lower())
    for c in (side + b, side + re.sub(r" (bone|muscle)$", "", b), side + b + " bone"):
        if c in bp:
            return c
    return None


pairs = {}
for r in idx:
    if r.get("nf", 0) < 20 or re.search(r"\.[oe]\d*[lr]?$", r["name"]):
        continue
    b = bp_name(r["name"])
    if b:
        pairs[r["name"]] = (r, b)

bones, soft = [], []
for zn, (r, b) in pairs.items():
    zv, zf = npz[f"v{r['i']}"].astype(float), npz[f"f{r['i']}"]
    bv, bf = load_obj(bp[b])
    rec = {"za": zn, "bp": b, "system": r["system"], "zs": sample(zv, zf, 1500), "bs": sample(bv, bf, 1500)}
    (bones if r["system"].startswith("1") else soft).append(rec)
print(f"paired by name: {len(bones)} skeletal objects, {len(soft)} other structures")

for b in bones:
    R, t = icp(b["zs"], b["bs"])
    b["R"], b["t"] = R, t
    b["icp_mean"], b["icp_p95"] = surf(b["zs"] @ R.T + t, b["bs"])
    b["raw_mean"], _ = surf(b["zs"], b["bs"])
    b["rot_deg"] = float(np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))))
    c = b["zs"].mean(0)
    b["disp_mm"] = ((R @ c + t - c) * 1e3)

res = np.array([b["icp_mean"] for b in bones])
print(f"per-bone rigid ICP residual (sym. mean surface dist, mm): median {np.median(res):.2f}, "
      f"p90 {np.percentile(res, 90):.2f}, max {res.max():.2f}; bones < 1 mm: {(res < 1).sum()}/{len(res)}, < 2 mm: {(res < 2).sum()}/{len(res)}")
D = np.array([b["disp_mm"] for b in bones])
print(f"per-bone displacement ZA->BP3D (mm): mean {D.mean(0).round(1).tolist()}, std {D.std(0).round(1).tolist()}, "
      f"min {D.min(0).round(1).tolist()}, max {D.max(0).round(1).tolist()}")
rot = np.array([b["rot_deg"] for b in bones])
print(f"per-bone rotation (deg): median {np.median(rot):.2f}, p90 {np.percentile(rot, 90):.2f}, max {rot.max():.2f}")
worst = sorted(bones, key=lambda b: -b["icp_mean"])[:12]
print("worst bones after rigid ICP (re-sculpted / different segmentation):",
      "; ".join(f"{b['za']} {b['icp_mean']:.1f}" for b in worst))
print("examples:")
for n in ["Femur.l", "Tibia.l", "Calcaneus.l", "Hip bone.l", "Sacrum", "Humerus.l", "Radius.l", "Scapula.l",
          "Clavicle.l", "Mandible", "Frontal bone", "Occipital bone", "First rib.l", "Sternum", "Atlas (C1)", "Vertebra L3"]:
    for b in bones:
        if b["za"] == n:
            print(f"  {n:16s} disp_mm={b['disp_mm'].round(1).tolist()} rot={b['rot_deg']:.2f} deg  raw surf={b['raw_mean']:.1f}  after rigid={b['icp_mean']:.2f} (p95 {b['icp_p95']:.2f})")


def build(bs, k=60):
    P = np.concatenate([b["zs"][:k] for b in bs])
    Q = np.concatenate([b["zs"][:k] @ b["R"].T + b["t"] for b in bs])
    return RBFInterpolator(P, Q - P, kernel="thin_plate_spline", neighbors=200, smoothing=1e-6)


good = [b for b in bones if b["icp_mean"] < 3.0]
warp = build(good)
T0 = np.median(np.array([b["disp_mm"] for b in bones]), axis=0) * 1e-3
print(f"\nwarp built from {len(good)} bones; baseline = single global translation {np.round(T0*1e3,1).tolist()} mm")
print(f"{'held-out soft tissue':40s} {'raw':>7s} {'transl.':>8s} {'warp mean':>9s} {'warp p95':>8s}")
rows = []
for s in sorted(soft, key=lambda s: (s["system"], s["za"])):
    raw, _ = surf(s["zs"], s["bs"])
    tr, _ = surf(s["zs"] + T0, s["bs"])
    wm, wp = surf(s["zs"] + warp(s["zs"]), s["bs"])
    rows.append({"za": s["za"], "system": s["system"], "raw": raw, "translation": tr, "warp_mean": wm, "warp_p95": wp})
for sysn in sorted({r["system"] for r in rows}):
    sel = [r for r in rows if r["system"] == sysn]
    f = lambda k: np.median([r[k] for r in sel])
    print(f"{sysn[:34]+' (n='+str(len(sel))+')':40s} {f('raw'):7.1f} {f('translation'):8.1f} {f('warp_mean'):9.2f} {f('warp_p95'):8.2f}   (medians, mm)")
wm = np.array([r["warp_mean"] for r in rows])
print(f"all soft tissue n={len(rows)}: warp mean-surface-distance median {np.median(wm):.2f} mm, p75 {np.percentile(wm,75):.2f}, p90 {np.percentile(wm,90):.2f}; <3 mm: {(wm<3).sum()}, <5 mm: {(wm<5).sum()}")
print("worst:", "; ".join(f"{r['za']} {r['warp_mean']:.1f}" for r in sorted(rows, key=lambda r: -r['warp_mean'])[:15]))

cv = []
order = rng.permutation(len(good))
for k in range(5):
    test = [good[i] for i in order[k::5]]
    w = build([good[i] for i in order if i not in set(order[k::5])])
    for b in test:
        cv.append(surf(b["zs"] + w(b["zs"]), b["bs"])[0])
cv = np.array(cv)
print(f"5-fold held-out bones: warp residual median {np.median(cv):.2f} mm, p90 {np.percentile(cv,90):.2f}, max {cv.max():.2f}")
if out:
    json.dump({"bones": [{k: (v.tolist() if isinstance(v, np.ndarray) else v) for k, v in b.items() if k not in ("zs", "bs")} for b in bones],
               "soft": rows, "cv_bone_mm": cv.tolist()}, open(out, "w"))
