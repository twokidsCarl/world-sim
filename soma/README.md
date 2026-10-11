# soma

三维人体解剖浏览器，面向医学生。world-sim 阶梯上的 L4：器官怎么合成一个活着的整体。

长期目标是外科训练用的模拟人：解剖结构在医学上可信，组织有物理性质，身体对疼痛有反应。现在完成的是第一步——把一个完整的人体拆成三千多个可以单独查看的部件，并标出它们之间的关系。

> 仅供教学使用，不是临床依据。几何来自公开数据集，源数据自身声明仍含错误；中文名称、功能关系和体表图都还没有经过医学专业人员审校。

[English version below](#english)

## 现在能做什么

- 男女两个体型。男性 3,332 个独立部件：骨、肌肉、血管段、器官、神经、韧带、淋巴结、皮下脂肪，按系统分组；女性 3,369 个（见下文，精度低得多）。
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

仓库里已经带了生成好的解剖数据（`public/anatomy/`），克隆后可以直接看。

### 地址参数

视图状态都写在地址的查询参数里，所以任何一个画面都可以用一个链接直接打开。参数都可省略，省略即默认值；无效的值会被忽略并在控制台给出警告。

| 参数 | 取值示例 | 含义 |
|---|---|---|
| `body` | `male`（默认）、`female` | 体型 |
| `embed` | `1` | 嵌入模式：只留舞台和必要控件，不弹对话框 |
| `tab` | `d`、`t`、`p` | 左侧面板：显示、结构树、姿势 |
| `sys` | `ske,ner:60` | 可见的系统，可带不透明度百分数；未列出的隐藏。代码：`int mus ske cv ner res dig uri rep end lym oth` |
| `peel` | `2` | 剥离层数 |
| `iso` | `FMA7088,FJ1234` | 隔离显示：部件编号或概念编号（概念展开为其下全部部件） |
| `hide` | 同 `iso` | 隐藏 |
| `sel` | `FMA9611` 或 `FJ3259,FJ3260` | 选中：一个概念编号，或若干部件编号 |
| `adj` | `1` | 显示相邻结构 |
| `focus` | `1` | 加载后把相机对准所选（或隔离、可见）的结构 |
| `cam` | `px,py,pz,tx,ty,tz` | 相机位置与目标，单位米 |
| `cut` | `a620`、`c500f`、`s250` | 剖切：轴（`a` 横断、`c` 冠状、`s` 矢状）+ 位置千分比 + 可选的 `f` 翻转 |
| `xp` | `40` | 爆炸视图百分数 |
| `pose` | `squat` 或 `elbow_L.0:90,elbow_R.0:90` | 姿势：预设名，或"关节.自由度:角度"（度，相对静止姿势） |
| `breath` | `1` | 呼吸演示 |
| `map` | `d`、`n` | 体表图：皮节、皮神经分布区 |
| `reg` | `14,15` | 体表图中高亮的区域下标 |
| `see` | `1` | 显示体表图时皮肤半透明，露出其下的神经 |
| `src` | `1` | 按数据来源着色 |
| `cmp` | `ske` | 对照视图及其显示的系统 |
| `renderer` | `webgl` | 强制用 WebGL2 后端 |

例：`/?body=male&sys=ske,ner&sel=FMA9611&focus=1`。完整定义见 `src/state/urlState.ts`。

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
| [HRA](https://humanatlas.io) 女性参考器官 | 乳腺，以及子宫动静脉、卵巢系膜、卵巢悬韧带、膀胱子宫陷凹。重新建模过的几何，标记为 `curated` | CC BY 4.0 |
| Wu 等 2015 女性盆底（[doi:10.1371/journal.pone.0132226](https://doi.org/10.1371/journal.pone.0132226)，更正 [10.1371/journal.pone.0140736](https://doi.org/10.1371/journal.pone.0140736)） | 女性体型的盆底肌、肛门和尿道括约肌、会阴体、阴蒂和前庭球、阴道、子宫、输卵管、卵巢、直肠，共 51 个部件。来自另一位女性的标本，放大并按骨配准，标记为 `curated` | CC BY 4.0 |
| [丹佛大学 Visible Human 女性下肢模型](https://doi.org/10.1038/s41597-022-01905-2) | 女性体型的下肢肌肉、膝关节韧带、关节软骨、跗骨，共 100 个部件 | CC BY 4.0 |
| [FMA](http://si.washington.edu/projects/fma) 5.1.0 | 新增部件在分类树里的位置 | 见其发布页 |
| [Wikidata](https://www.wikidata.org) | 名称、功能关系、编号对照 | CC0 |
| [Wikipedia](https://en.wikipedia.org) 肌肉信息框 | 部分肌肉的起止点和神经支配，每条带修订版链接 | CC BY-SA 4.0 |
| ISNCSCI 关键感觉点、Lee 等 2008、Gray 1918 | 体表图的定义依据（只取事实，逐条注明） | 见 `data/curated/skinmaps/` |

名称数据里约三分之二的中文名是按术语表机器生成的，没有出处；`names.json` 的 `zhSource` 字段逐条标明了来源，全部条目的状态都是 `unreviewed`。

### 疼痛声音包（禁止商用，与解剖数据分开）

`public/voice/vivae-pain/` 是一个**独立的集合**，许可是 **CC BY-NC 4.0（仅限非商业使用）**，不属于上面 CC BY-SA 4.0 的解剖数据集，也不属于 MIT 许可的代码。

- 内容：VIVAE 语料库（Holz、Larrouy-Maestri、Poeppel，[doi:10.5281/zenodo.4066235](https://doi.org/10.5281/zenodo.4066235)）里"身体疼痛"类的 185 条录音，重采样到 24 kHz，另加本项目做的逐条分析。这些是按指令表演出来的发声，不是真实疼痛时的录音。署名、许可和改动清单在该目录的 `ATTRIBUTION.txt` 和 `LICENSE.txt` 里。
- 用法：`src/voice/` 在运行时加载它，在录音基础上做变化（换录音、小幅变调变速、连成持续性发声、由女声推出男声）。目录不存在时自动改用参数化合成器。
- **商业用途的构建或部署必须删除这个目录**（构建产物里是 `dist/voice/`）。没有任何机制强制这一点。
- `data/curated/voice/calibration.json` 只含由该语料统计出的汇总量，不含音频。

## 已知的缺口

完整的清单在每个体型数据的 `cautions` 字段里。主要的几条：

- 神经是手工绘制的示意性几何，粗细不是实测，位置经配准后误差中位数约 2 mm、下肢更大；约五分之一的中心线点被从骨和肌腹里推出过。
- 没有的神经：膈神经、颈丛、肋下神经、内脏神经、自主神经丛、喉神经。
- 没有壁胸膜、淋巴管、黄韧带、颅内脑膜；心包只是心脏的外包络；降结肠包含乙状结肠；脊髓是程序化生成的表面，止于 L2/L3。
- 皮下脂肪是从皮肤内壁和深层结构之间推导出来的，厚度按 3 mm 量化。
- 男性皮肤是按他的内部结构拟合的参数化体表（Meta MHR，Apache-2.0），不是他本人的皮肤：生殖器处只是一块隆起，脚趾连成一块，没有乳头和脐，指尖和眼周有突起；腋窝内侧的皮肤贴着胸壁。大幅度姿势下（肩前屈 160°、深蹲）皮肤仍有明显拉伸，深部结构会穿出皮肤最多约 4 cm；呼吸演示时胸部皮肤不随肋骨动。皮肤包不在仓库里，由 `tools/bodyshape/` 的脚本生成到 `data/raw/bodyshape/out/`。
- 体表图的边界有 1–3 厘米的锯齿。体表图是构造出来的教学用图，皮节因人而异，已发表的图互相矛盾。
- 男性的肩带姿势被校正过：原始扫描是仰卧耸肩的姿势，锁骨下降约 10°、肩胛骨沿胸廓转动，上肢整体平移。148 个跨越肩部的肌肉、血管和皮肤因此由 `scanned` 改标为 `warped`。两肩关节中心间距 338 mm，没有达到 350 mm 的目标；肩胛骨内旋仍比文献均值小约 2 个标准差。
- 女性体型是第二版，仍比男性粗糙得多：
  - 骨架来自 Visible Human 女性供体（59 岁、肥胖、六节腰椎），已按标准比例缩放到身高 1.606 m、五节腰椎，所以她的部件都不再标为 `scanned`。缩放系数记在 `pipeline-report.json` 里。踝仍偏高约 17 mm。
  - 下肢的肌肉和膝关节韧带是她自己的（丹佛数据），53 块肌腹接上了从男性肌切下的腱；14 块肌没有接好，仍用男性的。约 4.9% 的神经长度深埋在她的肌肉里。
  - 盆底、阴道、子宫、附件和直肠来自另一位女性的标本（Wu 等 2015），放大 1.096 倍后按骨配准。结构之间仍有少量穿插（最差的一对 3.8%）；阴道与直肠壁局部相贴；膀胱（她自己的，空虚）与子宫（按充盈膀胱的位置）之间有 16.6 mm 空隙；乙状结肠与直肠的连接是构造出来的。
  - 没有阴唇和外阴皮肤、尿道腔、阔韧带、主韧带、宫骶韧带、输卵管系膜、卵巢固有韧带、卵巢和阴道血管、自主神经丛。
  - 皮肤是男性皮肤变形来的，只在胸部抬高包住乳腺，还没有换成按女性体型拟合的皮肤。
  - 右前臂和右手在 CT 里被裁切，用的是左侧镜像。
- 触屏手势没有在真机上测过。

## 接下来

1. 两个体型的新皮肤：按各自内部结构拟合的参数化体表，替换现在的占位皮肤。
2. 体型可调：身高、比例、胖瘦，依据实测人体测量数据（模型已有，界面未接）。
3. 对照视图里的姿势、女性体型的直达卡片。
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

- Two bodies. Male: 3,332 separate parts — bones, muscles, vessel segments, organs, nerves, ligaments, lymph nodes, subcutaneous fat — grouped by system. Female: 3,369 (far less accurate; see below).
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

The generated anatomy data (`public/anatomy/`) is in the repository, so a fresh clone runs as is.

### URL parameters

The whole view state lives in the query string, so any view can be opened by one link. Every parameter is optional and absent means the default; invalid values are ignored with a console warning.

| Parameter | Example values | Meaning |
|---|---|---|
| `body` | `male` (default), `female` | Which body |
| `embed` | `1` | Embed mode: stage and essential controls only, no dialogs |
| `tab` | `d`, `t`, `p` | Left panel: display, tree, pose |
| `sys` | `ske,ner:60` | Visible systems, each optionally with an opacity percent; unlisted ones are hidden. Codes: `int mus ske cv ner res dig uri rep end lym oth` |
| `peel` | `2` | Peel depth |
| `iso` | `FMA7088,FJ1234` | Isolate: part ids or concept ids (a concept expands to all its parts) |
| `hide` | as `iso` | Hide |
| `sel` | `FMA9611` or `FJ3259,FJ3260` | Selection: one concept id, or several part ids |
| `adj` | `1` | Show adjacent structures |
| `focus` | `1` | Frame the selected (or isolated, or visible) structures on load |
| `cam` | `px,py,pz,tx,ty,tz` | Camera position and target, in metres |
| `cut` | `a620`, `c500f`, `s250` | Section: axis (`a` axial, `c` coronal, `s` sagittal) + position per mille + optional `f` to flip |
| `xp` | `40` | Explode percent |
| `pose` | `squat` or `elbow_L.0:90,elbow_R.0:90` | Pose: a preset name, or `joint.dof:degrees` relative to rest |
| `breath` | `1` | Breathing demonstration |
| `map` | `d`, `n` | Skin map: dermatomes, cutaneous nerve territories |
| `reg` | `14,15` | Highlighted region indices of the skin map |
| `see` | `1` | Draw the skin see-through under a skin map, to reveal the nerves beneath |
| `src` | `1` | Colour by data source |
| `cmp` | `ske` | Compare view and the system it shows |
| `renderer` | `webgl` | Force the WebGL2 backend |

Example: `/?body=male&sys=ske,ner&sel=FMA9611&focus=1`. The full definition is in `src/state/urlState.ts`.

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
| [HRA](https://humanatlas.io) female reference organs | Mammary glands, plus uterine artery and vein, mesovarium, suspensory ligament of ovary, uterovesical pouch. Remodelled geometry, marked `curated` | CC BY 4.0 |
| Wu et al. 2015 female pelvic floor ([doi:10.1371/journal.pone.0132226](https://doi.org/10.1371/journal.pone.0132226), correction [10.1371/journal.pone.0140736](https://doi.org/10.1371/journal.pone.0140736)) | The female body's pelvic floor muscles, anal and urethral sphincters, perineal body, clitoris and vestibular bulbs, vagina, uterus, uterine tubes, ovaries and rectum: 51 parts. From another woman's specimen, enlarged and fitted by bone, marked `curated` | CC BY 4.0 |
| [University of Denver Visible Human Female lower extremity](https://doi.org/10.1038/s41597-022-01905-2) | The female body's leg muscles, knee ligaments, articular cartilage and tarsal bones: 100 parts | CC BY 4.0 |
| [FMA](http://si.washington.edu/projects/fma) 5.1.0 | Placement of added parts in the is-a hierarchy | see its release page |
| [Wikidata](https://www.wikidata.org) | Names, functional relations, id crosswalks | CC0 |
| [Wikipedia](https://en.wikipedia.org) muscle infoboxes | Origin, insertion and innervation of some muscles, each with a revision link | CC BY-SA 4.0 |
| ISNCSCI key sensory points, Lee et al. 2008, Gray 1918 | Basis of the skin map definitions (facts only, cited per entry) | see `data/curated/skinmaps/` |

About two thirds of the Chinese names are machine-generated from a term lexicon and have no source; `zhSource` in `names.json` says where each came from, and every entry is `unreviewed`.

### Pain sound pack (non-commercial, separate from the anatomy data)

`public/voice/vivae-pain/` is a **separate collection** under **CC BY-NC 4.0 (non-commercial use only)**. It is not part of the CC BY-SA 4.0 anatomy dataset above and not part of the MIT-licensed code.

- Contents: the 185 physical-pain recordings of the VIVAE corpus (Holz, Larrouy-Maestri, Poeppel, [doi:10.5281/zenodo.4066235](https://doi.org/10.5281/zenodo.4066235)), resampled to 24 kHz, plus a per-clip analysis made by this project. They are vocalisations performed on instruction, not recordings of real pain. Attribution, licence and the list of changes are in `ATTRIBUTION.txt` and `LICENSE.txt` in that directory.
- Use: `src/voice/` loads it at run time and varies the recordings (clip choice, small pitch and time changes, sequences for sustained pain, a male voice derived from the female recordings). Without the directory it falls back to the parametric synthesizer.
- **A build or deployment for commercial use must delete this directory** (`dist/voice/` in the build output). Nothing enforces this.
- `data/curated/voice/calibration.json` holds only aggregates computed from the corpus, no audio.

## Known gaps

The full list is in each body's `cautions`. The main ones:

- Nerves are hand-drawn schematic geometry: calibre is not measured, position after registration is off by about 2 mm (median), more in the lower limb; about a fifth of centreline points were pushed out of bone and muscle bellies.
- Missing nerves: phrenic, cervical plexus, subcostal, splanchnic, autonomic plexuses, laryngeal.
- No parietal pleura, lymphatic vessels, ligamenta flava or cranial meninges; the pericardium is only an envelope of the heart; the descending colon includes the sigmoid; the spinal cord is a procedurally generated surface ending at L2/L3.
- Subcutaneous fat is derived from the space between the skin's inner wall and the deep structures; thickness is quantised to 3 mm.
- The male skin is a parametric body surface (Meta MHR, Apache-2.0) fitted to his internals, not his own skin: the genital region is only a mound, the toes are one block, there are no nipples or navel, and there are bumps at the fingertips and round the eyes; medial axillary skin lies against the chest wall. In large poses (shoulder flexion 160°, deep squat) the skin still stretches visibly and deep parts come through it by up to about 4 cm; in the breathing demonstration the chest skin does not follow the ribs. The skin package is not in the repository; the scripts in `tools/bodyshape/` write it to `data/raw/bodyshape/out/`.
- Skin map boundaries are jagged at 1–3 cm. The skin maps are constructed teaching maps; dermatomes vary between people and published maps disagree.
- The male shoulder girdle was re-posed: the scan is supine with shrugged shoulders, so the clavicles were lowered by about 10°, the scapulae turned round the rib cage and each upper limb translated. 148 muscles, vessels and the skin that span the shoulder changed from `scanned` to `warped`. The glenohumeral centres are 338 mm apart, short of the 350 mm target, and scapular internal rotation is still about 2 SD below the literature mean.
- The female body is a second version and still far coarser than the male:
  - The skeleton is from the Visible Human Female donor (59 years old, obese, six lumbar vertebrae), rescaled to standard proportions at 1.606 m with five lumbar vertebrae, so none of her parts is marked `scanned` any more. The scale factors are in `pipeline-report.json`. The ankle is still about 17 mm too high.
  - Leg muscles and knee ligaments are her own (Denver data); 53 bellies carry tendons cut from the male muscles, and 14 muscles could not be spliced and remain male. About 4.9% of nerve length lies deep inside her muscles.
  - Pelvic floor, vagina, uterus, adnexa and rectum come from another woman's specimen (Wu et al. 2015), enlarged 1.096× and fitted by bone. Some interpenetration remains (worst pair 3.8%); the vaginal and rectal walls touch in places; there is a 16.6 mm gap between the bladder (her own, empty) and the uterus (positioned for a full bladder); the join between sigmoid colon and rectum is constructed.
  - Missing: labia and vulvar skin, urethral lumen, broad, cardinal, uterosacral and ovarian ligaments, mesosalpinx, ovarian and vaginal vessels, autonomic plexuses.
  - The skin is a warped male skin, raised only over the chest to enclose the breasts; a skin fitted to a female body has not been installed yet.
  - The right forearm and hand were clipped in the CT and are a mirrored left.
- Touch gestures have not been tested on a real device.

## Next

1. New skins for both bodies: parametric body surfaces fitted to each body's internals, replacing the present placeholders.
2. Adjustable body shape: stature, proportions, fatness, based on measured anthropometry (the model exists; the UI is not wired yet).
3. Posing in the compare view, and deep-link cards for the female body.
4. Soft-tissue physics: tetrahedral meshes, XPBD, validated on one region first.
5. Pain: a nociception model along nerve pathways that drives vital signs, withdrawal reflexes and a heat map on the skin. This is a computational model of pain physiology; the simulated body has no subjective experience.
6. Surgical actions: incision, retraction, bleeding, suturing.
