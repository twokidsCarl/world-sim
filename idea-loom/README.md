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

- **玩 / Play**：单列的卡片流，一屏一张，一张卡是某个模拟的一个可以直达的场景。可以直接在里面玩，也可以切到下一张（按钮、上下键或 j / k、在卡片两侧的空白处滚动）。只有当前这张卡在运行，划走就卸载。可以收藏、重来、在新窗口打开完整版、带着这张卡问小助手。
  A single-column feed, one card per screen; a card is one directly reachable scenario of
  a simulation. Play it in place or move to the next (buttons, arrow keys or j / k, or
  scrolling in the margins beside the card). Only the current card runs and it is
  unmounted when you move on. Like it, restart it, open the full UI in a new window, or
  ask the assistant with the card attached.

  推荐顺序是写明的打分：没看过的排前面；你收藏过同一条 idea（或同一层）的往前提；进来几秒就划走、从没停下来看过的往后放；看得越多越靠后；相邻两张尽量不是同一个项目。每张卡可以点开看"为什么推这张"。每张卡看了多久记进操作轨迹，统计页把它算到那条 idea 的注意力上。
  The order is an explicit score: unseen cards first; cards of an idea (or a level) you
  liked move up; cards you left within seconds and never really watched move back; the
  more often seen, the further back; neighbours are kept from the same project where
  possible. Each card can show why it is where it is. Watch time goes into the action
  trail, and the statistics page counts it toward that idea's attention.
- **中 / EN**：界面可以在中文和英文之间切换（左下角）。idea、层、横线、内核有英文的就显示英文；后端给的自由文本（历史、愿望、方案、报错）保持原样。
  The UI switches between Chinese and English (bottom left). Ideas, levels, threads and
  kernels show their English where it exists; free text from the backend (history,
  wishes, plans, errors) stays as written.
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

- **小助手 / Assistant**：右侧的边栏，随时可以问。每次提问自动带上当前页面的文字提纲、最近的操作和许愿池里已有的愿望；在 idea 页时带上那条 idea。它能读仓库、读本工具的接口、记愿望、提议 idea（进候选）、在页面上圈出元素；它不能改任何东西。窗口窄时变成浮层。
  A sidebar on the right, always there to ask. Each question carries a text outline of
  the current page, your recent actions and the existing wishes, plus the idea when you
  are on an idea page. It can read the repository and this tool's API, record wishes,
  propose ideas (into the candidates) and point at elements on the page; it cannot
  change anything. On a narrow window it floats.
- **许愿池 / Wish pool**：对这个工具本身的改进愿望。愿望只从和小助手的对话里来，同一个问题再遇到是给原来那条加一次。未处理时可以改写和撤销，采纳之后冻结。
  Wishes for improving this tool itself. They only come out of conversations with the
  assistant, and meeting the same problem again bumps the existing wish. A wish can be
  edited or withdrawn while open and is frozen once accepted.
- **观察 / Watching**：记下你换页、点了什么、每页停留多久（只算窗口在前台且最近有操作的时间），存在本机 `runs/trail.jsonl`，不进 git，不记输入的文字。来回跳、连续报错、原地反复点时，小助手的按钮亮一个点问要不要解释这一页，同一页只问一次。
  Records navigation, clicks and the dwell time on each page (foreground time with
  recent activity only) in `runs/trail.jsonl` on this machine, never in git and never
  including typed text. When you bounce between two pages, hit repeated errors or click
  around in place, the assistant button lights a dot offering to explain the page, once
  per page.

- **开发 / Work**：把一条 idea 交给一个子项目（写一个新目录名就是开新项目），任务看板分待开工、方案待批、进行中、已合并。每个子项目的进度读自 GitHub：按 PR 标题冒号前的项目名归类。idea 页上能看到它对应的项目和任务；子项目的开发服务在跑时，可以直接在 idea 页里嵌着用。
  Hand an idea to a subproject (a new directory name starts a new one); the board has
  todo, plan ready, running and merged. Each subproject's progress is read from GitHub,
  assigning PRs by the project name before the colon in the title. The idea page shows
  its projects and tasks, and embeds a subproject's UI when its dev server is running.
