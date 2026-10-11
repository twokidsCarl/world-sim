"""Shared geometry helpers for the female anchor package (meshing, landmarks, frames, ICP, I/O)."""
import numpy as np
import trimesh
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage import measure

# ── label map -> mesh ─────────────────────────────────────────────────────────────────────────


def clean_mask(mask, keep_frac=0.05, largest_only=False):
    """drop stray components; returns (mask, removed volume fraction, kept component count)"""
    cc, n = ndi.label(mask)
    if n <= 1:
        return mask, 0.0, n
    vol = ndi.sum(mask, cc, np.arange(1, n + 1))
    keep = [int(np.argmax(vol)) + 1] if largest_only else [i + 1 for i, v in enumerate(vol) if v >= keep_frac * vol.max()]
    out = np.isin(cc, keep)
    return out, float(1 - out.sum() / mask.sum()), len(keep)


def mask_to_mesh(mask, origin_vox, sigma=0.7, taubin=12):
    """Marching cubes on a slightly blurred mask, then Taubin smoothing (no net shrinkage).
    Vertices are returned in voxel index coordinates of the full volume."""
    f = ndi.gaussian_filter(np.pad(mask, 3).astype(np.float32), sigma)
    v, faces, _, _ = measure.marching_cubes(f, 0.5)
    v = v - 3 + np.asarray(origin_vox, dtype=float)
    m = trimesh.Trimesh(v, faces, process=False)
    m.merge_vertices()
    if taubin:
        trimesh.smoothing.filter_taubin(m, lamb=0.5, nu=-0.53, iterations=taubin)
    return m


def decimate(mesh, target_faces):
    if len(mesh.faces) <= target_faces:
        return mesh
    out = mesh.simplify_quadric_decimation(face_count=int(target_faces))
    out.remove_unreferenced_vertices()
    return out


def signed_volume(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def sample_surface(v, f, n, seed=0):
    rng = np.random.default_rng(seed)
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    idx = rng.choice(len(f), size=n, p=area / area.sum())
    r1, r2 = np.sqrt(rng.random(n)), rng.random(n)
    return (1 - r1)[:, None] * a[idx] + (r1 * (1 - r2))[:, None] * b[idx] + (r1 * r2)[:, None] * c[idx]


def surface_distance(a_pts, b_pts):
    d, _ = cKDTree(b_pts).query(a_pts)
    return d


# ── landmarks and bone frames ─────────────────────────────────────────────────────────────────


def pca_axis(pts):
    c = pts.mean(0)
    _, _, vt = np.linalg.svd(pts - c, full_matrices=False)
    return c, vt


def unit(v):
    return v / np.linalg.norm(v)


def end_slab(pts, axis, centre, frac, far_from=None, near_to=None):
    """points in the terminal `frac` of the bone along `axis`; the end is chosen as the one
    nearest `near_to` (or farthest from `far_from`)"""
    t = (pts - centre) @ axis
    lo, hi = t.min(), t.max()
    a = pts[t <= lo + frac * (hi - lo)]
    b = pts[t >= hi - frac * (hi - lo)]
    ref = near_to if near_to is not None else far_from
    da, db = np.linalg.norm(a.mean(0) - ref), np.linalg.norm(b.mean(0) - ref)
    if near_to is not None:
        return a if da < db else b
    return a if da > db else b


def fit_sphere(pts):
    A = np.c_[2 * pts, np.ones(len(pts))]
    sol, *_ = np.linalg.lstsq(A, (pts ** 2).sum(1), rcond=None)
    c = sol[:3]
    return c, float(np.sqrt(max(sol[3] + c @ c, 0)))


def ransac_sphere(pts, rmin, rmax, tol=0.0012, iters=600, seed=0):
    """largest spherical cap with radius in [rmin, rmax] (metres) — femoral / humeral head"""
    rng = np.random.default_rng(seed)
    best = (None, 0, 0)
    for _ in range(iters):
        c, r = fit_sphere(pts[rng.choice(len(pts), 4, replace=False)])
        if not (rmin <= r <= rmax):
            continue
        inl = np.abs(np.linalg.norm(pts - c, axis=1) - r) < tol
        if inl.sum() > best[1]:
            best = (inl, int(inl.sum()), r)
    if best[0] is None:
        return pts.mean(0), float("nan"), 0.0
    c, r = fit_sphere(pts[best[0]])
    inl = np.abs(np.linalg.norm(pts - c, axis=1) - r) < tol
    c, r = fit_sphere(pts[inl])
    return c, r, float(inl.mean())


def frame(a1, a2_hint):
    """right-handed orthonormal frame (columns) with first axis a1 and second axis towards a2_hint"""
    a1 = unit(a1)
    a2 = unit(a2_hint - (a2_hint @ a1) * a1)
    return np.c_[a1, a2, np.cross(a1, a2)]


def rigid_about(R, pivot_from, pivot_to=None):
    """4x4 transform x' = pivot_to + R (x - pivot_from)"""
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = (pivot_from if pivot_to is None else pivot_to) - R @ pivot_from
    return T


def apply(T, pts):
    return pts @ T[:3, :3].T + T[:3, 3]


def rot_angle_deg(R):
    return float(np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))))


