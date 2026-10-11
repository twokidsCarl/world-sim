# 部署到云端 / Deploying to the cloud

把 world-sim 放到一台云主机上：idea-loom 做统一入口，所有模拟在各自的子域名下。

Put world-sim on one cloud host: idea-loom is the single entry point and every simulation
lives on its own subdomain.

> **状态 / Status**：这些文件是按方案写的，**还没有在真实的主机上跑过**（写的时候手边没有 Docker、主机和域名）。第一次部署时请当它是初稿：遇到的问题记下来改掉。方案里的七期都写完了（合并前的自动测试目前只报告、不拦合并），下面"还没有的"一节列了没做的部分。
>
> These files follow the plan but **have not been run on a real host yet** (there was no Docker, host or domain at hand when they were written). Treat the first deployment as a first draft and fix what you hit. All seven stages of the plan are written (tests before merging only report for now and do not gate merges); see "not there yet" below.

## 结构 / Layout

```
                    ┌─ HUB_DOMAIN ─────────── hub    idea-loom 的界面和接口 / UI and API
互联网 ─ proxy ─────┤
Internet  (Caddy)   └─ *.SIM_DOMAIN ───────── play   各模拟的静态文件和它们自己的 /api
                                                     static files of the simulations and their own /api
                       （不对外 / no inbound）  worker 改代码的作业 / code-changing jobs
```

| 容器 / Container | 做什么 / What it does | 持有的密钥 / Secrets it holds |
|---|---|---|
| `proxy` | 自动证书、按域名分流 / automatic certificates, routing by host | 证书 / certificates |
| `hub` | 界面、接口、登录 / UI, API, sign-in | 内部口令、登录的密钥 / the internal token and the sign-in secrets |
| `play` | 取 `main` 的快照、构建、按需运行各模拟的后端 / snapshots `main`, builds, runs simulation backends on demand | **没有 / none** |
| `worker` | 出方案、改代码、跑测试、开 PR / plans, changes code, runs tests, opens PRs | 订阅令牌、仓库的推送凭证 / the subscription token and the push credential |

这样分是按"谁持有密钥、谁执行不可信的代码"：`play` 运行各子项目的代码并接受访客的请求，所以什么密钥都没有；`worker` 持有密钥，所以不接受任何外来请求。

The split follows who holds secrets and who runs untrusted code: `play` runs the
subprojects' code and takes visitors' requests, so it holds nothing; `worker` holds the
secrets, so it accepts no inbound requests.

## 准备 / What you need

1. 一台云主机：4 核 8G 起，装好 Docker 和 Compose 插件，开放 80 和 443。
   A cloud host with 4 cores and 8 GB or more, Docker with the Compose plugin, ports 80 and 443 open.
2. 一个域名，两条 DNS 记录都指向这台主机：`HUB_DOMAIN` 的 A 记录，和 `*.SIM_DOMAIN` 的通配 A 记录。
   A domain with two DNS records pointing at the host: an A record for `HUB_DOMAIN` and a wildcard A record for `*.SIM_DOMAIN`.
3. 订阅令牌：在**自己的电脑**上运行 `claude setup-token`，得到一个一年有效的令牌。
   The subscription token: run `claude setup-token` on **your own computer** for a token valid for a year.
4. 仓库的推送凭证：一个只对这一个仓库有"内容读写 + 合并请求读写"的细粒度令牌。
   The push credential: a fine-grained token limited to this one repository, with contents and pull requests read/write.
5. 一个 GitHub OAuth 应用（Settings → Developer settings → OAuth Apps），回调地址填 `https://<HUB_DOMAIN>/auth/callback`。它只用来认人，只要 `read:user`。
   A GitHub OAuth app (Settings → Developer settings → OAuth Apps) whose callback URL is `https://<HUB_DOMAIN>/auth/callback`. It is only used to tell people apart and asks for `read:user` only.

## 谁能做什么 / Who may do what

