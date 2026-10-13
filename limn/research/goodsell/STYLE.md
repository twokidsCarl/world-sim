# 从图集里学到的做法 / What the gallery teaches

## 中文

我把 Goodsell Gallery 的 49 幅画（`gallery/`）看了一遍，也读了他在各幅页面上写的说明。下面是他反复使用的做法，以及 limn 现在做到了哪一条。说明很有用：他逐个写了每种颜色画的是什么，比如流感那幅：“lipid bilayer membrane (light purple) … hemagglutinin (purple), neuraminidase (magenta) … M1 matrix protein (blue) lines the inner side of the membrane. RNA-dependent RNA polymerase (red) is bound to the genomic RNA strands (yellow), which are protected in a helical complex with nucleoprotein (orange).”

| 他的做法 | 在哪些画里看得最清楚 | limn |
|---|---|---|
| **画的是一片薄切片**：切面这一层用亮色，后面一两层用同色的深一号，再往后不画。从不画整个物体的后半个内壁。 | influenza-virus、zika-virus、ebola-virus、coronavirus、escherichia-coli | 已做（`Style.slab`，剖开时只画厚度为画幅高度 20% 的一片；衬在后面的层另外保留，空隙里不露白） |
| **里面总是填满的**。没有坐标的东西，按文献和已知结构画上去。 | influenza-virus（M1、RNP、聚合酶）、coronavirus（核蛋白和 RNA）、sars-cov-2-mrna-vaccine | 流感已做（`src/infer/influenza.ts`），标为推断；别的还没做 |
| **一个区室一族颜色**，相邻的区室用对比色：病毒里面紫或蓝，包膜粉或紫，血浆黄绿，细胞质蓝，细胞核紫。 | excitatory-and-inhibitory-synapses、hiv-vaccine、autophagy | 流感按他那幅量出的颜色做了（目录条目的 `colors`）；别的模型一个区室里仍有好几族颜色 |
| **远近只靠同色的三档深浅**，没有渐变的阴影。 | influenza-virus（血凝素三层：明度 0.76、0.60、0.45） | 已做 |
| **线是填色的深一号，细**；分子内部只有少数几条表示亚基的线。 | 全部 | 已做 |
| **形状是光滑的瓣状**，细节到结构域为止，看不到原子。 | 全部 | 已做（“滚球”平滑）；相邻的同种分子会连在一起 |
| **膜是一条颜色均匀的浅带子**，常在中线画一道虚线表示两层；蛋白穿过它。 | influenza-virus、immunological-synapse、insulin-release | 浅带子已做；中线的虚线没做 |
| **核酸是等宽的光滑线条**：DNA 黄或橙，RNA 粉或白；核蛋白是串在上面的珠子。 | escherichia-coli、mycoplasma-mycoides、sars-cov-2-mrna-vaccine、jcvi-syn3a-minimal-cell | 没做（仍是原子堆平滑出来的团块） |
| **环境铺满整张纸**：病毒周围是拥挤的血浆、黏液或细胞质，底色是该区室颜色的最深一号。只有“肖像”式的画（流感、埃博拉、支原体、syn3A）留白。 | coronavirus、hiv-in-blood-plasma、zika-virus、biosites-* | 没做 |
| **外面的刺排得很整齐**：等间隔、垂直于膜，前一圈的空隙里露出后一圈。他画的是理想化的排布，不是某一个瞬间的样子。 | influenza-virus、coronavirus、ebola-virus、hiv-in-blood-plasma | 流感已做（`src/infer/idealise.ts`）：种类、数量、结构照模拟，位置和朝向排成一圈圈，说明里写明；切到 Illustrate 画法看原样的数据 |
| **小分子、离子、水都不画。** | 图集首页的说明 | 一直如此 |

### 把图集看全之后补的几条（共 50 幅，这次全部看过缩略图）

上面那张表是只看了约 30 幅时归纳的。看全之后，原来的十一条没有被推翻的，另外看到：

- **“肖像”和“场景”是两种构图。** 肖像（influenza-virus、ebola-virus、measles-virus-proteins、mycoplasma-mycoides、jcvi-syn3a-minimal-cell、model-of-a-mycoplasma-cell）是一个完整的对象摆在白纸上，对称、居中。场景（其余四十多幅）铺满整张纸，膜斜着或弯着穿过画面，把画面分成两三个颜色不同的区室。limn 现在所有的图都是肖像式的；场景式的还没有。
- **细胞里的 DNA 是很长的线，绕成一团或穿过整个画面**（escherichia-coli、mycoplasma-mycoides、jcvi-syn3a-minimal-cell、reca-and-dna），粗细均匀，上面串着蛋白。我们的支原体里 DNA 仍是团块，这是和他差得最明显的一处。
- **病毒里面的核酸有三种画法**：流感是蛋白裹着的粗杆，新冠和寨卡是珠子串在线上绕成一团，mRNA 疫苗里是一根裸的线团。
- **膜**：几乎每一幅都画了中线的虚线或两排短纹（immunological-synapse、insulin-release、lipid-droplets、coronavirus 都很清楚），蛋白穿过的地方断开。这一条我们还没做。
- **底色**：场景的缝隙里是该区室颜色的最深一号，或者近黑；从来不是白。肖像才用白纸。
- **用黑底的只有三幅**（bacteriophage-t4-infection、hiv-infected-cell、respiratory-droplet），都是比例尺很大的图。

### 第四轮（g4）：切片，流感的内部，按他的画配色

- **切片**：剖开时只画切面往后一小段。流感病毒原来那个灰紫色的“碗底”没有了，膜成了一圈浅带子，刺分成前后三层深浅。
- **流感病毒的内部**（推断）：基质蛋白 M1 用 PDB 7JM3，从它自带的 60 个拷贝的螺旋排布量出每个拷贝占的面积和朝膜的那一面，贴着膜内侧铺了 1,273 个；核糖核蛋白用 PDB 4BBL（从病毒颗粒里分离出的 RNP 螺旋段，含 616 个核苷酸），八条平行成束；每条一端一个聚合酶（PDB 6RR7）。八个基因组片段的长度取自 NCBI 的参考序列（NC_002016–NC_002023）。按片段长度一共该有 23 段螺旋，这个病毒颗粒里只放得下 8 段（每条一段），其余截掉了；说明里写了这两个数。
- **颜色**：流感的各部分用他那幅画量出的值（血凝素 h 290、神经氨酸酶 h 321、M1 h 245、核蛋白 h 62、RNA h 86、聚合酶 h 25）。
- 写测试时发现一个真问题：我先用“各拷贝质心的主轴”当螺旋轴，但螺旋短而粗时方差最大的方向是横着的，量出的半径和面积都不对。改成从两个拷贝之间的相对变换求转轴。

limn 这一轮的数：

| pair | which | paper | ink | ink_L | ink_C | bumps | flat | L | C | palette |
|---|---|---|---|---|---|---|---|---|---|---|
| influenza | limn | 0.443 | 0.103 | 0.469 | 0.058 | 0.715 | 0.837 | 0.659 | 0.082 | 0.081 |
| zika | limn | 0.388 | 0.154 | 0.427 | 0.068 | 0.982 | 0.861 | 0.690 | 0.097 | 0.177 |
| coronavirus | limn | 0.754 | 0.095 | 0.462 | 0.059 | 0.584 | 0.842 | 0.632 | 0.081 | 0.116 |
| hiv | limn | 0.475 | 0.169 | 0.468 | 0.078 | 0.938 | 0.818 | 0.687 | 0.103 | 0.176 |
| synapse | limn | 0.153 | 0.192 | 0.435 | 0.060 | 0.946 | 0.657 | 0.609 | 0.082 | 0.105 |
| mycoplasma | limn | 0.376 | 0.205 | 0.444 | 0.071 | 1.425 | 0.593 | 0.647 | 0.106 | 0.103 |

- 流感：主色距离 0.103→0.081，细碎起伏 0.80→0.72（他的画 0.85）。
- 突触：细碎起伏 1.53→0.95（他的画 0.94）。
- 新冠：切片之后里面显得很空。PetWorld 的模型里核蛋白本来就不密，以前是靠后半个内壁上的东西填满了画面；他那幅里面是填满的。这是下一个要按推断补的。
- 还差的见上表里写“没做”的几行。

### 第五轮（g5）：外面的刺排整齐

用户看了第四轮说：他的外面很对称，我们的很乱。原因是我们用的是分子动力学模拟的一帧，刺本来就是歪斜、聚堆的（量得偏离膜法线的角度中位数是 14 度）；他画的是理想化的排布。

照他的做法（`src/infer/idealise.ts`）：
- 从模拟数据里按质心的远近把链分成复合体（236 个血凝素三聚体、30 个神经氨酸酶四聚体、11 个 M2 四聚体），每种挑最直立的一个连同它身上的糖链当样板。
- 位置排在绕观察方向的一圈圈纬线上，每圈等间隔，相邻两圈错开半步；中间那一圈在赤道稍靠后，从正面剖开时整圈留在切片里。神经氨酸酶均匀地插在血凝素中间。
- 样板的轴对着所在位置的膜法线。
- 只在手绘画法下这样做；切到 Illustrate 画法时重新载入，看到的是模拟里原样的位置。说明里写明了哪些取自数据、哪些是理想化的。

线也加重了一点（他的线细，但比我们上一轮的实）。并排图是 `out/g5-influenza.jpg`。

新冠没有照这样处理：PetWorld 的模型里刺只有 30 个，本来就稀；他 2020 年那幅画得密得多。这一处是数据和他的画不一致，我没有改数量。

### 第七轮（g7）：RNA 画成线，新冠按他的画配色

