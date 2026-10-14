"""`idea-loom serve` 的看守：代码变了，后端自己重启，界面自己重新构建。

`serve` 自己不跑后端，它是一个看守进程：先占住端口，再把后端作为子进程起起来，把端口交给它。
子进程里有一个巡查线程，每两秒看一眼：

- 界面的源码比构建产物新，而且已经停了一会儿没再改，就边服务边重新构建界面（构建失败就等源码再变）；
- 后端的代码比这个进程新（或者主人点了"立即重启"），就等一个安全的时刻——小助手没有在回答、
  没有正在处理的请求（事件流不算）——先在另一个进程里试着导入新代码，导入得了才退出，退出码是
  RESTART_EXIT。

看守看到这个退出码，界面要构建就先构建，再用同一个端口起一个新的子进程。端口一直由看守占着，
所以重启的那一两秒里连进来的请求只是排队，不会被拒绝，也不会被别的程序抢走。
会话和作业本来就是脱钩的独立进程，重启不影响它们；在进程里的只有小助手的回答和正在处理的请求，
所以只等这两样。打开着的页面看到 /api/health 里的 started 或 ui 变了，会在没有人打字的时候自己刷新。

只在本机（角色 all）这样做：云端的容器直接跑 uvicorn，不经过这里，部署靠换镜像。

The keeper of `idea-loom serve`: when the code changes the backend restarts itself and the UI
rebuilds itself. `serve` does not run the backend itself; it is a keeper process that first
holds the port, then starts the backend as a child process and hands the port to it. Inside
the child a watcher thread looks every two seconds:

- when the UI sources are newer than the build and have been left alone for a moment, it
  rebuilds the UI while still serving (after a failed build it waits for the sources to change
  again);
- when the backend code is newer than the process (or the owner pressed "restart now"), it
  waits for a safe moment — no assistant answer in progress and no request being handled
  (event streams do not count) — tries importing the new code in another process, and only
  if that works exits with RESTART_EXIT.

On that exit code the keeper builds the UI if it needs it and starts a new child on the same
port. The keeper holds the port throughout, so a request arriving during the second or two of
a restart waits in the queue instead of being refused, and no other program can take the
port. Sessions and jobs are detached processes already and a restart leaves them alone; what
lives in the process is only the assistant's answers and the requests being handled, so those
two are what it waits for. Open pages notice that `started` or `ui` in /api/health changed
and reload themselves once nobody is typing.

Local only (role all): cloud containers run uvicorn directly, not through this, and deploy by
replacing the image.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Literal, Optional

from . import config

RESTART_EXIT = 75  # 子进程要求重启时的退出码 / the exit code of a child asking to be restarted
SETTLE = 4.0  # 代码最后一次改动之后要静多久才动手（秒）/ seconds of quiet after the last code change before acting
QUICK_CRASH = 15.0  # 起来不到这么久就崩，算新代码有问题 / a crash this soon after start counts as broken new code
TICK = 2.0
ENV_FD = "IDEA_LOOM_SERVE_FD"  # 看守交给子进程的监听套接字 / the listening socket the keeper hands the child
ENV_BUILD = "IDEA_LOOM_SERVE_BUILD"  # 子进程要不要自己重新构建界面 / whether the child rebuilds the UI itself


def _say(text: str) -> None:
    print(text, flush=True)


# ---------- 磁盘上的代码和界面 / code and UI on disk ----------


def package_dir() -> Path:
    return Path(__file__).resolve().parent


def web_dir() -> Path:
    from .play import host as play_host

    return play_host.ui_dist().parent


def newest_code() -> float:
    """后端代码里最新的那个文件的修改时间。 / The modification time of the newest backend source file."""
    try:
        return max((f.stat().st_mtime for f in package_dir().rglob("*.py")), default=0.0)
    except OSError:
        return 0.0


def newest_ui_source() -> float:
    web = web_dir()
    sources = [web / "index.html", web / "package.json", web / "vite.config.ts", *(web / "src").rglob("*"), *(web / "public").rglob("*")]
    try:
        return max((f.stat().st_mtime for f in sources if f.is_file()), default=0.0)
    except OSError:
        return 0.0


def ui_built() -> Optional[float]:
    try:
        return (web_dir() / "dist" / "index.html").stat().st_mtime
    except OSError:
        return None


def ui_stale() -> bool:
    """界面要不要重新构建：还没构建过，或者源码比构建产物新。 / Whether the UI needs building: never built, or the sources are newer than the build."""
    built = ui_built()
    return built is None or newest_ui_source() > built


def build_ui() -> bool:
    """bun install 再 vite build。 / bun install, then vite build."""
    for command in (["bun", "install"], ["bunx", "vite", "build"]):
        _say("$ " + " ".join(command))
        try:
            if subprocess.run(command, cwd=web_dir()).returncode != 0:
                return False
        except FileNotFoundError:
            _say("找不到 bun，界面构建不了。 / bun was not found, so the UI cannot be built.")
            return False
    return True


def imports_ok() -> bool:
    """新代码在另一个进程里导入得了吗：导入不了就不重启，免得把能用的后端换成起不来的。

    Whether the new code imports in another process: if not, do not restart, so a working backend is never swapped for one that cannot start.
    """
    try:
        return subprocess.run([sys.executable, "-c", "import idea_loom.server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


# ---------- 纯粹的判断，测试直接测 / pure decisions, tested directly ----------


def decide(*, stale: bool, requested: bool, newest: float, now: float, busy: Optional[str]) -> tuple[Literal["idle", "wait", "restart"], Optional[str]]:
    """后端现在该不该重启。返回（动作，在等什么）。

    Whether the backend should restart now. Returns (action, what it is waiting for).

    stale：磁盘上的代码比进程新。requested：主人点了"立即重启"。newest：最新代码文件的修改时间。
    busy：进程里还有什么事在做，没有是 None。
    stale: the code on disk is newer than the process. requested: the owner pressed "restart now".
    newest: modification time of the newest code file. busy: what is still going on in the process, None when nothing.
    """
    if not stale and not requested:
        return "idle", None
    if stale and not requested and now - newest < SETTLE:
        return "wait", "代码还在改 / the code is still being changed"
    if busy:
        return "wait", busy
    return "restart", None


def after_exit(code: Optional[int], ran: float) -> Literal["restart", "stop", "wait"]:
    """子进程退出之后看守做什么。 / What the keeper does once the child has exited.

    要求重启就重启；正常退出（Ctrl+C）就跟着退出；崩了：刚起来就崩，多半是新代码有问题，等代码再变；
    跑了一阵才崩，直接再起一个。
    A requested restart restarts; a clean exit (Ctrl+C) stops too; a crash right after start most
    likely means broken new code, so wait for the code to change; a crash after a while just starts again.
    """
    if code == RESTART_EXIT:
        return "restart"
    if code in (0, -signal.SIGINT, -signal.SIGTERM, 130):
        return "stop"
    return "wait" if ran < QUICK_CRASH else "restart"


# ---------- 子进程：巡查线程 / the child: the watcher thread ----------

_server: Any = None  # 子进程里的 uvicorn.Server / the uvicorn.Server in the child
_requested = False
_waiting: Optional[str] = None
_restarting = False
_in_flight = 0
_flight_lock = threading.Lock()


def supervised() -> bool:
    """这个进程能不能自己重启：由 `idea-loom serve` 起的，而且是本机的 all 角色。

    Whether this process can restart itself: started by `idea-loom serve`, in the local all role.
    """
    return _server is not None and config.role() == "all"


def waiting() -> Optional[str]:
    """要重启了，在等什么；不在等是 None。 / What a pending restart is waiting for; None when nothing is pending."""
    return _waiting


def request() -> Optional[str]:
    """主人要求立即重启：在下一个安全的时刻重启。返回现在在等什么。

    The owner asks for a restart now: it happens at the next safe moment. Returns what it is waiting for now.
    """
    global _requested
    _requested = True
    return _busy(own=1)


def _busy(own: int = 0) -> Optional[str]:
    """进程里还有什么事在做；own 是调用者自己那个还没答完的请求。 / What is still going on in the process; own is the caller's own unanswered request."""
    from .assistant import turns

    answering = len(turns._by_conversation)
    if answering:
        return f"小助手正在回答（{answering}）/ the assistant is answering ({answering})"
    handling = _in_flight - own
    if handling > 0:
        return f"还有 {handling} 个请求在处理 / {handling} request(s) still being handled"
    return None


