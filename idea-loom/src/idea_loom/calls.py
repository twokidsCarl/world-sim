"""把模型调用从 hub 交给 worker。

hub 里没有 claude，也没有订阅令牌。它要调用模型时，在共享的运行目录里放一张单子；
worker 取走、自己拼好命令去跑、把输出一行行写回来，hub 这边跟着读。

单子里只有数据（提示词、模型名、哪一轮对话），**没有命令行**：命令是 worker 用它自己的
代码拼出来的。这样 hub 即使出了问题，也不能让持有密钥的 worker 去执行任意命令。

Handing model calls from the hub to the worker. The hub has neither claude nor the
subscription token. To call the model it leaves a request slip in the shared runs
directory; the worker takes it, builds the command itself, runs it and writes the output
back line by line while the hub reads along. A slip holds data only (the prompt, the model
name, which conversation turn) and **never a command line**: the worker builds the command
with its own code, so even a compromised hub cannot make the worker, which holds the
secrets, run an arbitrary command.

    runs/worker/calls/<编号>/request.json   hub 写 / written by the hub
                             stdout          worker 边跑边写 / written by the worker as it runs
                             cancel          hub 想停 / the hub wants it stopped
                             done.json       worker 写，表示结束 / written by the worker when it ends
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from . import config, gates, store

KINDS = ("llm", "assistant")
POLL = 0.1
KEEP_SECONDS = 3600


def root() -> Path:
    return store.runs_dir() / "worker" / "calls"


def remote() -> bool:
    """这个进程要不要把模型调用交出去。 / Whether this process hands its model calls over."""
    return config.role() == "hub"


def heartbeat_path() -> Path:
    return store.runs_dir() / "worker" / "heartbeat"


def worker_alive(now: Optional[float] = None) -> bool:
    try:
        return (now or time.time()) - heartbeat_path().stat().st_mtime < 60
    except OSError:
        return False


# ---------- hub 这边 / the hub's side ----------


def submit(kind: str, payload: dict[str, Any]) -> Path:
    if kind not in KINDS:
        raise ValueError(kind)
    directory = root() / f"{int(time.time() * 1000)}-{secrets.token_hex(4)}"
    directory.mkdir(parents=True)
    store.write_json(directory / "request.json", {"kind": kind, **payload})
    return directory


def cancel(directory: Path) -> None:
    (directory / "cancel").touch()


def lines(directory: Path, timeout: float, stopped: Callable[[], bool] = lambda: False) -> Iterator[bytes]:
    """跟着读 worker 写回来的输出，到它结束为止。超时或被停掉就让它也停。

    Follow the output the worker writes back until it ends. On a timeout or a stop, tell the worker to stop too.
    """
    deadline = time.monotonic() + timeout
    position, pending = 0, b""
    while True:
        finished = (directory / "done.json").exists()
        try:
            with (directory / "stdout").open("rb") as f:
                f.seek(position)
                chunk = f.read()
        except OSError:
            chunk = b""
        position += len(chunk)
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            yield line + b"\n"
        if finished and not chunk:
            if pending:
                yield pending
            return
        if stopped() or time.monotonic() > deadline:
            cancel(directory)
            if time.monotonic() > deadline + 15:  # worker 没有回应 / the worker did not answer
                raise TimeoutError
        time.sleep(POLL)


def outcome(directory: Path) -> dict[str, Any]:
    return store.read_json(directory / "done.json", {})


def run(kind: str, payload: dict[str, Any], timeout: float) -> str:
    """交出去、等它做完、拿回全部输出。worker 不在就马上说。

    Hand it over, wait until it is done and return all the output. Says so at once if no worker is there.
    """
    if not worker_alive():
        raise RuntimeError("worker 没有在运行，模型现在用不了")
    directory = submit(kind, payload)
    out = b"".join(lines(directory, timeout))
    done = outcome(directory)
    if done.get("timed_out"):
        raise TimeoutError
    if done.get("error") and not out.strip():
        raise RuntimeError(str(done["error"]))
    return out.decode("utf-8", "replace")


# ---------- worker 这边 / the worker's side ----------


def pending() -> list[Path]:
    if not root().exists():
        return []
    return sorted(d for d in root().iterdir() if (d / "request.json").exists() and not (d / "done.json").exists() and not (d / "taken").exists())


def sweep(now: Optional[float] = None) -> None:
    """做完很久的单子删掉。 / Remove slips that finished long ago."""
    if not root().exists():
        return
    for d in root().iterdir():
        try:
            if (d / "done.json").exists() and (now or time.time()) - (d / "done.json").stat().st_mtime > KEEP_SECONDS:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


def _command(request: dict[str, Any], binary: str) -> tuple[list[str], str, str, float]:
    """由 worker 自己拼命令。返回（命令，标准输入，工作目录，时限）。 / The worker builds the command itself: (argv, stdin, cwd, time limit)."""
    from . import llm

    kind = request.get("kind")
    if kind == "llm":
        schema = request.get("schema") if isinstance(request.get("schema"), dict) else None
        system = request.get("system") if isinstance(request.get("system"), str) else None
        return llm.build_argv(binary, str(request.get("model") or llm.default_model()), system, schema), str(request.get("prompt") or ""), llm._neutral_cwd(), float(request.get("timeout") or 180)
    if kind == "assistant":
        from . import worker
        from .assistant import turns

        worker.ensure_clone()
        return turns.build_argv(binary, str(request.get("token") or "")), str(request.get("prompt") or ""), str(worker.clone()), float(turns.TURN_LIMIT_SECONDS)
    raise ValueError(f"不认识的调用：{kind}")


def serve(directory: Path) -> None:
    """做一张单子。 / Serve one slip."""
    from . import llm

    (directory / "taken").touch()
    done: dict[str, Any] = {}
    try:
        binary = llm.claude_bin()
        if binary is None:
            raise RuntimeError("worker 上找不到 claude 命令")
        argv, stdin, cwd, limit = _command(store.read_json(directory / "request.json", {}), binary)
        env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN", "IDEA_LOOM_INTERNAL_TOKEN")}
        env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "1"
        with (directory / "stdout").open("wb") as out, (directory / "stderr").open("wb") as err:
            proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, cwd=cwd, env=env)

            def watch() -> None:
                started = time.monotonic()
                while proc.poll() is None:
                    if (directory / "cancel").exists() or time.monotonic() - started > limit:
                        done["timed_out"] = not (directory / "cancel").exists()
                        proc.kill()
                        return
                    time.sleep(POLL)

            threading.Thread(target=watch, daemon=True).start()
            assert proc.stdin and proc.stdout
            try:
                proc.stdin.write(stdin.encode("utf-8"))
                proc.stdin.close()
            except BrokenPipeError:
                pass
            for raw in proc.stdout:
                out.write(raw)
                out.flush()
                if b'"rate_limit_event"' in raw:
                    try:
                        info = json.loads(raw).get("rate_limit_info")
                        if isinstance(info, dict):
                            gates.note_usage(info)
                    except ValueError:
                        pass
            done["returncode"] = proc.wait()
        if done["returncode"] != 0:
            done["error"] = f"claude 退出码 {done['returncode']}: {(directory / 'stderr').read_text(encoding='utf-8', errors='replace')[:300]}"
    except Exception as e:  # noqa: BLE001 — 单子不能悄悄没了 / a slip must not vanish silently
        done["error"] = str(e)[:300]
    store.write_json(directory / "done.json", done)
