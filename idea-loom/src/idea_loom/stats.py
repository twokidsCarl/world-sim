"""统计：每个项目花了多少 token、有多少合并请求、多少行代码；Claude Code 每次运行了多久、
做了多少、什么时候停的；你在界面里把注意力放在了哪里。

token 和运行情况读的是本机 Claude Code 的会话记录（~/.claude/projects 下属于这个仓库的那些）。
只在本机读、只返回汇总的数字，不进 git。

Statistics: tokens, pull requests and lines of code per project; how long each Claude
Code session ran, how much it did and when it stopped; and where your attention went
in the UI. Tokens and runs come from the local Claude Code transcripts under
~/.claude/projects that belong to this repository. They are read on this machine, only
aggregates are returned, and nothing goes into git.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

from pydantic import BaseModel, Field

from . import github, ideas, llm, ops, store, trail

UNASSIGNED = "(未归属)"
GAP_SECONDS = 300  # 两条记录隔了这么久，就算中间停下了 / a gap this long between records counts as a stop
SKIP_CODE = re.compile(r"(^|/)(bun\.lock|uv\.lock|package-lock\.json|types\.gen\.ts|schema\.json)$|\.(jsonl?|svg|glb|obj|lock|map|csv|tsv|txt)$|(^|/)(public|data|dist|corpus)/")
LANG = {".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".css": "CSS", ".md": "Markdown",
        ".html": "HTML", ".sh": "Shell", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".wgsl": "WGSL", ".rs": "Rust"}


class Tokens(BaseModel):
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0
    messages: int = 0

    def add(self, usage: dict[str, Any]) -> None:
        self.input += int(usage.get("input_tokens") or 0)
        self.output += int(usage.get("output_tokens") or 0)
        self.cache_read += int(usage.get("cache_read_input_tokens") or 0)
        self.cache_write += int(usage.get("cache_creation_input_tokens") or 0)
        self.messages += 1


class Segment(BaseModel):
    """一段连续的运行，到下一次停下为止。 / One stretch of continuous running, up to the next stop."""

    start: str
    end: str
    seconds: float
    output_tokens: int


class Session(BaseModel):
    id: str
    project: str
    title: str = ""  # 第一句用户输入的开头 / the start of the first user prompt
    first_at: str
    last_at: str
    active_seconds: float
    prompts: int
    tool_calls: int
    subagents: int
    tokens: Tokens
    segments: list[Segment]


class ProjectStats(BaseModel):
    dir: str
    tokens: Tokens = Field(default_factory=Tokens)
    sessions: int = 0
    active_seconds: float = 0
    prs: int = 0
    merged: int = 0
    first_pr_at: Optional[str] = None
    last_pr_at: Optional[str] = None
    median_merge_seconds: Optional[float] = None
    additions: int = 0
    deletions: int = 0
    lines: int = 0
    files: int = 0
    by_language: dict[str, int] = Field(default_factory=dict)
    tokens_per_line: Optional[float] = None
    tokens_per_pr: Optional[float] = None


class DayPoint(BaseModel):
    day: str
    project: str
    merged: int = 0
    additions: int = 0
    output_tokens: int = 0


class IdeaAttention(BaseModel):
    id: str
    title: str
    seconds: float = 0
    opens: int = 0
    last_at: Optional[str] = None


class Attention(BaseModel):
    total_seconds: float = 0
    by_page: dict[str, float] = Field(default_factory=dict)
    ideas: list[IdeaAttention] = Field(default_factory=list)
    never_opened: list[str] = Field(default_factory=list)
    cells: dict[str, dict[str, float]] = Field(default_factory=dict)  # 层 -> 横线 -> 秒 / level -> thread -> seconds
    by_level: dict[str, float] = Field(default_factory=dict)
    by_kernel: dict[str, float] = Field(default_factory=dict)
    clicks: int = 0
    questions: int = 0
    feature_uses: dict[str, int] = Field(default_factory=dict)
    proposals_kept: int = 0
    proposals_dropped: int = 0
    days: int = 0


class OwnCalls(BaseModel):
    """idea-loom 自己调用模型的用量。 / What idea-loom's own model calls used."""

    calls: int = 0
    cost_usd: float = 0
    output_tokens: int = 0
    by_purpose: dict[str, int] = Field(default_factory=dict)


