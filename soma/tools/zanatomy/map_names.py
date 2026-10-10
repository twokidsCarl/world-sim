"""Estimate how Z-Anatomy object names map to FMA ids.

Usage: python3 -I map_names.py <export/index.json> <TA2.csv> <bp3d dir> <wikidata dir> [out.json]

Routes tried per (unsided) Z-Anatomy name:
  bp3d  : normalised name == BodyParts3D concept name (isa/partof lists)  -> FMA (sided ids available)
  ta2   : name == English column of Z-Anatomy's TA2.csv -> TA2 id -> Wikidata P7173 -> P1402 FMA
  wd    : name == Wikidata English label/alias of an item carrying P1402 FMA
"""
import csv
import json
import re
import sys
from collections import defaultdict

idxp, ta2p, bpdir, wddir = sys.argv[1:5]
out = sys.argv[5] if len(sys.argv) > 5 else None

SPELL = [("oesophag", "esophag"), ("caec", "cec"), ("haem", "hem"), ("fibular", "fibular"),
         ("coeliac", "celiac"), ("faec", "fec"), ("grey", "gray"), ("fibres", "fibers"), ("-", " ")]


def norm(s):
    s = s.lower().strip()
    s = re.sub(r"\s*\((?:[ivx]+|b[ivx+]+|c\d|[tl]\d+)\)$", "", s)  # "(VI)", "(BIII)"
    s = s.strip("()*' ")
    for a, b in SPELL:
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s)


def variants(n):
    n = norm(n)
    v = {n, re.sub(r" (muscle|bone|nerve|gland)$", "", n), n + " muscle"}
    v.add(re.sub(r"^(.*) of (left|right) (.*)$", r"\1 of \3", n))
    if n.endswith("s"):
        v.add(n[:-1])
    return v


# --- Z-Anatomy names
idx = json.load(open(idxp))
za = defaultdict(lambda: {"sides": set(), "types": set(), "system": None})
for r in idx:
    m = re.match(r"(.*)\.([lr])$", r["name"])
    base, side = (m.group(1), m.group(2)) if m else (r["name"], "")
    if re.search(r"\.[oe]\d*$", base):  # muscular origin/insertion patches ".ol/.e2r"
        continue
    e = za[(r["system"], base)]
    e["sides"].add(side)
    e["types"].add(r["type"])

# --- BP3D
bp = {}
for fn in ("isa_parts_list_e.txt", "partof_parts_list_e.txt"):
    for row in csv.reader(open(f"{bpdir}/{fn}", errors="replace"), delimiter="\t"):
        if row and row[0].startswith("FMA"):
            bp.setdefault(norm(row[2]), row[0])

# --- TA2.csv (one quoted field per line, ';' separated inside)
ta2 = {}
for line in open(ta2p, encoding="utf-8-sig"):
    parts = line.strip().strip('"').split(";")
    if len(parts) > 1 and parts[0].isdigit():
        ta2.setdefault(norm(parts[1]), parts[0])

# --- Wikidata
def uq(s):
    return re.sub(r'^"(.*)"(@en)?$', r"\1", s)


wd_name, wd_ta2 = {}, {}
# fma_labels.tsv: ?item ?fma ?itemLabel  (all ~79k Wikidata items carrying P1402, FMA was bulk-imported incl. left/right)
for row in csv.reader(open(f"{wddir}/fma_labels.tsv"), delimiter="\t", quoting=csv.QUOTE_NONE):
    if len(row) >= 3 and not row[0].startswith("?"):
        wd_name.setdefault(norm(uq(row[2])), "FMA" + uq(row[1]))
# fma_alts.tsv: ?fma ?alt
for row in csv.reader(open(f"{wddir}/fma_alts.tsv"), delimiter="\t", quoting=csv.QUOTE_NONE):
    if len(row) >= 2 and not row[0].startswith("?"):
        wd_name.setdefault(norm(uq(row[1])), "FMA" + uq(row[0]))
# ta2_items.tsv: ?item ?itemLabel ?ta2 ?ta98 ?fma
for row in csv.reader(open(f"{wddir}/ta2_items.tsv"), delimiter="\t", quoting=csv.QUOTE_NONE):
    if len(row) >= 5 and not row[0].startswith("?") and uq(row[4]):
        wd_ta2.setdefault(uq(row[2]), "FMA" + uq(row[4]))

rows = []
for (system, base), e in sorted(za.items()):
    V = variants(base)
    r = {"system": system, "name": base, "sided": bool(e["sides"] - {""}), "types": sorted(e["types"])}
    r["bp3d"] = next((bp[v] for v in V if v in bp), None)
    if r["sided"]:
        r["bp3d_sided"] = all(any(f"{s} {v}" in bp for v in V) for s in ("left", "right"))
    r["ta2"] = next((ta2[v] for v in V if v in ta2), None)
    r["ta2_fma"] = wd_ta2.get(r["ta2"]) if r["ta2"] else None
    r["wd"] = next((wd_name[v] for v in V if v in wd_name), None)
    r["fma_any"] = r["bp3d"] or r["ta2_fma"] or r["wd"]
    if r["sided"]:
        r["wd_sided"] = all(any(f"{s} {v}" in wd_name for v in V) for s in ("left", "right"))
    rows.append(r)


def report(label, sel):
    n = len(sel)
    if not n:
        return
    c = lambda k: sum(1 for r in sel if r.get(k))
    print(f"{label:46s} n={n:4d}  bp3d-name={c('bp3d'):4d} ({c('bp3d')/n:4.0%})  in-TA2.csv={c('ta2'):4d} ({c('ta2')/n:4.0%})  "
          f"TA2->FMA(wd)={c('ta2_fma'):4d} ({c('ta2_fma')/n:4.0%})  wd-label={c('wd'):4d} ({c('wd')/n:4.0%})  ANY FMA={c('fma_any'):4d} ({c('fma_any')/n:4.0%})")


print(f"BP3D names {len(bp)}, TA2.csv terms {len(ta2)}, Wikidata FMA names {len(wd_name)}, Wikidata TA2->FMA {len(wd_ta2)}")
for s in sorted({r["system"] for r in rows}):
    report(s, [r for r in rows if r["system"] == s])
nerves = [r for r in rows if r["system"].startswith("7") and "CURVE" in r["types"]]
report("  of which nerve curves (system 7)", nerves)
report("ALL", rows)
print("\nnerve curves with NO FMA by any route:")
print("; ".join(r["name"] for r in nerves if not r["fma_any"]))
print("\nnerve curves resolved only via crosswalk (not a BP3D concept name):",
      sum(1 for r in nerves if r["fma_any"] and not r["bp3d"]))
sided = [r for r in rows if r["sided"] and r["bp3d"]]
print(f"sided names with a BP3D match: {len(sided)}; with both 'left X' and 'right X' BP3D concepts: {sum(1 for r in sided if r.get('bp3d_sided'))}")
sn = [r for r in nerves if r["sided"]]
print(f"sided nerve curves: {len(sn)}; with Wikidata/FMA 'left X' and 'right X' labels: {sum(1 for r in sn if r.get('wd_sided'))}")
sa = [r for r in rows if r["sided"] and not r["system"].startswith("2")]
print(f"all sided names (excl. insertions): {len(sa)}; sided FMA id via BP3D or Wikidata labels: {sum(1 for r in sa if r.get('wd_sided') or r.get('bp3d_sided'))}")
if out:
    json.dump(rows, open(out, "w"), indent=0)
