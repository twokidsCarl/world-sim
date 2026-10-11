# Goodsell 的图：手里有什么 / Goodsell's pictures: what is in hand

## 中文

用 `fetch.py` 取的，可以重跑。许可在取之前逐个来源核实过，原话记在 `fetch.py` 开头。

| 来源 | 数量 | 许可 | 在哪 | 我看过多少 |
|---|---|---|---|---|
| PDB-101 图集的水彩全景 | 50 幅 | CC BY 4.0 | `gallery/`（800 像素，入库） | 全部看过缩略图；6 幅逐张对照过 |
| 上面其中 6 幅的原尺寸 TIF | 6 幅，共 154 MB | CC BY 4.0 | 本机 `.cache/goodsell/tif/`（不入库） | 还没用来对细节 |
| “每月分子”的插图 | 322 篇，743 张（jpg 519, gif 185, png 39） | CC BY 4.0（文章的文字有版权，没有存） | 索引 `motm/index.json` 入库；图在本机 `.cache/goodsell/motm/`（141 MB，不入库）；对照用的 7 张在 `motm/refs/` | 16 张总览里看了 3 张，约 125 张 |
| 维基共享资源 | 搜到 72 个，收了 33 个 | CC BY 4.0 17, CC BY-SA 4.0 11, CC BY 3.0 2, Public domain 2, CC BY-SA 3.0 1 | 索引 `commons/index.json` 入库；图在本机 `.cache/goodsell/commons/`（不入库） | 没有逐张看；多数和上面两类重复 |

没收的：共享资源上 39 个文件，作者一栏不是他（多数是别人用他的软件或风格画的、标成公有领域的图）。他书里的图是出版社的版权，没有取。他在 Scripps 的个人页面这次没有细看。

### 水彩全景（50 幅），按主题


**病毒 / Viruses**（16）

- `bacteriophage-t4-infection`：Bacteriophage T4 Infection
- `coronavirus`：Coronavirus ← limn 对照 / paired with limn: `/?model=sars-cov-2-virion`
- `coronavirus-life-cycle`：Coronavirus Life Cycle
- `ebola-virus`：Ebola Virus
- `hiv-in-blood-plasma`：HIV in Blood Plasma ← limn 对照 / paired with limn: `/?model=hiv-virion-petworld`
- `hiv-infected-cell`：HIV-Infected Cell
- `hiv-vaccine`：HIV Vaccine
- `influenza-vaccine`：Influenza Vaccine
- `influenza-virus`：Influenza Virus ← limn 对照 / paired with limn: `/?model=influenza-virion`
- `measles-virus-proteins`：Measles Virus Proteins
- `phage-based-covid-19-vaccine`：Phage-based COVID-19 Vaccine
- `poliovirus-neutralization`：Poliovirus Neutralization
- `sars-cov-2-and-neutralizing-antibodies`：SARS-CoV-2 and Neutralizing Antibodies
- `sars-cov-2-fusion`：SARS-CoV-2 Fusion
- `sars-cov-2-mrna-vaccine`：SARS-CoV-2 mRNA Vaccine
- `zika-virus`：Zika Virus ← limn 对照 / paired with limn: `/?model=zika-virus`

**细菌和最小细胞 / Bacteria and minimal cells**（8）

- `abiogenesis`：Abiogenesis
- `caulobacter-polar-microdomain`：Caulobacter Polar Microdomain
- `escherichia-coli`：Escherichia coli
- `escherichia-coli-bacterium`：Escherichia coli Bacterium
- `jcvi-syn3a-minimal-cell`：JCVI-syn3A Minimal Cell ← limn 对照 / paired with limn: `/?model=syn3a-envelope`
- `last-universal-common-ancestor`：Last Universal Common Ancestor
- `model-of-a-mycoplasma-cell`：Model of a Mycoplasma Cell
- `mycoplasma-mycoides`：Mycoplasma mycoides ← limn 对照 / paired with limn: `/?model=mycoplasma-genitalium`

**神经和免疫 / Nerve and immunity**（3）

- `excitatory-and-inhibitory-synapses`：Excitatory and Inhibitory Synapses ← limn 对照 / paired with limn: `/?model=presynaptic-bouton`
- `immunological-synapse`：Immunological Synapse
- `myelin`：Myelin

**血液和细胞外 / Blood and outside the cell**（9）

- `biosites-basement-membrane`：Biosites: Basement Membrane
- `biosites-blood-plasma`：Biosites: Blood Plasma
- `biosites-red-blood-cell`：Biosites: Red Blood Cell
- `blood`：Blood
- `casein-micelle-and-fat-globule-in-milk`：Casein Micelle and Fat Globule in Milk
- `collagen-and-extracellular-matrix`：Collagen and Extracellular Matrix
- `red-blood-cell-cytoskeleton`：Red Blood Cell Cytoskeleton
- `respiratory-droplet`：Respiratory Droplet
- `vascular-endothelial-growth-factor-vegf-signaling`：Vascular Endothelial Growth Factor (VegF) Signaling