`.env` 里的 `OWNER_GITHUB` 是主人。身份用 GitHub 登录来认，会话是一个签了名的 cookie，服务器不存会话。

`OWNER_GITHUB` in `.env` is the owner. People are told apart by GitHub sign-in; the session is a signed cookie and nothing is stored on the server.

| 身份 / Role | 能做的 / May |
|---|---|
| 游客（没登录）/ guest (not signed in) | 看地图、想法池、idea、血缘、项目与任务；玩 / browse the map, the pool, ideas, lineage, projects and tasks; play |
| 访客（登录了，不是主人）/ member (signed in, not the owner) | 再加上记自己的观看和收藏、提愿望（每天最多 5 条）/ also record their own watching and likes, and send wishes (at most 5 a day) |
| 主人 / owner | 其余全部：改动、生成、小助手、作业、许愿池、统计、同步 / everything else: changes, generating, the assistant, jobs, the wish pool, statistics, sync |

规则是"默认只有主人"：`src/idea_loom/auth.py` 里列出了游客和访客能用的接口，没列出的一律要主人身份，所以新加的接口不会不小心对外开放。模型只为主人调用。限流是每个地址每分钟 600 次接口请求、每个模拟的后端 120 次。

The rule is owner-only by default: `src/idea_loom/auth.py` lists the routes a guest or a
member may use and everything unlisted needs the owner, so a newly added route is never
open by accident. The model is only called for the owner. Rate limits are 600 API requests
per address per minute, and 120 to each simulation's backend.

## 启动 / Start

```sh
git clone https://github.com/twokidsCarl/world-sim.git && cd world-sim
cp deploy/.env.example deploy/.env      # 填好每一项 / fill in every entry
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

第一次启动时：`play` 克隆仓库并构建所有模拟（几分钟，soma 要拷约 64MB 的模型）；`hub` 等仓库就绪后把 `idea-loom/data/` 里的数据取到持久盘上。之后数据以持久盘上的为准。

On first start `play` clones the repository and builds every simulation (a few minutes;
soma copies about 64 MB of models), and `hub` waits for the repository and then seeds the
data from `idea-loom/data/` onto the persistent volume. From then on the volume is
authoritative.

看状态 / Check on it:

```sh
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs -f play
docker compose -f deploy/compose.yaml exec play idea-loom play status
```

## 证书 / Certificates

不需要通配证书。每个子域名第一次被访问时，Caddy 先问 hub"这个主机名是不是我们的"（`/internal/tls-ask`），hub 只对自己的域名和已知的模拟答是，然后才签发。

No wildcard certificate is needed. The first time a subdomain is visited, Caddy asks the
hub whether the host name is ours (`/internal/tls-ask`); the hub says yes only for its own
domain and for known simulations, and only then is a certificate issued.

## 更新 / Updating

- **子项目的代码**：不用做任何事。`play` 每分钟看一次 `main`，哪个项目的目录变了就重新构建它，构建期间继续用上一个版本。
  **Subproject code**: nothing to do. `play` looks at `main` every minute and rebuilds a project whose directory changed, serving the previous build meanwhile.
- **idea-loom 自己或 `deploy/`**：`git pull` 之后重新 `up -d --build`。
  **idea-loom itself or `deploy/`**: `git pull`, then `up -d --build` again.

## 数据在哪 / Where the data is

五个卷 / Five volumes：`state`（数据库和运行记录，**要备份的就是它** / the database and run records, **the one to back up**）、`play-state`（快照和构建，可重建 / snapshots and builds, rebuildable）、`repo`（仓库的副本，可重建 / the clone, rebuildable）、`work`（作业的工作区，可重建 / job workspaces, rebuildable）、`caddy-data`（证书 / certificates）。`play` 挂的是 `play-state`，数据库所在的卷它碰不到。

`play` mounts `play-state`; it cannot reach the volume the database is on.

**数据库。** 云端的 idea、愿望、任务、操作轨迹、候选、模型用量存在一个 SQLite 文件里（`state` 卷的 `db/loom.sqlite`），它是事实来源；仓库里 `idea-loom/data/` 的事件文件是导出的记录。hub 启动时把卷里原有的事件文件和 `main` 上的事件文件并进数据库，之后每五分钟再并一次 `main` 上新的——别的会话直接提交进仓库的 idea 就是这样到云端的。每条事件的编号由内容算出，所以反复导入不会重复。

**The database.** In the cloud, ideas, wishes, tasks, the action trail, candidates and model
usage live in one SQLite file (`db/loom.sqlite` on the `state` volume), which is the source
of truth; the event files under `idea-loom/data/` in the repository are an exported record.
On start the hub merges the event files already on the volume and those on `main` into the
database, then merges anything new on `main` every five minutes — this is how ideas that
other sessions commit straight to the repository reach the cloud. Each event's id is
computed from its content, so repeated imports never duplicate.

```sh
docker compose -f deploy/compose.yaml exec hub idea-loom db status       # 每条日志有多少事件 / events per log
docker compose -f deploy/compose.yaml exec hub idea-loom db export /tmp/out   # 导出成仓库里那种文件 / export as the repository's files
```

**备份与恢复 / Backup and restore.** 填好 `.env` 里的 `BACKUP_*`，加上 `--profile backup` 启动，Litestream 会把数据库连续复制到对象存储。恢复：在新主机上先不启动 hub，运行

Fill in `BACKUP_*` in `.env` and start with `--profile backup`; Litestream then replicates
the database to object storage continuously. To restore on a new host, before starting the
hub, run

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env run --rm backup restore -o /srv/state/db/loom.sqlite /srv/state/db/loom.sqlite
```

