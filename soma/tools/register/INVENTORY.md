# Female anchor data: inventory and feasibility

Date: 2026-10-11. Machine: Apple M4 Max, 64 GB, macOS. Everything in sections 1–3 marked **[inspected]** was downloaded and
opened here; **[read only]** means web pages / papers only (mostly gathered by a research sub-agent; quotes are
near-verbatim page-reader output — re-check the exact wording before pasting into an attribution file).

## Verdict

The registration plan is feasible with open data, but not the way the leads suggested.

- **HRA is not a skeleton/skin anchor.** It is a clean, artist-remodelled, A-posed model with excellent female
  reproductive organs and breasts, but only ~40 bone objects (spine, sacrum, coccyx, ilium, sternum, leg long bones):
  no skull, ribs, shoulder girdle, arms, hands, feet, **and no pubis or ischium in the female pelvis**. Two muscles.
- **The Visible Human Female CT is the real anchor.** It is public, whole-body head-to-toe at 1 mm, and on this machine
  TotalSegmentator (free tasks) + MOOSE `clin_ct_peripheral_bones` (CC BY 4.0 weights) produced a complete female
  skeleton, skin, 20+ organs, major vessels and ~45 muscle groups in about 25 minutes.
- HRA bones are the same individual as the CT (femur 421 vs 423 mm, tibia 343 vs 348 mm), so HRA organs can be carried
  into the CT frame through the bones both have.
- The subject is a poor "reference female": 59 y, BMI ≈ 36, **six lumbar vertebrae**, supine cadaver with hands resting
  on the pelvis, and no upper teeth detected. That is the main risk, not data availability.

## What is on disk

`data/raw/female/` totals **6.7 GB** (budget 15 GB). Source data proper is ~1.1 GB; the rest is model weights and a second venv.

| Path (under `data/raw/female/`) | Size | Content |
|---|---|---|
| `hra/3d-vh-f-united.glb`, `3d-vh-m-united.glb` | 375 MB, 242 MB | HRA united female / male, v1.10 |
| `hra/` other | ~30 MB | `crosswalk.united-female.csv`, `united-female.graph.json`, `reference-organs.json`, `catalog.jsonld`, `uberon-simple.obo` |
| `vhf/normalCT/` | 441 MB | 1,734 `c_vfNNNN.fre.Z` CT slices |
| `vhf/normalCTHeaders/` | 34 MB | 1,734 text header dumps |
| `vhf/` other | ~2 MB | NLM READMEs, INDEX, terms page |
| `vhf/derived/` | 921 MB | assembled NIfTI, label maps, meshes (regenerable) |
| `totalseg_home/` | 3.0 GB | TotalSegmentator weights (set via `TOTALSEG_HOME_DIR`, not `~/.totalsegmentator`) |
| `venv-moose/` | 1.7 GB | separate venv for MOOSE incl. its weights |
| `totalseg_dataset/` | 164 KB | `meta.csv` + candidate table only (no images fetched) |

`tools/register/.venv` (Python 3.12, 1.7 GB) and `tools/register/out/` (TSVs + preview PNGs, 2.4 MB) are outside `data/raw`.
Note `.gitignore` covers `.venv/` and `data/raw/`, but **not** `tools/register/out/`.

---

## 1. HRA 3D reference organs **[inspected]**

- **Fetched from:** `https://cdn.humanatlas.io/digital-objects/ref-organ/united-female/latest/assets/3d-vh-f-united.glb`
  (male: `.../united-male/latest/assets/3d-vh-m-united.glb`). Per-organ GLBs are listed by
  `https://apps.humanatlas.io/api/v1/reference-organs` (45 female, 36 male entries); node → ontology table at
  `.../united-female/latest/assets/crosswalk.csv`.
- **Licence:** CC BY 4.0. `graph.json` metadata: `"license": "https://creativecommons.org/licenses/by/4.0/"`, publisher HuBMAP,
  version v1.10, created 2026-06-09. Redistribution in a public web app: **yes, with attribution**.
- **Format:** glTF 2.0 binary, exported from Maya (`babylon.js glTF exporter for Autodesk MAYA`). No textures, skins or animations.
- **Frame and units:** **metres**, Y up, +X = patient left, +Z = anterior, origin near the body centre. All organs sit in one
  common whole-body frame under a single root (`VH_F`). No node transforms on the root.
