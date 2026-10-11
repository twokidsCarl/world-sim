# Z-Anatomy assessment for soma

Date: 2026-10-11. Scope: can Z-Anatomy fill BodyParts3D 4.0 gaps (nerves first)?

**Bottom line.** Yes, and without the Blender app. The official `bpy` wheel (4.2.23, CPython 3.11
fetched by `uv`) opens the `.blend` and exports every object with modifiers applied and curves
turned into tubes. Z-Anatomy has 249 peripheral/cranial nerve curve objects (126 names), including
brachial, lumbar and sacral plexus branches down to digital nerves. It is **not** in the BodyParts3D
frame: the body was shifted about 10 cm and re-posed region by region, so nerves need a bone-driven
warp (tested: about 1.5 mm on held-out bones, 2.7 mm median on held-out muscles). Licence is
CC BY-SA 4.0, so whatever we derive from it must be offered under BY-SA.

## What was actually done vs. only read

| Item | Status |
|---|---|
| `Z-Anatomy/Models-of-human-anatomy` @ `26507ed` (`Z-Anatomy.zip` → `Startup.blend`, 307 MB, saved by Blender 3.5.10, dated 2023-05-02) | downloaded, opened with `bpy`, fully inventoried and exported |
| `TA2.csv`, `License.txt`, `Readme.md`, `TO DO List` from the same repo | downloaded and read |
| `Z-Biomechanics.7z` (rigged variant: 1,424 meshes, 3 armatures, no curve objects) | opened, counts only |
| Frame comparison and registration test against `data/raw/bodyparts3d/isa_BP3D_4.0_obj_99` | run, numbers below |
| Name → FMA mapping against BP3D lists and Wikidata dumps | run, numbers below |
| `LluisV/Z-Anatomy` (Unity app) FBX files | file tree and licence read; FBX **not** downloaded or parsed |
| Sketchfab `Z-Anatomy` account | search API listing only |
| z-anatomy.com | JS-only WebGL app, nothing readable; the licence Google Doc could not be fetched |
| Alternatives (section 7) | web pages / one API call each, no data downloaded |

## 1. Distribution and formats

- GitHub user `Z-Anatomy` has three repos: `Models-of-human-anatomy` (`The-blend` redirects here),
  `Blender-addons` (GPL-3.0), `Models-of-veterinary-anatomy`. No GitHub releases on any of them.
- The human repo ships only Blender application templates: `Z-Anatomy.zip` (87 MB) and
  `Z-Biomechanics.7z` (22 MB), plus `TA2.csv`. No OBJ/GLB/USD.
- FBX exports per system exist in the Unity app repo, `LluisV/Z-Anatomy` branch `PC-Version`,
  `Resources/Models/FBX/` (9 files, 233 MB; `NervousSystem100.fbx` 54 MB, last touched 2023-03).
  Its README also links a Google Drive folder with `.blend` files.
- Sketchfab account `Z-Anatomy` lists downloadable CC BY-SA models per system (Neurology, Angiology,
  Myology, Arthrology, Splanchnology, Muscular insertions).

**Reading the .blend without Blender: works.** No need for the low-level parsers.

- `bpy` on PyPI: 4.2–5.0 need CPython 3.11, 5.1–5.2 need 3.13. No 3.14 wheel. macOS arm64 wheels
  exist for all of these except 4.5.0.
- `uv` 0.13.0 is at `/opt/homebrew/bin/uv`. Setup used (no sudo, no brew):
  ```
  export UV_PYTHON_INSTALL_DIR=$PWD/data/raw/z-anatomy/uv-python
  uv venv --python 3.11 tools/zanatomy/.venv
  uv pip install --python tools/zanatomy/.venv/bin/python "bpy==4.2.23" numpy scipy
  ```
- 4.2 LTS was chosen as the closest LTS to the 3.5 file. The file opens with
  `open_mainfile(..., use_scripts=False)`; the embedded `z-anatomy.py` autoexec script is skipped.
- One defect: reading `FONT` object `.data.body` segfaults in this build. Not needed, label text
  equals the object name.
