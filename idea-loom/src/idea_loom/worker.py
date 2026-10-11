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
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from . import gates, jobs, store

POLL_SECONDS = 5.0
KEEP_FAILED_SECONDS = 7 * 24 * 3600
MERGE_WAIT_SECONDS = 1800
CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'


def work_dir() -> Path:
    value = os.environ.get("IDEA_LOOM_WORK", "")
    if not value:
        raise RuntimeError("没有设置 IDEA_LOOM_WORK")
    return Path(value)


def clone() -> Path:
    return work_dir() / "repo"


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
    fetched = _git("fetch", "--quiet", "origin", "main")
    if fetched.returncode != 0:
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
    if phase == "execute":
        # 新开的工作树里没有依赖：先装好，Claude 和后面的测试才跑得起来。
        # A fresh worktree has no dependencies: install them so Claude and the tests can run.
        for sub in (job.directory, f"{job.directory}/web"):
            if (Path(job.workspace) / sub / "package.json").exists():
                jobs._say(job.job_id, f"装依赖：bun install --cwd {sub}")
                subprocess.run(["bun", "install", "--cwd", sub], cwd=job.workspace, capture_output=True, text=True, timeout=900, env=jobs.secret_free_env())
    return job


def submit(job: jobs.Job, title: str, commit_body: str, pr_body: str) -> tuple[Optional[str], Optional[str]]:
    """提交这个目录的改动、推分支、开 PR、等合并。返回（PR 地址，出了什么问题）。

    Commit this directory's changes, push the branch, open the PR and wait for the merge.
    Returns (the PR URL, what went wrong).
    """
    ws = Path(job.workspace or "")
    plain = jobs.secret_free_env()
    identity = [] if plain.get("GIT_AUTHOR_NAME") and plain.get("GIT_AUTHOR_EMAIL") else ["-c", "user.name=idea-loom", "-c", "user.email=idea-loom@users.noreply.github.com"]
    if _git("add", "-A", "--", job.directory, cwd=ws).returncode != 0:
        return None, "git add 失败"
    if _git("diff", "--cached", "--quiet", cwd=ws).returncode != 0:  # 有东西要提交 / there is something to commit
        done = _git(*identity, "commit", "--quiet", "-m", f"{title}\n\n{commit_body}", cwd=ws)
        if done.returncode != 0:
            return None, f"提交失败：{(done.stdout + done.stderr).strip()[-300:]}"
    if _git("rev-list", "--count", "origin/main..HEAD", cwd=ws).stdout.strip() in ("", "0"):
        return None, "没有可以提交的改动"
    with_token = {**plain, **{k: os.environ[k] for k in ("GH_TOKEN",) if k in os.environ}}
    pushed = _git("-c", f"credential.helper={CREDENTIAL_HELPER}", "push", "--quiet", "--force", "origin", f"{job.branch}:{job.branch}", cwd=ws, env=with_token)
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
    url = job.pr_url if job.pr_url and pr_state(job.pr_url) == "OPEN" else None
    if url is None:
        created = subprocess.run(["gh", "pr", "create", "--base", "main", "--head", str(job.branch), "--title", title, "--body", pr_body],
                                 cwd=ws, capture_output=True, text=True, env=with_token, timeout=120)
        url = next((line.strip() for line in created.stdout.splitlines() if line.strip().startswith("http")), None)
        if created.returncode != 0 or not url:
            return url, f"开 PR 失败：{(created.stdout + created.stderr).strip()[-300:]}"
    jobs._say(job.job_id, f"PR 已开：{url}，等它合并。")
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


class Worker:
    def __init__(self) -> None:
        self.running: dict[str, int] = {}  # 作业编号 → 进程号 / job id → pid

    def tick(self) -> list[str]:
        """看一遍队列，返回这一轮开工的作业。 / Look over the queue once; returns the jobs started this round."""
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
            if job.phase in ("merged", "cancelled", "declined") or (job.phase == "failed" and age > KEEP_FAILED_SECONDS):
                remove_workspace(job)
                job.workspace = None
                jobs.save(job)
        # 3. 排着队的，按先来后到 / the queued, first come first served
        started: list[str] = []
        for job in sorted((j for j in all_jobs if j.queued and j.phase != "cancelled"), key=lambda j: j.updated_at):
            reason = self._hold(job, all_jobs)
            if reason:
                if job.waiting != reason:
                    job.waiting = reason
                    jobs.save(job)
                    jobs._say(job.job_id, f"还没轮到：{reason}")
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
        while True:
            try:
                self.tick()
            except Exception as e:  # noqa: BLE001 — 一轮失败不能让 worker 停下 / one bad round must not stop the worker
                print(f"worker: {e}", flush=True)
            time.sleep(POLL_SECONDS)


def status() -> dict[str, object]:
    """给"现在在跑什么"用。 / For the "what is running now" view."""
    listed = jobs.listing()
    return {
        "queued": [{"job_id": j.job_id, "title": j.title, "step": j.queued, "waiting": j.waiting} for j in listed if j.queued],
        "active": [{"job_id": j.job_id, "title": j.title, "phase": j.phase} for j in listed if j.phase in jobs.ACTIVE and not j.queued],
        "started_today": gates.started_today(), "per_day": gates.per_day(), "paused": gates.paused(), "usage": gates.usage(),
    }