- **Size:** female 956 meshes, 7.76 M triangles; male 918 meshes, 6.88 M triangles.
- **Naming:** `VH_F_<structure>[_L|_R]`, grouped by system. Crosswalk has 874 rows: 546 UBERON ids, 328 FMA ids.
  214 mesh nodes (mostly the 283-node Allen brain) have no crosswalk row.

| Category | Female content | Usable as anchor? |
|---|---|---|
| Skin | 1 mesh, 267 k triangles, 1.658 m tall, 0.96 m wide (arms abducted, A-pose) | Yes as a display skin; it is a remodelled surface, not the scan |
| Skeleton | C1–C7, T1–T12, **L1–L6**, sacrum, coccyx, ilium L/R (compact + spongy), sternum, manubrium, femur/tibia/fibula/patella L/R, discs | Partial. **Missing: skull, mandible, ribs, clavicle, scapula, humerus, radius, ulna, hands, feet, pubis, ischium** |
| Muscles | 12 extra-ocular, rectus femoris L/R (+ quadriceps tendon) | No |
| Vessels | 110 nodes: aorta, venae cavae, coronary, hepatic, portal, mesenteric, renal, iliac veins, **uterine arteries/veins** | Trunk only; nothing in the limbs |
| Organs | heart (14), lungs (27) + bronchial tree (36), liver (26), kidneys/ureters (81), bladder, spleen, pancreas, small intestine, colon, larynx, trachea, thymus, eyes, spinal cord, brain | Yes. **No stomach, no oesophagus** |
| Female-specific | uterus (10 parts incl. cervix), ovaries, uterine tubes (4 parts each), **vagina**, 16 ligaments (broad, round, cardinal, uterosacral, …), mammary glands (8 parts each side) | **Yes — this is the main value of HRA** |
| To exclude | full-term **placenta** (8 nodes) is in the united file | — |

- **Male set:** exists, same conventions and export. 802 of 956 female node names also occur in the male file, so
  HRA male ↔ HRA female correspondences are easy. But it is a different person in the same *convention*, not a shared
  coordinate frame, and it has the same skeleton gaps (its pelvis does include pubis and ischium).
- **Quality:** smooth, clean, web-ready topology. Clearly sculpted from the Visible Human rather than raw segmentation.
- **Correspondence to BodyParts3D** (`out/hra_f_to_bp3d.tsv`): 266 of 956 mesh nodes match, hitting 236 distinct BP3D
  concepts (115 by FMA id, 149 by UBERON→FMA xref, 2 by name). By system: circulatory 89/124, skeletal 50/81,
  nervous 49/362, respiratory 29/70, digestive 22/84, muscular 14/16, lower limb 8/52, reproductive 0/46 (expected:
  BP3D is male).

## 2. Visible Human Female CT **[inspected]**

- **Fetched from:** `https://data.lhncbc.nlm.nih.gov/public/Visible-Human/Female-Images/radiological/normalCT/`
  (`c_vf1001.fre.Z` … `c_vf2734.fre.Z`) and `.../normalCTHeaders/` (`c_vfNNNN.txt`). No login, no agreement form.
- **Licence:** not a named open licence. The directory README says: "Image data usage is approved in accordance with the
  conditions as stated in the NLM Terms and Conditions at https://www.nlm.nih.gov/databases/download/terms_and_conditions.html".
  That page (last reviewed 2019-05-21) requires users to "acknowledge NLM as the source of the data by including the phrase
  'Courtesy of the U.S. National Library of Medicine' in a clear and conspicuous manner" and "not indicate or imply that NLM
  has endorsed its products/services/applications"; redistributors must keep data current or say it may not be.
  The older per-directory README still mentions "the written license agreement" — stale text.
  Redistribution of derived meshes: **yes, with that attribution line**. I did not find a statement about public-domain status.
- **Format:** per-slice GE Genesis, 3,416-byte header + 512×512 big-endian int16, unix `.Z` compressed. `gzip -dc` reads it.
  HU = stored value − 1024. A PNG conversion exists under `Female-Images/PNG_format/radiological/` (not fetched).
  I found no official NIfTI/DICOM; the Denver dataset (section 4) ships an aligned CT DICOM.
- **Coverage:** **whole body, vertex to toes, including both arms and hands.** 1,734 slices at 1 mm = 1.734 m
  (feet plantar-flexed). Acquired 1993-09-22, fresh ("normal") cadaver — there is no frozen CT for the female. Subject 59 y.
