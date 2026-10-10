"""Quantify the Z-Anatomy frame against BodyParts3D 4.0 on shared structures.

Usage: .venv/bin/python -I compare_frame.py <export dir> <bp3d obj dir> [out.json]

BP3D: millimetres, Z up, left = +x, anterior = -y.  Z-Anatomy export: metres.
Pairs are matched by name ("Femur.l" <-> "left femur").  Reports, per pair, the
area-weighted surface-centroid offset, bbox-size difference and symmetric mean /
95th-percentile surface distance (a) with only the unit change mm->m and (b) after one
global similarity transform fitted (Umeyama) on all paired centroids.
"""
import glob
import json
import re
import sys

import numpy as np
from scipy.spatial import cKDTree

exp, bpdir = sys.argv[1], sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else None
idx = json.load(open(f"{exp}/index.json"))
npz = np.load(f"{exp}/meshes.npz")
za = {r["name"]: r for r in idx}

# BP3D element name -> file (from OBJ headers)
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


def sample(v, f, n=4000, rng=np.random.default_rng(0)):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    cen = ((a + b + c) / 3 * area[:, None]).sum(0) / area.sum()
    t = rng.choice(len(f), n, p=area / area.sum())
    r1, r2 = np.sqrt(rng.random(n))[:, None], rng.random(n)[:, None]
    return (1 - r1) * a[t] + r1 * (1 - r2) * b[t] + r1 * r2 * c[t], cen, area.sum()


def surf(A, B):
    d1 = cKDTree(B).query(A)[0]
    d2 = cKDTree(A).query(B)[0]
    d = np.concatenate([d1, d2])
    return float(d.mean()), float(np.percentile(d, 95))


def umeyama(X, Y):  # Y ~ s R X + t
    mx, my = X.mean(0), Y.mean(0)
    Xc, Yc = X - mx, Y - my
    U, S, Vt = np.linalg.svd(Yc.T @ Xc / len(X))
    D = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (Xc ** 2).sum(1).mean()
    return s, R, my - s * R @ mx


def bp_name(zn):
    m = re.match(r"(.*)\.(l|r)$", zn)
    base, side = (m.group(1), {"l": "left ", "r": "right "}[m.group(2)]) if m else (zn, "")
    b = base.lower()
    cands = [side + b, side + re.sub(r" bone$", "", b), side + b + " bone", side + re.sub(r" muscle$", "", b)]
    for c in cands:
        if c in bp:
            return c
    return None


WANT = ["Femur", "Tibia", "Fibula", "Patella", "Humerus", "Radius", "Ulna", "Clavicle", "Scapula",
        "Hip bone", "Calcaneus", "Talus", "Sacrum", "Sternum", "Mandible", "Occipital bone", "Frontal bone",
        "Parietal bone", "Temporal bone", "Sphenoid", "Sphenoid bone", "Atlas (C1)", "Atlas", "Axis (C2)", "Axis",
        "First rib", "Vertebra L5", "Fifth lumbar vertebra", "Lumbar vertebra (L5)", "Third metacarpal bone",
        "First metatarsal bone", "Kidney", "Hyoid bone", "Zygomatic bone", "Maxilla", "Spleen", "Stomach",
        "Urinary bladder", "Pancreas", "Thyroid cartilage", "Biceps brachii", "Sartorius", "Sartorius muscle",
        "Gluteus maximus", "Gluteus maximus muscle", "Deltoid", "Deltoid muscle", "Rectus femoris",
        "Rectus femoris muscle", "Soleus", "Soleus muscle", "Trachea", "Gallbladder", "Prostate", "Testis"]
pairs = []
for w in WANT:
    for suffix in ("", ".l", ".r"):
        zn = w + suffix
        if zn in za and za[zn].get("nv"):
            b = bp_name(zn)
            if b:
                pairs.append((zn, b))

rows, ZC, BC, cache = [], [], [], {}
for zn, bn in pairs:
    i = za[zn]["i"]
    zv, zf = npz[f"v{i}"].astype(float), npz[f"f{i}"]
    bv, bf = load_obj(bp[bn])
    zs, zc, zarea = sample(zv, zf)
    bs, bc, barea = sample(bv, bf)
    cache[zn] = (zs, bs)
    ZC.append(zc)
    BC.append(bc)
    m0, p0 = surf(zs, bs)
    rows.append({"za": zn, "bp3d": bn, "system": za[zn]["system"],
                 "za_nv": len(zv), "bp_nv": len(bv),
                 "centroid_offset_mm": ((zc - bc) * 1e3).round(2).tolist(),
                 "centroid_dist_mm": round(float(np.linalg.norm(zc - bc)) * 1e3, 2),
                 "bbox_size_diff_mm": (((zv.max(0) - zv.min(0)) - (bv.max(0) - bv.min(0))) * 1e3).round(2).tolist(),
                 "area_ratio": round(zarea / barea, 3),
                 "surf_mean_mm": round(m0 * 1e3, 2), "surf_p95_mm": round(p0 * 1e3, 2)})

ZC, BC = np.array(ZC), np.array(BC)
bone = np.array([r["system"].startswith("1") for r in rows])
s, R, t = umeyama(ZC[bone], BC[bone])  # maps Z-Anatomy -> BP3D, fitted on bones only
ang = np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1)))
for r, zc, bc in zip(rows, ZC, BC):
    zs, bs = cache[r["za"]]
    m1, p1 = surf(s * zs @ R.T + t, bs)
    r["after_fit_centroid_mm"] = round(float(np.linalg.norm(s * R @ zc + t - bc)) * 1e3, 2)
    r["after_fit_surf_mean_mm"] = round(m1 * 1e3, 2)
    r["after_fit_surf_p95_mm"] = round(p1 * 1e3, 2)

print(f"pairs: {len(rows)} (bones: {int(bone.sum())})")
print(f"global similarity fit ZA->BP3D on bone centroids: scale={s:.5f} rot={ang:.3f} deg t_mm={np.round(t*1e3,2).tolist()}")
hdr = f"{'structure':34s} {'dC mm (x,y,z)':>24s} {'|dC|':>6s} {'dBBox mm (x,y,z)':>24s} {'surf':>5s} {'p95':>6s} | {'fit|dC|':>7s} {'surf':>5s} {'p95':>6s}"
print(hdr)
for r in rows:
    print(f"{r['za'][:34]:34s} {str(r['centroid_offset_mm']):>24s} {r['centroid_dist_mm']:6.2f} {str(r['bbox_size_diff_mm']):>24s} "
          f"{r['surf_mean_mm']:5.2f} {r['surf_p95_mm']:6.2f} | {r['after_fit_centroid_mm']:7.2f} {r['after_fit_surf_mean_mm']:5.2f} {r['after_fit_surf_p95_mm']:6.2f}")
for label, mask in (("bones", bone), ("non-bones", ~bone)):
    if mask.any():
        sel = [r for r, m in zip(rows, mask) if m]
        f = lambda k: np.array([r[k] for r in sel])
        print(f"{label}: n={len(sel)} median |dC|={np.median(f('centroid_dist_mm')):.2f} mm, max={f('centroid_dist_mm').max():.2f}; "
              f"median surf mean={np.median(f('surf_mean_mm')):.2f} mm, median p95={np.median(f('surf_p95_mm')):.2f}, max p95={f('surf_p95_mm').max():.2f}; "
              f"after fit median surf mean={np.median(f('after_fit_surf_mean_mm')):.2f}")
if out:
    json.dump({"scale": s, "R": R.tolist(), "t_m": t.tolist(), "rot_deg": ang, "rows": rows}, open(out, "w"), indent=1)
