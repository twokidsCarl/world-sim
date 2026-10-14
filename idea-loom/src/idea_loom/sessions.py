"""网页里的 Claude Code：用 Agent SDK 开的长会话。

和网页里的"作业"不是一回事。作业是 `claude -p` 跑一次：不能问人、不读项目的规矩、工具砍到最少。
这里是 Claude Code 的同一个 harness 一直开着：读 CLAUDE.md 和记忆、全套工具、能派子 Agent、
能来回对话。它要改文件、要跑命令、要问你问题、要交计划的时候，都停下来等你在网页上回答——
就像在终端里那样。

    你发一条消息 → 它干活 →（要确认 / 要问你 / 交计划）→ 你在网页上回答 → 它接着干 → 说完

它说的话、调的工具、等你回答的事，都按顺序追加到 runs/sessions/<编号>/events.jsonl，界面用事件流读，
断了能续。

每个会话是一个独立的、和后端脱钩的进程（`python -m idea_loom.sessions run <编号>`），所以后端重启不会打断它：

    浏览器 ─▶ 后端 ─写命令文件─▶ runs/sessions/<编号>/inbox/ ─▶ 会话进程 ─▶ Claude Code
                 ◀─读事件、状态── events.jsonl、meta.json     ◀─写──┘

后端只做两件事：把你的操作（说话、回答、打断、切模式、换模型、结束）各写成 inbox/ 下的一个小文件，和读
事件、状态。会话进程闲了 30 分钟、或者发现磁盘上的代码比自己新而自己正好闲着，就自己退出；下一句话把它
拉起来，用存着的 SDK 会话编号接上原来的对话。

只在本机开放，只有主人能用：这个会话能以你的身份在你的机器上执行命令。用的是本机 Claude Code
已有的登录（订阅）；环境里有 ANTHROPIC_API_KEY 时会改成按量计费，界面上会说明。

Claude Code in the web page: a long session opened with the Agent SDK. This is not the same
as a "job". A job is one `claude -p` run: it cannot ask anyone, reads none of the project's
rules and has the fewest tools. Here the very harness of Claude Code stays open: it reads
CLAUDE.md and memory, has every tool, can spawn subagents and holds a conversation. Whenever
it wants to edit a file, run a command, ask you something or hand in a plan, it stops and
waits for your answer in the page — as it would in a terminal. What it says, the tools it
calls and what awaits your answer are appended in order to runs/sessions/<id>/events.jsonl,
read by the UI as a resumable event stream.
Each session is its own process, detached from the backend (`python -m idea_loom.sessions run <id>`),
so restarting the backend does not interrupt it. The backend does two things only: it writes each
of your actions (say, answer, interrupt, switch mode, change model, close) as a small file under
inbox/, and it reads events and state. A session process exits by itself after 30 idle minutes, or
when it finds the code on disk newer than itself while idle; the next message starts it again and
picks the conversation up with the stored SDK session id.
Local only and owner only: such a session can run commands on your machine as you. It uses
the existing login of the local Claude Code (your subscription); with ANTHROPIC_API_KEY in
the environment it bills per token instead, and the UI says which.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Literal, Optional

from pydantic import BaseModel, Field

from . import config, gates, llm, notify, store
from .assistant.stream import step_label

MAX_LIVE = 3
POLL = 0.1  # 会话进程多久看一眼 inbox / how often a session process looks at its inbox
# 会话进程用到的代码：这些文件比进程新了，进程就算"用的是旧代码"，闲下来时自己退出。
# The code a session process runs on: once any of these is newer than the process, it counts as running old code and exits when idle.
CODE = ("sessions.py", "store.py", "notify.py", "gates.py", "llm.py", "config.py", "assistant/stream.py")


def idle_exit() -> float:
    """闲多久自己退出（秒）。 / Seconds of idleness after which a session process exits."""
    return float(os.environ.get("IDEA_LOOM_SESSION_IDLE") or 1800)


def code_stamp() -> float:
    here = Path(__file__).resolve().parent
    stamps = []
    for name in CODE:
        try:
            stamps.append((here / name).stat().st_mtime)
        except OSError:
            continue
    return max(stamps, default=0.0)

# 先出计划 / 每次问我 / 改文件不用问 / 自动。没有"全部放行"。
# 自动就是 Claude Code 原样的自动模式：它自己的安全分类器判断每一步。这里不在它上面另加规则——主人说要做的事，不由我们再怀疑一遍。
# plan first / ask every time / edits without asking / auto. There is no "allow everything".
# Auto is Claude Code's auto mode as it is: its own safety classifier judges each step. No rules are added on top of it here:
# what the owner asked for is not second-guessed by us.
MODES = ("plan", "default", "acceptEdits", "auto")
Mode = Literal["plan", "default", "acceptEdits", "auto"]
MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1")
EFFORTS = ("low", "medium", "high", "xhigh", "max")


def default_model() -> str:
    return os.environ.get("IDEA_LOOM_SESSION_MODEL") or MODELS[0]
CLIP = 4000


class SessionError(ValueError):
    """这一步做不了，原因写给人看。 / The step cannot be taken; the message is for a person."""


class Subagent(BaseModel):
    """会话列表上的一个子 Agent：派它的那次工具调用、它在做什么、在跑还是回来了。

    A subagent as listed under its session: the tool call that launched it, what it does, and whether it is running or back.
    """

    id: str
    label: str
    state: Literal["running", "done", "failed", "stopped"]  # stopped：进程没了，它没做完 / the process is gone and it did not finish


class Meta(BaseModel):
    id: str
    title: str
    wish_id: Optional[str] = None
    mode: Mode = "plan"
    model: str = ""  # 要它用的模型 / the model asked for
    effort: str = "high"  # 思考的努力程度 / the reasoning effort
    model_used: Optional[str] = None  # Claude Code 报的实际在用的模型 / the model Claude Code reports it is actually using
    status: Literal["idle", "running", "waiting", "closed", "error"] = "idle"
    sdk_session: Optional[str] = None  # SDK 的会话编号，重启后靠它接上 / the SDK's session id, used to pick up after a restart
    cost_usd: float = 0
    # 整个会话累计的 token（输入、输出、缓存读、缓存写），每轮说完时更新。
    # Tokens used by the whole session so far (input, output, cache read, cache write), updated as each turn ends.
    tokens: dict[str, int] = Field(default_factory=dict)
    turns: int = 0
    # 做完了的时刻：一轮结束、后台没有任务在跑。和"停下来等你说话"分开，界面据此显示"做完了"。再开一轮就清掉。
    # When it finished: a turn ended with no background task running. Kept apart from "stopped to let you speak" so the UI can say "done"; cleared when another turn begins.
    done_at: Optional[float] = None
    tasks: int = 0  # 后台还在跑的任务（子 Agent、后台命令）有几个 / how many background tasks (subagents, background commands) are still running
    waiting_for: Optional[str] = None  # 在等你回答什么，一句话 / what awaits your answer, in a sentence
    created_at: float
    updated_at: float
    live: bool = False  # 会话进程在不在；不在的话下一条消息会把它接上 / whether the session process is up; if not, the next message resumes it
    stale: bool = False  # 进程用的是不是旧代码；是的话它闲下来会自己换成新的 / whether the process runs old code; if so it replaces itself once idle
    pid: Optional[int] = None  # 会话进程的进程号 / the session process's pid
    agents: list[Subagent] = Field(default_factory=list)  # 只在列表里给：这一轮派的和还在跑的子 Agent / listing only: the subagents of this turn and those still running


class _Live:
    """一个开着的会话在内存里的那一半。 / The in-memory half of an open session."""

    def __init__(self, meta: Meta) -> None:
        self.meta = meta
        self.inbox: asyncio.Queue[Optional[dict[str, Any]]] = asyncio.Queue()
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        # 每个还在等的请求的一句话，和它算哪一类。它会同时发起好几个工具调用，所以同时在等的可能不止一个。
        # A one-line summary of each request still waiting, and the kind it counts as. Several tool calls can be issued at once, so more than one may be waiting.
        self.waiting: dict[str, tuple[str, str]] = {}
        self.always: set[str] = set()  # 这个会话里说过"以后都允许"的 / what was allowed "from now on" within this session
        self.client: Any = None
        self.task: Optional[asyncio.Task[None]] = None  # 跑会话循环的那个任务 / the task running the session loop
        self.seq = 0
        self.busy = False  # 一轮正在进行 / a turn is in progress
        self.closing = False  # 主人点了"结束"；否则退出只是歇着，状态仍是闲着 / the owner closed it; otherwise an exit is only a rest and the state stays idle
        self.idle_since = time.monotonic()
        self.started = time.time()
        self.tasks: dict[str, str] = {}  # 后台还在跑的任务：编号 → 一句话 / background tasks still running: id → one line
        self.task_steps: dict[str, Optional[str]] = {}  # 任务属于哪一步（派它的工具调用）/ the step (launching tool call) each task belongs to
        self.turn_done = asyncio.Event()
        self.turn_started = time.monotonic()
        self.reader: Optional[asyncio.Task[None]] = None
        # token 的账：modelUsage 是这个进程里的累计，所以要知道进程开始时会话已经用了多少（base，第一轮说完才定），
        # 和已经记进 runs/llm.jsonl 的有多少（logged）。replies 是还没等到结果的这几条回复，用来在干活时报一个估计。
        # Token bookkeeping: modelUsage is cumulative within this process, so we need what the session had used when the
        # process started (base, settled when the first turn ends) and how much is already in runs/llm.jsonl (logged).
        # replies holds the replies not yet covered by a result, for an estimate while it works.
        self.usage_base: Optional[dict[str, int]] = None
        self.logged: dict[str, int] = dict(meta.tokens)
        self.replies: dict[str, dict[str, int]] = {}


# 只在测试里用：没有真的子进程时，会话"进程"是当前事件循环里的一个任务。
# Tests only: with no real subprocess, a session "process" is a task on the current event loop.
_tasks: dict[str, "asyncio.Task[None]"] = {}

# 测试时换成假的。真的是 Agent SDK 的 ClaudeSDKClient。
# Replaced by a fake in tests. The real one is the Agent SDK's ClaudeSDKClient.
ClientFactory = Callable[..., Any]
client_factory: Optional[ClientFactory] = None


def root() -> Path:
    return store.runs_dir() / "sessions"


def available() -> Optional[str]:
    """现在能不能开会话：不能就返回原因。 / Whether a session can be opened now; the reason if not."""
    if not config.is_local() or config.role() != "all":
        return "网页里的 Claude Code 会话只在本机开放"
    if client_factory is None and not os.environ.get("IDEA_LOOM_SESSION_CLIENT") and llm.claude_bin() is None:
        return "这台机器上找不到 claude 命令"
    return None


def billing() -> str:
    return "api_key" if os.environ.get("ANTHROPIC_API_KEY") else "subscription"


def _dir(session_id: str) -> Path:
    return root() / session_id


def _save(meta: Meta) -> Meta:
    meta.updated_at = time.time()
    store.write_json(_dir(meta.id) / "meta.json", meta.model_dump(exclude={"live", "stale", "pid", "agents"}))
    return meta


def _held(session_id: str) -> bool:
    """会话进程在不在：它活着的时候一直占着 runner.lock 这把锁，进程一没锁就放了，不管它是怎么没的。

    Whether the session process is up: it holds the lock on runner.lock for as long as it lives, and the lock is
    released the moment the process is gone, however it went.
    """
    path = _dir(session_id) / "runner.lock"
    if not path.exists():
        return False
    with path.open("a") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.flock(f, fcntl.LOCK_UN)
    return False


def get(session_id: str) -> Meta:
    raw = store.read_json(_dir(session_id) / "meta.json", None) if session_id.replace("-", "").isalnum() else None
    if raw is None:
        raise SessionError("没有这个会话")
    meta = Meta.model_validate(raw)
    meta.live = _held(session_id)
    if meta.live:
        info = store.read_json(_dir(session_id) / "runner.json", None) or {}
        meta.pid, meta.stale = info.get("pid"), code_stamp() > float(info.get("code") or 0) + 0.001 if info else False
    elif meta.status in ("running", "waiting"):
        # 进程不在了：没说完的、在等回答的，都算停在那里。 / The process is gone: anything unfinished or waiting counts as stopped there.
        meta.status, meta.waiting_for = "idle", None
    return meta


def listing() -> list[Meta]:
    if not root().exists():
        return []
    out = []
    for d in root().iterdir():
        try:
            meta = get(d.name)
        except (SessionError, ValueError):
            continue
        # 进程不在了，没回来的子 Agent 也就停在那里了。 / With the process gone, a subagent that never came back stopped there.
        meta.agents = [a if meta.live or a.state != "running" else a.model_copy(update={"state": "stopped"}) for a in subagents(d.name)]
        out.append(meta)
    return sorted(out, key=lambda m: m.updated_at, reverse=True)


AGENT_TOOLS = ("Agent", "Task")
SHOWN_AGENTS = 6
_agents_seen: dict[str, tuple[tuple[int, int], list[Subagent]]] = {}


def subagents(session_id: str) -> list[Subagent]:
    """一个会话的子 Agent，给左边的列表用：最近一次你说话之后派的，加上更早派的、还没回来的；最多六个，
    在跑的优先，按派出去的先后排。要读整个事件文件，所以按文件的大小和修改时间记住结果，没变就不再读。

    A session's subagents for the list on the left: those launched since you last spoke, plus earlier ones not back
    yet; six at most, running ones first, in launch order. It reads the whole event file, so the result is kept by
    the file's size and modification time and the file is not read again until it changes.
    """
    path = _dir(session_id) / "events.jsonl"
    try:
        stat = path.stat()
    except OSError:
        return []
    stamp = (stat.st_mtime_ns, stat.st_size)
    seen = _agents_seen.get(session_id)
    if seen and seen[0] == stamp:
        return seen[1]
    found: dict[str, dict[str, Any]] = {}
    spoke = 0
    for e in store.read_lines(path)[0]:
        kind, seq, ref = e.get("type"), int(e.get("seq", 0)), str(e.get("tool_use_id") if e.get("type") == "task" else e.get("id"))
        if kind == "user":
            spoke = seq
        elif kind == "tool" and e.get("name") in AGENT_TOOLS:
            tool_input = e.get("input") if isinstance(e.get("input"), dict) else {}
            found[ref] = {"seq": seq, "label": str(tool_input.get("description") or e.get("label") or ""), "state": "running", "task": False}
        elif kind == "tool_result" and ref in found and not found[ref]["task"]:
            found[ref]["state"] = "failed" if e.get("error") else "done"
        elif kind == "task" and ref in found:
            # 有任务消息就以它为准：在后台跑的，派出去的那一步马上就"返回"了。 / Task messages win: for background work the launching step "returns" at once.
            found[ref]["task"] = True
            found[ref]["state"] = "running" if e.get("state") != "done" else "done" if e.get("status") == "completed" else "failed"
    rows = [(k, a) for k, a in found.items() if a["state"] == "running" or a["seq"] > spoke]
    back = [k for k, a in rows if a["state"] != "running"]
    room = max(0, SHOWN_AGENTS - (len(rows) - len(back)))
    keep = set(back[len(back) - room:]) if room else set()
    out = [Subagent(id=k, label=a["label"], state=a["state"]) for k, a in rows if a["state"] == "running" or k in keep]
    _agents_seen[session_id] = (stamp, out)
    return out


def events(session_id: str, after: int = 0) -> list[dict[str, Any]]:
    rows, _ = store.read_lines(_dir(session_id) / "events.jsonl")
    return [r for r in rows if int(r.get("seq", 0)) > after]


def _emit(live: _Live, event: dict[str, Any]) -> None:
    if live.seq == 0:
        live.seq = len(store.read_lines(_dir(live.meta.id) / "events.jsonl")[0])
    live.seq += 1
    store.append(_dir(live.meta.id) / "events.jsonl", [{"seq": live.seq, "at": time.time(), **event}])


def _clip(value: Any, limit: int = CLIP) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit] + f"…（还有 {len(value) - limit} 个字符）"
    if isinstance(value, dict):
        return {k: _clip(v, limit) for k, v in value.items()}
    if isinstance(value, list):
        return [_clip(v, limit) for v in value[:50]]
    return value


def _set(live: _Live, status: str, waiting_for: Optional[str] = None) -> None:
    live.meta.status, live.meta.waiting_for = status, waiting_for  # type: ignore[assignment]
    _save(live.meta)
    _emit(live, {"type": "status", "status": status, "waiting_for": waiting_for})


# ---------- 等你回答 / waiting for your answer ----------


async def _ask(live: _Live, kind: str, tool: str, tool_input: dict[str, Any], ctx: Any, summary: str, key: str = "", extra: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """写一条"待回答"的事件，然后挂起，直到界面给出回答。不设超时：它等你，就像终端里那样。

    Write a "needs an answer" event and suspend until the UI answers. No timeout: it waits for you, as a terminal would.
    """
    request_id = secrets.token_hex(6)
    future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
    live.pending[request_id] = future
    live.waiting[request_id] = (summary, key)
    _emit(live, {"type": "request", "request_id": request_id, "kind": kind, "tool": tool, "input": _clip(tool_input),
                 "title": str(getattr(ctx, "title", None) or ""), "description": str(getattr(ctx, "description", None) or ""), "summary": summary, **(extra or {})})
    _set(live, "waiting", summary)
    notify.send({"plan": "计划写好了，等你批准", "question": "Claude 有问题要问你", "permission": "Claude 在等你确认"}[kind],
                f"{live.meta.title}：{summary}"[:200], url=f"/sessions/{live.meta.id}", tag=live.meta.id)
    try:
        answer = await future
    finally:
        live.pending.pop(request_id, None)
        live.waiting.pop(request_id, None)
    _emit(live, {"type": "resolved", "request_id": request_id, "decision": answer.get("decision"), "note": _clip(str(answer.get("note") or ""), 500)})
    # 还有别的在等，就仍然是"等你回答"：它一次发了几个请求时，回答完一个不等于可以接着干了。
    # While others still wait it remains "waiting for your answer": when it issued several requests at once, answering one does not mean it can go on.
    if live.waiting:
        _set(live, "waiting", next(iter(live.waiting.values()))[0])
    else:
        _set(live, "running")
    return answer


# ---------- 一条命令算哪一类 / what kind a command is ----------

TWO_WORD = {"git", "uv", "bun", "bunx", "npm", "npx", "pnpm", "yarn", "gh", "docker", "cargo", "go", "pip", "brew", "kubectl", "make"}
VALUE_FLAGS = {"-C", "-c", "--project", "--cwd", "--directory", "-R", "--repo", "--git-dir", "--work-tree", "--prefix", "-f", "--file"}
# shell 的关键字和只是"带着别的命令跑"的程序：算哪一类，看的是它们后面那条命令。
# Shell keywords and programs that merely run another command: the kind is that of the command after them.
KEYWORDS = {"do", "then", "else", "if", "elif", "while", "until", "!", "time", "{", "("}
WRAPPERS = {"xargs", "nohup", "command", "exec", "env", "nice", "timeout"}


def heredocs(command: str) -> tuple[str, list[tuple[str, str]]]:
    """把 heredoc 的正文从命令里拿掉：那是喂给程序的内容，不是命令。返回剩下的命令，和每个 heredoc 的
    （开头那一行，正文）。

    Take heredoc bodies out of a command: they are content fed to a program, not commands. Returns what is left
    of the command, and for each heredoc (the line that opens it, its body).
    """
    import re

    kept: list[str] = []
    found: list[tuple[str, str]] = []
    waiting: list[tuple[str, str, list[str]]] = []  # 结束标记、开头那一行、正文 / end marker, opening line, body
    for line in command.split("\n"):
        if waiting:
            if line.strip() == waiting[0][0]:
                marker, opener, body = waiting.pop(0)
                found.append((opener, "\n".join(body)))
            else:
                waiting[0][2].append(line)
            continue
        kept.append(line)
        for match in re.finditer(r"(?<!<)<<(?!<)-?\s*(['\"]?)([A-Za-z_]\w*)\1", line):
            waiting.append((match.group(2), line, []))
    found += [(opener, "\n".join(body)) for _, opener, body in waiting]  # 没写结束标记的 / one never closed
    return "\n".join(kept), found


def segments(command: str) -> list[str]:
    """按 | ; && || 把一条命令拆成几段；引号里的不拆，heredoc 的正文不算。 / Split a command at | ; && || into segments, leaving quoted text alone and heredoc bodies out."""
    command = heredocs(command)[0]
    out, buf, quote, i = [], "", "", 0
    while i < len(command):
        ch = command[i]
        if quote:
            buf += ch
            if ch == "\\" and quote == '"' and i + 1 < len(command):
                buf += command[i + 1]
                i += 1
            elif ch == quote:
                quote = ""
        elif ch in "'\"":
            quote, buf = ch, buf + ch
        elif command.startswith(("&&", "||"), i):
            out.append(buf)
            buf, i = "", i + 1
        elif ch in "|;\n" or (ch == "&" and not command.startswith("&>", i) and not buf.rstrip().endswith((">", "2>", "<"))):
            out.append(buf)
            buf = ""
        else:
            buf += ch
        i += 1
    out.append(buf)
    return [s.strip() for s in out if s.strip()]


def _words(segment: str) -> list[str]:
    import shlex

    try:
        words = shlex.split(segment)
    except ValueError:
        words = segment.split()
    while words:
        if "=" in words[0] and not words[0].startswith(("-", "/", ".")) and words[0].split("=")[0].replace("_", "").isalnum():
            words = words[1:]  # 开头的 VAR=值 / leading VAR=value
        elif words[0] in KEYWORDS:
            words = words[1:]  # for … ; do rm x 里的 do：要看的是 rm / the "do" of "for … ; do rm x": rm is what counts
        elif words[0] in WRAPPERS:
            # xargs rm、env X=1 rm、timeout 5 rm：跳过它自己的选项和数字，看它带着跑的那条命令。
            # xargs rm, env X=1 rm, timeout 5 rm: skip its own options and numbers and look at the command it runs.
            rest = words[1:]
            while rest and (rest[0].startswith("-") or rest[0].replace(".", "").isdigit() or ("=" in rest[0] and words[0] == "env")):
                rest = rest[1:]
            if not rest:
                break
            words = rest
        else:
            break
    return words


def kind_of(segment: str) -> str:
    """这一段算哪一类：程序名，像 git、uv 这种再加上子命令。 / The kind of a segment: the program, plus the subcommand for tools like git and uv."""
    words = _words(segment)
    if not words:
        return ""
    program = words[0].rsplit("/", 1)[-1] if words[0].startswith("/") else words[0]
    if program in TWO_WORD:
        # 跳过选项；带值的选项（git -C <目录>、uv --project <目录>）连它的值一起跳过。
        # Options are skipped, and those taking a value (git -C <dir>, uv --project <dir>) are skipped with it.
        sub, skip = "", False
        for word in words[1:]:
            if skip:
                skip = False
            elif word in VALUE_FLAGS:
                skip = True
            elif not word.startswith("-"):
                sub = word
                break
        return f"{program} {sub}".strip()
    return program


def _kinds(tool: str, tool_input: dict[str, Any]) -> list[str]:
    """"以后都允许"记的是什么：命令的每一段各记一类，别的工具按工具名记。

    What "always allow" remembers: one kind per segment of a command; other tools by name.
    """
    if tool == "Bash":
        return [f"Bash:{kind_of(part)}" for part in segments(str(tool_input.get("command") or ""))] or ["Bash:"]
    return [tool]


def _breakdown(live: "_Live", tool_input: dict[str, Any]) -> list[dict[str, Any]]:
    """给卡片看的：命令的每一段、算哪一类、以前允许过没有。 / For the card: each segment of the command, its kind and whether it was allowed before."""
    return [{"text": part, "kind": kind_of(part), "known": f"Bash:{kind_of(part)}" in live.always} for part in segments(str(tool_input.get("command") or ""))]


def _permission_callback(live: _Live) -> Callable[[str, dict[str, Any], Any], Any]:
    async def can_use_tool(tool: str, tool_input: dict[str, Any], ctx: Any) -> Any:
        from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

        def deny(what: str, note: str) -> Any:
            # 这段话会作为工具的结果回到模型手里，要让它明白这是人的决定，不要换个办法再试。
            # This text returns to the model as the tool's result; it must read as the person's decision, not something to retry around.
            return PermissionResultDeny(message=f"The user {what} in the web UI. This is the user's own decision: do not retry the same action or work around it. "
                                                + (f"The user's note: {note}" if note else "Ask the user how to proceed if unsure."))

        if tool == "AskUserQuestion":
            questions = tool_input.get("questions") or []
            first = str(questions[0].get("question", "")) if questions and isinstance(questions[0], dict) else ""
            answer = await _ask(live, "question", tool, tool_input, ctx, first or "它有问题要问你")
            if answer.get("decision") != "answer":
                return deny("declined to answer", str(answer.get("note") or ""))
            return PermissionResultAllow(updated_input={"questions": questions, "answers": answer.get("answers") or {}})
        if tool == "ExitPlanMode":
            answer = await _ask(live, "plan", tool, tool_input, ctx, "计划写好了")
            after = {"approve": "default", "approve_edits": "acceptEdits", "approve_auto": "auto"}.get(str(answer.get("decision")))
            if after is None:
                return deny("did not approve this plan", str(answer.get("note") or ""))
            # 批准之后它自己离开计划模式；选了"改文件不用问"或"之后自动"的，再切一下。
            # After approval it leaves plan mode by itself; "edits without asking" and "auto from here" need one more switch.
            live.meta.mode = after  # type: ignore[assignment]
            _save(live.meta)
            _emit(live, {"type": "mode", "mode": live.meta.mode})
            if after != "default":
                asyncio.get_running_loop().create_task(live.client.set_permission_mode(after))
            return PermissionResultAllow(updated_input=tool_input)
        kinds = _kinds(tool, tool_input)
        # 每一段都允许过，才不再问。 / Not asked again only when every segment was allowed before.
        if all(k in live.always for k in kinds):
            return PermissionResultAllow(updated_input=tool_input)
        summary = step_label(tool, tool_input, str(store.repo_root()))
        extra = {"segments": _breakdown(live, tool_input)} if tool == "Bash" else {}
        answer = await _ask(live, "permission", tool, tool_input, ctx, summary, key="|".join(sorted(kinds)), extra=extra)
        if answer.get("decision") == "allow_always":
            live.always.update(kinds)
            # 同时在等的请求里，现在每一段都允许了的，一并放行：说了"这一类以后都允许"，就不该再为它们各点一次。
            # Among the requests waiting at the same moment, those whose every segment is now allowed go through with it: having said "always allow this kind", one should not have to click once for each.
            for other, (_, other_key) in list(live.waiting.items()):
                if other_key and all(k in live.always for k in other_key.split("|")) and not live.pending[other].done():
                    live.pending[other].set_result({"decision": "allow", "note": ""})
        if answer.get("decision") in ("allow", "allow_always"):
            return PermissionResultAllow(updated_input=tool_input)
        return deny("declined this action", str(answer.get("note") or ""))

    return can_use_tool


# ---------- 会话的循环 / the session loop ----------


def _client(live: _Live) -> Any:
    callback = _permission_callback(live)
    model, effort = live.meta.model or default_model(), live.meta.effort if live.meta.effort in EFFORTS else "high"
    if client_factory is not None:
        return client_factory(cwd=str(store.repo_root()), mode=live.meta.mode, resume=live.meta.sdk_session, can_use_tool=callback, model=model, effort=effort)
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

    # 配置得和终端里一样：读用户、项目、本机三处设置；工具不砍。模型和努力程度由主人在界面上选。
    # Configured as in a terminal: user, project and local settings are read; no tool is removed. The model and the effort are the owner's choice in the UI.
    return ClaudeSDKClient(options=ClaudeAgentOptions(
        cwd=str(store.repo_root()), setting_sources=["user", "project", "local"], permission_mode=live.meta.mode,
        resume=live.meta.sdk_session, can_use_tool=callback, model=model, effort=effort,  # type: ignore[arg-type]
    ))


async def _prompt(message: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": message["text"]}]
    content += [{"type": "image", "source": {"type": "base64", "media_type": i["media_type"], "data": i["data"]}} for i in message.get("images") or []]
    yield {"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None}


def _convert(live: _Live, message: Any) -> None:
    """把 SDK 的一条消息变成界面读的事件。按类名分，不依赖具体的类，测试里可以用假的。

    Turn one SDK message into the events the UI reads. Dispatch is by class name rather than the classes themselves, so tests can use fakes.
    """
    kind = type(message).__name__
    repo = str(store.repo_root())
    if kind == "SystemMessage" and getattr(message, "subtype", "") == "init":
        # 一开始就记下会话编号和实际在用的模型：第一轮还没说完时进程没了，也能接上。
        # The session id and the model actually in use are recorded at the very start, so the conversation can be picked up even if the process dies before the first turn ends.
        data = getattr(message, "data", None) or {}
        used, session = data.get("model"), data.get("session_id")
        if (used and used != live.meta.model_used) or (session and session != live.meta.sdk_session):
            live.meta.model_used, live.meta.sdk_session = used or live.meta.model_used, session or live.meta.sdk_session
            _save(live.meta)
            _emit(live, {"type": "init", "model": live.meta.model_used, "effort": live.meta.effort})
    elif kind in ("TaskStartedMessage", "TaskProgressMessage", "TaskNotificationMessage", "TaskUpdatedMessage"):
        _task(live, kind, message)
    elif kind == "AssistantMessage":
        # 子 Agent 的每一步都带着派它的那次工具调用的编号；界面按它把这一步放到那个子 Agent 下面。
        # Each step of a subagent carries the id of the tool call that launched it; the UI uses it to put the step under that subagent.
        parent = {"parent": message.parent_tool_use_id} if getattr(message, "parent_tool_use_id", None) else {}
        _reply_usage(live, message)
        for block in message.content:
            name = type(block).__name__
            if name == "TextBlock" and block.text.strip():
                _emit(live, {"type": "text", "text": block.text, **parent})
            elif name == "ToolUseBlock" and block.name not in ("AskUserQuestion", "ExitPlanMode"):
                _emit(live, {"type": "tool", "id": block.id, "name": block.name, "label": step_label(block.name, block.input or {}, repo), "input": _clip(block.input or {}, 1500), **parent})
    elif kind == "UserMessage" and isinstance(message.content, list):
        parent = {"parent": message.parent_tool_use_id} if getattr(message, "parent_tool_use_id", None) else {}
        for block in message.content:
            if type(block).__name__ == "ToolResultBlock":
                text = block.content if isinstance(block.content, str) else " ".join(str(c.get("text", "")) for c in block.content or [] if isinstance(c, dict))
                _emit(live, {"type": "tool_result", "id": block.tool_use_id, "error": bool(block.is_error), "text": _clip(text, 1500), **parent})
    elif kind == "ResultMessage":
        live.meta.sdk_session = message.session_id or live.meta.sdk_session
        live.meta.cost_usd = round(float(message.total_cost_usd or live.meta.cost_usd), 4)  # 这是整个会话累计的 / cumulative for the whole session
        _result_usage(live, message)
        live.meta.turns += 1
        _emit(live, {"type": "result", "is_error": bool(message.is_error), "cost_usd": live.meta.cost_usd, "tokens": live.meta.tokens, "subtype": str(message.subtype or "")})
    elif kind == "RateLimitEvent":
        info = message.rate_limit_info
        resets, name, used = getattr(info, "resets_at", None), getattr(info, "rate_limit_type", None), getattr(info, "utilization", None)
        gates.note_usage({"status": getattr(info, "status", ""), "resetsAt": resets, "unifiedWindows": {str(name): {"utilization": used, "resetsAt": resets}} if name else {}})


def _reply_usage(live: _Live, message: Any) -> None:
    """一条回复的 token 先记下来，告诉界面现在大概用到多少了。一条回复按内容块拆成几条消息，用量相同或递增，按编号只算一次、取大的。

    Note the tokens of one reply and tell the UI roughly where the count stands. A reply comes split into several
    messages by content block with the same or growing usage, so it counts once per id, taking the larger figures.
    """
    usage, reply = getattr(message, "usage", None), getattr(message, "message_id", None) or getattr(message, "uuid", None)
    if not isinstance(usage, dict) or not reply:
        return
    now = llm.tokens_of({"usage": usage})
    before = live.replies.get(str(reply), {})
    merged = {k: max(now[k], int(before.get(k) or 0)) for k in llm.TOKEN_KEYS}
    if merged != before:
        live.replies[str(reply)] = merged
        _emit(live, {"type": "usage", "tokens": llm.add_tokens(live.meta.tokens, *live.replies.values()), "estimate": True})


def _result_usage(live: _Live, message: Any) -> None:
    """一轮说完：按结果里的数把会话的累计 token 定下来。

    结果里的 modelUsage 是这个进程（这次 query）到现在的累计，包括子 Agent；它不说自己是不是接着上一个进程的数
    往下记的（续上的会话有时会从记录里的总数接着记），所以进程的第一轮用这一轮主循环的用量判断一下：累计至少是
    "以前的 + 这一轮的"，就是接着记的；否则是从零记的，要加上以前的。没有 modelUsage 时，usage 只是这一轮的，直接加上。

    A turn has ended: settle the session's cumulative tokens from the result. The result's modelUsage is the running
    total of this process (this query) so far, subagents included. It does not say whether it carries on from the
    previous process's total (a resumed session sometimes continues from the total in its transcript), so the first turn
    of a process decides with this turn's main-loop usage: a total of at least "earlier + this turn" carries on; anything
    less started from zero and the earlier tokens are added. Without modelUsage, usage covers this turn only and is added.
    """
    per_model, usage = getattr(message, "model_usage", None), getattr(message, "usage", None)
    live.replies.clear()
    if per_model:
        current = llm.tokens_of({"modelUsage": per_model})
        if live.usage_base is None:
            before, turn = llm.add_tokens(live.meta.tokens), llm.tokens_of({"usage": usage or {}})
            carried_on = sum(current.values()) >= sum(before.values()) + sum(turn.values())
            live.usage_base = llm.add_tokens() if carried_on else before
        live.meta.tokens = llm.add_tokens(live.usage_base, current)
    elif isinstance(usage, dict):
        live.meta.tokens = llm.add_tokens(live.meta.tokens, llm.tokens_of({"usage": usage}))


TERMINAL = {"completed", "failed", "stopped", "killed"}


def _task(live: _Live, kind: str, message: Any) -> None:
    """后台任务（子 Agent、后台命令）开始、进展、结束。记下还有几个在跑，并告诉界面。

    A background task (a subagent, a background command) starts, progresses or ends. Keep count of those still running and tell the UI.
    """
    task_id = str(getattr(message, "task_id", "") or "")
    status = str(getattr(message, "status", None) or (getattr(message, "patch", None) or {}).get("status") or "")
    # 有的消息不带"属于哪一步"，按开始时记下的补上。 / Some messages do not say which step they belong to; fill it in from the start.
    tool_use_id = getattr(message, "tool_use_id", None) or live.task_steps.get(task_id)
    if kind == "TaskStartedMessage":
        live.tasks[task_id] = str(getattr(message, "description", "") or "")
        live.task_steps[task_id] = tool_use_id
        state = "started"
    elif status in TERMINAL:
        # 结束常报两次：先是状态更新，再是带结论的通知。两次都转给界面，由它合并。
        # An end is often reported twice: a state update, then a notification with the conclusion. Both go to the UI, which merges them.
        live.tasks.pop(task_id, None)
        state = "done"
    elif kind == "TaskProgressMessage":
        state = "progress"
    else:
        return
    usage = getattr(message, "usage", None) or {}
    _emit(live, {"type": "task", "task_id": task_id, "tool_use_id": tool_use_id, "state": state, "status": status or None,
                 "task_type": getattr(message, "task_type", None), "description": str(getattr(message, "description", "") or ""),
                 "last_tool": getattr(message, "last_tool_name", None), "summary": _clip(str(getattr(message, "summary", "") or ""), 1500),
                 "tool_uses": usage.get("tool_uses") if isinstance(usage, dict) else None})
    if len(live.tasks) != live.meta.tasks:
        live.meta.tasks = len(live.tasks)
        _save(live.meta)


def _begin(live: _Live, by_itself: bool) -> None:
    live.busy, live.turn_started = True, time.monotonic()
    live.turn_done.clear()
    live.meta.done_at = None
    if by_itself:
        # 没人说话它自己开了一轮：后台的子 Agent 做完了，Claude Code 收到通知接着做。
        # A turn began with nobody speaking: a background subagent finished and Claude Code carries on after its notification.
        _emit(live, {"type": "resumed", "tasks": len(live.tasks)})
    _set(live, "running")


def _end(live: _Live) -> None:
    # 记这一轮新用掉的 token，和 Claude Code 的会话编号：统计时靠它认出这一轮也在 Claude Code 自己的记录里，不重复算。
    # Log the tokens this turn added, and Claude Code's session id: the statistics use it to see that this turn is also in Claude Code's own records and not count it twice.
    spent = {k: v - int(live.logged.get(k) or 0) for k, v in llm.add_tokens(live.meta.tokens).items()}
    live.logged = dict(live.meta.tokens)
    llm.log_call("session", "claude-code", time.monotonic() - live.turn_started, {"cost_usd": None, "session": live.meta.sdk_session, **spent}, ok=True)
    # 后台还有子 Agent 在跑，这一轮说完了也不算做完：它们回来后 Claude Code 会自己接着做。
    # With subagents still running in the background, the end of a turn is not the end of the work: when they return Claude Code carries on by itself.
    done = not live.tasks
    live.meta.done_at = time.time() if done else None
    _set(live, "idle")
    live.busy, live.idle_since = False, time.monotonic()
    live.turn_done.set()
    # 只在真的做完时说一声：自己往下推的时候中间那些轮不打扰人。 / Say so only when it is really done; the turns in between while it carries on by itself do not disturb anyone.
    if done:
        notify.send("Claude Code 做完了", live.meta.title[:200], url=f"/sessions/{live.meta.id}", tag=live.meta.id)


async def _read(live: _Live, client: Any) -> None:
    """一直读 Claude Code 的输出，不按轮停。一轮说完后，后台的子 Agent 还在干活、做完了还会让 Claude Code
    自己再开一轮——这些都要读到，否则它们会积在缓冲里，混进你下一句话的那一轮。

    Read Claude Code's output continuously instead of turn by turn. After a turn ends, background subagents keep
    working, and when they finish Claude Code opens another turn by itself; all of that must be read, or it piles
    up in the buffer and gets mixed into the turn of your next message.
    """
    async for item in client.receive_messages():
        kind = type(item).__name__
        top = kind == "AssistantMessage" and not getattr(item, "parent_tool_use_id", None)
        if not live.busy and (top or (kind == "SystemMessage" and getattr(item, "subtype", "") == "init")):
            _begin(live, by_itself=True)
        _convert(live, item)
        if kind == "ResultMessage" and live.busy:
            _end(live)


async def _either(live: _Live, awaitable: Any) -> Any:
    """等一件事，但读输出的那个任务先没了就报它的错。 / Wait for something, but report the reader's error if it ends first."""
    waiter = asyncio.ensure_future(awaitable)
    assert live.reader is not None
    done, _ = await asyncio.wait({waiter, live.reader}, return_when=asyncio.FIRST_COMPLETED)
    if waiter in done:
        return waiter.result()
    waiter.cancel()
    live.reader.result()
    raise RuntimeError("Claude Code 的输出断了 / Claude Code's output ended")