- **Resolution:** 1 mm slices; in-plane 0.49 mm (head, FOV 250), 0.72/0.86 mm (neck), 0.94 mm (trunk, FOV 480),
  0.72 mm (legs, FOV 370). Assembled here to 480×480×1734 at 1 mm isotropic, RAS, 177 MB.

Problems found while assembling (`vhf_ct_to_nifti.py`, `out/vhf_ct_slices.tsv`):

| Issue | Detail | Consequence |
|---|---|---|
| Two exams | 370 (head-first, head → mid-thigh, files 1001–1985) and 371 (feet-first, "FEMUR-TOES", 1986–2734) with different table landmarks | Header table position is unusable as global z; I stack by file number |
| Bad headers | 131 slices carry a bogus location (file 1448, and 2236–2365 all say 3.0 mm) | Same; pixel size/FOV in those headers look right |
| Seam at mid-thigh | Femur cortex centres jump by 4.8–5.7 mm lateral and 2.9–4.6 mm AP between files 1986 and 1985 | **Fixed** in the anchor build: rigid in-plane move of the leg exam (0.42° + 5.3/−3.8 mm); bone residual 0.09 mm, skin 0.75 mm |
| FOV clipping | Body is 468–478 mm wide in a 480 mm FOV. **Both** elbows touch the reconstruction circle: left humerus/radius/ulna on 20–36 % of their slices, right on 28–44 %; the right ulna is cut lengthwise (25 mL vs 50 mL left) | Arm skin truncated; left elbow shaved, right proximal forearm unusable |
| Leg FOV | 370 mm FOV below mid-thigh | Fine for bones; whether thigh skin is clipped there was not checked |
| Pose | Supine, arms at sides with hands lying on the lower abdomen/pelvis; soft tissue and breasts flattened by gravity | Skin and arm pose differ from BodyParts3D and from HRA |

Laterality was checked: liver, right kidney and right femur all land at +x (patient right) in both exams.

### Segmentation experiment (real run on the full volume)

| Tool | Version | Result |
|---|---|---|
| TotalSegmentator | 2.18.0, torch 2.14.1, MPS | Installs and runs under Python 3.12 via `uv`. Python 3.14 not attempted. |
| `total` | 117 classes | 730 s wall, **30 GB peak RAM**, 114/117 present (absent: prostate, 2× kidney cyst) |
| `body`, `abdominal_muscles`, `headneck_bones_vessels`, `headneck_muscles`, `breasts`, `craniofacial_structures` | free tasks | 2–6 min each, all classes present except `teeth_upper` |
| MOOSE `clin_ct_peripheral_bones` | moosez 3.2.2, MPS | 243 s, 31/31 classes present |

Marching cubes on σ = 0.8-voxel smoothed masks (`labels_to_meshes.py`) gives 7.3 M triangles for `total` before decimation.
Per-label volumes, triangle counts, component counts and border flags are in `out/vhf_*_meshes.tsv`;
pictures in `out/preview/` (`vhf_mip_coronal.png`, `vhf_skeleton_ts_plus_moose.png`, `vhf_ts_meshes.png`).

| Category | Obtained from the VHF CT | Quality |
|---|---|---|
| Skeleton | skull, mandible, C1–L5 + S1 + sacrum, 24 ribs, sternum, costal cartilages, clavicles, scapulae, humeri, hips, femora (TS); patella, tibia, fibula, radius, ulna each side, plus **grouped** carpals, metacarpals, fingers, tarsals, metatarsals, toes (MOOSE); hyoid, thyroid and cricoid cartilage | Good: long bones are single clean components. See caveats below |
| Skin | whole-body surface (`body` task) | Complete but arms fused to trunk, hands fused to pelvis, laterally clipped |
| Organs | brain, lungs (5 lobes), heart, liver, spleen, kidneys, adrenals, pancreas, gallbladder, stomach, oesophagus, duodenum, small bowel, colon, bladder, thyroid, trachea, spinal cord | Plausible volumes; lungs, heart, oesophagus and trachea are fragmented (post-mortem collapse) |
| Vessels | aorta, SVC, IVC, portal/splenic, pulmonary vein, brachiocephalic, subclavian, common carotid, iliac arteries and veins, internal carotid, internal jugular | Unenhanced cadaver CT: trunks only |
| Muscles | gluteus max/med/min, iliopsoas, autochthon (TS total); pectoralis major, rectus abdominis, serratus anterior, latissimus dorsi, trapezius, external/internal oblique, erector spinae, transversospinalis, psoas major, quadratus lumborum; SCM, scalenes, levator scapulae, platysma and others | Usable as coarse anchors; external oblique is 20+ fragments |
| Female-specific | `breast` (one label, 1.9 L, both sides, flattened) | **No uterus/ovary/vagina class exists in any free CT model I found** |