class InFlight:
    """数正在处理的请求。事件流一开始回答就不算了：它们一直开着，重启时由 uvicorn 掐掉，页面会自己接上。

    Counts the requests being handled. An event stream stops counting as soon as it starts answering: such streams stay open, uvicorn cuts them at a restart and the page reconnects by itself.
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        global _in_flight
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        open_ = [True]

        def done() -> None:
            global _in_flight
            if open_[0]:
                open_[0] = False
                with _flight_lock:
                    _in_flight -= 1

        async def watch(message: Any) -> None:
            if message["type"] == "http.response.start":
                kind = dict(message.get("headers") or []).get(b"content-type", b"")
                if b"text/event-stream" in kind:
                    done()
            await send(message)

        with _flight_lock:
            _in_flight += 1
        try:
            await self.app(scope, receive, watch)
        finally:
            done()


def _watch(started: float, build: bool) -> None:
    global _waiting, _restarting
    ui_failed_at = -1.0  # 上次构建失败时源码的时刻：源码没再变就不重试 / source time at the last failed build: no retry until it changes
    import_failed_at = -1.0
    while not _restarting:
        time.sleep(TICK)
        try:
            now = time.time()
            if build and ui_stale():
                source = newest_ui_source()
                if source != ui_failed_at and now - source >= SETTLE:
                    _say("界面有变化，重新构建… / The UI has changed; rebuilding it…")
                    if not build_ui():
                        ui_failed_at = source
                        _say("界面没有构建成功，等源码再变。 / The UI build failed; waiting for the sources to change.")
            newest = newest_code()
            action, why = decide(stale=newest > started + 1, requested=_requested, newest=newest, now=now, busy=_busy())
            if action == "restart":
                if newest == import_failed_at:
                    why = "新代码导入不了，等它再变 / the new code does not import; waiting for it to change"
                elif not imports_ok():
                    import_failed_at = newest
                    why = "新代码导入不了，等它再变 / the new code does not import; waiting for it to change"
                    _say(why)
                else:
                    _waiting, _restarting = None, True
                    _say("后端的代码变了，重启… / The backend code changed; restarting…")
                    _server.should_exit = True
                    return
            _waiting = why
        except Exception as e:  # noqa: BLE001 — 巡查不能自己死掉 / the watcher must not die
            _say(f"巡查出错 / watcher error: {e}")


def child_main() -> None:
    """看守起的子进程：用看守交来的套接字跑后端。 / The child the keeper starts: run the backend on the socket the keeper handed over."""
    global _server
    import uvicorn

    from . import server as backend

    sock = socket.socket(fileno=int(os.environ[ENV_FD]))
    _server = uvicorn.Server(uvicorn.Config(backend.app, log_level="warning", timeout_graceful_shutdown=3))
    if config.role() == "all":
        started = int(backend._STARTED) / 1e9
        threading.Thread(target=_watch, args=(started, os.environ.get(ENV_BUILD) != "0"), daemon=True, name="self-restart").start()
    try:
        _server.run(sockets=[sock])
    except KeyboardInterrupt:
        # uvicorn 退出后把它接到的 Ctrl+C 再抛一次；这是正常的退出，不打印堆栈。
        # uvicorn re-raises the Ctrl+C it caught once it has exited; that is a normal exit, so no traceback.
        return
    if _restarting:
        sys.exit(RESTART_EXIT)


# ---------- 看守 / the keeper ----------


def _bind(host: str, port: int) -> socket.socket:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(2048)
    sock.set_inheritable(True)
    return sock


def keep(host: str, port: int, build: bool) -> None:
    """占住端口，起子进程；子进程要求重启就（构建界面后）再起一个，Ctrl+C 就一起退出。

    Hold the port and start the child; when the child asks for a restart, (build the UI and) start another; on Ctrl+C stop together.
    """
    sock = _bind(host, port)
    env = {**os.environ, ENV_FD: str(sock.fileno()), ENV_BUILD: "1" if build else "0"}
    child: Optional[subprocess.Popen] = None

    def stop(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        while True:
            if build and ui_stale():
                _say("界面有变化，先构建… / The UI has changed; building it first…")
                if not build_ui():
                    _say("界面没有构建成功，后端照常启动（界面可能是旧的或者打不开）。 / The UI build failed; the backend starts anyway (the UI may be stale or missing).")
            began = time.time()
            child = subprocess.Popen([sys.executable, "-c", "from idea_loom.serving import child_main; child_main()"], env=env, pass_fds=(sock.fileno(),))
            code = child.wait()
            what = after_exit(code, time.time() - began)
            if what == "stop":
                return
            if what == "wait":
                _say(f"后端起不来（退出码 {code}），等代码再变… / The backend would not start (exit code {code}); waiting for the code to change…")
                while not newest_code() > began or time.time() - newest_code() < SETTLE:
                    time.sleep(TICK)
            _say("重启后端… / Restarting the backend…")
    except KeyboardInterrupt:
        # 在终端里按 Ctrl+C 时子进程也收到了（同一个进程组）；只有看守收到时（kill）这里转给它。
        # 补发的是 SIGTERM：uvicorn 第二次收到 SIGINT 会强行退出，SIGTERM 只是再要求一次优雅退出。然后等它一会儿。
        # On Ctrl+C in a terminal the child got it too (same process group); when only the keeper got it (kill), pass it on.
        # SIGTERM is what is sent: a second SIGINT makes uvicorn force its exit, SIGTERM only asks again for a graceful one. Then give it a moment.
        if child is not None:
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                child.kill()
    finally:
        sock.close()
