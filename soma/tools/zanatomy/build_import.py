"""Build the Z-Anatomy / Open3DModel import package for the geometry pipeline.

Usage (from the soma project root):
  tools/zanatomy/.venv/bin/python -I tools/zanatomy/build_import.py

Reads   data/raw/z-anatomy/out/export            (export.py, Z-Anatomy, Blender frame)
        data/raw/z-anatomy/out/open3d/{upper-limb,lower-limb}  (export_o3d.py)
        data/raw/z-anatomy/repo/TA2.csv, wikidata/ta2_items.tsv, fma/fma_names.tsv
        data/raw/bodyparts3d/*, public/anatomy/male/anatomy.json (read only)
        tools/zanatomy/o3d_nerves.tsv, tools/zanatomy/za_manual_fma.tsv (hand tables)
Writes  data/raw/z-anatomy/out/import/{manifest.json,centrelines.json,nerves.bin,parts.bin,
        anchors.bin,build_log.txt}

Output frame: the SOURCE frame (Z-Anatomy or Open3DModel; not registered to BodyParts3D),
axes/units converted to ours: metres, Y up, anterior +Z, left +X  ((x,y,z) -> (x,z,-y)).
"""
import csv
import glob
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

ROOT = os.getcwd()
Z = f"{ROOT}/data/raw/z-anatomy"
OUT = f"{Z}/out/import"
TOOLS = f"{ROOT}/tools/zanatomy"
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(0)
LOG = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def ax(v):  # Blender (Z up, anterior -y) -> ours (Y up, anterior +Z); proper rotation
    v = np.asarray(v, dtype=np.float64)
    return np.stack([v[..., 0], v[..., 2], -v[..., 1]], -1)


def zid(source, obj, unit=""):
    return "ZA" + hashlib.sha1(f"{source}|{obj}|{unit}".encode()).hexdigest()[:8].upper()


# ----------------------------------------------------------------------------- names
SPELL = [("oesophag", "esophag"), ("caec", "cec"), ("haem", "hem"), ("coeliac", "celiac"),
         ("faec", "fec"), ("bucinator", "buccinator"), ("grey", "gray"), ("fibres", "fibers"), ("tuberculum", "tubercle")]


def norm(s):
    s = s.lower().strip()
    s = re.sub(r"\s*\((?:[ivx]+|b[ivx+]+|c\d|[tl]\d+)\)$", "", s)
    s = s.strip("()*' ")
    return re.sub(r"\s+", " ", s)


def variants(n):
    n0 = norm(n)
    out = []
    for a in (n0, n0.replace("-", ""), n0.replace("-", " ")):
        b = a
        for x, y in SPELL:
            b = b.replace(x, y)
        for c in (a, b):
            out += [c, re.sub(r" (muscle|bone|gland)$", "", c), c + " muscle", "set of " + c]
            if c.endswith("s"):
                out.append(c[:-1])
    seen, res = set(), []
    for o in out:
        if o not in seen:
            seen.add(o)
            res.append(o)
    return res