- One harmless dependency cycle is reported (Oesophagus curve and its profile).
- Modifiers matter and are handled by the depsgraph: 1,311 Solidify, 1,249 Subsurf, 1,076 Hook,
  44 Mirror, 30 Array, 30 Curve, 20 Skin, 8 Boolean, 7 Geometry Nodes. 2,324 of the 3,880 geometry
  objects have none. A raw DNA parser would get the thyroid as half a shell (Mirror + Solidify +
  Subsurf) and nerves as bare control points.
- Export result: 3,880 objects, all non-empty, 5.83 M vertices, 11.5 M triangles, about 40 s.

## 2. Content inventory (from the file)

File totals: 7,184 objects (4,569 mesh, 1,660 text labels, 951 curves), 1,944 collections,
3,839 text datablocks (Wikipedia-derived definitions). Units metres, Z up.

| System collection | Geometry objects | Mesh / curve | Unsided names |
|---|---|---|---|
| 1: Skeletal system | 277 | 277 / 0 | 159 |
| 2: Muscular insertions (origin/insertion patches) | 705 | 705 / 0 | 705 |
| 3: Joints (ligaments, capsules, bursae, discs) | 413 | 413 / 0 | 236 |
| 4: Muscular system (incl. fasciae, retinacula) | 683 | 683 / 0 | 344 |
| 5: Cardiovascular system | 676 | 22 / 654 | 420 |
| 6: Lymphoid organs | 163 | 163 / 0 | 109 |
| 7: Nervous system & Sense organs | 588 | 339 / 249 | 322 |
| 8: Visceral systems | 119 | 75 / 44 | 102 |
| 9: Regions of human body (surface patches) | 256 | 256 / 0 | 129 |

The numbered collections are flat. The anatomical hierarchy lives in a parallel `Bonus collection`
tree (same objects linked again, by system and by body region) and in object parenting to `.g`
group labels (for example `Median nerve.l` → parent `Brachial plexus.g`).

### Nervous system

Nerves are Bezier **curve** objects (822 splines, 4,773 control points in total, median 10 points
per object) with a round bevel of 0.5 mm times a per-point radius. Evaluated, they become tubes of
mostly 0.5–1 mm radius (sciatic up to 6 mm). Branches are extra splines inside the same object.
Full table: `data/raw/z-anatomy/out/nerves.tsv`.

- **Cranial**: I–XII all present, plus ophthalmic, maxillary, mandibular divisions, inferior
  alveolar, lingual, buccal, mental, chorda tympani, nerve to mylohyoid, cochlear, vestibular.
  Vagus has 21 splines and 1.2 m of centreline, so it carries its thoraco-abdominal course.
- **Brachial plexus**: roots (10 splines), superior/middle/inferior trunks, all six divisions,
  posterior cord; dorsal scapular, long thoracic, suprascapular, subclavian, lateral and medial
  pectoral, superior and inferior subscapular, thoracodorsal, axillary, musculocutaneous, median,
  ulnar, radial, medial brachial and antebrachial cutaneous; forearm and hand branches (anterior
  and posterior interosseous, superficial/deep radial and ulnar, palmar and dorsal branches, common
  and proper palmar digital, dorsal digital). Lateral and medial cords exist only as label groups.
- **Lumbar plexus**: iliohypogastric, ilio-inguinal, genitofemoral (+ femoral and genital
  branches), lateral femoral cutaneous, femoral (+ anterior cutaneous, saphenous with infrapatellar
  and medial crural branches), obturator (+ anterior and posterior branches).
- **Sacral plexus**: sciatic, tibial, common/deep/superficial fibular, sural, medial sural
  cutaneous, sural communicating branch, medial and lateral plantar with common and proper plantar
  digital, dorsal cutaneous nerves of foot, posterior femoral cutaneous, pudendal, superior
  gluteal, nerves to piriformis and quadratus femoris.
- **Spinal nerves**: not individual objects. `Anterior root of spinal nerve.l/.r` and
  `Posterior root…` hold 21 splines each, `Intercostal nerves.l/.r` hold 11 splines each,
  `Cauda equina` 12 splines, `Spinal ganglion.l/.r` one mesh per side. Per-level ids (C5, T4, …)
  would have to be assigned by us from spline position.