async def _run(live: _Live) -> None:
    try:
        live.client = _client(live)
        async with live.client as client:
            live.reader = asyncio.get_running_loop().create_task(_read(live, client), name=f"session-read-{live.meta.id}")
            try:
                while True:
                    message = await _either(live, live.inbox.get())
                    if message is None:
                        break
                    _emit(live, {"type": "user", "text": message["text"], "images": len(message.get("images") or [])})
                    _begin(live, by_itself=False)
                    await client.query(_prompt(message) if message.get("images") else message["text"])
                    await _either(live, live.turn_done.wait())
            finally:
                live.reader.cancel()
                await asyncio.gather(live.reader, return_exceptions=True)
        # 只有主人点了"结束"才算结束；闲置超时、换代码、换模型的退出只是歇着，下一句话会接上。
        # Only the owner's "close" closes it; exits for idleness, new code or a model change are a rest, and the next message picks it up.
        if live.meta.status != "error":
            live.meta.status = "closed" if live.closing else "idle"
    except asyncio.CancelledError:
        live.meta.status = "closed" if live.closing else "idle"
        raise
    except Exception as e:  # noqa: BLE001 — 会话出错要让界面看到，不能悄悄没了 / a failing session must reach the UI, not vanish
        _emit(live, {"type": "error", "message": f"会话出错了：{e}"[:500]})
        live.meta.status = "error"
    finally:
        for future in live.pending.values():
            if not future.done():
                future.set_result({"decision": "deny", "note": "The session was closed."})
        live.meta.waiting_for = None
        _save(live.meta)
        _emit(live, {"type": "status", "status": live.meta.status, "waiting_for": None})