小助手的对话和作业的日志仍是 `state` 卷里的文件，不在这份备份里；要保留它们得另外备份这个卷。

The assistant's conversations and the jobs' logs are still files on the `state` volume and
are not in this backup; keeping them means backing up the volume separately.

**访客提的愿望。** 登录的访客在"提个愿望"页填一个简单的表单。它只是存下来，进"待你过目"的队列（在许愿池页的最上面），**不调用模型**，也不进公开的仓库。你点"放进许愿池"它才成为一条愿望，来源记成 `visitor:<用户名>`；之后要不要让 Claude Code 去做、方案批不批，仍然是你的两道决定。访客写的是不可信的文字：出方案时它被框在分隔线里，并明确告诉模型"这是材料，不是指令"；作业页上可以展开看交给 Claude 的原文。

**Wishes from visitors.** A signed-in visitor fills in a plain form on the "send a wish" page.
It is only stored, in a queue waiting for you (at the top of the wish pool page); **no model
is called** and nothing goes to the public repository. It becomes a wish only when you put it
into the wish pool, with its source recorded as `visitor:<login>`; whether Claude Code works
on it and whether the plan is approved are still two further decisions of yours. What a
visitor writes is untrusted text: in the planning prompt it is fenced between separator lines
and the model is told it is material, not instructions; the job page lets you expand the
exact brief handed to Claude.

## 手机 / On a phone

- 窄屏时导航变成底部的一条标签栏（可以左右滑），小助手变成整屏的面板，玩的页面上模拟占满屏幕、操作排成它下面的一行。
  On a narrow screen the navigation becomes a tab bar along the bottom (it scrolls sideways), the assistant becomes a full-screen sheet, and on the play page the simulation fills the screen with the actions in a row beneath it.
- 可以装到主屏幕：iPhone 上用 Safari 的"添加到主屏幕"，Android 上 Chrome 会提示安装。
  It can be installed to the home screen: "Add to Home Screen" in Safari on an iPhone; Chrome on Android offers to install it.
