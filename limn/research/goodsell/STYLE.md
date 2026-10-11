# 从图集里学到的做法 / What the gallery teaches

## 中文

我把 Goodsell Gallery 的 49 幅画（`gallery/`）和他给每幅写的说明（`gallery/index.json`）看了一遍。下面是他反复使用的做法，以及 limn 现在做到了哪一条。说明很有用：他逐个写了每种颜色画的是什么，比如流感那幅：“lipid bilayer membrane (light purple) … hemagglutinin (purple), neuraminidase (magenta) … M1 matrix protein (blue) lines the inner side of the membrane. RNA-dependent RNA polymerase (red) is bound to the genomic RNA strands (yellow), which are protected in a helical complex with nucleoprotein (orange).”

| 他的做法 | 在哪些画里看得最清楚 | limn |
|---|---|---|
| **画的是一片薄切片**：切面这一层用亮色，后面一两层用同色的深一号，再往后不画。从不画整个物体的后半个内壁。 | influenza-virus、zika-virus、ebola-virus、coronavirus、escherichia-coli | 已做（`Style.slab`，剖开时只画厚度为画幅高度 16% 的一片） |
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

## English

I went through the 49 paintings of the Goodsell Gallery (`gallery/`) and the description he gives each (`gallery/index.json`). The table above lists the practices he uses again and again, and which of them limn now follows. The descriptions are valuable: he says what every colour stands for, as quoted above for the influenza painting.

In order, the rows of the table are:

1. **He paints a thin slab**: the cut layer in bright colour, a layer or two behind it in deeper shades of the same hue, and nothing beyond; never the far inner wall of the whole object. Done (`Style.slab`: when cut, only a slab 16% of the frame height thick is drawn).
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
