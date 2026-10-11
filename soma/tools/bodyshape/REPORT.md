# 体型：参考数据、人体测量模型、标定与方案 / Body shape: reference data, anthropometric model, calibration and proposal

2026-10-11。中文在前，English follows（两部分的数字和结论相同）。

---

# 中文

## 0. 结论一览

1. **参考数据的等级**：实测人体测量调查 > 由扫描学习且许可可用的统计体型模型 > 美术建模的参数化模型 > 绘画比例法则。动漫、插画和 AI 生成的人体不能当作真值：它们没有测量来源，比例是风格化或由模型“想象”的，无法溯源，也无法给出误差；抓取真人照片有肖像/同意和版权问题，本工作没有收集任何照片。
2. **可用的数据都已下载并打开**：ANSUR II（女 1986 人、男 4082 人、93 项测量）、NHANES 1999–2023 体格测量（成人女 30082、男 28908）。CAESAR、SizeUSA/UK、SizeKorea、中国个体级数据均不可再分发或需付费。**GB/T 10000-2023 的百分位表没有拿到**（官方在线阅读器防复制，只能人工抄录）；中国数据目前只有 GB/T 10000-1988 的二手转载和 2020 年国民体质监测公报的均值。
3. **人体测量模型**（`data/curated/bodyshape/anthro-model.json`）：每个性别用 4 个控制量——身高、BMI、腿长比例、体型分布（腰腹型–四肢型）——预测 50 项尺寸。只用身高+BMI 时，躯干高度类 R² 0.86–0.97，主要围度（胸、腰、臀、大腿、小腿、上臂）0.67–0.88，颈、踝、腕 0.42–0.66；加上两个体型因子后下肢高度类升到 0.87–0.96，腰围升到 0.89（女）/0.94（男）。
4. **我们的两个人体**：男性骨架肢段长度基本正常，但肩峰间宽只有 333 mm（比同身高男性低 5.5 个标准差）、前臂短 2.5 个标准差；皮肤 BMI 23.9。女性骨架肩胛带整体上抬约 5 cm、下肢偏短、前臂短 2.9 个标准差；现用皮肤（形变的男性皮肤）体积相当于 BMI 25.6，颈围 441 mm（超出女性样本上限）、胸围比 BMI 22 的女性大 14 cm、大腿根围反而小 3 cm，而且还带着男性外生殖器。
5. **参数化模型的标定**：MHR（Meta，Apache-2.0，由扫描学习）在四肢和臀围上与真人最接近（NHANES 五项围度平均 |z| 0.66–0.70）；Anny/MakeHuman（CC0，美术建模）腕和前臂明显偏细（男 −3 到 −5 个标准差）、踝偏粗、“体重”滑块在平均肌肉量下只能到 BMI 23–26（平均 |z| 0.99–1.11）。
6. **体型模型方案**（`shape-model.json`）：你设想的三部分（骨架分段缩放、皮肤沿法向的脂肪位移、肌肉横截面缩放）方向是对的，MHR 本身就是“骨架缩放参数 + 表面形变”这样分开的；但脂肪不能只用法向位移（乳房、臀部下垂、腹部悬垂、腋窝和腹股沟自交），需要少量带方向的校正形变。
7. **标准女性体表**已生成（MHR 网格，18439 顶点，带蒙皮权重）：身高 1.670 m（她的骨架）、BMI 22。**她的内部结构装不进 BMI 22 的体表**：腹部 20 % 的肌肉顶点在皮肤之外、前臂 47 %、膝部 38 %；换成 BMI 28 的体表后躯干基本都在皮肤内（腹部 1.5 %），前臂仍有 36 %。

## 1. 数据来源（许可证为原文摘录；“打开”指本工作实际下载并读取了内容）

| 来源 | 类型 | 许可证（原文） | 状态 | 结论 |
|---|---|---|---|---|
| ANSUR II（美国陆军 2012） | 实测，个体级，93 项 | NATICK/TR-15/007："Approved for public release; distribution is unlimited" | 已下载并打开 | 可用。军人样本：年轻（中位 27/28 岁）、偏健壮，BMI 第 1–99 百分位 18.8–34.8（女）、19.5–38.2（男） |
| NHANES 1999–2023（CDC） | 实测，个体级，约 10 项 | CDC："not subject to copyright, is in the public domain, and may be freely used or reproduced" | 已下载并打开（24 个文件） | 可用。平民、BMI 范围完整，但测量项少 |
| GB/T 10000-2023 | 百分位表 | 平台页脚“版权所有 侵权必究”，无开放许可 | **表格未取得**；只见到一个二手数值（男身高 P95 = 1800 mm） | 数值可作为事实引用并注明出处，不能转载表格；需人工抄录 |
| GB/T 10000-1988 | 百分位表（33 项） | 同上 | 读到的是教材转载（有印刷错误） | 仅作对照；已被 2023 版取代 |
| 第五次国民体质监测公报（2020） | 按年龄组的均值 | 政府公报 | 已打开（表格图片，人工读数） | 可用作中国青年人群预设；只有均值，没有标准差 |
| NCD-RisC | 各国身高、BMI 估计 | 网站未写许可；Lancet 2017 BMI 论文为 CC BY 4.0 | 已下载（84 MB） | 仅作国别对照；是模型估计值，不要和实测均值混用 |
| CAESAR / SizeUSA / SizeUK / SizeChina / iSize | 三维扫描调查 | 商业销售 | 未获取 | 不可用 |
| SizeKorea | 实测 | 需注册；条款禁止未经同意的商业复制 | 未获取 | 目前不可用 |
| CHNS / CHARLS / CFPS | 中国个体级 | 需注册，禁止公开微观数据 | 未获取 | 不可再分发 |
| MakeHuman / MPFB2 | 美术建模参数化模型 | mpfb2 `LICENSE.md`："These assets have been released under CC0 1.0 Universal"（含基础网格、形变目标、骨架和权重） | 已下载并打开 | 可用 |
| Anny（NAVER） | MakeHuman 派生，可微 | 代码 Apache-2.0；"MakeHuman assets adapted from MPFB2 that are licensed under the CC0 1.0 Universal License" | 已安装并运行 | 可用。**不要**用它的 smpl/smplx 拓扑（仅限非商业） |
| MHR（Meta） | 由 7110 个扫描学习的身份空间 | 代码 Apache-2.0；资产包内 `LICENSE.txt` 为 Apache License 2.0（本工作解压核对过） | 已下载（199 MB）并运行 | 可用。随应用分发时保留 Apache 许可文本和署名 |
| SMPL / SMPL-X / STAR / SUPR / SKEL / OSSO / HIT / SHAPY / BEDLAM | 由扫描学习 | "non-commercial scientific research…"；"shall not be copied, shared, distributed" | 只读了许可页 | 不可用 |
| SMPL-Body（CC BY 4.0） | 单个固定体型 | "excludes the shape blendshapes" | 只读了许可页 | 不能当参数化模型用 |
| GHUM、UMTRI HumanShape、AnthroNet、SynBody、DAZ、MB-Lab | — | 申请制 / 无开放许可 / 非商业 / AGPL | 只读了许可页 | 不可用 |
| OpenSim Rajagopal 2016 | 肌骨模型 | MIT 式许可（SimTK） | 只读了许可页 | 可用（关节定义、肢段缩放规则） |
| Blender Studio Human Base Meshes | 静态雕刻底模 | CC0（经抓取工具转述） | 未下载 | 可用但没有形变和骨架 |

许可证和文献的检索由三个子任务完成，结果写在 `refpop-china.json`、`fat-literature.json`；我没有逐条复核它们摘录的数值。MPFB2 仓库已下载并读了许可文件，但测量用的是 Anny 包里那份相同的 MakeHuman 数据。ANSUR II 官方链接已失效，文件取自互联网档案馆对同一官方 URL 的存档。

## 2. 人体测量模型

形式：`ln y = a + b·ln(S/1650) + c·ln(B/22) + L1·f1 + L2·f2 + e`，y、S 为毫米，B 为 BMI。80 % 训练、20 % 留出检验。线性形式与对数形式的留出 R² 相同（差别 ≤ 0.01），取对数形式是为了外推时不出现负值。

- **控制量**：身高；BMI；**f1 腿长比例**（+1：会阴高 +2.5 %、坐高 −2 %）；**f2 体型分布**（+1：腰围 +4 %，四肢围度 −1 % 至 −3 %；男性表现为上臂、前臂、肩变细）。两个因子是扣除身高和 BMI 后残差的前两个旋转主成分，分别占残差方差的 23 % 和 12 %（女），22 % 和 11 %（男）。数据里没有独立的“肌肉量”轴：在同样的身高和 BMI 下，肌肉多少主要体现在 f2 上。
- **留出检验（女 / 男）**，仅身高+BMI → 加两个因子：

| 测量项 | R²（身高+BMI） | 残差标准差 mm | R²（加因子） |
|---|---|---|---|
| 颈椎点高 | 0.97 / 0.97 | 11 / 11 | 0.98 / 0.98 |
| 肩峰高 | 0.95 / 0.94 | 14 / 15 | 0.96 / 0.96 |
| 髂嵴点高 | 0.86 / 0.83 | 20 / 21 | 0.96 / 0.92 |
| 大转子点高 | 0.77 / 0.73 | 23 / 25 | 0.93 / 0.90 |
| 会阴高 | 0.75 / 0.75 | 24 / 23 | 0.94 / 0.92 |
| 胫骨点高 | 0.75 / 0.72 | 13 / 14 | 0.94 / 0.89 |
| 坐高 | 0.56 / 0.59 | 22 / 22 | 0.88 / 0.88 |
| 上臂长（肩峰–桡骨点） | 0.67 / 0.66 | 10 / 10 | 0.74 / 0.71 |
| 前臂长（桡骨点–茎突） | 0.53 / 0.53 | 11 / 10 | 0.73 / 0.69 |
| 肩峰间宽 | 0.37 / 0.43 | 16 / 15 | 0.37 / 0.57 |
| 髂嵴间宽 | 0.48 / 0.46 | 16 / 13 | 0.65 / 0.54 |
| 胸围 | 0.78 / 0.86 | 39 / 32 | 0.88 / 0.86 |
| 腰围（脐水平） | 0.79 / 0.84 | 44 / 44 | 0.89 / 0.94 |
| 臀围 | 0.88 / 0.88 | 27 / 27 | 0.89 / 0.90 |
| 大腿根围 | 0.86 / 0.84 | 21 / 24 | 0.89 / 0.84 |
| 小腿围 | 0.67 / 0.70 | 17 / 16 | 0.82 / 0.72 |
| 屈肘上臂围 | 0.79 / 0.68 | 15 / 19 | 0.79 / 0.79 |
| 颈围 | 0.60 / 0.66 | 12 / 15 | 0.66 / 0.69 |

预测不了的项：外踝高（R² 0.20）、头宽/头长/头围（0.06–0.22）、手宽、足宽（0.3）。肩峰间宽只有 0.4 左右，说明肩宽基本是个体差异，不能由身高和 BMI 决定。

- **NHANES 拟合**（同一形式，平民，BMI 全范围；女 / 男）：腰围 R² 0.85 / 0.87（残差 64 / 57 mm），臀围 0.92 / 0.89（45 / 41），大腿中部围 0.78 / 0.74（39 / 33），小腿围 0.73 / 0.75（24 / 20），放松上臂围 0.86 / 0.81（21 / 20）。年龄每增加十岁，腰围在同 BMI 下增加 1.4 % / 2.0 %，大腿围减少 1.4 % / 2.1 %。
- **跨数据集检验**（用 ANSUR 拟合的模型预测 NHANES 的人）：限定 45 岁以下且 BMI 在 ANSUR 范围内时，臀围偏差 +3 / −8 mm，小腿围 +2 / −2 mm，腰围 −8 / −21 mm（两者腰围测量水平不同，且军人腰更细）。不限年龄时腰围低估 29–46 mm（女）、50–61 mm（男）；BMI ≥ 35 时臀围低估 46–48 mm。所以 BMI 超出 ANSUR 范围时围度应使用 NHANES 那组系数。大腿围和上臂长两套数据定义不同（差 7–15 cm 和 1–4 cm），不能互相检验。
- **用中国数据检验**：把 GB/T 10000-1988 的 P50 身高和体重代入模型，肩高、胫骨点高、肩宽（女）、臀宽、臀围偏差都在 ±1 个标准差内；**坐高中国人高 21–25 mm（+1.0 至 +1.1 个标准差，即腿长因子约 −1）、前臂短 17–18 mm（−1.7 至 −1.8）、最大肩宽窄 16–20 mm**。2020 年 20–24 岁人群：NHANES 拟合高估腰围 71 mm（女）、60 mm（男），臀围只差 +13 / −14 mm——中国青年在同样 BMI 下腰更细，腰围应使用 ANSUR 那组系数或另行校正。
- **人群预设**（身高 mm / BMI）：ANSUR II 女 1626 / 25.3，男 1755 / 27.5；NHANES 20–39 岁女 1628 / 27.2，男 1761 / 27.7；NHANES 亚裔 20–39 岁女 1583 / 22.9，男 1732 / 26.0；中国 20–24 岁（2020 均值）女 1606 / 21.6，男 1726 / 23.6；GB/T 10000-1988 P50 女 1570 / 21.1，男 1678 / 21.0。

