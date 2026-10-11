"""Validate data/raw/z-anatomy/out/import (run from the soma project root).

Usage: tools/zanatomy/.venv/bin/python -I tools/zanatomy/validate_import.py [> out/import/validation.txt]
Exit code 1 if any hard check fails.
"""
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict

import numpy as np

ROOT = os.getcwd()
D = f"{ROOT}/data/raw/z-anatomy/out/import"
M = json.load(open(f"{D}/manifest.json"))
CL = json.load(open(f"{D}/centrelines.json"))
items, anchors = M["items"], M["anchors"]
fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


bins = {n: np.memmap(f"{D}/{n}", dtype=np.uint8, mode="r") for n in ("nerves.bin", "parts.bin", "anchors.bin")}


def read_mesh(ref):
    b = bins[ref["file"]]
    v = np.frombuffer(b, dtype="<f4", count=ref["vCount"] * 3, offset=ref["vOffset"]).reshape(-1, 3)
    i = np.frombuffer(b, dtype="<u4", count=ref["iCount"], offset=ref["iOffset"]).reshape(-1, 3)
    return v, i


print("== 1. files / geometry integrity")
ids = Counter(r["id"] for r in items + anchors)
check(all(c == 1 for c in ids.values()), "duplicate ids")
check(all(re.fullmatch(r"ZA[0-9A-F]{8}", k) for k in ids), "id format")
n_geo = n_cl = n_branch = 0
side_bad, bbox_bad = [], []
for r in items + anchors:
    if r.get("candidate"):
        check(r["files"] is None, f"candidate with files {r['id']}")
        continue
    check(r["files"] and "mesh" in r["files"], f"no mesh: {r['id']} {r['name']}")
    ref = r["files"]["mesh"]
    check(ref["iOffset"] + ref["iCount"] * 4 <= len(bins[ref["file"]]), f"mesh ref out of range: {r['id']}")
    v, i = read_mesh(ref)
    n_geo += 1
    check(len(i) == r["triangles"] and len(i) > 0, f"triangle count: {r['id']}")
    check(i.max() < len(v), f"index out of range: {r['id']}")
    check(np.isfinite(v).all(), f"non-finite vertex: {r['id']}")
    bb = list(v.min(0)) + list(v.max(0))
    check(np.allclose(bb, r["bbox"], atol=2e-5), f"bbox mismatch: {r['id']}")
    # plausibility in the source frame (metres, Y up): body is ~1.75 m tall, arms down
    if not (-0.45 < bb[0] and bb[3] < 0.45 and -0.02 < bb[1] and bb[4] < 1.80 and -0.30 < bb[2] and bb[5] < 0.25):
        bbox_bad.append((r["id"], r["name"], [round(x, 3) for x in bb]))
    cx = float(v[:, 0].mean())
    if (r["side"] == "L" and cx < -0.03) or (r["side"] == "R" and cx > 0.03):
        side_bad.append((r["id"], r["name"], r["side"], round(cx, 4)))
    if r.get("kind") == "nerve" and "centreline" in r["files"]:
        cl = CL.get(r["files"]["centreline"]["key"])
        check(cl is not None and len(cl) == r["files"]["centreline"]["branches"], f"centreline missing: {r['id']}")
        n_cl += 1
        for b in cl or []:
            n_branch += 1
            P = np.array(b["points"])
            check(len(P) >= 2 and len(P) == len(b["radius"]), f"centreline branch malformed: {r['id']}")
            # centreline must lie inside its own tube mesh bbox (2 mm slack)
            check((P.min(0) > np.array(bb[:3]) - 0.002).all() and (P.max(0) < np.array(bb[3:]) + 0.002).all(), f"centreline outside mesh bbox: {r['id']}")