class Stats(BaseModel):
    generated_at: str
    projects: list[ProjectStats]
    sessions: list[Session]
    days: list[DayPoint]
    totals: Tokens
    attention: Attention
    own: OwnCalls
    transcripts_found: bool
    notes: list[str] = Field(default_factory=list)


# ---------- 会话记录 / transcripts ----------


def transcripts_root() -> Path:
    override = os.environ.get("IDEA_LOOM_TRANSCRIPTS")
    return Path(override) if override else Path.home() / ".claude" / "projects"


def _slug(path: Path) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def transcript_files(repo: Path) -> list[tuple[str, Path]]:
    """（会话编号，文件）。子代理的记录算在它所属的会话上。 / (session id, file); a subagent's records count toward its parent session."""
    out = []
    slug = _slug(repo.resolve())
    for directory in sorted(transcripts_root().glob(slug + "*")) if transcripts_root().exists() else []:
        if not directory.is_dir() or not (directory.name == slug or directory.name.startswith(slug + "-")):
            continue
        for f in directory.glob("*.jsonl"):
            out.append((f.stem, f))
        for f in directory.glob("*/**/*.jsonl"):
            out.append((f.relative_to(directory).parts[0], f))
    return out


def project_of(cwd: str, repo: str, known: set[str]) -> Optional[str]:
    if not cwd.startswith(repo):
        return None
    first = cwd[len(repo):].strip("/").split("/")[0]
    return first if first in known else None


def _ts(text: str) -> Optional[float]:
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def _is_prompt(obj: dict[str, Any]) -> Optional[str]:
    """一条真正由人输入的话（不是工具结果，不是系统插入的）。 / A line really typed by a person."""
    if obj.get("type") != "user" or obj.get("isSidechain") or obj.get("isMeta"):
        return None
    content = (obj.get("message") or {}).get("content")
    if isinstance(content, list):
        if any(isinstance(x, dict) and x.get("type") == "tool_result" for x in content):
            return None
        content = "\n".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
    if not isinstance(content, str) or not content.strip():
        return None
    text = content.strip()
    if text.startswith(("<local-command", "<task-notification", "<system-reminder", "Another Claude session", "[SYSTEM", "<command-name>")) and "<command-args>" not in text:
        return None
    args = re.search(r"<command-args>(.*?)</command-args>", text, re.S)
    if args:
        text = args.group(1).strip()
    return text or None


