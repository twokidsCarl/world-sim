# limn

中文在前，[English below](#limn-english)。

按 David S. Goodsell 的画法，从真实原子坐标生成分子与细胞插图。输入一个病毒、基因或机理，得到一张平涂色块、黑色勾线、按功能分色的科学图；画面由数据确定性渲染，模型只负责选结构和分配角色，不生成像素。

## 现在有什么

| | 内容 | 状态 |
|---|---|---|
| M0 | 风格研究：分析 12 张 Goodsell 原图，写成风格准则 | 完成，见 [docs/style-guide.md](docs/style-guide.md) |
| M1 | 渲染核心：移植 Illustrate 的描边、阴影算法到 WebGL2 | 完成，见 `src/render/`。已与原版 Illustrate 对照：它自带的 2hhb 示例，同一份 PDB、同一套参数，平均色差 2.8/255，见下文 |
| M2 | 网页应用：旋转、调色、高分辨率导出 | 完成 |
| M3 | 主题解析：自由文本 → 真实结构 | 完成，见 `server/resolve.ts` |
| M4 | 看图精修：让模型看渲染结果、给反馈、迭代 | 完成，见 `server/critique.ts`、`src/refine/` |
| M5 | 细胞全景：按浓度自动排布的截面图 | 第一版完成，见 `server/landscape.ts`、`src/landscape/`；局限见下 |
| 二期·1 | 现成的整病毒、整细胞模型：新冠病毒颗粒、HIV、突触小泡、外泌体、整只支原体、核孔等 14 个 | 完成，见 `data/catalog.json`、`src/mol/load.ts`、`src/mol/coarse.ts` |

二期的目标是用更多真实数据扩大可画的范围，共八个阶段：现成模型（已完成）、用实测数据替换估计值（丰度、膜取向、脂质组成）、AlphaFold 扩展与逐残基标注、Nature/Science 最新结构、分子尺度的突触、神经元形态、细胞器网格、电镜密度图。

## 运行

```sh
bun install
bun run dev        # 网页 http://127.0.0.1:5184 ，本地服务 127.0.0.1:5185
bun run test
bun run typecheck
```

三种用法：

- **按主题**：输入“CRISPR-Cas9 切割 DNA”“新冠刺突蛋白结合 ACE2”“TP53”这样的话。需要本机装有并登录了 [Claude Code](https://claude.com/claude-code)（用 `claude -p` 调用，不需要 API key）。一次解析约半分钟。
- **按 PDB 编号**：直接输入 4 位编号，不需要 `claude`。例如 `2hhb`（血红蛋白）、`6vxx`（新冠刺突蛋白）、`1m4x`（PBCV-1 病毒衣壳，1600 万原子）。

- **现成模型**：从列表里点一个已发表的整体模型，不需要 `claude`。按主题输入“新冠病毒长什么样”这类话时，也会自动用上对应的现成模型。

拖动旋转，滚轮缩放，Shift 拖动平移。“剖开”滑杆从前面切掉一部分，看病毒或细胞的内部；切的时候整个分子一起保留或去掉，不会出现被切了一半的蛋白。

主题如果是一个拥挤的细胞场景（“大肠杆菌细胞质的拥挤场景”“流感病毒包膜表面的横截面全景”），会画成全景：80×56 nm、厚 30 nm 的一片截面，可以带一层水平的膜。

可调的环境变量：`LIMN_MODEL`（默认 `sonnet`）、`LIMN_CLAUDE_BIN`、`LIMN_CACHE`、`LIMN_PORT`。

## 它怎么保证画的是真的

1. **模型不出像素，也不出坐标。** 画面完全由 PDB 的原子坐标确定性渲染。
2. **模型不能编造结构编号。** 解析分三步：模型说要找什么 → 代码去 RCSB、UniProt、PDBe 查 → 模型只能在查回来的候选里选（选项是候选编号的枚举，不在其中的一律丢弃）。模型凭记忆提到的编号只当作检索线索，要经 RCSB 确认存在并取回真实的描述后才会成为候选。
3. **看图精修只能改呈现。** 评审能做的操作是一份白名单：转视角、缩放、改颜色角色、调线条和阴影。换结构、动坐标不在其中，见 `src/refine/edits.ts`。
4. **说明出处和局限。** 界面列出每个面板的 PDB 编号、实验方法、分辨率、年份和选它的理由；AlphaFold 预测模型会明确标注，低置信度区域不画。

多个面板的机理图里，各面板比例相同，并按共同的蛋白链叠合到同一朝向。

## 现成模型里什么是真的，什么不是

目录（`data/catalog.json`）里有两类东西，界面上分别标为“实测”和“整理的模型”：

- **实测**：PDB 里的实验结构，例如完整的 HIV-1 衣壳（3J3Q）、寨卡病毒（5IRE）。
- **整理的模型**：别人已发表的整体模型，例如 PetWorld 的新冠病毒颗粒、cellPACK 的 HIV 和整只生殖支原体。其中每个分子是真实结构或同源模型，**位置和数量是模型作者依据实验数据排布的，不是直接观测到的**。核孔复合体这类整合结构同理：由多种实验数据拼合而成。

画法上做了三件要说明的事：

- 整张膜画成一片，不逐个脂质描边；纤维（DNA、RNA）的一节节片段连成一条，不分段描边。
- 比线还细的东西会被画粗一点，否则会被自己的描边吞掉（Goodsell 也这样做）。所以整细胞图里 DNA 细丝比实际略粗。
- 原子数超过约 4500 万的模型（整只支原体有 1.61 亿）自动改成每个残基画一个球，界面上会说明。

目录只存指针、出处和许可，模型在运行时从原地址下载，不入库。各模型的许可不同（CC0、MIT、CC BY-SA 4.0，有几个文件没有附许可声明），界面上逐条列出；用这些图时请按原作者的许可署名。

## 全景图里什么是真的，什么不是

真的：每个分子都是 PDB 里的实验结构，按同一比例画；分子之间不重叠；各区室画出的大分子总质量与该区室的总浓度相符。

不是观测结果，界面上也都写明了：

- **位置和朝向是随机排布的。** 可溶分子在各自区室里随机放置；真实细胞里的结合关系、排列（例如贴在膜内侧的基质蛋白层）没有体现。
- **丰度是模型给的估计值。** 配方由模型拟定：列出十来种有代表性的分子和它们的大致浓度。除标为主角的成分外，数量按比例放大到区室总浓度，用这十来种代表其余上千种。
- **膜蛋白是近似摆放的。** 沿分子长轴竖立；只解析了膜外段的结构立在膜面上，连膜的一端由链末端的位置判断。没有使用实验确定的取向和插入深度，缺失的柄部和跨膜段不画。
- **膜是同一种磷脂（POPC）的理想构象铺成的**，不是真实的脂质组成和构象。
- **没有画**：水、离子、小分子，以及核酸长链和纤维（DNA、mRNA、细胞骨架）。

所以它适合用来感受“细胞里有多挤、各种分子相对多大”，不适合用来读具体的相互作用。

## 重做风格分析

```sh
research/fetch_gallery.sh     # 下载原图到 research/gallery/（约 320 MB）
uv run --no-project --with numpy --with scipy --with pillow python -I research/analyze.py
```

结果写到 `research/out/`：`stats.json`（每张图的取色、色相区占比、明度与彩度范围、线宽）、预览图和色带图。

与原版 Illustrate 对照（需要 gfortran，`brew install gcc`）：

```sh
research/illustrate/build.sh   # 下载并编译 Illustrate，渲染它自带的 2hhb 示例到 research/illustrate/build/（不入库）
bun run dev                    # 然后打开 http://127.0.0.1:5184/research/illustrate/compare.html
```

页面用 limn 的渲染器按同样的输入卡片画同一个分子，并排显示两张图和差异图。当前结果（922×750）：平均色差 2.8/255，3.7% 的像素差异超过 32，分子的平均色调 (228,147,124) 对 (229,147,124)，纯黑墨线占比 4.3% 对 4.7%。剩下的差异集中在线条边缘：limn 做了 2 倍超采样，线条有灰度过渡，原版是硬边。

重建“每月分子”对照表（`data/motm.json`，只存文章标题和 PDB 编号）：`bun server/tools/scrape_motm.ts`。

## 数据与参考图

- **结构数据**：运行时从 RCSB PDB（`models.rcsb.org`，CC0）按编号下载，不入库。检索还用到 UniProt、PDBe SIFTS 和 AlphaFold DB 的公开接口。
- **现成模型**（`data/catalog.json`，只存指针）：[Mesoscale Explorer](https://mesoscope.scripps.edu/explorer/) 的示例文件，包括 YASARA [PetWorld](http://download.yasara.org/petworld/)（CC BY-SA 4.0；Ozvoldik 等，*J. Chem. Inf. Model.* 2021）和 [cellPACK](https://github.com/mesoscope/cellPACK_data)（数据仓库为 MIT）的模型、生殖支原体整细胞模型（MIT；Maritan 等，*J. Mol. Biol.* 2022），以及 RCSB 里的整合结构（PDB-IHM，CC0）。
- **`data/motm.json`**：PDB-101 “Molecule of the Month” 各篇文章的标题和文中提到的 PDB 编号，用来优先选经过人工挑选的代表性结构。不含文章正文和图片。
- **参考图**：Goodsell 的原图来自 RCSB PDB-101 的 [Goodsell Gallery](https://pdb101.rcsb.org/sci-art/goodsell-gallery) 和 [Molecule of the Month](https://pdb101.rcsb.org/motm)，许可为 CC-BY-4.0。本仓库**不包含这些图片**，只包含从中测得的统计数字（写在风格准则里）；`research/gallery/` 和 `research/out/` 已被忽略，用上面的脚本重新获取。
- **算法来源**：描边与阴影的做法出自 Goodsell 的 [Illustrate](https://github.com/ccsb-scripps/Illustrate)（Apache-2.0；Goodsell, Autin & Olson, *Structure* 2019）。limn 是重新实现，不包含其源码。
- **文件解析**：用 [Mol\*](https://github.com/molstar/molstar)（MIT）的 CIF 解析模块。

本项目与 David S. Goodsell、Scripps Research、RCSB PDB 无隶属关系，风格是致敬。

---

# limn (English)

Molecular and cellular illustrations in the manner of David S. Goodsell, generated from real atomic coordinates. Name a virus, a gene or a mechanism and get a picture in flat colour with black outlines, coloured by function. The picture is rendered deterministically from data; the language model only chooses structures and assigns roles, and never produces pixels.

## What is here

| | What | Status |
|---|---|---|
| M0 | Style study: 12 of Goodsell's pictures analysed and written up as a style guide | Done, see [docs/style-guide.md](docs/style-guide.md) (Chinese) |
| M1 | Rendering core: the outline and shadow algorithms of Illustrate, ported to WebGL2 | Done, see `src/render/`. Compared against the original Illustrate on its own 2hhb example with the same PDB file and parameters: mean colour difference 2.8/255, see below |
| M2 | Web app: rotation, recolouring, high-resolution export | Done |
| M3 | Topic resolution: free text to real structures | Done, see `server/resolve.ts` |
| M4 | Review loop: the model looks at the render, gives feedback, iterates | Done, see `server/critique.ts`, `src/refine/` |
| M5 | Cellular landscapes: cross-sections packed automatically by concentration | First version done, see `server/landscape.ts`, `src/landscape/`; limits below |
| Round 2, phase 1 | Ready-made whole virions and cells: a SARS-CoV-2 virion, HIV, a synaptic vesicle, an exosome, a whole mycoplasma cell, nuclear pores; 14 models | Done, see `data/catalog.json`, `src/mol/load.ts`, `src/mol/coarse.ts` |

Round 2 widens what can be drawn by bringing in more real data, in eight phases: ready-made models (done), measured data in place of estimates (abundance, membrane orientation, lipid composition), AlphaFold extensions and per-residue annotation, recent structures from Nature and Science, the synapse at molecular scale, neuron morphologies, organelle meshes, and electron-microscopy density maps.

## Running it

```sh
bun install
bun run dev        # web app on http://127.0.0.1:5184 , local service on 127.0.0.1:5185
bun run test
bun run typecheck
```

Three ways in:

- **By topic**: type something like "CRISPR-Cas9 cutting DNA", "the SARS-CoV-2 spike bound to ACE2" or "TP53". This needs [Claude Code](https://claude.com/claude-code) installed and signed in on the machine (it is called as `claude -p`; no API key is needed). One resolution takes about half a minute.
- **By PDB id**: type a four-character id; `claude` is not needed. Examples: `2hhb` (haemoglobin), `6vxx` (the SARS-CoV-2 spike), `1m4x` (the PBCV-1 capsid, 16 million atoms).
- **Ready-made models**: pick a published whole model from the list; `claude` is not needed. A topic such as "what does the coronavirus look like" also resolves to the matching ready-made model.

Drag to rotate, scroll to zoom, shift-drag to pan. The "cut" slider removes the front of the subject to show the inside of a virus or a cell; whole molecules are kept or dropped together, so no protein is ever shown sliced in half.

A topic that asks for a crowded cellular scene ("the crowded cytoplasm of E. coli", "a cross-section of the influenza envelope") is drawn as a landscape: a slab 80 × 56 nm and 30 nm thick, optionally with a horizontal membrane.

Environment variables: `LIMN_MODEL` (default `sonnet`), `LIMN_CLAUDE_BIN`, `LIMN_CACHE`, `LIMN_PORT`.

## How it keeps the picture true

1. **The model produces neither pixels nor coordinates.** The picture is rendered deterministically from atomic coordinates.
2. **The model cannot invent a structure id.** Resolution has three steps: the model says what to look for; code looks it up in RCSB, UniProt and PDBe; the model may then choose only among what came back (the choice is an enumeration of the candidate ids, and anything else is discarded). Ids the model recalls from memory are search hints only; each must be confirmed by RCSB, and its real description fetched, before it becomes a candidate.
3. **The review loop can change presentation only.** What a reviewer may do is a whitelist: turn the view, zoom, cut, change colour roles, adjust lines and shadows. Swapping structures or moving atoms is not on it; see `src/refine/edits.ts`.
4. **Provenance and limits are stated.** The interface lists each panel's PDB id, method, resolution, year and the reason it was chosen. AlphaFold predictions are labelled as such, and their low-confidence regions are not drawn.

In a multi-panel mechanism figure every panel is at the same scale, and panels are superposed on their shared protein chain so that they face the same way.

## What is real in a ready-made model, and what is not

The catalogue (`data/catalog.json`) holds two kinds of thing, labelled "measured" and "curated model" in the interface:

- **Measured**: experimental structures in the PDB, such as the entire HIV-1 capsid (3J3Q) or Zika virus (5IRE).
- **Curated models**: whole models that others have published, such as PetWorld's SARS-CoV-2 virion and cellPACK's HIV virion and whole Mycoplasma genitalium cell. Each molecule in them is a real structure or a homology model; **where the molecules are and how many there are was arranged by the model's authors from experimental data, and was not observed directly**. The same holds for integrative structures such as the nuclear pore complex, which are assembled from several kinds of experiment.

Three things about how they are drawn:

- A membrane is drawn as one sheet, without an outline around each lipid; the segments of a fibre (DNA, RNA) are joined into one strand, without an outline around each segment.
- Anything thinner than the line is drawn a little fatter, or its own outline would swallow it (Goodsell does the same). So the DNA strands in a whole-cell picture are slightly thicker than in life.
- A model with more than about 45 million atoms (the whole mycoplasma cell has 161 million) is drawn with one sphere per residue instead, and the interface says so.

The catalogue stores pointers, provenance and licences only; models are downloaded from their home at run time and are not in this repository. Licences differ (CC0, MIT, CC BY-SA 4.0, and a few files carry no licence statement) and are listed per model in the interface. If you use the pictures, credit the original authors as their licence requires.

## What is real in a landscape, and what is not

Real: every molecule is an experimental structure from the PDB, drawn at one scale; molecules do not overlap; the total mass of macromolecules drawn in each compartment matches that compartment's overall concentration.

Not observed, and said so in the interface:

- **Positions and orientations are random.** Soluble molecules are scattered within their compartment; real binding partners and arrangements (a matrix layer under a membrane, say) are not represented.
- **Abundances are the model's estimates.** The recipe is proposed by the model: a dozen representative molecules and their rough concentrations. Apart from the featured ones, counts are scaled up to the compartment's total concentration, so that a dozen kinds stand in for the thousand others.
- **Membrane proteins are placed approximately.** They stand along their long axis; a structure that covers only the part outside the membrane stands on the membrane face, with the membrane end judged from where the chain terminus is. Experimentally determined orientations and insertion depths are not used, and missing stalks and transmembrane segments are not drawn.
- **The membrane is one phospholipid (POPC) in its ideal conformation**, not a real lipid composition or real conformations.
- **Not drawn**: water, ions, small molecules, and long nucleic acids and filaments (DNA, mRNA, the cytoskeleton).

So a landscape is good for a sense of how crowded a cell is and how large its molecules are relative to each other, and not for reading off particular interactions.

## Redoing the style analysis

```sh
research/fetch_gallery.sh     # download the originals to research/gallery/ (about 320 MB)
uv run --no-project --with numpy --with scipy --with pillow python -I research/analyze.py
```

Results go to `research/out/`: `stats.json` (per picture: palette, share of each hue sector, lightness and chroma ranges, line width), previews and palette strips.

Comparing against the original Illustrate (needs gfortran, `brew install gcc`):

```sh
research/illustrate/build.sh   # download and build Illustrate, render its own 2hhb example into research/illustrate/build/ (ignored)
bun run dev                    # then open http://127.0.0.1:5184/research/illustrate/compare.html
```

The page draws the same molecule with limn's renderer from the same input cards and shows both pictures and their difference side by side. Current result (922 × 750): mean colour difference 2.8/255; 3.7% of pixels differ by more than 32; mean tone of the molecule (228,147,124) against (229,147,124); pure black ink 4.3% against 4.7%. What remains is at line edges: limn supersamples 2×, so its lines have grey transitions where the original's are hard.

Rebuilding the Molecule of the Month table (`data/motm.json`, article titles and PDB ids only): `bun server/tools/scrape_motm.ts`.

## Data and reference pictures

- **Structures**: downloaded by id at run time from the RCSB PDB (`models.rcsb.org`, CC0); none are in this repository. Lookups also use the public interfaces of UniProt, PDBe SIFTS and the AlphaFold DB.
- **Ready-made models** (`data/catalog.json`, pointers only): the example files of the [Mesoscale Explorer](https://mesoscope.scripps.edu/explorer/), which include models from YASARA [PetWorld](http://download.yasara.org/petworld/) (CC BY-SA 4.0; Ozvoldik et al., *J. Chem. Inf. Model.* 2021) and [cellPACK](https://github.com/mesoscope/cellPACK_data) (the data repository is MIT), the whole-cell model of Mycoplasma genitalium (MIT; Maritan et al., *J. Mol. Biol.* 2022), and integrative structures in the RCSB (PDB-IHM, CC0).
- **`data/motm.json`**: the title of each PDB-101 "Molecule of the Month" article and the PDB ids it mentions, used to prefer hand-picked representative structures. It contains no article text and no images.
- **Reference pictures**: Goodsell's originals come from the RCSB PDB-101 [Goodsell Gallery](https://pdb101.rcsb.org/sci-art/goodsell-gallery) and [Molecule of the Month](https://pdb101.rcsb.org/motm), licensed CC-BY-4.0. This repository **does not contain those images**, only statistics measured from them (in the style guide); `research/gallery/` and `research/out/` are ignored and can be fetched again with the scripts above.
- **Algorithms**: the outlines and shadows follow Goodsell's [Illustrate](https://github.com/ccsb-scripps/Illustrate) (Apache-2.0; Goodsell, Autin & Olson, *Structure* 2019). limn is a reimplementation and contains none of its source.
- **File parsing**: the CIF parser of [Mol\*](https://github.com/molstar/molstar) (MIT).

This project is not affiliated with David S. Goodsell, Scripps Research or the RCSB PDB; the style is a tribute.