print(f"items+anchors with geometry read back: {n_geo}; nerve items with centrelines: {n_cl} ({n_branch} branches)")
ner = [r for r in items if r["kind"] == "nerve"]
no_cl = [r for r in ner if "centreline" not in r["files"]]
print(f"nerve items without a centreline: {len(no_cl)} ({Counter(r['name'].split(' spinal ganglion')[-1] if 'ganglion' not in r['name'].lower() else 'ganglia (meshes, not tubes)' for r in no_cl).most_common(5)})")
print(f"nerve items with incomplete centrelines (some branch not recoverable): {sum(1 for r in ner if r.get('centrelineIncomplete'))}")
deriv = Counter(b.get("derivation") for cl in CL.values() for b in cl)
print(f"centreline derivation per branch: {dict(deriv)}")
print(f"bbox outside plausible body bounds: {len(bbox_bad)}")
for b in bbox_bad[:10]:
    print("   ", b)
print(f"side label vs centroid x sign mismatches: {len(side_bad)}")
for b in side_bad[:10]:
    print("   ", b)
check(not bbox_bad, "implausible bboxes")
check(len(side_bad) == 0, "side mismatches")

print("\n== 2. left/right pairs")
pairs = defaultdict(set)
for r in items:
    if r["side"] in "LR":
        pairs[(r["source"], r["name"], bool(r.get("candidate")))].add(r["side"])
unp = sorted(k for k, s in pairs.items() if len(s) == 1)
print(f"sided names: {len(pairs)}; with only one side: {len(unp)}")
for k in unp:
    print("   ", k, pairs[k])

print("\n== 3. counts")
exp = [r for r in items if not r.get("candidate")]
cand = [r for r in items if r.get("candidate")]
print(f"items: {len(items)} = {len(exp)} exported + {len(cand)} candidates (listed only); anchors: {len(anchors)}; excluded objects: {len(M['excluded'])}")
print("exported by system/kind:", dict(sorted(Counter(f"{r['system']}/{r['kind']}" for r in exp).items())))
print("exported by source/kind:", dict(Counter(f"{r['source']}/{r['kind']}" for r in exp)))
print("exported mesh parts by category:", dict(Counter(r.get("category") for r in exp if r["kind"] == "mesh")))
print("  tissue:", dict(Counter(r["tissue"] for r in exp if r["kind"] == "mesh")))
print("  flags: alsoInBp3d30", sum(1 for r in exp if r.get("alsoInBp3d30")), "| inBp3d40", sum(1 for r in exp if r.get("inBp3d40")))
print("nerve items: preferred", sum(1 for r in ner if r["preferred"]), "| superseded Z-Anatomy items kept as alternates", sum(1 for r in ner if not r["preferred"]),
      "| split units", sum(1 for r in ner if r.get("splitFrom")), "| mirrored (Open3DModel left side)", sum(1 for r in ner if r.get("mirroredFrom")))
print("  split-unit level confidence:", dict(Counter(r["levelConfidence"] for r in ner if r.get("splitFrom"))))
print("  ambiguous:", [f"{r['splitFrom']} / {r['name']}" for r in ner if r.get("levelAmbiguous")])
print("triangles: nerves", sum(r["triangles"] for r in ner), "| mesh parts", sum(r["triangles"] for r in exp if r["kind"] == "mesh"), "| anchors", sum(a["triangles"] for a in anchors))
print("candidates by Z-Anatomy collection:", dict(sorted(Counter(r["zaCollection"] for r in cand).items())))
print("anchors:", dict(Counter(f"{a['source']}/{a['anchorClass']}/{a['quality']}" for a in anchors)))
print("  resculpted:", sorted({f"{a['name']} ({a['source'][:1]}, {a['residualMeanMm']:.1f} mm)" for a in anchors if a["resculpted"]}))
A = json.load(open(f"{ROOT}/public/anatomy/male/anatomy.json"))
our_ids = {p["id"] for p in A["parts"]}
check(all(set(a["bp3dIds"]) <= our_ids for a in anchors), "anchor bp3dIds not in anatomy.json")
print(f"  all anchor bp3dIds exist in public/anatomy/male/anatomy.json: {all(set(a['bp3dIds']) <= our_ids for a in anchors)}")
print("excluded:", sorted(e["object"] for e in M["excluded"]))