## 3. 我们的男、女人体在分布中的位置

测量程序 `measure.py`：骨性标志点取自骨网格（ANSUR 的定义），围度取自皮肤的水平截面（凸包周长，相当于皮尺）。骨面上的点比 ANSUR 在皮肤上标的点深 3–10 mm，所以 |z| < 0.5 的差别没有意义。z 是相对“同身高、同 BMI”预测值的标准分；“差值”是与“同身高、BMI 22”的差。

姿势：男性上臂外展 9.6°、前臂外展 11°、前臂前倾 12°；女性上臂外展 9–10°、前臂外展 12–15°、前倾 13°。

**男性**（身高 1719 mm，ANSUR 男性第 30 百分位；皮肤体积 70.0 L，按 1010 kg/m³ 折合 BMI 23.9）

| 测量项 | 数值 mm | z | 说明 |
|---|---|---|---|
| 肩峰间宽 | 333 | −5.5 | 比预测窄 67–71 mm，在 4082 名男性中排最末 |
| 颈椎点高 | 1447 | −3.3 | 低 34 mm |
| 前臂长 | 237 | −2.5 | 短 25 mm |
| 髂嵴间宽 | 289 | +2.1 | 宽 27–31 mm |
| 肩峰高 | 1423 | +1.3 | |
| 大转子、胫骨点、外踝高 | 887 / 451 / 71 | +0.3 / −0.4 / +0.1 | 下肢长度正常 |
| 会阴高（皮肤） | 780 | −2.2 | 低 49–52 mm |
| 胸围 / 腰围（脐）/ 臀围 | 1018 / 785 / 907 | +1.5 / −1.3 / −1.6 | 胸大腰臀小 |
| 腰围（髂嵴，对 NHANES） | 779 | −2.3 | 比美国平民细 111 mm |
| 小腿围 / 颈围 | 392 / 397 | +1.7 / +1.5 | |

另外，男性皮肤的上臂在肩到肘 70 % 处以上都与躯干连在一起（腋窝很低）。

**女性**（身高 1670 mm，ANSUR 女性第 74 百分位；现用皮肤体积 70.7 L，折合 BMI 25.6；供体本人 BMI 约 36）

| 测量项 | 数值 mm | z | 与“同身高、BMI 22”的差 mm | 说明 |
|---|---|---|---|---|
| 肩峰高 | 1423 | +3.6 | +54 | 肩峰比 C7 棘突还高 4 mm（正常低约 6 cm）：肩胛带上抬 |
| 髂嵴点高 | 966 | −3.0 | −58 | |
| 大转子点高 | 823 | −2.1 | −46 | 下肢短 |
| 股骨外上髁高 / 胫骨点高 | 447 / 427 | −2.0 / −1.9 | −31 / −24 | |
| 外踝高 | 87 | +4.2 | +23 | 超出女性样本上限；足是形变的男性足 |
| 上臂长 / 前臂长 | 297 / 218 | −2.2 / −2.9 | −21 / −29 | |
| 手长 | 210 | +3.1 | +27 | 手是形变的男性手 |
| 肩峰间宽 | 326 | −3.3 | −42 | |
| 髂嵴间宽 | 296 | +1.0 | +30 | |
| 会阴高（皮肤） | 710 | −4.3 | −99 | |
| 颈围 | 441 | +7.7 | +123 | 超出女性样本上限 |
| 胸围 | 1032 | +1.6 | +144 | |
| 胸厚 | 280 | +1.7 | +52 | |
| 腰围（脐） | 790 | −1.8 | +5 | |
| 臀围 | 965 | −2.7 | −7 | |
| 大腿根围 | 545 | −3.9 | −30 | |
| 大腿中部围（NHANES） | 529 | +0.3 | +52 | |
| 小腿围 | 401 | +1.2 | +44 | |
| 前臂围 / 腕围 | 294 / 175 | +2.3 / +3.0 | +41 / +21 | |
| 放松上臂围（NHANES） | 301 | −0.2 | +25 | |

肢段相对“同身高标准”的比值（实测 / 期望）：头颈 1.06、躯干 1.06、大腿 0.96、小腿 0.87、踝高 1.36、上臂 0.93、前臂 0.88、手 1.15、肩宽 0.89、骨盆宽 1.11。注意她的“身高”本身不可靠：颅骨和足是形变的男性结构，踝高多出约 2 cm。

**数据支持的修正**：
- 颈围应减约 12 cm、胸围减约 14 cm、胸厚减约 5 cm；前臂围减 4 cm、腕围减 2 cm、小腿围减 4 cm。
- 大腿根围应增加约 3 cm、臀围基本不变——即把男性的“倒三角”改成女性的臀腿分布。
- 腰围（脐水平）已经接近 BMI 22 女性的 785 mm。
- 皮肤上的男性外生殖器应去掉。
- 肩胛带上抬、下肢短、六节腰椎是供体骨骼和体位本身的特点，不是皮肤问题；改不改要由你决定（见第 8 节）。

## 4. 参数化模型的标定

每个样本的 BMI 由网格体积得出，再与“同身高、同 BMI 的真人”比较。下表是平均 z（括号内为平均差值 mm），BMI 18.5–25 / 25–30 两档。

| 测量项 | Anny 女 | Anny 男 | MHR 女侧 | MHR 男侧 |
|---|---|---|---|---|
| 胸围 | +1.0 (+43) / +0.9 (+44) | −1.3 (−39) / −1.9 (−64) | −0.7 (−26) / 0.0 (+2) | −4.3 (−113) / −2.5 (−74) |
| 腰围（髂嵴，NHANES） | +0.1 (+10) / −1.0 (−45) | −0.3 (−11) / −0.4 (−23) | +0.9 (+51) / +1.4 (+93) | −0.5 (−23) / −0.1 (−7) |
| 臀围（NHANES） | −0.3 (−13) / −1.7 (−78) | +0.1 (+3) / −0.1 (−7) | +0.9 (+36) / +0.6 (+26) | −0.1 (−1) / +0.2 (+7) |
| 大腿中部围（NHANES） | 0.0 (−3) / +0.3 (+10) | +0.4 (+10) / +0.3 (+9) | +0.5 (+19) / +0.4 (+16) | +0.4 (+12) / +0.7 (+22) |
| 小腿围（NHANES） | −0.8 (−23) / −0.4 (−13) | +0.3 (+7) / +0.3 (+8) | −0.6 (−14) / −0.6 (−14) | +0.2 (+3) / +0.2 (+4) |
| 上臂围（NHANES） | 0.0 (0) / +2.0 (+49) | −0.9 (−16) / +0.2 (+6) | +0.3 (+5) / +0.3 (+5) | +0.8 (+14) / +0.9 (+17) |
| 大腿根围 | −1.1 (−27) / −1.6 (−42) | −0.3 (−8) / −0.8 (−19) | −1.4 (−28) / −2.0 (−48) | −1.4 (−26) / −1.4 (−29) |
| 踝围 | +1.1 (+16) / +1.3 (+19) | +1.7 (+19) / +1.9 (+23) | −1.0 (−12) / −0.9 (−11) | −0.4 (−4) / −0.3 (−3) |
| 前臂围 | −1.5 (−16) / +1.6 (+22) | −3.6 (−44) / −3.0 (−39) | −2.5 (−24) / −2.2 (−24) | −1.8 (−20) / −1.9 (−23) |
| 腕围 | −3.6 (−20) / −2.1 (−12) | −5.3 (−32) / −3.4 (−22) | −1.0 (−5) / −1.0 (−5) | −1.5 (−8) / −1.6 (−9) |

11 项围度的平均 |z|：Anny 女 1.48、男 1.70；MHR 女侧 1.05、男侧 1.12。只看 NHANES 的 5 项：Anny 1.11 / 0.99，MHR 0.70 / 0.66。

**Anny / MakeHuman**（13718 顶点，163 根骨，A 字站姿，肘微屈；Anny 中 gender 0 = 男、1 = 女，age 2/3 = 青年）
- 参数到身高：height 0 / 0.5 / 1 → 女 1224 / 1769 / 2313 mm，男 1364 / 1909 / 2454 mm。默认值（0.5）是 1.77 m 的女性和 1.91 m 的男性。
- 参数到 BMI（height 0.5）：女性 muscle 0.5 时 weight 0→1 只有 17.7→23.2；muscle 0 时 13.8→34.0。男性 muscle 0.5 时 21.6→25.7；muscle 0 时 16.1→41.2。也就是说“weight”不等于胖瘦，要得到肥胖体型必须同时把 muscle 降到 0。
- 形变不是简单的线性混合：系数是各参数分段线性插值权重的乘积（多线性），共 1132 个形变。
- 另有 MakeHuman 的 `measure-*` 局部形变（腰围、臀围、胸围、大腿围、上臂围、颈围、肩宽、各肢段长度），可用来把网格拟合到给定围度。
- 偏差：腕和前臂偏细，踝偏粗，男性胸围偏小 4–9 cm，肥胖档女性臀围偏小 8 cm；proportions 参数 0→1 使会阴高/身高从 0.482 变到 0.462（女）。

**MHR**（LOD1：18439 顶点，127 个关节，每顶点最多 4 个权重，A 字站姿；单位厘米，坐标系与我们一致）
- 45 个身份系数（前 20 个管身体）。没有性别和胖瘦标签；渲染确认**第 1 系数是胖瘦，第 2 系数是性别**（正值为女性）。
- 线性映射（119 个样本）：BMI = 28.6 + 5.8·c1（R² 0.99）；腰围 = 1047 + 164·c1 + 38·c2 mm；臀围 = 1097 + 121·c1 + 45·c2 mm。平均体型是 BMI 28.6 的超重体型。
- 身份系数不改变身高（1727 mm）和关节位置；骨架比例由另外的缩放参数控制（脊柱、颈、肩宽、上臂、前臂、髋宽/高/深、大腿、小腿、踝高、足长；每单位 = 10 cm）。
- 偏差：女侧腰围比同 BMI 的 NHANES 女性大 5–12 cm（比 ANSUR 大 11–15 cm），腰厚 +2.7 至 +3.2 个标准差——体型偏“腹型”；男侧在 BMI 18.5–25 时胸围小 11 cm；前臂细 2 cm。

**测量程序自身的偏差**（所有模型都同向，不能算作模型的问题）：胸宽 +1.8 至 +3.5 个标准差（腋襞处的切法偏宽）；臀宽 +1.6 至 +3.8 个标准差（两腿分开站立）；颈围（水平截面，ANSUR 是斜面）在 MHR 上 +4 至 +7 个标准差；会阴高在多数模型上低 2–4 cm。这几项不要用来下结论。

## 5. 皮下脂肪知识

`fat-literature.json`：27 个来源（23 个读到全文或官方表格），114 条部位厚度、27 条回归、48 条分配数据。**没有任何一篇开放文献在所有部位同时按性别和 BMI 分层**；唯一这样做的 Störchle 2017 无法自动获取，需要人工打开。

方案采用的厚度函数 t = max(下限, a + b·BMI)（毫米，不含约 2 mm 的皮肤）：

| 部位 | 女 a, b | 男 a, b | 依据 | 可靠程度 |
|---|---|---|---|---|
| 腹前壁 | −8.47, 1.14 | −13.82, 1.14 | Sim 2014 回归（韩国，超声），取 22 岁 | 实测回归 |
| 上臂后侧 | 2.09, 0.403 | −1.25, 0.403 | Sim 2014 | 实测回归 |
| 三角肌区 | −2.1, 0.40 | −3.9, 0.39 | Kowatari 2023（日本，22 岁） | 实测回归 |
| 大腿前侧 | −4.79, 0.710 | −7.10, 0.647 | Jain 2013 分级均值，本工作拟合直线 | 由分级均值推导 |
| 臀部 | 11.5, 0.239 | 5.8, 0.239 | Gibney 2010 合并性别的分级均值 ± 性别差的一半 | 推导；性别与 BMI 从未同时分层 |
| 小腿 | −7.7, 0.495 | −5.1, 0.33 | Störchle 2018（10 名男性）；女性按 1.5 倍 | 弱 |
| 前臂 | 0.4, 0.075 | 0.0, 0.05 | 同上 | 弱 |
| 胸前壁（乳房以外） | −2.7, 0.405 | −1.8, 0.27 | 同上 | 弱；女性倍数是假设 |
| 背部 | 0.7, 0.21 | 0.4, 0.14 | 同上 | 弱 |