def kabsch(P, Q):
    """R, t minimising |R P + t - Q|"""
    pc, qc = P.mean(0), Q.mean(0)
    H = (P - pc).T @ (Q - qc)
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1, 1, d]) @ U.T
    return R, qc - R @ pc


def icp(src, dst, iters=40, trim=0.85, init=None):
    """trimmed point-to-point ICP of src onto dst (both Nx3, metres); returns 4x4, rms of kept pairs"""
    T = np.eye(4) if init is None else init.copy()
    tree = cKDTree(dst)
    rms = np.inf
    for _ in range(iters):
        cur = apply(T, src)
        d, idx = tree.query(cur)
        keep = d <= np.quantile(d, trim)
        R, t = kabsch(cur[keep], dst[idx[keep]])
        step = np.eye(4)
        step[:3, :3], step[:3, 3] = R, t
        T = step @ T
        new = float(np.sqrt((d[keep] ** 2).mean()))
        if abs(rms - new) < 1e-7:
            rms = new
            break
        rms = new
    d, _ = tree.query(apply(T, src))
    keep = d <= np.quantile(d, trim)
    return T, float(np.sqrt((d[keep] ** 2).mean()))


def ct_edge_offset(ct, A2V, v, f, n=6000):
    """Where is the bone edge in the CT relative to this surface? Mean HU profile along the outward
    normal (-4..+4 mm); the edge is the half-height crossing between the cortical peak and the soft
    tissue outside. Returns millimetres, positive = edge outside the surface; None if no clear edge."""
    m = trimesh.Trimesh(v, f, process=False)
    pts, fid = trimesh.sample.sample_surface(m, n, seed=2)
    nrm = m.face_normals[fid]
    steps = np.arange(-4.0, 4.01, 0.25) / 1000.0
    mean = np.array([ndi.map_coordinates(ct, apply(A2V, pts + t * nrm).T, order=1, mode="nearest").mean() for t in steps])
    k = int(np.argmax(mean))
    half = (mean[k] + mean[-4:].mean()) / 2
    for j in range(k, len(steps) - 1):
        if mean[j] >= half > mean[j + 1]:
            return float((steps[j] + (mean[j] - half) / (mean[j] - mean[j + 1]) * 0.00025) * 1000)
    return None


# ── male reference meshes (BodyParts3D OBJ, millimetres, x = left, y = posterior, z = up) ─────


def load_bp3d_obj(path):
    v, f = [], []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                v.append([float(x) for x in line.split()[1:4]])
            elif line.startswith("f "):
                idx = [int(p.split("/")[0]) - 1 for p in line.split()[1:]]
                for k in range(1, len(idx) - 1):
                    f.append([idx[0], idx[k], idx[k + 1]])
    v = np.array(v)
    # soma convention: metres, Y up, +Z anterior, +X left
    return np.c_[v[:, 0], v[:, 2], -v[:, 1]] / 1000.0, np.array(f, dtype=np.int64)


# ── package I/O ───────────────────────────────────────────────────────────────────────────────


class BinWriter:
    """one little-endian blob: per item float32 xyz positions then uint32 triangle indices"""

    def __init__(self, path):
        self.f = open(path, "wb")
        self.off = 0

    def add_array(self, a, dtype="<f4"):
        a = np.ascontiguousarray(a, dtype=dtype)
        rec = {"byteOffset": self.off, "count": int(a.size)}
        self.f.write(a.tobytes())
        self.off += a.nbytes
        return rec

    def add(self, v, faces):
        v = np.ascontiguousarray(v, dtype="<f4")
        faces = np.ascontiguousarray(faces, dtype="<u4")
        rec = {"positions": {"byteOffset": self.off, "count": int(len(v))}}
        self.f.write(v.tobytes())
        self.off += v.nbytes
        rec["indices"] = {"byteOffset": self.off, "count": int(faces.size)}
        self.f.write(faces.tobytes())
        self.off += faces.nbytes
        return rec

    def close(self):
        self.f.close()


# ── quick renders ─────────────────────────────────────────────────────────────────────────────


def render(groups, path, height=1300, views=("front", "side"), crop=None):
    """point-splat render. groups: list of (Nx3 points in soma convention, (r,g,b), dim: bool)"""
    from PIL import Image
    allv = np.vstack([g[0] for g in groups if len(g[0])])
    lo, hi = (allv.min(0), allv.max(0)) if crop is None else (np.array(crop[0]), np.array(crop[1]))
    scale = (height - 20) / (hi[1] - lo[1])
    widths = [int((hi[0] - lo[0]) * scale) + 20 if v == "front" else int((hi[2] - lo[2]) * scale) + 20 for v in views]
    img = np.zeros((height, sum(widths), 3), dtype=np.uint8)
    x0 = 0
    for view, w in zip(views, widths):
        for pts, col, dim in groups:
            if not len(pts):
                continue
            ok = np.all((pts >= lo) & (pts <= hi), axis=1)
            p = pts[ok]
            y = (height - 10 - (p[:, 1] - lo[1]) * scale).astype(int)
            x = (x0 + 10 + ((p[:, 0] - lo[0]) if view == "front" else (p[:, 2] - lo[2])) * scale).astype(int)
            c = np.array(col, dtype=np.uint8)
            if dim:
                img[y, x] = np.maximum(img[y, x], c // 2)
            else:
                img[y, x] = c
        x0 += w
    Image.fromarray(img).save(path)