print("\n== 4. FMA coverage")
fma_ok = {r[0] for r in csv.reader(open(f"{ROOT}/data/raw/z-anatomy/fma/fma_names.tsv", encoding="utf-8"), delimiter="\t", quoting=csv.QUOTE_NONE)}
check(all(r["fma"] in fma_ok for r in items if r["fma"]), "FMA id not in FMA 5.1.0")
print("every assigned FMA id exists in FMA 5.1.0:", all(r["fma"] in fma_ok for r in items if r["fma"]))
for label, sel in (("exported", exp), ("candidates", cand)):
    print(f"{label}:")
    by = defaultdict(list)
    for r in sel:
        by[f"{r['system']}/{r['kind']}"].append(r)
    for k in sorted(by):
        rs = by[k]
        n = len(rs)
        f = sum(1 for r in rs if r["fma"])
        sided = [r for r in rs if r["side"] in "LR" and r["fma"]]
        src = Counter(r["fmaSource"] for r in rs)
        print(f"  {k:22s} n={n:4d}  FMA {f:4d} ({f/n:4.0%})  sided id {sum(1 for r in sided if r.get('fmaSided')):4d}/{len(sided):4d}  "
              f"name-match {src['name-match']}, ta2-wikidata {src['ta2-wikidata']}, manual {src['manual']}, null {src[None]}")
print("name vs FMA class (fmaMatch), exported:", dict(Counter(r.get("fmaMatch") or "no FMA id" for r in exp)))
check(all(r.get("fmaMatch") for r in items if r["fma"]), "item with FMA id but no fmaMatch")
uns = [r for r in exp if r.get("fmaIsUnsided")]
check(all((r.get("fmaSided") is False) == bool(r.get("fmaIsUnsided")) for r in items if r["fma"] and r["side"] in "LR"), "fmaIsUnsided inconsistent with fmaSided")
check(all(r["fma"] == r["fmaUnsided"] for r in items if r.get("fmaIsUnsided")), "fmaIsUnsided item whose fma is not the unsided id")
print(f"lateralised exported items with an unsided FMA id (fmaIsUnsided: true; listed in unsided_fma_items.tsv): {len(uns)}",
      dict(Counter(f"{r['kind']}/{r['tissue']}" for r in uns)))
pn = [r for r in ner if r["preferred"]]
print(f"preferred nerve items: {len(pn)}; with FMA {sum(1 for r in pn if r['fma'])}; unique FMA ids {len({r['fma'] for r in pn if r['fma']})}")
dup = Counter(r["fma"] for r in pn if r["fma"])
print("  FMA ids shared by differently named preferred nerve items:",
      {k: v for k, v in ((k, sorted({r['name'] for r in pn if r['fma'] == k})) for k, c in dup.items() if c > 1) if len(v) > 1})
near = [(r["name"], r["side"], round(float(read_mesh(r["files"]["mesh"])[0][:, 0].mean()), 3)) for r in exp if r["side"] in "LR"]
near = [n for n in near if (n[1] == "L" and n[2] < -0.002) or (n[1] == "R" and n[2] > 0.002)]
print("  sided items whose centroid is slightly across the midline (< 3 cm, kept as labelled):", near)
print("  nerve names without FMA:", sorted({r["name"] for r in ner if not r["fma"]}))

