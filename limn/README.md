# limn

按 David S. Goodsell 的画法，从真实原子坐标生成分子与细胞插图。输入一个病毒、基因或机理，得到一张平涂色块、黑色勾线、按功能分色的科学图；画面由数据确定性渲染，模型只负责选结构和分配角色，不生成像素。

## 现在有什么

项目在建设中，按里程碑推进：

| | 内容 | 状态 |
|---|---|---|
| M0 | 风格研究：分析 12 张 Goodsell 原图，写成风格准则 | 完成，见 [docs/style-guide.md](docs/style-guide.md) |
| M1 | 渲染核心：移植 Illustrate 的描边、阴影算法到 WebGL2 | 完成，见 `src/render/`。尚未与原版 Illustrate 的输出逐像素对照 |
| M2 | 网页应用：旋转、调色、高分辨率导出 | 基本可用：按 PDB 编号载入、选组装体、改角色、调线条与阴影、导出 PNG |
| M3 | 主题解析：自由文本 → 真实结构（RCSB / UniProt / SIFTS / AlphaFold） | 未开始 |
| M4 | 看图精修：让模型看渲染结果、给反馈、迭代 | 未开始 |
| M5 | 细胞全景：按浓度自动排布的截面图 | 未开始 |

## 运行

```sh
bun install
bun run typecheck
bun run test
```

```sh
bun run dev:web               # http://127.0.0.1:5184/?id=2hhb
```

输入 4 位 PDB 编号载入结构。拖动旋转，滚轮缩放，Shift 拖动平移。试过的例子：`2hhb`（血红蛋白）、`6vxx`（新冠刺突蛋白）、`1m4x`（PBCV-1 病毒衣壳，1600 万原子）。

本地服务（主题解析、看图精修）要到 M3 才有，`bun run dev` 现在还不能用。

重做风格分析：

```sh
research/fetch_gallery.sh     # 下载原图到 research/gallery/（约 320 MB）
uv run --no-project --with numpy --with scipy --with pillow python -I research/analyze.py
```

结果写到 `research/out/`：`stats.json`（每张图的取色、色相区占比、明度与彩度范围、线宽）、预览图和色带图。

## 数据与参考图

- **结构数据**：运行时从 RCSB PDB（`models.rcsb.org`，CC0）按编号下载，不入库。
- **参考图**：Goodsell 的原图来自 RCSB PDB-101 的 [Goodsell Gallery](https://pdb101.rcsb.org/sci-art/goodsell-gallery) 和 [Molecule of the Month](https://pdb101.rcsb.org/motm)，许可为 CC-BY-4.0。本仓库**不包含这些图片**，只包含从中测得的统计数字（写在风格准则里）；`research/gallery/` 和 `research/out/` 已被忽略，用上面的脚本重新获取。
- **算法来源**：描边与阴影的做法出自 Goodsell 的 [Illustrate](https://github.com/ccsb-scripps/Illustrate)（Apache-2.0；Goodsell, Autin & Olson, *Structure* 2019）。limn 是重新实现，不包含其源码。
- **文件解析**：用 [Mol\*](https://github.com/molstar/molstar)（MIT）的 CIF 解析模块。

本项目与 David S. Goodsell、Scripps Research、RCSB PDB 无隶属关系，风格是致敬。