- **Autonomic**: `Sympathetic trunk`, `Sympathetic nerves` (19 splines), `Ganglia of sympathetic
  trunk`. Nothing else.
- **Missing**: phrenic nerve, all cervical plexus branches (label only), inferior gluteal,
  subcostal, splanchnic nerves, autonomic plexuses, recurrent laryngeal as a named object,
  dermatomes.
- CNS and sense organs (339 meshes): gyri and sulci, nuclei, ventricles, spinal cord tracts,
  eyeball parts, cochlea and semicircular canals, lacrimal apparatus.

### Other gap structures

| Asked about | Found in file |
|---|---|
| Thyroid | `Thyroid gland` (mesh, Mirror+Solidify+Subsurf, 2,600 tris evaluated) |
| Other endocrine | superior and inferior parathyroid, suprarenal, pineal, adeno- and neurohypophysis, pancreas, testis |
| Lymphatic | 163 meshes: about 100 named node groups (cervical, axillary, inguinal, iliac, mesenteric, …), spleen, thymus lobes, palatine tonsil. Nodes are small blobs (around 170–340 tris each). **No lymphatic vessels, no thoracic duct** |
| Lungs | five lobes as separate meshes, pleura, full segmental bronchial tree. No single whole-lung object |
| Liver | `Liver` (12,270 tris) plus eight Couinaud segment objects |
| Abdominal wall | rectus abdominis, external and internal abdominal oblique, transversus abdominis, latissimus dorsi, all present both sides (20–34k tris each) |
| Female | **none**. No uterus, ovary, vagina or breast; only `Mammary region` surface patches. The TO DO list has "CREATE A FEMALE HUMAN MODEL" as a midterm goal |
| Skin, fat | **no skin surface and no fat layer**. Only 256 regional surface patches, hair, nails, and `Infrapatellar fat pad` |
| Ligaments, fascia | 317 ligament meshes, 21 fasciae, 9 retinacula, 38 bursae |

### Naming and ids

- Object names are TA2 **English** terms, British spelling (`Oesophagus`, `Fibular`, `Caecum`).
  No Latin or other languages in the `.blend`; `TA2.csv` (7,314 rows) gives
  `TA2ID;English;Latin;Français;Español;Portugues;Italiano;Parsi`.
- Suffixes: `.l` / `.r` laterality (mesh data shared and mirrored); `.t`, `.s`, `.st` text labels;
  `.g` group label; `.j`, `.i` two-vertex leader lines; `.ol`, `.or`, `.el`, `.er`, `.o2l`, `.e3r`
  … muscle origin/insertion patches. Parentheses mark inconstant structures, `*` non-TA terms.
- **No ontology ids on objects.** Custom properties are only viewer flags (cross-section, shader).
  The TO DO list says "REPLACE ALL THE MESHES' NAMES WITH THE ANATOMICAL ID", not done.

## 3. Coordinate frame vs. BodyParts3D 4.0

Same axes and handedness (Z up, left = +x, anterior = −y), metres instead of millimetres, but
**not the same positions**. 64 name-matched pairs, area-weighted surface centroids:

- Unit change only: median centroid distance 116 mm (bones), surface distance 92 mm.
- Unmodified BP3D meshes survive in the trunk: kidneys, spleen and gallbladder have bbox
  differences of 0.0 mm and an offset of exactly (0, +98.15, +74.78) mm.