print("\n== 5. nerves still missing from both sources")
have = " | ".join(sorted({r["name"].lower() for r in ner}))
CHECK = ["phrenic nerve", "great auricular nerve", "lesser occipital nerve", "transverse cervical nerve", "supraclavicular nerve",
         "ansa cervicalis", "greater occipital nerve", "suboccipital nerve", "subcostal nerve", "intercostobrachial nerve",
         "greater splanchnic nerve", "lesser splanchnic nerve", "least splanchnic nerve", "lumbar splanchnic", "pelvic splanchnic",
         "cardiac plexus", "pulmonary plexus", "coeliac plexus", "superior mesenteric plexus", "inferior mesenteric plexus",
         "superior hypogastric plexus", "inferior hypogastric plexus", "recurrent laryngeal nerve", "superior laryngeal nerve",
         "inferior gluteal nerve", "superior gluteal nerve", "nerve to obturator internus", "pudendal nerve", "inferior rectal nerve", "perineal nerve",
         "dorsal nerve of penis", "posterior brachial cutaneous nerve", "lateral sural cutaneous nerve", "coccygeal nerve",
         "lumbosacral trunk", "lateral cord of brachial plexus", "medial cord of brachial plexus", "thoracodorsal nerve",
         "auriculotemporal nerve", "infra-orbital nerve", "zygomatic nerve", "frontal nerve", "nasociliary nerve", "lacrimal nerve",
         "greater petrosal nerve", "posterior rami of spinal nerves", "c1 spinal nerve", "s5"]
missing = [c for c in CHECK if c.replace(" nerve", "") not in have and c not in have]
print("checked", len(CHECK), "names; missing:", missing)
lv_have = sorted({r["level"] for r in ner if r.get("level") and r["name"].startswith("Anterior root")}, key=lambda l: ("CTLS".index(l[0]), int(l[1:])))
print("spinal root levels present (anterior roots):", lv_have, "+ cauda equina roots:", sorted({r['level'] for r in ner if r.get('splitFrom') == 'Cauda equina' and r.get('level')}))

print("\n== 6. batch 2")
b2 = [r for r in items if r.get("batch") == 2]
check(all(r["files"] and r.get("quality") and r.get("batchGroup") for r in b2), "batch-2 item without files/quality/batchGroup")
check(not any(r.get("candidate") for r in b2), "batch-2 item still flagged candidate")
print(f"batch-2 items: {len(b2)}; by source {dict(Counter(r['source'] for r in b2))}; triangles {sum(r['triangles'] for r in b2)}")
for gname in sorted({r["batchGroup"] for r in b2}):
    g = [r for r in b2 if r["batchGroup"] == gname]
    names_ = sorted({r["name"] for r in g})
    print(f"  {gname:38s} items {len(g):4d}  names {len(names_):4d}  FMA {sum(1 for r in g if r['fma']):4d}  closed {sum(1 for r in g if r['quality']['closed']):4d}  "
          f"duplicateRisk high {sum(1 for r in g if r.get('duplicateRisk') == 'high'):4d}")
    if gname.startswith("requested"):
        print("      " + "; ".join(f"{n} [{'/'.join(sorted({r['source'][0] for r in g if r['name'] == n}))}]" for n in names_))
f2 = sum(1 for r in b2 if r["fma"])
print(f"batch-2 FMA coverage: {f2}/{len(b2)} ({f2/len(b2):.0%}); fmaMatch {dict(Counter(r.get('fmaMatch') or 'none' for r in b2))}; "
      f"lateralised with unsided id {sum(1 for r in b2 if r.get('fmaIsUnsided'))}")
old_ids = None
print("remaining candidates (listed only):", dict(Counter(r["zaCollection"] for r in cand)))

print("\n== 7. attachments.json")
AT = json.load(open(f"{D}/attachments.json"))["attachments"]
check(len({a["id"] for a in AT}) == len(AT), "duplicate attachment ids")
print(f"patches: {len(AT)}; muscles (unsided names): {len({a['muscle'] for a in AT})}; origin {sum(a['kind']=='origin' for a in AT)}, insertion {sum(a['kind']=='insertion' for a in AT)}")
print(f"on bone (median distance < 4 mm): {sum(a['onBone'] for a in AT)}; muscle FMA resolved: {sum(1 for a in AT if a['muscleFma'])}; "
      f"patches with at least one bone carrying an FMA id: {sum(1 for a in AT if any(b['fma'] for b in a['bones']))}; "
      f"patches spanning more than one bone: {sum(1 for a in AT if len(a['bones']) > 1)}")