- **流感的基因组 RNA** 画成一条黄线：走向取自 RNP 结构（PDB 4BBL）里 RNA 链上的磷原子，每三个取一个、略作平滑，推到杆的表面上（否则埋在核蛋白的沟里看不见），用圆台图元连起来。线是真实的走向，“推到表面”是为了看得见做的处理。
- 圆台图元现在也遵守切片的背面。
- **新冠**按他 2020 年那幅量出的颜色配：膜浅粉（L 0.87、C 0.06、h 345），刺品红（h 336），M 蛋白粉，核蛋白淡紫（h 297）。
- **没有做“弯着填满”**，算过之后放弃了：这个模拟里的病毒颗粒内腔半径约 31 nm，按 RNP 真实的粗细，再怎么弯也只装得下九到十段螺旋（现在直着放了八段），而按基因组长度该有二十三段。他画里填得那么满，是因为他画的颗粒更大。要填满只能把 RNP 画细或者把数量画少，那就不是推断而是编了，所以没做。
- 并排图：`out/g7-influenza.jpg`、`out/g7-coronavirus.jpg`。
- 还差：流感的 RNA 线在中间缠成一团，不像他那样一条条清楚的波浪；新冠里面仍然偏空，刺只有 30 个（数据如此）；刺的颜色在后面几层偏暗。

### 第八轮（g8）：里面画满

**先更正第七轮里的一句话。** 我写“他画得那么满是因为他画的颗粒更大”，量了之后发现不对：模拟里这个病毒颗粒连刺直径约 108 nm，已经是典型大小；按刺的长度（13.5 nm）去量他那幅画，他画的颗粒反而更小（约 75 nm）。他里面满，是因为他把核糖核蛋白一直画到贴着内壁，画的是每条的一部分。真实的核糖核蛋白最长的一条有一百多纳米，球形的病毒颗粒里本来就得折叠着才放得下。

照他的做法：
- 病毒颗粒的大小不动。每条核糖核蛋白沿杆的方向一段接一段摆满整条弦，在内壁处截断，顶上留出聚合酶的位置（`rnpBundle` 的 `fill`、`clipToCavity`）。
- 每个核蛋白单独描边，所以读出来是一串珠子，和他画的一样；RNA 的黄线在珠子之间露出来。
- 说明里写明：按基因组长度八条一共该有 23 段螺旋，画出来的相当于 8.3 段，每条只画了一部分；它们实际怎样折叠没有画。
- Illustrate 画法下仍是每条只放完整的螺旋段。

并排图：`out/g8-influenza.jpg`。还差：八条杆成一束在中间，束的两侧到内壁之间仍有空（他画的是填满整个圆）；刺的头部没有他那样的分瓣。

### 第九轮（g9）：白的地方填上，勾黑线

用户看了 `g8-influenza.jpg` 提了两条：白色的地方要有结构填上；要勾黑线。

- **勾黑线**：墨色改成接近黑、只带一点旁边填色的色相，线宽从 1.05 加到 1.6。
- **每个刺单独描边**。查出一个错：刺和它身上的糖链放在同一组里，而“糖链不单独描边”的规则是按组判断的，结果整个刺都被当成不描边的东西，相邻的刺之间一条线也没有。现在糖链单独成组。
- **填白**：切片从画幅高度的 24% 加厚到 42%，刺之间的空隙里露出后面几圈刺；里面的七条核糖核蛋白从紧挨着中间那条改成摊开到贴着内壁，从侧面看铺满了整个圆。
- 并排图：`out/g9-influenza.jpg`。
- 还差：左上和左下还有几处白缝（那里前后两圈刺正好对齐）；刺的头部没有他那样的分瓣；神经氨酸酶只有少数几个在切片里。

### 自己循环：看、找原因、改、再看（流感）

用户要求不再由人来指出问题：我自己对照他的画看差在哪、找原因、改、再对照。每轮记在这里。并排图是 `out/g10-influenza.jpg`、`out/L<轮次>-influenza.jpg`。

| 轮 | 看到的 | 原因 | 改法 | 结果 |
|---|---|---|---|---|
| g10 | 外面乱：刺后面叠了四五圈，有的地方对齐、有的地方重叠；刺上有一块块浅斑 | 各圈的刺数目不同，错开的半步绕一圈会漂移；切片太厚；糖链另上了浅色 | 赤道一圈和它前后各一圈取同样的数目；切片改回画幅高度的 20%；糖链和所在蛋白同色；线略收细 | 外圈成了一亮一暗交替的两层，干净了 |
| L1 | 里面露出带格子的蓝色“碗底”；切面上品红的神经氨酸酶太少；刺被抹成平板 | 切片薄了以后后面只剩基质蛋白的内壁；神经氨酸酶是均匀撒在整个球面上的；平滑的探针偏大 | 核糖核蛋白衬在后面；先在切面那一圈上等间隔放八个神经氨酸酶；探针从 7 减到 5 像素 | 神经氨酸酶对了；里面更糟：出现白洞，核糖核蛋白成了参差的碎块 |
| L2 | 白洞；碎块 | 切面正好从杆的中间劈开，削掉了每条杆的前半边，露出螺旋的内部 | 八条杆整条排在切面后面：前排四条并排，后面两排错开；基质蛋白和核糖核蛋白都衬在后面 | 里面是并排的几列橙色珠子，上面露着黄色的 RNA 线，顶上是聚合酶，没有白洞 |
| L3 | 后面的层太暗，发脏；核蛋白的橙色偏褐 | 最远一层压到本色的 0.5；核蛋白的明度取低了 | 最远一层改成 0.64（他的三层是 0.76、0.60、0.45）；核蛋白 L 0.79、C 0.15 | 流感主色距离 0.077→0.062 |
| L4 | 核糖核蛋白上有许多透出蓝色的小洞 | 螺旋里原子之间的缝 | 这一层的原子半径画成 2.9 Å | 小洞少了，没有全消；主色距离 0.070 |
| L5 | 新冠切开后里面是白的（L4 时第一次看其余模型才发现） | 切片背面把膜的后半个也切掉了，模型里核蛋白又稀 | 膜总是衬在后面 | 新冠里面露出膜内壁的深粉色，不再露白 |
| L6 | 突触里到处是暗灰色的碎片，线满纸都是 | 几百个小泡的膜都被留在后面；分子小而线粗 | 只有单个病毒颗粒（拷贝数不超过两万）才把膜衬在后面；密的模型线宽 0.9 | 碎片没了，但到处露白 |
| L7 | 突触、支原体到处露白 | 密的模型里一个分子只有画幅的百分之几，20% 的切片太薄 | 密的模型切片取 50%，线宽 0.7 | 突触铺满了，白纸占比 0.10→0.00 |
| L8 | 突触、支原体颜色杂：一个区室里橙、蓝、紫、褐都有 | 颜色按“角色”取，各角色的色相分散在整个色环上 | 目录条目新增 `hues`（每种角色在这个模型里用哪一族颜色）和 `membrane`，数值照他画同一个对象的那幅：突触是绿色细胞质加黄橙色小泡，支原体是蓝色蛋白、品红核糖体、黄色 DNA、绿色膜 | 支原体主色距离 0.114→0.088；突触 0.122→0.121（参考图是三联画，一半是紫色的突触后，这个量在这里说明不了什么），看图是对上了 |
| L9 | 新冠刺少（30 个）、里面稀；HIV 里面粉、紫、橙混着 | 新冠：模型里的数量在实测范围的下端；切片后面的核糖核蛋白被切掉了。HIV：没有按区室配色 | 新冠的刺按文献推断到 74 个并排成等间隔的环（目录条目的 `respike`，写明出处）；核糖核蛋白衬在后面（`lining`），数量不动。HIV 用他的红色一族，RNA 黄色 | 新冠外圈成了亮暗两层交替的一整圈；白纸占比 0.65→0.48 |
| L10 | 突触、支原体的线又黑又密，盖住了颜色 | 密的模型也用了近黑的墨色 | 密的模型的线改用填色的深一号（inkTint 0.9、inkShade 0.34） | 支原体：线的明度 0.39→0.48、彩度 0.046→0.069（他的 0.48、0.072），主色距离 0.088→0.082。突触：线的明度 0.37→0.45（他的 0.35，偏浅了），主色距离 0.121→0.150（参考是三联画，见 L8） |

**新冠的数量是怎么推断的（L9）。** 查了开放获取的全文：Klein 等 2020（*Nat. Commun.*，doi:10.1038/s41467-020-19619-7，新冠的原位冷冻电镜断层扫描）给出每个病毒颗粒平均 48 个刺三聚体，范围 25–127，平均 38 ± 10 个核糖核蛋白；Neuman 等 2011（*J. Struct. Biol.*，doi:10.1016/j.jsb.2010.11.021，冠状病毒）给出平均 74 个刺。PetWorld 的模型里是 30 个刺、36 个核糖核蛋白：刺在实测范围的下端，核糖核蛋白和实测一致。所以刺取 74（Neuman 的平均值，在 Klein 的范围之内，高于 Klein 的平均值；Goodsell 2020 年那幅的密度与它相近），核糖核蛋白的数量不动。M 蛋白的数量我没有查到可以直接引用的数字，没有改。

**循环到这里的状态。** 流感在结构和配色上接近他的画。我自己看仍然不对的：新冠里面仍比他的稀（36 个核糖核蛋白与实测一致，他画的是填满的）；支原体里的 DNA 是团块，不是他那样的长线；所有的画都没有周围的环境。

## 用概念来画（第六阶段）

十轮逐个模型调参数之后差距仍然明显，于是换了做法：把他的画法提炼成几种**所有模型共用的概念**，由“这是什么”（膜、核酸、蛋白）决定怎么画，不由“这是哪个模型”决定；数据里缺的东西用几个**通用的工具**按依据补上。验证也换了两样：取他原尺寸图的一小块和我们同样的一块并排（`out/C<n>-detail-*.jpg`），以及每一步把全部 25 张卡出成一张总览（`sheet.py`，`out/sheet-C<n>.jpg`）。

### C1–C2：线、膜

