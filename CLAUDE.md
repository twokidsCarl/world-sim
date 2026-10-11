# world-sim

这是一个公开的单一仓库（`twokidsCarl/world-sim`），每个子目录是一个独立的模拟项目。多个 Claude 会话同时在这一个工作目录里工作，各管各的子目录。

## 提交：一律用 `tools/pr.sh`

```sh
tools/pr.sh "<项目>: <做了什么>" <项目目录>
```

- 所有改动都通过 PR 进入 `main`，PR 由 GitHub Actions 自动 squash 合并。`main` 受保护，不能直接推送。
- **不要在这个目录里 `git checkout`、`git switch`、`git stash`、`git commit`、`git add`。** 工作目录和暂存区是所有会话共用的，切分支会把别的会话的文件一起切走。`tools/pr.sh` 用临时 index 造提交，不碰这些。
- 只提交自己的项目目录。根目录的文件（`README.md`、`IDEAS.md`、`CLAUDE.md`、`tools/`、`.github/`）改动要单独开 PR。
- 一个 PR 做一件事，做完一个能说清楚的单元就提交，不要攒。标题以项目名开头。
- 提交信息的正文用环境变量 `COMMIT_BODY` 传入，PR 描述用 `PR_BODY`。
- 脚本报"还没有合并"时，用 `gh pr checks <url>` 看原因。通常是和刚合并的改动冲突，重新运行脚本即可（它每次都基于最新的 `origin/main`）。

## 中英双语

进 git 的内容都要有中文和英文两个版本：

- **文档**（README 等）：同一个文件里中文在前、英文在后，或者成对的两个文件。
- **PR**：标题写成 `<项目>: 中文 / English`；描述里先中文一节，再英文一节。提交信息的正文同样。
- **代码注释和文档字符串**：中文一行，英文一行（短的可以写在同一行，用 ` / ` 隔开）。
- **PR 和 issue 里的评论**：同上。

Everything that goes into git is written in both Chinese and English: documentation,
PR titles and descriptions, commit message bodies, code comments and docstrings, and
PR or issue comments. Chinese first, then English.

已有的内容不必一次补齐，改到哪个文件就把哪个文件补上。

Existing content need not be converted in one go; bring a file up to date when you
next touch it.

## 仓库是公开的

提交前确认：

- 没有密钥、token、个人信息、本机绝对路径。
- 没有超过 50MB 的文件（脚本会拒绝）。原始数据、缓存、运行输出不提交，见根目录 `.gitignore`；大的生成物写清楚怎么重新生成。
- 第三方数据和素材注明来源和许可，许可不允许再分发的不提交。

## 子项目原来的独立仓库

并入之前有自己 `.git` 的项目，把它改名保留在本地：

```sh
mv <项目>/.git <项目>/.git-nested
```

`.git-nested/` 已被忽略，旧历史不会丢，也不会被提交。不改名的话 `tools/pr.sh` 会拒绝，因为那会被当成嵌套仓库。

## 统一入口与嵌入约定

**开发时**每个子项目照旧用自己的开发服务器和端口。**使用时**不用启动它们：`idea-loom` 一个进程托管所有模拟。

```sh
cd idea-loom && uv run idea-loom build-ui && uv run idea-loom serve    # 然后打开 http://localhost:8767
```

- 每个模拟在自己的子域名下：`http://<项目>.localhost:8767/`。它是独立的源，所以项目里写的 `/api/...`、`/assets/...` 这些从根开始的路径照常能用。
- 托管的是**已经合并进 `main` 的版本**：idea-loom 取 `origin/main` 上那个目录的快照来构建，不看工作目录。合并了新 PR 就自动重新构建。
- 需要后端的项目，后端由 idea-loom 按需启动、转发 `/api/*`、空闲后停掉。
- idea-loom 的 play 页把各项目的**卡片**排成一列：一张卡是一个可以直达的场景。

