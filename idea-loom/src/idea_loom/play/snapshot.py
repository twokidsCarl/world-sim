"""取 origin/main 上一个项目的快照并构建。状态写在 runs/play/<项目>/state.json。

构建在独立的进程里跑（`python -m idea_loom.play.snapshot <项目>`），所以后端重启不影响它。
版本号是那个目录在 main 上的 tree 哈希：合并了新 PR，哈希变了，就重新构建。

Take a snapshot of one project from origin/main and build it. State lives in
runs/play/<project>/state.json. A build runs in its own process, unaffected by backend
restarts. The version is the tree hash of that directory on main: once a PR merges and
the hash changes, the project is rebuilt.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel

from .. import llm, store
from . import manifest

Status = Literal["missing", "building", "ready", "failed"]
_last_fetch = 0.0
RETRY_AFTER = (300.0, 900.0, 3600.0)  # 失败后第 1、2、3 次起的等待秒数，之后都用最后一个 / seconds to wait after the 1st, 2nd, 3rd failure; the last one repeats


class State(BaseModel):
    version: str = ""
    status: Status = "missing"
    log: str = ""
    built_at: Optional[str] = None
    pid: Optional[int] = None
    stale: bool = False  # main 上有更新的版本，正在等重新构建 / a newer version exists on main
    serving: str = ""  # 上一个构建成功的版本；新版本在构建或失败时继续用它 / the last good build, kept in use while a newer one builds or fails
    attempts: int = 0  # 同一个版本连续失败的次数 / consecutive failures of this version
    failed_at: Optional[float] = None
    next_retry: Optional[str] = None  # 下次自动重试的时间（ISO），给界面显示 / when the next automatic retry is due (ISO), for display


def base(name: str) -> Path:
    return llm.runs_dir() / "play" / name


def src_root(name: str, version: str) -> Path:
    return base(name) / f"src-{version[:12]}" / name


def web_root(sim: manifest.Sim, version: str) -> Path:
    root = src_root(sim.name, version)
    return root / sim.static.dir if sim.static else root / sim.web.dir / sim.web.dist  # type: ignore[union-attr]


def fetch(max_age: float = 60.0) -> None:
    """最多每分钟向远端取一次。 / Fetch from the remote at most once a minute."""
    global _last_fetch
    if time.time() - _last_fetch < max_age:
        return
    _last_fetch = time.time()
    subprocess.run(["git", "-C", str(store.repo_root()), "fetch", "-q", "origin", "main"], capture_output=True, timeout=30)


def version(name: str) -> str:
    out = subprocess.run(["git", "-C", str(store.repo_root()), "rev-parse", f"{manifest.REF}:{name}"], capture_output=True, text=True)
    return out.stdout.strip() if out.returncode == 0 else ""


def _alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read(name: str) -> State:
    return State.model_validate(store.read_json(base(name) / "state.json", {}))


def _write(name: str, state: State) -> State:
    store.write_json(base(name) / "state.json", state.model_dump())
    return state


def retry_delay(attempts: int) -> float:
    return RETRY_AFTER[min(max(attempts, 1), len(RETRY_AFTER)) - 1]


def _failed(state: State, now: Optional[float] = None) -> None:
    """记一次失败，并定下下次重试的时间。 / Record one failure and set when to retry."""
    now = time.time() if now is None else now
    state.status, state.attempts, state.failed_at = "failed", state.attempts + 1, now
    state.next_retry = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(now + retry_delay(state.attempts)))


def status(name: str) -> State:
    """现在的状态。构建的进程不在了却还显示在构建，就改成失败。

    The current state. A build whose process is gone but still shows as building becomes failed.
    """
    state = read(name)
    if state.status == "building" and not _alive(state.pid):
        _failed(state)
        state.log = (state.log + "\n构建的进程不在了，没有做完。").strip()
        _write(name, state)
    current = version(name)
    state.stale = bool(current) and state.version != current
    return state


def ensure(name: str, force: bool = False, now: Optional[float] = None) -> State:
    """需要的话启动一次构建，马上返回。同一个版本失败后，按退避的间隔自动重试。

    Start a build if one is needed, and return at once. After a failure of the same version
    it retries by itself, backing off between attempts.
    """
    now = time.time() if now is None else now
    state = status(name)
    current = version(name)
    if not current:
        return _write(name, State(status="failed", log=f"main 上没有 {name}/ 这个目录"))
    if state.status == "building":
        return state
    if state.status == "ready" and state.version == current and not force:
        return state
    if state.status == "failed" and state.version == current and not force and state.failed_at is not None and now < state.failed_at + retry_delay(state.attempts):
        return state  # 还没到重试的时间 / not yet time to retry
    base(name).mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen([sys.executable, "-m", "idea_loom.play.snapshot", name], start_new_session=True,
                            stdout=subprocess.DEVNULL, stderr=(base(name) / "builder.log").open("ab"), cwd=store.repo_root())
    return _write(name, State(version=current, status="building", log="开始构建…", pid=proc.pid, serving=state.serving,
                                   attempts=state.attempts if state.version == current else 0))


def extract(name: str, target: Path, ref: str = manifest.REF) -> None:
    """把 main 上这个目录的文件解到 target 下（target/<项目>/…）。 / Extract the directory from main under target."""
    archive = subprocess.run(["git", "-C", str(store.repo_root()), "archive", ref, name], capture_output=True, check=True).stdout
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(target, filter="data")


def build(name: str) -> State:
    """取快照、跑构建命令。在独立进程里调用。 / Take the snapshot and run the build commands; called in its own process."""
    sim = manifest.load(name)
    current = version(name)
    state = State(version=current, status="building", log="", pid=os.getpid(), serving=read(name).serving, attempts=read(name).attempts)
    log: list[str] = []

    def say(text: str) -> None:
        log.append(text)
        state.log = "\n".join(log)[-6000:]
        _write(name, state)

    target = base(name) / f"src-{current[:12]}"
    try:
        if target.exists() and current != state.serving:
            shutil.rmtree(target)
        say(f"取 main 上的 {name}/（版本 {current[:12]}）")
        extract(name, target)
        root = target / name
        steps: list[tuple[Path, list[str]]] = []
        if sim.web is not None:
            steps += [(root / sim.web.dir, c) for c in sim.web.build]
        if sim.api is not None:
            steps += [(root / sim.api.dir, c) for c in sim.api.prepare]
        for cwd, command in steps:
            say(f"$ {' '.join(command)}")
            proc = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=1800)
            tail = (proc.stdout + proc.stderr).strip()[-1500:]
            if tail:
                say(tail)
            if proc.returncode != 0:
                raise RuntimeError(f"`{' '.join(command)}` 失败（退出码 {proc.returncode}）")
        if not (web_root(sim, current) / "index.html").exists():
            raise RuntimeError(f"构建完了，但在 {web_root(sim, current).relative_to(target)} 下没有 index.html")
    except Exception as e:  # noqa: BLE001 — 失败的原因要留给人看 / the reason must reach a person
        _failed(state)
        say(f"失败：{e}")
        return state
    state.status, state.built_at, state.serving = "ready", time.strftime("%Y-%m-%dT%H:%M:%S%z"), current
    state.attempts, state.failed_at, state.next_retry = 0, None, None
    say("就绪")
    for old in base(name).glob("src-*"):
        if old != target:
            shutil.rmtree(old, ignore_errors=True)
    return state


if __name__ == "__main__":
    build(sys.argv[1])