**对着原尺寸图发现前面量错了一件事。** 我在 800 像素的缩小版上量出“他的线是填色的深一号，偏浅偏彩”，并据此把线调浅了。看原尺寸图（`out/C2-detail-influenza.jpg` 左半）不是这样：水彩里他用的是**细而深的墨线，每个形状都勾一圈**。缩小之后细线和旁边的颜色混在一起，才量成了“浅而彩”。“每月分子”2015 年以后的图确实没有黑线，那是另一种画法。所以：

- **线**（水彩）：近黑的细墨线，粗细均匀。
- **膜**：脂质一律按球来切，切口整齐；编号里标成膜；从侧面看到的膜（宽度像一层膜的窄带子）中线上画一道很淡的虚线（合成通道里朝八个方向找带子的两边）。
- **理想的膜**（工具）：模拟里的膜是起伏的，切开后边缘参差。流感在手绘画法下改用一层理想的球壳（`shellMembrane`），厚度取自数据。
- **一个复合体一个颜色**：同一种分子的各条链不再在明度上交替，刺不再有深浅的条纹。
- 平滑探针的上限从 14 Å 降到 6.5 Å，保留一两纳米大小的凹凸。
- 突触小泡按他的黄橙色配。

**总览里看到的、还没改的：** HeLa 细胞是白底黑线，很脏；syn3A 膜包层里面是空的一个圆；新冠里面有白洞；流感的刺仍是一块板，没有他那样的细柄和分瓣的头（这是真实结构平滑之后的样子，要靠“蛋白分瓣”这个概念来解决）；支原体的 DNA 是团块。

### C3：核酸画成线

- **概念**：模型里一节节摆出来的纤维（DNA、RNA）画成一条粗细均匀的线。每一节画成同样大小的球（DNA 半径 11 Å，RNA 7 Å），连起来就是一条等宽的带子；各节之间不画线。
- **让相邻的两股分得开**：一开始整条染色体共用一个编号，并排的几股融成一大片黄色。于是沿走向每 110 Å 换一个编号（`fibreSegments`）：相邻的两股编号不同，中间有线；同一股上每隔一段有一道横纹，像他画的绳纹。
- **这里走了两次弯路**。支原体模型把一条染色体按碱基拆成四组。我先假设四组是交错的、可以按顺序归并，结果每个球又各自成了一圈。查了才知道其中两组是双链的另一股，走向相反。改成按“位置”共用编号：后面的组经过前面的组走过的地方时，沿用那里的编号。
- 支原体的 RNA 用他的粉白色。
- 并排图 `out/C3-detail-mycoplasma.jpg`，总览 `out/sheet-C3.jpg`。支原体和外泌体里的核酸现在读成一股股的线。
- **和他的差别**：他画的 DNA 是稀疏的、近乎直的长线；模型里的染色体是按真实密度填的，又密又弯。这是数据和他的画的差别，没有改。
- 密的模型的切片试了 30%（突触又露白）和 50%（支原体成了一堵 DNA 的墙），取 40%。

### C4：场景，和两个新工具（填环境、穿线）

- **概念“场景”**：对象泡在拥挤的环境里，铺满整张纸，底色是深的。先做了新冠（他那幅就是场景）。
- **工具“填环境”**（`src/infer/environment.ts` 的 `scatter`）：把几种蛋白随机摆在对象周围切面后面的一层里，不进对象的范围，彼此不重叠。
- **工具“穿线”**（同文件的 `threads`）：生成弯弯曲曲的长线，方向带惯性地随机变，碰到对象就沿表面滑开。用它画黏蛋白，交给圆台图元。
- 新冠的环境照他的《Coronavirus》（2020）：黏蛋白的长链、抗体（PDB 1IGT）、小的蛋白（用血清白蛋白 PDB 1AO6 代表）。目录条目的 `environment` 里写了依据；来源栏标“示意的环境”，说明里写明位置随机、数量按铺满画面定；切到 Illustrate 画法只看模型本身。
- 画幅裁在环境的范围之内（打开时放大 1.22 倍），四周不露底色的边。
- 量出来的（新冠；括号里是他的画）：白纸占比 0.48→0.00（0.00），主色距离 0.110→0.094，平均明度 0.60（0.61），平均彩度 0.096（0.104）。
- 并排图 `out/C4-coronavirus.jpg`。
- **还差的**：他的黏蛋白是分叉的、带糖链的刷子状，我们是光滑的线；刺之间的空隙露出的是底色，他的是后一圈刺的深色；橙色的小蛋白是一个结构重复几百次，他画了好几种。

### C5–C6：核对，以及把工具用到“里面是空的”模型上

- 做完场景之后重出了全部卡片的总览（`out/sheet-C5.jpg`），没有弄坏的；Illustrate 对照重跑了，仍是 2.80。
- **syn3A 膜包层**：数据里只有膜和膜蛋白，里面是空的。用“填环境”和“穿线”两个工具填里面（工具加了“只放在某个半径以内”的选项）：染色体 DNA 的长线、核糖体（PDB 7P6Z）、伴侣蛋白 GroEL（PDB 1AON）、小的可溶蛋白（用 PDB 2HHB 占位）。配色照他的《JCVI-syn3A Minimal Cell》（2022）：绿膜、品红核糖体、蓝色蛋白、黄色 DNA。主色距离 0.081。并排图 `out/C6-syn3a.jpg`。这些都是示意，说明里写明；小的可溶蛋白用血红蛋白占位只是因为大小合适，不代表细胞里有它。
- **HeLa 细胞**：手绘画法下改成暖白的纸，线是填色的深一号、很细。细胞器的碎片成千上万，用黑线会盖成一片黑。
- **没做的**：“蛋白分瓣”这个概念没有做，流感的刺仍是一块板；“排整齐”“衬一层”没有合成一个通用工具，HIV 没有用上。

### D1–D2：蛋白分瓣查下来的结论，流感再对一遍

- **“蛋白分瓣”没有做，原因查清了。** 流感的刺是一块板，我先怀疑是模拟里伸展的糖链把柄撑粗了，去掉糖链试了一次：没有变化。再对着他的原尺寸图量：他的刺长约为膜厚的 4.2 倍、有细柄和蘑菇状分瓣的头；真实的血凝素三聚体长约为膜厚的 3 倍，上下差不多粗。**他的刺是夸张过的。** 把真实结构捏成那个形状就违背了“结构是真的”，所以不改，差别留着。
- **膜的厚度量错了**：理想的球壳原来取模拟里脂质半径的 2%–98% 百分位，起伏的膜这样量出来约 80 Å，是真实膜厚的两倍。改成以半径中位数为中面、厚 38 Å。基质蛋白层和里面的空腔跟着往外移，核糖核蛋白能画的地方变大了。
- **基质蛋白层读成一条带子**：各份拷贝共用一个编号，彼此之间不画线（`oneId`）。原来是满是黑线的小格子。
- 流感主色距离 0.077→0.072。并排图 `out/D2-influenza.jpg`：浅色的薄膜带中线、蓝色的基质蛋白带、填满的橙色核糖核蛋白、顶上红色的聚合酶，这几样和他那幅一一对得上；刺的形状对不上，原因如上。

### E1–E2：HIV 也做成场景

- HIV 周围填上血浆：白蛋白（PDB 1AO6）、抗体（PDB 1IGT）、纤维蛋白原（PDB 3GHG），照他的《HIV in Blood Plasma》。血浆里最多的三类蛋白就是这三类；数量按铺满画面定，是示意。
- **填环境的工具改了一处**：占的地方原来按分子最远的原子算，细长的纤维蛋白原会占掉一个大球，周围什么都放不下，画面很稀。改成按均方根半径算。新冠的场景也跟着密了一点（主色距离 0.092→0.089）。
- HIV 主色距离 0.134→0.081，白纸占比 0.47→0.00。并排图 `out/E2-hiv.jpg`。
- **和他的差别**：他那幅的比例尺小得多，病毒是完整的一个球（没有剖开），只占画面的四分之一；我们是剖开的特写。他的血浆蛋白更小更密，种类也多。

### X1–X2：“夸张”选项

用户同意加一个明确标注的“夸张”选项。`exaggerate`（`src/infer/idealise.ts`）把刺沿它的轴拉长、柄收细、头放宽：流感的血凝素长 1.4 倍、柄 0.55、头 1.2；神经氨酸酶 1.25、0.5、1.15；新冠的刺只把头放宽到 1.3。倍数是对着他的原尺寸图定的（他的刺长约为膜厚的 4.2 倍，真实的约 3 倍）。

- 只在手绘画法下，默认开；“线条与阴影”里有开关，地址里 `?exaggerate=0` 也能关。说明里写明这不是真实的形状。Illustrate 画法不受影响。
- 切片从 20% 加到 30%，柄变细之后空隙里要露出后一圈。
- 流感主色距离 0.072→0.075（基本没动），看图是近了一大步：刺有了细柄和宽头，神经氨酸酶成了蘑菇状。新冠 0.089→0.081，外圈的刺基本连成一整圈。
- 并排图 `out/X2-influenza.jpg`、`out/X2-coronavirus.jpg`。
- **还差的**：他的刺头是分成几瓣的，我们的是一整块带锯齿的边；流感的柄之间还有几处露白。

### S1–S2：单个分子照他 2015 年以后的画法

按编号载入的单个结构，手绘画法下改成他最近的“每月分子”那样：**看得见原子**（不做平滑），**没有黑线**，轮廓是填色的深一号。第一次试把线调得太浅又留着平滑，图是糊的；对着他的新冠刺突图（第 246 篇）改回来。量出来线的明度 0.48（他的 0.43），线占主体的比例 0.11（他的 0.10）。并排图 `out/S2-*.jpg`。颜色和视角与他的不同（他按结构域上色、带示意的膜和柄），这些没有做。

### G1：总览核对，突触的底色，黏蛋白分叉