print("not on bone:", sorted({f"{a['muscle']} ({a['kind']})" for a in AT if not a["onBone"]}))
gp = f"{ROOT}/data/curated/knowledge/muscle-gaps.json"
if os.path.exists(gp):
    G = json.load(open(gp))["muscles"]
    by_fma = defaultdict(set)
    by_name = defaultdict(set)
    for a in AT:
        for k in (a["muscleFma"], a["muscleFmaUnsided"]):
            if k:
                by_fma[k].add(a["kind"])
        by_name[re.sub(r" muscle$", "", a["muscle"].lower()).strip("() ")].add(a["kind"])
    need = cov_full = cov_part = whole = 0
    rows = []
    for g in G:
        want = {k for k in g["missing"] + g.get("wholeMuscleOnly", []) if k in ("origin", "insertion")}
        if not want:
            continue
        need += 1
        got = set()
        for k in g["fma"]:
            got |= by_fma.get(k, set())
        got |= by_name.get(g["name"].lower(), set())
        viaw = set()
        if g.get("wholeMuscle"):
            viaw = by_name.get(g["wholeMuscle"].lower(), set())
        if want <= got:
            cov_full += 1
        elif want & got:
            cov_part += 1
        elif want & viaw:
            whole += 1
        rows.append((g["name"], sorted(want), sorted(got), sorted(viaw)))
    print(f"muscle-gaps.json: {len(G)} gap muscles, {need} lack origin and/or insertion (missing or whole-muscle-only)")
    print(f"  covered by a patch of that very muscle/part: fully {cov_full}, partly {cov_part}; only via the whole muscle's patches: {whole}; not covered: {need - cov_full - cov_part - whole}")
    print("  not covered:", [r[0] for r in rows if not (set(r[1]) & set(r[2])) and not (set(r[1]) & set(r[3]))])
    with open(f"{D}/attachments_gap_coverage.tsv", "w") as fh:
        fh.write("gapMuscle\twanted\tpatchesOfThisMuscle\tpatchesOfWholeMuscle\n")
        for r in rows:
            fh.write(f"{r[0]}\t{','.join(r[1])}\t{','.join(r[2])}\t{','.join(r[3])}\n")
reg = defaultdict(lambda: [set(), 0])
for r in cand:
    if r["zaCollection"].startswith("9"):
        reg[r["name"]][0].add(r["side"])
        reg[r["name"]][1] = r["zaTriangles"]
with open(f"{D}/surface_regions.tsv", "w") as fh:
    fh.write("name\tsides\ttriangles\tfma\n")
    fm = {r["name"]: r.get("fmaUnsided") for r in cand}
    for n in sorted(reg):
        fh.write(f"{n}\t{''.join(sorted(reg[n][0]))}\t{reg[n][1]}\t{fm.get(n) or ''}\n")
print(f"surface regions still listed only: {len(reg)} names (surface_regions.tsv); names mentioning dermatome/nerve territory: "
      f"{[n for n in reg if re.search('dermatom|nerve|cutaneous', n, re.I)]}")
mid = {p_["id"] for p_ in A["parts"] if p_["id"].startswith("ZA")}
check(mid <= set(ids), "an already-merged ZA id is no longer in the manifest")
print(f"ids of the {len(mid)} ZA parts already merged in anatomy.json all still present: {mid <= set(ids)}")

print("\n== result:", "FAIL" if fails else "PASS")
for f_ in fails[:40]:
    print("  FAIL", f_)
sys.exit(1 if fails else 0)