算例（女，BMI 18.5 / 22 / 25 / 30 / 35）：腹 12.6 / 16.6 / 20.0 / 25.7 / 31.4；上臂后 9.5 / 11.0 / 12.2 / 14.2 / 16.2；大腿前 8.3 / 10.8 / 13.0 / 16.5 / 20.1；臀 15.9 / 16.8 / 17.5 / 18.7 / 19.9；小腿 1.5 / 3.2 / 4.7 / 7.1 / 9.6 mm。
男（同样的 BMI）：腹 7.3 / 11.3 / 14.7 / 20.4 / 26.1；上臂后 6.2 / 7.6 / 8.8 / 10.8 / 12.9；大腿前 4.9 / 7.1 / 9.1 / 12.3 / 15.5；臀 10.2 / 11.1 / 11.8 / 13.0 / 14.2；小腿 1.5 / 2.2 / 3.2 / 4.8 / 6.5 mm。

与另一位同事在我们女性供体 CT 上量到的中位厚度（BMI 约 36；腹前 33、大腿 23、髋 30、小腿 12 mm）对照：公式在 BMI 36 给出腹 32.6、大腿 20.8、小腿 10.1——吻合；臀部 20.1 对 30，**臀部公式偏低约 10 mm**。

其他要点：内脏/皮下脂肪比（香港华人，MRI）男 0.39–0.46，女 0.21–0.28，随 BMI 变化不大；腹型/臀型脂肪比（DXA）青年女性约 0.26–0.3，青年男性约 0.38–0.4；乳房体积约每 BMI 单位 +53 mL（BMI 18.5–25 约 370 mL，25–30 约 690 mL，≥30 约 1065 mL）；体脂率 = 1.20·BMI + 0.23·年龄 − 10.8·性别（男 = 1）− 5.4（Deurenberg 1991）。数据缺口：髂上、背部、前臂和小腿的女性人群数据；中国人数据很少；多数注射部位数据来自 50–65 岁糖尿病患者。

## 6. 体型模型方案（Rig.shape）

**控制量**（4 个标量，男女各自的系数表）：身高（1.40–2.00 m）、BMI（16–40）、腿长比例（±2 个标准差）、体型分布（±2 个标准差）。静止值：男 1.720 m / BMI 23.9 / 0 / 0；女取决于采用哪张皮肤。

**(i) 身高与比例 → 关节分段缩放。** 这部分数据支持得最好，MHR 也是这样做的。
- 每个肢段沿骨轴的缩放 = 模型(控制量) / 模型(静止控制量)。肢段长度是 ANSUR 量的线性组合：头颈 = 身高 − 颈椎点高；躯干 = 颈椎点高 − 大转子点高；大腿 = 大转子点高 − 股骨外上髁高；小腿 = 股骨外上髁高 − 外踝高；上臂、前臂、手、足；肩宽 = 肩峰间宽；骨盆宽 = 髂嵴间宽。
- 算例（女，身高 1606 mm，BMI 22）：头颈 232、躯干 544、大腿 374、小腿 395、上臂 305、前臂 236、肩宽 358 mm。腿长因子 −1.5 / 0 / +1.5：大腿 364 / 374 / 385，小腿 377 / 395 / 414，躯干 563 / 544 / 523，坐高 876 / 848 / 821 mm。
- 男（1726 mm，BMI 22）：头颈 241、躯干 599、大腿 404、小腿 412、上臂 328、前臂 263、肩宽 400 mm；腿长因子 −1.5 / 0 / +1.5：大腿 390 / 404 / 419，小腿 397 / 412 / 428，躯干 619 / 599 / 578 mm。
- **骨的缩放要在固定 BMI（22）下求值**：ANSUR 的“髂嵴间宽”随 BMI 从 243 增到 301 mm，那是软组织，不是骨盆变宽。
- 不足：脊柱不是一个刚性段，躯干缩放要分摊到各椎间关节；骨的横向尺寸（肩宽、骨盆宽、胸廓）与长度的指数不同（肩峰间宽对身高的指数 0.6–0.7，长度约 1.1），所以要用各向异性缩放；肩宽几乎不能由控制量预测（R² 0.4），建议单独留一个“肩宽”微调或干脆不动。

**(ii) 胖瘦 → 皮肤位移 + 皮下脂肪层。** 思路可行，但仅靠“沿平滑法线、按部位权重位移”不够：
- 需要的逐顶点属性：部位权重（最多 4 个部位，可与蒙皮权重同样的存法：4×uint8 索引 + 4×uint8 权重）、平滑法线（10 bit）。表：第 5 节的 9 个部位 × 性别的 (a, b, 下限)。位移 = Σ 权重 × [t(性别, BMI) − t(静止)]。每顶点约 8 字节，220 万三角形的皮肤和脂肪层完全负担得起；内部结构不需要这些属性。
- **哪里会错**：
1. 乳房：体积随 BMI 增加的同时下垂、向外下方移动，不是沿法线膨胀。需要一个带方向的校正形变（MakeHuman 用 cupsize × firmness 的 9 个目标；MHR 包含在身份分量里）。
2. 腹部：肥胖时出现悬垂和皱褶，位移方向是向前下；内脏脂肪推的是腹壁肌层而不是皮肤，男性尤其明显（内脏/皮下比 0.4 对女性 0.2），所以腹部要分成“腹壁外移（内脏项）+ 皮下层加厚”两项。
3. 臀部：臀沟位置下移、臀部向后下方变形；文献数据显示臀部皮下厚度随 BMI 增长很慢（13.7→16.6 mm），围度的增加主要来自形状变化。
4. 凹处自交：腋窝、腹股沟、臀沟、大腿内侧、颈–下颌之间，法向位移超过局部曲率半径就会互相穿透。需要在这些区域把权重压低，并在运行时或预计算中做碰撞限制（大腿内侧位移不超过到正中面的距离）。
5. 厚度公式是“厚度”，而围度数据是“周长”：两者要对账。建议用围度作约束——某部位围度目标 G(控制量) 来自第 2 节，肌肉包络周长 Gm 已知，则平均脂肪厚度 ≈ (G − Gm)/(2π) − 皮肤，再按部位权重在一圈内分配（腹前多、腰侧和背少）。这样两套数据互相校验，不会出现皮肤围度不合人体测量的情况。
- 与参数化模型的对照：Anny/MakeHuman 和 MHR 都没有“脂肪层”概念，它们直接形变皮肤，骨架和内部不存在；MHR 的第 1 分量就是一个学出来的、带方向的全身脂肪位移场——**可以直接把它当作 (ii) 的位移方向**：把 MHR 的 c1 位移场（以及 c2 的性别差异场）经配准传递到我们的皮肤上，存成每顶点一个 3 分量位移（16 bit × 3），运行时乘以 (BMI − 静止) / 5.8。这比法向位移多 6 字节/顶点，但乳房、腹部、臀部的方向问题一次解决。建议：皮肤用“传递来的位移场”，脂肪层内表面跟随肌肉，层厚自然由两者之差决定；第 5 节的厚度表用来校验和限幅。

**(iii) 肌肉量 → 肌肉横截面绕作用线缩放。** 契约里的 `MuscleLine` 已经有按长度保持体积的缩放，再乘一个系数即可。
- 数据能支持的只有 f2（体型分布）和 BMI 对四肢围度的影响：例如男性 f2 从 −1.5 到 +1.5，屈肘上臂围 328 → 299 mm（BMI 22）。扣掉脂肪厚度后得到肌肉半径：r = G/(2π) − t − 皮肤，缩放 = r(控制量)/r(静止)。
- 不足：只对有清晰作用线的梭形肌合适；扁肌（腹壁、背阔肌、胸大肌）和臀肌要按厚度缩放；骨不随之变粗，缩放过大肌肉会离开骨面或互相穿透；ANSUR 没有独立的肌肉量变量，所以不建议单独做“肌肉”滑块而不标注它是近似。

**各控制量需要的数据小结**

| 控制量 | 逐顶点 / 逐部件数据 | 表 |
|---|---|---|
| 身高、腿长比例 | 已有：部件到关节的绑定和蒙皮权重 | 每性别 11 个肢段 × (a, b, L1)；来自 anthro-model.json |
| BMI | 皮肤和脂肪层：位移场 3×int16（或法线 + 4 个部位权重） | 9 个部位 × 性别的厚度系数；13 个围度位置的 (a, b, c) |
| 体型分布 | 同上（腰腹与四肢部位权重相反） | 各围度的 L2 |
| 肌肉横截面 | 已有：MuscleLine；扁肌需每块一个厚度方向 | 每肢段的肌肉半径公式 |

## 7. 标准女性体表（立即可用的参考）

`data/raw/bodyshape/out/reference-female/`：`skin.obj`（MHR LOD1 拓扑，18439 顶点、36874 三角形，我们的坐标系）、`weights.bin`（51337 条蒙皮权重）、`joints.json`（127 个关节）、`manifest.json`、`fit.json`、预览图。另有 `reference-female-bmi28/`（同法，BMI 28）和 `anny-female/`（Anny/MakeHuman 青年女性的网格、骨架、权重、宏观位移，CC0）。

- **标准**：女性，身高 1.670 m（即我们的女性骨架，不是人群中位数——体表必须套得上她的骨骼），BMI 22（WHO 和中国标准的正常范围中段）。围度目标来自 NHANES（腰、臀、大腿中部、小腿、上臂）和 ANSUR II（胸、腰、大腿根、大腿下部、踝、腕）。
- **做法**：身份系数（前 6 个，第 2 个固定 ≥ 1.5 保证女性体型）由围度目标求解；MHR 的 11 个骨架缩放参数和关节角拟合到她的 12 个关节中心、头顶、足底、足尖和手指，并惩罚骨骼穿出皮肤。
- **达到的围度**（目标 → 实际，括号内为人群标准差数）：BMI 22.0 → 22.0；腰围（髂嵴）821 → 787（−0.7）；臀围 959 → 1023（+1.6）；大腿中部 477 → 498（+0.6）；小腿 352 → 335（−0.8）；上臂 276 → 274（−0.2）；胸围 889 → 873（−0.4）；腰围（脐）785 → 739（−1.0）；大腿根 575 → 540（−1.7）；踝 211 → 203（−0.7）；腕 153 → 146（−1.5）。臀围偏大、大腿根和腕偏细是 MHR 体型空间在这个骨架上的极限。
- **关节残差**：肩、肘 0.8–1.3 mm；髋 4–7 mm；膝 8–11 mm；踝 5–6 mm；腕 6–7 mm；手指约 20 mm（手的姿势没对上）。
- **MHR 给出的骨架缩放**：脊柱 +7.8 cm，大腿 −6.1 cm，小腿 −6.0 cm，前臂 −4.1 cm，髋高 +3.3 cm，髋深 +3.2 cm，髋宽 +1.8 cm，踝高 +1.9 cm，肩宽 −1.0 cm——与第 3 节的结论一致（躯干长、下肢和前臂短）。
- **与她的内部结构是否相容**（她的肌肉顶点到参考皮肤的有符号距离；正值在皮肤外）：

| 区域 | BMI 22：在外比例 / 超出 5 mm 比例 / 第 90 百分位 mm | BMI 28：在外比例 / 第 90 百分位 mm |
|---|---|---|
| 头 | 6 % / 1 % / −1 | 6 % / −1 |
| 颈 | 4 % / 2 % / −5 | 0.4 % / −13 |
| 肩 | 17 % / 12 % / +6 | 4 % / −5 |
| 胸 | 2 % / 1 % / −10 | 0 % / −23 |
| 腹 | 20 % / 10 % / +5 | 1.5 % / −8 |
| 骨盆/臀 | 5 % / 2 % / −4 | 0 % / −17 |
| 大腿 | 16 % / 11 % / +6 | 6 % / −5 |
| 膝 | 38 % / 30 % / +15 | 28 % / +10 |
| 小腿 | 12 % / 5 % / +1 | 5 % / −4 |
| 上臂 | 9 % / 6 % / −2 | 3 % / −5 |
| 前臂 | 47 % / 31 % / +18 | 36 % / +12 |
| 手 / 足（仅在外比例） | 19 % / 11 % | 19 % / 10 % |

骨：BMI 22 时膝部 53 % 的骨顶点在皮肤外（第 90 百分位 +25 mm）、前臂 37 %、小腿 16 %、肩 14 %、腹部（下位肋和腰椎）12 %；BMI 28 时膝部仍有 46 %、前臂 22 %、小腿 10 %，躯干各区 ≤ 2 %。手、足的骨在两种 BMI 下都有 29–35 % 在外（姿势没对上）。膝部在两种 BMI 下都穿出，说明是膝关节轴线/髌骨位置没有对准，不是软组织厚度问题。