- 重出了全部 25 张卡的总览（`out/sheet-G1.jpg`），Illustrate 对照重跑仍是 2.80。
- **总览抓到一处退步**：上一步把单个分子的平滑关掉之后，寨卡和 HIV 衣壳这类几十万原子的大结构成了一片麻点。改成放置后原子数超过 20 万的仍做平滑。
- **突触的白洞**：突触前、突触后两个场景用深色的底（目录条目的 `ground`），缝隙里露出的是深色，不再是白纸。
- **黏蛋白分叉**：穿线工具加了 `branches`，每隔几步向旁边伸出一小段，用在新冠的黏蛋白上。离他画的刷子状还有距离：他的分叉更密、更长，而且线之间填满了。

### H1：逐张对照，小分子画成圆点，DNA 取真实的粗细

把清单里没有逐张对照过的四张（寨卡、核孔、突触小泡、外泌体）和他的画并排看了。寨卡、核孔、外泌体没有发现要改的大问题；突触小泡最差，支原体的 DNA 其次。

- **概念“小分子”**（`out/H1-synaptic-vesicle.jpg`，左旧右新）：小泡里的谷氨酸原来共用一个编号、抹成一团带黑斑的色块。他画的是一粒粒圆点。现在每个小分子收成质心上的一个球（目录条目的 `dots`，半径 8 Å），各自描边。**这是夸张**：位置是模型里的，大小不是，真实的谷氨酸小得多；归在“夸张”选项里，可以关，来源栏有说明，Illustrate 画法不受影响。
- **概念“核酸”，粗细**（`out/H1-mycoplasma-dna.jpg`，左我们右他）：支原体模型里的 DNA 是珠子模型，每个碱基对两个半径 11 Å 的珠子，画出来宽约 41 Å，是真实 DNA（20 Å）的两倍。手绘画法下每节收成中线上的一个球：双链半径 10 Å，单链 5 Å。这一条不是夸张，是把模型里过粗的珠子改回真实的粗细。
- **核酸，长短**：纤维的切片比别的分子深一倍半，于是 DNA 是长长的一股，从前面的分子后面穿过去，而不是被切成一小段一小段。
- **核酸，横纹**：原来每 110 Å 换一个编号，线上有一道道横纹；他的 DNA 上没有。改成 2000 Å。
- 仍然不像的：他的 DNA 走得直、稀；模型里的 DNA 弯而密，这是数据本身，没有动。线仍然比他的黑。

### J1：线改轻，刺之间露出后面那一圈

- **概念“线”，再改一次**（`out/J1-ink.jpg`：近黑、填色压到 0.32、压到 0.45 并收细、他的画）：整体模型的线从近黑改成填色的深一号（`inkTint` 0.85，`inkShade` 0.32）。理由和 C 轮的结论不矛盾但取舍变了：他的原图上线确实又细又深，可是我们的图是按缩小后的大小看的，同样一像素的近黑线在这个大小上比他的重得多。每个形状仍然勾一圈。**这改动了使用者早先要的“勾黑线”**，已在回复里说明。
- **刺之间的空隙**（`out/J1-coronavirus.jpg`：改前、改后、他的画）：重排的刺衬在后面（切片的背面不切），前排刺之间露出的是后面那一圈刺的深一号色调，不再是深色的底。还剩少数几处露底。
- 全部 25 张卡的总览：`out/sheet-J1.jpg`。

### K4：黏蛋白从一张网改成一根根分叉的长链

（`out/K4-coronavirus.jpg`：改前、改后、他的画）新冠周围的黏蛋白原来有 70 条、每步方向偏得多，平滑之后连成一张绿色的网。试了四次：收细到 4 Å 反而更像网；减到 30 条、方向每步只偏一点之后成了一根根线，但太直太稀；最后取 34 条、半径 6.5 Å、每步偏 0.32、分叉两节。白蛋白从 240 个减到 170 个，底色从近黑调成深橄榄。穿线工具每步的偏转改小了，syn3A 里用同一个工具生成的 DNA 也跟着变直了一些，看过，没有变坏。

### K7：支原体的 DNA 按他的画法重新穿线（使用者定的）

（`out/K7-mycoplasma-dna.jpg`：整幅、中间一块、他的画）使用者在四项里选了“按他的画法重新穿线”。“填环境”工具加了 `replace`：手绘画法下把模型里名字匹配的东西（这里是 `fibers.DNA`）拿掉，由生成的线代替；穿线工具加了 `wander`（每步方向偏多少）。试了三次：70 条、几乎笔直、放在切片后部，大多被蛋白挡住；挪到切片最前面的一薄层后成了一堆交叉的直棍，交叉处还粘成蹼；最后取 30 条、每步偏 0.2、半径 7 Å。

这一项推断的成分很大，来源栏照实写了：走向是随机生成的，比真实 DNA 直得多；按基因组长度和切片体积，画面里应有约 42 微米，只画了约 18 微米。Illustrate 画法下仍是模型里原来的 DNA。

### L1：突触后场景的外面填上细胞外基质（使用者定的），切换画法的一处错

- **填不规则形状的外面**（`out/L1-postsynaptic.jpg`，左旧右新）：使用者选了“像他那样把细胞外面也填上”。“填环境”工具原来只会绕着一个球填；加了 `outsideOf`：把对象各部分的位置记进 70 Å 的粗格子，占了的格子胀一格，再从格子边界灌水，灌得到的就是外面。细胞里面的空隙灌不到，不会被填。填的是分叉的长链（透明质酸上挂着蛋白聚糖）和占位的小蛋白。膜外留着一圈一两格宽的空隙，是胀的那一格造成的。
- **要照实说的**：真实的脑组织里细胞外只是几十纳米宽的缝，这片地方大部分其实是邻近的细胞，模型里没有；用基质填满是为了画面。来源栏里写了这句话。
- **切换画法的一处错**：带示意环境、圆点或自己底色的模型，从手绘切到 Illustrate 时没有重新载入，推断的东西会留在 Illustrate 的画面里（HIV、syn3A 一直有这个问题，这次核对支原体时才发现）。现在这些模型切换时都重新载入；在支原体上来回切换核对过。
- 全部 25 张卡的总览：`out/sheet-L1.jpg`。

### M3：流感的刺一根根分开

（`out/M3-influenza.jpg`：改前、改后、他的画）夸张时把血凝素的头放宽到 1.2 倍，相邻的头连在一起，一圈刺成了一条连续的裙边；他的刺是一根根分开的，缝里露出后排深色的刺。头改回原宽（1.0），柄从 0.55 放回 0.75。试过头 0.95、柄 0.5：刺分开了，但柄之间透出许多白纸。把刺衬在后面（切片背面不切）在这里几乎没有效果（两张图只差一千多个像素）：缝是一直透到后面的，不是后排被切掉了。现在还剩一些小白洞，他的画里这些地方是深靛色。

### N2：HIV 的刺重排，刺头分瓣（使用者定的）

- **HIV**（`out/N2-hiv.jpg`：之前、现在、他的画）：模型里有 100 个刺；文献是每个病毒 14 ± 7 个（Zhu 等，Nature 2006）。手绘画法下用“排整齐”工具换成 14 个，等间隔。**等间隔是理想化**：那篇文献里刺的分布并不均匀，来源栏里写了。我原先认为这一项没有依据、不该做，使用者要做。刺的颜色定成他的粉红。
- **分瓣**（`out/N2-coronavirus.jpg`）：“夸张”工具加了 `lobes`：头部的每个亚基朝自己那一侧推开若干 Å，越靠顶推得越多，头裂成几瓣。方向取各条链在头部的质心相对轴的方向；只有一条链时等分成几个扇区。新冠 16 Å，流感 6 Å（9 Å 时柄之间的白洞变多）。结果：HIV 的头读成三瓣；新冠和流感只在顶上有凹口，离他画的扇形分瓣还远。

### R1：按逐张批注的第一步——“不细致”的原因，膜上的一圈突起

使用者对 14 项对比逐张批注，归并成五个问题（里面不好看、突出的东西不细致、没有背景、细胞外面缺一圈有秩序的小突起、个别的）。计划在 `~/.claude/plans/` 里，这里记每一步的结果。

- **一个判断被推翻**：我在计划里认为“不细致”是平滑按屏幕像素定造成的。读代码发现探针半径换成 Å 之后有上限（6.5 Å），已经是按分子大小定的；再在小泡上把平滑关掉、加大三倍、把切片加厚，四张图里蛋白的形状几乎没有变。原因不在平滑。
- **真正的原因**：小泡模型的膜上一共只有 104 个蛋白（21 种），切片里看得到十来个，各朝各的方向；他画的是二十来根等间隔的须。
- **概念“膜上的一圈突起”**（新工具 `arrange`，在 `src/state/store.ts`）：把膜上的各种蛋白重新排成等间隔的一圈圈（各种穿插着分），膜换成光滑均匀的球壳。每种蛋白的结构、数量、嵌在膜里的深浅和歪斜取自模型，只有“在球面上的哪里”是重排的。来源栏写明。
- **里面的底色**：`arrange.lining` 在膜里面贴一层深一号的颜色，膜的切口才读得出是一条带子。
- **圆点的切片加深**（实例标志 9）：画成圆点的小分子用深一倍半的切片。小泡里的圆点仍然不满：模型里一共只有 400 个谷氨酸。
- **背景**：小泡泡在示意的细胞质里（占位的可溶蛋白、大复合体、细丝）。
- **环境离对象多近**（`environment.clear`）：原来环境从对象最远的一点开始，个别伸得远的蛋白会在周围留一圈空着的底色（使用者在 HIV 上指出的）。现在可以取“九成的点以内”和“最远的点”之间的任意处：HIV 0.45，小泡 0.55，新冠保持 1（取小了黏蛋白和抗体会钻到刺之间）。环境里的蛋白整个放在切面后面，不再探到前面盖住对象伸出来的东西。

### S4：支原体外面的一圈（使用者：“没有绿色的杂乱，但是又有秩序的小的突出线条”）

（`out/S4-mycoplasma-fringe.jpg`：整幅、上沿局部、他的画的同一处）把他那幅放大看才明白这句话指什么：他的细胞外面是一圈厚厚的绿色乱线（荚膜的多糖链），贴着膜，厚薄均匀；膜上是一排整齐的小瓣。