- Other regions moved differently. Offset Z-Anatomy − BP3D, mm:

  | Structure | dx | dy | dz | bbox size change (x, y, z) |
  |---|---|---|---|---|
  | Kidney.l | 0.0 | 98.2 | 74.8 | 0, 0, 0 |
  | Frontal bone | 0.5 | 89.7 | 70.4 | −2.9, −1.7, −2.5 |
  | Mandible | 0.7 | 85.0 | 70.5 | −3.1, −2.1, −2.1 |
  | Clavicle.l | 5.9 | 101.2 | 74.8 | 7.6, 10.1, −10.6 |
  | Humerus.l | 6.3 | 103.3 | 63.1 | 3.5, 3.2, 10.3 |
  | Third metacarpal.l | 8.6 | 100.7 | 48.9 | 0.9, 1.3, 2.3 |
  | Sacrum | 0.6 | 87.3 | 53.7 | 5.1, 2.8, −29.3 |
  | Hip bone.l | −4.1 | 85.1 | 49.3 | −10.1, 5.1, 8.5 |
  | Prostate | 0.6 | 95.8 | 38.7 | 1.4, 0.8, 3.1 |
  | Femur.l | −0.3 | 98.1 | 55.5 | −1.7, 15.3, −11.7 |
  | Tibia.l | 1.0 | 112.9 | 69.5 | 4.0, 5.5, −22.0 |
  | Calcaneus.l | 6.7 | 113.8 | 80.9 | −8.2, 5.8, 1.8 |

- One global similarity transform fitted on 45 bone centroids (scale 0.9995, rotation 0.74°,
  translation (0.2, −111.5, −66.9) mm) still leaves a median surface distance of 5.2 mm on bones,
  with p95 up to 24 mm (feet, pelvis, hands).
- Per-bone rigid ICP on 126 matched skeletal objects: displacement std (6.5, 7.2, 11.2) mm,
  rotation median 2.7°, max 22.5°. Residual after the per-bone rigid fit: median 1.04 mm,
  103/126 under 2 mm, worst tibia 4.8, femur 4.1, hip bone 3.7, sacrum 3.2 mm. So most bones are
  BP3D shapes moved rigidly (and symmetrised: `.r` is the exact mirror of `.l`); a few long bones
  and the pelvis were re-sculpted.

**Consequence: Z-Anatomy nerves cannot be dropped straight in.** They need a non-rigid
registration. Tested in `register_test.py`: thin-plate-spline warp driven by 119 bones (60 surface
points each, carrying the per-bone rigid motion).

| Held-out set | Translation only | TPS warp, mean surface distance | p95 |
|---|---|---|---|
| Bones, 5-fold cross-validation | – | median 1.55 mm (p90 2.9, max 5.3) | – |
| Muscles (n=229) | 6.4 mm | median 2.65 mm | 5.7 mm |
| Nervous system meshes also in BP3D (n=76, mostly brain) | 7.2 mm | median 1.47 mm | 3.7 mm |
| Viscera (n=30) | 6.8 mm | median 5.7 mm | 11.9 mm |
| Vessels (n=242) | 9.6 mm | median 8.1 mm | 17.2 mm |

Vessel and viscera numbers are an upper bound on warp error, not a clean measure: Z-Anatomy redrew
vessels as curves and re-sculpted several organs, so shape differences are mixed in. Limb nerves
run along bones and muscles, where the warp is at 2–3 mm. Pelvic and abdominal nerves sit in the
weakest region (prostate and bladder are off by 12–20 mm after the global fit).

## 4. Licence

`License.txt` in `Models-of-human-anatomy`, verbatim:

> All the code and content shared by 'Z-Anatomy' is under Creative Commons Attribution-ShareAlike
> 4.0 International License. […] You must attribute this database in the manner specified by the
> author or licensor when distributing part or whole of this database or any derivative work. You
> must distribute any derivative work based on part or whole of the data from this database under
> the same license.

Required attribution, verbatim:

> "BodyParts3D - The Database Center for Life Science - CC-BY-SA 2.1 Japan"
> "Z-Anatomy - The libre 3D atlas of anatomy - CC-BY-SA 4.0"

Also listed as "used as reference/included and adapted":

> "Brainder" and "White matter" from the University of Washington
> "Cranial Nerves and Foramina - by University of Dundee, CAHID - CC-BY 4.0"
> "Anatomy of the Inner Ear - by University of Dundee School of Medicine - CC-BY-NC-SA 4.0"
> "Kidney - by Lissie Cowley - CC-BY-NC 4.0"

Consequences (not legal advice):