**细胞内部 / Inside the cell**（14）

- `autophagy`：Autophagy
- `biosites-cytoplasm`：Biosites: Cytoplasm
- `biosites-muscle`：Biosites: Muscle
- `biosites-nucleus`：Biosites: Nucleus
- `cellulose-synthase`：Cellulose Synthase
- `chloroplast`：Chloroplast
- `cytoskeleton`：CytoSkeleton
- `insulin-action`：Insulin Action
- `insulin-release`：Insulin Release
- `kinetochore`：Kinetochore
- `lipid-droplets`：Lipid Droplets
- `myoglobin-in-a-whale-muscle-cell`：Myoglobin in a Whale Muscle Cell
- `reca-and-dna`：RecA and DNA
- `transfer-rna-and-gag-protein`：Transfer RNA and Gag Protein

### “每月分子”

322 篇，从 2000 年 1 月的肌红蛋白到最近一篇“Celebrating 55 Years of the PDB”。看了早期、中期、最近各一张总览，他画单个分子的画法前后变了三次：

1. **2000 年前后**：白色的原子球，氧红氮蓝，黑色轮廓线。这就是 Illustrate 程序的默认样子。
2. **2005–2015 年前后**：一条链一个淡彩色（桃、淡紫、淡绿），黑色轮廓线，原子的细节还在。
3. **2015 年以后**：一条链一个饱和的颜色，同一种分子的各条链用同色的深浅来分；**没有黑线**，轮廓是填色的深一号；远处的原子压暗；膜画成一条灰带子；常带文字标注。

limn 的 Illustrate 画法对的是第 2 种。把 limn 的核小体、新冠刺突和他最近的图并排看（`out/M1-*.jpg`），差别主要是第 3 种的那几条：我们有黑线，他没有；他的 DNA 是彩色的骨架加白色的碱基，我们整条一个颜色。

limn 现成卡片里能配上“每月分子”的：核小体（第 7、314 篇）、抗体（第 21 篇）、血红蛋白（第 41、257 篇）、新冠刺突（第 246 篇）、核糖体（第 121 篇）、寨卡病毒（第 197 篇）。配对写在 `pairs.json`，`drawing` 为 `illustrate` 的那几条。

## English

Fetched by `fetch.py`, which can be rerun. Licences were checked source by source before fetching, and the wording found is quoted at the head of `fetch.py`.

- **Watercolour landscapes of the PDB-101 gallery**: 50 paintings, CC BY 4.0, in `gallery/` (800 pixels, in the repository). All seen as thumbnails; six compared one by one.
- **Full-size TIFs of those six**: 154 MB in all, CC BY 4.0, on this machine in `.cache/goodsell/tif/` (not in git). Not yet used to check details.
- **Molecule of the Month illustrations**: 322 articles, 743 pictures, CC BY 4.0 (the articles' text is copyrighted and none is kept). The index `motm/index.json` is in the repository; the pictures are on this machine in `.cache/goodsell/motm/` (141 MB, not in git); the seven used in pairs are in `motm/refs/`. Three of sixteen contact sheets were looked at, about 125 pictures.
- **Wikimedia Commons**: 72 found, 33 taken (CC BY 4.0 17, CC BY-SA 4.0 11, CC BY 3.0 2, Public domain 2, CC BY-SA 3.0 1). The index `commons/index.json` is in the repository; the pictures are on this machine in `.cache/goodsell/commons/` (not in git). Not looked at one by one; most repeat the two kinds above.

Not taken: 39 Commons files whose author field is not his (mostly pictures others made with his software or in his manner, marked public domain). Pictures from his books belong to the publishers and were not fetched. His personal page at Scripps was not gone through this time.

The paintings by theme are listed above, with those paired with a limn scene marked.

**Molecule of the Month.** 322 articles, from myoglobin in January 2000 to the latest, "Celebrating 55 Years of the PDB". Going by one contact sheet each from the early, middle and recent years, his way of drawing a single molecule changed three times:

1. **Around 2000**: white atom spheres with red oxygen and blue nitrogen, outlined in black. This is what the Illustrate program does by default.
2. **About 2005–2015**: one pastel colour per chain (peach, lavender, pale green), black outlines, atomic detail still there.
3. **Since about 2015**: one saturated colour per chain, with copies of one molecule told apart by shades of the same hue; **no black lines**, the outline being a deeper shade of the fill; atoms farther away darkened; membranes drawn as a grey band; often with text labels.

limn's Illustrate drawing matches the second. With limn's nucleosome and coronavirus spike next to his recent pictures (`out/M1-*.jpg`), the differences are mostly those of the third: we have black lines and he has none; his DNA is a coloured backbone with white bases, where ours is one colour throughout.

Of limn's ready-made cards, these can be paired with Molecule of the Month: the nucleosome (articles 7 and 314), antibodies (21), hemoglobin (41 and 257), the coronavirus spike (246), the ribosome (121) and Zika virus (197). The pairs are in `pairs.json`, those whose `drawing` is `illustrate`.