def _recover(meta: Meta) -> None:
    """说过话、却没有记下 SDK 会话编号的会话（旧版本要等第一轮说完才记）：按开始的时间到 Claude Code 自己的
    会话记录里把它找回来，这样重启之后还能接上原来的对话，而不是从头开始。

    A session that has spoken but has no SDK session id recorded (older versions only recorded it once the first
    turn ended): find it among Claude Code's own stored sessions by its start time, so that after a restart the
    conversation is picked up instead of starting over.
    """
    if meta.sdk_session or client_factory is not None or not events(meta.id):
        return
    try:
        from claude_agent_sdk import list_sessions

        found = list_sessions(directory=str(store.repo_root()), limit=300)
    except Exception:  # noqa: BLE001 — 找不回来就算了，当成新对话 / if it cannot be found, it is simply a new conversation
        return
    near = [s for s in found if s.created_at and abs(s.created_at / 1000 - meta.created_at) < 60]
    if near:
        meta.sdk_session = min(near, key=lambda s: abs((s.created_at or 0) / 1000 - meta.created_at)).session_id
        _save(meta)


# ---------- 会话进程这一半 / the session-process half ----------


def _inbox(session_id: str) -> Path:
    return _dir(session_id) / "inbox"


def _commands(session_id: str) -> list[Path]:
    """还没处理的命令，按写入的先后。写到一半的（临时文件）不在里面。 / Commands not yet handled, oldest first. Half-written ones (temp files) are not among them."""
    try:
        return sorted(f for f in _inbox(session_id).iterdir() if f.suffix == ".json")
    except OSError:
        return []