- Any Z-Anatomy geometry we warp, decimate or merge is adapted material and must be distributed
  under CC BY-SA 4.0 with both attribution lines. BP3D (CC BY 4.0 per our `README_e.html`) can flow
  into a BY-SA dataset, not the other way round. Simplest safe position: the combined anatomy
  dataset is BY-SA 4.0. Alternative: ship Z-Anatomy-derived parts as a separate layer with a
  per-part `licence` field and keep the BP3D base under BY.
- No non-commercial clause on Z-Anatomy itself and no trademark terms in the repo. But two inputs
  are **NC-licensed** (inner ear, kidney), which a BY-SA release cannot actually relicense. Avoid
  the inner-ear objects (cochlea, semicircular canals, vestibule, ampullae) and any kidney
  internals; we do not need them. No "Brainder"/"White matter" licence is stated; avoid the brain
  white-matter objects or check first.
- Side note: the BP3D 4.0 OBJ headers in `data/raw/bodyparts3d` still say "CC Attribution-Share
  Alike 2.1 Japan", while the README says CC BY 4.0. Worth settling which one we cite.
- Blender add-ons are GPL-3.0; we use none of that code.

## 5. Provenance of the nerves

The repo states no source for the peripheral nerves. What it does say: authorship "Gauthier KERVYN
(Design, 3D, anatomy)"; cranial nerves had the Dundee "Cranial Nerves and Foramina" model as
reference; the TO DO list still has "LIST AND DESCRIBE THE MODIFICATIONS REQUIRED or validate the
content (by a radiologist?)" open. The geometry confirms hand modelling: Bezier curves with a
handful of control points (median nerve 20 points over 60 cm), uniform schematic calibre, perfect
left/right mirroring. Label them **curated / artist-modelled, not scanned, not expert-validated**.
For comparison, BP3D 4.0 has 36 nerve segments; only 3 of Z-Anatomy's 126 nerve names match a BP3D
concept name.

## 6. Mapping to FMA ids

`map_names.py`, exact match after light normalisation (British spelling, `.l/.r`, roman-numeral
suffixes). Sources: BP3D concept lists (3,432 names), `TA2.csv` (7,192 terms), Wikidata dumps
fetched today (79,093 items with FMA ID P1402, incl. left/right concepts; 4,912 TA2 ID P7173 → FMA
pairs).

| System | Names | BP3D name | In TA2.csv | TA2 → FMA (Wikidata) | Any route |
|---|---|---|---|---|---|
| Skeletal | 159 | 44% | 43% | 41% | 52% |
| Joints | 236 | 3% | 98% | 57% | 61% |
| Muscular | 344 | 44% | 99% | 96% | 97% |
| Cardiovascular | 420 | 45% | 95% | 85% | 90% |
| Lymphoid | 109 | 3% | 100% | 13% | 18% |
| Nervous + sense | 322 | 15% | 92% | 76% | 83% |
| **Nerve curves only** | **126** | **2%** | **99%** | **84%** | **86%** |
| Visceral | 102 | 31% | 100% | 59% | 69% |

- Nerves: 105 of 126 names (83%) get an FMA id only through the TA2 → FMA crosswalk; 18 (14%)
  need manual assignment (trunk divisions of mandibular nerve, "muscular branches of …", some
  digital branches, `Sympathetic nerves`).
- Laterality: our key is per-side FMA ids. Of 124 sided nerve names only 53 have "left X" /
  "right X" labels in Wikidata. The rest need the FMA OWL release itself, or the unsided FMA id
  plus a `side` field.
- Open crosswalks that exist: Wikidata P7173 (TA2), P1323 (TA98), P1402 (FMA), CC0. FMA's own TA
  annotations were not checked.
- Lymph nodes map poorly (18%); mostly plural group terms that need manual FMA lookup.

## 7. Alternatives for nerve geometry

- **AnatomyTool Open3DModel** (Leiden, Utrecht, Maastricht, Leuven; built on Z-Anatomy): CC BY-SA;
  `.blend`, `.obj`, `.glb` downloads dated July 2025. Page says "All nerves in the upper and lower
  limb were newly modelled" with anatomist review; separate downloads listed for brachial plexus,
  axillary, radial, ulnar, median, musculocutaneous. Best quality upgrade for limb nerves; same
  licence, same frame problem. Not downloaded.