穿出最多的肌肉（第 95 百分位，BMI 22）：桡侧腕长伸肌 29–33 mm、肘肌 26–33 mm、指伸肌 26–31 mm、三角肌肩峰部和棘部 25–27 mm、肱桡肌 21–26 mm、缝匠肌和股薄肌 19–20 mm。

- **皮肤下的软组织余量**（参考皮肤到她的肌肉/骨表面的中位距离）：BMI 22 时腹 2.9 mm、前臂 3.5、上臂 4.7、小腿 5.1、胸 5.8、大腿 14.6、骨盆 21.0 mm；而 BMI 22 女性应有的皮下脂肪是腹 16.6、上臂 11.0、大腿 10.8、小腿 3.2 mm。**结论：除大腿和臀部外，形变得到的肌肉包络比 BMI 22 女性应有的大，躯干和上臂每侧约多 10 mm，前臂伸肌群多 2–3 cm。** BMI 28 时腹 18.3、大腿 24.8、胸 16.5 mm，基本合理。对照：男性皮肤到自身肌肉的中位距离为腹 7.4、上臂 14.5、大腿 15.5、小腿 9.0 mm。
- **这张体表的问题**（如实说明）：头略后仰；肩部因她的肩胛带上抬而显得耸肩；臀沟和会阴处有皱褶；LOD1 网格较粗，渲染呈面片状；手指和足趾姿势没有对上；胸围比目标小 16 mm。它适合作为“形状目标”和测量对照，不适合不经处理直接当最终皮肤。

## 8. 需要你决定的事和阻碍

1. **默认参考人群**：建议用中国 20–24 岁均值（女 160.6 cm / 55.7 kg / BMI 21.6；男 172.6 cm / 70.4 kg / BMI 23.6）作默认身高和 BMI，比例和围度函数用 ANSUR II / NHANES（中国没有可再分发的个体级数据），并加上已量化的修正：腿长因子约 −1、前臂约 −7 %、腰围用 ANSUR 系数。是否接受？
2. **GB/T 10000-2023**：表格需要有人在浏览器里打开 openstd.samr.gov.cn 的在线预览，手工抄录表 1/表 6（18–70 岁）和表 2/表 7（18–25 岁）。抄到之后可以直接校正上面的修正量。
3. **女性皮肤用哪个来源**：MHR（Apache-2.0，形状更真实，需随应用保留许可文本和署名；与 CC BY-SA 应用并存没有问题，但那几个文件要单独标注许可）还是 Anny/MakeHuman（CC0，无署名要求，腕、前臂、踝有偏差）。我的建议是 MHR 作形状来源。
4. **内部结构与体表不相容**：要么把女性的静止 BMI 定在 28 左右（内部基本装得下），要么让管线把形变来的肌肉横截面缩小（躯干和上臂每侧约 10 mm，前臂伸肌更多）再用 BMI 22。这是管线一侧的工作。
5. **是否把她的骨架“标准化”**：肩胛带上抬约 5 cm、下肢短（小腿比值 0.87，含踝高偏差）、前臂短、六节腰椎。按标准缩放会让比例正常，但那就不再是这位供体的真实骨骼。
6. **男性模型**：肩峰间宽 333 mm（−5.5 个标准差）、前臂短、腋窝很低。做体型控制时这些个体特征会按比例保留；是否要修？
7. **未完成**：没有把 MHR 的位移场传递到我们的皮肤上（第 6 节的建议做法）；没有做肌肉横截面缩放的数值试验；参数化模型没有按中国人群单独标定；我没有逐条复核子任务摘录的文献数值；Störchle 2017 等四篇关键文献没有读到。

## 9. 文件与复现

```
bash tools/bodyshape/download.sh                 # ANSUR II、NHANES -> data/raw/bodyshape/
bun tools/bodyshape/export-parts.ts male female  # GLB -> 中性二进制
PY=data/raw/bodyshape/.venv/bin/python           # uv venv（Python 3.12）；numpy pandas scipy scikit-learn trimesh matplotlib libigl torch pillow anny
$PY -I tools/bodyshape/fit_anthro.py             # -> anthro-model.json
$PY -I tools/bodyshape/measure.py male female && $PY -I tools/bodyshape/compare.py male female   # -> our-bodies.json
$PY tools/bodyshape/calibrate_anny.py; $PY tools/bodyshape/calibrate_mhr.py; $PY -I tools/bodyshape/calibration_report.py   # -> model-calibration.json
$PY -I tools/bodyshape/build_shape_model.py      # -> shape-model.json
$PY tools/bodyshape/reference_female.py [--bmi 28]; $PY tools/bodyshape/export_anny.py
```

MHR 资产（`assets.zip`，v1.0.1）和 Anny 源码包需放到 `data/raw/bodyshape/models/` 下（见 `mhrlib.py`、`annylib.py`）。`data/raw/bodyshape/` 共 2.5 GB。入库的表在 `data/curated/bodyshape/`：`anthro-model.json`、`our-bodies.json`、`model-calibration.json`、`shape-model.json`、`fat-literature.json`、`refpop-china.json`。

---

# English

## 0. Summary

1. **Ranking of reference types**: measured anthropometric surveys > scan-derived statistical shape models with usable licences > artist-built parametric models > illustration canons. Anime, illustration and AI-generated bodies cannot serve as ground truth: they have no measurement behind them, their proportions are stylised or invented by a model, they cannot be traced to a population, and no error can be stated. Scraped photographs of real people raise consent and copyright problems; no photographs were collected.
2. **The usable data were downloaded and opened**: ANSUR II (1,986 women, 4,082 men, 93 measurements) and NHANES 1999–2023 body measures (30,082 adult women, 28,908 men). CAESAR, SizeUSA/UK, SizeKorea and Chinese individual-level data are paid or not redistributable. **The GB/T 10000-2023 percentile tables were not obtained** (the official online reader is copy-protected; they must be transcribed by hand). The Chinese data in hand are a secondary reprint of GB/T 10000-1988 and the means of the 2020 national fitness bulletin.
3. **Anthropometric model** (`data/curated/bodyshape/anthro-model.json`): per sex, four controls — stature, BMI, relative leg length, mass distribution (waist-heavy vs limb-heavy) — predict 50 measurements. With stature + BMI alone, trunk heights reach R² 0.86–0.97, the main girths (chest, waist, hip, thigh, calf, upper arm) 0.67–0.88, and neck, ankle and wrist 0.42–0.66; with the two build factors, lower-limb heights rise to 0.87–0.96 and waist girth to 0.89 (F) / 0.94 (M).
4. **Our two bodies**: the male skeleton has normal segment lengths, but a biacromial breadth of only 333 mm (5.5 SD below men of his stature) and forearms 2.5 SD short; his skin corresponds to BMI 23.9. The female skeleton has a shoulder girdle raised by about 5 cm, short lower limbs and forearms 2.9 SD short; her current skin (warped male skin) has the volume of BMI 25.6, a neck girth of 441 mm (above every woman in the sample), a chest 14 cm larger than a BMI-22 woman's, a proximal thigh 3 cm smaller, and still carries male external genitalia.
5. **Calibration of the parametric models**: MHR (Meta, Apache-2.0, learned from scans) is closest to real people on limbs and hip (mean |z| 0.66–0.70 over the five NHANES girths); Anny/MakeHuman (CC0, artist-built) has clearly thin wrists and forearms (men −3 to −5 SD), thick ankles, and a "weight" slider that reaches only BMI 23–26 at average muscle (mean |z| 0.99–1.11).
6. **Shape-model proposal** (`shape-model.json`): the three parts you outlined (per-segment skeleton scaling, fat as a skin displacement, muscle cross-section scaling) are the right structure, and MHR itself separates skeleton-scale parameters from surface shape. But fat cannot be a normal displacement alone (breast, gluteal sag, abdominal overhang, self-intersection in axilla and groin); a small directional displacement field is needed.
7. **A reference female surface** was produced (MHR mesh, 18,439 vertices, with skin weights): stature 1.670 m (her skeleton), BMI 22. **Her internal model does not fit inside a BMI-22 surface**: 20 % of abdominal muscle vertices lie outside the skin, 47 % in the forearm, 38 % at the knee. Inside a BMI-28 surface the trunk fits (abdomen 1.5 % outside); the forearm still has 36 %.

## 1. Sources (licence text quoted; "opened" means downloaded and read in this work)

| Source | Kind | Licence (quoted) | Status | Verdict |
|---|---|---|---|---|
| ANSUR II (US Army 2012) | measured, individual-level, 93 items | NATICK/TR-15/007: "Approved for public release; distribution is unlimited" | downloaded and opened | Usable. Military sample: young (median 27/28 y), fit; BMI 1st–99th percentile 18.8–34.8 (F), 19.5–38.2 (M) |
| NHANES 1999–2023 (CDC) | measured, individual-level, about 10 items | CDC: "not subject to copyright, is in the public domain, and may be freely used or reproduced" | downloaded and opened (24 files) | Usable. Civilian, full BMI range, few measurements |
| GB/T 10000-2023 | percentile tables | platform footer "版权所有 侵权必究"; no open licence | **tables not obtained**; one secondary value seen (male stature P95 = 1800 mm) | Values may be cited as facts with attribution; tables may not be redistributed; needs manual transcription |
| GB/T 10000-1988 | percentile tables (33 items) | as above | read from a textbook reprint (with typos) | Comparison only; superseded by the 2023 edition |
| 5th National Physical Fitness Surveillance bulletin (2020) | means by age group | government bulletin | opened (table images, read by eye) | Usable as the Chinese young-adult preset; means only, no SD |
| NCD-RisC | country height and BMI estimates | no licence on the site; the Lancet 2017 BMI paper is CC BY 4.0 | downloaded (84 MB) | Country comparison only; modelled estimates, not to be mixed with measured means |
| CAESAR / SizeUSA / SizeUK / SizeChina / iSize | 3D scan surveys | sold commercially | not obtained | Not usable |
| SizeKorea | measured | registration; terms forbid commercial reproduction without consent | not obtained | Not usable as it stands |
| CHNS / CHARLS / CFPS | Chinese individual-level | registration; micro-data may not be published | not obtained | Not redistributable |
| MakeHuman / MPFB2 | artist-built parametric model | mpfb2 `LICENSE.md`: "These assets have been released under CC0 1.0 Universal" (base mesh, targets, rigs and weights) | downloaded and opened | Usable |
| Anny (NAVER) | MakeHuman-derived, differentiable | code Apache-2.0; "MakeHuman assets adapted from MPFB2 that are licensed under the CC0 1.0 Universal License" | installed and run | Usable. Do **not** use its smpl/smplx topologies (non-commercial only) |
| MHR (Meta) | identity space learned from 7,110 scans | code Apache-2.0; `LICENSE.txt` inside the asset zip is the Apache License 2.0 (unzipped and checked here) | downloaded (199 MB) and run | Usable. Keep the Apache licence text and attribution when shipping |
| SMPL / SMPL-X / STAR / SUPR / SKEL / OSSO / HIT / SHAPY / BEDLAM | learned from scans | "non-commercial scientific research…"; "shall not be copied, shared, distributed" | licence pages read only | Not usable |
| SMPL-Body (CC BY 4.0) | one fixed body | "excludes the shape blendshapes" | licence page read only | Not a parametric model |
| GHUM, UMTRI HumanShape, AnthroNet, SynBody, DAZ, MB-Lab | — | request form / no open licence / non-commercial / AGPL | licence pages read only | Not usable |
| OpenSim Rajagopal 2016 | musculoskeletal model | MIT-style (SimTK) | licence page read only | Usable (joint definitions, segment scaling rules) |
| Blender Studio Human Base Meshes | static sculpt bases | CC0 (read through a fetch tool) | not downloaded | Usable but no shape targets or rig |

Licence and literature searches were done by three sub-tasks whose results are in `refpop-china.json` and `fat-literature.json`; I did not re-verify each number they extracted. The MPFB2 repository was downloaded and its licence read, but the measurements used the identical MakeHuman data shipped in the Anny package. The official ANSUR II links are dead; the files came from the Internet Archive's copy of the same official URLs.

## 2. The anthropometric model

Form: `ln y = a + b·ln(S/1650) + c·ln(B/22) + L1·f1 + L2·f2 + e`, y and S in mm, B the BMI. 80 % training, 20 % held out. A linear form gives the same held-out R² (difference ≤ 0.01); the log form was chosen so that extrapolation cannot go negative.