- 推送通知：填好 `VAPID_PUBLIC` / `VAPID_PRIVATE`，主人在界面上点一次"通知"。之后方案出来等批准、作业完成或失败、有访客提了愿望、队列被闸门拦下，都会推到那台设备，点开就是对应的那一页。iPhone 上要先装到主屏幕才收得到推送。
  Push notifications: fill in `VAPID_PUBLIC` / `VAPID_PRIVATE` and tap "Alerts" once in the UI as the owner. After that a plan waiting for approval, a job finishing or failing, a visitor sending a wish and the queue being held by a gate are all pushed to that device, and tapping one opens the page concerned. On an iPhone the app must be installed to the home screen before it can receive push.

## 作业 / Jobs

```sh
docker compose -f deploy/compose.yaml --env-file deploy/.env --profile jobs up -d --build
```

hub 不跑作业，只把它排进队列；`worker` 每几秒看一遍队列。每个作业有自己的工作区：从 `worker` 自己那份仓库的 `main` 开一个分支 `job/<编号>` 和一棵工作树，Claude 在里面改，测试在里面跑；过了之后由 `worker` 提交这个目录的改动、推分支、开 PR、等它合并。合并了、取消了的工作区立刻删；失败的留七天，可以"接着做"。

The hub does not run jobs, it queues them, and the `worker` looks over the queue every few
seconds. Every job has its own workspace: a branch `job/<id>` and a worktree cut from `main`
in the worker's own clone. Claude edits there and the tests run there; once they pass, the
worker commits that directory's changes, pushes the branch, opens the PR and waits for the
merge. Workspaces of merged and cancelled jobs are removed at once; failed ones are kept
for seven days so they can be resumed.