# FMA release (labels, synonyms, parents)
FMA_LABEL, FMA_PAR, FMA_NAME = {}, {}, {}
FMA_PREF = {}
for row in csv.reader(open(f"{Z}/fma/fma_names.tsv", encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE):
    if row[0] == "fmaid":
        continue
    FMA_LABEL[row[0]] = row[1]
    FMA_PAR[row[0]] = [p for p in row[4].split("|") if p]
    FMA_PREF.setdefault(row[1].lower(), row[0])
for fid, lab in FMA_LABEL.items():
    FMA_NAME.setdefault(lab.lower(), fid)
for row in csv.reader(open(f"{Z}/fma/fma_names.tsv", encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE):
    if row[0] == "fmaid":
        continue
    for s in row[2].split("|"):
        if s:
            FMA_NAME.setdefault(s.lower(), row[0])  # preferred labels win over synonyms


def uq(s):
    return re.sub(r'^"(.*)"(@en)?$', r"\1", s)


WD_TA2 = {}
for row in csv.reader(open(f"{Z}/wikidata/ta2_items.tsv"), delimiter="\t", quoting=csv.QUOTE_NONE):
    if len(row) >= 5 and not row[0].startswith("?") and uq(row[4]):
        WD_TA2.setdefault(uq(row[2]), "FMA" + uq(row[4]))

TA2 = {}
for line in open(f"{Z}/repo/TA2.csv", encoding="utf-8-sig"):
    parts = line.strip().strip('"').split(";")
    if len(parts) > 2 and parts[0].isdigit():
        TA2.setdefault(norm(parts[1]), {"ta2": parts[0], "en": parts[1], "la": parts[2]})


def ta2_of(name):
    for v in (norm(name), norm(name).replace(" muscle", ""), norm(name) + " muscle"):
        if v in TA2:
            return TA2[v]
    return None


def tokens(s):
    return set(re.findall(r"[a-z]+", s.lower())) - {"of", "the", "to", "and", "set", "nerve", "nerves", "muscle",
                                                    "branch", "branches", "left", "right"}


def stem(t):
    return re.sub(r"(es|s|al|ar|ic|eal|ous|um|us|a)$", "", t)[:5]


def fma_by_label(labels):
    for lab in labels:
        f = FMA_NAME.get(lab.lower().strip())
        if f:
            return f, lab
    return None, None


def sided_fma(unsided, side):
    """FMA class for the left/right variant; accepted only if its FMA parent is the unsided class."""
    if side not in ("L", "R") or not unsided:
        return None
    w = "left" if side == "L" else "right"
    lab = FMA_LABEL[unsided]
    low = lab[0].lower() + lab[1:]
    cands = [f"{w} {low}"]
    toks = low.split(" ")
    for i in range(1, len(toks)):
        cands.append(" ".join(toks[:i] + [w] + toks[i:]))
    for c in cands:
        f = FMA_PREF.get(c)
        if f and unsided in FMA_PAR.get(f, []):
            return f
    return None


def _n2(x):
    x = norm(x).replace("-", " ")
    for a_, b_ in SPELL:
        x = x.replace(a_, b_)
    x = re.sub(r"\b(muscle|bone|gland)$", "", x).strip().replace("brachial nerve plexus", "brachial plexus")
    return re.sub(r"\s+", " ", x)


FMA_SYN = defaultdict(list)
for _row in csv.reader(open(f"{Z}/fma/fma_names.tsv", encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE):
    if _row[0] != "fmaid":
        FMA_SYN[_row[0]] = [x for x in _row[2].split("|") if x]


def match_class(name, unsided, generated=False):
    """How the item name relates to the (unsided) FMA class it is mapped to."""
    n = _n2(name)
    pref = _n2(FMA_LABEL[unsided])
    syn = {_n2(x) for x in FMA_SYN[unsided]}
    if n == pref:
        return "preferred-label"
    if n in syn:
        return "synonym"
    if "set of " + n == pref or "set of " + n in syn:
        return "set-class"
    if n.endswith("s") and any(x in ({pref} | syn) for x in (n[:-1], re.sub(r"(nerve|branche|ligament|node|vein)s\b", lambda m: m.group(1).rstrip("e") if m.group(1) == "branche" else m.group(1), n))):
        return "singular-class-for-set"
    if generated:
        return "generated-level-label"
    return "curated-equivalent"


MANUAL = {}
for line in open(f"{TOOLS}/za_manual_fma.tsv", encoding="utf-8"):
    if line.startswith("#") or not line.strip():
        continue
    c = line.rstrip("\n").split("\t")
    MANUAL[norm(c[0])] = {"labels": [] if c[1] == "-" else c[1].split(";"), "note": c[2] if len(c) > 2 else ""}

FMA_STATS = Counter()
MISMATCH = []


def resolve_fma(name, side, ta2=None, labels=None, note=None, generated=False):
    """-> dict(fma, fmaUnsided, fmaSource, fmaNote).  Never guesses: null when nothing matches."""
    res = {"fma": None, "fmaUnsided": None, "fmaSource": None}
    unsided, src, n = None, None, note
    key = norm(name)
    if labels is not None:  # caller supplied hand-table labels (possibly empty = force null)
        f, lab = fma_by_label(labels)
        if f:
            unsided = f
            src = "name-match" if generated or lab.lower() in [v for v in variants(name)] else "manual"
    elif key in MANUAL:
        f, lab = fma_by_label(MANUAL[key]["labels"])
        n = MANUAL[key]["note"]
        if f:
            unsided, src = f, "manual"
    else:
        for v in variants(name):
            if v in FMA_NAME:
                unsided, src = FMA_NAME[v], "name-match"
                break
        wd = WD_TA2.get(ta2) if ta2 else None
        if wd and wd not in FMA_LABEL:
            wd = None
        if unsided is None and wd:
            # sanity check of the crosswalk: FMA label must share a word stem with the name
            a = {stem(t) for t in tokens(name)}
            b = {stem(t) for t in tokens(FMA_LABEL[wd])}
            if a & b:
                unsided, src = wd, "ta2-wikidata"
            else:
                MISMATCH.append((name, ta2, wd, FMA_LABEL[wd]))
                n = f"TA2 {ta2} -> Wikidata -> {wd} '{FMA_LABEL[wd]}' rejected (label does not match name)"
        elif unsided and wd and wd != unsided:
            FMA_STATS["name-match disagrees with ta2-wikidata"] += 1
    if unsided:
        s = sided_fma(unsided, side)
        res.update(fma=s or unsided, fmaUnsided=unsided, fmaSource=src,
                   fmaSided=bool(s) if side in ("L", "R") else None, fmaLabel=FMA_LABEL[s or unsided],
                   fmaUnsidedLabel=FMA_LABEL[unsided], fmaMatch=match_class(name, unsided, generated))
        if side in ("L", "R") and not s:
            # lateralised item, FMA has no left/right class: `fma` is the UNSIDED concept; mint a sided id from fma + side
            res["fmaIsUnsided"] = True
    if n:
        res["fmaNote"] = n
    return res


# ----------------------------------------------------------------------------- our model
A = json.load(open(f"{ROOT}/public/anatomy/male/anatomy.json"))
# The live anatomy.json may already contain parts merged from this very package (ids "ZA..."). "Ours" here means
# the BodyParts3D base only: non-ZA parts plus the tree concepts above them.
PARTS = [p for p in A["parts"] if not p["id"].startswith("ZA")]
_base_ids = {p["id"] for p in PARTS}
OUR_FMA = {p["fma"] for p in PARTS}
for _t in A["trees"].values():
    _par = {c["id"]: c["parent"] for c in _t}
    for c in _t:
        if _base_ids & set(c["parts"]):
            k = c["id"]
            while k and k not in OUR_FMA | {None}:
                OUR_FMA.add(k)
                k = _par.get(k)
            k = _par.get(c["id"])
            while k:
                OUR_FMA.add(k)
                k = _par.get(k)
PART_BY_NAME = defaultdict(list)
for p in PARTS:
    PART_BY_NAME[p["name"].lower()].append(p)
OUR_NAMES = set(PART_BY_NAME) | {c["name"].lower() for t in A["trees"].values() for c in t if c["id"] in OUR_FMA}
log(f"our anatomy.json (BodyParts3D base only, {len(A['parts']) - len(PARTS)} already-merged ZA parts ignored): {len(PARTS)} parts, {len(OUR_FMA)} FMA concepts")

# Current model = BodyParts3D base + already merged ZA / R3 parts.  Used only for batch 2 ("what is still missing").
CUR_FMA = {p["fma"] for p in A["parts"]}
CUR_NAMES = {p["name"].lower() for p in A["parts"]}
CUR_IDS = {p["id"] for p in A["parts"]}


def in_current(rec, base, side):
    if rec.get("fma") and (rec["fma"] in CUR_FMA or rec.get("fmaUnsided") in CUR_FMA):
        return True
    w = {"L": "left ", "R": "right "}.get(side, "")
    return any(x in CUR_NAMES for x in (norm(base), w + norm(base), w + norm(base).replace(" muscle", "")))


def mesh_quality(v, f):
    """Closedness / wall thickness of a mesh (source units: metres)."""
    e = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), 1)
    _, c = np.unique(e, axis=0, return_counts=True)
    nc, _ = components(len(v), f)
    a, b, cc = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    area = float(np.linalg.norm(np.cross(b - a, cc - a), axis=1).sum() / 2)
    closed = bool((c == 1).sum() == 0)
    q = {"closed": closed, "boundaryEdges": int((c == 1).sum()), "nonManifoldEdges": int((c > 2).sum()), "components": int(nc),
         "areaCm2": round(area * 1e4, 2)}
    if closed and area > 0:
        vol = abs(float(np.einsum("ij,ij->i", a, np.cross(b, cc)).sum() / 6))
        q["volumeCm3"] = round(vol * 1e6, 3)
        q["meanThicknessMm"] = round(2 * vol / area * 1e3, 2)  # 2V/A: wall thickness for a sheet, ~diameter/2 for a tube
    return q


REQUESTED = [("spinal cord", r"spinal cord|^central canal"), ("meninges", r"\bdura\b|arachnoid|pia mater|falx|tentorium|diaphragma sellae"),
             ("pleura", r"pleura"), ("pericardium", r"pericardium"), ("salivary gland", r"parotid (gland|duct)|submandibular (gland|duct)|sublingual gland"),
             ("meniscus", r"menisc(us|i)\b|horn of (lateral|medial) meniscus"), ("cruciate ligament", r"cruciate ligament"),
             ("fat", r"\bfat\b|adipose"), ("peritoneum / omentum", r"periton|omentum|mesocolon|meso-?appendix|mesentery"),
             ("joint capsule", r"capsule"), ("vertebral ligament", r"supraspinous|interspinous|flav|intertransverse|longitudinal ligament|nuchal"),
             ("large intestine / anal canal", r"caecum|cecum|sigmoid colon|anal canal|\banal\b|rectum|pubo-analis"),
             ("nail", r"nail plate|perionyx")]


def batch2_group(base, s0, tissue):
    """None = stays a listed-only candidate.  Otherwise the batchGroup label."""
    b = base.lower()
    if not re.search(r"[a-z]{3}", b):
        return None  # junk object names ('????????', '?x')
    if base in ("Malleus", "Incus", "Stapes", "Tympanic membrane", "Auditory tube"):
        return None  # middle ear: left alone (NC-risk)
    for label, rx in REQUESTED:
        if re.search(rx, b) and not re.search(r"\bnodes?\b|artery|vein|nerve|region", b):
            return "requested: " + label
    if s0 in "1345" or s0 == "8":
        return "extra: " + {"1": "skeletal", "3": "joint", "4": "muscular", "5": "vessel", "8": "viscera"}[s0]
    if s0 == "7" and tissue != "brain":
        return "extra: sense organ"
    return None


FINGER_H = {"first": "thumb", "second": "index finger", "third": "middle finger", "fourth": "ring finger", "fifth": "little finger"}
FINGER_F = {"first": "big toe", "second": "second toe", "third": "third toe", "fourth": "fourth toe", "fifth": "little toe"}
ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"]
REG = {"C": "cervical", "T": "thoracic", "L": "lumbar", "S": "sacral"}


def bp3d_part_names(base, side):
    """Candidate BodyParts3D part names (lower case) for a Z-Anatomy / Open3DModel object."""
    b = norm(base).replace("_", " ")
    w = {"L": "left", "R": "right"}.get(side)
    alts = [b, re.sub(r" (bone|muscle)$", "", b), b + " bone", b.replace("oesophag", "esophag")]
    m = re.match(r"(distal|middle|proximal) phalanx of (\w+) finger of (hand|foot)$", b)
    if m:
        alts.append(f"{m.group(1)} phalanx of {(FINGER_H if m.group(3) == 'hand' else FINGER_F)[m.group(2)]}")
    m = re.match(r"vertebra ([ctl])(\d+)$", b)
    if m:
        alts.append(f"{ORD[int(m.group(2))]} {REG[m.group(1).upper()]} vertebra")
    m = re.match(r"costal cartilage of (\w+) rib$", b)
    if m:
        alts.append(f"{m.group(1)} costal cartilage")
    m = re.match(r"(upper|lower) (medial incisor|lateral incisor|canine|first premolar|second premolar|first molar tooth|second molar tooth|third molar tooth)$", b)
    if m:
        t = m.group(2).replace(" tooth", "").replace("medial", "central")
        if t == "canine":
            alts.append(f"{m.group(1)} secondary canine tooth")
        else:
            q, kind = t.split(" ")
            alts.append(f"{m.group(1)} {q} secondary {kind} tooth")
    alts += {"navicular bone": ["navicular bone of foot"], "triquetrum bone": ["triquetral"], "manubrium of sternum": ["manubrium"],
             "atlas": ["atlas"], "axis": ["axis"], "ethmoid bone": ["ethmoid"], "sphenoid bone": ["sphenoid"],
             "pisiform bone": ["pisiform"], "hamate bone": ["hamate"], "capitate bone": ["capitate"]}.get(b, [])
    out = []
    for a in alts:
        if w is None:
            out.append(a)
        else:
            t = a.split(" ")
            out += [" ".join(t[:i] + [w] + t[i:]) for i in range(len(t))]
    return out


def bp3d_match(base, side):
    for c in bp3d_part_names(base, side):
        if c in PART_BY_NAME:
            return PART_BY_NAME[c]
    return None


BP_OBJ = {}
for d in ("isa_BP3D_4.0_obj_99", "partof_BP3D_4.0_obj_99"):
    for p in glob.glob(f"{ROOT}/data/raw/bodyparts3d/{d}/*.obj"):
        BP_OBJ.setdefault(os.path.basename(p)[:-4], p)


def load_bp3d(fj):
    v, f = [], []
    for line in open(BP_OBJ[fj], errors="replace"):
        if line.startswith("v "):
            v.append(line.split()[1:4])
        elif line.startswith("f "):
            f.append([t.split("/")[0] for t in line.split()[1:4]])
    return ax(np.array(v, float) * 1e-3), np.array(f, int) - 1


# ----------------------------------------------------------------------------- geometry helpers
def sample(v, f, n=1500):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    if area.sum() <= 0:
        return v[rng.integers(0, len(v), n)]
    t = rng.choice(len(f), n, p=area / area.sum())
    r1, r2 = np.sqrt(rng.random(n))[:, None], rng.random(n)[:, None]
    return (1 - r1) * a[t] + r1 * (1 - r2) * b[t] + r1 * r2 * c[t]


def surf(Ap, Bp):
    d = np.concatenate([cKDTree(Bp).query(Ap)[0], cKDTree(Ap).query(Bp)[0]])
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
        d, j = tree.query(X @ R.T + t)
        keep = d <= np.percentile(d, 90)
        R, t = rigid(X[keep], Y[j[keep]])
    return R, t


def components(nv, faces):
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]]])
    nc, lab = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(nv, nv)), directed=False)
    return nc, lab


def tube_branches(v, f, e):
    """Split a bevelled-curve tube mesh into branches and recover each branch's centreline.

    Blender writes a bevelled curve ring by ring: R consecutive vertices form one ring, rings of one
    spline are consecutive.  R = the most common vertex-index difference of an edge other than 1.
    Returns [{'vidx', 'points' (ring centres), 'radius' (mean ring radius)}], or points=None when a
    component does not have that structure.
    """
    nc, lab = components(len(v), f)
    d = np.abs(e[:, 0] - e[:, 1])
    cnt = Counter(d[d > 1].tolist())
    R = cnt.most_common(1)[0][0] if cnt else 0
    out = []
    for c in range(nc):
        idx = np.nonzero(lab == c)[0]
        br = {"vidx": idx, "points": None, "radius": None}
        if R >= 3 and len(idx) % R == 0 and len(idx) >= 2 * R and idx[-1] - idx[0] + 1 == len(idx):
            rings = v[idx].reshape(-1, R, 3)
            cen = rings.mean(1)
            rad = np.linalg.norm(rings - cen[:, None, :], axis=2)
            if (rad.std(1) / np.maximum(rad.mean(1), 1e-9)).max() < 0.35:
                br["points"], br["radius"] = cen, rad.mean(1)
        out.append(br)
    # Blender's "fill caps" writes each end cap as its own R-vertex component: not a branch.
    # Attach every cap to the tube whose end ring is nearest so it stays in that branch's mesh.
    tubes = [b for b in out if b["points"] is not None]
    caps = [b for b in out if b["points"] is None and len(b["vidx"]) <= R]
    if tubes and caps:
        ends = np.array([p for b in tubes for p in (b["points"][0], b["points"][-1])])
        for c in caps:
            j = int(np.linalg.norm(ends - v[c["vidx"]].mean(0), axis=1).argmin()) // 2
            tubes[j]["vidx"] = np.concatenate([tubes[j]["vidx"], c["vidx"]])
        cap_ids = {id(c) for c in caps}
        out = [b for b in out if id(b) not in cap_ids]
    return out, R