async def _handle(live: _Live, command: dict[str, Any]) -> None:
    kind = command.get("kind")
    if kind == "say":
        # 一收到就算"在跑"：否则界面在它真正开始之前的那一瞬间会以为它闲着，可以再发一条。
        # It counts as running the moment the message arrives; otherwise, in the instant before it really starts, the UI would think it idle and allow another message.
        live.busy = True
        live.meta.status, live.meta.done_at = "running", None
        _save(live.meta)
        await live.inbox.put({"text": str(command.get("text") or "").strip(), "images": list(command.get("images") or [])[:4]})
    elif kind == "answer":
        future = live.pending.get(str(command.get("request_id")))
        if future is not None and not future.done():
            future.set_result({"decision": command.get("decision"), "note": str(command.get("note") or ""), "answers": command.get("answers") or {}})
            await asyncio.sleep(0)
    elif kind == "interrupt":
        for future in list(live.pending.values()):
            if not future.done():
                future.set_result({"decision": "deny", "note": "The user interrupted."})
        if live.client is not None and live.busy:
            await live.client.interrupt()
        _emit(live, {"type": "interrupted"})
    elif kind == "mode" and command.get("mode") in MODES:
        live.meta.mode = command["mode"]
        _save(live.meta)
        if live.client is not None:
            await live.client.set_permission_mode(command["mode"])
        _emit(live, {"type": "mode", "mode": command["mode"]})
    elif kind == "retire" and not live.busy:
        await live.inbox.put(None)  # 换模型：歇下来，下一句话用新的配置接上 / a model change: rest, and the next message resumes with the new settings
    elif kind == "close":
        live.closing = True
        await live.inbox.put(None)
        if live.busy and live.task is not None:
            live.task.cancel()