- **凭证 / Credentials**：推送凭证只在"推分支、开 PR"这一步用，不给 Claude 进程，也不给测试和安装依赖的命令。订阅令牌 Claude 自己要用；起它的时候设了 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`，让它不把自己的凭证传给它起的子进程。
  The push credential is used only for pushing and opening the PR; neither the Claude process nor the test and install commands get it. Claude needs the subscription token itself; it is started with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so that it does not pass its own credentials on to the subprocesses it starts.
- **闸门 / Gates**：每天最多开工 `JOBS_PER_DAY` 个作业；`claude` 在每次运行里会报订阅额度的使用率（五小时和七天两个窗口），任何一个到了 `USAGE_PAUSE` 就暂停队列，等那个窗口过去。排着队的作业会写明为什么还没轮到。
  At most `JOBS_PER_DAY` jobs start per day. `claude` reports the allowance utilisation in every run (a five-hour and a seven-day window); when either reaches `USAGE_PAUSE` the queue pauses until that window resets. A queued job says why it has not started.
- **并行 / Parallelism**：同时最多两个作业，同一个目录同时只有一个。
  At most two jobs at once, and only one per directory.

**其余的模型调用也经过 worker。** hub 里没有 `claude`，也没有订阅令牌。生成、细化、翻译、小助手要调用模型时，hub 在共享卷里放一张单子，`worker` 取走、**自己拼好命令**去跑、把输出一行行写回来。单子里只有数据（提示词、模型名、哪一轮对话），没有命令行，所以 hub 即使出了问题也不能让 `worker` 执行任意命令。`worker` 没启动时，界面上这些功能会直接说"worker 没有在运行"。

**The other model calls go through the worker too.** The hub has neither `claude` nor the
subscription token. When generating, refining, translating or the assistant needs the model,
the hub leaves a request slip on the shared volume; the worker takes it, **builds the command
itself**, runs it and writes the output back line by line. A slip holds data only (the prompt,
the model name, which conversation turn) and never a command line, so even a compromised hub
cannot make the worker run an arbitrary command. When the worker is not running, those
features say so in the UI.

**导出到仓库 / Export to the repository.** `worker` 每 15 分钟看一次：先把 `main` 上别的会话提交的事件并进数据库，再把数据库里的 idea、愿望、任务导出；和 `main` 上的不一样，就重新生成 `IDEAS.md` / `IDEAS.en.md` 并开一个 PR。

Every 15 minutes the worker first merges events other sessions committed to `main` into the
database, then exports the ideas, wishes and tasks; if they differ from `main` it regenerates
`IDEAS.md` / `IDEAS.en.md` and opens a PR.

## 人不在的时候 / While you are away

**连续推进 / Chains.** 在"开发"页给一个子项目点"连续推进三步"：worker 让模型提议下一个里程碑、建成任务、出方案、动手、跑测试、开 PR，合并后接着下一步。方案不再等你批；范围靠这几样限制——Claude 只能改这个子项目的目录，测试修了两轮还没过就失败，哪一步没做成这条线就停下并通知你，步数用完就停，每天的上限和额度的暂停线照样管着它。它不会发现"这一步加了新的依赖"这类事，那要看 PR。

On the Work page, "run three steps" for a subproject makes the worker have the model propose
the next milestone, create the task, plan, execute, run the tests and open the PR, then go on
to the next step after the merge. Plans no longer wait for you; the scope is bounded by
these: Claude can edit that subproject's directory only, tests still failing after two repair
rounds fail the step, a failed step stops the chain and notifies you, the chain ends when its
steps run out, and the daily cap and the allowance pause still apply. It does not notice
things like a step adding a new dependency; that is for the PR to show.

**自动维护 / Automatic maintenance**（`MAINTENANCE=1` 才开 / on only with `MAINTENANCE=1`）。它不是每晚定时的：worker 每五分钟取一次 `main`，数最近一小时的提交。少于 2 次、没有别的作业、闸门没拦，就立刻做一件事——也就是仓库一安静下来，几分钟之内它就开工；有人又开始提交，下一次看就不再开新的。两次之间至少隔半小时，每天最多 4 次；等你看的草稿 PR 攒到 3 个就先停。这几个数都能在 `.env` 里改。清单轮着来——文档一致性、代码审查、清理、测试补缺、加固、排查——并且只碰这段时间里没人提交的子项目。"查过了，没有要改的"是正常的结果。

It is not a nightly schedule: every five minutes the worker fetches `main` and counts the
commits of the last hour. With fewer than 2, no other job and the gates open it does one
thing at once — so within minutes of the repository going quiet it starts, and when commits
resume the next look starts nothing new. Runs are at least half an hour apart and at most 4
a day, and it holds off once 3 draft PRs are waiting for you. All of these numbers can be
changed in `.env`. The list rotates — documentation consistency, code review, cleanup,
missing tests, hardening, triage — and only subprojects nobody committed to within the window
are touched. "Looked, nothing to change" is a normal result.

| 档 / Tier | 条件 / When | 怎么处理 / What happens |
|---|---|---|
| 甲 / A | 只改了 `*.md`，测试全过 / only `*.md` changed and the tests pass | 照常开 PR，自动合并 / a normal PR that merges automatically |
| 乙 / B | 改了别的任何东西 / anything else changed | 开成**草稿 PR**，不会自动合并，推送通知你；你在 GitHub 上点 "Ready for review" 才合并 / opened as a **draft PR**, which is not merged automatically, and you are notified; it merges when you mark it ready for review on GitHub |

只改了代码里的注释也算乙档：程序没法便宜地确认"只动了注释"，所以保守处理。

A change to code comments alone is tier B too: the program cannot cheaply confirm that only
comments moved, so it errs on the side of caution.

"开发"页最上面的"现在在跑什么"显示队列、在跑的作业、今天开工了几个、订阅额度用了多少、等你看的草稿 PR、连续推进还剩几步、定时维护最近做过什么。

"What is running now" at the top of the Work page shows the queue, running jobs, how many
started today, how much of the allowance is used, draft PRs waiting for you, how many steps
each chain has left, and what maintenance did recently.

## 还没有的 / Not there yet

按顺序做 / In this order:

1. **合并前的自动测试 / Tests before merging**。仓库的自动合并现在不看测试。worker 在开 PR 之前自己重跑过测试，但别的来源的 PR 没有这一关。
   The repository's auto-merge does not look at tests yet. The worker re-runs the tests before opening its PR, but PRs from other sources have no such gate.
2. **作业的出站网络 / Outbound network for jobs**。作业的进程能访问任何地址，还没有只放行模型接口、GitHub 和包管理源的名单。
   A job's processes can reach any address; there is no allow-list yet limiting them to the model API, GitHub and the package registries.

## 已知的风险 / Known risks

- 数据库这一段在本机测过（把现有的 350 条 idea 事件导进去，折叠出来的状态和导出的文件都和原来逐字节相同；并发新建不撞号），但 **Litestream 的备份和恢复没有跑过**，配置是照它的文档写的。
  The database was tested locally (the existing 350 idea events imported, with the folded state and the exported files byte-identical to the originals; concurrent creation never collides), but **the Litestream backup and restore have not been run**; the configuration follows its documentation.
- 作业这一段在本机用假的 `claude` 和假的 `gh`、一个本地的远端仓库测过（排队、工作区、提交只含这个目录、推分支、开 PR、等合并、闸门、取消、接着做），但**没有在容器里对着真的 GitHub 跑过**。`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 的效果没有单独验证过。
  Jobs were tested locally with a fake `claude`, a fake `gh` and a local remote (queueing, the workspace, a commit holding only that directory, pushing, opening the PR, waiting for the merge, the gates, cancelling, resuming), but **have not been run in the container against the real GitHub**. The effect of `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` has not been verified separately.
