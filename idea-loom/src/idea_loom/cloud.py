"""云端启动时要做的两件事：准备好仓库的副本，第一次把数据从仓库里取出来。

本地用不到：仓库就是你所在的目录，数据就在 idea-loom/data/。

Two things to do on start in the cloud: have a clone of the repository ready, and seed the
data from the repository the first time. Not needed locally, where the repository is the
directory you are in and the data sits in idea-loom/data/.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from . import store

SEED = ("ideas.jsonl", "frame.json", "projects.json", "wishes.jsonl", "tasks.jsonl", "sessions.json")


def repo_url() -> str:
    return os.environ.get("IDEA_LOOM_REPO_URL", "")


def has_clone(repo: Path | None = None) -> bool:
    repo = repo or store.repo_root()
    return subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "-q", "origin/main"], capture_output=True).returncode == 0


def ensure_clone(repo: Path | None = None) -> bool:
    """仓库目录是空的就克隆一份。已经有了就什么都不做。 / Clone into the repository directory if it is empty; otherwise do nothing."""
    repo = repo or store.repo_root()
    if has_clone(repo):
        return True
    if not repo_url():
        return False
    repo.mkdir(parents=True, exist_ok=True)
    done = subprocess.run(["git", "clone", "--quiet", repo_url(), str(repo)], capture_output=True, text=True, timeout=1800)
    return done.returncode == 0 and has_clone(repo)


def seed_data(repo: Path | None = None) -> list[str]:
    """数据目录里还没有的文件，从 main 上的 idea-loom/data/ 取一份过来。已经有的不动。

    Copy any file the data directory lacks from idea-loom/data/ on main. Existing files are left alone.
    """
    repo = repo or store.repo_root()
    data = store.data_dir()
    if not has_clone(repo):
        return []
    listed = subprocess.run(["git", "-C", str(repo), "ls-tree", "-r", "--name-only", "origin/main", "idea-loom/data"], capture_output=True, text=True).stdout
    wanted = [line for line in listed.splitlines() if line.rsplit("/", 1)[-1] in SEED or line.startswith("idea-loom/data/play/")]
    if store.db_path() is not None:  # 事件日志进数据库，不在数据目录里留一份 / the event logs go into the database, not the data directory
        wanted = [line for line in wanted if line.rsplit("/", 1)[-1] not in {f"{s}.jsonl" for s in store.DATA_STREAMS}]
    copied = []
    for rel in wanted:
        target = data / rel[len("idea-loom/data/"):]
        if target.exists():
            continue
        shown = subprocess.run(["git", "-C", str(repo), "show", f"origin/main:{rel}"], capture_output=True)
        if shown.returncode != 0:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(shown.stdout)
        copied.append(rel)
    return copied


def _rows(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def migrate_files() -> dict[str, int]:
    """数据目录和运行目录里原来的事件文件并进数据库。可以反复做，已经在库里的不会重复。

    Merge the event files already sitting in the data and runs directories into the
    database. Repeatable: what is already there is never duplicated.
    """
    if store.db_path() is None:
        return {}
    added = {}
    for base, streams in ((store.data_dir(), store.DATA_STREAMS), (store.runs_dir(), store.RUNS_STREAMS)):
        for stream in streams:
            path = base / f"{stream}.jsonl"
            if path.exists():
                added[stream] = store.import_rows(stream, _rows(path.read_text(encoding="utf-8")))
    return added


def import_from_main(repo: Path | None = None) -> dict[str, int]:
    """把 main 上的事件文件并进数据库：别的会话直接提交进仓库的 idea、愿望、任务，就是这样到云端的。

    Merge the event files on main into the database: this is how ideas, wishes and tasks
    that other sessions commit straight to the repository reach the cloud.
    """
    repo = repo or store.repo_root()
    if store.db_path() is None or not has_clone(repo):
        return {}
    added = {}
    for stream in store.DATA_STREAMS:
        shown = subprocess.run(["git", "-C", str(repo), "show", f"origin/main:idea-loom/data/{stream}.jsonl"], capture_output=True)
        if shown.returncode == 0:
            added[stream] = store.import_rows(stream, _rows(shown.stdout.decode("utf-8", "replace")))
    return added


def wait_and_seed(attempts: int = 60, pause: float = 5.0) -> list[str]:
    """hub 用：仓库是 play 负责克隆的，等它好了再取数据。 / For the hub: the play role clones the repository, so wait for it before seeding."""
    for _ in range(attempts):
        if has_clone():
            copied = seed_data()
            migrate_files()
            import_from_main()
            return copied
        time.sleep(pause)
    return []


IMPORT_EVERY = 300.0


def keep_importing() -> None:
    """hub 用：先取一次数据，然后每五分钟把 main 上新的事件并进来。 / For the hub: seed once, then merge new events from main every five minutes."""
    wait_and_seed()
    while store.db_path() is not None:
        time.sleep(IMPORT_EVERY)
        try:
            import_from_main()
        except Exception:  # noqa: BLE001 — 一次失败不能让循环停下 / one failure must not stop the loop
            pass
