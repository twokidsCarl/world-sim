"""把本地的改动同步到仓库：重新生成 IDEAS.md，用 tools/pr.sh 开一个 PR。

Sync local changes to the repository: regenerate IDEAS.md and open a PR through
tools/pr.sh.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Optional

from pydantic import BaseModel

from . import ideas, render, store

DATA_FILES = ("ideas.jsonl", "frame.json", "projects.json", "wishes.jsonl", "tasks.jsonl", "sessions.json")


class SyncStatus(BaseModel):
    pending: int  # 还没进仓库的事件数 / events not yet in the repository
    ideas_md_stale: bool  # IDEAS.md 和当前状态对不上 / IDEAS.md differs from the current state
    other_data: bool = False  # 愿望、任务等别的数据文件有改动 / other data files (wishes, tasks) changed
    can_sync: bool
    reason: Optional[str] = None  # 不能同步时的原因 / why syncing is not possible


class SyncResult(BaseModel):
    ok: bool
    pr_url: Optional[str] = None
    message: str


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


def _rel(repo: Path, path: Path) -> str:
    return path.resolve().relative_to(repo.resolve()).as_posix()


def _committed_lines(repo: Path, rel: str) -> int:
    shown = _git(repo, "show", f"origin/main:{rel}")
    return shown.stdout.count("\n") if shown.returncode == 0 else 0


def rendered(repo: Path) -> tuple[dict[str, str], Optional[str]]:
    """要改写的文件：{相对路径: 新内容}；标记缺失时第二项是原因。

    Files to rewrite as {relative path: new content}; the second item is the
    reason when a marker is missing.
    """
    state = ideas.state()
    out: dict[str, str] = {}
    for name, apply in (("IDEAS.md", render.apply), ("IDEAS.en.md", render.apply_en)):
        path = repo / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        try:
            fresh = apply(text, state)
        except ValueError:
            return {}, f"{name} 里还没有 idea-loom 的标记"
        if fresh != text:
            out[name] = fresh
    return out, None


def _generated_files(repo: Path) -> list[str]:
    return [name for name in ("IDEAS.md", "IDEAS.en.md") if (repo / name).exists()]


def status(repo: Optional[Path] = None) -> SyncStatus:
    repo = repo or store.repo_root()
    data = store.data_dir()
    if store.db_path() is not None:
        # 数据在数据库里时，仓库里的文件是导出的记录；导出并开 PR 要推送凭证，那是 worker 的事。
        # With the data in the database the files in the repository are an exported record; exporting and opening the PR needs the push credential, which is the worker's.
        return SyncStatus(pending=0, ideas_md_stale=False, can_sync=False, reason="云端的数据在数据库里，worker 每 15 分钟自动导出到仓库一次。")
    try:
        rel = _rel(repo, data / "ideas.jsonl")
    except ValueError:
        return SyncStatus(pending=0, ideas_md_stale=False, can_sync=False, reason="数据目录不在仓库里")
    local, _ = store.read_lines(data / "ideas.jsonl")
    pending = max(0, len(local) - _committed_lines(repo, rel))
    changed, reason = rendered(repo)
    if reason:
        return SyncStatus(pending=pending, ideas_md_stale=False, can_sync=False, reason=reason)
    # 愿望、任务这些数据文件改了，也要同步。 / Wishes, tasks and the other data files count too.
    other = _git(repo, "status", "--porcelain", "--", _rel(repo, data)).stdout.strip() != ""
    return SyncStatus(pending=pending, ideas_md_stale=bool(changed), other_data=other and pending == 0, can_sync=pending > 0 or bool(changed) or other)


def run(title: Optional[str] = None, repo: Optional[Path] = None) -> SyncResult:
    repo = repo or store.repo_root()
    st = status(repo)
    if not st.can_sync:
        return SyncResult(ok=False, message=st.reason or "没有要同步的改动")
    changed, _ = rendered(repo)
    for name, text in changed.items():
        (repo / name).write_text(text, encoding="utf-8")
    data = store.data_dir()
    paths = [_rel(repo, data / name) for name in DATA_FILES if (data / name).exists()] + _generated_files(repo)
    n = st.pending
    title_given = title
    title = title or f"ideas: 同步想法池（{n} 处改动）/ sync the idea pool ({n} change{'s' if n != 1 else ''})"
    if n == 0:
        title = title_given or "ideas: 同步想法池的数据 / sync the idea pool data"
    summary_zh = f"由 idea-loom 同步：{n} 条新的 idea 事件（以及愿望、任务等数据的改动），并重新生成 IDEAS.md 和 IDEAS.en.md 里的想法池、内核表和覆盖表。"
    summary_en = f"Synced by idea-loom: {n} new idea event{'s' if n != 1 else ''} (plus any changes to wishes, tasks and other data), and the pool, kernel table and coverage table in IDEAS.md and IDEAS.en.md regenerated."
    env = {**os.environ, "COMMIT_BODY": f"{summary_zh}\n\n{summary_en}", "PR_BODY": f"## 中文\n\n{summary_zh}\n\n## English\n\n{summary_en}"}
    proc = subprocess.run([str(repo / "tools" / "pr.sh"), title, *paths], cwd=repo, env=env, capture_output=True, text=True, timeout=300)
    out = (proc.stdout + proc.stderr).strip()
    url = next((line.split("PR: ", 1)[1].strip() for line in out.splitlines() if line.startswith("PR: ")), None)
    if proc.returncode != 0:
        return SyncResult(ok=False, pr_url=url, message=out.splitlines()[-1] if out else "同步失败")
    return SyncResult(ok=True, pr_url=url, message="已同步并合并" if url else "没有改动")