def submesh(v, f, vidx):
    mask = np.zeros(len(v), bool)
    mask[vidx] = True
    remap = -np.ones(len(v), np.int64)
    remap[vidx] = np.arange(len(vidx))
    ff = f[mask[f].all(1)]
    return v[vidx], remap[ff]


class Bin:
    def __init__(self, name):
        self.name, self.fh, self.off = name, open(f"{OUT}/{name}", "wb"), 0

    def add(self, v, f):
        v = np.ascontiguousarray(ax(v), dtype="<f4")
        f = np.ascontiguousarray(f, dtype="<u4")
        ref = {"file": self.name, "vOffset": self.off, "vCount": len(v), "iOffset": self.off + v.nbytes, "iCount": int(f.size)}
        self.fh.write(v.tobytes())
        self.fh.write(f.tobytes())
        self.off += v.nbytes + f.nbytes
        return ref, v

    def close(self):
        self.fh.close()


def bbox6(v):
    return [round(float(x), 5) for x in list(v.min(0)) + list(v.max(0))]


# ----------------------------------------------------------------------------- load sources
ZA_IDX = json.load(open(f"{Z}/out/export/index.json"))
ZA_NPZ = np.load(f"{Z}/out/export/meshes.npz")
ZA = {r["name"]: r for r in ZA_IDX}


def za_mesh(r):
    return ZA_NPZ[f"v{r['i']}"].astype(np.float64), ZA_NPZ[f"f{r['i']}"].astype(np.int64)


def split_side(name):
    m = re.match(r"(.*)\.([lr])$", name)
    return (m.group(1), m.group(2).upper()) if m else (name, None)


def side_of(base_side, v):
    if base_side:
        return base_side
    return "M"


# ----------------------------------------------------------------------------- exclusions (NC inputs)
EXCL_INNER_EAR = {"Cochlea", "Vestibule", "Cochlear nerve", "Vestibular nerve"}
EXCL_KIDNEY = {"Renal pelvis", "Intrarenal arteries of left kidney", "Intrarenal arteries of right kidney",
               "Intrarenal veins of left kidney", "Intrarenal veins of right kidney"}
excluded = []
for r in ZA_IDX:
    base, _ = split_side(r["name"])
    if base in EXCL_INNER_EAR:
        excluded.append({"object": r["name"], "type": r["type"], "reason": "inner ear: Z-Anatomy lists 'Anatomy of the Inner Ear' (Univ. of Dundee, CC BY-NC-SA 4.0) as included/adapted"})
    elif base in EXCL_KIDNEY:
        excluded.append({"object": r["name"], "type": r["type"], "reason": "kidney internals: Z-Anatomy lists 'Kidney' (Lissie Cowley, CC BY-NC 4.0) as included/adapted"})
EXCL = {e["object"] for e in excluded}
# Z-Anatomy objects that lost their .l/.r suffix: an unsuffixed object whose name has exactly one suffixed sibling
_sib = defaultdict(list)
for r in ZA_IDX:
    b_, s_ = split_side(r["name"])
    _sib[b_].append(r["name"])
UNSUFFIXED_TWIN = {b_: [n for n in ns if n != b_][0] for b_, ns in _sib.items() if b_ in ns and len(ns) == 2}

items, centre = [], {}
BIN_N, BIN_P, BIN_A = Bin("nerves.bin"), Bin("parts.bin"), Bin("anchors.bin")


def add_item(source, obj, unit, name, side, kind, system, tissue, v=None, f=None, branches=None, ta2name=None,
             fma_labels=None, fma_note=None, extra=None, binf=None, frame="za", generated=False):
    extra = dict(extra or {})
    if v is not None and source == "z-anatomy" and not unit:
        cx = float(np.asarray(v)[:, 0].mean())
        if side in ("L", "R") and abs(cx) > 0.03 and (cx > 0) != (side == "L"):
            # object suffix contradicts the geometry (e.g. 'Lateral temporomandibular ligament.l' lies on the right)
            side = "L" if cx > 0 else "R"
            extra["sideCorrected"] = "source suffix contradicted the geometry; side taken from the mesh position"
        elif side == "M" and obj in UNSUFFIXED_TWIN and abs(cx) > 0.01:
            side = "L" if cx > 0 else "R"
            extra["sideInferred"] = f"object has no .l/.r suffix but is the mirror twin of '{UNSUFFIXED_TWIN[obj]}'"
    t2 = ta2_of(ta2name or name)
    rec = {"id": zid(source, obj, unit), "source": source, "sourceObject": obj, "frame": frame, "name": name, "side": side,
           "ta2": t2["ta2"] if t2 else None, "en": t2["en"] if t2 else None, "la": t2["la"] if t2 else None}
    rec.update(resolve_fma(name, side, t2["ta2"] if t2 else None, labels=fma_labels, note=fma_note, generated=generated))
    rec.update(system=system, tissue=tissue, kind=kind, license="CC-BY-SA-4.0", provenance="curated")
    if v is not None:
        ref, vo = (binf or (BIN_N if kind == "nerve" else BIN_P)).add(v, f)
        rec.update(files={"mesh": ref}, triangles=int(len(f)), bbox=bbox6(vo))
    else:
        rec.update(files=None, triangles=None, bbox=None)
    if branches is not None:
        cl = []
        for b in branches:
            if b.get("points") is not None:
                cl.append({"points": np.round(ax(b["points"]), 5).tolist(), "radius": np.round(b["radius"], 5).tolist(),
                           "derivation": b.get("derivation", "tube-ring-centres")})
        centre[rec["id"]] = cl
        rec["files"]["centreline"] = {"file": "centrelines.json", "key": rec["id"], "branches": len(cl)}
        rec["branches"] = len(branches)
        if len(cl) < len(branches):
            rec["centrelineIncomplete"] = True
    if extra:
        rec.update(extra)
    items.append(rec)
    return rec


def mirror_x(v, f):
    v2 = v.copy()
    v2[:, 0] *= -1
    return v2, f[:, ::-1].copy()


# ----------------------------------------------------------------------------- Z-Anatomy nerves
LEVELS = [f"C{i}" for i in range(1, 9)] + [f"T{i}" for i in range(1, 13)] + [f"L{i}" for i in range(1, 6)] + [f"S{i}" for i in range(1, 6)] + ["Co"]


def lvl_words(lv):
    return ORD[int(lv[1:])], REG[lv[0]]


def za_branches(r):
    v, f = za_mesh(r)
    e = ZA_NPZ[f"e{r['i']}"]
    br, R = tube_branches(v, f, e)
    for b in br:
        if b["points"] is None:  # fall back: nearest original Bezier spline's control points
            c = v[b["vidx"]].mean(0)
            best = min(r["splines"], key=lambda s: np.linalg.norm(np.array(s["points"]).mean(0) - c) if s["points"] else 9)
            if len(best["points"]) >= 2:
                b["points"] = np.array(best["points"])
                b["radius"] = np.array(best["radius"]) * r["bevel_depth"]
                b["derivation"] = "bezier-control-points"
    return v, f, br


VERT_Z = {}  # vertebra bbox-centre heights (Blender z), cranio-caudal
for r in ZA_IDX:
    m = re.match(r"Vertebra ([CTL])(\d+)$", r["name"])
    if m:
        VERT_Z[m.group(1) + m.group(2)] = (r["bbox_min"][2] + r["bbox_max"][2]) / 2
VERT_Z["C1"] = (ZA["Atlas (C1)"]["bbox_min"][2] + ZA["Atlas (C1)"]["bbox_max"][2]) / 2
VERT_Z["C2"] = (ZA["Axis (C2)"]["bbox_min"][2] + ZA["Axis (C2)"]["bbox_max"][2]) / 2
VERT_Z["S1"] = ZA["Sacrum"]["bbox_max"][2] - 0.02
DISC_Z = {}
for r in ZA_IDX:
    m = re.match(r"Intervertebral disc (\w+)-(\w+)$", r["name"])
    if m:
        DISC_Z[m.group(1)] = (r["bbox_min"][2] + r["bbox_max"][2]) / 2  # keyed by the upper vertebra


def interval_level(z):
    """Vertebra-interval rule: an exit between the centres of vertebra k (above) and k+1 (below)
    belongs to nerve k, except in the neck (C1-C7 exit above their vertebra, C8 below C7)."""
    order = [l for l in LEVELS if l in VERT_Z]
    for a, b in zip(order, order[1:]):
        if VERT_Z[a] >= z > VERT_Z[b]:
            if a[0] == "C":
                return "C" + str(int(a[1:]) + 1)
            return a
    return None


RIBS = {}
for n in range(1, 13):
    for s in "lr":
        nm = f"{ORD[n].capitalize()} rib.{s}"
        if nm in ZA:
            RIBS[(n, s)] = cKDTree(za_mesh(ZA[nm])[0])

T1_NOTE = ("C5-C8 roots map to 'Anterior ramus of <n> cervical nerve'. FMA has no class of its own for the anterior ramus of T1: "
           "'Anterior ramus of first thoracic nerve' is a synonym of FMA7645 'First intercostal nerve'. The T1 plexus root is therefore "
           "mapped to the whole spinal nerve, FMA6037 'First thoracic nerve' (deliberate, broader than the C5-C8 mapping)")
SPLIT_REPORT = {"rule": None, "units": [], "ambiguous": []}
EXITS = {}


def lateral_end(P):
    return P[np.argmax(np.abs(P[:, 0]))]


def proximal_end(P):
    return P[np.argmin(np.abs(P[:, 0]))]