- **Z-Anatomy FBX / Sketchfab**: same content, same licence; only useful if `bpy` were unavailable.
- **HRA / HuBMAP 3D reference objects** (API listing checked: 81 objects, GLB, male and female):
  spinal cord, blood vasculature, lymph node, skin, uterus, ovary, fallopian tube, mammary gland,
  placenta. **No peripheral nerves.** Relevant for the female and skin gaps. Licence not re-read
  today (published as CC BY 4.0).
- **Open Anatomy Project (SPL)**: regional atlases (brain, head and neck, knee, abdomen, liver,
  inner ear, thorax). Only the knee atlas lists nerves. Licence not stated on the index page.
- Visible Human-based segmentations: not checked.

## Recommended route

1. Keep the `bpy` venv. `export.py --systems 7` already yields nerve tubes plus raw centrelines
   and radii (`index.json` → `splines`). Keep the centrelines: the innervation model wants
   polylines and branch topology, and tubes can be regenerated at any calibre.
2. Build the warp from all name-matched bones (per-bone rigid ICP → TPS), as in
   `register_test.py`, after first applying the mm/m and Y-up conversion our pipeline already uses.
   Warp centreline control points, then re-tube. Add muscles as extra control structures in the
   pelvis and abdomen, where bone-only error is highest.
3. Assign FMA ids: TA2.csv name → TA2 id → Wikidata → FMA, then a hand table for the 18 unresolved
   nerve names and for laterality. Split the multi-spline spinal objects (roots, intercostals) into
   per-level parts by position.
4. Same pipeline for thyroid, parathyroids, lymph node groups, lung lobes, liver, abdominal wall
   muscles. For structures another agent is taking from BP3D 3.0, prefer BP3D (BY licence, native
   frame) and use Z-Anatomy only where BP3D has nothing: nerves, thyroid, lymph nodes, ligaments.
5. Mark every imported part `source: z-anatomy`, `provenance: curated`, `licence: CC-BY-SA-4.0`,
   and add both attribution strings to the app credits.
6. Hand-check after warping: brachial plexus through the scalene gap, sciatic through the greater
   sciatic foramen, median nerve in the carpal tunnel, pudendal nerve.

## Blockers and open decisions

- **Licence decision** (owner: project lead): accept BY-SA for the combined dataset, or keep a
  separately licensed layer.
- No Blender app needed. Nothing to install beyond the venv already created.
- Content holes Z-Anatomy does not fill: phrenic nerve, cervical plexus, autonomic plexuses,
  per-level spinal nerves, lymphatic vessels, skin, fat, all female anatomy.
- Pelvic nerve placement will be the least accurate (re-sculpted pelvis and sacrum).

## Files

Scripts (`tools/zanatomy/`): `inventory.py`, `export.py`, `compare_frame.py`, `register_test.py`,
`map_names.py`, `nerves_report.py`. Run with `tools/zanatomy/.venv/bin/python -I <script> …`;
arguments are in each docstring.

Data (`data/raw/z-anatomy/`, 764 MB, gitignored): `repo/` downloads, `extracted/` blend,
`out/inventory.json`, `out/export/{meshes.npz,index.json}`, `out/nerves.tsv`,
`out/frame_compare.json`, `out/register_test.json`, `out/name_map.json`, `wikidata/*.tsv`,
`uv-python/` (CPython 3.11 for the venv). `wikidata/fma_items.tsv` is a truncated first attempt and
is unused.

---

# Addendum (2026-10-11): import package and AnatomyTool Open3DModel

Decision recorded: Z-Anatomy is imported and the whole anatomy dataset is released under
CC BY-SA 4.0. The package for the geometry pipeline is in `data/raw/z-anatomy/out/import/`
(format and field reference in its `README.md`, checks in `validation.txt`).

## Open3DModel, inspected for real