Caveats that matter for registration:

1. **Lumbar labels are wrong.** The subject has six lumbar vertebrae (HRA models L1–L6). TotalSegmentator's five-lumbar
   scheme yields an 84 mm "L1" and an "L2" spanning 171 mm; its `sacrum` has 43 components. **Fixed** in the anchor
   build (`fix_volume.py`): discs located from the endplates, L1–L6 reassigned by watershed, S1 merged into the sacrum.
   The male has five lumbar vertebrae; female L2–L6 map to male L1–L5 and female L1 has no counterpart.
2. **Hand and foot bones are groups, not bones.** BodyParts3D has every carpal, tarsal and phalanx separately.
3. TotalSegmentator's humerus and MOOSE's ulna overlap by 1.8 mL at the left elbow (two models, one joint); the anchor
   build gives such voxels to MOOSE.
4. **Plain thresholding does not solve (2)** (`limb_bones_threshold.py`): HU > 220 gives one fused blob per lower
   leg + foot (≈ 370 mL) and per forearm + hand; only the patellae separate.
5. `TotalSegmentator` sends anonymous usage statistics by default; it ran that way here (7 predictions).

### Segmentation model licences

| Model / task | Licence | Notes |
|---|---|---|
| TotalSegmentator code and open tasks (`total`, `body`, `abdominal_muscles`, `headneck_*`, `breasts`, `craniofacial_structures`, `teeth`, `vertebrae_body`, `liver_segments`, …) | Apache-2.0, "Openly available for any usage" | `totalseg_info --list-tasks` marks these `LICENSE no` |
| TotalSegmentator `appendicular_bones`, `tissue_types`, `thigh_shoulder_muscles`, `heartchambers_highres`, `face`, `brain_structures`, `coronary_arteries`, … | Licence key required; free only for non-commercial use | **Not used.** `appendicular_bones` is the one that would have mattered |
| MOOSE 3.2.2 | Code Apache-2.0, "Model License: CC BY 4.0" (package README badge) | Sub-agent notes part of its training data is CC BY-NC; the stated weight licence is CC BY |

## 3. TotalSegmentator training dataset **[metadata inspected, images not fetched]**

- **Source:** Zenodo record 10047292, `Totalsegmentator_dataset_v201.zip` (23.6 GB), CC BY 4.0. `meta.csv` and each
  candidate's NIfTI header were read through HTTP range requests (`ts_dataset_female_candidates.py`).
- 1,228 scans, 510 female, all resampled to 1.5 mm. Table in `out/ts_dataset_female_candidates.tsv`.
- **No head-to-toe female scan exists in it.** Longest female z-extent is 990 mm (s0933, 55 y, polytrauma with bleeding).
  The best healthy candidates are **s0790 (40 y, 807 mm, no pathology)** and **s1159 (47 y, 806 mm, no pathology)** —
  roughly skull base to mid-thigh.
- Use: a younger, living, non-obese torso + pelvis with ground-truth labels, as a shape sanity check or a second anchor
  for the trunk. Not a replacement for the VHF. `--fetch s0790` pulls one subject (~55 MB + masks).

## 4. Alternatives

### University of Denver VHF lower extremity **[inspected; imported into the anchor package]**

- `https://digitalcommons.du.edu/visiblehuman/1` (DOI 10.56902/COB.vh.2022.1), "Final 3D STL Models" archive, fetched by hand
  (Cloudflare blocks `curl`). README: "free to use under the Creative Commons Attribution 4.0 license"; cite Andreassen
  et al., *Sci Data* 10, 34 (2023).
- 128 STL files, millimetres, cryosection frame: 76 muscles, 28 bones, 16 cartilages, 8 knee ligaments.
- **Not in this archive**, contrary to the dataset description: the two fat components (so no cryosection skin),
  and menisci. The hip bone is one mesh (no separate pubis / ischium / ilium); metatarsals and phalanges are one mesh
  per foot. The fat masks exist only in the multi-gigabyte segmentation archives.