每个子项目要做到下面七条。前两条决定它能不能出现在 play 页，后五条决定它在卡片里好不好用。

1. **在项目根目录提供 `sim.json`**（格式见下）。没有的项目，idea-loom 暂时用自己带的一份临时名片（`idea-loom/data/play/<项目>.json`）；项目自己的进了 `main` 就以它为准。
2. **每张卡片有直达链接**：一个 URL（查询参数或 hash）就能打开到那个场景。卡片列表要和实际能直达的状态一致。
3. **`?embed=1` 时只留舞台和必要的控件**：去掉侧栏、标题栏、库列表；不弹模态框；进来就自己开始，不等人按播放。
4. **看不见的时候停下来**：页面隐藏（`visibilitychange`）时暂停模拟循环，回来再继续。
5. **不写死主机和端口**。后端的接口都放在 `/api` 下；后端监听的端口从启动参数或环境变量来，只绑 `127.0.0.1`。
6. **后端不依赖当前目录**；运行中要写的数据写到环境变量 `WORLD_SIM_STATE` 指的目录；没有 `claude` 命令时界面仍然能用。
7. **运行时要用的数据要么进 git，要么在 `sim.json` 的 `prepare` 里给出生成它的命令**。快照里只有 git 里的文件。

`sim.json`：

```json
{
  "title": { "zh": "从微观规则到涌现", "en": "From microscopic rules to emergence" },
  "level": "L1",
  "ready": true,
  "web": { "dir": ".", "build": [["bun", "install"], ["bunx", "vite", "build"]], "dist": "dist" },
  "api": {
    "dir": ".",
    "prepare": [["uv", "sync"]],
    "run": ["uv", "run", "uvicorn", "pkg.server:app", "--host", "127.0.0.1", "--port", "{port}"],
    "health": "/api/health",
    "env": { "SOME_DIR": "{state}" }
  },
  "cards": [
    {
      "id": "wake",
      "title": { "zh": "流过一个圆盘：背后出现回流", "en": "Flow past a disc: backflow appears behind it" },
      "hint": { "zh": "一句话：进来可以试什么", "en": "One line: what to try" },
      "idea": "1.1",
      "url": "/?scenario=wake"
    }
  ]
}
```

- `web`（要构建的前端）和 `static`（`{"dir": "…"}`，不用构建的静态文件）二选一。`build` 里的命令在 `web.dir` 下依次运行，产物在 `web.dir/dist` 下要有 `index.html`。
- `api` 可以没有。`run` 或 `env` 里必须出现 `{port}`；还可以用 `{state}`（给它写数据的目录）和 `{repo}`（仓库根目录）。`prepare` 在构建时跑一次。
- `cards[].url` 相对于这个模拟自己的根，以 `/` 开头。`cards[].idea` 是想法池里的编号，可以不给。
- `ready: false` 的项目不出现在 play 页。
- 构建不跑类型检查和测试，那是各项目自己提交前的事。
- 用 `cd idea-loom && uv run idea-loom play status` 看每个项目的构建状态，`uv run idea-loom play build <项目>` 重新构建。

### The single entry point and the embed contract