Downloaded `upper-limb`, `lower-limb` and `hand` (`.blend` + `.glb`, 84 MB zipped) from
caskanatomy.info. `upper-limb.blend` and `hand.blend` open with `bpy` 4.2; `lower-limb.blend` was
saved with Blender 5.2 and needs `bpy==5.2.2` on CPython 3.13 (second venv at
`data/raw/z-anatomy/venv-bpy5`). The `.glb` files are Draco-compressed.

- **Content**: upper limb 532 meshes, lower limb 472, hand 225 (a subset of the upper limb).
  Right side only. Objects are parented to empties per region and tissue ("Arm - nerves", …).
  Nerve objects: 50 upper, 65 lower.
- **Geometry**: nerves are meshes, not curves, but they are converted curve tubes (12-vertex
  rings), so centrelines and radii are recoverable exactly. Calibres vary along the nerve
  (median 0.07–1.4 mm, sciatic up to 6.4 mm) and far more branches are modelled: tibial nerve
  26 branches and 2.8 m of centreline against 1 branch and 0.5 m in Z-Anatomy.
- **Nerves Z-Anatomy lacks**: inferior gluteal, nerve to obturator internus, coccygeal nerve,
  lumbosacral trunk, L1–S5 and C5–T1 plexus roots as separate objects, lateral and medial cords,
  lateral/medial roots of the median nerve, posterior brachial cutaneous, lateral sural cutaneous,
  clunial nerves, calcaneal branches, muscular branches of the femoral nerve. 40 of the 115 objects
  have no Z-Anatomy counterpart.
- **Still missing in both**: phrenic nerve, every cervical plexus branch, subcostal, splanchnic
  nerves, autonomic plexuses, laryngeal nerves, the branches of the pudendal nerve,
  intercostobrachial, the C1 spinal nerve, posterior rami, and the named branches of the
  trigeminal divisions. Full list in `validation.txt` section 5.
- **Frame**: same frame as Z-Anatomy (hence the same ~10 cm offset from BodyParts3D 4.0), but
  bones were remodelled: 45 name-matched bones differ from Z-Anatomy by 1.5–2.1 mm median, up to
  5.9 mm (radius, ulna, tibia, humerus). Against BodyParts3D 4.0 its bones fit as well as
  Z-Anatomy's after per-bone rigid ICP (median 0.76 mm; femur, tibia, hip bone, sacrum, humerus
  3–4.5 mm).
- **Naming and ids**: free-form English with abbreviations and typos ("Musculocutaneus nerve",
  "Radial nerve (posterior interosseus n).r", "Lateral femoral cuteneous nerve"). No TA or FMA ids.
  Mapping needed a hand table (`o3d_nerves.tsv`, 115 rows).
- **Licence**: the pages say "open-licensed (Creative Commons Attribute ShareAlike CC BY SA)" and
  "You should follow the requirements of the Creative Commons license if you distribute the
  models"; the link target is by-sa/4.0. No attribution wording is prescribed. Provenance: "All
  nerves in the upper and lower limb were newly modelled", "Each structure was reviewed by one to
  three anatomists". Muscle textures are based on CC BY-NC-SA material (textures not used).

**What was taken**: all 115 nerve objects, each also mirrored to the left (230 items). Where a
Z-Anatomy nerve covers the same structure, the Open3DModel item is marked preferred and the
Z-Anatomy one kept as an alternate. Open3DModel items carry `frame: "o3d"` and get their own bone
anchors, because of the remodelled bones. Its ligaments, bursae, vessels and muscles were not
taken.

## Package contents

| | Count |
|---|---|
| Nerve items (tube mesh + centreline) | 643: 413 Z-Anatomy, 230 Open3DModel |
| … preferred set | 462 (181 Z-Anatomy items superseded, kept as alternates) |
| … units split from multi-spline objects | 177 |
| Mesh parts | 548: 358 ligaments/bursae/fasciae, 160 lymphoid, 5 thyroid/parathyroids, 25 fallback (lungs, pleura, liver, five muscles) |
| Candidates (listed, no geometry) | 1,849, of which 705 muscle origin/insertion patches |
| Anchors | 501: 251 Z-Anatomy bones, 159 unchanged soft tissue, 91 Open3DModel bones |
| Excluded on NC grounds | 14 objects |