- **统计 / Statistics**：
  - 每个项目：模型输出的 token、Claude Code 在跑的时间、合并的 PR、代码行数，以及每行代码、每个 PR 用了多少 token。
    Per project: model output tokens, Claude Code running time, merged PRs, lines of
    code, and tokens per line and per PR.
  - Claude Code 的每次运行：每个会话跑了多久、说了几句话、调了多少次工具、输出多少，中间停了几次、最后停在什么时候。两条记录相隔五分钟以上算停下。
    Every Claude Code run: how long each session ran, how many prompts and tool calls,
    how much output, how many times it stopped and when it last stopped. A gap of five
    minutes or more between two records counts as a stop.
  - 你的注意力：在每条 idea、每一格、每个页面上停了多久，哪些 idea 从没打开过，候选留下了多少。
    Your attention: time spent per idea, per cell and per page, which ideas were never
    opened, and how many candidates were kept.

  token 和运行情况读的是本机 `~/.claude/projects` 下属于这个仓库的会话记录，只在本机算，只显示汇总数字。从根目录启动的会话，大部分记录落在哪个子目录就归哪个；说不清的列为"未归属"，可以在 `data/sessions.json` 里按会话编号指定：`{"<会话编号>": "<项目目录>"}`。

  Tokens and runs come from the transcripts under `~/.claude/projects` that belong to
  this repository; they are computed on this machine and only aggregates are shown. A
  session started at the root is assigned to the subdirectory most of its records fall
  in; anything unclear is listed as unassigned and can be pinned in `data/sessions.json`
  as `{"<session id>": "<project dir>"}`.

- **作业 / Jobs**：在愿望页或任务上点"开工"，从界面触发 Claude Code。
  Press "start" on a wish or a task to trigger Claude Code from the UI.

  ```
  出方案中 → 方案待批 →（你批准）→ 执行中 → 测试 → PR → 已合并
                      ↘ 提意见重写 / 不做          ↘ 失败（可以还原）
  ```

  - 出方案时 Claude 只有读文件的工具，方案显示在界面里；你可以批准、提意见让它重写，或标为不做。批准之前不改任何文件。
    While planning, Claude only has read tools and the plan is shown in the UI; you can
    approve it, send feedback for a rewrite, or decline. Nothing is changed before approval.
  - 批准后另起一次：它只能改这次作业所属的目录（愿望是 `idea-loom/`，任务是那个子项目的目录），可以跑该目录的测试命令，不能运行 git 和 gh。没有明确允许的操作一律被拒绝。
    After approval a second run starts: it may only edit the job's directory
    (`idea-loom/` for a wish, the subproject's directory for a task) and run that
    directory's test commands, never git or gh. Anything not explicitly allowed is denied.
  - 它结束后由程序自己：把测试重跑一遍 → 调用 `tools/pr.sh`（只提交这个目录）→ 合并后把愿望标为已做完、任务标为已合并。
    When it finishes the runner itself re-runs the tests, calls `tools/pr.sh` (which
    submits this directory only), and after the merge marks the wish done or the task merged.
  - 以程序重跑的测试为准，不以 Claude 自己说"做完了"为准。测试没过会把输出交回给它修，最多两轮。它被拒绝的操作会记下来显示在作业的"经过"里。
    The tests re-run by the runner decide the outcome, not the agent's own "done". Failing
    output is handed back to it for repair, twice at most. Operations it was denied are
    recorded and shown in the job's log.
  - 失败的作业如果已经改了文件，可以点"接着做"直接从跑测试走到开 PR，不用重来；也可以一键还原。
    A failed job that already changed files can be continued from the tests to the PR
    without starting over, or reverted in one click.
  - 同一个目录同时只跑一个作业。开工前该目录的代码必须没有未提交的改动，这样失败或取消后可以一键还原。
    One job per directory at a time. The directory's code must have no uncommitted changes
    before a job starts, so a failed or cancelled job can be reverted with one click.
  - 每个阶段在独立的进程里跑，状态写在 `runs/jobs/` 下，后端重启不影响它。
    Each phase runs in its own process with its state under `runs/jobs/`, unaffected by a
    backend restart.

  已知的边界：目录限制管的是 Claude 的写文件工具（用真实 CLI 验证过），而且 PR 只包含这个目录。但测试命令会执行这个目录里的代码，那些代码在技术上能写到本机的别处；工作目录是多个会话共用的，别的目录随时有人在改，所以程序没法靠比较文件变化来发现这种情况。PR 合并前没有人工审查——你审的是方案。

  A known limit: the directory restriction applies to Claude's file-writing tools (checked
  against the real CLI), and the PR only ever contains that directory. But the test
  commands execute code from that directory, which could technically write elsewhere on
  this machine; the working tree is shared and other directories change all the time, so
  the runner cannot detect that by comparing files. No human reviews the PR before it
  merges — what you review is the plan.
- **推进 / Advance**：在开发页对一个子项目点"推进"，模型读它的 README 和最近的 PR，提议下一个里程碑，建成一个待开工的任务。
  Press "advance" on a subproject and the model reads its README and recent PRs, proposes
  the next milestone and files it as a todo task.
- **回看 / Review**：在许愿池页点"回看我最近的使用"，模型读一遍操作轨迹，提出最多三条愿望，由你决定记不记。
  Press "review my recent use" on the wish page and the model reads the action trail and
  proposes up to three wishes for you to keep or drop.