async def _watch(live: _Live) -> None:
    """会话进程的另一半循环：读命令；顺便看自己该不该歇着了。

    The other loop of a session process: read commands, and see whether it is time to rest.
    """
    session_id, stamp, checked = live.meta.id, code_stamp(), time.monotonic()
    while True:
        for path in _commands(session_id):
            try:
                await _handle(live, json.loads(path.read_text()))
            except Exception as e:  # noqa: BLE001 — 一条坏命令不能把会话带走 / one bad command must not take the session down
                _emit(live, {"type": "error", "message": f"这一步没做成：{e}"[:500]})
            finally:
                path.unlink(missing_ok=True)
        # 后台还有子 Agent 在跑时不歇：它们做完了，Claude Code 会自己接着做一轮。
        # No rest while subagents still run in the background: when they finish, Claude Code carries on with a turn by itself.
        if not live.busy and not live.tasks and live.inbox.empty() and not _commands(session_id):
            now = time.monotonic()
            stale = False
            if now - checked > 2:
                checked, stale = now, code_stamp() > stamp
            # 闲得够久了，或者磁盘上的代码比自己新：歇着。这之后才到的命令没人读，后端发现后会另起一个进程。
            # Idle long enough, or the code on disk is newer than this process: rest. A command arriving after this is read by nobody; the backend notices and starts another process.
            if stale or now - live.idle_since > idle_exit():
                await live.inbox.put(None)
                return
        await asyncio.sleep(POLL)


