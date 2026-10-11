"""worker：云端跑作业的那个进程。它不接受任何外来请求，只从队列里取主人批准过的事。

hub 把作业排进队列（job.queued）。这里每隔几秒看一遍：

    取消了的     把它的进程停掉，工作区删掉
    排着队的     过闸门（每天的上限、订阅额度的暂停线）→ 准备工作区 → 起进程去做

每个作业有自己的工作区：从 worker 自己那份仓库的 origin/main 开一个分支和一棵工作树。
Claude 在里面改，测试在里面跑，过了之后由这里提交、推分支、开 PR、等它合并。
推送凭证只在这一步用，不给 Claude 进程，也不给测试。失败的作业留着工作区（可以"接着做"），
过期了再清；合并了、取消了的立刻删。

The worker: the process that runs jobs in the cloud. It accepts no inbound requests and
only takes what the owner approved from the queue. The hub queues jobs (job.queued); every
few seconds this module stops the processes of cancelled jobs and removes their workspaces,
and for queued ones passes the gates (the daily cap and the allowance pause), prepares a
workspace and starts the process. Every job has its own workspace: a branch and a worktree
cut from origin/main in the worker's own clone. Claude edits there and the tests run there;
once they pass, this module commits, pushes the branch, opens the PR and waits for the merge.
The push credential is used in that step only and is given neither to the Claude process nor
to the tests. A failed job keeps its workspace (so it can be resumed) until it expires;
merged and cancelled ones are removed at once.

环境变量 / Environment:
    IDEA_LOOM_WORK        工作目录：里面是 repo/（仓库）和 jobs/<编号>/（工作区）
                          the work directory, holding repo/ (the clone) and jobs/<id>/ (workspaces)
    IDEA_LOOM_REPO_URL    仓库地址 / the repository URL
    IDEA_LOOM_PARALLEL    同时最多跑几个作业，缺省 2 / jobs that may run at once, default 2
    GH_TOKEN              推分支和开 PR 用 / for pushing the branch and opening the PR
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from . import calls, gates, jobs, notify, store

POLL_SECONDS = 5.0
MAX_CALLS = 3
KEEP_FAILED_SECONDS = 7 * 24 * 3600
MERGE_WAIT_SECONDS = 1800
CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'


def local() -> bool:
    """是不是本机（不是云端的 worker）：工作区直接从你所在的仓库里开。 / Whether this is the local machine rather than the cloud worker: workspaces are cut straight from the repository you are in."""
    from . import config

    return config.role() == "all" and not os.environ.get("IDEA_LOOM_WORK")


def work_dir() -> Path:
    """工作区放在哪。本机放在仓库目录**外面**（缓存目录下，按仓库路径分开）：放在里面的话，工作树的
    .git 会被 tools/pr.sh 当成嵌套仓库而拒绝提交。

    Where workspaces live. Locally that is **outside** the repository directory (under the cache
    directory, one per repository path): inside it, a worktree's .git would be taken for a nested
    repository by tools/pr.sh, which would then refuse to submit.
    """
    value = os.environ.get("IDEA_LOOM_WORK", "")
    if value:
        return Path(value)
    import hashlib

    cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return cache / "world-sim" / "work" / hashlib.sha256(str(store.repo_root().resolve()).encode("utf-8")).hexdigest()[:12]


def clone() -> Path:
    return store.repo_root() if local() else work_dir() / "repo"


def parallel() -> int:
    return int(os.environ.get("IDEA_LOOM_PARALLEL", "2"))


def _git(*args: str, cwd: Optional[Path] = None, env: Optional[dict[str, str]] = None, timeout: int = 600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(cwd or clone()), *args], capture_output=True, text=True, env=env or jobs.secret_free_env(), timeout=timeout)


def ensure_clone() -> None:
    repo = clone()
    if not (repo / ".git").exists():
        url = os.environ.get("IDEA_LOOM_REPO_URL", "")
        if not url:
            raise RuntimeError("没有设置 IDEA_LOOM_REPO_URL")
        repo.parent.mkdir(parents=True, exist_ok=True)
        done = subprocess.run(["git", "clone", "--quiet", url, str(repo)], capture_output=True, text=True, timeout=1800, env=jobs.secret_free_env())
        if done.returncode != 0:
            raise RuntimeError(f"克隆仓库失败：{done.stderr.strip()[-300:]}")
    # 别的会话可能正好也在取：git 会报锁冲突。等一下重试；实在不行，手上有 origin/main 就先用它。
    # Another session may be fetching at the same moment and git reports a lock conflict. Wait and retry; failing that, use the origin/main at hand.
    for attempt in range(4):
        fetched = _git("fetch", "--quiet", "origin", "main")
        if fetched.returncode == 0:
            return
        time.sleep(2.0 * (attempt + 1) * float(os.environ.get("IDEA_LOOM_RETRY_SCALE", "1")))
    if _git("rev-parse", "--verify", "-q", "origin/main").returncode != 0:
        raise RuntimeError(f"取不到 main：{fetched.stderr.strip()[-300:]}")


def remove_workspace(job: jobs.Job) -> None:
    if not job.workspace:
        return
    _git("worktree", "remove", "--force", job.workspace)
    shutil.rmtree(job.workspace, ignore_errors=True)
    _git("worktree", "prune")
    if job.branch:
        _git("branch", "-D", job.branch)


def prepare(job: jobs.Job, phase: str) -> jobs.Job:
    """给这一步准备工作区。出方案和动手都从最新的 main 重新开；"接着做"用留下来的那个。

    Prepare the workspace for this step. Planning and executing each start afresh from the latest main; resuming uses the one left behind.
    """
    if phase == "finish":
        if not job.workspace or not Path(job.workspace).exists():
            raise RuntimeError("它的工作区已经不在了，没有可以接着做的。重新出方案吧。")
        return job
    ensure_clone()
    remove_workspace(job)
    job.workspace, job.branch = str(work_dir() / "jobs" / job.job_id), f"job/{job.job_id}"
    Path(job.workspace).parent.mkdir(parents=True, exist_ok=True)
    added = _git("worktree", "add", "--force", "-B", job.branch, job.workspace, "origin/main")
    if added.returncode != 0:
        raise RuntimeError(f"建不了工作区：{added.stderr.strip()[-300:]}")
    job.base = _git("rev-parse", "origin/main").stdout.strip() or None
    jobs.save(job)
    if phase == "execute":
        # 新开的工作树里没有依赖：先装好，Claude 和后面的测试才跑得起来。
        # A fresh worktree has no dependencies: install them so Claude and the tests can run.
        for sub in (job.directory, f"{job.directory}/web"):
            if (Path(job.workspace) / sub / "package.json").exists():
                jobs._say(job.job_id, f"装依赖：bun install --cwd {sub}")
                subprocess.run(["bun", "install", "--cwd", sub], cwd=job.workspace, capture_output=True, text=True, timeout=900, env=jobs.secret_free_env())
    return job


def publish(ws: Path, branch: str, paths: list[str], title: str, commit_body: str, pr_body: str,
            existing_pr: Optional[str] = None, say: Callable[[str], None] = lambda text: None, draft: bool = False) -> tuple[Optional[str], Optional[str]]:
    """提交工作区里这几个路径的改动、推分支、开 PR、等合并。返回（PR 地址，出了什么问题）。

    Commit the changes under these paths in the workspace, push the branch, open the PR and
    wait for the merge. Returns (the PR URL, what went wrong).
    """
    plain = jobs.secret_free_env()
    # 提交用的名字和邮箱：环境变量里有就用，否则用这台机器上 git 配好的；都没有才用一个占位的。
    # The name and email to commit with: the environment's if set, else what git has configured on this machine; a placeholder only when neither exists.
    configured = bool(_git("config", "user.email", cwd=ws).stdout.strip())
    identity = [] if configured or (plain.get("GIT_AUTHOR_NAME") and plain.get("GIT_AUTHOR_EMAIL")) else ["-c", "user.name=idea-loom", "-c", "user.email=idea-loom@users.noreply.github.com"]
    if _git("add", "-A", "--", *paths, cwd=ws).returncode != 0:
        return None, "git add 失败"
    if _git("diff", "--cached", "--quiet", cwd=ws).returncode != 0:  # 有东西要提交 / there is something to commit
        done = _git(*identity, "commit", "--quiet", "-m", f"{title}\n\n{commit_body}", cwd=ws)
        if done.returncode != 0:
            return None, f"提交失败：{(done.stdout + done.stderr).strip()[-300:]}"
    if _git("rev-list", "--count", "origin/main..HEAD", cwd=ws).stdout.strip() in ("", "0"):
        return None, "没有可以提交的改动"
    with_token = {**plain, **{k: os.environ[k] for k in ("GH_TOKEN",) if k in os.environ}}
    # 有令牌（云端）就用它；本机没有令牌，用这台机器上已经登录好的 git 和 gh。推送遇到一闪而过的错误会重试。
    # A token (in the cloud) is used when present; locally there is none and the git and gh already signed in on this machine are used. Pushing retries on passing errors.
    helper = ["-c", f"credential.helper={CREDENTIAL_HELPER}"] if with_token.get("GH_TOKEN") else []
    for attempt in range(4):
        pushed = _git(*helper, "push", "--quiet", "--force", "origin", f"{branch}:{branch}", cwd=ws, env=with_token)
        if pushed.returncode == 0 or not jobs.transient(pushed.stderr) or attempt == 3:
            break
        say(f"推分支时遇到一个一闪而过的错误，等一下重试：{pushed.stderr.strip()[-160:]}")
        time.sleep(jobs.SUBMIT_WAIT * (attempt + 1))
    if pushed.returncode != 0:
        return None, f"推分支失败：{pushed.stderr.strip()[-300:]}"

    def pr_state(pr_url: str) -> str:
        seen = subprocess.run(["gh", "pr", "view", pr_url, "--json", "state"], cwd=ws, capture_output=True, text=True, env=with_token, timeout=60)
        try:
            return str(json.loads(seen.stdout).get("state") or "")
        except ValueError:
            return ""

    # 接着做的时候，上次开的 PR 还开着就接着用它，不再开一个。
    # When resuming, a PR opened last time that is still open is reused instead of opening another.
    url = existing_pr if existing_pr and pr_state(existing_pr) == "OPEN" else None
    if url is None:
        created = subprocess.run(["gh", "pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", pr_body, *(["--draft"] if draft else [])],
                                 cwd=ws, capture_output=True, text=True, env=with_token, timeout=120)
        url = next((line.strip() for line in created.stdout.splitlines() if line.strip().startswith("http")), None)
        if created.returncode != 0 or not url:
            return url, f"开 PR 失败：{(created.stdout + created.stderr).strip()[-300:]}"
    if draft:  # 草稿不会被自动合并，不用等 / a draft is not merged automatically, so there is nothing to wait for
        return url, None
    say(f"PR 已开：{url}，等它合并。")
    deadline = time.monotonic() + MERGE_WAIT_SECONDS
    state = ""
    while time.monotonic() < deadline:
        state = pr_state(url)
        if state == "MERGED":
            return url, None
        if state == "CLOSED":
            return url, "PR 被关掉了，没有合并"
        time.sleep(float(os.environ.get("IDEA_LOOM_MERGE_POLL", "10")))
    return url, f"等了 {MERGE_WAIT_SECONDS // 60} 分钟还没有合并（状态：{state or '不知道'}）"


def submit(job: jobs.Job, title: str, commit_body: str, pr_body: str, draft: bool = False) -> tuple[Optional[str], Optional[str]]:
    """作业做完之后：只提交它那个目录。 / After a job: submit its directory only."""
    return publish(Path(job.workspace or ""), str(job.branch), [job.directory], title, commit_body, pr_body,
                   existing_pr=job.pr_url, say=lambda text: jobs._say(job.job_id, text), draft=draft)


def sync_back(job: jobs.Job) -> list[str]:
    """本机用：作业合并之后，把它改过的文件同步回共用的仓库目录。返回合不了的文件。

    那个目录不会自己更新（多个会话共用，谁都不切分支）。不同步的话，它里面还是旧文件，下一次从那里
    提交就会把这个作业的改动改回去。每个文件三种情况：目录里的还是作业开工时的样子——直接换成新的；
    别人同时改过——三方合并；合不了——留着目录里的不动，报告出来。

    Local only: after a job merges, sync the files it changed back into the shared repository
    directory. Returns the files that could not be merged. That directory never updates by itself
    (several sessions share it and nobody switches branches); left alone it keeps the old files
    and the next commit from there would undo this job's changes. Three cases per file: still as it
    was when the job started — replaced with the new one; changed by someone meanwhile — three-way
    merged; unmergeable — the shared copy is left alone and reported.
    """
    ws, shared = Path(job.workspace or ""), store.repo_root()
    if not job.workspace or not job.base or ws.resolve() == shared.resolve():
        return []
    conflicts = []
    for rel in job.changed:
        theirs_path, ours_path = ws / rel, shared / rel
        shown = subprocess.run(["git", "-C", str(shared), "show", f"{job.base}:{rel}"], capture_output=True)
        base = shown.stdout if shown.returncode == 0 else None
        theirs = theirs_path.read_bytes() if theirs_path.is_file() else None
        ours = ours_path.read_bytes() if ours_path.is_file() else None
        if ours == theirs:
            continue
        if ours == base:  # 目录里的没人动过 / untouched in the shared directory
            if theirs is None:
                ours_path.unlink(missing_ok=True)
            else:
                ours_path.parent.mkdir(parents=True, exist_ok=True)
                ours_path.write_bytes(theirs)
            continue
        if ours is None or theirs is None or base is None:
            conflicts.append(rel)
            continue
        scratch = Path(tempfile.mkdtemp(prefix="loom-merge-"))
        try:
            (scratch / "ours").write_bytes(ours), (scratch / "base").write_bytes(base), (scratch / "theirs").write_bytes(theirs)
            merged = subprocess.run(["git", "merge-file", "-p", str(scratch / "ours"), str(scratch / "base"), str(scratch / "theirs")], capture_output=True)
            if merged.returncode == 0:
                ours_path.write_bytes(merged.stdout)
            else:
                conflicts.append(rel)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
    return conflicts


EXPORT_EVERY = 900.0


def export_pool() -> Optional[str]:
    """把数据库里的 idea、愿望、任务导出到仓库：和 main 上的不一样就开一个 PR。返回 PR 地址，没有改动返回 None。

    先把 main 上别的会话提交的事件并进数据库，再导出，这样不会把它们丢掉。

    Export the ideas, wishes and tasks in the database to the repository, opening a PR when
    they differ from main. Returns the PR URL, or None when nothing changed. Events other
    sessions committed to main are merged into the database first, so the export never drops them.
    """
    from . import cloud, sync

    if store.db_path() is None:
        return None
    ensure_clone()
    cloud.import_from_main(repo=clone())
    branch = f"sync/{time.strftime('%Y%m%d-%H%M%S')}"
    ws = work_dir() / "sync"
    _git("worktree", "remove", "--force", str(ws))
    shutil.rmtree(ws, ignore_errors=True)
    _git("worktree", "prune")
    added = _git("worktree", "add", "--force", "-B", branch, str(ws), "origin/main")
    if added.returncode != 0:
        raise RuntimeError(f"建不了工作区：{added.stderr.strip()[-300:]}")
    try:
        data = ws / "idea-loom" / "data"
        data.mkdir(parents=True, exist_ok=True)
        before = (data / "ideas.jsonl").read_text(encoding="utf-8").count("\n") if (data / "ideas.jsonl").exists() else 0
        for stream in store.DATA_STREAMS:
            text = store.export_text(stream)
            if text or (data / f"{stream}.jsonl").exists():
                (data / f"{stream}.jsonl").write_text(text, encoding="utf-8")
        changed, _ = sync.rendered(ws)
        for name, text in changed.items():
            (ws / name).write_text(text, encoding="utf-8")
        paths = ["idea-loom/data", *changed]
        if not _git("status", "--porcelain", "--", *paths, cwd=ws).stdout.strip():
            return None
        n = max(0, store.export_text("ideas").count("\n") - before)
        title = f"ideas: 同步想法池（{n} 处改动）/ sync the idea pool ({n} change{'s' if n != 1 else ''})"
        zh = f"由云端的 idea-loom 导出：{n} 条新的 idea 事件（以及愿望、任务的改动），并重新生成 IDEAS.md 和 IDEAS.en.md 里的想法池、内核表和覆盖表。"
        en = f"Exported by idea-loom in the cloud: {n} new idea event{'s' if n != 1 else ''} (plus any changes to wishes and tasks), with the pool, kernel table and coverage table in IDEAS.md and IDEAS.en.md regenerated."
        url, problem = publish(ws, branch, paths, title, f"{zh}\n\n{en}", f"## 中文\n\n{zh}\n\n## English\n\n{en}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)")
        if problem:
            raise RuntimeError(f"导出没有合并：{problem}")
        return url
    finally:
        _git("worktree", "remove", "--force", str(ws))
        shutil.rmtree(ws, ignore_errors=True)
        _git("worktree", "prune")
        _git("branch", "-D", branch)


class Worker:
    def __init__(self) -> None:
        self.running: dict[str, int] = {}  # 作业编号 → 进程号 / job id → pid
        self.calls: list[threading.Thread] = []  # 正在替 hub 做的模型调用 / model calls being served for the hub
        # 负无穷：启动后第一次就看，不依赖"开机多久了"。 / Minus infinity: look on the first round after start, whatever the machine's uptime.
        self.maintained_at = float("-inf")
        self.maintenance_note: Optional[str] = None
        self.exporting: Optional[threading.Thread] = None
        self.exported_at = time.monotonic()  # 启动后过一个间隔再导第一次 / the first export comes one interval after start

    def maybe_export(self) -> bool:
        """到时间了就在后台导出一次（等 PR 合并要一会儿，不能卡住队列）。 / When due, export once in the background (waiting for the merge takes a while and must not block the queue)."""
        if store.db_path() is None or (self.exporting and self.exporting.is_alive()) or time.monotonic() - self.exported_at < EXPORT_EVERY:
            return False
        self.exported_at = time.monotonic()

        def run() -> None:
            try:
                url = export_pool()
                if url:
                    print(f"worker: 想法池已导出 {url}", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"worker: 导出想法池失败：{e}", flush=True)

        self.exporting = threading.Thread(target=run, daemon=True, name="export-pool")
        self.exporting.start()
        return True

    def tick(self) -> list[str]:
        """看一遍队列，返回这一轮开工的作业。 / Look over the queue once; returns the jobs started this round."""
        self.serve_calls()
        self.maybe_export()
        all_jobs = jobs.listing()
        by_id = {j.job_id: j for j in all_jobs}
        # 1. 结束了的、被取消的 / the finished and the cancelled
        for job_id, pid in list(self.running.items()):
            job = by_id.get(job_id)
            if job is None or not jobs._alive(pid):
                self.running.pop(job_id)
                continue
            if job.phase == "cancelled":
                try:
                    os.killpg(pid, 15)
                except (ProcessLookupError, PermissionError):
                    pass
                self.running.pop(job_id)
        # 2. 用不着的工作区 / workspaces no longer needed
        for job in all_jobs:
            if not job.workspace or job.job_id in self.running or job.queued:
                continue
            age = time.time() - datetime.fromisoformat(job.updated_at).timestamp()
            if job.phase in ("merged", "cancelled", "declined", "review", "clean") or (job.phase == "failed" and age > KEEP_FAILED_SECONDS):
                remove_workspace(job)
                job.workspace = None
                jobs.save(job)
        # 3. 方案不等人批的那些（定时维护、连续推进）：出完方案直接动手。
        #    Those whose plan does not wait for approval (maintenance, chains): go straight from the plan to the work.
        for job in all_jobs:
            if job.phase == "plan_ready" and jobs.auto(job) and not job.queued:
                try:
                    jobs.approve(job.job_id)
                except jobs.JobError:
                    pass
        self.advance_chains(all_jobs)
        self.maybe_maintain(all_jobs)
        all_jobs = jobs.listing()
        # 4. 排着队的，按先来后到 / the queued, first come first served
        started: list[str] = []
        for job in sorted((j for j in all_jobs if j.queued and j.phase != "cancelled"), key=lambda j: j.updated_at):
            reason = self._hold(job, all_jobs)
            if reason:
                if job.waiting != reason:
                    job.waiting = reason
                    jobs.save(job)
                    jobs._say(job.job_id, f"还没轮到：{reason}")
                    if "订阅额度" in reason or "上限" in reason:  # 闸门拦下的才通知；只是在排队的不吵 / notify for the gates only, not for ordinary queueing
                        notify.send("队列暂停了", reason, url="/work", tag="gate")
                continue
            phase = str(job.queued)
            try:
                job = prepare(job, phase)
            except Exception as e:  # noqa: BLE001 — 准备不了就让这个作业失败，别卡住队列 / fail this job instead of blocking the queue
                job.queued = None
                jobs._fail(job, f"准备工作区时出错：{e}")
                continue
            if phase == "execute":
                gates.note_start(job.job_id)
            jobs._spawn(job, phase)
            self.running[job.job_id] = int(jobs.get(job.job_id).pid or 0)
            started.append(job.job_id)
        return started

    def maybe_maintain(self, all_jobs: list[jobs.Job]) -> Optional[str]:
        """提交少、没有别的作业、闸门没拦的时候，开一次定时维护。返回开的作业编号。

        Start one maintenance run when commits are few, no other job exists and the gates are open. Returns the job id.
        """
        from . import maintenance

        if not maintenance.enabled() or time.monotonic() - self.maintained_at < maintenance.check_seconds():
            return None
        self.maintained_at = time.monotonic()
        if any(j.phase in jobs.HOLDING for j in all_jobs) or gates.may_start():
            return None
        ensure_clone()  # 顺带取一次 main，数到的是最新的提交 / this also fetches main, so the count is current
        self.maintenance_note = maintenance.due(clone(), waiting_drafts=sum(1 for j in all_jobs if j.phase == "review"))
        store.write_json(store.runs_dir() / "worker" / "maintenance_state.json", {"at": time.time(), "why_not": self.maintenance_note})
        if self.maintenance_note is not None:
            return None
        ref = maintenance.pick(clone())
        if ref is None:
            return None
        job = jobs.start("maintenance", ref)
        maintenance.record(ref.split(":")[0], job.directory, job.job_id)
        return job.job_id

    def advance_chains(self, all_jobs: list[jobs.Job]) -> list[str]:
        """连续推进：主人给一个子项目批准了"接下来最多 N 步"。上一步合并了就提议下一个里程碑并开工；
        上一步失败了就停掉这条线并通知。

        Chains: the owner approved "at most N more steps" for a subproject. When the previous step
        has merged, the next milestone is proposed and started; when it failed, the chain stops and
        the owner is notified.
        """
        from . import chains

        started = []
        for directory, left in chains.load().items():
            mine = [j for j in all_jobs if j.directory == directory]
            if any(j.phase in jobs.HOLDING for j in mine):
                continue
            # 按记下的编号找上一步，不按时间比：同一秒里开的两个作业时间是一样的。
            # The previous step is found by its recorded id, not by time: two jobs started within the same second share a timestamp.
            last = next((j for j in mine if j.job_id == chains.last_job(directory)), None)
            if last is not None and last.phase in ("failed", "cancelled"):
                chains.stop(directory)
                notify.send(f"连续推进停了：{directory}", f"上一步没做成（{last.title}），剩下的 {left} 步没有做。", url="/work", tag=f"chain-{directory}")
                continue
            if left <= 0:  # 步数用完，最后一步也有了结果：这条线结束 / the steps are used up and the last one has its result: the chain is over
                chains.stop(directory)
                continue
            if gates.may_start():
                continue
            try:
                task_id = chains.propose(directory)
                job = jobs.start("task", task_id, chain=True)
                chains.use(directory, job.job_id)
                started.append(job.job_id)
            except Exception as e:  # noqa: BLE001 — 提议不出来就停掉这条线，别每几秒试一次 / stop the chain instead of retrying every few seconds
                chains.stop(directory)
                notify.send(f"连续推进停了：{directory}", f"提议下一步时出错：{e}"[:200], url="/work", tag=f"chain-{directory}")
        return started

    def serve_calls(self) -> int:
        """hub 交过来的模型调用（生成、细化、小助手）。这些是主人当面在用的，不过闸门，只限同时几个。

        Model calls handed over by the hub (generating, refining, the assistant). The owner is using
        these interactively, so they skip the gates and are only limited in how many run at once.
        """
        heartbeat = calls.heartbeat_path()
        heartbeat.parent.mkdir(parents=True, exist_ok=True)
        heartbeat.touch()
        self.calls = [t for t in self.calls if t.is_alive()]
        taken = 0
        for slip in calls.pending():
            if len(self.calls) >= MAX_CALLS:
                break
            (slip / "taken").touch()
            thread = threading.Thread(target=calls.serve, args=(slip,), daemon=True, name=f"call-{slip.name}")
            thread.start()
            self.calls.append(thread)
            taken += 1
        calls.sweep()
        return taken

    def _hold(self, job: jobs.Job, all_jobs: list[jobs.Job]) -> Optional[str]:
        if len(self.running) >= parallel():
            return f"已经有 {len(self.running)} 个作业在跑"
        busy = next((j for j in all_jobs if j.job_id in self.running and j.directory == job.directory and j.job_id != job.job_id), None)
        if busy is not None:
            return f"`{job.directory}/` 上另一个作业还在跑"
        if job.queued == "execute":
            return gates.may_start()
        return gates.paused()

    def loop(self) -> None:
        last = 0.0
        while True:
            try:
                # 模型调用是有人在等的，每半秒看一次；作业的队列每几秒看一次。
                # Someone is waiting on a model call, so those are checked every half second; the job queue every few seconds.
                if time.monotonic() - last >= POLL_SECONDS:
                    last = time.monotonic()
                    self.tick()
                else:
                    self.serve_calls()
            except Exception as e:  # noqa: BLE001 — 一轮失败不能让 worker 停下 / one bad round must not stop the worker
                print(f"worker: {e}", flush=True)
            time.sleep(0.5)


def status() -> dict[str, object]:
    """给"现在在跑什么"用。 / For the "what is running now" view."""
    from . import chains, maintenance

    listed = jobs.listing()
    return {
        "queued": [{"job_id": j.job_id, "title": j.title, "step": j.queued, "waiting": j.waiting} for j in listed if j.queued],
        "active": [{"job_id": j.job_id, "title": j.title, "phase": j.phase} for j in listed if j.phase in jobs.ACTIVE and not j.queued],
        "started_today": gates.started_today(), "per_day": gates.per_day(), "paused": gates.paused(), "usage": gates.usage(),
        "worker_alive": calls.worker_alive(), "chains": chains.load(),
        "maintenance": {"enabled": maintenance.enabled(), "below": maintenance.below(), "window_minutes": maintenance.window_minutes(),
                        "check_seconds": maintenance.check_seconds(), "per_day": maintenance.per_day(),
                        "last_check": store.read_json(store.runs_dir() / "worker" / "maintenance_state.json", {}),
                        "recent": maintenance.history()[-10:][::-1]},
        "review": [{"job_id": j.job_id, "title": j.title, "pr_url": j.pr_url} for j in listed if j.phase == "review"],
    }