- Same donor confirmed: per-bone rigid fits to the CT bones at 0.6–1.8 mm RMS (3.2 mm for the seven tarsals moved as one
  block); the posture differs by 1–2° at hip and knee between cryosectioning and CT.

### Everything else **[read only]**

| Source | Licence as found | Female geometry | Usable? |
|---|---|---|---|
| Z-Anatomy | CC BY-SA 4.0 | None found; repo describes a "Human male model", two open issues ask for a female one. `.blend` not opened | No (male only) |
| SMPL, SMPL-X, STAR, SKEL, OSSO, HIT, SUPR | MPI licence: "non-commercial scientific research, non-commercial education…"; "shall not be copied, shared, distributed…" | Parametric skin / skeleton | **No** — the no-distribution clause rules out shipping meshes |
| BASH | Code Apache-2.0, depends on SCAPE data obtained separately | — | No |
| MakeHuman / MPFB2; Anny (NAVER) | CC0 assets; Anny code Apache-2.0 | Parametric female skin + rig, no anatomy | Yes, as a neutral-posed skin target only |
| Visible Korean (Ajou) | No formal licence; free download, commercial users "have to notify the authors" | Whole female body and female pelvis surface models as **3D PDF** | Only with written permission |
| Chinese Visible Human | No public distribution found | — | No |
| AustinWoman | Non-commercial, password on request (page unreachable; from search snippets) | VHF voxel model | No |
| VHP-Female (NEVA), IT'IS Ella, XCAT | Commercial / licence agreement | — | No |
| ICRP 110 adult female | ICRP copyright, 1.8×1.8×4.8 mm voxels | — | No |
| NMDID | DUA forbids derivative works and redistribution | Whole-body post-mortem CT | No |
| Healthy-Total-Body-CTs (TCIA, uEXPLORER) | Images restricted; **segmentations CC BY 4.0** | Automatic label maps, 2.3 mm slices | Maybe, as coarse healthy-skeleton shape reference |
| autoPET, CADS, ENHANCE.PET | Mixed (CC BY / CC BY-NC per site) | Skull base to mid-thigh or head to knee | Not head-to-toe |
| CTPelvic1K | CC BY 4.0 | Pelvis CT + bone masks; sex labels unverified | Possible pelvis shape prior |
| BMFToolkit (Zenodo 889060) | "Other (Open)", licence file unverified | VHF lower-body bones | Redundant with Denver |
| Skellytour, VISTA3D, CADS-model | Various | No distal limb bones | No added value |
| BodyParts3D-derived female model | — | None found | — |

---

## Recommendation

### Anchor set

| Role | Source | Label |
|---|---|---|
| Skeleton, complete | VHF CT → TotalSegmentator `total` + `craniofacial_structures` + `headneck_bones_vessels` + MOOSE peripheral bones | scanned |
| Organs shared with the male, trunk vessels, muscle groups | Same CT, TotalSegmentator free tasks | scanned (anchors); fine structures warped |
| Uterus, ovaries, tubes, vagina, pelvic ligaments, uterine vessels, breasts | HRA united female, rigidly + non-rigidly fitted into the CT frame via shared bones (25 vertebrae, sacrum, coccyx, ilia, sternum, femur/tibia/fibula/patella) and bladder/kidneys | curated (HRA is modelled, not scanned) |
| Pelvis + leg muscles, individual tarsals, knee ligaments and cartilage | Denver VHF STLs (imported; no pubis/ischium split, no fat) | scanned |
| Skin | Decide: CT `body` surface (true but supine, clipped, hands fused) vs. HRA skin (clean A-pose, same person, remodelled) | scanned vs. curated |

All three female sources are the **same donor**, which is what makes this combination work: bone-to-bone alignment
between them is close to rigid per bone.

### Correspondences to the BodyParts3D male

BodyParts3D is millimetres, Z up, +X = patient **left**, +Y = **posterior**, arms straight at the sides.
The CT NIfTI is RAS (flip X and Y); HRA is metres, Y up.