- 膜蛋白用 `arrange` 排成等间隔的一圈（4563 个，118 种），膜换成光滑的球壳。
- “填环境”工具加了 `fringe`：线限在膜外的一层里（穿线工具同时给内半径和外半径），后面垫一层深一号的同色，外沿由线自己参差地伸出去。试了三次：第一次线和膜之间隔着一道缝（范围取了最远的一点，改成取球壳的外沿）；第二次底色太深、线太少，膜和底之间有白缝（中心取了各部分位置的平均，改成球壳自己的中心）。
- **要照实说的**：他画的是丝状支原体（M. mycoides），有多糖荚膜；这个模型是生殖支原体（M. genitalium），没有查到它有这样的荚膜。这一圈是照他的画加的，不是这个物种的实际样子，来源栏里写了。
- 仍然不像：他膜上的小瓣是鲜绿色、一格一格的，我们的不显眼；他的线更细更卷。

## English

I went through the 49 paintings of the Goodsell Gallery (`gallery/`) and read the description he gives each on its page. The table above lists the practices he uses again and again, and which of them limn now follows. The descriptions are valuable: he says what every colour stands for, as quoted above for the influenza painting.

In order, the rows of the table are:

1. **He paints a thin slab**: the cut layer in bright colour, a layer or two behind it in deeper shades of the same hue, and nothing beyond; never the far inner wall of the whole object. Done (`Style.slab`: when cut, only a slab 20% of the frame height thick is drawn; layers that line the back are kept besides, so gaps do not show paper).
2. **The inside is always full.** What has no coordinates is painted in from the literature and from known structures. Done for influenza (`src/infer/influenza.ts`), marked as inferred; not yet for anything else.
3. **One family of hue per compartment**, with contrast between neighbouring compartments: violet or blue inside a virus, pink or violet for the envelope, yellow-green for plasma, blue for cytoplasm, violet for the nucleus. Done for influenza with colours measured on his painting (`colors` in the catalogue entry); other models still mix several families in one compartment.
4. **Distance is three steps of one hue**, with no graded shadows. Done.
5. **Lines are a deeper shade of the fill, and thin**; inside a molecule only a few lines mark subunits. Done.
6. **Shapes are smooth and lobed**, detailed down to domains, with no atoms showing. Done ("rolling ball" smoothing); neighbouring copies of one molecule tend to join.
7. **A membrane is an even pale band**, often with a dashed mid-line for its two leaflets, and proteins pass through it. The pale band is done; the dashed mid-line is not.
8. **Nucleic acids are smooth strands of constant width**: DNA yellow or orange, RNA pink or white, with nucleoproteins as beads along them. Not done (still blobs smoothed out of piles of atoms).
9. **The environment fills the sheet**: a virus is surrounded by crowded plasma, mucus or cytoplasm, on a ground of that compartment's deepest shade. Only "portraits" (influenza, Ebola, mycoplasma, syn3A) are left on white. Not done.
10. **The spikes outside stand in good order**: evenly spaced and straight up from the membrane, the ring behind showing in the gaps of the ring in front. What he paints is an idealised arrangement, not one instant. Done for influenza (`src/infer/idealise.ts`): kinds, numbers and structures as in the simulation, positions and orientations set in rings, with the notes saying so; switch to Illustrate to see the data as it is.
11. **Small molecules, ions and water are left out.** Always the case.

### What seeing the whole gallery added (50 paintings, all now seen as thumbnails)

The table above was drawn up after seeing about 30. With all of them seen, none of the eleven points is overturned, and there is this besides:

- **"Portraits" and "scenes" are two compositions.** A portrait (influenza-virus, ebola-virus, measles-virus-proteins, mycoplasma-mycoides, jcvi-syn3a-minimal-cell, model-of-a-mycoplasma-cell) is one whole object on white paper, symmetrical and centred. A scene (the other forty-odd) fills the sheet, with a membrane crossing it at a slant or in a curve and dividing it into two or three compartments of different colour. Everything limn draws now is a portrait; it has no scenes yet.
- **DNA in a cell is a very long strand, wound into a tangle or crossing the whole picture** (escherichia-coli, mycoplasma-mycoides, jcvi-syn3a-minimal-cell, reca-and-dna), of even width, with proteins strung along it. In our mycoplasma the DNA is still lumps, which is where we differ from him most plainly.
- **Nucleic acid inside a virus is painted three ways**: thick protein-clad rods in influenza, beads on a strand wound into a ball in the coronavirus and Zika, a bare tangle of strand in the mRNA vaccine.
- **Membranes**: nearly every painting has the dashed mid-line or two rows of short strokes (plain in immunological-synapse, insulin-release, lipid-droplets, coronavirus), broken where a protein passes through. We have not done this.
- **Ground**: in a scene the gaps show the deepest shade of that compartment's colour, or near-black, never white. Only portraits use white paper.
- **Only three have a black ground** (bacteriophage-t4-infection, hiv-infected-cell, respiratory-droplet), all at very large scale.

### Round 4 (g4): the slab, the inside of the influenza virion, colours after his painting

- **Slab**: when cut, only a short way back from the cut is drawn. The grey-violet "bowl" that used to fill the influenza virion is gone, the membrane is a pale ring, and the spikes fall into three depths of tone.
- **The inside of the influenza virion** (inferred): matrix protein M1 from PDB 7JM3, whose own helical arrangement of 60 copies gives the area per copy and the side that faces the membrane, with 1,273 copies laid against the inner face; ribonucleoprotein from PDB 4BBL (a helical stretch of RNP isolated from virions, holding 616 nucleotides), eight in a parallel bundle; a polymerase (PDB 6RR7) at one end of each. The lengths of the eight genome segments come from NCBI reference sequences (NC_002016–NC_002023). Those lengths call for 23 helical stretches in all, of which only 8 fit in this virion (one per rod), the rest being cut off; the notes under the picture give both numbers.
- **Colour**: the parts of the influenza virion take the values measured on his painting (hemagglutinin h 290, neuraminidase h 321, M1 h 245, nucleoprotein h 62, RNA h 86, polymerase h 25).
- Writing the tests turned up a real fault: I first took "the principal axis of the copies' centroids" for the helix axis, but for a short, wide helix the direction of greatest variance lies across it, and both the radius and the area came out wrong. The axis is now found from the relative transform between two copies.

The numbers for this round are in the table above.

- Influenza: colour distance 0.103→0.081, fine relief 0.80→0.72 (0.85 in his painting).
- Synapse: fine relief 1.53→0.95 (0.94 in his painting).
- Coronavirus: with the slab its inside looks rather empty. The PetWorld model is not dense in nucleoprotein to begin with, and the picture used to be filled by what sat on the far inner wall; in his painting the inside is packed. That is the next thing to fill in by inference.
- What is still missing is in the rows marked as not done.

### Round 5 (g5): the spikes outside set in order

