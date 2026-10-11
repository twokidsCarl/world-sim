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
| 三期 | 界面实测与版面修正；比例尺；界面中英双语（`?lang=en`）；AlphaFold 预测复合物；BFVD 病毒蛋白预测；Complex Portal 复合物配比；NeuroMorpho 检索与多神经元并排；自备拷贝数表的导入口 | 完成。MICrONS 在四期接入 |
| 四期 | 三处小修；看图精修改成成对比较并能撤销；脂质构象的几何松弛；核糖体的实测朝向；MICrONS 连接组里相邻的神经元；两种新图元（圆台胶囊、三角网格） | 这几项完成；超大模型（突触、流感整病毒、syn3A）还没做 |
| 二期·7 | 整个细胞的细胞器：OpenOrganelle 的电镜分割（HeLa 细胞的细胞核、内质网、线粒体、高尔基体、内体） | 第一版完成，见 `src/volume/n5.ts`、`data/cells.json` |
| 二期·8 | 电镜密度图：按 `EMD-编号` 载入 EMDB 的图，画作者建议阈值处的等值面，拟合的原子模型叠在里面 | 第一版完成，见 `src/volume/mrc.ts`、`server/sources/emdb.ts` |
| 二期·6 | 神经元形态：NeuroMorpho.Org 的显微重建（锥体细胞、浦肯野细胞等），按胞体、树突、轴突分色 | 第一版完成，见 `src/neuro/swc.ts`、`data/neurons.json` |
| 二期·5 | 分子尺度的脑神经：38 个神经相关的地标结构（突触前、突触后、轴突、髓鞘、病理纤维）；膜蛋白取向增加 PDBTM 后备 | 完成，见 `data/neuro.json`、`server/sources/pdbtm.ts` |
| 二期·4 | 最新发表：按期刊（Nature、Science、Cell 等）列出最近公开的结构，点一下出图；出处里显示论文 | 完成，见 `server/sources/literature.ts` |
| 二期·2d | 膜的真实脂质组成（八类膜，分小叶混排），脂质尾链转到同一侧 | 完成，见 `data/membranes.json`、`src/landscape/lipid.ts` |
| 二期·3a | 逐残基上色：结构域、活性与结合位点、AlphaFold 置信度、AlphaMissense 致病性；按 `AF-<UniProt 编号>` 直接载入预测模型 | 完成，见 `src/style/annotate.ts`、`server/sources/annotations.ts` |
| 二期·2e | 冷冻电镜断层扫描里粒子的实测位置：一片支原体细胞里 331 个核糖体 | 完成，见 `src/mol/points.ts` 和目录里的 `mycoplasma-ribosomes-in-situ` |
| 二期·2c | 全景图里的 DNA 长链（程序生成的双螺旋） | 完成，见 `src/landscape/fiber.ts`、`data/bdna.json` |
| 二期·2b | 膜蛋白按 OPM 的取向嵌进膜里 | 完成，见 `server/sources/opm.ts`、`src/landscape/orient.ts` |
| 二期·2a | 全景图的蛋白丰度改用 PaxDb 实测数据 | 完成，见 `server/sources/paxdb.ts` |
| 二期·1 | 现成的整病毒、整细胞模型：新冠病毒颗粒、HIV、突触小泡、外泌体、整只支原体、核孔等 14 个 | 完成，见 `data/catalog.json`、`src/mol/load.ts`、`src/mol/coarse.ts` |

二期的目标是用更多真实数据扩大可画的范围，共八个阶段：现成模型（已完成）、用实测数据替换估计值（丰度、膜取向、脂质组成）、AlphaFold 扩展与逐残基标注、Nature/Science 最新结构、分子尺度的突触、神经元形态、细胞器网格、电镜密度图。

## 运行

```sh
bun install
bun run dev        # 网页 http://127.0.0.1:5184 ，本地服务 127.0.0.1:5185
bun run test
bun run typecheck
```

四种用法：