def assign_levels(s):
    """Levels of the spinal-nerve exits on one side ('l'/'r').  Returns {exit index: (level, confidence, evidence)}."""
    v, f, ant = za_branches(ZA[f"Anterior root of spinal nerve.{s}"])
    ex = np.array([lateral_end(b["points"]) for b in ant])
    order = np.argsort(-ex[:, 2])
    exs = ex[order]
    n = len(exs)
    # evidence A: brachial plexus topology.  Root branches that end at a common point: the upper pair
    # (-> superior trunk) is C5+C6, the single one (-> middle trunk) C7, the lower pair C8+T1.
    _, _, bp = za_branches(ZA[f"Roots of brachial plexus.{s}"])
    cand = []
    for b in bp:
        P = b["points"]
        d0, d1 = np.linalg.norm(exs - P[0], axis=1), np.linalg.norm(exs - P[-1], axis=1)
        if min(d0.min(), d1.min()) < 0.003:
            j = int(d0.argmin()) if d0.min() < d1.min() else int(d1.argmin())
            dist = P[-1] if d0.min() < d1.min() else P[0]
            cand.append((j, dist, b))
    cand.sort(key=lambda c: c[0])
    groups = []
    for j, dist, b in cand:
        if groups and np.linalg.norm(groups[-1][0][1] - dist) < 0.004:
            groups[-1].append((j, dist, b))
        else:
            groups.append([(j, dist, b)])
    pat = [len(g) for g in groups]
    offA = None
    for k in range(len(pat) - 2):
        if pat[k:k + 3] == [2, 1, 2]:
            j5 = groups[k][0][0]
            if [c[0] for g in groups[k:k + 3] for c in g] == list(range(j5, j5 + 5)):
                offA = LEVELS.index("C5") - j5
    # evidence B: intercostal nerve <-> rib adjacency
    _, _, ic = za_branches(ZA[f"Intercostal nerves.{s}"])
    ribB = {}
    for b in ic:
        P = b["points"]
        lat = P[np.abs(P[:, 0]) > 0.04]
        if len(lat) < 5:
            continue
        dist = {n_: float(np.median(t.query(lat)[0])) for (n_, s_), t in RIBS.items() if s_ == s}
        best = sorted(dist, key=dist.get)[:2]
        prox = P[0] if np.linalg.norm(exs - P[0], axis=1).min() < np.linalg.norm(exs - P[-1], axis=1).min() else P[-1]
        de = np.linalg.norm(exs - prox, axis=1)
        b["_exit"] = int(de.argmin()) if de.min() < 0.003 else None
        # is the nerve below (caudal to) its nearest rib?
        dd, ii = RIBS[(best[0], s)].query(lat)
        below = float(np.mean(lat[:, 2] < RIBS[(best[0], s)].data[ii][:, 2]))
        b["_rib"] = (best[0], dist[best[0]] * 1e3, dist[best[1]] * 1e3, below)
        if b["_exit"] is not None:
            ribB[b["_exit"]] = best[0]
    offB = Counter(LEVELS.index(f"T{nr}") - j for j, nr in ribB.items())
    # evidence C: vertebra-interval rule
    agreeC = 0
    res = {}
    off = offA if offA is not None else (offB.most_common(1)[0][0] if offB else None)
    for j in range(n):
        lv = LEVELS[j + off] if off is not None and 0 <= j + off < len(LEVELS) else None
        c = interval_level(exs[j, 2])
        agreeC += int(c == lv)
        ev = []
        if offA is not None:
            ev.append("brachial-plexus-topology")
        if j in ribB:
            ev.append("rib-adjacency" if lv == f"T{ribB[j]}" else f"rib-adjacency-says-T{ribB[j]}")
        ev.append("vertebra-interval" if c == lv else f"vertebra-interval-says-{c}")
        conf = "high" if (offA is not None and offB and offB.most_common(1)[0][0] == offA and (j not in ribB or lv == f"T{ribB[j]}")) else "medium"
        if lv is None or (offA is None and not offB):
            conf = "ambiguous"
        res[j] = (lv, conf, ev)
    EXITS[s] = (exs, res)
    log(f"  side {s}: {n} exits; brachial groups {pat} -> offset {offA}; rib evidence offsets {dict(offB)} "
        f"({len(ribB)} intercostals tied to exits); vertebra-interval rule agrees on {agreeC}/{n}")
    for b in ic:
        if "_rib" in b:
            log(f"    intercostal branch: nearest rib {b['_rib'][0]} (median {b['_rib'][1]:.1f} mm, next {b['_rib'][2]:.1f} mm, "
                f"{b['_rib'][3]:.0%} of points caudal to it) exit#{b['_exit']} -> {res[b['_exit']][0] if b['_exit'] is not None else None}")
    return ant, bp, ic, groups


def exit_level(s, p, tol=0.004):
    exs, res = EXITS[s]
    d = np.linalg.norm(exs - p, axis=1)
    if d.min() < tol:
        return res[int(d.argmin())]
    dz = np.sort(np.abs(exs[:, 2] - p[2]))
    if dz[0] < 0.006 and dz[1] > 2 * dz[0]:  # no 3D coincidence, but one exit is clearly nearest in height
        lv, conf, ev = res[int(np.abs(exs[:, 2] - p[2]).argmin())]
        return lv, "medium", ev + [f"matched to exit by height only (dz {dz[0]*1e3:.1f} mm, next {dz[1]*1e3:.1f} mm)"]
    return None, "ambiguous", ["no coincident root exit"]


log("spinal level assignment (Z-Anatomy):")
NERVE_SKIP = {"Central canal'", "Ciliary body-curve"}
SPLIT_OBJECTS = {"Anterior root of spinal nerve", "Posterior root of spinal nerve", "Intercostal nerves", "Roots of brachial plexus",
                 "Cauda equina", "Spinal ganglion"}


def unit_item(obj, unit, name, side, v, f, brs, labels, level, conf, ev, parent, extra=None):
    vidx = np.concatenate([b["vidx"] for b in brs])
    sv, sf = submesh(v, f, np.sort(vidx))
    x = {"splitFrom": obj, "level": level, "levelConfidence": conf, "levelEvidence": ev}
    if conf == "ambiguous":
        x["levelAmbiguous"] = True
    if extra:
        x.update(extra)
    rec = add_item("z-anatomy", obj, unit, name, side, "nerve", "nervous", "nerve", sv, sf,
                   branches=brs if brs[0].get("points") is not None else None, ta2name=parent, fma_labels=labels, extra=x,
                   generated=True,
                   fma_note="FMA id looked up by the canonical FMA label generated from the assigned level" if labels else None)
    SPLIT_REPORT["units"].append((obj, unit, level, conf))
    if conf == "ambiguous":
        SPLIT_REPORT["ambiguous"].append(f"{obj} / {unit}")
    return rec


for s in "lr":
    S = s.upper()
    ant, bp, ic, groups = assign_levels(s)
    # anterior + posterior roots
    for kind in ("Anterior", "Posterior"):
        obj = f"{kind} root of spinal nerve.{s}"
        v, f, brs = za_branches(ZA[obj])
        for k, b in enumerate(brs):
            lv, conf, ev = exit_level(s, lateral_end(b["points"]))
            if lv:
                o, rg = lvl_words(lv)
                unit_item(obj, lv, f"{kind} root of {lv} spinal nerve", S, v, f, [b], [f"{kind} root of {o} {rg} nerve"], lv, conf, ev,
                          f"{kind} root of spinal nerve")
            else:
                unit_item(obj, f"branch{k}", f"{kind} root of spinal nerve (level undetermined)", S, v, f, [b], [], None, "ambiguous", ev,
                          f"{kind} root of spinal nerve")
    # spinal ganglia (mesh components)
    obj = f"Spinal ganglion.{s}"
    v, f = za_mesh(ZA[obj])
    nc, lab = components(len(v), f)
    for c in range(nc):
        vidx = np.nonzero(lab == c)[0]
        lv, conf, ev = exit_level(s, v[vidx].mean(0), tol=0.008)
        b = {"vidx": vidx, "points": None}
        if lv:
            o, rg = lvl_words(lv)
            unit_item(obj, lv, f"{lv} spinal ganglion", S, v, f, [b], [f"{o} {rg} spinal ganglion"], lv, conf, ev, "Spinal ganglion")
        else:
            unit_item(obj, f"component{c}", "Spinal ganglion (level undetermined)", S, v, f, [b], [], None, "ambiguous", ev, "Spinal ganglion")
    # intercostal nerves
    obj = f"Intercostal nerves.{s}"
    v, f, _ = za_branches(ZA[obj])
    for k, b in enumerate(ic):
        if b.get("_exit") is not None:
            lv, conf, ev = EXITS[s][1][b["_exit"]]
        else:
            lv, conf, ev = None, "ambiguous", ["no coincident root exit"]
        if "_rib" in b and lv and lv != f"T{b['_rib'][0]}":
            conf = "medium" if conf == "high" else conf
        if lv and lv[0] == "T" and int(lv[1:]) <= 11:
            n = int(lv[1:])
            unit_item(obj, lv, f"{ORD[n].capitalize()} intercostal nerve", S, v, f, [b], [f"{ORD[n]} intercostal nerve"], lv, conf, ev, "Intercostal nerves")
        else:
            unit_item(obj, f"branch{k}", "Intercostal nerve (level undetermined)", S, v, f, [b], [], lv, "ambiguous", ev, "Intercostal nerves")
    # roots of brachial plexus
    obj = f"Roots of brachial plexus.{s}"
    v, f, _ = za_branches(ZA[obj])
    used = set()
    for g in groups:
        for j, dist, b in g:
            lv, conf, ev = EXITS[s][1][j]
            used.add(id(b))
            if lv in ("C5", "C6", "C7", "C8", "T1"):
                o, rg = lvl_words(lv)
                unit_item(obj, lv, f"{lv} root of brachial plexus", S, v, f, [b],
                          [f"{o} {rg} nerve"] if lv == "T1" else [f"Anterior ramus of {o} {rg} nerve", f"{o} {rg} nerve"],
                          lv, conf, ev, "Roots of brachial plexus",
                          extra={"fmaNoteRoot": T1_NOTE if lv == "T1" else "plexus root = anterior ramus of the spinal nerve"})
            else:
                unit_item(obj, f"{lv}-contribution", f"{lv} contribution to brachial plexus roots", S, v, f, [b], [], lv, "medium",
                          ev + ["starts at a root exit but does not join a trunk"], "Roots of brachial plexus")
    rest = [b for b in bp if id(b) not in used and len(b["vidx"]) > 0]
    if rest:
        unit_item(obj, "unassigned", "Roots of brachial plexus (unassigned branches)", S, v, f, rest, [], None, "ambiguous",
                  ["branches not starting at a spinal root exit"], "Roots of brachial plexus")

