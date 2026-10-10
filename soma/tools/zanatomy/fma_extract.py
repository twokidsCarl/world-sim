"""Extract a compact name table from the FMA OWL release (fma.owl, v5.1.0).

Usage: python3 -I fma_extract.py <fma.owl> <out.tsv>
Columns: fmaid, label, synonyms ('|'-joined), TA98 ids ('|'-joined), parent fmaids ('|').
Line-based scan (the file is 208 MB of regular RDF/XML written by the OWL API).
"""
import html
import re
import sys

src, out = sys.argv[1], sys.argv[2]
n = 0
with open(src, encoding="utf-8") as fh, open(out, "w", encoding="utf-8") as o:
    o.write("fmaid\tlabel\tsynonyms\tta98\tparents\n")
    cur = None
    depth = 0
    for line in fh:
        s = line.strip()
        if cur is None:
            m = re.match(r'<owl:Class rdf:about="http://purl.org/sig/ont/fma/fma(\d+)">', s)
            if m and line.startswith("    <owl:Class"):
                cur = {"id": None, "label": "", "syn": [], "ta": [], "par": []}
            continue
        if line.startswith("    </owl:Class>"):
            if cur["id"]:
                o.write("\t".join(["FMA" + cur["id"], cur["label"], "|".join(cur["syn"]), "|".join(cur["ta"]), "|".join(cur["par"])]) + "\n")
                n += 1
            cur = None
            continue
        m = re.match(r"<(rdfs:label|fma:FMAID|fma:synonym|fma:TA_ID|fma:preferred_name)[^>]*>(.*?)</", s)
        if m:
            k, v = m.group(1), html.unescape(m.group(2)).replace("\t", " ")
            if k == "fma:FMAID":
                cur["id"] = v
            elif k == "rdfs:label":
                cur["label"] = v
            elif k == "fma:synonym":
                cur["syn"].append(v)
            elif k == "fma:TA_ID":
                cur["ta"].append(v)
            continue
        m = re.match(r'<rdfs:subClassOf rdf:resource="http://purl.org/sig/ont/fma/fma(\d+)"/>', s)
        if m and line.startswith("        <rdfs:subClassOf"):
            cur["par"].append("FMA" + m.group(1))
print("classes", n)