- **按主题**：输入“CRISPR-Cas9 切割 DNA”“新冠刺突蛋白结合 ACE2”“TP53”这样的话。需要本机装有并登录了 [Claude Code](https://claude.com/claude-code)（用 `claude -p` 调用，不需要 API key）。一次解析约半分钟。
- **按编号**：直接输入 4 位 PDB 编号，或 `AF-` 加 UniProt 编号（如 `AF-P04637`）载入 AlphaFold 预测模型，或 `EMD-` 加数字（如 `EMD-1080`）载入一张电镜密度图。不需要 `claude`。例如 `2hhb`（血红蛋白）、`6vxx`（新冠刺突蛋白）、`1m4x`（PBCV-1 病毒衣壳，1600 万原子）。

- **最新发表**：选一个期刊和时间范围，列出 RCSB 里这段时间公开的结构，按论文归并，点编号出图。需要本地服务，不需要 `claude`。
- **现成模型**：从列表里点一个已发表的整体模型，不需要 `claude`。同一页还有“整个细胞（电镜）”和“神经元的形态”，以及“神经系统的分子”：按突触前、突触后、轴突、髓鞘、病理纤维分组的 38 个地标结构。按主题输入“新冠病毒长什么样”这类话时，也会自动用上对应的现成模型。

拖动旋转，滚轮缩放，Shift 拖动平移。每张图（包括导出的 PNG）右下角有一条比例尺；画面是正交投影，所以它对整张图都准确。“剖开”滑杆从前面切掉一部分，看病毒或细胞的内部；切的时候整个分子一起保留或去掉，不会出现被切了一半的蛋白。

单个分子的图可以换“上色”方式：按功能角色（默认）、按结构域、标出活性与结合位点（都来自 UniProt，PDB 的残基号经 PDBe SIFTS 对应过去）、按 AlphaFold 置信度（只对预测模型）、按 AlphaMissense 预测的突变致病性（只覆盖人类蛋白；是预测，不是临床结论）。图例里写明每种颜色的含义和数据来源。

预测结构有三种来源，界面上都标为“预测”：`AF-<UniProt 编号>` 先查 AlphaFold 数据库；查不到时用 [BFVD](https://bfvd.steineggerlab.workers.dev/)（CC BY 4.0），它收录了 AlphaFold 数据库里没有的许多病毒蛋白，例如 HIV-1 的 Gag（`AF-P04591`）。载入一个预测蛋白后，侧栏会列出 AlphaFold 数据库里含有它的预测复合物和各自的界面可信度 ipTM（低于 0.6 的不列），点一下即可画出；复合物里链与链怎样结合是预测，不是实验结果。

主题如果是一个拥挤的细胞场景（“大肠杆菌细胞质的拥挤场景”“流感病毒包膜表面的横截面全景”），会画成全景：80×56 nm、厚 30 nm 的一片截面，可以带一层水平的膜。

可调的环境变量：`LIMN_MODEL`（默认 `sonnet`）、`LIMN_CLAUDE_BIN`、`LIMN_PORT`、`LIMN_CACHE`（运行时写数据的目录；不设时用 `WORLD_SIM_STATE`，再不然是源码旁的 `.cache/`）。

本地服务会把取过的结构文件缓存在这个目录的 `structures/` 下（只从白名单里的几个公共数据库主机下载），下次打开不用再联网。服务没启动时，网页直接从原地址取。

### 在 idea-loom 里

world-sim 的统一入口 idea-loom 会托管 limn（`http://limn.localhost:8767/`），卡片列表在 `sim.json`。每张卡是一个直达链接：`/?model=<目录 id>` 或 `/?id=<PDB 编号>`。加上 `?embed=1` 时只留画面，上面一条标题栏（标题、出处、“剖开”滑杆），在 320–400 px 宽的卡片里实测过不压画面；不带其他参数时画新冠病毒颗粒。

界面有中文和英文两种语言：侧栏顶上的按钮切换，选择记在浏览器里；网址里加 `?lang=zh` 或 `?lang=en` 可以指定（嵌入模式也认）。界面文字都在 `src/i18n.ts` 的两张表里；模型写的标题、说明和注释保持主题所用的语言。

## 它怎么保证画的是真的

1. **模型不出像素，也不出坐标。** 画面完全由 PDB 的原子坐标确定性渲染。
2. **模型不能编造结构编号。** 解析分三步：模型说要找什么 → 代码去 RCSB、UniProt、PDBe 查 → 模型只能在查回来的候选里选（选项是候选编号的枚举，不在其中的一律丢弃）。模型凭记忆提到的编号只当作检索线索，要经 RCSB 确认存在并取回真实的描述后才会成为候选。
3. **看图精修只能改呈现，而且改了要比出来确实更好才留下。** 评审给同一张图打的分自己就会跳半分到一分（同一张血红蛋白图评四次：6.5、7、7、7），所以不靠分数判断。每轮最多改三项，改完把改之前和改之后的两张图交给评审直接比较（哪张叫 A 是随机的），更好才保留，否则立刻退回并记下“这个改法没用”；连续两轮没有改进就停。 评审能做的操作是一份白名单：转视角、缩放、改颜色角色、调线条和阴影。换结构、动坐标不在其中，见 `src/refine/edits.ts`。
4. **说明出处和局限。** 界面列出每个面板的 PDB 编号、实验方法、分辨率、年份和选它的理由，以及这个结构的论文（标题、作者、期刊、年份、DOI 链接）；AlphaFold 预测模型会明确标注，低置信度区域不画。论文大多不是开放获取的，所以只显示书目信息并链接到原文；只有 Europe PMC 标明开放获取并带知识共享许可的论文才显示摘要。不转载论文的图和正文。

多个面板的机理图里，各面板比例相同，并按共同的蛋白链叠合到同一朝向。

## 现成模型里什么是真的，什么不是

目录（`data/catalog.json`）里有两类东西，界面上分别标为“实测”和“整理的模型”：

- **实测**：PDB 里的实验结构，例如完整的 HIV-1 衣壳（3J3Q）、寨卡病毒（5IRE）。
- **实测位置和朝向**：目录里有一项来自冷冻电镜断层扫描（[CZ CryoET Data Portal](https://cryoetdataportal.czscience.com/) 数据集 10003，CC0）：一片肺炎支原体细胞里 331 个核糖体各自的位置和朝向都是实测的，每个位置上放的是同种细胞里解出的 70S 核糖体原子模型（PDB 7P6Z）。数据集没有说明朝向矩阵该怎么读，这是用断层扫描本身检验出来的（`research/cryoet/orient.py`）：按“断层扫描里的位置 = 粒子位置 + R·模板里的偏移”把每个粒子周围的密度叠起来，得到形状清楚的核糖体（起伏 0.74），按转置叠只是一个球（0.32）；再把原子模型对到这个平均密度上，六个不同起点都收敛到同一个朝向，换一张独立的断层扫描得到的朝向相差不到 4 度。镜像后的模型拟合得更好（两张图分别是 0.76 对 0.71、0.83 对 0.78），所以判断这批断层扫描相对原子模型是镜像的，画的时候把整个场景沿一个方向翻了过来；这一点是从相关系数推断的，把握不如前两点。另一个独立的迹象：相邻核糖体互相穿插的程度，用实测朝向时是随机朝向时的四分之一左右。放置精度约 1 nm、几度。细胞膜和其他分子没有画。
- **整理的模型**：别人已发表的整体模型，例如 PetWorld 的新冠病毒颗粒、cellPACK 的 HIV 和整只生殖支原体。其中每个分子是真实结构或同源模型，**位置和数量是模型作者依据实验数据排布的，不是直接观测到的**。核孔复合体这类整合结构同理：由多种实验数据拼合而成。

画法上做了三件要说明的事：

- 整张膜画成一片，不逐个脂质描边；纤维（DNA、RNA）的一节节片段连成一条，不分段描边。
- 比线还细的东西会被画粗一点，否则会被自己的描边吞掉（Goodsell 也这样做）。所以整细胞图里 DNA 细丝比实际略粗。
- 原子数超过约 4500 万的模型（整只支原体有 1.61 亿）自动改成每个残基画一个球，界面上会说明。

目录只存指针、出处和许可，模型在运行时从原地址下载，不入库。各模型的许可不同（CC0、MIT、CC BY-SA 4.0，有几个文件没有附许可声明），界面上逐条列出；用这些图时请按原作者的许可署名。

## 密度图和细胞器：表面是怎么画的

电镜密度图（[EMDB](https://www.ebi.ac.uk/emdb/)，CC0）和整个细胞的细胞器分割（[OpenOrganelle](https://openorganelle.janelia.org/)，CC BY 4.0）都不是原子，而是三维的体数据。limn 把它们的表面画成三角网格：先找出表面穿过的每个小格，在每格里放一个顶点（“表面网”法），再把相邻小格的顶点连成面（`src/volume/mrc.ts` 的 `surfaceMesh`）。网格平涂，不用法线，描边和阴影照旧只从深度和编号算。细胞器是实心的，剖开时切口画成平的断面；密度图的等值面剖开时看到的是壳的里面，叠在里面的原子模型因此露出来。

四期之前没有三角网格，表面是在每个顶点上放一个略小于一个体素的球拼出来的。那种画法留着做对照：地址里加 `?prim=spheres` 就用它。同一视角下两种画法的差别（1400 像素的图）：GroEL 的密度图（EMD-1080）有 19% 的主体像素不同，网格画出的面积是小球的 0.91 倍，因为小球把表面往外撑了将近一个体素，孔被填小了；HeLa 细胞有 57% 的主体像素不同，其中 99% 在轮廓线 3 像素以内，主要来自两处：细胞核等被切开的地方现在是平的断面，薄的内质网不再被小球撑胖，线因此更密。我的判断是网格更接近数据，但 HeLa 细胞里内质网那一片的线比以前更碎，不一定更好看。

- **密度图**画的是作者建议的阈值处的等值面；阈值高一点或低一点，表面会瘦一点或胖一点。大的图会先把体素合并到最长边 200 以内。条目里有拟合的原子模型时，模型叠在里面：密度图从正中剖开，模型不切。
- **细胞器**用的是原数据缩小 16 倍的版本（每个体素约 64×64×84 nm），比这更细的结构看不出来或者断开；边界是机器学习模型逐个体素判断的，不是人工描的。默认从上往下看、在半高处剖开，细胞膜没有画。核膜算在内质网的分割里，紧贴着细胞核表面；贴着细胞核两个体素以内的其他细胞器没有画，免得两层表面叠在一起。
- 这两类图的坐标单位分别是 Å 和 nm。每张图右下角都有比例尺，自动换成读起来顺的单位。

## 神经元形态图

“现成模型”页里的“神经元的形态”画的不是原子，而是从显微图像描出来的整个神经元（[NeuroMorpho.Org](https://neuromorpho.org/)，CC BY 4.0），单位是微米。每个节点画一个球，每一段分支画成连着两端的一段圆台（“胶囊”），粗细按两端的半径线性过渡；片元里直接求视线和圆台的交点（`src/render/capsule.ts` 里有这段算式的可测版本）。四期之前每一段是用一串紧挨着的球填出来的（球心间距是半径的三分之一），`?prim=spheres` 仍可切回那种画法：浦肯野细胞现在是 4,153 段，五个 MICrONS 细胞从 68 万个球变成约 3 万段，画出来的面积相差不到 1%。

- 分支的走向是重建数据；粗细也来自重建，但重建里的粗细常常不如走向可靠。
- 比线还细的分支画粗了一点，否则会整条被描边盖住。
- 目录里四个重建都没有轴突（原作者没有描），界面上写明了。
- “检索 NeuroMorpho.Org”可以按物种、脑区、细胞类型（用英文，如 mouse、cerebellum、Purkinje）查它的三十万个重建。点名字单独画，点 “+” 并排加入，最多四个，同一比例。
- 并排不等于相邻：NeuroMorpho 的标准化文件把每个神经元的胞体都放在原点，它们在脑里的相对位置不在数据里，所以只能比较形状和大小。
- **连接组里相邻的细胞**：列表最后一项“小鼠视皮层里五个相邻的神经元”来自 [MICrONS](https://www.microns-explorer.org/cortical-mm3)（一立方毫米小鼠视皮层的电镜连接组，minnie65 数据集的 v661 版骨架，[doi:10.1038/s41586-025-08790-w](https://doi.org/10.1038/s41586-025-08790-w)）。这些骨架在同一个坐标系里，所以五个细胞按它们在脑里的真实相对位置叠在一起画，每个细胞一个色相，皮层表面朝上。细胞是这样挑的：在骨架文件大小 150–900 KB 的前 500 个里，取胞体彼此最近的五个（相距不到 20 微米）；只画离它们 260 微米以内的部分，伸得更远的轴突在边界截断，图下的说明里写了。**许可**：我查了 MICrONS 的主页、数据页、服务条款页和 BossDB 的项目页，都没有找到许可声明。所以骨架只在使用时从 BossDB 的公开存储下载，不入库；界面上的来源一栏写着“没有找到许可声明”。H01 没有接。

## 全景图里什么是真的，什么不是

真的：每个分子都是 PDB 里的实验结构，按同一比例画；分子之间不重叠；各区室画出的大分子总质量与该区室的总浓度相符。

不是观测结果，界面上也都写明了：

- **位置和朝向是随机排布的。** 可溶分子在各自区室里随机放置；真实细胞里的结合关系、排列（例如贴在膜内侧的基质蛋白层）没有体现。
- **丰度优先用实测数据，查不到才是估计值。** 配方由模型拟定：列出十来种有代表性的分子。场景属于某个物种的细胞时，蛋白的丰度取自 [PaxDb](https://pax-db.org/)（整合了多项质谱研究的丰度数据库，覆盖大肠杆菌、酵母、人和小鼠的各种组织等四百多个物种）；复合物取各亚基的中位数，再除以每种亚基的份数。PaxDb 里查不到的成分和膜蛋白的面密度仍是模型的估计。界面上每种成分都标明是“实测数据”还是“估计”。把亚基丰度换成复合物丰度时，“一个复合物里每种亚基有几份”优先取自 [Complex Portal](https://www.ebi.ac.uk/complexportal/) 的人工整理（例如 GroEL 是 14 份），查不到才按结构里的链数推。
- **可以用你自己的拷贝数表。** 有些定量数据不开放（例如 Wilhelm 等 2014 年测的突触小体里各种蛋白的拷贝数），不能放进仓库。有权限的话，把它存成 `<状态目录>/copy-numbers.tsv`：每行“基因名、拷贝数”，并加一行 `# volume_um3: 0.37` 写明这些拷贝数对应的体积；配方会优先用它，并标为“你提供的拷贝数表”。这条路只用我自己造的小表测过，没有用真实的表验证过。除标为主角的成分外，数量按比例放大到区室总浓度，用这十来种代表其余上千种。
- **膜蛋白的取向优先用 OPM，其次 PDBTM。** OPM 没有收录的跨膜结构，用 [PDBTM](https://pdbtm.unitmp.org/) 给出的变换摆进膜里，再按 UniProt 的拓扑注释（哪些残基在胞外、哪些在胞质）决定哪面朝外；拓扑注释不够用时不采用。 [OPM](https://opm.phar.umich.edu/) 数据库收录的结构，按它给出的位置、倾角和内外朝向嵌进膜里（这是由实验结构计算出来的取向，不是直接测量）；界面上会标出。OPM 没有收录的（多数只解析了膜外段的结构）仍是近似摆放：沿分子长轴竖立，立在膜面上，连膜的一端由链末端的位置判断，缺失的柄部和跨膜段不画。膜蛋白正前方的脂质不画，好让跨膜的部分露出来。
- **膜的脂质组成取自文献，构象是示意的。** 八类膜（哺乳动物质膜、内质网、线粒体内膜、大肠杆菌内膜和外膜、HIV 和新冠病毒的包膜、突触小泡）的组成写在 `data/membranes.json` 里，每条都有出处，并说明哪些是分小叶实测的、哪些只有整膜数据、哪些是综述给的范围（例如质膜两个小叶的磷脂是实测的，胆固醇在两叶之间怎么分没有测到）。画的时候两个小叶各按比例混排。每种脂质用数据库里的理想坐标，尾链整体转到头基的另一侧，再做一次几何松弛把挤在一起的原子推开（九种脂质里，不直接相连的原子最近也有 2.5 Å，键长偏差不超过 0.03 Å）；这不是力场，也不是模拟；所有同种脂质构象相同，位置随机，不是模拟得到的膜。缩醛磷脂并入 PE，糖脂和脂多糖的长糖链没有画。配方没有指明膜的类型时，仍用单一的 POPC。
- **DNA 是程序生成的。** 场景里有 DNA 时（细菌拟核、细胞核），画成双螺旋长链：每个碱基对的原子位置量自晶体结构 1BNA，螺旋参数用溶液中 B 型 DNA 的通用值（每对升 3.4 Å、每圈 10.5 对），走向是按 DNA 的刚度（持久长度约 50 nm）随机弯曲的曲线，序列随机，总长度按模型估计的 DNA 密度换算。DNA 上结合的蛋白、超螺旋和核小体没有画。
- **没有画**：水、离子、小分子，以及 RNA 长链和细胞骨架纤维。

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
- **`data/cells.json`**：整细胞分割数据在 OpenOrganelle 上的地址和出处（Heinrich 等，*Nature* 2021；Xu 等，*Nature* 2021；CC BY 4.0）；数据运行时下载。
- **电镜密度图**：运行时按编号从 EMDB 下载（CC0），经本地服务缓存。
- **`data/neurons.json`**：四个神经元重建在 NeuroMorpho.Org 上的名字、档案和原始论文的 DOI；重建文件运行时下载，不入库。NeuroMorpho.Org 以 CC BY 4.0 发布。另有一组 MICrONS 连接组细胞的编号，骨架运行时从 BossDB 的公开存储下载，不入库；没有找到这份数据的许可声明。
- **`data/neuro.json`**：38 个神经相关结构的 PDB 编号和一句说明，每个编号都对过 RCSB 的标题。
- **膜蛋白取向（后备）**：运行时查询 [PDBTM](https://pdbtm.unitmp.org/)；它的条款只允许非营利使用且不得修改，所以只在运行时取用、注明来源，不入库。
- **膜蛋白取向**：运行时从 [OPM](https://opm.phar.umich.edu/) 下载预先定向的坐标，只取 Cα 位置和膜的半厚度，缓存在本机，不入库。OPM 的许可条款我没有查到原文，所以只在运行时取用、标明来源。
- **蛋白丰度**：运行时从 [PaxDb](https://pax-db.org/) 下载对应物种和组织的整合数据集，缓存在本机，不入库。
- **现成模型**（`data/catalog.json`，只存指针）：[Mesoscale Explorer](https://mesoscope.scripps.edu/explorer/) 的示例文件，包括 YASARA [PetWorld](http://download.yasara.org/petworld/)（CC BY-SA 4.0；Ozvoldik 等，*J. Chem. Inf. Model.* 2021）和 [cellPACK](https://github.com/mesoscope/cellPACK_data)（数据仓库为 MIT）的模型、生殖支原体整细胞模型（MIT；Maritan 等，*J. Mol. Biol.* 2022），以及 RCSB 里的整合结构（PDB-IHM，CC0）。
- **`data/membranes.json`**：八类膜按脂质类别的摩尔组成，数字取自所列文献（Lorent 等 2020、Vance 2015、Rowlett 等 2017、Brügger 等 2006、Saud 等 2022、Takamori 等 2006 等），每条注明测量的范围和局限。脂质坐标运行时取自 RCSB 化学组分库（CC0）。
- **`data/bdna.json`**：四种碱基对在螺旋坐标系里的原子位置，由 `bun server/tools/build_bdna.ts` 从 PDB 1BNA（CC0；Drew 等，*PNAS* 1981）量出。
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
| Round 3 | The interface checked by hand, with layout fixes; scale bars; a bilingual interface (`?lang=en`); AlphaFold predicted complexes; BFVD predictions of viral proteins; Complex Portal stoichiometry; NeuroMorpho search and several neurons side by side; an import path for a copy-number table of your own | Done. Connectome datasets such as MICrONS are not connected (no licence statement was found) |
| Round 4 | Three small fixes; the review loop compares pairs and can undo; geometric relaxation of lipid conformers; measured orientations for ribosomes; neighbouring neurons from the MICrONS connectome; two new primitives (round cones and triangle meshes) | These are done; the very large models (synapse, whole influenza virion, syn3A) are not done yet |
| Round 2, phase 7 | Whole-cell organelles: electron-microscopy segmentations from OpenOrganelle (the nucleus, endoplasmic reticulum, mitochondria, Golgi and endosomes of a HeLa cell) | First version done, see `src/volume/n5.ts`, `data/cells.json` |
| Round 2, phase 8 | Electron-microscopy density maps: an EMDB map loads as `EMD-<number>`, drawn as the isosurface at its authors' recommended level, with the fitted atomic model inside | First version done, see `src/volume/mrc.ts`, `server/sources/emdb.ts` |
| Round 2, phase 6 | Neuron morphologies: microscopy reconstructions from NeuroMorpho.Org (pyramidal cells, a Purkinje cell and others), coloured by soma, dendrite and axon | First version done, see `src/neuro/swc.ts`, `data/neurons.json` |
| Round 2, phase 5 | The nervous system at molecular scale: 38 landmark structures (presynaptic, postsynaptic, axon, myelin, fibrils of disease); a PDBTM fallback for membrane protein orientation | Done, see `data/neuro.json`, `server/sources/pdbtm.ts` |
| Round 2, phase 4 | Recently published: the structures most recently released for a journal (Nature, Science, Cell and others), one click to draw; the provenance shows the paper | Done, see `server/sources/literature.ts` |
| Round 2, phase 2d | Real lipid compositions of membranes (eight kinds, mixed per leaflet), with lipid tails turned to one side | Done, see `data/membranes.json`, `src/landscape/lipid.ts` |
| Round 2, phase 3a | Per-residue colouring: domains, active and binding sites, AlphaFold confidence, AlphaMissense pathogenicity; predicted models load directly as `AF-<UniProt accession>` | Done, see `src/style/annotate.ts`, `server/sources/annotations.ts` |
| Round 2, phase 2e | Measured particle positions from a cryo-electron tomogram: 331 ribosomes in a slice of mycoplasma cells | Done, see `src/mol/points.ts` and `mycoplasma-ribosomes-in-situ` in the catalogue |
| Round 2, phase 2c | Long DNA in landscapes, as a generated double helix | Done, see `src/landscape/fiber.ts`, `data/bdna.json` |
| Round 2, phase 2b | Membrane proteins sit in the membrane as OPM orients them | Done, see `server/sources/opm.ts`, `src/landscape/orient.ts` |
| Round 2, phase 2a | Protein abundances in landscapes come from PaxDb measurements | Done, see `server/sources/paxdb.ts` |
| Round 2, phase 1 | Ready-made whole virions and cells: a SARS-CoV-2 virion, HIV, a synaptic vesicle, an exosome, a whole mycoplasma cell, nuclear pores; 14 models | Done, see `data/catalog.json`, `src/mol/load.ts`, `src/mol/coarse.ts` |

Round 2 widens what can be drawn by bringing in more real data, in eight phases: ready-made models (done), measured data in place of estimates (abundance, membrane orientation, lipid composition), AlphaFold extensions and per-residue annotation, recent structures from Nature and Science, the synapse at molecular scale, neuron morphologies, organelle meshes, and electron-microscopy density maps.

## Running it

```sh
bun install
bun run dev        # web app on http://127.0.0.1:5184 , local service on 127.0.0.1:5185
bun run test
bun run typecheck
```

Four ways in:

- **By topic**: type something like "CRISPR-Cas9 cutting DNA", "the SARS-CoV-2 spike bound to ACE2" or "TP53". This needs [Claude Code](https://claude.com/claude-code) installed and signed in on the machine (it is called as `claude -p`; no API key is needed). One resolution takes about half a minute.
- **By id**: type a four-character PDB id, or `AF-` followed by a UniProt accession (`AF-P04637`) for an AlphaFold predicted model, or `EMD-` followed by a number (`EMD-1080`) for an electron-microscopy density map; `claude` is not needed. Examples: `2hhb` (haemoglobin), `6vxx` (the SARS-CoV-2 spike), `1m4x` (the PBCV-1 capsid, 16 million atoms).
- **Recently published**: choose a journal and a period to list the structures the RCSB released in it, grouped by paper; click an id to draw it. This needs the local service but not `claude`.
- **Ready-made models**: pick a published whole model from the list; `claude` is not needed. The same tab also holds "a whole cell (electron microscopy)" and "shapes of neurons", and "molecules of the nervous system": 38 landmark structures grouped as presynaptic, postsynaptic, axon, myelin and fibrils of disease. A topic such as "what does the coronavirus look like" also resolves to the matching ready-made model.

Drag to rotate, scroll to zoom, shift-drag to pan. Every picture, exported PNGs included, has a scale bar at bottom right; the projection is orthographic, so the bar holds across the whole picture. The "cut" slider removes the front of the subject to show the inside of a virus or a cell; whole molecules are kept or dropped together, so no protein is ever shown sliced in half.

A picture of a single molecule can be recoloured: by functional role (the default), by domain, with active and binding sites picked out (both from UniProt, with PDB residue numbers mapped through PDBe SIFTS), by AlphaFold confidence (predicted models only), or by AlphaMissense's predicted pathogenicity of mutations (human proteins only; a prediction, not a clinical finding). The legend says what each colour means and where the data is from.

Predicted structures come from three places, all labelled as predictions: `AF-<UniProt accession>` looks in the AlphaFold DB first and, failing that, in [BFVD](https://bfvd.steineggerlab.workers.dev/) (CC BY 4.0), which holds many viral proteins the AlphaFold DB lacks, such as HIV-1 Gag (`AF-P04591`). Once a predicted protein is loaded, the sidebar lists the predicted complexes in the AlphaFold DB that contain it, each with its interface confidence ipTM (those under 0.6 are left out); one click draws it. How the chains of such a complex bind is a prediction, not an experimental result.

A topic that asks for a crowded cellular scene ("the crowded cytoplasm of E. coli", "a cross-section of the influenza envelope") is drawn as a landscape: a slab 80 × 56 nm and 30 nm thick, optionally with a horizontal membrane.

Environment variables: `LIMN_MODEL` (default `sonnet`), `LIMN_CLAUDE_BIN`, `LIMN_PORT`, and `LIMN_CACHE` (where run-time data is written; when unset, `WORLD_SIM_STATE` is used, and failing that `.cache/` next to the source).

The local service caches every structure file it has fetched under `structures/` in that directory (it downloads only from a short allowlist of public database hosts), so opening the same thing again needs no network. When the service is not running, the page fetches straight from the source.

### Inside idea-loom

idea-loom, the single entry point of world-sim, hosts limn at `http://limn.localhost:8767/`; the cards are listed in `sim.json`. Each card is a deep link: `/?model=<catalogue id>` or `/?id=<PDB id>`. With `?embed=1` only the stage remains under a title strip (title, provenance, cut slider), checked in cards 320-400 px wide so that nothing sits on the picture; with no other parameter it draws the SARS-CoV-2 virion.

The interface comes in Chinese and English: the button at the top of the sidebar switches, and the choice is remembered in the browser; `?lang=zh` or `?lang=en` in the address sets it (embed mode follows it too). All interface text is in the two tables of `src/i18n.ts`; titles, captions and notes written by the model stay in the language of the topic.

## How it keeps the picture true

1. **The model produces neither pixels nor coordinates.** The picture is rendered deterministically from atomic coordinates.
2. **The model cannot invent a structure id.** Resolution has three steps: the model says what to look for; code looks it up in RCSB, UniProt and PDBe; the model may then choose only among what came back (the choice is an enumeration of the candidate ids, and anything else is discarded). Ids the model recalls from memory are search hints only; each must be confirmed by RCSB, and its real description fetched, before it becomes a candidate.
3. **The review loop can change presentation only, and a change stays only if a direct comparison shows it is better.** The score a reviewer gives one picture wanders by half a point to a point by itself (one haemoglobin picture scored four times: 6.5, 7, 7, 7), so scores are not what decides. Each round makes at most three changes, then the pictures before and after are given to the reviewer to compare directly (which is called A is random); the change is kept only if it is better and is otherwise undone at once, with a note that it did not help, and two rounds in a row without improvement end the loop. What a reviewer may do is a whitelist: turn the view, zoom, cut, change colour roles, adjust lines and shadows. Swapping structures or moving atoms is not on it; see `src/refine/edits.ts`.
4. **Provenance and limits are stated.** The interface lists each panel's PDB id, method, resolution, year and the reason it was chosen, and the structure's paper (title, authors, journal, year, a DOI link). AlphaFold predictions are labelled as such, and their low-confidence regions are not drawn. Most papers are not open access, so only bibliographic facts are shown, with a link to the original; an abstract appears only when Europe PMC marks the paper open access under a Creative Commons licence. No figure or body text of a paper is reproduced.

In a multi-panel mechanism figure every panel is at the same scale, and panels are superposed on their shared protein chain so that they face the same way.

## What is real in a ready-made model, and what is not

The catalogue (`data/catalog.json`) holds two kinds of thing, labelled "measured" and "curated model" in the interface:

- **Measured**: experimental structures in the PDB, such as the entire HIV-1 capsid (3J3Q) or Zika virus (5IRE).
- **Measured positions and orientations**: one catalogue entry comes from cryo-electron tomography ([CZ CryoET Data Portal](https://cryoetdataportal.czscience.com/) dataset 10003, CC0): the positions and orientations of 331 ribosomes in a slice of Mycoplasma pneumoniae cells are both measured, and at each stands the atomic model of the 70S ribosome solved in the same kind of cell (PDB 7P6Z). The dataset does not say how its orientation matrices are to be read, so that was settled from the tomogram itself (`research/cryoet/orient.py`): stacking the density around every particle by "position in the tomogram = particle position + R x offset in the template" gives a ribosome of clear shape (relief 0.74), while stacking by the transpose gives only a ball (0.32); fitting the atomic model to that average converges on one orientation from six different starts, and an independent tomogram gives an orientation under 4 degrees away. The mirrored model fits better (0.76 against 0.71 and 0.83 against 0.78 on the two tomograms), so these tomograms are taken to be mirror images relative to the atomic model and the whole scene is flipped along one direction when drawn; that point is inferred from correlation coefficients and is less certain than the first two. One more independent sign: neighbouring ribosomes run into one another about a quarter as much with the measured orientations as with random ones. Placement is good to about 1 nm and a few degrees. The cell membrane and all other molecules are not drawn.
- **Curated models**: whole models that others have published, such as PetWorld's SARS-CoV-2 virion and cellPACK's HIV virion and whole Mycoplasma genitalium cell. Each molecule in them is a real structure or a homology model; **where the molecules are and how many there are was arranged by the model's authors from experimental data, and was not observed directly**. The same holds for integrative structures such as the nuclear pore complex, which are assembled from several kinds of experiment.

Three things about how they are drawn:

- A membrane is drawn as one sheet, without an outline around each lipid; the segments of a fibre (DNA, RNA) are joined into one strand, without an outline around each segment.
- Anything thinner than the line is drawn a little fatter, or its own outline would swallow it (Goodsell does the same). So the DNA strands in a whole-cell picture are slightly thicker than in life.
- A model with more than about 45 million atoms (the whole mycoplasma cell has 161 million) is drawn with one sphere per residue instead, and the interface says so.

The catalogue stores pointers, provenance and licences only; models are downloaded from their home at run time and are not in this repository. Licences differ (CC0, MIT, CC BY-SA 4.0, and a few files carry no licence statement) and are listed per model in the interface. If you use the pictures, credit the original authors as their licence requires.

## Density maps and organelles: how surfaces are drawn

Electron-microscopy density maps ([EMDB](https://www.ebi.ac.uk/emdb/), CC0) and whole-cell organelle segmentations ([OpenOrganelle](https://openorganelle.janelia.org/), CC BY 4.0) are not atoms but three-dimensional volumes. limn draws their surfaces as triangle meshes: every cell of the grid that the surface passes through gets one vertex (the "surface nets" method), and the vertices of neighbouring cells are joined into faces (`surfaceMesh` in `src/volume/mrc.ts`). A mesh is filled flat and uses no normals; outlines and shadows come from depth and ids as everywhere else. Organelles are solid, so a cut through one is drawn as a flat section; the isosurface of a density map shows the inside of its shell when cut, which is what lets the atomic model inside it be seen.

Before round 4 there were no triangle meshes, and a surface was built by putting a sphere a little smaller than a voxel on every vertex. That way of drawing is kept for comparison: add `?prim=spheres` to the address to use it. How the two differ at the same view (pictures 1400 pixels across): for the GroEL density map (EMD-1080) 19% of the subject's pixels differ and the mesh covers 0.91 times the area of the spheres, because the spheres push the surface out by nearly a voxel and close up the holes; for the HeLa cell 57% of the subject's pixels differ, 99% of them within 3 pixels of an outline, mostly from two things: the nucleus and whatever else is cut open is now a flat section, and thin endoplasmic reticulum is no longer fattened by spheres, so its lines are denser. My judgement is that the mesh is closer to the data, but the lines over the endoplasmic reticulum in the HeLa cell are more broken up than before and not necessarily better looking.

- A **density map** is drawn as the isosurface at the level its authors recommend; a slightly higher or lower level gives a slightly thinner or fatter surface. A large map is first binned to at most 200 voxels a side. When the entry has a fitted atomic model, the model goes inside: the map is cut through the middle and the model is left whole.
- **Organelles** use the data reduced sixteen-fold (voxels of about 64 × 64 × 84 nm), so anything finer is lost or broken up; the boundaries were decided voxel by voxel by a machine-learning model, not traced by hand. By default the cell is seen from above and cut at mid-height, and the plasma membrane is not drawn. The nuclear envelope belongs to the ER segmentation and lies right on the surface of the nucleus; whatever of another organelle is within two voxels of the nucleus is not drawn, so that two coincident surfaces do not fight.
- Coordinates in these two kinds of picture are in Å and in nm respectively. Every picture carries a scale bar at bottom right, in whichever unit reads well.

## Neuron morphology pictures

"Shapes of neurons", on the ready-made models tab, draws not atoms but whole neurons traced from microscope images ([NeuroMorpho.Org](https://neuromorpho.org/), CC BY 4.0), in microns. The drawing method is the one used for molecules: each node is a sphere and each stretch of a branch is a round cone (a "capsule") joining its two ends, tapering linearly between their radii; the fragment shader finds where the line of sight meets the cone directly (`src/render/capsule.ts` holds a testable copy of the algebra). Before round 4 each stretch was filled with a run of closely spaced spheres (centres a third of a radius apart), and `?prim=spheres` still switches back to that: the Purkinje cell is now 4,153 segments, and the five MICrONS cells go from 680 thousand spheres to about 30 thousand segments, with the drawn area differing by under 1%.

- Where a branch runs is the reconstruction's data; so is its thickness, though thickness in reconstructions is often less reliable than course.
- A branch thinner than the line is drawn a little fatter, or its outline would cover it from side to side.
- None of the four reconstructions in the catalogue has an axon (the original authors did not trace it), and the interface says so.
- "Search NeuroMorpho.Org" queries its three hundred thousand reconstructions by species, region and cell type (in English: mouse, cerebellum, Purkinje). Click a name to draw it alone, or "+" to add it alongside, up to four at one scale.
- Side by side is not next to each other: NeuroMorpho's standardised files put every neuron's soma at the origin, and where neurons lie relative to one another in the brain is not in the data, so only shape and size can be compared.
- **Neighbouring cells of a connectome**: the last item of the list, "Five neighbouring neurons of the mouse visual cortex", comes from [MICrONS](https://www.microns-explorer.org/cortical-mm3) (the electron-microscopy connectome of a cubic millimetre of mouse visual cortex; skeletons v661 of the minnie65 dataset, [doi:10.1038/s41586-025-08790-w](https://doi.org/10.1038/s41586-025-08790-w)). These skeletons share one coordinate frame, so the five cells are drawn where they really lie relative to one another, one hue per cell, with the cortical surface at the top. The cells were chosen like this: among the first 500 skeleton files of 150–900 KB, the five whose somas are closest together (within 20 microns). Only the parts within 260 microns of them are drawn; axons that run further are cut at that boundary, and the notes under the picture say so. **Licence**: I looked at MICrONS's home page, data page and terms page and at BossDB's project page and found no licence statement. The skeletons are therefore downloaded from BossDB's open storage only when used and are not in this repository, and the source panel reads "no licence statement found". H01 is not connected.

## What is real in a landscape, and what is not

Real: every molecule is an experimental structure from the PDB, drawn at one scale; molecules do not overlap; the total mass of macromolecules drawn in each compartment matches that compartment's overall concentration.

Not observed, and said so in the interface:

- **Positions and orientations are random.** Soluble molecules are scattered within their compartment; real binding partners and arrangements (a matrix layer under a membrane, say) are not represented.
- **Abundances are measured where possible and estimated otherwise.** The recipe is proposed by the model: a dozen representative molecules. When the scene is one organism's cell, protein abundances come from [PaxDb](https://pax-db.org/), a database that integrates many mass-spectrometry studies and covers over four hundred organisms, including E. coli, yeast, and many human and mouse tissues; a complex takes the median over its subunits, divided by the number of copies of each. Ingredients PaxDb does not have, and the surface density of membrane proteins, are still the model's estimates. The interface marks every ingredient as measured data or an estimate. When subunit abundance is turned into complex abundance, the number of copies of each subunit per complex comes from the hand-curated [Complex Portal](https://www.ebi.ac.uk/complexportal/) where it has the complex (14 for GroEL, say), and from the chain count of the structure otherwise.
- **You can bring a copy-number table of your own.** Some quantitative data is not open (the copy numbers of proteins in a synaptic bouton measured by Wilhelm et al. 2014, for one) and cannot be in the repository. With access, save it as `<state directory>/copy-numbers.tsv`: one "gene, copies" per line, plus a line `# volume_um3: 0.37` giving the volume the copy numbers refer to; recipes then prefer it and label it as your table. This path was tested only with a small table I made up, never with the real one. Apart from the featured ones, counts are scaled up to the compartment's total concentration, so that a dozen kinds stand in for the thousand others.
- **Membrane proteins follow OPM where it has them, and PDBTM next.** A transmembrane structure that OPM lacks is set into the membrane by the transformation [PDBTM](https://pdbtm.unitmp.org/) gives, and UniProt's topology annotation (which residues are extracellular and which cytoplasmic) decides which face is out; when that annotation is not enough, the orientation is not used. A structure listed in the [OPM](https://opm.phar.umich.edu/) database is set into the membrane at the position, tilt and inside-outside sense OPM gives (an orientation computed from the experimental structure, not measured directly), and the interface says so. Structures OPM does not list (mostly those that cover only the part outside the membrane) are still placed approximately: standing along their long axis on the membrane face, with the membrane end judged from where the chain terminus is, and with missing stalks and transmembrane segments not drawn. Lipids straight in front of a membrane protein are left out so that the part spanning the membrane can be seen.
- **The membrane's lipid composition is from the literature; its conformations are schematic.** The compositions of eight membranes (the mammalian plasma membrane, the endoplasmic reticulum, the inner mitochondrial membrane, the inner and outer membranes of E. coli, the envelopes of HIV and SARS-CoV-2, and the synaptic vesicle) are in `data/membranes.json`, each with its source and a statement of what was measured per leaflet, what is known only for the whole membrane, and what is a range from a review (in the plasma membrane, for instance, the phospholipids of each leaflet were measured, but how cholesterol divides between the leaflets was not). Each leaflet is mixed to its own proportions. Each lipid uses its ideal coordinates from the database with its tails turned as a whole to the side away from the head group, followed by a geometric relaxation that pushes crowded atoms apart (across the nine lipids, atoms not bonded to each other stay at least 2.5 Å apart and bond lengths within 0.03 Å); this is neither a force field nor a simulation; all copies of a lipid share one conformation and are placed at random, so this is not a simulated membrane. Plasmalogens are counted with PE, and glycolipids and the long sugar chains of lipopolysaccharide are not drawn. When the recipe names no kind of membrane, a single phospholipid (POPC) is still used.
- **DNA is generated.** Where a scene holds DNA (a bacterial nucleoid, a nucleus) it is drawn as long double helix: the atoms of each base pair were measured from the crystal structure 1BNA, the helix uses the usual figures for B-DNA in solution (a rise of 3.4 Å per pair, 10.5 pairs per turn), its course is a curve that bends at random with DNA's own stiffness (a persistence length of about 50 nm), the sequence is random, and the total length follows the DNA density the model estimates. Proteins bound to the DNA, supercoiling and nucleosomes are not drawn.
- **Not drawn**: water, ions, small molecules, and long RNA and cytoskeletal filaments.

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
- **`data/cells.json`**: where the whole-cell segmentations are on OpenOrganelle, and their sources (Heinrich et al., *Nature* 2021; Xu et al., *Nature* 2021; CC BY 4.0); the data is downloaded at run time.
- **Electron-microscopy density maps**: downloaded by id from the EMDB at run time (CC0) and cached by the local service.
- **`data/neurons.json`**: the names, archives and original papers' DOIs of four neuron reconstructions on NeuroMorpho.Org; the reconstruction files are downloaded at run time and are not in this repository. NeuroMorpho.Org is released under CC BY 4.0. It also holds the ids of one set of MICrONS connectome cells, whose skeletons are downloaded at run time from BossDB's open storage and are not in this repository; no licence statement was found for that data.
- **`data/neuro.json`**: the PDB ids of 38 structures of the nervous system with a line each, every id checked against its RCSB title.
- **Membrane protein orientation (fallback)**: [PDBTM](https://pdbtm.unitmp.org/) is queried at run time; its terms allow non-profit use without modification only, so it is fetched at run time and credited, and nothing of it is in the repository.
- **Membrane protein orientation**: pre-oriented coordinates are downloaded from [OPM](https://opm.phar.umich.edu/) at run time; only Cα positions and the membrane half-thickness are used, cached locally, and none of it is in this repository. I could not find the text of OPM's licence, so the data is only fetched at run time and credited.
- **Protein abundance**: the integrated dataset for the organism and tissue is downloaded from [PaxDb](https://pax-db.org/) at run time and cached locally; none of it is in this repository.
- **Ready-made models** (`data/catalog.json`, pointers only): the example files of the [Mesoscale Explorer](https://mesoscope.scripps.edu/explorer/), which include models from YASARA [PetWorld](http://download.yasara.org/petworld/) (CC BY-SA 4.0; Ozvoldik et al., *J. Chem. Inf. Model.* 2021) and [cellPACK](https://github.com/mesoscope/cellPACK_data) (the data repository is MIT), the whole-cell model of Mycoplasma genitalium (MIT; Maritan et al., *J. Mol. Biol.* 2022), and integrative structures in the RCSB (PDB-IHM, CC0).
- **`data/membranes.json`**: the molar composition by lipid class of eight membranes, with numbers taken from the literature cited there (Lorent et al. 2020, Vance 2015, Rowlett et al. 2017, Brügger et al. 2006, Saud et al. 2022, Takamori et al. 2006 and others), each with what was measured and its limits. Lipid coordinates come from the RCSB Chemical Component Dictionary (CC0) at run time.
- **`data/bdna.json`**: the atoms of the four kinds of base pair in the frame of the helix, measured from PDB 1BNA (CC0; Drew et al., *PNAS* 1981) by `bun server/tools/build_bdna.ts`.
- **`data/motm.json`**: the title of each PDB-101 "Molecule of the Month" article and the PDB ids it mentions, used to prefer hand-picked representative structures. It contains no article text and no images.
- **Reference pictures**: Goodsell's originals come from the RCSB PDB-101 [Goodsell Gallery](https://pdb101.rcsb.org/sci-art/goodsell-gallery) and [Molecule of the Month](https://pdb101.rcsb.org/motm), licensed CC-BY-4.0. This repository **does not contain those images**, only statistics measured from them (in the style guide); `research/gallery/` and `research/out/` are ignored and can be fetched again with the scripts above.
- **Algorithms**: the outlines and shadows follow Goodsell's [Illustrate](https://github.com/ccsb-scripps/Illustrate) (Apache-2.0; Goodsell, Autin & Olson, *Structure* 2019). limn is a reimplementation and contains none of its source.
- **File parsing**: the CIF parser of [Mol\*](https://github.com/molstar/molstar) (MIT).

This project is not affiliated with David S. Goodsell, Scripps Research or the RCSB PDB; the style is a tribute.