def read_sessions(repo: Path, known: set[str], assigned: dict[str, str]) -> tuple[list[Session], dict[str, Tokens], dict[tuple[str, str], int]]:
    """读全部会话记录。返回（会话，每个项目的 token，每天每个项目的输出 token）。

    Read every transcript. Returns (sessions, tokens per project, output tokens per day and project).
    """
    repo_str = str(repo.resolve())
    seen: dict[str, list[tuple[int, str, int]]] = defaultdict(list)  # 回复编号 -> [(输出 token, 会话, 第几条记录)] / reply id -> [(output tokens, session, record index)]
    tool_ids: set[str] = set()
    per_session: dict[str, dict[str, Any]] = {}
    for session_id, path in transcript_files(repo):
        s = per_session.setdefault(session_id, {"records": [], "prompts": [], "tools": 0, "subagents": set(), "cwd_projects": Counter()})
        is_sub = path.stem != session_id
        try:
            handle = path.open(encoding="utf-8", errors="replace")
        except OSError:
            continue
        with handle:
            for line in handle:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(obj, dict):
                    continue
                at = _ts(obj.get("timestamp", ""))
                if at is None:
                    continue
                project = project_of(str(obj.get("cwd") or ""), repo_str, known)
                if project:
                    s["cwd_projects"][project] += 1
                if is_sub:
                    s["subagents"].add(path.stem)
                elif (prompt := _is_prompt(obj)) is not None:
                    s["prompts"].append((at, prompt))
                message = obj.get("message") if isinstance(obj.get("message"), dict) else {}
                for block in message.get("content") or [] if isinstance(message.get("content"), list) else []:
                    if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id") not in tool_ids:
                        tool_ids.add(block.get("id"))
                        s["tools"] += 1
                usage = message.get("usage") if isinstance(message.get("usage"), dict) else None
                if usage is not None:
                    # 一条回复会按内容块拆成几条记录，续接的会话里还会再出现；每条回复只算一次，
                    # 取输出最多的那条，一样多时算在开始得更早的那个会话上。
                    # One reply is split into several records by content block and shows up again in resumed
                    # sessions; count each reply once, taking the record with the most output and, on a tie,
                    # the session that started earlier.
                    seen[str(message.get("id") or obj.get("uuid"))].append((int(usage.get("output_tokens") or 0), session_id, len(s["records"])))
                s["records"].append([at, obj.get("timestamp"), project, usage, str(message.get("id") or obj.get("uuid")) if usage is not None else None])
    started = {sid: min((r[0] for r in s["records"]), default=0.0) for sid, s in per_session.items()}
    best = {key: max(found, key=lambda c: (c[0], -started[c[1]], -c[2]))[1:] for key, found in seen.items()}
    for session_id, s in per_session.items():
        for index, record in enumerate(s["records"]):
            if record[4] is not None and best[record[4]] != (session_id, index):
                record[3] = None

    sessions: list[Session] = []
    by_project: dict[str, Tokens] = defaultdict(Tokens)
    by_day: dict[tuple[str, str], int] = defaultdict(int)
    for session_id, s in per_session.items():
        records = sorted(s["records"], key=lambda r: r[0])
        if not records:
            continue
        total = sum(s["cwd_projects"].values())
        top = s["cwd_projects"].most_common(1)
        # 从根目录启动的会话：大部分记录落在哪个子目录就归哪个；说不清的单列。
        # A session started at the root goes to the subdirectory most of its records fall in; otherwise it stays unassigned.
        home = assigned.get(session_id) or (top[0][0] if top and top[0][1] >= 0.6 * total else UNASSIGNED)
        tokens = Tokens()
        segments: list[Segment] = []
        seg_start = prev = records[0][0]
        seg_start_text = prev_text = records[0][1]
        seg_out = 0
        active = 0.0
        for at, text, project, usage, _ in records:
            if at - prev > GAP_SECONDS:
                segments.append(Segment(start=seg_start_text, end=prev_text, seconds=round(prev - seg_start, 1), output_tokens=seg_out))
                active += prev - seg_start
                seg_start, seg_start_text, seg_out = at, text, 0
            prev, prev_text = at, text
            if usage is not None:
                target = project or home
                tokens.add(usage)
                by_project[target].add(usage)
                out = int(usage.get("output_tokens") or 0)
                seg_out += out
                by_day[(datetime.fromtimestamp(at).strftime("%Y-%m-%d"), target)] += out
        segments.append(Segment(start=seg_start_text, end=prev_text, seconds=round(prev - seg_start, 1), output_tokens=seg_out))
        active += prev - seg_start
        prompts = sorted(s["prompts"])
        sessions.append(Session(
            id=session_id, project=home, title=(prompts[0][1].splitlines()[0][:80] if prompts else ""),
            first_at=records[0][1], last_at=records[-1][1], active_seconds=round(active, 1), prompts=len(prompts),
            tool_calls=s["tools"], subagents=len(s["subagents"]), tokens=tokens, segments=segments,
        ))
    sessions.sort(key=lambda x: x.last_at, reverse=True)
    return sessions, by_project, by_day


# ---------- 代码量 / lines of code ----------