- **Controls**: stature; BMI; **f1 relative leg length** (+1: crotch height +2.5 %, sitting height −2 %); **f2 mass distribution** (+1: waist girth +4 %, limb girths −1 % to −3 %; in men the upper arm, forearm and shoulders get thinner). The factors are the first two rotated principal components of the residuals after stature and BMI, carrying 23 % and 12 % of residual variance (F), 22 % and 11 % (M). The data contain no independent "muscularity" axis: at equal stature and BMI, muscle shows up mainly in f2.
- **Held-out test (F / M)**, stature + BMI only → with the two factors:

| Measurement | R² (stature + BMI) | residual SD mm | R² (with factors) |
|---|---|---|---|
| Cervicale height | 0.97 / 0.97 | 11 / 11 | 0.98 / 0.98 |
| Acromial height | 0.95 / 0.94 | 14 / 15 | 0.96 / 0.96 |
| Iliocristale height | 0.86 / 0.83 | 20 / 21 | 0.96 / 0.92 |
| Trochanterion height | 0.77 / 0.73 | 23 / 25 | 0.93 / 0.90 |
| Crotch height | 0.75 / 0.75 | 24 / 23 | 0.94 / 0.92 |
| Tibiale height | 0.75 / 0.72 | 13 / 14 | 0.94 / 0.89 |
| Sitting height | 0.56 / 0.59 | 22 / 22 | 0.88 / 0.88 |
| Acromion–radiale length | 0.67 / 0.66 | 10 / 10 | 0.74 / 0.71 |
| Radiale–stylion length | 0.53 / 0.53 | 11 / 10 | 0.73 / 0.69 |
| Biacromial breadth | 0.37 / 0.43 | 16 / 15 | 0.37 / 0.57 |
| Bicristal breadth | 0.48 / 0.46 | 16 / 13 | 0.65 / 0.54 |
| Chest girth | 0.78 / 0.86 | 39 / 32 | 0.88 / 0.86 |
| Waist girth (navel) | 0.79 / 0.84 | 44 / 44 | 0.89 / 0.94 |
| Buttock girth | 0.88 / 0.88 | 27 / 27 | 0.89 / 0.90 |
| Proximal thigh girth | 0.86 / 0.84 | 21 / 24 | 0.89 / 0.84 |
| Calf girth | 0.67 / 0.70 | 17 / 16 | 0.82 / 0.72 |
| Biceps girth, flexed | 0.79 / 0.68 | 15 / 19 | 0.79 / 0.79 |
| Neck girth | 0.60 / 0.66 | 12 / 15 | 0.66 / 0.69 |

Not predictable: lateral malleolus height (R² 0.20), head breadth/length/girth (0.06–0.22), hand and foot breadth (0.3). Biacromial breadth at about 0.4 means shoulder width is essentially individual and cannot be derived from stature and BMI.

- **NHANES fits** (same form, civilian, full BMI range; F / M): waist R² 0.85 / 0.87 (residual 64 / 57 mm), hip 0.92 / 0.89 (45 / 41), mid-thigh 0.78 / 0.74 (39 / 33), calf 0.73 / 0.75 (24 / 20), relaxed upper arm 0.86 / 0.81 (21 / 20). Per decade of age at equal BMI, waist grows 1.4 % / 2.0 % and thigh shrinks 1.4 % / 2.1 %.
- **Cross-dataset check** (ANSUR-fitted model applied to NHANES people): restricted to age ≤ 45 and BMI inside the ANSUR range, the bias is +3 / −8 mm for hip, +2 / −2 mm for calf, −8 / −21 mm for waist (different waist level, and soldiers have smaller waists). Over all ages the waist is under-predicted by 29–46 mm (F) and 50–61 mm (M); at BMI ≥ 35 the hip is under-predicted by 46–48 mm. So girths outside the ANSUR BMI range should use the NHANES coefficients. Thigh girth and upper-arm length are defined differently in the two surveys (7–15 cm and 1–4 cm apart) and cannot cross-validate.
- **Check against Chinese data**: with the GB/T 10000-1988 P50 stature and weight, shoulder height, tibial height, biacromial breadth (F), hip breadth and hip girth are within ±1 SD; **Chinese sitting height is 21–25 mm greater (+1.0 to +1.1 SD, i.e. leg-length factor about −1), the forearm 17–18 mm shorter (−1.7 to −1.8 SD), bideltoid breadth 16–20 mm narrower**. For the 2020 20–24 group the NHANES fit over-predicts waist by 71 mm (F) and 60 mm (M) but hip by only +13 / −14 mm: young Chinese adults have smaller waists at equal BMI, so the waist should use the ANSUR coefficients or its own correction.
- **Population presets** (stature mm / BMI): ANSUR II F 1626 / 25.3, M 1755 / 27.5; NHANES 20–39 F 1628 / 27.2, M 1761 / 27.7; NHANES non-Hispanic Asian 20–39 F 1583 / 22.9, M 1732 / 26.0; China 20–24 (2020 means) F 1606 / 21.6, M 1726 / 23.6; GB/T 10000-1988 P50 F 1570 / 21.1, M 1678 / 21.0.

## 3. Where our male and female bodies sit

The measurer `measure.py` takes bony landmarks from the bone meshes (ANSUR definitions) and girths from horizontal sections of the skin (convex-hull perimeter, as a tape would). Bony points lie 3–10 mm under the skin marks ANSUR measures to, so |z| < 0.5 is not meaningful. z is against the prediction for the same stature and BMI; "difference" is against the same stature at BMI 22.

Pose: male upper arm abducted 9.6°, forearm 11°, forearm 12° forward; female upper arm 9–10°, forearm 12–15°, 13° forward.

**Male** (stature 1719 mm, 30th percentile of ANSUR men; skin volume 70.0 L, BMI 23.9 at 1010 kg/m³)

| Measurement | Value mm | z | Note |
|---|---|---|---|
| Biacromial breadth | 333 | −5.5 | 67–71 mm narrower than predicted; lowest of 4,082 men |
| Cervicale height | 1447 | −3.3 | 34 mm low |
| Forearm length | 237 | −2.5 | 25 mm short |
| Bicristal breadth | 289 | +2.1 | 27–31 mm wide |
| Acromial height | 1423 | +1.3 | |
| Trochanterion, tibiale, lateral malleolus height | 887 / 451 / 71 | +0.3 / −0.4 / +0.1 | lower-limb lengths normal |
| Crotch height (skin) | 780 | −2.2 | 49–52 mm low |
| Chest / waist (navel) / buttock girth | 1018 / 785 / 907 | +1.5 / −1.3 / −1.6 | large chest, small waist and hip |
| Waist (iliac crest, vs NHANES) | 779 | −2.3 | 111 mm smaller than US civilians |
| Calf / neck girth | 392 / 397 | +1.7 / +1.5 | |

The male skin's upper arm is also fused to the trunk down to 70 % of the way from shoulder to elbow (a very low axilla).

**Female** (stature 1670 mm, 74th percentile of ANSUR women; current skin volume 70.7 L, BMI 25.6; the donor herself was about BMI 36)

| Measurement | Value mm | z | Difference from same stature at BMI 22, mm | Note |
|---|---|---|---|---|
| Acromial height | 1423 | +3.6 | +54 | acromion 4 mm above the C7 spinous tip (normally about 6 cm below): raised shoulder girdle |
| Iliocristale height | 966 | −3.0 | −58 | |
| Trochanterion height | 823 | −2.1 | −46 | short lower limbs |
| Lateral femoral epicondyle / tibiale height | 447 / 427 | −2.0 / −1.9 | −31 / −24 | |
| Lateral malleolus height | 87 | +4.2 | +23 | above every woman in the sample; the feet are warped male feet |
| Upper arm / forearm length | 297 / 218 | −2.2 / −2.9 | −21 / −29 | |
| Hand length | 210 | +3.1 | +27 | the hands are warped male hands |
| Biacromial breadth | 326 | −3.3 | −42 | |
| Bicristal breadth | 296 | +1.0 | +30 | |
| Crotch height (skin) | 710 | −4.3 | −99 | |
| Neck girth | 441 | +7.7 | +123 | above every woman in the sample |
| Chest girth | 1032 | +1.6 | +144 | |
| Chest depth | 280 | +1.7 | +52 | |
| Waist girth (navel) | 790 | −1.8 | +5 | |
| Buttock girth | 965 | −2.7 | −7 | |
| Proximal thigh girth | 545 | −3.9 | −30 | |
| Mid-thigh girth (NHANES) | 529 | +0.3 | +52 | |
| Calf girth | 401 | +1.2 | +44 | |
| Forearm / wrist girth | 294 / 175 | +2.3 / +3.0 | +41 / +21 | |
| Relaxed upper-arm girth (NHANES) | 301 | −0.2 | +25 | |

Segments against the standard for her stature (measured / expected): head and neck 1.06, trunk 1.06, thigh 0.96, lower leg 0.87, ankle height 1.36, upper arm 0.93, forearm 0.88, hand 1.15, shoulder width 0.89, pelvis width 1.11. Her "stature" is itself unreliable: skull and feet are warped male parts, and the ankle height adds about 2 cm.

**Corrections the data support**:
- Neck girth down by about 12 cm, chest girth by about 14 cm, chest depth by about 5 cm; forearm girth by 4 cm, wrist by 2 cm, calf by 4 cm.
- Proximal thigh girth up by about 3 cm, buttock girth essentially unchanged — i.e. turn the male "inverted triangle" into a female hip-and-thigh distribution.
- Waist girth at navel level is already close to the 785 mm of a BMI-22 woman.
- Remove the male external genitalia from the skin.
- The raised shoulder girdle, short lower limbs and six lumbar vertebrae belong to the donor's skeleton and positioning, not to the skin; whether to change them is your decision (section 8).

## 4. Calibration of the parametric models

Each sample's BMI comes from its mesh volume; it is then compared with real people of that stature and BMI. Mean z (mean difference in mm) for BMI 18.5–25 / 25–30:

| Measurement | Anny F | Anny M | MHR female side | MHR male side |
|---|---|---|---|---|
| Chest girth | +1.0 (+43) / +0.9 (+44) | −1.3 (−39) / −1.9 (−64) | −0.7 (−26) / 0.0 (+2) | −4.3 (−113) / −2.5 (−74) |
| Waist (iliac crest, NHANES) | +0.1 (+10) / −1.0 (−45) | −0.3 (−11) / −0.4 (−23) | +0.9 (+51) / +1.4 (+93) | −0.5 (−23) / −0.1 (−7) |
| Hip (NHANES) | −0.3 (−13) / −1.7 (−78) | +0.1 (+3) / −0.1 (−7) | +0.9 (+36) / +0.6 (+26) | −0.1 (−1) / +0.2 (+7) |
| Mid-thigh (NHANES) | 0.0 (−3) / +0.3 (+10) | +0.4 (+10) / +0.3 (+9) | +0.5 (+19) / +0.4 (+16) | +0.4 (+12) / +0.7 (+22) |
| Calf (NHANES) | −0.8 (−23) / −0.4 (−13) | +0.3 (+7) / +0.3 (+8) | −0.6 (−14) / −0.6 (−14) | +0.2 (+3) / +0.2 (+4) |
| Upper arm (NHANES) | 0.0 (0) / +2.0 (+49) | −0.9 (−16) / +0.2 (+6) | +0.3 (+5) / +0.3 (+5) | +0.8 (+14) / +0.9 (+17) |
| Proximal thigh | −1.1 (−27) / −1.6 (−42) | −0.3 (−8) / −0.8 (−19) | −1.4 (−28) / −2.0 (−48) | −1.4 (−26) / −1.4 (−29) |
| Ankle | +1.1 (+16) / +1.3 (+19) | +1.7 (+19) / +1.9 (+23) | −1.0 (−12) / −0.9 (−11) | −0.4 (−4) / −0.3 (−3) |
| Forearm | −1.5 (−16) / +1.6 (+22) | −3.6 (−44) / −3.0 (−39) | −2.5 (−24) / −2.2 (−24) | −1.8 (−20) / −1.9 (−23) |
| Wrist | −3.6 (−20) / −2.1 (−12) | −5.3 (−32) / −3.4 (−22) | −1.0 (−5) / −1.0 (−5) | −1.5 (−8) / −1.6 (−9) |

Mean |z| over 11 girths: Anny F 1.48, M 1.70; MHR female side 1.05, male side 1.12. Over the five NHANES girths only: Anny 1.11 / 0.99, MHR 0.70 / 0.66.

