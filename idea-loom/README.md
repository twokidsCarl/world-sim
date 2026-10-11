# idea-loom

world-sim 的想法池：生成、查看、归类、合并 idea，分配开发并跟踪进度。

The idea pool of world-sim: generate, browse, classify and merge ideas, hand them
to development and follow their progress.

它不是模拟，不占阶梯上的位置。它是 idea 的家：`data/` 里的事件日志是事实来源，根目录的
`IDEAS.md` 由它生成。

It is not a simulation and has no place on the ladder. It is where the ideas
live: the event log in `data/` is the source of truth, and the root `IDEAS.md` is
generated from it.

## 现在能做什么 / What works now

- **地图 / Map**：十层 × 五条横线的格子，每格有几条、是哪几条；纵线和两条支线；按内核看。
  The ten levels × five threads grid with what sits in each cell; the verticals
  and the two branches; a view by kernel.
- **想法池 / Pool**：按层、横线、内核、状态、子项目筛选，全文搜索。
  Filter by level, thread, kernel, status and subproject; full-text search.
- **idea 页 / Idea page**：正文（可以复制给 Claude）、位置、血缘、每一次改动的历史；改写、改横线和内核、并入另一条、丢弃、恢复。
  The text (ready to hand to Claude), its position, its lineage and the history of
  every change; rewrite it, change its threads and kernel, merge it into another,
  discard it, restore it.
- **血缘 / Lineage**：想法池一批一批长出来的过程，谁并入了谁。
  How the pool grew batch by batch, and what was merged into what.
- **手写一条 / Write one**：编号由层自动决定，用过的编号不复用。
  The id follows the level; used ids are never reused.
- **同步到仓库 / Sync**：重新生成 `IDEAS.md` 里的三块，用 `tools/pr.sh` 开一个 PR。
  Regenerates the three blocks of `IDEAS.md` and opens a PR through `tools/pr.sh`.

- **生成与候选 / Generate and candidates**：让模型为一个格子、一种内核，或从某一条出发写新的 idea；给还没归类的定位置；在一层或一种内核里查重。在 idea 页上细化，在想法池里勾选几条融合。模型给的都只是候选，接受之前想法池不变。
  Ask the model for new ideas for a cell, a kernel, or starting from an existing
  idea; classify the unclassified; look for duplicates within a level or kernel.
  Refine on the idea page; tick several ideas in the pool to fuse them. Everything
  the model returns is a candidate, and the pool does not change until you accept.

- **英文版 / English edition**：每条 idea 有英文译文（模型翻译，中文是原文；中文改写后英文标为过期，等重新翻译）。同步时同时生成 `IDEAS.md` 和 `IDEAS.en.md`。
  Every idea has an English translation (by a model; the Chinese is the original, and
  a rewrite marks the English stale until it is translated again). A sync regenerates
  both `IDEAS.md` and `IDEAS.en.md`.

还没有的（按顺序做）：右侧小助手和许愿池、开发任务与统计、从许愿池触发 Claude Code。

Not yet (in this order): the assistant sidebar and the wish pool, development tasks
and statistics, triggering Claude Code from the wish pool.

## 运行 / Run

需要 [uv](https://docs.astral.sh/uv/) 和 [bun](https://bun.sh)；用模型的功能还需要本机装有并登录了
`claude` 命令行（不需要 API key）。两个进程：

Needs [uv](https://docs.astral.sh/uv/) and [bun](https://bun.sh); the model-backed
features also need the `claude` CLI installed and logged in on this machine (no API
key). Two processes:

```sh
# 后端 / backend — http://127.0.0.1:8767
uv run idea-loom serve

# 界面 / UI — http://localhost:5187
cd web && bun install && bun run dev
```

## 测试 / Test

```sh
uv run pytest                       # 后端 / backend
cd web && bun run test && bun run typecheck
```

`tests/test_import.py` 是导入往返测试：从 `IDEAS.md` 的 git 历史导入再生成，结果必须和现在的
`IDEAS.md` 一致。它需要 world-sim 的 git 历史，没有时自动跳过。

`tests/test_import.py` is the import round trip: importing from the git history
of `IDEAS.md` and rendering again must give what `IDEAS.md` holds today. It needs
the world-sim git history and skips itself without it.

## 数据 / Data

| 文件 / File | 内容 / Content |
|---|---|
| `data/ideas.jsonl` | idea 的事件，只追加；当前状态由它折叠得出 / idea events, append-only; the current state is folded from them |
| `data/frame.json` | 层、横线、内核 / levels, threads, kernels |
| `data/projects.json` | 子项目和它们对应的层 / subprojects and their levels |

`runs/`（不进 git）里是模型的提议 `proposals.jsonl` 和每次调用的用量 `llm.jsonl`。

`runs/` (not in git) holds the model's proposals in `proposals.jsonl` and the usage of
every call in `llm.jsonl`.

事件有这几种 / Event kinds：`created`、`edited`、`moved`、`status`、`merged_into`、`discarded`、
`restored`、`noted`。编号永不复用，合并和丢弃的条目留在日志里。

Ids are never reused; merged and discarded entries stay in the log.

数据的来源是这个仓库自己：`uv run idea-loom import` 顺着 `IDEAS.md` 的提交历史把每条 idea
的来历还原成事件。没有第三方数据。

The data comes from this repository itself: `uv run idea-loom import` walks the
commit history of `IDEAS.md` and reconstructs each idea's history as events.
There is no third-party data.

## 命令 / Commands

```sh
uv run idea-loom status             # 现在有多少条 / how many ideas
uv run idea-loom render             # 输出 IDEAS.md 的三块 / print the generated blocks
uv run idea-loom render --write     # 写回 IDEAS.md / write them into IDEAS.md
uv run idea-loom translate          # 把还没有英文的译成英文 / translate what has no English yet
uv run idea-loom sync               # 生成并开 PR / regenerate and open a PR
uv run idea-loom import --force     # 重新导入 / re-import from git history
uv run idea-loom schema             # 数据契约的 JSON Schema / JSON Schema of the contract
cd web && bun run gen:types         # 重新生成前端类型 / regenerate the TS types
```

## 结构 / Layout

```
src/idea_loom/
  model.py      数据契约 / data contract
  store.py      只追加的 JSONL / append-only JSONL
  ideas.py      折叠、血缘、覆盖表、内核计数 / fold, lineage, coverage, kernel counts
  markdown.py   读 IDEAS.md / parse IDEAS.md
  importer.py   从 git 历史导入 / import from git history
  render.py     生成 IDEAS.md 的三块 / render the generated blocks
  llm.py        claude -p 封装，带缓存和用量记录 / claude -p wrapper with cache and usage log
  ops.py        生成、细化、融合、归类、查重 / generate, refine, fuse, classify, dedupe
  prompts/      提示词 / prompts
  edits.py      手动改动，先检查再写事件 / manual changes, validated then appended
  sync.py       同步到仓库 / sync to the repository
  server.py     HTTP 接口 / HTTP API
  cli.py        命令行 / command line
web/            React + Vite + zustand
```