Having seen round 4 the user said: his outside is very symmetrical, ours is a mess. The reason is that ours is one frame of a molecular dynamics simulation, in which the spikes do lean and cluster (the median lean from the membrane's normal measures 14 degrees); what he paints is an idealised arrangement.

Following him (`src/infer/idealise.ts`):
- The chains of the simulation are grouped into complexes by how close their centroids are (236 hemagglutinin trimers, 30 neuraminidase tetramers, 11 M2 tetramers), and for each kind the most upright one, with the glycans on it, becomes the template.
- Sites lie on rings of latitude about the viewing direction, evenly spaced within a ring and offset by half a step between neighbouring rings; the middle ring sits just behind the equator, so that a cut from the front keeps the whole of it in the slab. Neuraminidase is spread evenly among the hemagglutinins.
- The template's axis is set along the membrane's normal at each site.
- This is done in the painted drawing only; switching to Illustrate reloads the model with the positions as they are in the simulation. The notes say what comes from the data and what is idealised.

Lines are a little heavier too (his are thin, but firmer than ours were last round). The side-by-side image is `out/g5-influenza.jpg`.

The coronavirus was not treated this way: the PetWorld model has only 30 spikes and is sparse to begin with, whereas his painting of 2020 shows many more. There the data and his painting disagree, and the number was left alone.

### Round 7 (g7): RNA as a line, and the coronavirus in his colours

- **The influenza genome RNA** is drawn as a yellow line: its course comes from the phosphorus atoms of the RNA chains in the RNP structure (PDB 4BBL), one in three and lightly smoothed, pushed onto the surface of the rod (otherwise it lies hidden in the nucleoprotein's groove) and joined with round cones. The course is the real one; pushing it to the surface is a treatment for visibility.
- Round cones now obey the back of the slab as well.
- **The coronavirus** takes the colours measured on his painting of 2020: a pale pink membrane (L 0.87, C 0.06, h 345), magenta spikes (h 336), pink M protein, lavender nucleoprotein (h 297).
- **"Bending the rods to fill the space" was not done**, having been worked out and dropped: the cavity of the virion in this simulation is about 31 nm in radius, and at the true thickness of an RNP no amount of bending fits more than nine or ten helical stretches (eight stand straight now), where the genome's length calls for twenty-three. His is so full because the virion he paints is larger. Filling ours would mean drawing RNPs thinner or fewer than they are, which would be invention rather than inference, so it was left.
- Side by side: `out/g7-influenza.jpg`, `out/g7-coronavirus.jpg`.
- Still short: the influenza RNA line tangles in the middle instead of running in clear separate waves like his; the coronavirus is still rather empty inside, with only 30 spikes (as the data has it); spike colour is dark in the layers behind.

### Round 8 (g8): the inside drawn full

**First a correction to round 7.** I wrote that "his is so full because the virion he paints is larger"; measured, that is wrong. The virion of the simulation is about 108 nm across with its spikes, already a typical size, and going by the length of a spike (13.5 nm) the one in his painting is if anything smaller (about 75 nm). His is full because he runs every ribonucleoprotein right up to the inner wall and shows part of each. The longest real ribonucleoprotein is over a hundred nanometres and has to fold to fit inside a spherical virion at all.

Following him:
- The size of the virion is left alone. Each ribonucleoprotein is laid stretch after stretch along its whole chord and cut off at the inner wall, with room left on top for the polymerase (`fill` in `rnpBundle`, and `clipToCavity`).
- Every nucleoprotein is outlined on its own, so the rods read as strings of beads, as in his painting, with the yellow line of the RNA showing between them.
- The notes say so: the genome's length calls for 23 helical stretches across the eight, what is drawn amounts to 8.3, only part of each is shown, and how they really fold is not drawn.
- In the Illustrate drawing each rod still gets whole helical stretches only.

Side by side: `out/g8-influenza.jpg`. Still short: the eight rods form a bundle in the middle, with space left between its flanks and the wall (he fills the whole circle); the heads of the spikes lack the lobes his have.

### Round 9 (g9): white filled in, outlines in black

Looking at `g8-influenza.jpg` the user asked for two things: structure where it is white, and black outlines.

- **Black outlines**: the ink is now nearly black with only a trace of the neighbouring fill's hue, and the line width goes from 1.05 to 1.6.
- **Every spike outlined on its own.** A fault was found: a spike and the glycans on it were in one group, and the rule "glycans are not outlined one by one" is decided per group, so whole spikes counted as not outlined and no line at all was drawn between neighbours. Glycans now form a group of their own.
- **Filling the white**: the slab goes from 24% of the frame height to 42%, so the gaps between spikes show the rings of spikes behind; inside, the seven outer ribonucleoproteins are spread out to the wall instead of hugging the middle one, and seen from the side they cover the whole circle.
- Side by side: `out/g9-influenza.jpg`.
- Still short: a few white slits remain at upper and lower left (where two rings of spikes happen to line up); the heads of the spikes lack the lobes his have; only a few neuraminidases fall in the slab.

### A loop of my own: look, find the cause, change, look again (influenza)

The user asked that problems no longer be pointed out by a person: I compare with his painting myself, find the cause, change it and compare again. Each round is recorded in the table above; the side-by-side images are `out/g10-influenza.jpg` and `out/L<round>-influenza.jpg`.

- **g10.** Seen: disorder outside, four or five rings of spikes piled up, aligned in places and overlapping in others, with pale patches on the spikes. Cause: rings held different numbers of spikes, so the half-step offset drifted round the ring; the slab was too thick; glycans had a pale colour of their own. Change: the equatorial ring and the one either side take the same count; the slab goes back to 20% of the frame height; glycans take their protein's colour; lines a little thinner. Result: the outside is two clean layers, bright and dark in alternation.
- **L1.** Seen: a blue latticed "bowl" inside; too few magenta neuraminidases in the cut; spikes wiped flat. Cause: with a thin slab only the inner wall of matrix protein was left behind; neuraminidase was spread evenly over the whole sphere; the smoothing probe was too large. Change: the ribonucleoproteins line the back; eight neuraminidases go evenly round the cut ring first; the probe drops from 7 pixels to 5. Result: neuraminidase is right, but the inside got worse, with white holes and ribonucleoproteins as ragged fragments.
- **L2.** Seen: white holes and fragments. Cause: the cut plane split the rods down their middle, taking the front half of each and exposing the inside of the helix. Change: the eight rods lie whole behind the cut, four side by side in the front row and two staggered rows behind; both matrix protein and ribonucleoproteins line the back. Result: the inside is columns of orange beads side by side with the yellow line of the RNA on them and the polymerases on top, and no white holes.
- **L3.** Seen: back layers too dark and muddy; nucleoprotein orange leaning brown. Change: the farthest layer goes to 0.64 of the fill instead of 0.5 (his three layers measure 0.76, 0.60, 0.45); nucleoprotein at L 0.79, C 0.15. Result: influenza colour distance 0.077→0.062.
- **L4.** Seen: many small holes in the ribonucleoproteins showing blue. Cause: gaps between atoms inside the helix. Change: atoms of that layer drawn at 2.9 Å. Result: fewer holes, not none; colour distance 0.070.
- **L5.** Seen: the coronavirus was white inside once cut (found only at L4, the first time the other models were looked at). Cause: the back of the slab cut away the far half of the membrane, and the model is sparse in nucleoprotein. Change: a membrane always lines the back. Result: the inside shows the deep pink of the membrane's inner wall, not paper.
- **L6.** Seen: dark grey fragments all over the synapse, and line everywhere. Cause: the membranes of hundreds of vesicles were all kept behind; small molecules, heavy lines. Change: only a single virion (no more than twenty thousand copies) has its membrane line the back; dense models get a line width of 0.9. Result: the fragments are gone, but paper shows everywhere.
- **L7.** Seen: paper showing all over the synapse and the mycoplasma. Cause: in a dense model a molecule is a few percent of the frame and a 20% slab is too thin. Change: dense models get a 50% slab and a line width of 0.7. Result: the synapse is filled, blank paper 0.10→0.00.
- **L8.** Seen: mixed colours in the synapse and the mycoplasma, with orange, blue, violet and tan all in one compartment. Cause: colour went by "role", and the roles' hues are spread round the whole wheel. Change: catalogue entries gain `hues` (which family each role takes in this model) and `membrane`, with values after his painting of the same subject: green cytoplasm with yellow-orange vesicles for the synapse; blue proteins, magenta ribosomes, yellow DNA and a green membrane for the mycoplasma. Result: mycoplasma colour distance 0.114→0.088; synapse 0.122→0.121 (its reference is a triptych, half of it a violet postsynapse, so the quantity says little here), and by eye it now matches.

- **L9.** Seen: few spikes (30) and a thin inside for the coronavirus; pink, violet and orange mixed inside HIV. Cause: the model's spike count is at the low end of what has been measured, and the ribonucleoproteins behind the slab were cut away; HIV was not coloured by compartment. Change: the coronavirus spikes are inferred at 74 from the literature and set in evenly spaced rings (`respike` in the catalogue entry, with its source); the ribonucleoproteins line the back (`lining`), their number unchanged; HIV takes his red family with yellow RNA. Result: the outside of the coronavirus is one full ring of alternating bright and dark spikes; blank paper 0.65→0.48.

- **L10.** Seen: black, dense line in the synapse and the mycoplasma, smothering the colour. Cause: dense models used the near-black ink too. Change: their lines take a deeper shade of the fill (inkTint 0.9, inkShade 0.34). Result: for the mycoplasma line lightness 0.39→0.48 and chroma 0.046→0.069 (his: 0.48, 0.072), colour distance 0.088→0.082; for the synapse line lightness 0.37→0.45 (his 0.35, so now a little pale) and colour distance 0.121→0.150 (its reference is a triptych; see L8).

**How the coronavirus numbers were inferred (L9).** From open-access full texts: Klein et al. 2020 (*Nat. Commun.*, doi:10.1038/s41467-020-19619-7, in situ cryo-electron tomography of SARS-CoV-2) give 48 spike trimers per virion on average, range 25–127, and 38 ± 10 ribonucleoproteins; Neuman et al. 2011 (*J. Struct. Biol.*, doi:10.1016/j.jsb.2010.11.021, coronaviruses) give 74 spikes on average. The PetWorld model has 30 spikes and 36 ribonucleoproteins: the spikes at the low end of the measured range, the ribonucleoproteins in agreement. So spikes are set to 74 (Neuman's average, inside Klein's range and above Klein's mean; the density of Goodsell's 2020 painting is close to it) and the number of ribonucleoproteins is left alone. For M protein I found no figure I could cite directly, and it was not changed.

**Where the loop stands.** Influenza is close to his painting in structure and colour. Still wrong, by my own eye: the coronavirus is still thinner inside than his (36 ribonucleoproteins agree with measurement; he paints it packed); DNA in the mycoplasma is lumps, not the long strands he paints; no painting has its surrounding environment.

## Drawing by concept (stage six)

After ten rounds of tuning model by model the gap was still plain, so the approach changed: his way of painting is distilled into a few **concepts shared by every model**, with "what this is" (membrane, nucleic acid, protein) deciding how it is drawn rather than "which model this is", and what the data lacks is filled in on stated grounds by a few **general tools**. Checking changed in two ways as well: a small piece of his full-size picture set beside the same piece of ours (`out/C<n>-detail-*.jpg`), and all 25 cards rendered into one contact sheet at every step (`sheet.py`, `out/sheet-C<n>.jpg`).

### C1–C2: line, membrane

**The full-size originals showed that something had been measured wrongly.** On the 800-pixel reductions I had measured "his lines are a deeper shade of the fill, rather pale and coloured" and lightened ours accordingly. At full size (left half of `out/C2-detail-influenza.jpg`) that is not so: in the watercolours he uses **a thin, dark ink line drawn round every shape**. Reduced, the thin line blends with the colour beside it, which is what measured as "pale and coloured". His Molecule of the Month pictures since 2015 really have no black lines, but that is a different way of drawing. So:

- **Line** (watercolours): a thin near-black ink line of even width.
- **Membrane**: lipids are always cut sphere by sphere, giving a clean cut edge, and are tagged as membrane in the ids; a membrane seen edge-on (a narrow band as wide as one membrane) gets a very faint dashed line along its middle (the composite pass looks for the band's two edges in eight directions).
- **An ideal membrane** (tool): a simulated membrane undulates and its cut edge is ragged. In the painted drawing the influenza virion now has an ideal spherical shell (`shellMembrane`), as thick as the data's.
- **One colour per complex**: chains of one kind of molecule no longer alternate in lightness, so spikes are no longer striped.
- The cap on the smoothing probe drops from 14 Å to 6.5 Å, keeping relief of a nanometre or two.
- The synaptic vesicle takes his yellow-orange.

**Seen on the contact sheet and not yet fixed:** the HeLa cell is black line on white and looks dirty; the syn3A envelope is an empty disc; the coronavirus has white holes inside; the influenza spikes are still slabs without the thin stalk and lobed head he gives them (that is the real structure once smoothed, and is for the concept "lobed protein" to solve); the mycoplasma's DNA is lumps.

### C3: nucleic acids as strands

- **Concept**: a fibre the model lays out piece by piece (DNA, RNA) is drawn as a strand of even width. Every piece is a sphere of one size (11 Å radius for DNA, 7 Å for RNA), which join into a band of constant width, with no lines between pieces.
- **Keeping neighbouring strands apart**: at first the whole chromosome shared one id, and strands lying side by side fused into sheets of yellow. So the id now changes every 110 Å along the course (`fibreSegments`): two neighbouring strands have different ids and a line between them, and one strand shows a cross-mark every so often, like the rope lay he paints.
- **Two wrong turns here.** The mycoplasma model splits one chromosome into four groups by base. I first assumed the four interleave and can be merged in order, and every sphere came out ringed again. It turned out that two of the groups are the other strand of the duplex, running the opposite way. Ids are now shared by place: a later group passing where an earlier one has been takes the id found there.
- The mycoplasma's RNA takes his pinkish white.
- Side by side: `out/C3-detail-mycoplasma.jpg`; contact sheet `out/sheet-C3.jpg`. Nucleic acids in the mycoplasma and the exosome now read as strands.
- **Where it still differs from his**: he paints DNA as sparse, nearly straight long strands; the model's chromosome is packed at its real density, dense and winding. That is a difference between the data and his painting and was left alone.
- For dense models a slab of 30% (paper shows again in the synapse) and of 50% (the mycoplasma becomes a wall of DNA) were tried; 40% is used.

### C4: scenes, and two new tools (filling the environment, threading strands)

- **The concept "scene"**: the subject sits in a crowded environment that fills the sheet, on a dark ground. The coronavirus comes first (his painting of it is a scene).
- **The tool "fill the environment"** (`scatter` in `src/infer/environment.ts`): a few proteins are placed at random round the subject in one layer behind the cut, outside the subject's range and not overlapping one another.
- **The tool "thread a strand"** (`threads`, same file): wandering long strands whose direction changes at random with inertia and slides off along the subject's surface on meeting it. Mucin is drawn with it, through the round-cone primitive.
- The coronavirus's surroundings follow his "Coronavirus" (2020): long mucin strands, antibodies (PDB 1IGT) and small proteins (stood for by serum albumin, PDB 1AO6). The grounds are stated in `environment` in the catalogue entry; the source panel reads "schematic environment", and the notes say that positions are random and numbers set to fill the picture; the Illustrate drawing shows the model alone.
- The frame is cropped inside the environment (it opens at 1.22 times), so no margin of ground shows.
- Measured (coronavirus; his painting in brackets): blank paper 0.48→0.00 (0.00), colour distance 0.110→0.094, mean lightness 0.60 (0.61), mean chroma 0.096 (0.104).
- Side by side: `out/C4-coronavirus.jpg`.
- **Still short**: his mucin is branched and brush-like with its glycans, ours is a smooth strand; gaps between spikes show the ground where his show the deeper tone of the ring behind; the small orange proteins are one structure repeated a few hundred times, where he paints several kinds.

### C5–C6: checking, and the tools applied to a model that is empty inside

- After the scene step the contact sheet of every card was rendered again (`out/sheet-C5.jpg`) with nothing broken, and the Illustrate comparison was rerun, still at 2.80.
- **The syn3A envelope**: the data holds membrane and membrane proteins only and is empty inside. The tools "fill the environment" and "thread a strand" now fill it (they gained an option to keep within a radius): long strands of chromosomal DNA, ribosomes (PDB 7P6Z), the chaperonin GroEL (PDB 1AON), and small soluble proteins (stood for by PDB 2HHB). Colours follow his "JCVI-syn3A Minimal Cell" (2022): green membrane, magenta ribosomes, blue proteins, yellow DNA. Colour distance 0.081. Side by side: `out/C6-syn3a.jpg`. All of it is schematic, and the notes say so; hemoglobin stands in for small soluble proteins only because it is the right size, not because the cell contains it.
- **The HeLa cell**: in the painted drawing it is on warm paper with very thin lines a deeper shade of the fill. Organelle fragments number in the thousands, and black line smothered the picture.
- **Not done**: the concept "lobed protein" is not done, and the influenza spikes are still slabs; "arranging" and "lining" have not been merged into one general tool, and HIV does not use them.

### D1–D2: what looking into "lobed proteins" found, and influenza once more

- **"Lobed proteins" was not done, and the reason is now clear.** The influenza spikes are slabs; I first suspected the splayed glycans of the simulation of thickening the stalk and tried once without them: no change. Measured against his full-size original, his spikes are about 4.2 membrane thicknesses long, with a thin stalk and a lobed mushroom head; a real hemagglutinin trimer is about 3 membrane thicknesses long and much the same width top to bottom. **His spikes are exaggerated.** Moulding the real structure into that shape would go against "the structures are real", so it is left, and the difference stays.
- **The membrane's thickness had been measured wrongly**: the ideal shell took the 2nd to 98th percentile of lipid radii in the simulation, which for an undulating membrane comes to about 80 Å, twice a real membrane. It is now 38 Å about the median radius. The matrix layer and the cavity move outwards with it, leaving more room to draw ribonucleoprotein.
- **The matrix layer reads as a band**: its copies share one id with no lines between them (`oneId`). It used to be small cells full of black line.
- Influenza colour distance 0.077→0.072. Side by side, `out/D2-influenza.jpg`: the thin pale membrane with its mid-line, the blue band of matrix protein, the orange ribonucleoprotein filling the inside and the red polymerases on top each answer to his painting; the shape of the spikes does not, for the reason above.

### E1–E2: HIV as a scene too

- HIV is surrounded by plasma: albumin (PDB 1AO6), antibodies (PDB 1IGT) and fibrinogen (PDB 3GHG), after his "HIV in Blood Plasma". Those are the three most abundant classes of plasma protein; numbers are set to fill the picture and are schematic.
- **One change to the environment tool**: the room a molecule takes went by its farthest atom, so long thin fibrinogen claimed a large sphere in which nothing else fitted and the picture was sparse. It now goes by the root-mean-square radius. The coronavirus scene grew a little denser with it (colour distance 0.092→0.089).
- HIV colour distance 0.134→0.081, blank paper 0.47→0.00. Side by side: `out/E2-hiv.jpg`.
- **Where it differs from his**: his is at a much smaller scale, with the virus a whole sphere (not cut open) taking a quarter of the picture, where ours is a cut-away close-up. His plasma proteins are smaller, denser and of more kinds.

### X1–X2: the "exaggeration" option

The user agreed to a clearly labelled "exaggeration" option. `exaggerate` (`src/infer/idealise.ts`) stretches a spike along its axis, narrows its stalk and widens its head: influenza hemagglutinin 1.4 times as long, stalk 0.55, head 1.2; neuraminidase 1.25, 0.5, 1.15; the coronavirus spike has only its head widened, to 1.3. The factors were set against his full-size original (his spikes are about 4.2 membrane thicknesses long, real ones about 3).

- Painted drawing only, on by default; there is a switch under "Lines and shadows", and `?exaggerate=0` in the address turns it off too. The notes say that this is not the real shape. The Illustrate drawing is unaffected.
- The slab goes from 20% to 30%: with thinner stalks the gaps have to show the ring behind.
- Influenza colour distance 0.072→0.075 (hardly moved), yet by eye it is a large step closer: spikes have a thin stalk and a wide head, and neuraminidase is a mushroom. Coronavirus 0.089→0.081, with the spikes now nearly one continuous ring.
- Side by side: `out/X2-influenza.jpg`, `out/X2-coronavirus.jpg`.
- **Still short**: the heads of his spikes are split into lobes, where ours are one block with a ragged edge; paper still shows in a few places between influenza stalks.

### S1–S2: single molecules after his way of drawing since 2015

Single structures loaded by id, in the painted drawing, now follow his recent Molecule of the Month pictures: **atoms can be seen** (no smoothing), **no black lines**, the outline a deeper shade of the fill. A first try made the lines too pale and kept the smoothing, which gave a blur; it was corrected against his coronavirus spike picture (article 246). Measured, line lightness is 0.48 (his 0.43) and the share of the subject that is line 0.11 (his 0.10). Side by side: `out/S2-*.jpg`. Colours and viewpoint differ from his (he colours by domain and adds a schematic membrane and stalk); those were not done.

### G1: checking the sheet, a ground for the synapse, branched mucin

- The contact sheet of all 25 cards was rendered again (`out/sheet-G1.jpg`), and the Illustrate comparison rerun, still at 2.80.
- **The sheet caught a regression**: with smoothing turned off for single molecules in the last step, large structures of hundreds of thousands of atoms such as the Zika and HIV capsids had become speckle. Structures with more than 200 thousand placed atoms are smoothed again.
- **White holes in the synapse**: the pre- and postsynaptic scenes get a dark ground (`ground` in the catalogue entry), so gaps show a deep tone and not paper.
- **Branched mucin**: the threading tool gained `branches`, a short side piece every few steps, used for the coronavirus's mucin. It is still some way from the brush he paints: his branches are denser and longer, and the space between strands is filled.

### H1: one by one, small molecules as dots, DNA at its true width

The four cards of the list not yet compared one by one (Zika, nuclear pore, synaptic vesicle, exosome) were put beside his pictures. Zika, the nuclear pore and the exosome showed nothing large to change; the synaptic vesicle was the worst, and the mycoplasma's DNA next.

- **The concept "small molecule"** (`out/H1-synaptic-vesicle.jpg`, old left, new right): the glutamates in the vesicle shared one id and were wiped into a blotched mass. He paints them as dots. Each small molecule now collapses to one sphere at its centroid (`dots` in the catalogue entry, radius 8 Å), outlined on its own. **This is an exaggeration**: positions are the model's, the size is not, and real glutamate is much smaller; it belongs to the "exaggerate" option, can be turned off, is stated under sources, and the Illustrate drawing is unaffected.
- **The concept "nucleic acid", width** (`out/H1-mycoplasma-dna.jpg`, ours left, his right): the DNA of the mycoplasma model is a bead model, two beads of radius 11 Å per base pair, drawing about 41 Å wide, twice real DNA (20 Å). In the painted drawing each piece collapses to one sphere on the midline: radius 10 Å for a duplex, 5 Å for a single strand. This one is not an exaggeration; it brings the model's oversized beads back to the true width.
- **Nucleic acid, length**: the slab is two and a half times as deep for fibres as for other molecules, so DNA runs long and passes behind the molecules in front and is no longer cut into short pieces.
- **Nucleic acid, cross-marks**: the id used to change every 110 Å, leaving cross-marks along a strand; his DNA has none. It is now 2000 Å.
- Still unlike his: his DNA runs straight and sparse; the model's is curved and dense, which is the data itself and was left alone. The lines are still blacker than his.

### J1: lighter line, the ring behind shows between spikes

- **The concept "line", revised again** (`out/J1-ink.jpg`: near-black, the fill deepened to 0.32, deepened to 0.45 and thinner, his painting): lines in mesoscale models go from near-black to a deeper shade of the fill (`inkTint` 0.85, `inkShade` 0.32). This does not contradict what round C found, but the choice changed: on his originals the line is indeed thin and dark, yet our pictures are seen at the reduced size, where a near-black line of one pixel is far heavier than his. Every shape is still outlined. **This alters the "outline in black" the user asked for earlier**, and the reply says so.
- **Gaps between spikes** (`out/J1-coronavirus.jpg`: before, after, his painting): the rearranged spikes line the back (not cut at the back of the slab), so between the spikes in front the ring behind shows in a deeper tone and not the dark ground. A few spots of ground remain.
- The sheet of all 25 cards: `out/sheet-J1.jpg`.

### K4: mucin goes from a net to separate branched chains

(`out/K4-coronavirus.jpg`: before, after, his painting) The mucin round the coronavirus had 70 strands whose heading shifted a good deal each step, and after smoothing they joined into a green net. Four tries: thinning to 4 Å made it more of a net; 30 strands with a small shift per step gave separate strands, but too straight and sparse; the setting kept is 34 strands, radius 6.5 Å, a shift of 0.32 per step, branches of two pieces. Albumin went from 240 copies to 170 and the ground from near-black to a deep olive. The threading tool's shift per step is smaller now, so the DNA it generates in syn3A is somewhat straighter as well; it was looked at and is no worse.

### K7: the mycoplasma's DNA threaded afresh after his painting (the user's choice)

(`out/K7-mycoplasma-dna.jpg`: the whole, the middle, his painting) Of the four questions put to the user, this one was answered "thread it afresh after his painting". The environment tool gained `replace`: in the painted drawing what the model holds under a matching name (here `fibers.DNA`) is taken out and generated strands stand in for it; the threading tool gained `wander` (how far the heading shifts per step). Three tries: 70 strands, almost straight, at the back of the slab, were mostly hidden by protein; moved to a thin layer at the very front they became a pile of crossing sticks, webbed where they crossed; the setting kept is 30 strands, a shift of 0.2 per step, radius 7 Å.

A great deal of this is inference, and the sources panel says so plainly: the courses are generated at random and far straighter than real DNA; by genome length and the slab's volume the picture should hold about 42 micrometres, and only about 18 are drawn. The Illustrate drawing still shows the DNA as the model has it.

### L1: extracellular matrix outside the postsynaptic scene (the user's choice), and a fault in switching drawings

- **Filling outside an irregular shape** (`out/L1-postsynaptic.jpg`, old left, new right): the user chose "fill the outside of the cell as he does". The environment tool could only fill round a sphere; it gained `outsideOf`: the positions of the subject's parts are entered in a coarse grid of 70 Å, occupied cells are swollen by one, and the grid is flooded from its boundary; what the flood reaches is the outside. Voids inside the cell are not reached and not filled. What is filled in is branched chains (hyaluronan carrying proteoglycans) and small stand-in proteins. A gap one or two cells wide remains outside the membrane, from the swelling.
- **To be said plainly**: in real brain tissue the extracellular space is a cleft a few tens of nanometres wide and most of this area is in fact neighbouring cells, which the model does not hold; filling it with matrix serves the picture. The sources panel says so.
- **A fault in switching drawings**: a model with a schematic environment, dots or a ground of its own was not reloaded on switching from painted to Illustrate, so inferred things stayed in the Illustrate picture (HIV and syn3A always had this; it was found while checking the mycoplasma). Such models now reload on a switch; checked by switching back and forth on the mycoplasma.
- The sheet of all 25 cards: `out/sheet-L1.jpg`.

### M3: the influenza spikes stand apart

(`out/M3-influenza.jpg`: before, after, his painting) Exaggeration widened the hemagglutinin head to 1.2, so neighbouring heads joined and the ring of spikes became one continuous skirt; his spikes stand apart, with the darker row behind showing in the slits. The head is back at its own width (1.0) and the stalk goes from 0.55 back to 0.75. A head of 0.95 with a stalk of 0.5 was tried: the spikes parted, but a good deal of paper showed between the stalks. Letting the spikes line the back (not cut at the back of the slab) made almost no difference here (the two renders differ in a thousand-odd pixels): the slits go right through, and it is not that the rows behind were cut away. Some small white holes remain where his painting has deep indigo.

### N2: HIV spikes rearranged, spike heads in lobes (the user's choice)

- **HIV** (`out/N2-hiv.jpg`: before, now, his painting): the model has 100 spikes; the literature gives 14 ± 7 per virion (Zhu et al., Nature 2006). In the painted drawing the arranging tool replaces them by 14, evenly spaced. **The even spacing is an idealisation**: in that paper the spikes are not evenly spread, and the sources panel says so. I had held that this had no grounds and should not be done; the user asked for it. The spikes take his pink-red.
- **Lobes** (`out/N2-coronavirus.jpg`): the exaggeration tool gained `lobes`: each subunit of the head is pushed some Å out to its own side, more towards the tip, so the head parts into lobes. Directions are those of each chain's centroid in the head relative to the axis; with a single chain, equal sectors are used. 16 Å for the coronavirus and 6 Å for influenza (at 9 Å more paper showed between stalks). Result: the HIV head reads as three lobes; the coronavirus and influenza heads only show notches at the tip, still far from the fanned lobes he paints.

### R1: first step after the card-by-card comments — why things looked coarse, and a ring of protrusions on a membrane

The user commented on the 14 comparisons one by one; the comments reduce to five problems (insides not handsome, protrusions not fine, no background, no ordered fringe outside cells, and a few particular ones). The plan is under `~/.claude/plans/`; this records what each step found.

- **One judgement overturned**: the plan held that the coarseness came from smoothing being set in screen pixels. Reading the code showed the probe radius is capped once converted to Å (6.5 Å), so it already goes by molecular size; and on the vesicle, turning smoothing off, tripling it, and thickening the slab left the proteins' shapes almost unchanged in four renders. Smoothing is not the cause.
- **The real cause**: the vesicle model has only 104 proteins on its membrane (21 kinds), a dozen visible in the slab, each facing its own way; he paints a score of evenly spaced whiskers.
- **The concept "a ring of protrusions on a membrane"** (a new tool, `arrange`, in `src/state/store.ts`): the proteins of a membrane are set out afresh in evenly spaced rings (kinds interleaved) and the membrane becomes a smooth, even shell. Each protein's structure, number, depth in the membrane and tilt are the model's; only where on the sphere it stands is rearranged. The sources panel says so.
- **A ground inside**: `arrange.lining` puts a layer of a deeper colour just inside the membrane, so the cut membrane reads as a band.
- **A deeper slab for dots** (instance flag 9): small molecules drawn as dots get a slab two and a half times as deep. The vesicle's dots still do not fill it: the model holds only 400 glutamates.
- **Background**: the vesicle sits in a schematic cytoplasm (stand-in soluble proteins, large complexes, filaments).
- **How near the environment comes** (`environment.clear`): the environment used to begin at the subject's farthest point, so a few far-reaching proteins left an empty ring of ground (which the user pointed out on HIV). It can now begin anywhere between "nine tenths of the points" and "the farthest point": 0.45 for HIV, 0.55 for the vesicle, and 1 as before for the coronavirus (lower, and mucin and antibodies creep in between the spikes). Environment proteins lie wholly behind the cut and no longer reach in front of it to cover what the subject holds out.

### S4: the fringe outside the mycoplasma (the user: "no green tangle of small, yet orderly, protruding lines")

(`out/S4-mycoplasma-fringe.jpg`: the whole, a detail of the top edge, the same place in his painting) Only on enlarging his painting did the remark become clear: outside his cell lies a thick band of tangled green strands (the capsule's polysaccharide chains), hugging the membrane and even in thickness, with a tidy row of small lobes on the membrane.

- Membrane proteins are set out in evenly spaced rings with `arrange` (4563 of them, 118 kinds) and the membrane becomes a smooth shell.
- The environment tool gained `fringe`: strands confined to a layer outside the membrane (the threading tool given both an inner and an outer radius), a deeper shade of the same hue laid behind, and the outer edge left to the strands, which reach out raggedly. Three tries: first a slit lay between strands and membrane (the range took the farthest point; now the shell's outer edge); then the ground was too dark, the strands too few, and paper showed between membrane and ground (the centre was the mean of the parts' positions; now the shell's own).
- **To be said plainly**: he painted Mycoplasma mycoides, which has a polysaccharide capsule; this model is Mycoplasma genitalium, for which no such capsule was found on record. The fringe follows his painting and is not how this species really is, and the sources panel says so.
- Still unlike his: the small lobes on his membrane are bright green and set like tiles, ours hardly show; his strands are finer and curlier.