async def _main(session_id: str) -> None:
    """一个会话进程的一生：占住锁，开会话循环和读命令的循环，结束时把锁放掉。

    The life of a session process: take the lock, run the session loop and the command loop, release the lock at the end.
    """
    _dir(session_id).mkdir(parents=True, exist_ok=True)
    lock = (_dir(session_id) / "runner.lock").open("a")
    for attempt in range(40):
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            # 后端探一下锁只要一瞬间；一直拿不到，就是这个会话已经有一个进程了。
            # The backend's probe of the lock lasts an instant; never getting it means this session already has a process.
            if attempt == 39:
                lock.close()
                return
            await asyncio.sleep(0.05)
    try:
        live = _Live(Meta.model_validate(store.read_json(_dir(session_id) / "meta.json", None)))
        live.meta.tasks = 0  # 上一个进程的后台任务跟着它走了 / the previous process's background tasks went with it
        store.write_json(_dir(session_id) / "runner.json", {"pid": os.getpid(), "code": code_stamp(), "started": live.started})
        live.task = asyncio.get_running_loop().create_task(_run(live), name=f"session-{session_id}")
        watcher = asyncio.get_running_loop().create_task(_watch(live), name=f"session-inbox-{session_id}")
        try:
            await live.task
        except asyncio.CancelledError:
            if not live.task.done():  # 被取消的是这个进程自己（收到了终止信号）/ it is this process that was cancelled (a termination signal)
                live.task.cancel()
                await asyncio.gather(live.task, return_exceptions=True)
        finally:
            watcher.cancel()
    finally:
        (_dir(session_id) / "runner.json").unlink(missing_ok=True)
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()
        _tasks.pop(session_id, None)


