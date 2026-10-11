# 部署到云端 / Deploying to the cloud

把 world-sim 放到一台云主机上：idea-loom 做统一入口，所有模拟在各自的子域名下。

Put world-sim on one cloud host: idea-loom is the single entry point and every simulation
lives on its own subdomain.

> **状态 / Status**：这些文件是按方案写的，**还没有在真实的主机上跑过**（写的时候手边没有 Docker、主机和域名）。第一次部署时请当它是初稿：遇到的问题记下来改掉。到目前为止完成了"能部署"、"登录与权限"、"数据库"三期，下面"还没有的"一节列了没做的部分。
>
> These files follow the plan but **have not been run on a real host yet** (there was no Docker, host or domain at hand when they were written). Treat the first deployment as a first draft and fix what you hit. The "can be deployed", "sign-in and roles" and "database" stages are done so far; see "not there yet" below.

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
| 访客（登录了，不是主人）/ member (signed in, not the owner) | 再加上记自己的观看和收藏 / also record their own watching and likes |
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

## 还没有的 / Not there yet

按顺序做 / In this order:

1. **导出到仓库 / Export to the repository**。数据库里新的 idea 事件还不会自动变成 PR：导出并推送需要仓库的凭证，那在 `worker` 里，和下一条一起做。在那之前，云端写的 idea 只在数据库里。
   New idea events in the database do not become a pull request by themselves yet: exporting and pushing needs the repository credential, which lives in the `worker` and comes with the next item. Until then ideas written in the cloud exist only in the database.
2. **云端的作业和模型调用 / Jobs and model calls in the cloud**。`worker` 容器默认不启动；hub 里没有 `claude`，所以生成、小助手、作业在云端暂时都用不了。
   The `worker` container is not started by default; the hub has no `claude`, so generating, the assistant and jobs do not work in the cloud yet.
3. 访客提愿望、手机布局与推送、持续运行与自动维护。
   Visitor wishes, the phone layout and push notifications, unattended running and automatic maintenance.

## 已知的风险 / Known risks

- 数据库这一段在本机测过（把现有的 350 条 idea 事件导进去，折叠出来的状态和导出的文件都和原来逐字节相同；并发新建不撞号），但 **Litestream 的备份和恢复没有跑过**，配置是照它的文档写的。
  The database was tested locally (the existing 350 idea events imported, with the folded state and the exported files byte-identical to the originals; concurrent creation never collides), but **the Litestream backup and restore have not been run**; the configuration follows its documentation.
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
