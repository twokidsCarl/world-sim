"""Audit name vs FMA concept in the import manifest (run from the soma project root).

Usage: tools/zanatomy/.venv/bin/python -I tools/zanatomy/audit_fma.py [--list] [--diff <older manifest.json>]

Every item with an FMA id carries `fmaMatch`, set by build_import.py from FMA 5.1.0:
  preferred-label         name == preferred label of the (unsided) class after normalisation
  synonym                 name == an FMA synonym of the class            (reviewed by hand, see za_manual_fma.tsv)
  set-class               FMA class is 'Set of <name>'
  singular-class-for-set  name is a plural, FMA class is the singular
  generated-level-label   spinal-level unit; class found by the canonical label built from the level
  curated-equivalent      different wording, accepted by hand table or TA2 -> Wikidata (reviewed)
--list prints every item that is not preferred-label / set-class / generated-level-label.
"""
import json
import os
import sys
from collections import Counter

D = f"{os.getcwd()}/data/raw/z-anatomy/out/import"
M = json.load(open(f"{D}/manifest.json"))
items = M["items"]
for scope, sel in (("exported", [i for i in items if not i.get("candidate")]), ("candidates", [i for i in items if i.get("candidate")])):
    c = Counter(i.get("fmaMatch") or "no FMA id" for i in sel)
    print(f"{scope}: {len(sel)} items;", ", ".join(f"{k} {v}" for k, v in c.most_common()))
    u = {}
    for i in sel:
        if i.get("fmaMatch"):
            u[(i["name"], i["fmaUnsided"])] = i["fmaMatch"]
    print(f"  distinct (name, concept) pairs: {len(u)};", ", ".join(f"{k} {v}" for k, v in Counter(u.values()).most_common()))
print("lateralised exported items carrying an unsided FMA id (fmaIsUnsided):",
      dict(Counter(f"{i['kind']}/{i['tissue']}" for i in items if i.get("fmaIsUnsided") and not i.get("candidate"))))
if "--list" in sys.argv:
    seen = set()
    for i in items:
        k = (i["name"], i.get("fmaUnsided"))
        if i.get("fmaMatch") in ("synonym", "singular-class-for-set", "curated-equivalent") and k not in seen:
            seen.add(k)
            print(f"{'cand' if i.get('candidate') else 'exp '}\t{i['fmaMatch']}\t{i['fmaSource']}\t{i['name']}\t{i['fmaUnsided']}\t{i['fmaUnsidedLabel']}")
if "--diff" in sys.argv:
    old = {i["id"]: i for i in json.load(open(sys.argv[sys.argv.index("--diff") + 1]))["items"]}
    new = {i["id"]: i for i in items}
    print(f"ids: {len(old)} before, {len(new)} after, removed {len(set(old) - set(new))}, added {len(set(new) - set(old))}")
    seen = set()
    for k, n in new.items():
        o = old.get(k)
        if o and (o.get("fma") != n.get("fma") or o["name"] != n["name"]):
            key = (n["name"], o.get("fmaUnsided"), n.get("fmaUnsided"))
            if key in seen:
                continue
            seen.add(key)
            print(f"  {'cand' if n.get('candidate') else 'exp '} {n['source'][:1]} {o['name']}: {o.get('fmaUnsided')} '{o.get('fmaLabel')}' -> "
                  f"{n.get('fmaUnsided')} '{n.get('fmaUnsidedLabel')}'" + (f"  (renamed '{n['name']}')" if o["name"] != n["name"] else ""))