**Anny / MakeHuman** (13,718 vertices, 163 bones, A-pose with slightly bent elbows; in Anny gender 0 = male, 1 = female, age 2/3 = young adult)
- Parameter to stature: height 0 / 0.5 / 1 → F 1224 / 1769 / 2313 mm, M 1364 / 1909 / 2454 mm. The default (0.5) is a 1.77 m woman and a 1.91 m man.
- Parameter to BMI (height 0.5): for women at muscle 0.5, weight 0→1 spans only 17.7→23.2; at muscle 0 it spans 13.8→34.0. For men at muscle 0.5, 21.6→25.7; at muscle 0, 16.1→41.2. "Weight" is therefore not fatness: an obese body needs muscle at 0 as well.
- Shape changes are not plain linear blendshapes: the coefficients are products of piecewise-linear interpolation weights (multilinear), 1,132 blendshapes in all.
- MakeHuman's local `measure-*` targets are also exposed (waist, hip, bust, thigh, upper-arm and neck girth, shoulder distance, segment lengths) and can fit a mesh to given girths.
- Biases: thin wrists and forearms, thick ankles, male chest 4–9 cm small, female hip 8 cm small in the overweight class; the proportions parameter 0→1 moves crotch height / stature from 0.482 to 0.462 (F).

**MHR** (LOD 1: 18,439 vertices, 127 joints, at most 4 weights per vertex, A-pose; centimetres, same axes as ours)
- 45 identity coefficients (the first 20 for the body). No sex or fatness labels; renders confirm that **coefficient 1 is fatness and coefficient 2 is sex** (positive = female).
- Linear map (119 samples): BMI = 28.6 + 5.8·c1 (R² 0.99); waist = 1047 + 164·c1 + 38·c2 mm; hip = 1097 + 121·c1 + 45·c2 mm. The mean body is overweight, BMI 28.6.
- Identity does not change stature (1727 mm) or joint positions; skeleton proportions have separate scale parameters (spine, neck, shoulder width, upper arm, forearm, hip width/height/depth, thigh, lower leg, ankle height, foot length; one unit = 10 cm).
- Biases: on the female side the waist is 5–12 cm larger than NHANES women of equal BMI (11–15 cm larger than ANSUR), waist depth +2.7 to +3.2 SD — an abdominal build; on the male side the chest is 11 cm small at BMI 18.5–25; forearms 2 cm thin.

