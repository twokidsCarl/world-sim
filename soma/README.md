# soma

三维人体解剖浏览器，面向医学生。world-sim 阶梯上的 L4：器官怎么合成一个活着的整体。

长期目标是外科训练用的模拟人：解剖结构在医学上可信，组织有物理性质，身体对疼痛有反应。现在完成的是第一步——把一个完整的人体拆成三千多个可以单独查看的部件，并标出它们之间的关系。

> 仅供教学使用，不是临床依据。几何来自公开数据集，源数据自身声明仍含错误；中文名称、功能关系和体表图都还没有经过医学专业人员审校。

[English version below](#english)

## 现在能做什么

- 男女两个体型。男性 3,332 个独立部件：骨、肌肉、血管段、器官、神经、韧带、淋巴结、皮下脂肪，按系统分组；女性 3,366 个（见下文，精度低得多）。
- 按系统显示或隐藏、调透明度；从皮肤到骨骼逐层剥离。
- 点选部件，查看中/英/拉丁名、FMA 编号、所属层级、相邻结构。
- 肌肉的起点、止点、神经支配、血供等关系，每条带出处，可点击跳转；神经列出它支配的结构，可一次全选。
- 体表图：皮节（31 区）和皮神经分布区（49 区）画在皮肤上，可以从皮肤区域跳到支配它的神经，也可以反过来。
- 每个部件标明几何的来源和许可，可按来源着色或筛选，一眼分清哪些是实测、哪些是推算或手绘。
- 隔离、只看相邻结构、爆炸视图、任意轴向剖切。
- 两棵层级树（分类 is-a、结构 part-of）和按名称或编号搜索。
- 男女切换保留视角和选中的结构；对照视图把两个体型的同一系统并排显示，视角联动。
- 每个体型带一份"使用前请注意"，首次加载时显示。

## 运行

需要 [Bun](https://bun.sh)。

```sh
bun install
bun run dev        # http://localhost:5183
```

仓库里已经带了生成好的解剖数据（`public/anatomy/`），克隆后可以直接看。地址参数：`?body=male`（默认）或 `?body=female`、`?renderer=webgl`（强制用 WebGL2 后端）。

## 测试

```sh
bunx vitest run    # 管线、知识层、体表图、图查询、显示规则
bunx tsc --noEmit
```

针对生成数据的测试检查的是不变量和解剖事实：每个部件恰好出现在一个 GLB 里，邻接关系对称，左股骨在身体左侧；18 项神经解剖标志（尺神经过内上髁后方、坐骨神经出梨状肌下孔、腓总神经绕腓骨颈等）；关键感觉点落在自己的皮节里；子宫在膀胱与直肠之间。

## 结构

```
src/anatomy/types.ts   数据契约：离线工具写，界面读
src/                   界面（React + three.js WebGPURenderer）
tools/pipeline/        几何管线：分类、分层、简化、邻接、配准、推导，输出 GLB
tools/knowledge/       知识层：名称和功能关系，按概念编号对齐
tools/skinmaps/        体表图：皮节与皮神经分布区
tools/zanatomy/        Z-Anatomy 与 Open3DModel 的读取和导入包
tools/register/        女性体型的锚点数据
tools/fixture/         开发用的合成数据集
data/curated/          提交进仓库的精编数据
public/anatomy/        生成的运行时数据
```

几何和知识分开来源：形状和位置只取自体数据重建的网格或由它们推导，名称和关系取自本体库、百科和开放资料。两边靠 FMA（Foundational Model of Anatomy）编号对上。

每个部件带来源标记：`scanned`（源数据原样）、`warped`（经配准变形得到）、`curated`（人工建模，或由本项目从相邻结构推导）。

## 重新生成数据

原始数据不在仓库里（`data/raw/` 被忽略），需要先下载。

```sh
# BodyParts3D 4.0：把 LATEST/ 下的表格和两个 zip 下载到 data/raw/bodyparts3d/ 并解压
#   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/
bun run pipeline                 # 生成 public/anatomy/male/
bun run pipeline:female          # 生成 public/anatomy/female/，需要先有男性输出和女性锚点包（tools/register/run_anchors.sh）
bun tools/knowledge/run.ts       # 名称和关系；加 --refresh 重新查询 Wikidata
bun tools/skinmaps/run.ts male   # 体表图；female 同理
```

顺序有依赖：知识层和体表图读取几何管线的输出，女性体型读取男性体型的输出。

## 数据来源与许可

代码之外，本目录下的解剖数据（`public/anatomy/`、`data/curated/`）整体以 **CC BY-SA 4.0** 发布。

| 来源 | 用在哪里 | 许可 |
|---|---|---|
| [BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html) 4.0 | 男性体型的几何（2,220 个部件）与两棵层级树 | CC BY 4.0（"BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"） |
| BodyParts3D 3.0 | 4.0 里没有的 79 个部件：肺叶、腹壁肌、背阔肌、咀嚼肌和表情肌。经配准变形，标记为 `warped` | CC BY-SA 2.1 JP |
| [Z-Anatomy](https://github.com/Z-Anatomy) | 颅神经和躯干神经、脊神经根、脊髓、韧带、筋膜、关节囊、淋巴结群、甲状腺、腮腺。手工建模，标记为 `curated` | CC BY-SA 4.0（"Z-Anatomy - The libre 3D atlas of anatomy"） |
| [AnatomyTool Open3DModel](https://anatomytool.org/open3dmodel) | 四肢神经（右侧建模，左侧为镜像）、膝关节交叉韧带和半月板。手工建模，标记为 `curated` | CC BY-SA 4.0 |
| soma（推导） | 皮下脂肪、脏胸膜、心包囊：由本项目从相邻结构计算得出，标记为 `curated` | CC BY-SA 4.0 |
| [Visible Human Project](https://www.nlm.nih.gov/research/visible/visible_human.html) 女性 CT | 女性体型的骨骼和部分器官，由 TotalSegmentator 与 MOOSE 分割 | NLM 使用条款；Courtesy of the U.S. National Library of Medicine |
| [HRA](https://humanatlas.io) 女性参考器官 | 子宫、卵巢、输卵管、阴道、盆腔韧带、乳腺。重新建模过的几何，标记为 `curated` | CC BY 4.0 |
| [FMA](http://si.washington.edu/projects/fma) 5.1.0 | 新增部件在分类树里的位置 | 见其发布页 |
| [Wikidata](https://www.wikidata.org) | 名称、功能关系、编号对照 | CC0 |
| [Wikipedia](https://en.wikipedia.org) 肌肉信息框 | 部分肌肉的起止点和神经支配，每条带修订版链接 | CC BY-SA 4.0 |
| ISNCSCI 关键感觉点、Lee 等 2008、Gray 1918 | 体表图的定义依据（只取事实，逐条注明） | 见 `data/curated/skinmaps/` |

名称数据里约三分之二的中文名是按术语表机器生成的，没有出处；`names.json` 的 `zhSource` 字段逐条标明了来源，全部条目的状态都是 `unreviewed`。

## 已知的缺口

完整的清单在每个体型数据的 `cautions` 字段里。主要的几条：

- 神经是手工绘制的示意性几何，粗细不是实测，位置经配准后误差中位数约 2 mm、下肢更大；约五分之一的中心线点被从骨和肌腹里推出过。
- 没有的神经：膈神经、颈丛、肋下神经、内脏神经、自主神经丛、喉神经。
- 没有壁胸膜、淋巴管、黄韧带、颅内脑膜；心包只是心脏的外包络；降结肠包含乙状结肠；脊髓是程序化生成的表面，止于 L2/L3。
- 皮下脂肪是从皮肤内壁和深层结构之间推导出来的，厚度按 3 mm 量化。
- 男性皮肤网格的上臂与胸壁粘连，腋部和臂内侧几乎没有皮肤；体表图的边界有 1–3 厘米的锯齿。体表图是构造出来的教学用图，皮节因人而异，已发表的图互相矛盾。
- 女性体型是一个初版：骨骼是 Visible Human 女性供体自己的（59 岁、肥胖、六节腰椎），86 个部件是实测，其余从男性模型配准变形而来或取自 HRA。
  - 骨与骨之间的软组织位置误差约 1–3 cm；从男性带过去的关节韧带与她的骨对不上。
  - 盆腔里的肠管被整体移开以避让子宫和附件，乙状结肠的位置不是真实解剖；阴道和宫颈与男性的盆底肌重叠。
  - 皮肤是男性皮肤变形来的，只在胸部抬高包住乳腺。
  - 右前臂和右手在 CT 里被裁切，用的是左侧镜像。
  - 没有外生殖器、会阴、女性尿道、卵巢和阴道血管。
- 触屏手势没有在真机上测过。

## 接下来

1. 身体可动：从骨骼几何拟合关节，肌肉和其他组织随骨骼位置变形。
2. 体型可调：身高、比例、胖瘦，依据实测人体测量数据。
3. 改进女性体型：标准体表、盆底、她自己的下肢肌肉和膝关节韧带。
4. 软组织物理：四面体化，XPBD，先在一个部位验证。
5. 疼痛：沿神经通路的伤害感受模型，驱动生命体征、退缩反射和体表热力图。这是对疼痛生理的计算模型，模拟人并没有主观感受。
6. 手术操作：切开、牵拉、出血、缝合。

---

<a id="english"></a>

# soma (English)

A 3D human anatomy browser for medical students. Level L4 on the world-sim ladder: how organs add up to one living body.

The long-term goal is a simulated patient for surgical training: anatomy that is medically credible, tissue with physical properties, a body that responds to pain. What exists now is the first step — a whole body taken apart into more than three thousand parts that can be inspected one by one, with the relations between them.

> For teaching only; not a clinical reference. The geometry comes from public datasets whose own release notes say they still contain errors. Chinese names, functional relations and skin maps have not been reviewed by a medical professional.

## What it does

- Two bodies. Male: 3,332 separate parts — bones, muscles, vessel segments, organs, nerves, ligaments, lymph nodes, subcutaneous fat — grouped by system. Female: 3,366 (far less accurate; see below).
- Show, hide and fade systems; peel layers from skin to skeleton.
- Select a part to see its Chinese / English / Latin names, FMA id, place in the hierarchies and adjacent structures.
- Origin, insertion, innervation, blood supply and other relations, each with its source, clickable; a nerve lists what it supplies and can select all of it at once.
- Skin maps: dermatomes (31 regions) and cutaneous-nerve territories (49 regions) painted on the skin; jump from a skin region to the nerve that supplies it and back.
- Every part states where its geometry came from and under which licence; colour or filter by provenance to tell measured from inferred or drawn.
- Isolate, show neighbours, exploded view, section plane on any axis.
- Two hierarchies (is-a and part-of) and search by name or id.
- Switching between male and female keeps the camera and the selection; the compare view shows one system of both bodies side by side with linked cameras.
- Each body carries a list of cautions, shown on first load.

## Run

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev        # http://localhost:5183
```

The generated anatomy data (`public/anatomy/`) is in the repository, so a fresh clone runs as is. URL parameters: `?body=male` (default) or `?body=female`; `?renderer=webgl` forces the WebGL2 backend.

## Test

```sh
bunx vitest run    # pipeline, knowledge layer, skin maps, graph queries, display rules
bunx tsc --noEmit
```

The tests on generated data check invariants and anatomical facts: every part appears in exactly one GLB, adjacency is symmetric, the left femur is on the body's left; 18 nerve landmarks (ulnar nerve behind the medial epicondyle, sciatic nerve leaving below piriformis, common fibular nerve round the fibular neck, …); key sensory points lie in their own dermatome; the uterus sits between bladder and rectum.

## Layout

```
src/anatomy/types.ts   data contract: offline tools write it, the UI reads it
src/                   UI (React + three.js WebGPURenderer)
tools/pipeline/        geometry: classification, layers, simplification, adjacency, registration, derived parts, GLB output
tools/knowledge/       names and functional relations, aligned by concept id
tools/skinmaps/        dermatomes and cutaneous-nerve territories
tools/zanatomy/        reading Z-Anatomy and Open3DModel, building the import package
tools/register/        anchor data for the female body
tools/fixture/         synthetic dataset for development
data/curated/          curated data checked into the repository
public/anatomy/        generated runtime data
```

Geometry and knowledge come from separate sources: shape and position only from meshes reconstructed from volume data, or derived from those; names and relations from ontologies, encyclopaedias and open literature. FMA (Foundational Model of Anatomy) ids join the two.

Each part carries a provenance: `scanned` (as in the source), `warped` (moved by non-rigid registration), `curated` (artist-modelled, or derived by this project from neighbouring structures).

## Regenerating the data

Raw data is not in the repository (`data/raw/` is ignored) and must be downloaded first.

```sh
# BodyParts3D 4.0: download the tables and both zips under LATEST/ into data/raw/bodyparts3d/ and extract
#   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/
bun run pipeline                 # writes public/anatomy/male/
bun run pipeline:female          # writes public/anatomy/female/; needs the male output and the female anchor package (tools/register/run_anchors.sh)
bun tools/knowledge/run.ts       # names and relations; --refresh re-queries Wikidata
bun tools/skinmaps/run.ts male   # skin maps; likewise for female
```

Order matters: the knowledge layer and skin maps read the geometry pipeline's output, and the female body reads the male body's output.

## Sources and licences

Apart from the code, the anatomy data in this directory (`public/anatomy/`, `data/curated/`) is released as a whole under **CC BY-SA 4.0**.

| Source | Used for | Licence |
|---|---|---|
| [BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html) 4.0 | Geometry of the male body (2,220 parts) and both hierarchies | CC BY 4.0 ("BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International") |
| BodyParts3D 3.0 | 79 parts missing from 4.0: lung lobes, abdominal wall muscles, latissimus dorsi, muscles of mastication and facial expression. Registered into place, marked `warped` | CC BY-SA 2.1 JP |
| [Z-Anatomy](https://github.com/Z-Anatomy) | Cranial and trunk nerves, spinal roots, spinal cord, ligaments, fasciae, joint capsules, lymph node groups, thyroid, parotid. Artist-modelled, marked `curated` | CC BY-SA 4.0 ("Z-Anatomy - The libre 3D atlas of anatomy") |
| [AnatomyTool Open3DModel](https://anatomytool.org/open3dmodel) | Limb nerves (right side modelled, left mirrored), cruciate ligaments and menisci. Artist-modelled, marked `curated` | CC BY-SA 4.0 |
| soma (derived) | Subcutaneous fat, visceral pleura, pericardial sac: computed by this project from neighbouring structures, marked `curated` | CC BY-SA 4.0 |
| [Visible Human Project](https://www.nlm.nih.gov/research/visible/visible_human.html) female CT | Skeleton and some organs of the female body, segmented with TotalSegmentator and MOOSE | NLM terms; Courtesy of the U.S. National Library of Medicine |
| [HRA](https://humanatlas.io) female reference organs | Uterus, ovaries, uterine tubes, vagina, pelvic ligaments, mammary glands. Remodelled geometry, marked `curated` | CC BY 4.0 |
| [FMA](http://si.washington.edu/projects/fma) 5.1.0 | Placement of added parts in the is-a hierarchy | see its release page |
| [Wikidata](https://www.wikidata.org) | Names, functional relations, id crosswalks | CC0 |
| [Wikipedia](https://en.wikipedia.org) muscle infoboxes | Origin, insertion and innervation of some muscles, each with a revision link | CC BY-SA 4.0 |
| ISNCSCI key sensory points, Lee et al. 2008, Gray 1918 | Basis of the skin map definitions (facts only, cited per entry) | see `data/curated/skinmaps/` |

About two thirds of the Chinese names are machine-generated from a term lexicon and have no source; `zhSource` in `names.json` says where each came from, and every entry is `unreviewed`.

## Known gaps

The full list is in each body's `cautions`. The main ones:

- Nerves are hand-drawn schematic geometry: calibre is not measured, position after registration is off by about 2 mm (median), more in the lower limb; about a fifth of centreline points were pushed out of bone and muscle bellies.
- Missing nerves: phrenic, cervical plexus, subcostal, splanchnic, autonomic plexuses, laryngeal.
- No parietal pleura, lymphatic vessels, ligamenta flava or cranial meninges; the pericardium is only an envelope of the heart; the descending colon includes the sigmoid; the spinal cord is a procedurally generated surface ending at L2/L3.
- Subcutaneous fat is derived from the space between the skin's inner wall and the deep structures; thickness is quantised to 3 mm.
- The male skin mesh fuses the upper arm to the chest wall, leaving almost no axillary or medial-arm skin; skin map boundaries are jagged at 1–3 cm. The skin maps are constructed teaching maps; dermatomes vary between people and published maps disagree.
- The female body is a first version: the skeleton is the Visible Human Female donor's own (59 years old, obese, six lumbar vertebrae); 86 parts are measured, the rest are warped from the male model or taken from HRA.
  - Soft tissue between bones is off by about 1–3 cm; joint ligaments carried over from the male do not fit her bones.
  - The bowel in the pelvis was shifted as a whole to clear the uterus and adnexa, so the sigmoid colon is not where it really lies; vagina and cervix overlap the male pelvic floor.
  - The skin is a warped male skin, raised only over the chest to enclose the breasts.
  - The right forearm and hand were clipped in the CT and are a mirrored left.
  - No external genitalia, perineum, female urethra, ovarian or vaginal vessels.
- Touch gestures have not been tested on a real device.

## Next

1. A movable body: joints fitted from bone geometry; muscles and other tissue deform with the position of the bones.
2. Adjustable body shape: stature, proportions, fatness, based on measured anthropometry.
3. A better female body: a standard body surface, the pelvic floor, her own leg muscles and knee ligaments.
4. Soft-tissue physics: tetrahedral meshes, XPBD, validated on one region first.
5. Pain: a nociception model along nerve pathways that drives vital signs, withdrawal reflexes and a heat map on the skin. This is a computational model of pain physiology; the simulated body has no subjective experience.
6. Surgical actions: incision, retraction, bleeding, suturing.
