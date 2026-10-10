#!/usr/bin/env python3
"""Map TotalSegmentator class names to BodyParts3D concepts (FMA ids) by name.

For every class of the given TS tasks, candidate English FMA-style names are
generated (side word order, ordinal vertebra/rib names, a small alias table)
and looked up in the BodyParts3D parts lists. Output TSV lists each class,
the matched concept (or blank) and the match kind:
  exact      one TS class <-> one BP3D concept
  composite  TS class is a union of several BP3D concepts (listed)
  none       no BP3D counterpart found by name

Usage: python -I correspond_ts_bp3d.py BP3D_DIR OUT.tsv total [body abdominal_muscles ...]
"""
import csv
import re
import sys
from collections import Counter

from totalsegmentator.map_to_binary import class_map

ORD = "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth".split()
ALIAS = {
    "adrenal_gland": ["adrenal gland"], "hip": ["hip bone"], "clavicula": ["clavicle"],
    "small_bowel": ["jejunum+ileum", "small intestine"], "colon": ["colon", "large intestine"],
    "autochthon": ["erector spinae", "iliocostalis+longissimus+spinalis"],
    "iliopsoas": ["psoas major+iliacus"], "iliac_artery": ["common iliac artery"],
    "iliac_vena": ["common iliac vein"], "atrial_appendage_left": ["left auricle", "auricle of left atrium"],
    "portal_vein_and_splenic_vein": ["portal vein+splenic vein"], "thyroid_gland": ["thyroid gland", "thyroid"], "brachiocephalic_trunk": ["brachiocephalic artery", "brachiocephalic trunk"], "trapezius": ["trapezius", "descending part of trapezius+ascending part of trapezius"], "tarsal": ["tarsal bone"], "carpal": ["carpal bone"], "metatarsal": ["metatarsal bone"], "metacarpal": ["metacarpal bone"],
    "lung_upper_lobe_left": ["upper lobe of left lung"], "lung_lower_lobe_left": ["lower lobe of left lung"],
    "lung_upper_lobe_right": ["upper lobe of right lung"], "lung_middle_lobe_right": ["middle lobe of right lung", "middle lobe of lung"],
    "lung_lower_lobe_right": ["lower lobe of right lung"], "costal_cartilages": ["costal cartilage"],
    "skull": ["skull"], "body": ["skin"], "skin": ["skin"], "breast": ["breast", "mammary gland"],
    "hyoid": ["hyoid bone"], "larynx_air": [], "transversospinalis": ["transversospinales", "multifidus+semispinalis thoracis+rotatores"],
    "sternocleidomastoid": ["sternocleidomastoid"], "pulmonary_vein": ["pulmonary vein"],
}


def cands(name):
    side = ""
    base = name
    m = re.match(r"(.*)_(left|right)(_\d+)?$", name)
    if m:
        base, side = m.group(1) + (m.group(3) or ""), m.group(2) + " "
    m = re.match(r"vertebrae_([CTLS])(\d+)$", name)
    if m:
        reg = {"C": "cervical", "T": "thoracic", "L": "lumbar", "S": "sacral"}[m.group(1)]
        n = int(m.group(2))
        extra = {("C", 1): ["atlas"], ("C", 2): ["axis"]}.get((m.group(1), n), [])
        return extra + [f"{ORD[n - 1]} {reg} vertebra"]
    m = re.match(r"rib_(\d+)$", base)
    if m:
        return [f"{side}{ORD[int(m.group(1)) - 1]} rib"]
    out = []
    out += ALIAS.get(name, []) if name != base else []   # full-name aliases already carry the side
    for a in ALIAS.get(base, []) + [base.replace("_", " ")]:
        out.append("+".join(side + p for p in a.split("+")))
    return out


def main():
    bp_dir, out, tasks = sys.argv[1], sys.argv[2], sys.argv[3:]
    bp = {}
    for fn in ("isa_parts_list_e.txt", "partof_parts_list_e.txt"):
        for r in csv.DictReader(open(f"{bp_dir}/{fn}", encoding="utf-8", errors="replace"), delimiter="\t"):
            bp.setdefault(r["en"].strip().lower(), r["concept id"])
    rows = []
    for t in tasks:
        for idx, name in class_map[t].items():
            hit, kind = "", "none"
            for c in cands(name):
                parts = c.split("+")
                if all(p in bp for p in parts):
                    hit = ";".join(f"{bp[p]}={p}" for p in parts)
                    kind = "exact" if len(parts) == 1 else "composite"
                    break
            rows.append((t, idx, name, kind, hit))
    with open(out, "w") as f:
        f.write("task\tlabel\tts_class\tmatch\tbp3d\n")
        for r in rows:
            f.write("\t".join(map(str, r)) + "\n")
    for t in tasks:
        c = Counter(r[3] for r in rows if r[0] == t)
        print(t, dict(c), "| none:", [r[2] for r in rows if r[0] == t and r[3] == "none"])


if __name__ == "__main__":
    main()
