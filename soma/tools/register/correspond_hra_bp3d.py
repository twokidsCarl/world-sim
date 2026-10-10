#!/usr/bin/env python3
"""Match HRA united-female mesh nodes to BodyParts3D concepts.

Match order per HRA node (crosswalk gives UBERON or FMA id + label):
  1. FMA id directly present in BodyParts3D
  2. UBERON id -> FMA xref (uberon-simple.obo) present in BodyParts3D
  3. normalised label / node-name equality (handles left/right word order)
Only HRA nodes that actually carry a mesh (from inspect_glb.py TSV) are counted.

Usage: python -I correspond_hra_bp3d.py BP3D_DIR CROSSWALK.csv UBERON.obo MESH_NODES.tsv OUT.tsv
"""
import csv
import re
import sys
from collections import Counter


def norm(s):
    s = s.lower().replace("_", " ")
    s = re.sub(r"\b(vh f|vh m)\b", " ", s)
    s = re.sub(r"\b(l|left)\b", " left ", s)
    s = re.sub(r"\b(r|right)\b", " right ", s)
    s = re.sub(r"\b(of|the)\b", " ", s)
    s = s.replace("fallopian tube", "uterine tube").replace("extraocular muscle", "").replace("vertebra ", "vertebra")
    ords = "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth".split()
    for i, o in enumerate(ords, 1):
        s = re.sub(rf"\b{o}\b", str(i), s)
    return " ".join(sorted(re.findall(r"[a-z0-9]+", s)))


def main():
    bp_dir, cw_path, obo_path, nodes_path, out = sys.argv[1:6]
    bp = {}
    for fn in ("isa_parts_list_e.txt", "partof_parts_list_e.txt"):
        for r in csv.DictReader(open(f"{bp_dir}/{fn}", encoding="utf-8", errors="replace"), delimiter="\t"):
            bp.setdefault(r["concept id"].replace("FMA", ""), r["en"])
    bp_by_name = {norm(v): k for k, v in bp.items()}

    ub2fma, cur = {}, None
    for line in open(obo_path, encoding="utf-8"):
        if line.startswith("id: UBERON:"):
            cur = line.split()[1]
        elif line.startswith("xref: FMA:") and cur:
            ub2fma.setdefault(cur, []).append(line.split()[1].split(":")[1])
        elif line.startswith("[") :
            cur = None

    mesh_nodes = {r["node"]: r for r in csv.DictReader(open(nodes_path), delimiter="\t")}
    cw = {r["node_name"]: r for r in csv.DictReader(open(cw_path))}
    rows, how = [], Counter()
    for node, m in mesh_nodes.items():
        c = cw.get(node)
        oid = c["OntologyID"] if c else ""
        label = c["label"] if c else ""
        fma, via = "", ""
        if oid.startswith("FMA:") and oid[4:] in bp:
            fma, via = oid[4:], "fma"
        elif oid.startswith("UBERON:"):
            for f in ub2fma.get(oid, []):
                if f in bp:
                    fma, via = f, "uberon-xref"
                    break
        if not fma:
            for cand in (norm(node), norm(label)):
                if cand in bp_by_name:
                    fma, via = bp_by_name[cand], "name"
                    break
        how[via or ("unmatched" if c else "no-crosswalk-row")] += 1
        rows.append((m["path"].split("/")[1] if "/" in m["path"] else "", node, oid, label,
                     ("FMA" + fma) if fma else "", bp.get(fma, ""), via, m["tris"]))
    with open(out, "w") as f:
        f.write("system\thra_node\thra_ontology_id\thra_label\tbp3d_concept\tbp3d_name\tmatched_via\ttris\n")
        for r in rows:
            f.write("\t".join(r) + "\n")
    print("BodyParts3D concepts:", len(bp), "| HRA mesh nodes:", len(mesh_nodes))
    print("match method:", dict(how))
    per = Counter((r[0], bool(r[4])) for r in rows)
    for s in sorted({r[0] for r in rows}):
        print(f"  {s:45s} matched {per[(s, True)]:4d} / {per[(s, True)] + per[(s, False)]}")
    print("distinct BP3D concepts hit:", len({r[4] for r in rows if r[4]}))


if __name__ == "__main__":
    main()