**While developing**, each subproject keeps its own dev server and port. **For use**, none of them needs starting: one `idea-loom` process hosts every simulation (`cd idea-loom && uv run idea-loom build-ui && uv run idea-loom serve`, then open http://localhost:8767).

- Each simulation lives on its own subdomain, `http://<project>.localhost:8767/`. That is a separate origin, so root-relative paths such as `/api/...` and `/assets/...` keep working unchanged.
- What is hosted is **the version merged into `main`**: idea-loom builds a snapshot of that directory from `origin/main` and ignores the working tree. A newly merged PR triggers a rebuild.
- A project that needs a backend has it started on demand by idea-loom, with `/api/*` proxied to it and the process stopped after a long idle.
- idea-loom's play page lays the projects' **cards** out in one column; a card is one scenario that can be opened directly.

Every subproject should meet these seven points. The first two decide whether it appears on the play page at all; the other five decide how well it works inside a card.

1. **Provide a `sim.json` at the project root** (format above). Until it exists, idea-loom uses an interim file of its own (`idea-loom/data/play/<project>.json`); the project's own file wins as soon as it is on `main`.
2. **Every card has a deep link**: one URL (query parameters or hash) opens that scenario. Keep the card list in step with what can really be opened.
3. **With `?embed=1`, show only the stage and the essential controls**: no sidebar, title bar or library list; no modal dialogs; start by itself without waiting for a play button.
4. **Stop when not visible**: pause the simulation loop on `visibilitychange` when the page is hidden, and resume on return.
5. **No hard-coded host or port.** Backend routes all live under `/api`; the port comes from an argument or an environment variable, and the server binds to `127.0.0.1` only.
6. **The backend does not depend on the current directory**; anything it writes at run time goes under the directory named by the `WORLD_SIM_STATE` environment variable; the UI still works without the `claude` command.
7. **Data needed at run time is either in git or generated by a command listed under `prepare` in `sim.json`.** A snapshot only contains what is in git.

Notes on `sim.json`: exactly one of `web` (a frontend to build) and `static` (`{"dir": "…"}`, files served as they are). The `build` commands run in order inside `web.dir`, and `web.dir/dist` must then contain an `index.html`. `api` is optional; `{port}` must appear in `run` or `env`, and `{state}` (a directory it may write to) and `{repo}` (the repository root) are also available; `prepare` runs once at build time. `cards[].url` is relative to the simulation's own root and starts with `/`; `cards[].idea` is an id from the idea pool and is optional. A project with `ready: false` stays off the play page. The build runs no type checks or tests; those belong to each project before it submits. `uv run idea-loom play status` shows every project's build state and `uv run idea-loom play build <project>` rebuilds one.

## IDEAS.md 和想法池

- `IDEAS.md` 里用注释标记圈出来的三块（想法池、内核表、覆盖表）由 `idea-loom/` 生成，**不要手改**。要加、改、合并、丢弃 idea，在 idea-loom 的界面里做，或者直接往 `idea-loom/data/ideas.jsonl` 追加事件，然后运行 `cd idea-loom && uv run idea-loom sync`。
- `IDEAS.en.md` 是英文版：同样的三块由 idea-loom 生成（idea 的英文是模型译的，中文是原文），标记之外是手写的译文。改了 `IDEAS.md` 的手写部分，要同时改 `IDEAS.en.md`。
- 标记之外的文字是手写的分析，可以照常改。
- `idea-loom/data/` 和 `IDEAS.md` 一起提交，同步命令会替你开这个 PR。
- `idea-loom/` 不是模拟，不占阶梯上的位置。

The three blocks of `IDEAS.md` fenced by comment markers (the pool, the kernel table,
the coverage table) are generated by `idea-loom/`; do not edit them by hand. Add, edit,
merge or discard ideas in the idea-loom UI, or append events to
`idea-loom/data/ideas.jsonl`, then run `cd idea-loom && uv run idea-loom sync`. Text
outside the markers is hand-written. `idea-loom/data/` and `IDEAS.md` are committed
together; the sync command opens that PR for you. `IDEAS.en.md` is the English edition:
the same three blocks are generated (idea texts are translated by a model from the
Chinese original) and the rest is a hand-written translation, so a change to the
hand-written part of `IDEAS.md` needs the same change in `IDEAS.en.md`. `idea-loom/` is not a simulation and
has no place on the ladder.

## 新项目

- 从 `IDEAS.md` 里选一条，在根目录下开一个新子目录，名字短、小写。
- 项目根目录要有 `README.md`：模拟什么、怎么运行、怎么测试、数据从哪来。
- 第一个 PR 里同时更新根 `README.md` 的阶梯表。
- 各项目共同的做法见根 `README.md`。
