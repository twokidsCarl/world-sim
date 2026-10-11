# 部署到云端 / Deploying to the cloud

把 world-sim 放到一台云主机上：idea-loom 做统一入口，所有模拟在各自的子域名下。

Put world-sim on one cloud host: idea-loom is the single entry point and every simulation
lives on its own subdomain.

> **状态 / Status**：这些文件是按方案写的，**还没有在真实的主机上跑过**（写的时候手边没有 Docker、主机和域名）。第一次部署时请当它是初稿：遇到的问题记下来改掉。到目前为止只完成了"能部署"这一期，下面"还没有的"一节列了没做的部分。
>
> These files follow the plan but **have not been run on a real host yet** (there was no Docker, host or domain at hand when they were written). Treat the first deployment as a first draft and fix what you hit. Only the "can be deployed" stage is done so far; see "not there yet" below.

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
| `hub` | 界面、接口、登录 / UI, API, sign-in | 内部口令 / the internal token |
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

四个卷 / Four volumes：`state`（数据和运行记录，**要备份的就是它** / data and run records, **the one to back up**）、`repo`（仓库的副本，可重建 / the clone, rebuildable）、`work`（作业的工作区，可重建 / job workspaces, rebuildable）、`caddy-data`（证书 / certificates）。

## 还没有的 / Not there yet

按顺序做 / In this order:

1. **登录与权限 / Sign-in and roles**。做好之前整个站点挡在 `Caddyfile` 里的一道口令后面（`GATE_USER` / `GATE_HASH`），**包括模拟的子域名以外的所有页面**。注意：模拟的子域名现在是公开的。
   Until then the whole site sits behind one password in the `Caddyfile`. Note that the simulations' subdomains are public already.
2. **数据库 / Database**。现在云端的数据仍是持久盘上的事件文件，没有连续备份。
   For now the cloud's data is still event files on the volume, without continuous backup.
3. **云端的作业和模型调用 / Jobs and model calls in the cloud**。`worker` 容器默认不启动；hub 里没有 `claude`，所以生成、小助手、作业在云端暂时都用不了。
   The `worker` container is not started by default; the hub has no `claude`, so generating, the assistant and jobs do not work in the cloud yet.
4. 访客提愿望、手机布局与推送、持续运行与自动维护。
   Visitor wishes, the phone layout and push notifications, unattended running and automatic maintenance.

## 已知的风险 / Known risks

- 模拟的后端是各子项目自己写的，没有按公网服务的标准审过。`play` 不带密钥、不能提权、有资源上限，但上线前仍应逐个看一遍它们的写接口。
  The simulations' backends were written by each subproject and not reviewed as public services. `play` holds no secrets, cannot gain privileges and has resource limits, but their write routes should still be reviewed one by one before going live.
- 订阅用于常驻的自动化是灰色地带：文档允许把令牌用于脚本和 CI，但额度按"普通的个人使用"设计。
  Using a subscription for always-on automation is a grey area: the docs allow the token for scripts and CI, but the allowance assumes "ordinary, individual usage".
- 不能用你的订阅替别的用户转发模型请求。云端所有调用模型的入口都只对主人开放。
  The subscription must not serve model requests on behalf of other users; every model-calling entry point in the cloud is owner-only.