| Set | Matched to a BP3D concept | Gaps |
|---|---|---|
| TotalSegmentator `total` (117) | 106 exact + 4 composite (small bowel, iliopsoas, portal+splenic, …) | thyroid, left atrial appendage, `autochthon`, S1, kidney cysts |
| MOOSE / appendicular bones | patella, tibia, fibula, radius, ulna each side exact; carpal/tarsal/metacarpal/metatarsal as groups | phalanges only as groups |
| `abdominal_muscles` (22) | 8 by name (pectoralis major, serratus anterior, external oblique, psoas major) | rectus abdominis, latissimus dorsi, internal oblique, quadratus lumborum, erector spinae not found by name in BP3D |
| `headneck_muscles` (23) | 11 | scalenes, trapezius (BP3D splits it into parts), prevertebral |
| HRA female (956 nodes) | 266 nodes → 236 concepts | see section 1 |

Matching is by name / FMA id only (`correspond_ts_bp3d.py`, `correspond_hra_bp3d.py`); the "not found" muscle names
need a manual look at BP3D's naming before concluding they are absent. Net: about **70 individual bones plus
12 bone groups, ~20 organs, ~15 vessel trunks and ~25 muscle groups** exist on both sides — enough to drive a
whole-body deformation, densest in the trunk and weakest in forearms, hands, lower legs and feet (bone only).

### What must be warped or curated

- **Warped from male:** all individual muscles except where Denver supplies them, all limb vessels and most trunk
  branches, nerves, individual carpals/tarsals/phalanges (fit the male bones into the female group masks), ligaments,
  fasciae, small glands.
- **Curated:** female reproductive organs and breasts placed from HRA; vertebra identities L1–L6/sacrum; the mid-thigh
  seam; the truncated right forearm; removal of male-only structures (prostate, seminal vesicles, testes, penis) and of
  the HRA placenta; female perineum and external genitalia (**no source found**); female urethra.
- **Not obtainable from any open data found:** individually segmented female upper-limb, trunk and head muscles;
  female nerves; female peripheral vessels.

### Risks

1. **Subject is atypical** (59 y, BMI ≈ 36 per the Denver paper, 6 lumbar vertebrae, no upper teeth detected, post-mortem lungs). A deformation
   driven by her skin will make every warped muscle follow an obese outline. Option: drive the warp with bones and
   organs only and treat skin separately, or normalise with a second, healthier torso (TS dataset s0790).
2. **Three different poses** (BP3D arms down; CT hands on pelvis; HRA A-pose). The arms need an articulated
   (per-bone rigid) pre-alignment before any smooth non-rigid warp; a single global TPS will tear the forearms.
3. **Licence mix.** The BodyParts3D OBJ headers say CC BY-SA 2.1 JP (the male model's own source list now gives
   4.0 as CC BY 4.0 and 3.0 as BY-SA 2.1 JP); HRA and Denver are CC BY 4.0; NLM needs its courtesy line; MOOSE weights
   CC BY 4.0. Decision taken: the dataset ships as CC BY-SA 4.0 with per-source attribution, which the anchor
   manifest carries per item. This is my reading, not legal advice.
4. **Automatic labels are unreviewed.** Nothing here was checked by an anatomist; previews look right at the scale of
   whole bones, and that is all I can claim.
5. **Segmentation of an unenhanced cadaver** gives fragmented hollow organs and only the largest vessels.

### Not done

- The male→female registration itself (the anchor package below is its input). Seam correction, lumbar relabelling and
  decimation are done there.
- Visible Human cryosection RGB images (tens of GB, not needed for anchors); Denver fat masks (multi-gigabyte archives).
- `run_inventory.sh` collects the exact commands I ran, but the script as a whole has not been executed end to end.
  `run_anchors.sh` has been (2.5 minutes).

## Anchor package (built 2026-10-11)

`sh tools/register/run_anchors.sh` writes `data/raw/female/out/anchors/` (gitignored): `manifest.json`, `scanned.bin`,
`reposed.bin`, `README.md` (format), `SANITY.md` (all numbers), `preview/`. Metres, +X left, +Y up, +Z anterior.