# cauda equina (midline object with a Mirror modifier; the tube has both sides)
obj = "Cauda equina"
v, f, brs = za_branches(ZA[obj])
brs = [b for b in brs if b["points"] is not None and len(b["points"]) >= 2]
central = [b for b in brs if np.abs(b["points"][:, 0]).max() < 0.006]
cen_ids = {id(b) for b in central}
for s, sgn in (("l", 1), ("r", -1)):
    side_b = [b for b in brs if id(b) not in cen_ids and np.sign(lateral_end(b["points"])[0]) == sgn]
    roots = [b for b in side_b if np.abs(proximal_end(b["points"])[0]) < 0.006]
    roots.sort(key=lambda b: -lateral_end(b["points"])[2])
    root_ids = {id(b) for b in roots}
    exs, res = EXITS[s]
    last_lv = res[len(exs) - 1][0]
    gap = exs[-1, 2] - lateral_end(roots[0]["points"])[2] if roots else 0
    ok = last_lv is not None and 0.6 * 0.034 < gap < 1.4 * 0.034
    log(f"  cauda equina side {s}: {len(roots)} root branches, {len(side_b) - len(roots)} continuation branches; "
        f"gap to last root exit ({last_lv}) {gap*1e3:.0f} mm -> {'contiguous' if ok else 'NOT contiguous'}")
    start = LEVELS.index(last_lv) + 1 if last_lv else None
    for k, b in enumerate(roots):
        chain = [b]
        for c in side_b:
            if id(c) not in root_ids and min(np.linalg.norm(c["points"][0] - lateral_end(b["points"])), np.linalg.norm(c["points"][-1] - lateral_end(b["points"]))) < 0.003:
                chain.append(c)
        lv = LEVELS[start + k] if ok and start + k < len(LEVELS) else None
        ev = ["sequence continues the spinal-root exits caudally", f"vertebra-interval-says-{interval_level(lateral_end(b['points'])[2])}"]
        if lv:
            o, rg = lvl_words(lv)
            unit_item(obj, f"{lv}.{s}", f"{lv} root in cauda equina", s.upper(), v, f, chain, [f"Root of {o} {rg} nerve"], lv, "medium", ev, "Cauda equina")
        else:
            unit_item(obj, f"branch{k}.{s}", "Cauda equina root (level undetermined)", s.upper(), v, f, chain, [], None, "ambiguous", ev, "Cauda equina")
if central:
    unit_item(obj, "central", "Cauda equina (central bundle)", "M", v, f, central, ["Cauda equina"], None, "n/a", ["midline branch"], "Cauda equina")

SPLIT_REPORT["rule"] = (
    "Spinal-root exits (lateral end points of the 21 'Anterior root of spinal nerve' branches per side) are sorted "
    "cranio-caudally and labelled as one contiguous run of levels. The run is anchored by (A) brachial plexus topology: the "
    "root branches that start at five consecutive exits and merge 2-1-2 into the superior/middle/inferior trunks are C5-T1; "
    "(B) rib adjacency: each intercostal branch is tied to the exit it starts at and to the rib it runs closest to "
    "(nerve n along rib n); (C) the vertebra-interval rule is reported as a cross-check only. 'high' = A and B give the same "
    "offset and the unit's own rib evidence agrees; 'medium' = sequence-based only (cauda equina roots L3-S4, which continue "
    "the run below the last root exit); 'ambiguous' = no coincident exit / no anchor. Posterior roots, spinal ganglia and "
    "intercostal nerves inherit the level of the exit their end point coincides with (< 4 mm; ganglia < 8 mm).")

# every other Z-Anatomy nerve curve + sympathetic ganglia
for r in ZA_IDX:
    base, sd = split_side(r["name"])
    if not r["system"].startswith("7") or r["name"] in EXCL or base in SPLIT_OBJECTS or base in NERVE_SKIP:
        continue
    if r["type"] == "CURVE":
        v, f, brs = za_branches(r)
        if not len(f):
            continue
        add_item("z-anatomy", r["name"], "", base, sd or "M", "nerve", "nervous", "nerve", v, f, branches=brs,
                 extra={"parentGroup": (r["parent"] or "").replace(".g", "") or None})
    elif base == "Ganglia of sympathetic trunk":
        v, f = za_mesh(r)
        add_item("z-anatomy", r["name"], "", base, sd or "M", "nerve", "nervous", "nerve", v, f,
                 extra={"note": "18 ganglia in one mesh; not split (no reliable level rule)"})
log(f"Z-Anatomy nerve items: {len(items)}")

# ----------------------------------------------------------------------------- Open3DModel nerves
O3D = {}
for m in ("upper-limb", "lower-limb"):
    O3D[m] = (json.load(open(f"{Z}/out/open3d/{m}/index.json")), np.load(f"{Z}/out/open3d/{m}/meshes.npz"))


def o3d_clean(n):
    n = n.strip().rstrip(".").strip()
    return re.sub(r"\.r$", "", n).strip()


O3D_TABLE = {}
for line in open(f"{TOOLS}/o3d_nerves.tsv", encoding="utf-8"):
    if line.startswith("#") or not line.strip():
        continue
    c = line.rstrip("\n").split("\t")
    c += [""] * (6 - len(c))
    O3D_TABLE[(c[0], c[1])] = {"english": c[2], "labels": [] if c[3] == "-" else c[3].split(";"),
                               "za": [] if c[4] == "-" else c[4].split(";"), "note": c[5]}

za_by_name_side = defaultdict(list)
for it in items:
    za_by_name_side[(it["name"], it["side"])].append(it)
    if it.get("splitFrom"):
        za_by_name_side[(split_side(it["splitFrom"])[0] + "#" + str(it.get("level")), it["side"])].append(it)

o3d_unmapped, o3d_n = [], 0
for m, key in (("upper-limb", "upper"), ("lower-limb", "lower")):
    idx, npz = O3D[m]
    for r in idx:
        if "nerve" not in (r["group"] or "").lower() or not r["nf"]:
            continue
        cn = o3d_clean(r["name"])
        row = O3D_TABLE.get((key, cn))
        if row is None:
            o3d_unmapped.append(f"{m}: {r['name']}")
            continue
        v, f, e = npz[f"v{r['i']}"].astype(np.float64), npz[f"f{r['i']}"].astype(np.int64), npz[f"e{r['i']}"]
        brs, R = tube_branches(v, f, e)
        orig_side = "R" if v[:, 0].mean() < 0 else "L"
        for side in ("R", "L"):
            vv, ff, bb = v, f, brs
            x = {"o3dModel": m, "o3dGroup": r["group"], "preferred": True}
            if row["english"].startswith("Sympathetic trunk ("):
                x["preferred"] = False
                x["alternateOf"] = [it["id"] for it in za_by_name_side.get(("Sympathetic trunk", side), [])]
            if side != orig_side:
                vv, ff = mirror_x(v, f)
                bb = [dict(b, points=None if b["points"] is None else b["points"] * [-1, 1, 1]) for b in brs]
                x["mirroredFrom"] = zid("open3dmodel", f"{m}/{r['name']}", orig_side)
            if row["za"] and any(z.startswith("Roots of brachial plexus") for z in row["za"]):
                pass
            rec = add_item("open3dmodel", f"{m}/{r['name']}", side, row["english"], side, "nerve", "nervous", "nerve", vv, ff,
                           branches=bb, fma_labels=row["labels"], fma_note=row["note"] or None, extra=x, frame="o3d")
            repl = []
            zc = list(row["za"])
            mm = re.match(r"([CTLS]\d) root of brachial plexus", row["english"])
            if mm:
                zc.append("Roots of brachial plexus#" + mm.group(1))
            for zn in zc:
                for it in za_by_name_side.get((zn, side), []):
                    it["preferred"] = False
                    it.setdefault("supersededBy", []).append(rec["id"])
                    repl.append(it["id"])
            if repl:
                rec["replaces"] = repl
            o3d_n += 1
for it in items:
    it.setdefault("preferred", True)
log(f"Open3DModel nerve items: {o3d_n} (unmapped O3D nerve-group objects, not imported: {o3d_unmapped})")

# ----------------------------------------------------------------------------- Z-Anatomy mesh parts
FALLBACK = re.compile(r"^(Superior|Middle|Inferior) lobe of (left|right) lung$|^Pleura$|^Liver$|segment of liver|"
                      r"^(Rectus abdominis|External abdominal oblique|Internal abdominal oblique|Transversus abdominis|Latissimus dorsi) muscle$")
ENDO = {"Thyroid gland", "Superior parathyroid gland", "Inferior parathyroid gland"}


def in_ours(rec, base, side):
    if rec.get("fma") and (rec["fma"] in OUR_FMA or rec.get("fmaUnsided") in OUR_FMA):
        return True
    return bool(bp3d_match(base, side)) or norm(base) in OUR_NAMES


def classify(base, system):
    b = base.lower()
    s = system[0]
    if s == "1":
        if re.search(r"incisor|canine|molar|premolar", b):
            return "skeletal", "tooth"
        return "skeletal", "cartilage" if "cartilage" in b else "bone"
    if s == "2":
        return "muscular", "other"
    if s == "3":
        if "bursa" in b:
            return "skeletal", "other"
        if re.search(r"disc|menisc|labrum|cartilage|symphysis|nucleus pulposus|anulus", b):
            return "skeletal", "cartilage"
        return "skeletal", "ligament"
    if s == "4":
        if re.search(r"fascia|retinaculum|aponeurosis|septum|tract|sheath|band|linea|arch|raphe", b):
            return "muscular", "fascia"
        if "tendon" in b:
            return "muscular", "tendon"
        return "muscular", "muscle"
    if s == "5":
        if re.search(r"ventricle|atrium|valve|leaflet|cusp|papillary|septum|auricle|heart|trabecul|chordae", b):
            return "cardiovascular", "heart"
        return "cardiovascular", "vein" if re.search(r"\bveins?\b|venous|sinus|vena", b) else "artery"
    if s == "6":
        return "lymphatic", "organ"
    if s == "7":
        if re.search(r"eye|cornea|lens|iris|retina|sclera|vitreous|lacrimal|tympanic|auditory|zonular|pupil|chamber", b):
            return "nervous", "organ"
        return "nervous", "brain"
    if s == "8":
        if re.search(r"bronch|lung|trachea|pleura|laryn|epiglott|nasal|nasophar", b):
            return "respiratory", "organ"
        if re.search(r"kidney|ureter|urinary|urethra|renal pelvis", b):
            return "urinary", "organ"
        if re.search(r"penis|testis|epididymis|deferens|prostate|seminal|ejaculatory", b):
            return "reproductive", "gland" if re.search(r"prostate|seminal|testis", b) else "organ"
        if re.search(r"thyroid|hypophysis|pineal|suprarenal", b):
            return "endocrine", "gland"
        return "digestive", "gland" if re.search(r"parotid gland|submandibular gland|sublingual gland|pancreas$", b) else "organ"
    return "integumentary", "skin" if not re.search(r"hair|nail|eyelash|perionyx", b) else "other"


