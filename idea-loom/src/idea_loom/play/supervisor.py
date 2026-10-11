"""按需启动各项目自己的后端，记下它的端口，空闲久了停掉。

状态写在 runs/play/<项目>/api.json，所以 idea-loom 重启后还认得已经在跑的后端。
后端只绑本机；它要写的运行数据放在 runs/play/<项目>/state/（环境变量 WORLD_SIM_STATE）。

Start each project's own backend on demand, remember its port, and stop it after a long
idle. State lives in runs/play/<project>/api.json, so a restarted idea-loom still knows a
backend that is already running. Backends bind to this machine only, and write their
run data under runs/play/<project>/state/ (environment variable WORLD_SIM_STATE).
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from .. import store
from . import manifest, snapshot

IDLE_SECONDS = 600
START_TIMEOUT = 90
_locks: dict[str, threading.Lock] = {}
_used: dict[str, float] = {}


class ApiError(RuntimeError):
    """后端起不来，原因写给人看。 / The backend would not start; the message is for a person."""


def _path(name: str):
    return snapshot.base(name) / "api.json"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _healthy(port: int, path: str) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=1.5) as response:
            return response.status < 500
    except urllib.error.HTTPError as e:
        return e.code < 500
    except OSError:
        return False


def stop(name: str) -> bool:
    state = store.read_json(_path(name), {})
    pid = state.get("pid")
    if pid and snapshot._alive(pid):
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    if _path(name).exists():
        _path(name).unlink()
    _used.pop(name, None)
    return bool(pid)


def running(name: str) -> Optional[dict[str, Any]]:
    state = store.read_json(_path(name), {})
    return state if state.get("pid") and snapshot._alive(state["pid"]) else None


def ensure(sim: manifest.Sim, version: str) -> int:
    """返回这个项目后端的端口；没在跑，或跑的是旧版本，就启动一个。

    Return the port of the project's backend, starting one if none runs or an old version does.
    """
    if sim.api is None:
        raise ApiError(f"{sim.name} 没有后端")
    with _locks.setdefault(sim.name, threading.Lock()):
        _used[sim.name] = time.time()
        state = running(sim.name)
        if state and state.get("version") == version and _healthy(state["port"], sim.api.health):
            return int(state["port"])
        stop(sim.name)
        port = _free_port()
        root = snapshot.src_root(sim.name, version)
        state_dir = snapshot.base(sim.name) / "state"
        state_dir.mkdir(parents=True, exist_ok=True)
        fill = {"port": str(port), "repo": str(store.repo_root()), "state": str(state_dir)}

        def sub(text: str) -> str:
            for key, value in fill.items():
                text = text.replace("{" + key + "}", value)
            return text

        env = {**os.environ, "WORLD_SIM_STATE": str(state_dir), **{k: sub(v) for k, v in sim.api.env.items()}}
        env.pop("VIRTUAL_ENV", None)  # 让 uv 用那个项目自己的环境 / let uv use that project's own environment
        log = (snapshot.base(sim.name) / "api.log").open("ab")
        try:
            proc = subprocess.Popen([sub(a) for a in sim.api.run], cwd=root / sim.api.dir, env=env, stdout=log, stderr=log, start_new_session=True)
        except OSError as e:
            raise ApiError(f"{sim.name} 的后端启动不了：{e}") from e
        store.write_json(_path(sim.name), {"pid": proc.pid, "port": port, "version": version, "started_at": time.time()})
        deadline = time.time() + START_TIMEOUT
        while time.time() < deadline:
            if proc.poll() is not None:
                tail = (snapshot.base(sim.name) / "api.log").read_text(encoding="utf-8", errors="replace")[-800:]
                stop(sim.name)
                raise ApiError(f"{sim.name} 的后端一启动就退出了：\n{tail}")
            if _healthy(port, sim.api.health):
                return port
            time.sleep(0.25)
        stop(sim.name)
        raise ApiError(f"{sim.name} 的后端 {START_TIMEOUT} 秒内没有就绪")


def reap_idle(now: Optional[float] = None) -> list[str]:
    """停掉空闲太久的后端。 / Stop backends that have been idle too long."""
    now = now or time.time()
    stopped = []
    for name in manifest.names():
        state = running(name)
        if not state:
            continue
        last = _used.get(name, state.get("started_at", now))
        if now - last > IDLE_SECONDS:
            stop(name)
            stopped.append(name)
    return stopped