| | |
|---|---|
| Items | 182 CT (`VF_`) + 128 Denver (`VD_`) + 59 HRA (`HRA_`) = 369; 1.9 M triangles |
| CT items | 74 bones, 12 bone groups, 3 cartilages, 1 tooth group, 24 organs, 18 vessel trunks, 47 muscles, 3 surfaces; 123 good, 52 usable, 7 poor |
| Denver items | 76 muscles, 26 bones + 2 forefoot groups, 16 cartilages, 8 ligaments; scanned pose; each with the bones it follows (`follows`: origin / insertion) |
| HRA items | 38 organ parts, 16 ligaments, 4 uterine vessels, 1 skin (with a per-vertex registration weight) |
| Duplicates | `preferred` / `alternatives` per item. Preferred: Denver's 7 individual tarsals over the CT tarsal group, Denver's gluteals / psoas / iliacus over TotalSegmentator's; CT for every other bone |
| Meshing | marching cubes on a blurred mask, 12 Taubin iterations, quadric decimation, sub-voxel normal offset restoring the voxel volume |
| Seam | CT leg exam moved 0.42° + 5.3/−3.8 mm. Cross-checked with the Denver femur: step at the seam 7–9 mm before, 1.3–1.8 mm after |
| Lumbar | six lumbar bodies confirmed two ways (endplates; HRA L1–L6 fit at 0.8–0.9 mm RMS). Female L2–L6 ↔ male L1–L5, female L1 has no counterpart |
| Bone surfaces | CT label surfaces lie 0.3–1.0 mm outside the CT's own cortical edge, Denver surfaces 0.3–1.1 mm inside it. Not corrected |
| Re-posing | arms only, per-bone rigid transforms; left arm usable, right arm poor (clipped elbow); Denver items are not re-posed here |
| HRA placement | 37 bone pairs, median ICP RMS 0.74 mm; uterus between bladder and rectum; right ovary collides with the scanned right common iliac vein |
| Coverage | 631 of 3,325 male parts named by an anchor (550 before Denver); thigh 38 and leg 36 parts now anchored (4 each before) |

### Skin and fat

- **CT body surface** (`VF_body_surface`): the donor's real skin, supine, arms fused to the trunk, clipped at the flanks.
- **HRA skin** (`HRA_skin`): registered with a whole-skeleton field; arms and hands are left in the HRA A-pose (no HRA
  arm bones) and flagged by vertex weight. It is **not a slim reference**: girth against the CT is 0.90 at mid-calf,
  0.99 at mid-thigh, 0.95 at the hips, 0.91 at the waist. Same obese donor, tidied.
- **Denver outer fat**: not available (see above).
- **Subcutaneous fat from the CT** (median / 90th percentile, mm): calf 12 / 16, thigh 23 / 42, hip 30 / 53,
  abdomen anterior 33 / 81, chest 24 / 38. Adipose tissue is 46 % of body volume. Mass from CT density ≥ 80.7 kg and
  BMI ≥ 29.6 (both lower bounds: the trunk is clipped); the Denver paper states 88 kg and BMI 36.

Proposal for a normal-BMI surface (not applied). Keep the lean envelope (outer surface of muscle and bone, which the CT
and the Denver muscles give directly) and rebuild the skin as lean envelope + a prescribed subcutaneous thickness:

1. Per body region, scale the donor's measured thickness map by one factor so that the regional girth hits a target,
   preserving her own distribution pattern (thicker posteriorly at the calf, anteriorly at the abdomen).
2. Targets: female circumferences (neck, chest, waist, hip, thigh, calf, upper arm, forearm) at her stature for BMI
   about 22, from an open anthropometric survey — ANSUR II (US Army, public release) is the obvious candidate; its
   licence and its fit to a civilian 59-year-old need checking. An alternative reference is subcutaneous thickness
   measured the same way on normal-BMI female CTs from the TotalSegmentator dataset (CC BY 4.0, includes sex and age),
   which would give thickness directly instead of girth.
3. Not addressed by this: visceral fat (the abdominal wall and organs are displaced by it), intramuscular fat
   (her gluteus maximus is 20 % fat density), breast size, and the supine shape. Those need the same decision for
   the lean envelope itself and cannot be derived from one donor.

### Pelvic floor and perineum

None of the three sources contains a female pelvic floor, urethra, perineum or external genitalia:

| Structure | CT tasks | Denver | HRA | Male model |
|---|---|---|---|---|
| Obturator internus / externus, piriformis, gemelli, quadratus femoris | – | yes | – | yes |
| Levator ani parts, coccygeus, external anal sphincter | – | – | – | yes (male, Z-Anatomy) |
| Urethra and sphincters | – | – | bladder neck only | male urethra |
| Perineal muscles, perineal body, clitoris, vestibular bulbs, labia | – | – | – | – |

External references (licences as found; the first two were downloaded and opened, the rest come from a research
sub-agent and are not re-verified):