n_parts = n_cand = n_b2 = 0
B2_NOTES = {
    "White matter of spinal cord": {"proxyFor": {"name": "Spinal cord", "fma": "FMA7647"},
        "note": "Outer surface of the spinal cord (Z-Anatomy has no object named 'Spinal cord'). Procedural: one cross-section arrayed along a curve "
                "(Mirror+Array+Curve), foramen magnum to the conus at L2/L3; mild cervical and lumbar enlargements (x-width 12.2-14.7 mm), conus "
                "tapers to 3.5 mm; ends are open. The anterior/posterior root units of batch 1 start 3 mm from the midline on this surface. "
                "Use as the spinal cord proper via proxyFor; `fma` is the white-matter class."},
    "Anterior horn of spinal cord": {"note": "grey matter column, same procedural construction as the cord surface; both sides in one object"},
    "Posterior horn of spinal cord": {"note": "grey matter column, same procedural construction as the cord surface; both sides in one object"},
    "Spinal dura": {"note": "dural sac with root sleeves, foramen magnum to L2/L3 only (same length as the cord, does not reach S2); 36 components, open and non-manifold edges: needs cleanup"},
    "Falx cerebri": {"note": "thin sheet (solidified, about 0.1 mm), 5 components"},
    "Greater omentum": {"note": "closed thin shell about 0.7 mm; apron in front of the intestines, must be fitted to our stomach / transverse colon"},
    "Lesser omentum": {"note": "closed thin shell about 0.7 mm between liver and stomach"},
    "Mesocolon": {"note": "closed thin shell about 0.7 mm; by position this is the transverse mesocolon region"},
    "Sigmoid colon": {"note": "closed tube wall (solidified, about 2 mm)"},
    "Parotid gland": {"note": "closed, 5.6 cm3 (small for a parotid, real glands are 15-25 cm3)"},
}
nerve_objs = {it["sourceObject"] for it in items} | {it.get("splitFrom") for it in items}
cat_count = Counter()
for r in ZA_IDX:
    base, sd = split_side(r["name"])
    side = sd or "M"
    if r["name"] in EXCL or r["name"] in nerve_objs or base in NERVE_SKIP or not r.get("nf"):
        continue
    system, tissue = classify(base, r["system"])
    s0 = r["system"][0]
    bl = base.lower()
    cat = None
    extra = {"zaCollection": r["system"]}
    if FALLBACK.search(base):
        cat = "fallback"
        extra["alsoInBp3d30"] = True
    elif base in ENDO:
        cat = "endocrine"
    elif s0 == "6":
        cat = "lymph"
    elif s0 in "34" and re.search(r"ligament|bursa|fascia|retinaculum|aponeurosis", bl) and tissue != "muscle":
        cat = "ligament-bursa-fascia"
        if "bursa" in bl:
            extra["structure"] = "bursa"
        elif re.search(r"fascia|retinaculum|aponeurosis", bl):
            system, tissue = "muscular", "fascia"
    if cat in ("lymph",):
        probe = resolve_fma(base, side, (ta2_of(base) or {}).get("ta2"))
        if in_ours(probe, base, sd):
            FMA_STATS["lymphoid object already in BP3D 4.0, skipped (" + base + ")"] += 1
            continue
    if cat:
        v, f = za_mesh(r)
        rec = add_item("z-anatomy", r["name"], "", base, side, "mesh", system, tissue, v, f, extra=extra)
        if cat == "ligament-bursa-fascia" and in_ours(rec, base, sd):
            rec["inBp3d40"] = True
        rec["category"] = cat
        cat_count[cat] += 1
        n_parts += 1
    else:
        # candidate: listed, geometry not exported
        rec0 = resolve_fma(base, side, (ta2_of(base) or {}).get("ta2"))
        if in_ours(rec0, base, sd):
            continue
        if s0 == "7" and r["type"] == "CURVE":
            continue
        grp = batch2_group(base, s0, tissue)
        if grp and in_current(rec0, base, sd):
            grp = None
            FMA_STATS["batch-2 structure already in the current model, left as candidate"] += 1
        if grp:
            v, f = za_mesh(r)
            bl2 = base.lower()
            if re.search(r"omentum|mesocolon|pleura|\bdura\b|falx|capsule|nail plate|perionyx", bl2) and tissue in ("organ", "brain"):
                tissue = "other"
            if "fat pad" in bl2:
                tissue = "fat"
            if re.search(r"\bdura\b|falx|white matter of spinal cord|horn of spinal cord", bl2):
                system = "nervous"
            x2 = dict(extra, batch=2, batchGroup=grp, zaType=r["type"], quality=mesh_quality(v, f))
            x2.update(B2_NOTES.get(base, {}))
            if grp.startswith("extra"):
                # "missing" was decided by FMA id / name only.  BodyParts3D names vessels and bronchi by segment and discs by
                # vertebra, so the same structure can already exist there under another concept.
                hi = s0 == "5" or re.search(r"bronch|intervertebral disc|nucleus pulposus|pharynx|mesocolon|taenia", bl2)
                x2["duplicateRisk"] = "high" if hi else "low"
            elif re.search(r"^mesocolon$", bl2):
                x2["duplicateRisk"] = "high"
            rec = add_item("z-anatomy", r["name"], "", base, side, "mesh", system, tissue, v, f, extra=x2)
            rec["category"] = "batch2"
            n_b2 += 1
            continue
        extra.update(candidate=True, zaType=r["type"], zaTriangles=r["nf"],
                     zaBbox=bbox6(ax(np.array([r["bbox_min"], r["bbox_max"]]))))
        extra["conceptCheck"] = "fma" if rec0.get("fma") else "name-only"
        if s0 == "7" and tissue == "brain":
            extra["licenceNote"] = ("CNS meshes may derive from the 'Brainder' / 'White matter' models (Univ. of Washington) that "
                                    "Z-Anatomy lists without a licence; verify before import")
        if base in ("Malleus", "Incus", "Stapes", "Tympanic membrane", "Auditory tube"):
            extra["licenceNote"] = "middle-ear structure; check it is not part of the CC BY-NC-SA 'Anatomy of the Inner Ear' model before import"
        rec = add_item("z-anatomy", r["name"], "", base, side, "mesh", system, tissue, extra=extra)
        rec["category"] = "candidate"
        n_cand += 1
log(f"Z-Anatomy mesh parts exported: {n_parts} {dict(cat_count)}; batch 2 exported: {n_b2}; candidates listed (no geometry): {n_cand}")

# ----------------------------------------------------------------------------- batch 2: pleura layers, Open3DModel joint structures
r = ZA["Pleura"]
v, f = za_mesh(r)
nc, lab = components(len(v), f)
shells = []
for c in range(nc):
    vidx = np.nonzero(lab == c)[0]
    sv, sf = submesh(v, f, vidx)
    a_, b_, c_ = sv[sf[:, 0]], sv[sf[:, 1]], sv[sf[:, 2]]
    shells.append({"vidx": vidx, "side": "L" if sv[:, 0].mean() > 0 else "R", "vol": abs(float(np.einsum("ij,ij->i", a_, np.cross(b_, c_)).sum() / 6))})
pleura_log = []
for sd in ("L", "R"):
    ss = sorted([s_ for s_ in shells if s_["side"] == sd], key=lambda s_: s_["vol"])
    pleura_log.append((sd, [round(s_["vol"] * 1e6) for s_ in ss]))
    if len(ss) == 4:  # two nested walls (inner, outer surface each): the inner pair is visceral, the outer pair parietal
        for layer, pair, labels in (("visceral", ss[:2], ["Visceral pleura"]), ("parietal", ss[2:], ["Parietal pleura"])):
            vidx = np.sort(np.concatenate([p_["vidx"] for p_ in pair]))
            sv, sf = submesh(v, f, vidx)
            gap = (pair[1]["vol"] - pair[0]["vol"])
            rec = add_item("z-anatomy", "Pleura", f"{layer}-{sd}", f"{layer.capitalize()} pleura", sd, "mesh", "respiratory", "other", sv, sf,
                           fma_labels=labels, ta2name=f"{layer.capitalize()} pleura",
                           extra={"batch": 2, "batchGroup": "requested: pleura", "splitFrom": "Pleura", "layer": layer, "zaCollection": r["system"],
                                  "quality": mesh_quality(sv, sf),
                                  "note": f"{layer} layer of the {'left' if sd == 'L' else 'right'} pleura: a closed double-walled shell (inner and outer surface, "
                                          "wall about 0.5 mm) cut out of the single Z-Anatomy 'Pleura' object by nesting order of its 8 closed surfaces. "
                                          "The four surfaces per lung are concentric offsets of ONE lung-shaped surface, 0.5 mm apart: visceral wall, a 0.5 mm "
                                          "cavity, parietal wall. So the parietal layer follows the lung, not the chest wall, diaphragm and mediastinum, and has "
                                          "no recesses. Shaped around Z-Anatomy's lungs; must be refitted to our lungs."})
            rec["category"] = "batch2"
            n_b2 += 1
log(f"pleura: {nc} closed surfaces; enclosed volumes per side (cm3) {pleura_log}")

