# 给 AI Agent：怎么用这个仓库里的东西 / For AI agents: how to use what is in this repository

这份文件讲的是**怎么用**——查数据、跑模拟、搜想法池。要**往仓库里提交改动**，看 [`CLAUDE.md`](CLAUDE.md)。

This file is about **using** what is here — querying data, running simulations, searching the
idea pool. To **commit changes to the repository**, read [`CLAUDE.md`](CLAUDE.md).

## 这里有什么 / What is here

- **模拟项目 / Simulation projects**：`strata`（物质）、`limn`（分子与细胞）、`soma`（人体）、`mindloop`（两个人互猜）、`polis`（社会）。每个挂在同一条尺度阶梯的一层上。
  Each sits on one rung of a single ladder of scales.
- **整理过的数据 / Curated data**：解剖部件和它们之间的关系、社会传播的理论与史实、带出处的互猜案例、分子模型的目录……每个数据集都写明许可和来历。
  Anatomical parts and their relations, theories and historical facts of social spread, sourced cases of mutual guessing, a catalogue of molecular models and more; every dataset states its licence and provenance.
- **想法池 / The idea pool**：一百多条可以直接交给 Agent 开工的短 idea，带位置和血缘。
  Over a hundred short ideas that can be handed to an agent to build, each with a position and a lineage.

完整的、随代码更新的清单在 [`llms.txt`](llms.txt)；服务运行时是 `/llms.txt` 和 `/llms-full.txt`（后者带每个数据集的字段和样例、每个计算的输入和例子）。

The complete list, kept in step with the code, is [`llms.txt`](llms.txt); when the service runs
it is at `/llms.txt` and `/llms-full.txt` (the latter with every dataset's fields and a sample,
and every computation's input and an example).

## 三种接法 / Three ways in

先把服务起起来（一个命令，它同时托管所有模拟）：

Start the service first (one command; it also hosts every simulation):

```sh
cd idea-loom && uv run idea-loom serve      # http://localhost:8767
```

**1. MCP。** 在这个仓库里打开的 Claude Code 会话已经配好了（根目录的 `.mcp.json`）。别的客户端：

**1. MCP.** A Claude Code session opened in this repository is already configured (the
`.mcp.json` at the root). For other clients:

```sh
uv run --project idea-loom idea-loom mcp                      # 标准输入输出 / stdio
# 或者远程 / or remote (Streamable HTTP):  POST http://localhost:8767/mcp
```

十个工具：`catalog`（先调它）、`search_ideas`、`get_idea`、`describe_dataset`、`query_dataset`、`describe_capability`、`run`、`list_cards`、`propose_idea`、`propose_wish`。

Ten tools: `catalog` (call it first), `search_ideas`, `get_idea`, `describe_dataset`,
`query_dataset`, `describe_capability`, `run`, `list_cards`, `propose_idea`, `propose_wish`.

**2. HTTP。** `/api/v1` 是稳定的、有版本的一层，只收发 JSON：

**2. HTTP.** `/api/v1` is the stable, versioned layer; JSON in, JSON out:

```sh
curl localhost:8767/api/v1/catalog
curl "localhost:8767/api/v1/datasets/soma/parts?q=biceps+brachii&limit=3"
curl "localhost:8767/api/v1/datasets/soma/relations?key=FMA37686&where=kind=innervatedBy"
curl -X POST localhost:8767/api/v1/run/mindloop/compute \
     -H 'content-type: application/json' -d '{"case_id":"kongchengji","depth_a":3,"depth_b":3}'
curl "localhost:8767/api/v1/ideas?q=rumour"
```

**3. 只读文档。** 不调用任何东西，读 `llms.txt` 就知道有什么。

**3. Documents only.** Without calling anything, `llms.txt` says what exists.

## 用的时候要知道 / What to know when using it

- **读和算不要密钥。** 提议（`propose_idea`、`propose_wish`）要一个带 `propose` 权限的令牌，用 `Authorization: Bearer wsk_…` 带上；提议只进主人"待过目"的队列，不会直接生效。
  **Reading and computing need no key.** Proposing needs a token with the `propose` scope, sent as `Authorization: Bearer wsk_…`; a proposal only enters the owner's review queue and takes no effect by itself.
- **这里没有任何东西会替你调用语言模型。** 给出去的都是数据和确定性的计算。
  **Nothing here calls a language model for you.** What is offered is data and deterministic computation.
- **每次返回数据都带 `licence` 和 `provenance`，请看。** 有些数据是机器汇集、没有经人逐条核对的（比如 soma 的关系三元组全部标着 `unreviewed`）；引用时照实说。
  **Every data reply carries `licence` and `provenance`; read them.** Some data was gathered by machine and not checked record by record (soma's relation triples are all marked `unreviewed`, for instance); say so when you cite it.
- **错误是 `{"error": …, "hint": …}`。** `hint` 说怎么把请求改对：有哪些字段、一个能跑的例子。
  **Errors are `{"error": …, "hint": …}`.** The hint says how to fix the request: which fields exist, an example that works.
- **计算是有界的。** 输入按声明的 JSON Schema 校验；有时间和返回大小的上限；结果里写明是 `main` 上哪个版本算的。
  **Computations are bounded.** Inputs are validated against the declared JSON Schema; time and reply size are capped; the result states which version on `main` computed it.
- **卡片的地址是给人看的。** `list_cards` 给出的 URL 要在浏览器里打开；要数字就用 `run`，要让人亲眼看就给卡片的地址。
  **Card URLs are for people.** The URLs from `list_cards` open in a browser; use `run` for numbers and a card URL to let a person watch.

## 一个项目怎么把自己接出来 / How a project offers itself

在它的 `sim.json` 里加一节 `agent`，写明数据集和计算；文档、`/api/v1` 和 MCP 的工具都从那一节生成。约定见 [`CLAUDE.md`](CLAUDE.md) 的"Agent 约定"。

It adds an `agent` section to its `sim.json` stating its datasets and computations; the
documents, `/api/v1` and the MCP tools are all generated from that section. The contract is
under "the agent contract" in [`CLAUDE.md`](CLAUDE.md).