FMA coverage of exported items: nerves 603/643 (94%), lymphoid 141/160, ligaments etc. 230/294,
muscular (fasciae + fallback) 72/74, endocrine 5/5. Sided FMA ids exist for 532 of 602 sided
nerve items; the rest carry the unsided id plus `side`. Manual table: 22 Z-Anatomy names (12 with
an id, 10 deliberately null) and 115 Open3DModel rows.

Spinal levels: 177 split units, 150 high confidence, 24 medium, 2 ambiguous (the unassigned
brachial-root branches), 1 not applicable (central cauda equina bundle).

## Not done

- Sympathetic ganglia (18 per side) and `Sympathetic nerves` (19 branches per side) are not split
  by level; no reliable rule.
- 17 nerve names have no FMA id (listed in `validation.txt`).
- Candidates are a list only; nothing was exported for them.
- Open3DModel left side is a mirror copy; BodyParts3D is not symmetric, so the pipeline must
  register each side with its own (mirrored) anchors.

## Addendum 2: FMA mapping audit

Trigger: items whose FMA concept read differently from their name. Cause in almost every case:
the name matched an FMA *synonym* that FMA attaches to a different structure (for example
"Acromioclavicular ligament" is a synonym of the joint capsule), or a bare name matched a class
with an odd preferred label (FMA's plain "Ulnar collateral ligament" is the wrist ligament).

- Every item with an FMA id now carries `fmaMatch` (how name and class relate) and
  `fmaUnsidedLabel`. `tools/zanatomy/audit_fma.py --list` prints all non-preferred-label matches.
- Exported items: 490 preferred-label, 277 synonym, 151 generated-level-label, 119
  curated-equivalent, 14 singular-class-for-set, 1 set-class, 139 without an id. All synonym and
  curated-equivalent pairs (212 distinct name/concept pairs exported, 189 among candidates) were
  read through by hand; near-misses were nulled or corrected in `za_manual_fma.tsv` /
  `o3d_nerves.tsv`. The per-item changes are in `out/import/fma_fix_diff.txt`.
- Lateralised items whose `fma` is the unsided class have `fmaIsUnsided: true` and are listed in
  `out/import/unsided_fma_items.tsv` (174 exported).
- "Anterior cord of brachial nerve plexus" is not mapped to any item. It is FMA's own parent class
  of the lateral and medial cords (FMA65385), so it appears when a tree is built from FMA parents.
- The build now ignores already-merged `ZA…` parts in `anatomy.json`, so it is repeatable after a
  merge.

## Addendum 3: batch 2 (remaining missing structures) and attachment table

- `out/import/` now also holds 745 `batch: 2` items: 104 for structures asked for explicitly
  (`batchGroup: "requested: …"`) and 641 other non-brain candidates the current model lacks by
  FMA id or name (`"extra: …"`). 376 of the extras carry `duplicateRisk: "high"` (vessels,
  bronchi, discs: BodyParts3D names these differently, so absence by name proves little).
- Not available in Z-Anatomy or Open3DModel: pericardium, parietal peritoneum, lymphatic vessels
  and thoracic duct, subcutaneous fat, cranial dura/arachnoid/pia, ligamenta flava, caecum and
  anal canal as separate objects. BodyParts3D 3.0 lists a spinal cord (FMA7647), which would be a
  native alternative to the Z-Anatomy cord surface.
- Z-Anatomy's "Pleura" is four concentric offsets of one lung-shaped surface per side; the
  parietal layer therefore follows the lung, not the chest wall.
- `attachments.json`: 705 origin/insertion patches of 167 muscle names, tested against
  Z-Anatomy's own bones (697 lie on bone). Against `muscle-gaps.json` (59 groups lacking origin
  and/or insertion): 3 fully and 12 partly covered by the muscle's own patches, 16 more only by
  the whole muscle's patches, 28 not covered.
- The surface regions are TA body regions and auricle/face landmarks. None is a dermatome or a
  cutaneous nerve territory.