O3D_EXTRA = [  # model, object, english, FMA labels, Z-Anatomy counterpart, system, tissue, group
    ("lower-limb", "Lateral meniscus.r", "Lateral meniscus", ["Lateral meniscus"], "Lateral meniscus", "skeletal", "cartilage", "requested: meniscus"),
    ("lower-limb", "Medial meniscus.r", "Medial meniscus", ["Medial meniscus"], "Medial meniscus", "skeletal", "cartilage", "requested: meniscus"),
    ("lower-limb", "Anterior horn of Lateral meniscus.r", "Anterior horn of lateral meniscus", ["Anterior horn of lateral meniscus"], None, "skeletal", "cartilage", "requested: meniscus"),
    ("lower-limb", "Posterior horn of Lateral meniscus.r", "Posterior horn of lateral meniscus", ["Posterior horn of lateral meniscus"], None, "skeletal", "cartilage", "requested: meniscus"),
    ("lower-limb", "Anterior horn of Medial meniscus.r", "Anterior horn of medial meniscus", ["Anterior horn of medial meniscus"], None, "skeletal", "cartilage", "requested: meniscus"),
    ("lower-limb", "Posterior horn of Medial meniscus.r", "Posterior horn of medial meniscus", ["Posterior horn of medial meniscus"], None, "skeletal", "cartilage", "requested: meniscus"),
    ("lower-limb", "Anterior cruciate ligament.r", "Anterior cruciate ligament", ["Anterior cruciate ligament"], "Anterior cruciate ligament", "skeletal", "ligament", "requested: cruciate ligament"),
    ("lower-limb", "Posterior cruciate ligament.r", "Posterior cruciate ligament", ["Posterior cruciate ligament"], "Posterior cruciate ligament", "skeletal", "ligament", "requested: cruciate ligament"),
    ("lower-limb", "Posterior meniscofemoral ligament.r", "Posterior meniscofemoral ligament", ["Posterior meniscofemoral ligament"], None, "skeletal", "ligament", "requested: meniscus"),
    ("lower-limb", "Articular capsule of knee joint.r", "Articular capsule of knee joint", ["Articular capsule of knee joint"], "Articular capsule of knee joint", "skeletal", "ligament", "requested: joint capsule"),
    ("lower-limb", "Hip joint capsule.r", "Articular capsule of hip joint", ["Articular capsule of hip joint"], "Articular capsule of hip joint", "skeletal", "ligament", "requested: joint capsule"),
    ("lower-limb", "Capsule of talocrural joint.r", "Articular capsule of ankle joint", ["Articular capsule of ankle joint", "Articular capsule of talocrural joint"], None, "skeletal", "ligament", "requested: joint capsule"),
    ("lower-limb", "Infrapatellar fat pad.r", "Infrapatellar fat pad", ["Infrapatellar fat pad"], "Infrapatellar fat pad", "skeletal", "fat", "requested: fat"),
    ("upper-limb", "Articular capsule of glenohumeral joint.r", "Articular capsule of glenohumeral joint", ["Articular capsule of glenohumeral joint"], "Articular capsule of glenohumeral joint", "skeletal", "ligament", "requested: joint capsule"),
    ("upper-limb", "Articular capsule of elbow joint.r", "Articular capsule of elbow joint", ["Articular capsule of elbow joint"], "Articular capsule of elbow joint", "skeletal", "ligament", "requested: joint capsule"),
    ("upper-limb", "Acromioclavicular capsule.r", "Articular capsule of acromioclavicular joint", ["Articular capsule of acromioclavicular joint"], "Articular capsule of acromioclavicular joint", "skeletal", "ligament", "requested: joint capsule"),
    ("upper-limb", "Sternoclavicular capsule.r", "Articular capsule of sternoclavicular joint", ["Articular capsule of sternoclavicular joint"], "Articular capsule of sternoclavicular joint", "skeletal", "ligament", "requested: joint capsule"),
    ("lower-limb", "Arachnoid mater", "Spinal arachnoid mater (lumbosacral part)", ["Spinal arachnoid mater", "Arachnoid mater of spinal cord"], None, "nervous", "other", "requested: meninges"),
]
za_items_by = defaultdict(list)
for it in items:
    if it["source"] == "z-anatomy":
        za_items_by[(it["name"], it["side"])].append(it)
n_o3x = 0
for m, on, english, labels, zac, system, tissue, grp in O3D_EXTRA:
    idx_, npz_ = O3D[m]
    rr = [q for q in idx_ if q["name"] == on]
    if not rr:
        log(f"  Open3DModel object not found: {m}/{on}")
        continue
    rr = rr[0]
    v, f = npz_[f"v{rr['i']}"].astype(np.float64), npz_[f"f{rr['i']}"].astype(np.int64)
    midline = english.startswith("Spinal arachnoid")
    for side in (("M",) if midline else ("R", "L")):
        vv, ff = (v, f) if side in ("R", "M") else mirror_x(v, f)
        x = {"batch": 2, "batchGroup": grp, "o3dModel": m, "o3dGroup": rr["group"], "quality": mesh_quality(vv, ff)}
        if side == "L":
            x["mirroredFrom"] = zid("open3dmodel", f"{m}/{on}", "R")
        alts = [it["id"] for it in za_items_by.get((zac, side), [])] if zac else []
        if alts:
            x["alternateOf"] = alts
            x["preferred"] = False
            x["note"] = "Open3DModel version (remodelled, anatomist-reviewed) of a structure also exported from Z-Anatomy; register with open3dmodel anchors"
        if midline:
            x["note"] = "partial: spinal arachnoid / dural sac below about T12 with root sleeves, from the lower-limb model; 47 components"
        rec = add_item("open3dmodel", f"{m}/{on}", side, english, side, "mesh", system, tissue, vv, ff, fma_labels=labels, extra=x, frame="o3d")
        rec["category"] = "batch2"
        n_o3x += 1
log(f"batch 2: {n_b2} Z-Anatomy items, {n_o3x} Open3DModel items")

# ----------------------------------------------------------------------------- anchors
anchors = []


def make_anchor(source, obj, base, sd, v, f, frame, skeletal):
    parts = bp3d_match(base, sd)
    if not parts or len(f) < 20:
        return None
    parts = [p for p in parts if p["id"] in BP_OBJ]
    if not parts:
        return None
    bv, bf, off = [], [], 0
    for p in parts:
        pv, pf = load_bp3d(p["id"])
        bv.append(pv)
        bf.append(pf + off)
        off += len(pv)
    bv, bf = np.concatenate(bv), np.concatenate(bf)
    zv = ax(v)
    zs, bs = sample(zv, f), sample(bv, bf)
    R, t = icp(zs, bs)
    mean, p95 = surf(zs @ R.T + t, bs)
    raw, _ = surf(zs, bs)
    ang = float(np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1, 1))))
    c = zs.mean(0)
    return {"zs": zs, "rec": {
        "id": zid(source, obj, "anchor"), "source": source, "sourceObject": obj, "frame": frame, "name": base,
        "side": sd or "M", "bp3dIds": [p["id"] for p in parts], "bp3dNames": [p["name"] for p in parts],
        "fma": parts[0]["fma"] if len(parts) == 1 else None, "fmaAll": [p["fma"] for p in parts],
        "system": parts[0]["system"], "tissue": parts[0]["tissue"], "anchorClass": "bone" if skeletal else "soft",
        "icp": {"R": np.round(R, 7).tolist(), "t": np.round(t, 6).tolist(),
                "convention": "p_bp3d = R @ p_source + t; both in metres, Y up, anterior +Z, left +X",
                "rotationDeg": round(ang, 3), "displacementMm": np.round((R @ c + t - c) * 1e3, 2).tolist()},
        "residualMeanMm": round(mean, 3), "residualP95Mm": round(p95, 3), "rawMeanMm": round(raw, 2),
        "license": "CC-BY-SA-4.0"}}


n_soft_tested = 0
for r in ZA_IDX:
    base, sd = split_side(r["name"])
    s0 = r["system"][0]
    if r["type"] != "MESH" or r["name"] in EXCL or s0 in "29" or re.search(r"\.[oe]\d*$", base):
        continue
    v, f = za_mesh(r)
    a = make_anchor("z-anatomy", r["name"], base, sd, v, f, "za", s0 == "1")
    if a is None:
        continue
    rec = a["rec"]
    if s0 != "1":
        n_soft_tested += 1
        if rec["residualMeanMm"] > 1.0 or len(f) < 200:
            continue  # only keep soft tissue that is demonstrably unchanged from BP3D
    rec["resculpted"] = rec["residualMeanMm"] > 2.5
    rec["quality"] = "good" if rec["residualMeanMm"] <= 1.5 else ("fair" if rec["residualMeanMm"] <= 2.5 else "poor")
    ref, vo = BIN_A.add(v, f)
    rec.update(files={"mesh": ref}, triangles=int(len(f)), bbox=bbox6(vo))
    anchors.append(rec)
za_anchor_n = len(anchors)
log(f"Z-Anatomy anchors: {za_anchor_n} ({sum(a['anchorClass']=='bone' for a in anchors)} skeletal, "
    f"{sum(a['anchorClass']=='soft' for a in anchors)} unchanged soft tissue of {n_soft_tested} name-matched)")

for m in ("upper-limb", "lower-limb"):
    idx, npz = O3D[m]
    for r in idx:
        g = (r["group"] or "").lower()
        if not (g.endswith("bones") or g == "bones") or not r["nf"]:
            continue
        base = o3d_clean(r["name"]).replace("_", " ")
        v, f = npz[f"v{r['i']}"].astype(np.float64), npz[f"f{r['i']}"].astype(np.int64)
        sd = None if abs(v[:, 0].mean()) < 0.012 and v[:, 0].min() < -0.002 and v[:, 0].max() > 0.002 else ("R" if v[:, 0].mean() < 0 else "L")
        a = make_anchor("open3dmodel", f"{m}/{r['name']}", base, sd, v, f, "o3d", True)
        if a is None:
            continue
        rec = a["rec"]
        if any(x["sourceObject"].split("/", 1)[-1] == r["name"] and x["source"] == "open3dmodel" for x in anchors):
            continue  # same bone present in both limb models
        rec["o3dModel"] = m
        rec["resculpted"] = rec["residualMeanMm"] > 2.5
        rec["quality"] = "good" if rec["residualMeanMm"] <= 1.5 else ("fair" if rec["residualMeanMm"] <= 2.5 else "poor")
        ref, vo = BIN_A.add(v, f)
        rec.update(files={"mesh": ref}, triangles=int(len(f)), bbox=bbox6(vo))
        anchors.append(rec)
        if sd == "R":  # the model is right-sided only; mirrored copy anchors the mirrored left nerves
            a2 = make_anchor("open3dmodel", f"{m}/{r['name']}", base, "L", *mirror_x(v, f), "o3d", True)
            if a2:
                rec2 = a2["rec"]
                rec2.update(id=zid("open3dmodel", f"{m}/{r['name']}", "anchor-mirror-L"), mirroredFrom=rec["id"], o3dModel=m,
                            resculpted=rec2["residualMeanMm"] > 2.5,
                            quality="good" if rec2["residualMeanMm"] <= 1.5 else ("fair" if rec2["residualMeanMm"] <= 2.5 else "poor"))
                ref, vo = BIN_A.add(*mirror_x(v, f))
                rec2.update(files={"mesh": ref}, triangles=int(len(f)), bbox=bbox6(vo))
                anchors.append(rec2)
