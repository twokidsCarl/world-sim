# 以 Goodsell 的原画为基线 / Goodsell's paintings as the baseline

## 中文

limn 以前对齐的是 Goodsell 的电脑出图程序 Illustrate（见 `../illustrate/`）。这个目录对齐的是另一样东西：他**手绘的全景画**。做法是把同一个对象的“他的画”和“limn 的图”并排放，逐条看差在哪，改一步量一步。

### 参考图

取自 PDB-101 的 [Goodsell Gallery](https://pdb101.rcsb.org/sci-art/goodsell-gallery)，页面写明 “These illustrations are free for use under CC-BY-4.0 license. Acknowledgement should be given as shown for each illustration.” `refs/` 里是 800 像素宽的版本（转成了 JPEG）；原尺寸在 `https://cdn.rcsb.org/pdb101/goodsell/tif/<名字>.tif`。各幅的署名：

| 文件 | 署名 |
|---|---|
| `refs/zika-virus.jpg` | Illustration by David S. Goodsell, RCSB Protein Data Bank. doi: 10.2210/rcsb_pdb/goodsell-gallery-015 |
| `refs/coronavirus.jpg` | Illustration by David S. Goodsell, RCSB Protein Data Bank; doi: 10.2210/rcsb_pdb/goodsell-gallery-019 |
| `refs/hiv-in-blood-plasma.jpg` | Illustration by David S. Goodsell, The Scripps Research Institute. doi: 10.2210/rcsb_pdb/goodsell-gallery-002 |
| `refs/influenza-virus.jpg` | Illustration by David S. Goodsell, RCSB Protein Data Bank. doi: 10.2210/rcsb_pdb/goodsell-gallery-049 |
| `refs/excitatory-and-inhibitory-synapses.jpg` | Illustration by David S. Goodsell. doi: 10.2210/rcsb_pdb/goodsell-gallery-016 |
| `refs/mycoplasma-mycoides.jpg` | Illustration by David S. Goodsell, The Scripps Research Institute. doi: 10.2210/rcsb_pdb/goodsell-gallery-011 |
| `refs/escherichia-coli.jpg` | Illustration by David S. Goodsell, The Scripps Research Institute. doi: 10.2210/rcsb_pdb/goodsell-gallery-001 |
| `refs/biosites-cytoplasm.jpg` | Illustration by David S. Goodsell. doi: 10.2210/rcsb_pdb/goodsell-gallery-006 |
| `refs/jcvi-syn3a-minimal-cell.jpg` | Illustration by David S. Goodsell, RCSB Protein Data Bank. doi: 10.2210/rcsb_pdb/goodsell-gallery-042 |

配对写在 `pairs.json`。`jcvi-syn3a-minimal-cell`、`escherichia-coli`、`biosites-cytoplasm` 三幅先取了回来，还没有配上场景。

### 怎么量

`measure.py` 的开头说明了每个量的意思。两张图不可能逐像素对齐（分子摆在哪是他安排的），所以量的是画法：白纸占比、线的多少、线的明度和彩度、细碎起伏、主体的平均明度和彩度、主色与参考图的距离。

```sh
uv run --no-project --with numpy --with scipy --with pillow python -I research/goodsell/measure.py g1
```

它从 `.cache/snapshots/<轮次>-<名字>.png` 取 limn 的图（在页面的控制台里用 `limn.snap('<轮次>-<名字>', 1200)` 存），把并排图写到 `out/`。

这些数只用来防止越改越差。**像不像，最后是眼睛说了算。** 其中 `flat` 这一项没有用：水彩有纸纹，limn 的平涂反而“更平”，它分不出好坏。

### 基线（g0，改之前）

| pair | which | paper | ink | ink_L | ink_C | bumps | flat | L | C | palette |
|---|---|---|---|---|---|---|---|---|---|---|
| influenza | Goodsell | 0.330 | 0.116 | 0.331 | 0.077 | 0.851 | 0.369 | 0.662 | 0.099 |  |
| influenza | limn | 0.418 | 0.168 | 0.290 | 0.026 | 0.939 | 0.856 | 0.609 | 0.071 | 0.119 |
| zika | Goodsell | 0.000 | 0.084 | 0.383 | 0.076 | 0.700 | 0.544 | 0.645 | 0.096 |  |
| zika | limn | 0.389 | 0.328 | 0.271 | 0.035 | 1.691 | 0.479 | 0.576 | 0.086 | 0.177 |
| coronavirus | Goodsell | 0.000 | 0.101 | 0.399 | 0.092 | 0.806 | 0.407 | 0.606 | 0.104 |  |
| coronavirus | limn | 0.608 | 0.224 | 0.259 | 0.023 | 0.981 | 0.710 | 0.547 | 0.070 | 0.110 |
| hiv | Goodsell | 0.003 | 0.184 | 0.310 | 0.063 | 0.812 | 0.319 | 0.612 | 0.083 |  |
| hiv | limn | 0.465 | 0.240 | 0.250 | 0.025 | 1.125 | 0.664 | 0.542 | 0.074 | 0.104 |
| synapse | Goodsell | 0.021 | 0.122 | 0.348 | 0.074 | 0.944 | 0.333 | 0.554 | 0.094 |  |
| synapse | limn | 0.359 | 0.277 | 0.223 | 0.017 | 2.379 | 0.266 | 0.451 | 0.048 | 0.142 |
| mycoplasma | Goodsell | 0.305 | 0.131 | 0.481 | 0.072 | 1.581 | 0.314 | 0.637 | 0.081 |  |
| mycoplasma | limn | 0.374 | 0.160 | 0.249 | 0.024 | 1.212 | 0.482 | 0.442 | 0.058 | 0.226 |

并排看下来，差在这几处（流感那一对最干净，因为是同一个对象、同样剖开）：

1. **膜**是浑浊的橄榄色，内壁还有一圈圈色阶；他的膜是很浅的淡紫（量得 L 0.89、C 0.035）。
2. **线**是纯黑的粗线（彩度 0.02–0.03）；他的线是填色的深一号（彩度 0.06–0.09，明度 0.31–0.48）。
3. **同种分子**的每条链颜色都不一样，像拼布；他的同种分子几乎一个颜色。
4. **糖链**是灰绿的小点，像脏东西；他把它们画成蛋白外缘同色的小瓣。
5. **形状**是原子的疙瘩；他的是光滑的轮廓。
6. **远处**往灰褐色褪；他的远一层是同色的深一号（血凝素前后三层明度 0.76、0.60、0.45，彩度不变）。
7. **画面**：他多数的画铺满整张纸、背景是拥挤的环境；我们是一个东西摆在白纸上。
8. 我们的病毒里面是空的：模型里本来就没有基质蛋白和基因组。这一条是数据决定的，不改。

### 第一轮（g1）：线和颜色

改了：线取旁边填色的深一号并减细；去掉原子间的阴影；远处把本色压暗加浓而不是褪向雾色；膜改成浅淡紫；主角的色相移到紫–品红（他三幅病毒画的 h 是 290–336）；糖链用蛋白的同色浅一号；同种分子相邻拷贝的色相步长从 9 度减到 3 度；纸略暖并带一点纸纹。只对整体模型和全景生效，单个分子的 Illustrate 画法没动。

limn 这一轮的数（参考图的数同上表）：

| pair | which | paper | ink | ink_L | ink_C | bumps | flat | L | C | palette |
|---|---|---|---|---|---|---|---|---|---|---|
| influenza | limn | 0.420 | 0.116 | 0.487 | 0.068 | 0.874 | 0.875 | 0.704 | 0.067 | 0.108 |
| zika | limn | 0.389 | 0.328 | 0.271 | 0.032 | 1.689 | 0.531 | 0.576 | 0.077 | 0.173 |
| coronavirus | limn | 0.613 | 0.171 | 0.450 | 0.066 | 1.034 | 0.721 | 0.666 | 0.084 | 0.121 |
| hiv | limn | 0.469 | 0.228 | 0.427 | 0.072 | 1.404 | 0.637 | 0.655 | 0.096 | 0.157 |
| synapse | limn | 0.365 | 0.247 | 0.417 | 0.049 | 2.687 | 0.243 | 0.604 | 0.064 | 0.105 |
| mycoplasma | limn | 0.376 | 0.160 | 0.410 | 0.060 | 1.609 | 0.326 | 0.568 | 0.088 | 0.128 |

- 线的明度从 0.22–0.29 升到 0.41–0.49，彩度从 0.02–0.03 升到 0.05–0.07，进了他的范围（明度 0.31–0.48，彩度 0.06–0.09）。
- 主色距离：流感 0.119→0.108，突触 0.142→0.105，支原体 0.226→0.128，变近；新冠 0.110→0.121，HIV 0.104→0.157，变远。后两幅参考画的大半面积是周围的血浆和黏液（黄、绿），我们没有画环境，主角改紫之后离“整幅画的主色”反而远了；看图本身是更像了。这说明主色距离在没有环境的场景上不可靠。
- 寨卡没变：它是按 PDB 编号载入的，走的还是 Illustrate 画法。
- 还差：形状仍是疙瘩（第二轮做平滑）；膜的内缘有一圈碎线；构图和环境没动。

### 第二轮（g2）：光滑的形状，单个结构也用手绘画法

- **“滚球”平滑**（`src/render/shaders.ts` 的 `SMOOTH_FS`）：画球时每个球的半径加一个探针半径，再对深度做一次以同样半径的球为结构元的腐蚀。合起来是高度场上的闭运算：原子之间的沟被填平，轮廓光滑，分子的外形和大小不变。探针半径按屏幕像素定（1500 像素宽的图上 7 像素），所以整颗病毒时分子成为光滑的一团，放大到看得见原子时自然变弱。
- **单个结构**（按 PDB 编号载入的）也改用手绘画法：一条链一个平涂的颜色（碳不再另取灰一号的颜色），线是填色的深一号，阴影很轻。核酸的颜色按他画里核糖核蛋白量出的黄–橙（h 59–81）调亮。
- **切换**：界面“线条与阴影”里多了“画法”一项，可以切回 Illustrate；地址里加 `?style=illustrate` 效果相同。Illustrate 画法本身没动，对照仍是 2.80。

| pair | which | paper | ink | ink_L | ink_C | bumps | flat | L | C | palette |
|---|---|---|---|---|---|---|---|---|---|---|
| influenza | limn | 0.419 | 0.105 | 0.479 | 0.067 | 0.795 | 0.889 | 0.706 | 0.068 | 0.103 |
| zika | limn | 0.388 | 0.154 | 0.427 | 0.068 | 0.982 | 0.861 | 0.690 | 0.097 | 0.178 |
| coronavirus | limn | 0.611 | 0.120 | 0.454 | 0.067 | 0.786 | 0.859 | 0.685 | 0.089 | 0.125 |
| hiv | limn | 0.467 | 0.177 | 0.470 | 0.078 | 1.008 | 0.823 | 0.699 | 0.102 | 0.189 |
| synapse | limn | 0.365 | 0.260 | 0.433 | 0.052 | 2.830 | 0.270 | 0.625 | 0.068 | 0.107 |
| mycoplasma | limn | 0.376 | 0.209 | 0.444 | 0.067 | 1.441 | 0.598 | 0.649 | 0.098 | 0.097 |

- 细碎起伏（`bumps`，他的画是 0.70–0.94，支原体那幅 1.58）：流感 0.87→0.80，新冠 1.03→0.79，HIV 1.40→1.01，寨卡 1.69→0.98，进了他的范围；突触仍是 2.8，那张图在这个比例下每个分子只有几个像素，平滑帮不上，要靠构图（放大）来解决。
- 寨卡这一对现在变了：淡紫的衣壳、粉色的糖链。
- `out/g2-nucleosome-before-after.jpg` 是核小体改前改后的并排图。
- 试过更大的探针（9 像素）：形状更圆，但血凝素的刺连成了一整圈，退回 7。
- 没改好的：相邻的同种分子在平滑后会连在一起，只剩编号不同处的一条线分开；膜的切口内缘还有一圈碎线；有的地方出现小白洞（真实的缝隙被描了边）；构图和环境没动。

## English

limn used to be matched against Illustrate, Goodsell's own program (see `../illustrate/`). This directory matches it against something else: his **hand-painted landscapes**. The method is to put "his painting" and "limn's picture" of the same subject side by side, list where they differ, and measure after every change.

### References

From PDB-101's [Goodsell Gallery](https://pdb101.rcsb.org/sci-art/goodsell-gallery), whose page states: "These illustrations are free for use under CC-BY-4.0 license. Acknowledgement should be given as shown for each illustration." `refs/` holds the 800-pixel versions (converted to JPEG); full size is at `https://cdn.rcsb.org/pdb101/goodsell/tif/<name>.tif`. The acknowledgement of each is in the table above.

The pairs are in `pairs.json`. Three paintings (`jcvi-syn3a-minimal-cell`, `escherichia-coli`, `biosites-cytoplasm`) have been fetched but not yet paired with a scene.

### How it is measured

The head of `measure.py` says what each quantity means. Two pictures cannot be aligned pixel by pixel (where the molecules sit is his arrangement), so what is measured is the way of drawing: the share of blank paper, how much line there is, the lightness and chroma of the lines, fine relief, the mean lightness and chroma of the subject, and the distance between dominant colours and the reference's. The command is above; it takes limn's pictures from `.cache/snapshots/<round>-<name>.png` (saved from the page's console with `limn.snap('<round>-<name>', 1200)`) and writes the side-by-side images to `out/`.

These numbers serve only to stop a change making things worse. **Whether it looks like his work is for the eye to say.** One of them, `flat`, is useless: watercolour has paper texture, so limn's flat fills come out "flatter", and it cannot tell better from worse.

### Baseline (g0, before any change)

The table is above. Side by side, the differences are these (the influenza pair is the cleanest, being the same subject cut the same way):

1. The **membrane** is a muddy olive, with rings of tone on its inner wall; his is a very pale lavender (measured: L 0.89, C 0.035).
2. The **lines** are thick and pure black (chroma 0.02–0.03); his are a deeper shade of the fill (chroma 0.06–0.09, lightness 0.31–0.48).
3. Every chain of **one kind of molecule** has a different colour, like patchwork; his copies of a molecule are nearly one colour.
4. **Glycans** are grey-green dots that look like dirt; he paints them as small lobes of the protein's own hue on its rim.
5. **Shapes** are lumps of atoms; his are smooth outlines.
6. **Distance** fades towards grey-brown; his farther layer is the same colour a shade deeper (three layers of hemagglutinin from front to back have lightness 0.76, 0.60, 0.45 at unchanged chroma).
7. **The frame**: most of his paintings fill the sheet, against a crowded environment; ours is one object on white paper.
8. Our virion is empty inside: the model has no matrix protein or genome. That is decided by the data and is not changed.

### Round 1 (g1): line and colour

Changed: lines take a deeper shade of the fill beside them and are thinner; shadows between atoms are gone; distance darkens and enriches the fill instead of fading to a fog colour; the membrane is a pale lavender; the subject's hue moves to violet–magenta (h 290–336 in his three virus paintings); glycans take a lighter shade of the protein's hue; the hue step between neighbouring copies of one molecule drops from 9 degrees to 3; the paper is a little warm with a little grain. This applies to whole models and landscapes only; the Illustrate drawing of single molecules is untouched.

limn's numbers for this round are in the table above (the references' are in the baseline table).

- Line lightness rose from 0.22–0.29 to 0.41–0.49 and line chroma from 0.02–0.03 to 0.05–0.07, into his range (lightness 0.31–0.48, chroma 0.06–0.09).
- Dominant-colour distance: influenza 0.119→0.108, synapse 0.142→0.105, mycoplasma 0.226→0.128, closer; coronavirus 0.110→0.121, HIV 0.104→0.157, farther. Most of the area of those last two paintings is the surrounding plasma and mucus (yellows and greens); we draw no environment, so turning the subject violet moves it away from "the dominant colours of the whole painting", although the picture itself looks more like his. The colour distance is therefore unreliable for scenes without an environment.
- Zika is unchanged: it is loaded by PDB id and still drawn the Illustrate way.
- Still missing: shapes are still lumps (smoothing is round 2); a ring of broken lines on the inner edge of the membrane; composition and environment are untouched.

### Round 2 (g2): smooth shapes, and the painted drawing for single structures

- **"Rolling ball" smoothing** (`SMOOTH_FS` in `src/render/shaders.ts`): each sphere is drawn with a probe radius added, and the depth is then eroded with a ball of the same radius as structuring element. Together that is a closing of the height field: grooves between atoms are filled and outlines become smooth, while the shape and size of each molecule stay as they are. The probe radius is set in screen pixels (7 on a picture 1500 pixels wide), so a molecule becomes a smooth blob at the scale of a whole virion, and the effect fades by itself once zoomed in far enough for atoms to show.
- **Single structures** (those loaded by PDB id) take the painted drawing too: one flat colour per chain (carbons no longer a greyer shade), lines a deeper shade of the fill, and faint shadows. Nucleic acids are brightened to the yellow–orange measured on the ribonucleoprotein in his painting (h 59–81).
- **Switching**: the "Lines and shadows" panel has a new "Drawing" choice that goes back to Illustrate; `?style=illustrate` in the address does the same. The Illustrate drawing itself is untouched, and its comparison still stands at 2.80.

The numbers are in the table above.

- Fine relief (`bumps`; 0.70–0.94 in his paintings, 1.58 in the mycoplasma one): influenza 0.87→0.80, coronavirus 1.03→0.79, HIV 1.40→1.01, Zika 1.69→0.98, all into his range; the synapse is still at 2.8, since at that scale each molecule is only a few pixels and smoothing cannot help, which is for composition (zooming in) to solve.
- The Zika pair has changed now: a lavender capsid with pink glycans.
- `out/g2-nucleosome-before-after.jpg` shows the nucleosome before and after.
- A larger probe (9 pixels) was tried: rounder shapes, but the hemagglutinin spikes joined into one ring, so it went back to 7.
- Not yet right: neighbouring copies of one molecule join once smoothed, with only the line where ids differ to part them; a ring of broken lines remains on the inner edge of a cut membrane; small white holes appear in places (real gaps that get outlined); composition and environment are untouched.