**Biases of the measurer itself** (same sign in every model, so not a property of the models): chest breadth +1.8 to +3.5 SD (the cut at the axillary folds is wide); hip breadth +1.6 to +3.8 SD (feet apart); neck girth (horizontal section; ANSUR's plane is tilted) +4 to +7 SD on MHR; crotch height 2–4 cm low on most models. Do not draw conclusions from these four.

## 5. Subcutaneous fat

`fat-literature.json`: 27 sources (23 opened in full text or as official tables), 114 site-thickness rows, 27 regressions, 48 partition rows. **No open paper stratifies thickness by both sex and BMI at all sites**; the one that does (Störchle 2017) could not be fetched automatically and must be opened by hand.

Thickness functions adopted in the proposal, t = max(floor, a + b·BMI), mm, excluding about 2 mm of skin:

| Site | F a, b | M a, b | Basis | Reliability |
|---|---|---|---|---|
| Anterior abdomen | −8.47, 1.14 | −13.82, 1.14 | Sim 2014 regression (Korea, ultrasound), at age 22 | measured regression |
| Posterior upper arm | 2.09, 0.403 | −1.25, 0.403 | Sim 2014 | measured regression |
| Deltoid | −2.1, 0.40 | −3.9, 0.39 | Kowatari 2023 (Japan, age 22) | measured regression |
| Anterior thigh | −4.79, 0.710 | −7.10, 0.647 | Jain 2013 class means, line fitted here | derived from class means |
| Buttock | 11.5, 0.239 | 5.8, 0.239 | Gibney 2010 pooled class means ± half the sex difference | derived; sex and BMI never stratified together |
| Calf | −7.7, 0.495 | −5.1, 0.33 | Störchle 2018 (10 men); women taken as 1.5× | weak |
| Forearm | 0.4, 0.075 | 0.0, 0.05 | same | weak |
| Anterior chest (outside the breast) | −2.7, 0.405 | −1.8, 0.27 | same | weak; female factor assumed |
| Back | 0.7, 0.21 | 0.4, 0.14 | same | weak |

Worked values (F, BMI 18.5 / 22 / 25 / 30 / 35): abdomen 12.6 / 16.6 / 20.0 / 25.7 / 31.4; posterior arm 9.5 / 11.0 / 12.2 / 14.2 / 16.2; anterior thigh 8.3 / 10.8 / 13.0 / 16.5 / 20.1; buttock 15.9 / 16.8 / 17.5 / 18.7 / 19.9; calf 1.5 / 3.2 / 4.7 / 7.1 / 9.6 mm.
M (same BMI): abdomen 7.3 / 11.3 / 14.7 / 20.4 / 26.1; posterior arm 6.2 / 7.6 / 8.8 / 10.8 / 12.9; anterior thigh 4.9 / 7.1 / 9.1 / 12.3 / 15.5; buttock 10.2 / 11.1 / 11.8 / 13.0 / 14.2; calf 1.5 / 2.2 / 3.2 / 4.8 / 6.5 mm.

Against the median thicknesses a colleague measured on our female donor's CT (BMI about 36; anterior abdomen 33, thigh 23, hip 30, calf 12 mm), the formulas at BMI 36 give abdomen 32.6, thigh 20.8, calf 10.1 — in agreement; buttock 20.1 against 30, so **the buttock formula is about 10 mm low**.

Other points: visceral/subcutaneous ratio (Hong Kong Chinese, MRI) 0.39–0.46 in men and 0.21–0.28 in women, changing little with BMI; android/gynoid ratio (DXA) about 0.26–0.3 in young women and 0.38–0.4 in young men; breast volume about +53 mL per BMI unit (about 370 mL at BMI 18.5–25, 690 mL at 25–30, 1065 mL at ≥ 30); body fat % = 1.20·BMI + 0.23·age − 10.8·sex (male = 1) − 5.4 (Deurenberg 1991). Gaps: suprailiac site; female population values for back, forearm and calf; very little Chinese data; most injection-site data come from people with diabetes aged 50–65.

## 6. Proposed body-shape model (Rig.shape)

**Controls** (four scalars, one coefficient table per sex): stature (1.40–2.00 m), BMI (16–40), relative leg length (±2 SD), mass distribution (±2 SD). Rest values: male 1.720 m / BMI 23.9 / 0 / 0; female depends on which skin is adopted.

**(i) Stature and proportions → per-joint segment scales.** This is the part the data support best, and it is what MHR does.
- Scale of each segment along its bone axis = model(controls) / model(rest controls). Segment lengths are linear combinations of ANSUR outputs: head and neck = stature − cervicale height; trunk = cervicale − trochanterion height; thigh = trochanterion − lateral femoral epicondyle height; lower leg = epicondyle − lateral malleolus height; upper arm, forearm, hand, foot; shoulder width = biacromial; pelvis width = bicristal.
- Worked values (F, stature 1606 mm, BMI 22): head and neck 232, trunk 544, thigh 374, lower leg 395, upper arm 305, forearm 236, shoulder width 358 mm. Leg-length factor −1.5 / 0 / +1.5: thigh 364 / 374 / 385, lower leg 377 / 395 / 414, trunk 563 / 544 / 523, sitting height 876 / 848 / 821 mm.
- M (1726 mm, BMI 22): head and neck 241, trunk 599, thigh 404, lower leg 412, upper arm 328, forearm 263, shoulder width 400 mm; leg-length factor −1.5 / 0 / +1.5: thigh 390 / 404 / 419, lower leg 397 / 412 / 428, trunk 619 / 599 / 578 mm.
- **Bone scales must be evaluated at a fixed BMI (22)**: ANSUR "bicristal breadth" grows from 243 to 301 mm with BMI; that is soft tissue, not a wider pelvis.
- Where it falls short: the spine is not one rigid segment, so trunk scaling has to be spread over the intervertebral joints; transverse bone dimensions (shoulder width, pelvis width, rib cage) scale with a different exponent from lengths (0.6–0.7 on stature for biacromial breadth against about 1.1 for lengths), so the scaling must be anisotropic; shoulder width is barely predictable from the controls (R² 0.4) — give it its own fine control or leave it alone.

**(ii) Fatness → skin displacement plus a subcutaneous layer.** Workable, but "displace along a smoothed normal by site weight" is not enough.
- Per-vertex attributes needed: site weights (up to 4 sites, stored like skin weights: 4 × uint8 index + 4 × uint8 weight) and a smoothed normal (10 bit). Table: the 9 sites of section 5 × sex × (a, b, floor). Displacement = Σ weight × [t(sex, BMI) − t(rest)]. About 8 bytes per vertex, affordable on skin and fat layer within 2.2 M triangles; internal structures need none of it.
- **Where it is wrong**:
1. Breast: volume grows with BMI but the breast also descends and moves down and outwards; that is not inflation along the normal. It needs a directional displacement (MakeHuman uses 9 targets over cup size × firmness; MHR has it inside its identity components).
2. Abdomen: obesity produces overhang and folds, displaced forwards and downwards; visceral fat pushes the abdominal wall muscles, not the skin, most of all in men (visceral/subcutaneous 0.4 against 0.2 in women). The abdomen therefore needs two terms: wall moved outwards (visceral) plus a thicker subcutaneous layer.
3. Buttock: the gluteal fold descends and the buttock deforms backwards and downwards; the literature shows gluteal subcutaneous thickness rising slowly with BMI (13.7 → 16.6 mm), so the girth gain is mostly a change of shape.
4. Self-intersection in concavities: axilla, groin, gluteal cleft, inner thighs, between neck and jaw — a normal displacement larger than the local radius of curvature makes surfaces pass through each other. Weights must be reduced there and a collision limit applied (inner-thigh displacement no greater than the distance to the midsagittal plane), at runtime or precomputed.
5. The thickness formulas give thickness while the survey data give girths, and the two must agree. Use girth as the constraint: the girth target G(controls) at a site comes from section 2 and the muscle-envelope perimeter Gm is known, so mean fat thickness ≈ (G − Gm)/(2π) − skin, distributed around the section by the site weights (more in front of the abdomen, less at the flank and back). The two data sets then check each other and the skin girth cannot drift away from anthropometry.
- Against the parametric models: neither Anny/MakeHuman nor MHR has a fat layer; they deform the skin directly and have no skeleton or interior. MHR's component 1 is precisely a learned, directional, whole-body fat displacement field — **it can be used as the direction for (ii)**: transfer the c1 field (and the c2 sex-difference field) onto our skin by registration, store one 3-component displacement per vertex (3 × 16 bit) and multiply at runtime by (BMI − rest) / 5.8. That costs 6 bytes per vertex more than a normal displacement and solves the direction problem for breast, abdomen and buttock at once. Recommendation: skin driven by the transferred field, inner face of the fat layer following the muscles, layer thickness being the difference; the thickness table of section 5 is used to validate and clamp.

**(iii) Muscularity → muscle cross-sections scaled about their lines of action.** The contract's `MuscleLine` already has the volume-preserving scale; multiply it by one more factor.
- The data support only the effect of f2 (mass distribution) and BMI on limb girths: for men, f2 from −1.5 to +1.5 takes the flexed biceps girth from 328 to 299 mm (BMI 22). Subtracting fat gives a muscle radius r = G/(2π) − t − skin, and scale = r(controls) / r(rest).
- Where it falls short: only fusiform muscles with a clear line of action; flat muscles (abdominal wall, latissimus, pectoralis major) and the glutei need scaling in thickness; bones do not thicken with them, so large scales lift muscles off bone or push them into each other; ANSUR has no independent muscularity variable, so a separate "muscle" slider should be labelled an approximation.

**Data needed per control**

| Control | Per-vertex / per-part data | Tables |
|---|---|---|
| Stature, relative leg length | existing part-to-joint bindings and skin weights | 11 segments × (a, b, L1) per sex, from anthro-model.json |
| BMI | skin and fat layer: displacement field 3 × int16 (or normal + 4 site weights) | 9 sites × sex thickness coefficients; (a, b, c) for 13 girth sites |
| Mass distribution | same (waist and limb sites with opposite sign) | L2 of each girth |
| Muscle cross-section | existing MuscleLine; one thickness direction per flat muscle | muscle-radius formula per segment |

## 7. The reference female surface (for immediate use)

`data/raw/bodyshape/out/reference-female/`: `skin.obj` (MHR LOD 1 topology, 18,439 vertices, 36,874 triangles, our frame), `weights.bin` (51,337 skin-weight records), `joints.json` (127 joints), `manifest.json`, `fit.json`, previews. Also `reference-female-bmi28/` (same method, BMI 28) and `anny-female/` (Anny/MakeHuman young-adult female mesh, rig, weights and macro displacements, CC0).

- **Standard**: female, stature 1.670 m (our female skeleton's, not a population median — the surface has to fit her bones), BMI 22 (middle of the normal range by both WHO and Chinese cut-offs). Girth targets from NHANES (waist, hip, mid-thigh, calf, upper arm) and ANSUR II (chest, waist, proximal and lower thigh, ankle, wrist).
- **Method**: identity coefficients (the first 6, coefficient 2 held ≥ 1.5 to keep a female shape) solved from the girth targets; MHR's 11 skeleton-scale parameters and joint angles fitted to her 12 joint centres, vertex, soles, toes and fingers, with a penalty on bones leaving the skin.
- **Girths reached** (target → obtained, population SDs in brackets): BMI 22.0 → 22.0; waist (iliac) 821 → 787 (−0.7); hip 959 → 1023 (+1.6); mid-thigh 477 → 498 (+0.6); calf 352 → 335 (−0.8); upper arm 276 → 274 (−0.2); chest 889 → 873 (−0.4); waist (navel) 785 → 739 (−1.0); proximal thigh 575 → 540 (−1.7); ankle 211 → 203 (−0.7); wrist 153 → 146 (−1.5). The large hip and the thin proximal thigh and wrist are the limit of MHR's shape space on this skeleton.
- **Joint residuals**: shoulder and elbow 0.8–1.3 mm; hip 4–7 mm; knee 8–11 mm; ankle 5–6 mm; wrist 6–7 mm; fingers about 20 mm (the hand pose was not matched).
- **Skeleton scales found by MHR**: spine +7.8 cm, thigh −6.1 cm, lower leg −6.0 cm, forearm −4.1 cm, hip height +3.3 cm, hip depth +3.2 cm, hip width +1.8 cm, ankle height +1.9 cm, shoulder width −1.0 cm — consistent with section 3 (long trunk, short lower limbs and forearms).
- **Does her internal model fit?** (signed distance from her muscle vertices to the reference skin; positive = outside)

| Region | BMI 22: outside / more than 5 mm outside / 90th percentile mm | BMI 28: outside / 90th percentile mm |
|---|---|---|
| Head | 6 % / 1 % / −1 | 6 % / −1 |
| Neck | 4 % / 2 % / −5 | 0.4 % / −13 |
| Shoulder | 17 % / 12 % / +6 | 4 % / −5 |
| Chest | 2 % / 1 % / −10 | 0 % / −23 |
| Abdomen | 20 % / 10 % / +5 | 1.5 % / −8 |
| Pelvis and buttock | 5 % / 2 % / −4 | 0 % / −17 |
| Thigh | 16 % / 11 % / +6 | 6 % / −5 |
| Knee | 38 % / 30 % / +15 | 28 % / +10 |
| Lower leg | 12 % / 5 % / +1 | 5 % / −4 |
| Upper arm | 9 % / 6 % / −2 | 3 % / −5 |
| Forearm | 47 % / 31 % / +18 | 36 % / +12 |
| Hand / foot (outside fraction only) | 19 % / 11 % | 19 % / 10 % |

Bones: at BMI 22, 53 % of knee bone vertices are outside the skin (90th percentile +25 mm), 37 % in the forearm, 16 % in the lower leg, 14 % at the shoulder, 12 % in the abdomen (lower ribs and lumbar spine); at BMI 28 the knee still has 46 %, the forearm 22 % and the lower leg 10 %, with every trunk region ≤ 2 %. Hand and foot bones are 29–35 % outside at both BMIs (pose not matched). The knee pokes out at both BMIs, which points to a knee-axis / patella registration error rather than soft-tissue thickness.

Muscles furthest outside (95th percentile, BMI 22): extensor carpi radialis longus 29–33 mm, anconeus 26–33 mm, extensor digitorum 26–31 mm, acromial and spinal parts of deltoid 25–27 mm, brachioradialis 21–26 mm, sartorius and gracilis 19–20 mm.

- **Soft-tissue margin under the skin** (median distance from the reference skin to her muscle/bone surface): at BMI 22, abdomen 2.9 mm, forearm 3.5, upper arm 4.7, lower leg 5.1, chest 5.8, thigh 14.6, pelvis 21.0 mm; a BMI-22 woman should have subcutaneous fat of 16.6 mm at the abdomen, 11.0 at the arm, 10.8 at the thigh, 3.2 at the calf. **Conclusion: except at the thigh and buttock, the warped muscle envelope is larger than a BMI-22 woman's — by about 10 mm per side on the trunk and upper arm and 2–3 cm at the forearm extensors.** At BMI 28 the margins are abdomen 18.3, thigh 24.8, chest 16.5 mm, which is reasonable. For comparison, the male skin sits at a median of 7.4 mm (abdomen), 14.5 (upper arm), 15.5 (thigh) and 9.0 mm (lower leg) above his own muscles.
- **Defects of this surface**, stated plainly: the head is tilted slightly back; the shoulders look shrugged because her shoulder girdle is raised; there are creases at the gluteal fold and perineum; the LOD 1 mesh is coarse and renders faceted; finger and toe poses do not match; the chest is 16 mm under target. It is fit to serve as a shape target and a measurement reference, not as the final skin without further work.

## 8. Decisions needed from you, and blockers

1. **Default reference population**: I suggest the Chinese 20–24 means (F 160.6 cm / 55.7 kg / BMI 21.6; M 172.6 cm / 70.4 kg / BMI 23.6) for default stature and BMI, with proportion and girth functions from ANSUR II / NHANES (China has no redistributable individual-level data) plus the corrections quantified above: leg-length factor about −1, forearm about −7 %, waist from the ANSUR coefficients. Accept?
2. **GB/T 10000-2023**: someone has to open the online preview on openstd.samr.gov.cn in a browser and transcribe Tables 1/6 (18–70) and 2/7 (18–25) by hand. With those, the corrections above can be fixed properly.
3. **Source of the female skin**: MHR (Apache-2.0, more realistic shape, licence text and attribution must ship with the app; it can sit alongside CC BY-SA content, but those files must be labelled with their own licence) or Anny/MakeHuman (CC0, no attribution duty, biased wrists, forearms and ankles). I recommend MHR as the shape source.
4. **Internals do not fit the surface**: either set the female rest BMI at about 28 (the internals mostly fit) or have the pipeline shrink the warped muscle cross-sections (about 10 mm per side on trunk and upper arm, more at the forearm extensors) and use BMI 22. That work is on the pipeline side.
5. **Whether to normalise her skeleton**: shoulder girdle raised by about 5 cm, short lower limbs (lower-leg ratio 0.87, including the ankle-height artefact), short forearms, six lumbar vertebrae. Scaling to the standard would give normal proportions, but it would no longer be the donor's real skeleton.
6. **The male model**: biacromial breadth 333 mm (−5.5 SD), short forearms, very low axilla. Shape controls will carry these individual traits along proportionally; should they be corrected?
7. **Not done**: the MHR displacement field was not transferred onto our skin (the approach recommended in section 6); no numerical trial of muscle cross-section scaling; no separate calibration of the parametric models against a Chinese population; I did not re-verify the literature numbers extracted by the sub-tasks; four key papers (Störchle 2017 among them) were not read.

## 9. Files and how to reproduce

```
bash tools/bodyshape/download.sh                 # ANSUR II, NHANES -> data/raw/bodyshape/
bun tools/bodyshape/export-parts.ts male female  # GLB -> neutral binary
PY=data/raw/bodyshape/.venv/bin/python           # uv venv (Python 3.12); numpy pandas scipy scikit-learn trimesh matplotlib libigl torch pillow anny
$PY -I tools/bodyshape/fit_anthro.py             # -> anthro-model.json
$PY -I tools/bodyshape/measure.py male female && $PY -I tools/bodyshape/compare.py male female   # -> our-bodies.json
$PY tools/bodyshape/calibrate_anny.py; $PY tools/bodyshape/calibrate_mhr.py; $PY -I tools/bodyshape/calibration_report.py   # -> model-calibration.json
$PY -I tools/bodyshape/build_shape_model.py      # -> shape-model.json
$PY tools/bodyshape/reference_female.py [--bmi 28]; $PY tools/bodyshape/export_anny.py
```

The MHR assets (`assets.zip`, v1.0.1) and the Anny source archive go under `data/raw/bodyshape/models/` (see `mhrlib.py`, `annylib.py`). `data/raw/bodyshape/` holds 2.5 GB. The checked-in tables are in `data/curated/bodyshape/`: `anthro-model.json`, `our-bodies.json`, `model-calibration.json`, `shape-model.json`, `fat-literature.json`, `refpop-china.json`.

---

# 第二部分（中文）

## 10. 男性肩峰间宽 −5.5 个标准差：一半是真的，一半是标志点

- 锁骨长度正常：左右各 152 mm。肩胛带不是整体偏小。
- 锁骨姿势是主因：上抬 14–15°、向后偏离冠状面 32–34°。同样的锁骨若为 10° 和 20°，肩峰间宽约多 36 mm（这两个“典型值”凭记忆，未查到出处）。这与仰卧成像时肩部后坠、上耸一致。
- 两侧肱骨头中心相距 325–329 mm；同身高的 MHR 平均体为 352 mm（窄 7 %）。
- 胸廓不窄：肋骨最大横径 273 mm。三角肌水平的皮肤宽 480 mm，MHR 为 468 mm。
- 标志点因素：该肩胛骨最外侧点（x = 166 mm）只比肱骨头中心靠外 1–2 mm，比大结节靠内 24 mm；活体上摸到的肩峰点更靠外，且量在皮肤上。
- 建议：把盂肱关节间距加宽约 25 mm（到约 350 mm），做法是把锁骨向前、向下转，而不是缩放骨骼。as-built 预设里的 shoulderWidth 0.833 是按骨性肩峰点算的，不要直接取倒数。
- 前臂：按东亚修正后的标准，男性前臂比值为 0.998，不是离群值，无需修正。

## 11. 男性新皮肤（MHR LOD0）

`data/raw/bodyshape/out/male-skin/`：73639 顶点、147274 三角形，单层，手臂与躯干分开。

- 做法：MHR 的 45 个身份系数、骨架缩放和姿势一起拟合（关节对 rig.json，表面贴原皮肤的可信部分），再加一层平滑的逐顶点修正（中位 2.0 mm，第 95 百分位 10.9 mm，上限 20 mm）。修正前各区域中位偏差 1–9 mm。
- 与原皮肤外表面的距离（可信顶点，分区域）：中位 0.06–0.46 mm，第 90 百分位 0.3–1.5 mm。可信顶点占 96 %；上臂 88 %（原先相连的区域）。
- 体积 70.0 → 69.8 L（BMI 23.9 → 23.8）。围度相差不超过 4 mm；例外是胸围 −10 mm、上臂围 +11 mm，都在原先相连的腋部。
- 间隙：上臂到躯干 8.7 / 9.2 mm，两大腿之间 1.9 mm。
- 肌肉穿出：躯干和上肢 ≤ 0.1 %；大腿、膝、小腿、头 1–3 %，几乎都在 5 mm 以内。最多的是右缝匠肌 3.4 mm、颞顶肌 2.3–2.8 mm、右股薄肌 2.3 mm（第 95 百分位）。缝匠肌和股薄肌在大腿内侧相贴处：把两腿分开占用了肌肉几毫米。
- 骨穿出：除手 7.4 %（手指姿势）和足 2.3 % 外均为 0。
- 关节残差：肩、肘、腕、髋、踝 2–4 mm；膝 16 mm；手指 PIP、DIP 多为 1–6 mm，MCP 5–8 mm。
- 腹股沟：MHR 本身是光滑的（无外生殖器、无乳头、无脐，足趾是一整块，由渲染图看到）。修正层在原皮肤外生殖器处带回了一个压平的隆起。BodyParts3D 的阴茎、阴囊部件没有对新皮肤做检验，很可能穿出。
- LOD：MHR 有 7 级（73639 / 18439 / 10661 / 4899 / 2461 / 971 / 595 顶点），每级都有身份形变和蒙皮权重。用 LOD0，需要 `mhr` 和 `pymomentum-cpu` 包。
- 膝关节：MHR 的膝关节点离解剖学屈伸轴中心约 14–19 mm；硬对上会把膝部皮肤顶出（肌肉穿出达 19 mm）。现在膝关节权重很小，由表面决定。

## 12. 体型场

每个皮肤目录里有 `shape-fat.f32`、`shape-sex.f32`、`shape-limit.f32`、`shape-fields.json`。

- 胖瘦场：每个 BMI 点的位移（米），我们的静止姿势。是 MHR 第 1、3–6 身份分量按一个方向的组合，方向由 NHANES/ANSUR 围度随 BMI 的变化校准；比单用第 1 分量略好（11 项围度 RMS 23.6 对约 26 mm）。
- 线性：固定姿势下对系数严格线性。与真人随 BMI 的变化相比（相对静止 BMI）：
  - 男：BMI 17–30 各围度在约 ±3 cm 内；35 时腰 +70 mm、胸 +51 mm；40 时腰 +111 mm、胸 +94 mm。
  - 女：17–30 多数在约 ±3 cm 内，臀围在 17 时 +39 mm，腰围在 30 时 +48 mm；35 时腰 +88 mm；40 时腰 +135 mm。
  - 体积 BMI 超出目标：男 35 / 40 时 +1.0 / +2.4，女 +2.1 / +3.8。
- 分两段没有帮助：一条直线、拐点在 25 / 27.5 / 30 的两段、逐 BMI 最优，RMS 都是 23.7 mm（女性都是 42 mm）。残差是固定的形状偏差，不是弯曲。
- 体积超出用查找表 `bmiToFieldUnits` 修正（如男性目标 BMI 30 → +6.02，40 → +14.28）。
- 线性的 MHR 场表现不了：腹部悬垂的出现、乳房下垂、臀沟下移。没有数据可补。
- 位移上限：每顶点沿场方向到对面皮肤距离的一半。0.3 % 的顶点上限小于 5 mm；男性 1.25 % 的顶点在 +15 个 BMI 点之前会碰到对面。
- 脂肪部件：`followsSkin = dEnvelope / (dEnvelope + dSkin)`（脂肪顶点到肌肉包络和到皮肤的距离）；位移 = followsSkin × 最近皮肤点的位移。

## 13. Rig.shape 数据格式（建议）

`data/curated/bodyshape/rig-shape.json`，每个性别：

- `controls`：身高、bmi、legLength、centralBuild 及静止值（与 `ShapeParam` 兼容）。
- `segments`：11 个肢段，用骨架关节 id 命名（`hip`→`knee`、`gh`→`elbow`、`gh_R`↔`gh_L` 等），各有 `bStature`、`legLength`、`centralBuild`、`standardLengthMm`。缩放 = (身高/静止身高)^bStature · exp(legLength·Δ + centralBuild·Δ)；骨在固定 BMI 下求值。
- `girths`（13 处）、`fat`（9 处）：系数和标准值。
- `fields`：文件名、`bmiToFieldUnits`、MHR 方向。
- `presets`：`standard`、`asBuilt`、`ansur`。
- 静止值即已确认的默认：女 1.606 m / BMI 21.6，男 1.726 m / BMI 23.6，legLength −1，前臂 ×0.93；`restBasis` 里写明比例和围度函数来自美国数据加修正。
- 管线要烘焙的标准长度（女 / 男，mm）：大腿 367 / 394，小腿 383 / 402，躯干 557 / 612，上臂 300 / 323，前臂 214 / 238。

## 14. 骨架组用的数据，以及女性（暂定）

- `male-skin/joints.json`：127 个关节的名称、父关节、拟合姿势下的位置和世界朝向，以及到骨架关节 id 的 `mapping`。`weights.bin`：218422 条（顶点、关节、权重），每顶点最多 7 个关节。拟合姿势即绑定姿势。
- MHR 的脊柱只有 4 个关节，与椎间关节没有一一对应。
- `skin-no-pose-correctives.f32` 是不含 MHR 姿势校正的皮肤；我没有验证用 `weights.bin` 做线性混合蒙皮能否复现它。
- 女性：`python tools/bodyshape/reference_female.py --bmi 21.6` 一条命令完成导出、测量、拟合和体型场。当前结果基于 07:42 的重建（尚未标准化），用 BMI 22：
  - 围度在目标的 1.3 个标准差内，体积 BMI 22.1。
  - 肌肉穿出：腹 45 %、前臂 52 %、骨盆 22 %、膝 24 %、头 10 %（超出 5 mm 的 2 %）、手 5 %。
  - 乳房：HRA 部件装不进 MHR 在 BMI 22 的乳房——乳头在皮肤外 43–44 mm，乳腺脂肪 74–78 %、腺叶 81–84 % 在外。
  - 女性体表没有外生殖器。头后仰和耸肩仍在，随她的颅骨和肩胛带位置而来。

## 15. 遗留问题

- 女性要在标准化之后重跑。
- 男性腹股沟的隆起留不留，他的外生殖器部件怎么办。
- 线性混合蒙皮的复现检验没有做。
- MHR 没有分开的足趾。
- `data/raw/bodyshape` 现为 4.9 GB。
- 早先的 `reference-female/`、`reference-female-bmi28/`（LOD1）已被 `female-skin/` 取代。
- 我曾有一段时间用重建前导出的旧网格拟合女性；现在脚本先重新导出，本节数字都来自新导出。

---

# Part 2 (English)

## 10. The male's biacromial breadth at −5.5 SD: half real, half landmark

- Clavicle length is normal: 152 mm on both sides. The girdle is not scaled down.
- Clavicle posture is the main cause: elevated 14–15° and angled 32–34° behind the frontal plane. With 10° and 20° the same clavicles would give about 36 mm more biacromial breadth (those two "typical" angles are from memory, not from a source I opened). This matches shoulders falling back and shrugging in supine imaging.
- Humeral head centres are 325–329 mm apart; the MHR mean body at the same stature has 352 mm (7 % narrower).
- The rib cage is not narrow: maximum rib breadth 273 mm. Skin breadth at deltoid level is 480 mm against 468 mm in MHR.
- Landmark effect: this scapula's most lateral point (x = 166 mm) is only 1–2 mm lateral to the humeral head centre and 24 mm medial to the greater tubercle; the palpated acromion in living subjects lies further out and is measured on skin.
- Recommendation: widen the glenohumeral separation by about 25 mm (to about 350 mm) by rotating the clavicles forward and down, not by scaling bones. The shoulderWidth 0.833 in the as-built preset is the bony-acromion figure and should not be inverted as it stands.
- Forearm: under the East-Asian-corrected standard the male's forearm ratio is 0.998; it is not an outlier and needs no correction.

## 11. The new male skin (MHR LOD 0)

`data/raw/bodyshape/out/male-skin/`: 73,639 vertices, 147,274 triangles, single wall, arms separate from the trunk.

- Method: MHR's 45 identity coefficients, skeleton scales and pose fitted together (joints to rig.json, surface to the trustworthy part of the old skin), then a smooth per-vertex correction (median 2.0 mm, 95th percentile 10.9 mm, capped at 20 mm). Before the correction the regional median error was 1–9 mm.
- Distance to the old outer skin (trusted vertices, by region): median 0.06–0.46 mm, 90th percentile 0.3–1.5 mm. 96 % of vertices are trusted; 88 % on the upper arm (the formerly fused zone).
- Volume 70.0 → 69.8 L (BMI 23.9 → 23.8). Girths differ by at most 4 mm, except chest −10 mm and upper arm +11 mm, both at the formerly fused axilla.
- Gaps: upper arm to trunk 8.7 / 9.2 mm, between the thighs 1.9 mm.
- Muscle poke-through: ≤ 0.1 % in trunk and arms; 1–3 % in thigh, knee, calf and head, almost all under 5 mm. Worst are right sartorius 3.4 mm, temporoparietalis 2.3–2.8 mm, right gracilis 2.3 mm (95th percentile). Sartorius and gracilis sit in the medial-thigh contact zone: separating the thighs took a few millimetres from the muscles.
- Bone poke-through: 0 everywhere except hand 7.4 % (finger pose) and foot 2.3 %.
- Joint residuals: shoulder, elbow, wrist, hip, ankle 2–4 mm; knee 16 mm; finger PIP and DIP mostly 1–6 mm, MCP 5–8 mm.
- Groin: MHR itself is smooth (no external genitalia, no nipples, no navel, toes as one block — seen in renders). The correction layer brought back a flattened bump where the old skin had genitalia. The BodyParts3D penis and scrotum parts were not tested against the new skin and will likely protrude.
- LOD: MHR ships 7 levels (73,639 / 18,439 / 10,661 / 4,899 / 2,461 / 971 / 595 vertices), each with identity blendshapes and skin weights. LOD 0 is used; it needs the `mhr` and `pymomentum-cpu` packages.
- Knee: MHR's knee joint lies about 14–19 mm from the anatomical flexion-axis centre; pinning it there pushes the knee skin out (muscles up to 19 mm outside). The knee now has a small weight and the surface decides.

## 12. Shape fields

Each skin directory holds `shape-fat.f32`, `shape-sex.f32`, `shape-limit.f32`, `shape-fields.json`.

- Fat field: displacement per BMI point (metres), in our rest pose. It combines MHR identity components 1 and 3–6 along a direction calibrated on how NHANES/ANSUR girths change with BMI; slightly better than component 1 alone (11-girth RMS 23.6 against about 26 mm).
- Linearity: exact in the coefficients at a fixed pose. Against how real people change with BMI (relative to the rest BMI):
  - Male: all girths within about ±3 cm over BMI 17–30; at 35, waist +70 mm and chest +51 mm; at 40, waist +111 mm and chest +94 mm.
  - Female: most within about ±3 cm over 17–30, hip +39 mm at 17, waist +48 mm at 30; at 35, waist +88 mm; at 40, waist +135 mm.
  - Volume BMI overshoot: male +1.0 / +2.4 at 35 / 40, female +2.1 / +3.8.
- Two segments do not help: one line, two segments with a knee at 25 / 27.5 / 30, and the per-BMI optimum all give RMS 23.7 mm (42 mm for the female in every case). The residual is a constant shape offset, not curvature.
- The volume overshoot is corrected by the lookup `bmiToFieldUnits` (e.g. male target BMI 30 → +6.02, 40 → +14.28).
- What a linear MHR field cannot show: onset of an abdominal apron, breast ptosis, descent of the gluteal fold. There is no data to add them.
- Displacement limit: per vertex, half the distance along the field to the facing skin. 0.3 % of vertices are limited to under 5 mm; 1.25 % of male vertices would reach the facing skin before +15 BMI points.
- Fat part: `followsSkin = dEnvelope / (dEnvelope + dSkin)` (distances from the fat vertex to the muscle envelope and to the skin); displacement = followsSkin × the skin displacement at the nearest skin point.

## 13. Proposed Rig.shape data format

`data/curated/bodyshape/rig-shape.json`, per sex:

- `controls`: stature, bmi, legLength, centralBuild with rest values (compatible with `ShapeParam`).
- `segments`: 11 segments named by rig joint ids (`hip`→`knee`, `gh`→`elbow`, `gh_R`↔`gh_L`, …), each with `bStature`, `legLength`, `centralBuild`, `standardLengthMm`. Scale = (stature / rest stature)^bStature · exp(legLength·Δ + centralBuild·Δ); bones are evaluated at fixed BMI.
- `girths` (13 sites) and `fat` (9 sites): coefficients and standard values.
- `fields`: file names, `bmiToFieldUnits`, MHR direction.
- `presets`: `standard`, `asBuilt`, `ansur`.
- Rest is the confirmed default: female 1.606 m / BMI 21.6, male 1.726 m / BMI 23.6, legLength −1, forearm ×0.93; `restBasis` states that proportion and girth functions are US data plus corrections.
- Standard lengths for the pipeline to bake (female / male, mm): thigh 367 / 394, lower leg 383 / 402, trunk 557 / 612, upper arm 300 / 323, forearm 214 / 238.

## 14. Data for the rig agent, and the female (provisional)

- `male-skin/joints.json`: 127 joints with names, parents, positions and world orientations in the fitted pose, and a `mapping` to rig joint ids. `weights.bin`: 218,422 records (vertex, joint, weight), up to 7 joints per vertex. The fitted pose is the bind pose.
- MHR's spine has only four joints, with no one-to-one vertebral level.
- `skin-no-pose-correctives.f32` is the skin without MHR's pose correctives; I did not verify that linear blend skinning of `weights.bin` reproduces it.
- Female: `python tools/bodyshape/reference_female.py --bmi 21.6` does export, measurement, fit and shape fields in one command. The current result is against the 07:42 rebuild (not yet standardised), at BMI 22:
  - Girths within 1.3 SD of target, volume BMI 22.1.
  - Muscle poke-through: abdomen 45 %, forearm 52 %, pelvis 22 %, knee 24 %, head 10 % (2 % beyond 5 mm), hand 5 %.
  - Breasts: the HRA parts do not fit inside MHR's BMI-22 breast — nipples 43–44 mm outside the skin, 74–78 % of the mammary fat and 81–84 % of the lobes outside.
  - No external genitalia on the female surface. The head tilt and shrug remain; they follow her skull and shoulder-girdle position.

## 15. Open issues

- The female must be rerun after standardisation.
- Whether to keep the male groin bump, and what to do with his external genital parts.
- The linear-blend-skinning reproduction check was not done.
- MHR has no separate toes.
- `data/raw/bodyshape` is now 4.9 GB.
- The earlier `reference-female/` and `reference-female-bmi28/` (LOD 1) are superseded by `female-skin/`.
- For part of this session I fitted the female against meshes exported before the rebuild; the script now re-exports first, and all numbers in this part come from fresh exports.