def code_lines(repo: Path, ref: str = "origin/main") -> dict[str, dict[str, Any]]:
    """每个顶层目录被跟踪的代码行数，不算依赖、数据、生成的文件。

    Tracked lines of code per top-level directory, leaving out dependencies, data and generated files.
    """
    proc = subprocess.run(["git", "-C", str(repo), "grep", "-I", "-c", "", ref, "--", "."], capture_output=True, text=True)
    out: dict[str, dict[str, Any]] = {}
    for line in proc.stdout.splitlines():
        try:
            _, path, count = line.rsplit(":", 2)[0].split(":", 1)[0], line[len(ref) + 1:].rsplit(":", 1)[0], int(line.rsplit(":", 1)[1])
        except (ValueError, IndexError):
            continue
        if SKIP_CODE.search(path) or "/" not in path:
            continue
        top = path.split("/")[0]
        language = LANG.get(Path(path).suffix.lower())
        if language is None:
            continue
        entry = out.setdefault(top, {"lines": 0, "files": 0, "by_language": Counter()})
        entry["lines"] += count
        entry["files"] += 1
        entry["by_language"][language] += count
    return out


# ---------- 注意力 / attention ----------


def attention(actions: Iterable[dict[str, Any]]) -> Attention:
    pool, _, _, _ = ideas.current()
    live = {i.id: i for i in pool.values() if i.status in ideas.LIVE}
    a = Attention(cells={lv: {t: 0.0 for t in ideas.THREADS} for lv in ideas.LEVELS})
    per_idea: dict[str, IdeaAttention] = {}
    days: set[str] = set()
    for row in actions:
        kind, at = row.get("kind"), str(row.get("at", ""))
        days.add(at[:10])
        if kind == "click":
            a.clicks += 1
        elif kind == "ask":
            a.questions += 1
        elif kind == "navigate" and row.get("idea") in pool:
            item = per_idea.setdefault(row["idea"], IdeaAttention(id=row["idea"], title=pool[row["idea"]].title))
            item.opens += 1
            item.last_at = max(item.last_at or "", at)
        elif kind in ("dwell", "play"):
            # play 页上一张卡的观看时间，也算到它所属的 idea 上。
            # Time spent on a card of the play page also counts toward the idea it belongs to.
            seconds = float(row.get("seconds") or 0)
            a.total_seconds += seconds
            page = "/play" if kind == "play" else "/" + str(row.get("url", "")).split("?")[0].strip("/").split("/")[0]
            a.by_page[page] = round(a.by_page.get(page, 0) + seconds, 1)
            idea = pool.get(str(row.get("idea") or ""))
            if idea is not None:
                item = per_idea.setdefault(idea.id, IdeaAttention(id=idea.id, title=idea.title))
                item.seconds = round(item.seconds + seconds, 1)
                item.last_at = max(item.last_at or "", at)
                a.by_level[idea.level] = round(a.by_level.get(idea.level, 0) + seconds, 1)
                if idea.kernel:
                    a.by_kernel[idea.kernel] = round(a.by_kernel.get(idea.kernel, 0) + seconds, 1)
                for t in idea.threads:
                    a.cells[idea.level][t] = round(a.cells[idea.level][t] + seconds / len(idea.threads), 1)
    a.total_seconds = round(a.total_seconds, 1)
    a.ideas = sorted(per_idea.values(), key=lambda i: -i.seconds)
    a.never_opened = sorted((i for i in live if i not in per_idea), key=ideas.sort_key)
    a.days = len(days - {""})
    for p in ops.load():
        a.proposals_kept += p.status == "accepted"
        a.proposals_dropped += p.status == "dismissed"
    return a


def own_calls() -> OwnCalls:
    rows, _ = store.read_lines(llm.runs_dir() / "llm.jsonl")
    o = OwnCalls()
    purposes: Counter[str] = Counter()
    for r in rows:
        if not r.get("ok"):
            continue
        o.calls += 1
        o.cost_usd += float(r.get("cost_usd") or 0)
        o.output_tokens += int(r.get("output_tokens") or 0)
        purposes[str(r.get("purpose") or "其它")] += 1
    o.cost_usd = round(o.cost_usd, 4)
    o.by_purpose = dict(purposes)
    return o


# ---------- 汇总 / putting it together ----------

_cache: dict[str, tuple[float, Stats]] = {}


def _median(values: list[float]) -> Optional[float]:
    if not values:
        return None
    values = sorted(values)
    mid = len(values) // 2
    return values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2