## 运行 / Run

需要 [uv](https://docs.astral.sh/uv/) 和 [bun](https://bun.sh)；用模型的功能还需要本机装有并登录了 `claude` 命令行（不需要 API key）。

Needs [uv](https://docs.astral.sh/uv/) and [bun](https://bun.sh); the model-backed
features also need the `claude` CLI installed and logged in on this machine (no API key).

日常使用只要一个进程 / For everyday use, one process:

```sh
uv run idea-loom build-ui     # 第一次，或者界面的代码变了之后 / the first time, or after the UI code changes
uv run idea-loom serve        # 然后打开 / then open  http://localhost:8767
```

这一个进程同时托管所有模拟，见下面"统一入口"。开发 idea-loom 自己时，另开一个终端跑 `cd web && bun install && bun run dev`（http://localhost:5187，带热更新，接口转给 8767）。

That one process also hosts every simulation; see "the single entry point" below. When
developing idea-loom itself, run `cd web && bun install && bun run dev` in a second
terminal (http://localhost:5187, with hot reload, proxying the API to 8767).

## 统一入口 / The single entry point

各子项目开发时用自己的服务器和端口；使用时不用启动它们，idea-loom 托管全部。

Subprojects use their own servers and ports while being developed; for use none of them
needs starting, because idea-loom hosts them all.

- **每个模拟一个子域名 / One subdomain per simulation**：`http://<项目>.localhost:8767/`。它是独立的源：有自己的本地存储，脚本碰不到 idea-loom 的页面；项目里从根开始的路径（`/api/…`、`/assets/…`）不用改。
  A separate origin: its own local storage, no script access to idea-loom's pages, and
  the project's root-relative paths work unchanged.
- **跑的是 main 上的版本 / It runs what is on main**：对每个项目，从 `origin/main` 取出它的目录（不碰工作目录），在 `runs/play/<项目>/` 下构建。版本号是那个目录在 main 上的 tree 哈希；合并了新 PR 就重新构建，构建期间和构建失败时继续用上一个成功的版本。
  Each project's directory is extracted from `origin/main` (the working tree is never
  touched) and built under `runs/play/<project>/`. The version is that directory's tree
  hash on main; a merged PR triggers a rebuild, and the last good build stays in use
  while a new one builds or if it fails.
- **后端按需启动 / Backends start on demand**：需要后端的项目，第一次访问它的 `/api/*` 时在一个空闲端口上启动（用那个项目自己的环境），请求转发过去，十分钟没人用就停掉。
  A project's backend is started on a free port (in that project's own environment) the
  first time its `/api/*` is requested, proxied to, and stopped after ten idle minutes.
- **来源检查 / Origin check**：idea-loom 自己的接口拒绝来自模拟源的请求，模拟页面里的脚本调不了它。
  idea-loom's own API refuses requests from a simulation's origin.
- **名片 / Card files**：每个项目怎么托管、有哪些卡片，写在它根目录的 `sim.json`（格式和各项目要遵守的嵌入约定见根目录 `CLAUDE.md`）。项目还没提交 `sim.json` 时，用 `data/play/<项目>.json` 里的临时名片。
  How a project is hosted and which cards it offers is declared in the `sim.json` at its
  root (the format and the embed contract are in the root `CLAUDE.md`). Until a project
  commits one, the interim file `data/play/<project>.json` is used.

```sh
uv run idea-loom play status          # 每个模拟的构建状态 / build state of every simulation
uv run idea-loom play build [项目]     # 取 main 的快照并构建 / snapshot main and build
```

`.localhost` 的子域名只在本机有效。放到云端时，域名和进程的分工由几个环境变量决定（见 `src/idea_loom/config.py`），容器和反向代理的配置在仓库根目录的 [`deploy/`](../deploy)。

The `.localhost` subdomains only work on this machine. In the cloud the domain and the
split into processes are set by a few environment variables (see
`src/idea_loom/config.py`); the containers and the reverse proxy are configured under
[`deploy/`](../deploy) at the repository root.

本地不用登录，你就是主人。云端设了 `IDEA_LOOM_OWNER`（主人的 GitHub 用户名）之后用 GitHub 登录认人，分三档：游客能看能玩，登录的访客再加上记自己的观看和收藏，其余只有主人能做。哪个接口要什么身份集中写在 `src/idea_loom/auth.py`，没列出的默认只有主人能用。

Locally nobody signs in and you are the owner. In the cloud, once `IDEA_LOOM_OWNER` (the
owner's GitHub login) is set, GitHub sign-in tells people apart in three roles: a guest can
browse and play, a signed-in member can also record their own watching and likes, and
everything else is the owner's. Which role each route needs is written in one place,
`src/idea_loom/auth.py`; anything unlisted is owner-only.

环境变量（都可以不设）/ Environment (all optional)：`IDEA_LOOM_MODEL`（缺省 `sonnet`，生成、细化、翻译用 / default `sonnet`, for generate, refine, translate）、`IDEA_LOOM_ASSISTANT_MODEL`（小助手 / the assistant）、`IDEA_LOOM_JOB_MODEL`（作业 / jobs）。

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
| `data/wishes.jsonl` | 愿望的事件 / wish events |
| `data/tasks.jsonl` | 开发任务的事件 / development task events |
| `data/play/*.json` | 各项目的临时名片 / interim card files for the projects |

`runs/`（不进 git）里是模型的提议 `proposals.jsonl`、每次调用的用量 `llm.jsonl`、操作轨迹 `trail.jsonl`、小助手的对话 `assistant/` 和作业 `jobs/`。

`runs/` (not in git) holds the model's proposals in `proposals.jsonl`, the usage of
every call in `llm.jsonl`, the action trail in `trail.jsonl`, the assistant's
conversations under `assistant/` and the jobs under `jobs/`.

以上是本地的存法。设了 `IDEA_LOOM_DB`（云端）之后，`ideas`、`wishes`、`tasks`、`trail`、`proposals`、`llm` 这六条日志改存进一个 SQLite 文件的事件表，读写的接口不变（`store.py`）；仓库里的文件变成导出的记录。`uv run idea-loom db import` 把现有的文件并进数据库（可以反复做，不会重复），`db export <目录>` 导出成和原来逐字节相同的文件，`db status` 看每条日志有多少事件。

That is how things are stored locally. With `IDEA_LOOM_DB` set (the cloud), the six logs
`ideas`, `wishes`, `tasks`, `trail`, `proposals` and `llm` go into an event table in one
SQLite file instead, behind the same read and write interface (`store.py`), and the files
in the repository become an exported record. `uv run idea-loom db import` merges the
existing files into the database (repeatable, never duplicating), `db export <dir>` writes
files byte-identical to the originals, and `db status` shows how many events each log has.

愿望进 git，也就是公开的。如果不想公开，把 `data/wishes.jsonl` 移到 `runs/` 下并改 `wishes.py` 里的路径。

Wishes are in git and therefore public. To keep them private, move `data/wishes.jsonl`
under `runs/` and change the path in `wishes.py`.

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
uv run idea-loom db status          # 数据库存法时：每条日志有多少事件（另有 import、export）/ with the database: events per log (also import, export)
uv run idea-loom wishes list        # 许愿池（给处理愿望的 Claude Code 用）/ the wish pool, for a Claude Code session
uv run idea-loom wishes accept <id> # 另有 show、note、link、done、decline / also show, note, link, done, decline
cd web && bun run gen:types         # 重新生成前端类型 / regenerate the TS types
```

## 结构 / Layout

```
src/idea_loom/
  model.py      数据契约 / data contract
  store.py      只追加的事件日志：文件或数据库 / append-only event logs: files or the database
  ideas.py      折叠、血缘、覆盖表、内核计数 / fold, lineage, coverage, kernel counts
  markdown.py   读 IDEAS.md / parse IDEAS.md
  importer.py   从 git 历史导入 / import from git history
  render.py     生成 IDEAS.md 的三块 / render the generated blocks
  llm.py        claude -p 封装，带缓存和用量记录 / claude -p wrapper with cache and usage log
  ops.py        生成、细化、融合、归类、查重 / generate, refine, fuse, classify, dedupe
  prompts/      提示词 / prompts
  tasks.py      开发任务 / development tasks
  github.py     读合并请求 / read pull requests
  stats.py      统计 / statistics
  config.py     部署配置：域名、角色 / deployment configuration: domain, roles
  auth.py       登录与权限：三档身份、签名的会话、限流 / sign-in and roles: three roles, the signed session, rate limits
  cloud.py      云端启动：克隆仓库、第一次取数据 / cloud start-up: clone the repository, seed the data once
  play/         统一入口：名片、快照与构建、后端进程、按主机名分发 / the single entry point: card files, snapshots and builds, backend processes, routing by host
  jobs.py       作业：出方案、批准、执行、测试、PR / jobs: plan, approve, execute, test, PR
  review.py     回看操作轨迹 / review of the action trail
  wishes.py     许愿池 / the wish pool
  trail.py      操作轨迹 / the action trail
  assistant/    小助手：提示词、回合、事件流、工具服务 / the assistant: prompt, turns, event stream, tool server
  edits.py      手动改动，先检查再写事件 / manual changes, validated then appended
  sync.py       同步到仓库 / sync to the repository
  server.py     HTTP 接口 / HTTP API
  cli.py        命令行 / command line
web/            React + Vite + zustand
```