| Candidate | Licence | Content | Status |
|---|---|---|---|
| Wu et al., *PLoS ONE* 10(8): e0132226 (2015), interactive 3D-PDF of the female pelvic floor, S3 Fig of the correction (doi:10.1371/journal.pone.0140736.s004) | "Creative Commons Attribution License" (PLOS) | Young adult female (Chinese Visible Human specimen CVH5, cryosections, remodelled). **Inspected:** 10.4 MB U3D stream with 45 named structures, including pubovisceral and puborectal muscle (two parts each), coccygeal muscle, external and internal anal sphincter, urethral sphincter proper, urethral compressor, urethro-vaginal sphincter, deep and superficial transverse perineal muscle, bulbospongiosus, ischiocavernosus, perineal body, **cavernous body of clitoris, vestibular bulb, Bartholin gland**, vaginal and uterine wall, bladder, rectum, pelvic bone | Best candidate. Geometry not extracted: U3D needs a converter this machine does not have. Scale and frame unknown; pelvic bone and sacrum are in the file, so it can be registered like HRA |
| Routzong et al., Mendeley Data doi:10.17632/75vnsc24wk.1 | CC BY 4.0 (per DataCite) | Mean shape of the levator / coccygeus / perineal / anal sphincter complex from MRI of 48 women, as **one fused surface**. **Inspected:** VTK, 8,327 points, extent 138 × 113 × 91 (millimetre-like; Procrustes-aligned, so scale is not guaranteed) | Shape and position check only; no separate muscles |
| Wu et al., *Clin Anat* 33:275 (2020), female pelvic floor 3D-PDF | CC BY 4.0 per PMC | Same specimen, teaching model | Download blocked by a captcha; same content family as the first row |
| Oklahoma State University "Pelvic Organs from MRI" (Sketchfab) | CC BY 4.0 per Sketchfab | 25-year-old living woman: uterus, tubes, ovaries, vagina, **vulva**, bladder, rectum; no muscles | Not downloaded (login). Only real-data vulva found |
| Clitoris STL (Fillod / Carrefour numérique) on Wikimedia Commons | CC0 per Commons; not confirmed at the original source | Artist-modelled from measurements | Unconfirmed licence |
| Geneva MRI clitoris models (Thingiverse) | mixed: some "Attribution", some NC-SA | MRI of four women | Unconfirmed licence |

Rejected: Wu et al. 2018 *J Anat* (CC BY-NC), UBC and Lyon models (NC), VIVA+ (LGPL, no pelvic floor anatomy),
Open3DAnatomy pelvic floor (male, no download). No public female pelvic MRI with pelvic-floor labels was found.

## Scripts (`tools/register/`)

| Script | Purpose |
|---|---|
| `run_inventory.sh` | All steps in order |
| `inspect_glb.py` | GLB node / triangle / bbox inventory |
| `render_glb_points.py` | Front + side point render of selected GLB nodes |
| `correspond_hra_bp3d.py`, `correspond_ts_bp3d.py` | Ontology / name matching to BodyParts3D |
| `download_vhf_ct.sh`, `vhf_ct_to_nifti.py` | Fetch and assemble the VHF CT |
| `preview_volume.py` | MIP and label quick-looks |
| `labels_to_meshes.py` | Label map → per-structure meshes + stats |
| `limb_bones_threshold.py` | Threshold baseline for distal limb bones (negative result) |
| `ts_dataset_female_candidates.py` | Coverage survey of the TotalSegmentator dataset by range requests |
| `run_anchors.sh` | Anchor package, all steps |
| `fix_volume.py` | Seam correction and six-lumbar relabelling |
| `anchor_spec.py` | Which structures become anchors; male-part regexes; quality overrides |
| `build_meshes.py` | Clean, smooth, decimate, volume-restore each structure |
| `build_package.py`, `anchorlib.py` | Frame, joint centres, re-posing, correspondences, manifest, binaries, previews |
| `hra_place.py` | HRA bones → CT bones, displacement field, organ placement checks |
| `write_reports.py` | `README.md` and `SANITY.md` from the manifest |
| `denver_import.py` | Denver STLs → CT frame (per-bone fits, soft-tissue field), seam and bone-edge checks, origin / insertion bones |
| `fat_thickness.py` | Subcutaneous fat thickness and body composition from the CT |
| `pelvic_floor_refs.py` | Fetches and lists the two pelvic-floor reference candidates (not part of the package) |