def run(session_id: str) -> None:
    """`python -m idea_loom.sessions run <编号>` 的入口。 / The entry point of `python -m idea_loom.sessions run <id>`."""
    global client_factory
    spec = os.environ.get("IDEA_LOOM_SESSION_CLIENT")
    if spec:  # 测试用：换成假的客户端，写成 "模块:名字" / for tests: a fake client, given as "module:name"
        import importlib

        module, _, attr = spec.partition(":")
        client_factory = getattr(importlib.import_module(module), attr)

    async def go() -> None:
        task = asyncio.current_task()
        assert task is not None
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
        await _main(session_id)

    asyncio.run(go())


# ---------- 后端这一半 / the backend half ----------


def _command(session_id: str, kind: str, **data: Any) -> Path:
    """把一个操作写成 inbox/ 下的一个文件。先写临时文件再改名，会话进程读到的都是完整的。

    Write one action as a file under inbox/. A temp file is written and then renamed, so the session process only ever reads whole ones.
    """
    _inbox(session_id).mkdir(parents=True, exist_ok=True)
    name = f"{time.time_ns():020d}-{secrets.token_hex(3)}"
    tmp = _inbox(session_id) / f".{name}.tmp"
    tmp.write_text(json.dumps({"kind": kind, **data}, ensure_ascii=False), encoding="utf-8")
    path = _inbox(session_id) / f"{name}.json"
    os.replace(tmp, path)
    return path


def _spawn(session_id: str) -> None:
    if client_factory is not None:
        _tasks[session_id] = asyncio.get_running_loop().create_task(_main(session_id), name=f"session-main-{session_id}")
        return
    # start_new_session：和后端脱钩，在终端里对后端按 Ctrl+C 不会连带把它带走。
    # start_new_session: detached from the backend, so Ctrl+C on the backend in a terminal does not take it along.
    with (_dir(session_id) / "runner.log").open("ab") as log:
        subprocess.Popen([sys.executable, "-m", "idea_loom.sessions", "run", session_id], start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, cwd=str(store.repo_root()))


def _count() -> int:
    try:
        return sum(1 for d in root().iterdir() if d.is_dir() and _held(d.name))
    except OSError:
        return 0


async def _gone(session_id: str, limit: float) -> bool:
    deadline = time.monotonic() + limit
    while _held(session_id):
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.02)
    return True