log(f"Open3DModel anchors: {len(anchors) - za_anchor_n}")
res = np.array([a["residualMeanMm"] for a in anchors if a["anchorClass"] == "bone" and a["source"] == "z-anatomy"])
log(f"Z-Anatomy bone anchors ICP residual mm: median {np.median(res):.2f}, p90 {np.percentile(res,90):.2f}, max {res.max():.2f}; "
    f"resculpted (>2.5 mm): {sorted({a['name'] for a in anchors if a.get('resculpted') and a['source']=='z-anatomy'})}")
res = np.array([a["residualMeanMm"] for a in anchors if a["source"] == "open3dmodel"])
if len(res):
    log(f"Open3DModel bone anchors ICP residual mm: median {np.median(res):.2f}, p90 {np.percentile(res,90):.2f}, max {res.max():.2f}; "
        f"resculpted: {sorted({a['name'] for a in anchors if a.get('resculpted') and a['source']=='open3dmodel'})}")

for b in (BIN_N, BIN_P, BIN_A):
    b.close()

# ----------------------------------------------------------------------------- muscle attachment table (not exported as parts)
bone_pts, bone_lab, bone_names = [], [], []
anchor_by_obj = {a["sourceObject"]: a for a in anchors if a["source"] == "z-anatomy"}
for r in ZA_IDX:
    if r["system"].startswith("1") and r.get("nf", 0) >= 20:
        v, f = za_mesh(r)
        pts = sample(v, f, int(np.clip(len(f), 400, 4000)))
        bone_pts.append(pts)
        bone_lab += [len(bone_names)] * len(pts)
        bone_names.append(r["name"])
bone_tree = cKDTree(np.concatenate(bone_pts))
bone_lab = np.array(bone_lab)
bone_info = {}


def bone_rec(obj):
    if obj not in bone_info:
        base, sd = split_side(obj)
        a = anchor_by_obj.get(obj)
        if a and a["fma"]:
            bone_info[obj] = {"name": base, "side": sd or "M", "fma": a["fma"], "bp3dIds": a["bp3dIds"], "fmaSource": "bp3d-anchor"}
        else:
            rf = resolve_fma(base, sd or "M", (ta2_of(base) or {}).get("ta2"))
            bone_info[obj] = {"name": base, "side": sd or "M", "fma": rf.get("fma"), "bp3dIds": a["bp3dIds"] if a else [], "fmaSource": rf.get("fmaSource")}
    return bone_info[obj]


attachments = []
for r in ZA_IDX:
    m = re.match(r"(.*)\.([oe])(\d*)([lr])$", r["name"])
    if not (r["system"].startswith("2") and m and r.get("nf")):
        continue
    muscle, kind, num, s_ = m.group(1), {"o": "origin", "e": "insertion"}[m.group(2)], m.group(3), m.group(4).upper()
    v, f = za_mesh(r)
    pts = sample(v, f, 300)
    d, j = bone_tree.query(pts)
    near = d < 0.004
    shares = Counter(bone_names[k] for k in bone_lab[j[near]])
    tot = max(1, int(near.sum()))
    bones = [dict(bone_rec(n), share=round(c / len(pts), 2)) for n, c in shares.most_common() if c / len(pts) >= 0.1]
    nearest = bone_rec(bone_names[int(np.bincount(bone_lab[j]).argmax())])
    a_, b_, c_ = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    area = float(np.linalg.norm(np.cross(b_ - a_, c_ - a_), axis=1).sum() / 2)
    mf = resolve_fma(muscle, s_, (ta2_of(muscle) or {}).get("ta2"))
    attachments.append({
        "id": zid("z-anatomy", r["name"], "attachment"), "sourceObject": r["name"], "muscle": muscle, "side": s_, "kind": kind,
        "index": int(num) if num else None,
        "muscleFma": mf.get("fma"), "muscleFmaUnsided": mf.get("fmaUnsided"), "muscleFmaSource": mf.get("fmaSource"), "muscleFmaMatch": mf.get("fmaMatch"),
        "bones": bones, "nearestBone": {"name": nearest["name"], "side": nearest["side"], "fma": nearest["fma"]},
        "onBone": bool(np.median(d) < 0.004), "medianDistanceToBoneMm": round(float(np.median(d)) * 1e3, 2),
        "centroid": np.round(ax(pts.mean(0)), 5).tolist(), "areaCm2": round(area * 1e4 / (2 if "SOLIDIFY" in r["modifiers"] else 1), 2)})
json.dump({"schema": 1, "source": "Z-Anatomy (collection '2: Muscular insertions')", "license": "CC-BY-SA-4.0", "provenance": "curated (artist-modelled)",
           "attribution": "Z-Anatomy - The libre 3D atlas of anatomy - CC-BY-SA 4.0",
           "frame": "Z-Anatomy frame, metres, Y up, anterior +Z, left +X (not registered)",
           "method": "Each patch is sampled (300 points) and tested against the surfaces of Z-Anatomy's own skeletal objects. `bones` lists every "
                     "bone/cartilage within 4 mm of at least 10% of the patch (share = fraction of the patch). onBone=false: the patch lies more than "
                     "4 mm (median) from any bone, i.e. it attaches to fascia, a ligament, a tendon or skin. 'origin' = Z-Anatomy suffix .o, "
                     "'insertion' = suffix .e; `index` numbers several patches of one muscle.",
           "attachments": attachments}, open(f"{OUT}/attachments.json", "w"), indent=1)
log(f"attachments: {len(attachments)} patches, {len({(a['muscle']) for a in attachments})} muscle names; on bone {sum(a['onBone'] for a in attachments)}; "
    f"muscle FMA resolved {sum(1 for a in attachments if a['muscleFma'])}; with >=1 bone FMA {sum(1 for a in attachments if any(b['fma'] for b in a['bones']))}")

# ----------------------------------------------------------------------------- write
ids = Counter(i["id"] for i in items + anchors)
dup = [k for k, c in ids.items() if c > 1]
assert not dup, dup
manifest = {
    "schema": 1,
    "generated": "tools/zanatomy/build_import.py",
    "frame": {"units": "metres", "up": "+Y", "anterior": "+Z", "left": "+X",
              "note": "Coordinates are in the SOURCE atlas frame (item.frame: 'za' = Z-Anatomy, 'o3d' = Open3DModel), NOT registered to "
                      "BodyParts3D. Register 'za' items with source 'z-anatomy' anchors and 'o3d' items with 'open3dmodel' anchors."},
    "sources": [
        {"id": "z-anatomy", "name": "Z-Anatomy", "url": "https://github.com/Z-Anatomy/Models-of-human-anatomy", "commit": "26507ed2a9515289a6f705da470eb9559a48e03c",
         "license": "CC-BY-SA-4.0", "attribution": "Z-Anatomy - The libre 3D atlas of anatomy - CC-BY-SA 4.0"},
        {"id": "open3dmodel", "name": "AnatomyTool Open3DModel", "url": "https://anatomytool.org/open3dmodel", "license": "CC-BY-SA-4.0",
         "attribution": "Open3DModel, Open 3D Model project (LUMC, UMC Utrecht, Maastricht UMC+, KU Leuven KULAK), anatomytool.org - CC BY-SA 4.0; based on Z-Anatomy and BodyParts3D"},
        {"id": "bodyparts3d", "name": "BodyParts3D", "license": "see data/raw/bodyparts3d", "attribution": "BodyParts3D - The Database Center for Life Science - CC-BY-SA 2.1 Japan"}],
    "spinalLevelRule": SPLIT_REPORT["rule"],
    "excluded": excluded,
    "items": items,
    "anchors": anchors,
}
for it in items:
    if it.get("fmaNoteRoot"):
        it["fmaNote"] = it.pop("fmaNoteRoot")
with open(f"{OUT}/unsided_fma_items.tsv", "w", encoding="utf-8") as fh:
    fh.write("id\tkind\ttissue\tside\tname\tfma (unsided)\tfmaLabel\tcandidate\n")
    for it in items:
        if it.get("fmaIsUnsided"):
            fh.write(f"{it['id']}\t{it['kind']}\t{it['tissue']}\t{it['side']}\t{it['name']}\t{it['fma']}\t{it['fmaLabel']}\t{bool(it.get('candidate'))}\n")
json.dump(manifest, open(f"{OUT}/manifest.json", "w"), indent=1)
json.dump(centre, open(f"{OUT}/centrelines.json", "w"))
log(f"manifest: {len(items)} items ({sum(1 for i in items if i['files'])} with geometry), {len(anchors)} anchors, {len(excluded)} excluded objects")
log("FMA notes:", dict(FMA_STATS))
log(f"TA2->Wikidata->FMA rejected by label check ({len(MISMATCH)}):")
for mm in sorted(set(MISMATCH)):
    log("   ", mm)
log("split units:", Counter((o.split('.')[0], c) for o, u, l, c in SPLIT_REPORT["units"]))
log("ambiguous units:", SPLIT_REPORT["ambiguous"])
ner = [i for i in items if i["kind"] == "nerve"]
log("nerve items without FMA:", sorted({i["name"] for i in ner if not i["fma"]}))
open(f"{OUT}/build_log.txt", "w").write("\n".join(LOG) + "\n")
