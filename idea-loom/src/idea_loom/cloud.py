"""云端启动时要做的两件事：准备好仓库的副本，第一次把数据从仓库里取出来。

本地用不到：仓库就是你所在的目录，数据就在 idea-loom/data/。

Two things to do on start in the cloud: have a clone of the repository ready, and seed the
data from the repository the first time. Not needed locally, where the repository is the
directory you are in and the data sits in idea-loom/data/.
"""

from __future__ import annotations

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


def wait_and_seed(attempts: int = 60, pause: float = 5.0) -> list[str]:
    """hub 用：仓库是 play 负责克隆的，等它好了再取数据。 / For the hub: the play role clones the repository, so wait for it before seeding."""
    for _ in range(attempts):
        if has_clone():
            return seed_data()
        time.sleep(pause)
    return []
