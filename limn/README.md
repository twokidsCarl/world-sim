# limn

按 David S. Goodsell 的画法，从真实原子坐标生成分子与细胞插图。输入一个病毒、基因或机理，得到一张平涂色块、黑色勾线、按功能分色的科学图；画面由数据确定性渲染，模型只负责选结构和分配角色，不生成像素。

## 现在有什么

| | 内容 | 状态 |
|---|---|---|
| M0 | 风格研究：分析 12 张 Goodsell 原图，写成风格准则 | 完成，见 [docs/style-guide.md](docs/style-guide.md) |
| M1 | 渲染核心：移植 Illustrate 的描边、阴影算法到 WebGL2 | 完成，见 `src/render/`。尚未与原版 Illustrate 的输出逐像素对照 |
| M2 | 网页应用：旋转、调色、高分辨率导出 | 完成 |
| M3 | 主题解析：自由文本 → 真实结构 | 完成，见 `server/resolve.ts` |
| M4 | 看图精修：让模型看渲染结果、给反馈、迭代 | 完成，见 `server/critique.ts`、`src/refine/` |
| M5 | 细胞全景：按浓度自动排布的截面图 | 未开始 |

## 运行

```sh
bun install
bun run dev        # 网页 http://127.0.0.1:5184 ，本地服务 127.0.0.1:5185
bun run test
bun run typecheck
```

两种用法：

- **按主题**：输入“CRISPR-Cas9 切割 DNA”“新冠刺突蛋白结合 ACE2”“TP53”这样的话。需要本机装有并登录了 [Claude Code](https://claude.com/claude-code)（用 `claude -p` 调用，不需要 API key）。一次解析约半分钟。
- **按 PDB 编号**：直接输入 4 位编号，不需要 `claude`。例如 `2hhb`（血红蛋白）、`6vxx`（新冠刺突蛋白）、`1m4x`（PBCV-1 病毒衣壳，1600 万原子）。

拖动旋转，滚轮缩放，Shift 拖动平移。

可调的环境变量：`LIMN_MODEL`（默认 `sonnet`）、`LIMN_CLAUDE_BIN`、`LIMN_CACHE`、`LIMN_PORT`。

## 它怎么保证画的是真的

1. **模型不出像素，也不出坐标。** 画面完全由 PDB 的原子坐标确定性渲染。
2. **模型不能编造结构编号。** 解析分三步：模型说要找什么 → 代码去 RCSB、UniProt、PDBe 查 → 模型只能在查回来的候选里选（选项是候选编号的枚举，不在其中的一律丢弃）。模型凭记忆提到的编号只当作检索线索，要经 RCSB 确认存在并取回真实的描述后才会成为候选。
3. **看图精修只能改呈现。** 评审能做的操作是一份白名单：转视角、缩放、改颜色角色、调线条和阴影。换结构、动坐标不在其中，见 `src/refine/edits.ts`。
4. **说明出处和局限。** 界面列出每个面板的 PDB 编号、实验方法、分辨率、年份和选它的理由；AlphaFold 预测模型会明确标注，低置信度区域不画。

多个面板的机理图里，各面板比例相同，并按共同的蛋白链叠合到同一朝向。

## 重做风格分析

```sh
research/fetch_gallery.sh     # 下载原图到 research/gallery/（约 320 MB）
uv run --no-project --with numpy --with scipy --with pillow python -I research/analyze.py
```

结果写到 `research/out/`：`stats.json`（每张图的取色、色相区占比、明度与彩度范围、线宽）、预览图和色带图。

重建“每月分子”对照表（`data/motm.json`，只存文章标题和 PDB 编号）：`bun server/tools/scrape_motm.ts`。

## 数据与参考图

- **结构数据**：运行时从 RCSB PDB（`models.rcsb.org`，CC0）按编号下载，不入库。检索还用到 UniProt、PDBe SIFTS 和 AlphaFold DB 的公开接口。
- **`data/motm.json`**：PDB-101 “Molecule of the Month” 各篇文章的标题和文中提到的 PDB 编号，用来优先选经过人工挑选的代表性结构。不含文章正文和图片。
- **参考图**：Goodsell 的原图来自 RCSB PDB-101 的 [Goodsell Gallery](https://pdb101.rcsb.org/sci-art/goodsell-gallery) 和 [Molecule of the Month](https://pdb101.rcsb.org/motm)，许可为 CC-BY-4.0。本仓库**不包含这些图片**，只包含从中测得的统计数字（写在风格准则里）；`research/gallery/` 和 `research/out/` 已被忽略，用上面的脚本重新获取。
- **算法来源**：描边与阴影的做法出自 Goodsell 的 [Illustrate](https://github.com/ccsb-scripps/Illustrate)（Apache-2.0；Goodsell, Autin & Olson, *Structure* 2019）。limn 是重新实现，不包含其源码。
- **文件解析**：用 [Mol\*](https://github.com/molstar/molstar)（MIT）的 CIF 解析模块。

本项目与 David S. Goodsell、Scripps Research、RCSB PDB 无隶属关系，风格是致敬。