async def _send(session_id: str, kind: str, wake: bool = False, **data: Any) -> None:
    """发一条命令，等到会话进程收下它。进程不在：wake 时把它拉起来，否则说它没在跑。

    Send a command and wait until the session process has taken it. With no process: start one when `wake` is set, otherwise report that it is not running.
    """
    path = _command(session_id, kind, **data)
    spawned, deadline = 0.0, time.monotonic() + 30
    while path.exists():
        now = time.monotonic()
        if not _held(session_id):
            if not wake:
                path.unlink(missing_ok=True)
                raise SessionError("这个会话现在没有在跑")
            if now - spawned > 10:
                _spawn(session_id)
                spawned = now
        if now > deadline:
            path.unlink(missing_ok=True)
            raise SessionError(f"会话进程没有响应，看 runs/sessions/{session_id}/runner.log")
        await asyncio.sleep(0.02)


def _wake_checks(meta: Meta) -> None:
    if meta.live:
        return
    if _count() >= MAX_LIVE:
        raise SessionError(f"同时最多开 {MAX_LIVE} 个会话，先结束一个")
    _recover(meta)


class NewSession(BaseModel):
    text: str
    title: str = ""
    mode: Mode = "plan"
    wish_id: Optional[str] = None
    images: list[dict[str, str]] = Field(default_factory=list)
    model: str = ""
    effort: str = "high"


async def start(request: NewSession) -> Meta:
    reason = available()
    if reason:
        raise SessionError(reason)
    if not request.text.strip():
        raise SessionError("第一句话不能空")
    if _count() >= MAX_LIVE:
        raise SessionError(f"同时最多开 {MAX_LIVE} 个会话，先结束一个")  # 先查，别留下一个开不起来的空会话 / checked first, so no empty session that could not start is left behind
    session_id = f"s-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"
    if request.model and request.model not in MODELS:
        raise SessionError("模型只能是：" + "、".join(MODELS))
    if request.effort not in EFFORTS:
        raise SessionError("努力程度只能是：" + "、".join(EFFORTS))
    meta = Meta(id=session_id, title=(request.title.strip() or request.text.strip().splitlines()[0])[:80], wish_id=request.wish_id, mode=request.mode,
                model=request.model or default_model(), effort=request.effort, created_at=time.time(), updated_at=time.time())
    _dir(session_id).mkdir(parents=True, exist_ok=True)
    _save(meta)
    await _send(session_id, "say", wake=True, text=request.text, images=request.images[:4])
    return get(session_id)


async def say(session_id: str, text: str, images: Optional[list[dict[str, str]]] = None) -> Meta:
    reason = available()
    if reason:
        raise SessionError(reason)
    meta = get(session_id)
    if not text.strip():
        raise SessionError("要说点什么")
    if meta.status in ("running", "waiting"):
        raise SessionError("它还在忙：等它说完，或者先打断" if meta.status == "running" else "它在等你回答上面那一条")
    _wake_checks(meta)  # 进程不在了就用存着的会话编号接上 / resumes with the stored session id when the process is gone
    await _send(session_id, "say", wake=True, text=text, images=(images or [])[:4])
    return get(session_id)


def _open_requests(session_id: str) -> set[str]:
    rows = events(session_id)
    return {str(e.get("request_id")) for e in rows if e.get("type") == "request"} - {str(e.get("request_id")) for e in rows if e.get("type") == "resolved"}


async def answer(session_id: str, request_id: str, decision: str, note: str = "", answers: Optional[dict[str, Any]] = None) -> Meta:
    if decision not in ("allow", "allow_always", "deny", "answer", "approve", "approve_edits", "approve_auto", "reject"):
        raise SessionError("不认识的回答")
    if request_id not in _open_requests(session_id) or not _held(session_id):
        raise SessionError("这一条已经回答过了，或者会话已经不在等它")
    await _send(session_id, "answer", request_id=request_id, decision=decision, note=note, answers=answers or {})
    for _ in range(40):  # 等它把这一条记成"已回答" / wait for it to record this one as answered
        if request_id not in _open_requests(session_id):
            break
        await asyncio.sleep(0.025)
    return get(session_id)


async def interrupt(session_id: str) -> Meta:
    get(session_id)
    await _send(session_id, "interrupt")
    return get(session_id)


async def set_mode(session_id: str, mode: str) -> Meta:
    if mode not in MODES:
        raise SessionError("模式只能是：" + "、".join(MODES))
    meta = get(session_id)
    if meta.live:
        try:
            await _send(session_id, "mode", mode=mode)
            return get(session_id)
        except SessionError:
            meta = get(session_id)  # 正好在这一刻歇下了：直接记下 / it rested at this very moment: record it directly
    # 会话进程不在时由后端来写；它在的时候只有它自己写 meta.json。
    # The backend writes when there is no session process; while there is one, only it writes meta.json.
    meta.mode = mode  # type: ignore[assignment]
    return _save(meta)


async def set_engine(session_id: str, model: str, effort: str) -> Meta:
    """换模型或努力程度。要在它闲着的时候换：让现在的进程歇下来，下一句话用新的配置接上同一段对话。

    Change the model or the effort. Done while it is idle: the current process is told to rest and the next message picks the same conversation up with the new settings.
    """
    if model not in MODELS:
        raise SessionError("模型只能是：" + "、".join(MODELS))
    if effort not in EFFORTS:
        raise SessionError("努力程度只能是：" + "、".join(EFFORTS))
    meta = get(session_id)
    if meta.status in ("running", "waiting"):
        raise SessionError("它在忙的时候不能换，等它说完或者先打断")
    if meta.live:
        if not meta.sdk_session:
            raise SessionError("这个会话还没开始说话，等它说完第一句再换")
        try:
            await _send(session_id, "retire")
        except SessionError:
            pass
        if not await _gone(session_id, 15):
            raise SessionError("它没能歇下来，过一会儿再换")
        meta = get(session_id)
    meta.model, meta.effort, meta.model_used = model, effort, None
    if meta.status == "closed":
        meta.status = "idle"
    return _save(meta)


async def close(session_id: str) -> Meta:
    get(session_id)
    if _held(session_id):
        try:
            await _send(session_id, "close")
        except SessionError:
            pass
        if not await _gone(session_id, 10):
            # 好好说不听，就让它停：先是终止信号，再不行就强杀它那一组进程。
            # It did not go when asked, so it is stopped: a termination signal first, then killing its process group.
            task = _tasks.get(session_id)
            pid = (store.read_json(_dir(session_id) / "runner.json", None) or {}).get("pid")
            for sig in (signal.SIGTERM, signal.SIGKILL):
                if task is not None:
                    task.cancel()
                elif pid and pid != os.getpid():
                    try:
                        os.killpg(int(pid), sig)
                    except (ProcessLookupError, PermissionError):
                        pass
                if await _gone(session_id, 3):
                    break
    for path in _commands(session_id):
        path.unlink(missing_ok=True)
    meta = get(session_id)
    meta.status, meta.waiting_for = "closed", None
    return _save(meta)


if __name__ == "__main__":
    # 用包里的那一份来跑，免得 __main__ 和 idea_loom.sessions 各有一套全局变量。
    # Run the packaged copy, so that __main__ and idea_loom.sessions do not each hold their own globals.
    from idea_loom import sessions as _packaged

    if len(sys.argv) == 3 and sys.argv[1] == "run":
        _packaged.run(sys.argv[2])
    else:
        raise SystemExit("用法 / usage: python -m idea_loom.sessions run <编号 / id>")
