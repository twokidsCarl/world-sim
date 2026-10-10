"""Nerve inventory from the export (curve objects in '7: Nervous system & Sense organs').

Usage: .venv/bin/python -I nerves_report.py <export dir> [out.tsv]
Prints per-parent-group tables with splines, control points, centreline length, tube radius.
"""
import json
import re
import sys
from collections import defaultdict

import numpy as np

exp = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else None
idx = json.load(open(f"{exp}/index.json"))

groups = defaultdict(dict)
for r in idx:
    if not (r["system"].startswith("7") and r["type"] == "CURVE"):
        continue
    m = re.match(r"(.*)\.([lr])$", r["name"])
    base, side = (m.group(1), m.group(2)) if m else (r["name"], "-")
    L, npts, rad = 0.0, 0, []
    for sp in r["splines"]:
        P = np.array(sp["points"])
        npts += len(P)
        if len(P) > 1:
            L += float(np.linalg.norm(np.diff(P, axis=0), axis=1).sum())
        rad += sp["radius"]
    e = groups[(r["parent"] or "-").replace(".g", "")].setdefault(
        base, {"sides": "", "splines": 0, "pts": 0, "len_mm": 0.0, "r_mm": [], "tris": 0})
    e["sides"] += side
    e["splines"] = max(e["splines"], len(r["splines"]))
    e["pts"] = max(e["pts"], npts)
    e["len_mm"] = max(e["len_mm"], L * 1e3)  # control-polygon length (lower bound for Bezier)
    e["r_mm"] = [min(rad) * r["bevel_depth"] * 1e3, max(rad) * r["bevel_depth"] * 1e3] if rad else [0, 0]
    e["tris"] = max(e["tris"], r.get("nf", 0))

lines = ["group\tnerve\tsides\tsplines\tcontrol_pts\tlength_mm\ttube_radius_mm_min\ttube_radius_mm_max\ttube_tris"]
tot = 0
for g in sorted(groups):
    print(f"\n[{g}]  {len(groups[g])} names")
    for n, e in sorted(groups[g].items()):
        tot += len(e["sides"])
        print(f"  {n:62s} {e['sides']:2s} splines={e['splines']:3d} pts={e['pts']:4d} len={e['len_mm']:7.0f} mm  r={e['r_mm'][0]:.2f}-{e['r_mm'][1]:.2f} mm  tris={e['tris']}")
        lines.append(f"{g}\t{n}\t{e['sides']}\t{e['splines']}\t{e['pts']}\t{e['len_mm']:.0f}\t{e['r_mm'][0]:.2f}\t{e['r_mm'][1]:.2f}\t{e['tris']}")
print("\ntotal nerve curve objects:", tot, "unique names:", sum(len(v) for v in groups.values()))
if out:
    open(out, "w").write("\n".join(lines) + "\n")