- 手机布局只在电脑上用 390 像素宽的窗口看过（玩、想法池、许愿池三页），**没有在真机上试过**；装到主屏幕和推送通知没有端到端试过（推送的服务器端用假的发送函数测过）。
  The phone layout was only looked at in a 390-pixel-wide frame on a computer (the play, idea pool and wish pool pages) and **not on a real phone**; installing to the home screen and push notifications were not tried end to end (the server side of push is tested with a fake delivery function).
- 连续推进和定时维护用假的 `claude`、假的 `gh` 测过（两档的分法、草稿 PR、没有要改的、给别的作业和闸门让路、哪一步没做成就停），**没有用真的模型跑过一次**。尤其是定时维护的六条提示写得好不好、会不会改出没用的东西，只有真的跑几次才知道——所以它默认是关的。
  Chains and maintenance were tested with a fake `claude` and a fake `gh` (the two tiers, the draft PR, nothing to change, giving way to other jobs and to the gates, stopping when a step fails) and **have never been run with the real model**. Whether the six maintenance prompts are any good, or produce pointless changes, can only be learned from real runs — which is why it is off by default.
- 登录这一段在本机测过（三种身份逐个调接口、伪造和过期的 cookie、回调的 state 校验），但**没有对着真的 GitHub 走过一遍**，因为还没有域名和 OAuth 应用。
  Sign-in was tested locally (every route as each of the three roles, forged and expired cookies, the callback's state check) but **has not been run against the real GitHub**, since there is no domain or OAuth app yet.
- 模拟的子域名不需要登录，任何人都能玩；它们的后端只有限流这一道。
  The simulations' subdomains need no sign-in, so anyone can play; their backends are protected by rate limits only.

- 模拟的后端是各子项目自己写的，没有按公网服务的标准审过。`play` 不带密钥、不能提权、有资源上限，但上线前仍应逐个看一遍它们的写接口。
  The simulations' backends were written by each subproject and not reviewed as public services. `play` holds no secrets, cannot gain privileges and has resource limits, but their write routes should still be reviewed one by one before going live.
- 订阅用于常驻的自动化是灰色地带：文档允许把令牌用于脚本和 CI，但额度按"普通的个人使用"设计。
  Using a subscription for always-on automation is a grey area: the docs allow the token for scripts and CI, but the allowance assumes "ordinary, individual usage".
- 不能用你的订阅替别的用户转发模型请求。云端所有调用模型的入口都只对主人开放。
  The subscription must not serve model requests on behalf of other users; every model-calling entry point in the cloud is owner-only.