def compute(force: bool = False) -> Stats:
    repo = store.repo_root()
    hit = _cache.get(str(repo))
    if hit and not force and time.time() - hit[0] < 60:
        return hit[1]
    projects = ideas.load_projects()
    known = {p.dir for p in projects} | {p.name for p in repo.iterdir() if p.is_dir() and not p.name.startswith(".") and (p / "README.md").exists()}
    assigned = store.read_json(store.data_dir() / "sessions.json", {})
    sessions, tokens_by_project, tokens_by_day = read_sessions(repo, known, assigned if isinstance(assigned, dict) else {})
    prs = github.pull_requests()
    code = code_lines(repo)

    names = sorted(known | {s.project for s in sessions} | {p.scope for p in prs if p.scope})
    out: list[ProjectStats] = []
    for name in names:
        mine = [p for p in prs if p.scope == name]
        merged = [p for p in mine if p.merged_at]
        waits = [b - a for p in merged if (a := _ts(p.created_at)) is not None and (b := _ts(p.merged_at or "")) is not None]
        c = code.get(name, {"lines": 0, "files": 0, "by_language": {}})
        own = [s for s in sessions if s.project == name]
        tok = tokens_by_project.get(name, Tokens())
        stat = ProjectStats(
            dir=name, tokens=tok, sessions=len(own), active_seconds=round(sum(s.active_seconds for s in own), 1),
            prs=len(mine), merged=len(merged), first_pr_at=min((p.created_at for p in mine), default=None),
            last_pr_at=max((p.merged_at or p.created_at for p in mine), default=None), median_merge_seconds=_median(waits),
            additions=sum(p.additions for p in merged), deletions=sum(p.deletions for p in merged),
            lines=c["lines"], files=c["files"], by_language=dict(c["by_language"]),
        )
        if stat.lines and tok.output:
            stat.tokens_per_line = round(tok.output / stat.lines, 1)
        if stat.merged and tok.output:
            stat.tokens_per_pr = round(tok.output / stat.merged)
        if stat.prs or stat.lines or tok.messages or stat.sessions:
            out.append(stat)
    out.sort(key=lambda p: -p.tokens.output)

    days: dict[tuple[str, str], DayPoint] = {}
    for (day, project), n in tokens_by_day.items():
        days.setdefault((day, project), DayPoint(day=day, project=project)).output_tokens += n
    for p in prs:
        if p.merged_at and (at := _ts(p.merged_at)) is not None:
            point = days.setdefault((datetime.fromtimestamp(at).strftime("%Y-%m-%d"), p.scope or UNASSIGNED),
                                    DayPoint(day=datetime.fromtimestamp(at).strftime("%Y-%m-%d"), project=p.scope or UNASSIGNED))
            point.merged += 1
            point.additions += p.additions

    totals = Tokens()
    for t in tokens_by_project.values():
        totals.input += t.input
        totals.output += t.output
        totals.cache_read += t.cache_read
        totals.cache_write += t.cache_write
        totals.messages += t.messages
    notes = []
    if not sessions:
        notes.append("这台机器上没有找到这个仓库的 Claude Code 会话记录，token 和运行统计是空的。")
    if not prs:
        notes.append("读不到 GitHub 上的合并请求（gh 没有登录或没有网络），PR 统计是空的。")
    unassigned = tokens_by_project.get(UNASSIGNED)
    if unassigned and totals.output and unassigned.output / totals.output > 0.05:
        notes.append(f"有 {unassigned.output / totals.output:.0%} 的输出 token 来自从根目录启动、说不清属于哪个项目的会话，列在「{UNASSIGNED}」里。可以在 data/sessions.json 里按会话编号指定项目。")
    result = Stats(
        generated_at=datetime.now().astimezone().isoformat(timespec="seconds"), projects=out, sessions=sessions,
        days=sorted(days.values(), key=lambda d: (d.day, d.project)), totals=totals, attention=attention(trail.load()),
        own=own_calls(), transcripts_found=bool(sessions), notes=notes,
    )
    _cache[str(repo)] = (time.time(), result)
    return result
