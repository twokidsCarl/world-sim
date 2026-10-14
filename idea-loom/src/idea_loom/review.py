"""回看：让模型读一遍你最近在界面里的操作，看出这个工具哪里让你费劲了，并给每条发现打重要程度。

攒够 DUE_AFTER 条操作，后台就自己回看一次（也可以在许愿池页手动"现在回看"）。重要的
（importance ≥ RECORD_AT）直接记进许愿池，来源是 review；其余的丢掉。每次回看都在
runs/reviews.jsonl 里留一笔：记了什么、丢了什么、为什么丢，丢掉的你还可以捞回来。

Review: have the model read your recent actions in the UI, find where this tool gets in
your way, and rate how important each finding is. Once DUE_AFTER actions have piled up
the backend reviews by itself (the wish page also has "review now"). Important findings
(importance ≥ RECORD_AT) go straight into the wish pool with the source "review"; the
rest are dropped. Every review leaves an entry in runs/reviews.jsonl: what was recorded,
what was dropped and why, and a dropped finding can still be rescued.
"""

from __future__ import annotations

import secrets
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel

from . import llm, notify, stats, store, trail, wishes

DUE_AFTER = 300  # 攒够这么多条操作就自己回看一次 / review by itself once this many actions have piled up
MIN_ACTIONS = 10  # 少于这么多条不回看 / too few actions to review
RECORD_AT = 4  # 重要程度到这个分数就直接记进许愿池（1–5） / importance from which a finding is recorded straight away (1–5)
MAX_FINDINGS = 5  # 一次最多看几条发现 / at most this many findings per review
CHECK_EVERY = 60.0  # 自动检查最多隔这么久做一次（秒），免得每次记操作都读整条轨迹 / check at most this often (s), so recording actions does not reread the whole trail each time
RETRY_AFTER = 3600.0  # 回看失败后隔这么久才自动再试（秒） / after a failed review, wait this long before trying again by itself (s)
LOG_SHOWN = 10  # 页面上列最近几次 / how many recent reviews the page lists

Trigger = Literal["auto", "manual"]


class Finding(BaseModel):
    """一条发现：模型提的愿望，加上它打的重要程度和理由。 / One finding: the wish the model proposes, with its importance and reason."""

    title: str
    kind: str
    stuck: str = ""
    suggestion: str = ""
    evidence: str = ""  # 它是从哪些操作里看出来的 / which actions it was drawn from
    importance: int = 1  # 1（无所谓）到 5（很要紧） / 1 (does not matter) to 5 (matters a lot)
    reason: str = ""  # 为什么是这个分数 / why this score
    wish_id: Optional[str] = None  # 记进许愿池了的话是哪一条 / the wish it became, if recorded
    rescued: bool = False  # 本来丢了，后来你捞回来了 / dropped at first, then rescued by you


class ReviewRun(BaseModel):
    id: str
    at: str
    trigger: Trigger = "manual"
    actions: int = 0  # 这次读了多少条操作 / how many actions this review read
    findings: list[Finding] = []
    error: str = ""


class ReviewStatus(BaseModel):
    actions_since: int
    due: bool
    due_after: int = DUE_AFTER
    record_at: int = RECORD_AT
    running: bool = False
    auto: bool = False  # 这里能不能自己回看（要有模型可用） / whether reviews can run by themselves here (needs a model)
    last_at: str | None = None
    runs: list[ReviewRun] = []  # 最近几次，新的在前 / the most recent reviews, newest first


class ReviewError(ValueError):
    """这次回看做不了，原因写给人看。 / This review cannot be run; the message is for a person."""


_running = threading.Lock()  # 同一时间只跑一次回看 / only one review at a time
_thread: Optional[threading.Thread] = None
_checked_at = 0.0


def _ts(text: str) -> float | None:
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def state_path() -> Path:
    return llm.runs_dir() / "review.json"


def log_path() -> Path:
    return llm.runs_dir() / "reviews.jsonl"


def _state() -> dict[str, Any]:
    return store.read_json(state_path(), {})


def _since(actions: list[dict[str, Any]], last: Optional[str]) -> int:
    cut = _ts(last) if last else None
    # 浏览器记的时间是 UTC，后端记的带本地时区，所以要化成时刻再比。
    # The browser records UTC and the backend a local offset, so compare instants, not strings.
    return sum(1 for a in actions if cut is None or (_ts(str(a.get("at", ""))) or 0) > cut)


def runs() -> list[ReviewRun]:
    """回看记录，新的在前。 / The review log, newest first."""
    out: dict[str, ReviewRun] = {}
    for row in store.read_lines(log_path())[0]:
        rid = str(row.get("id") or "")
        if row.get("event") == "reviewed":
            out[rid] = ReviewRun(**{k: v for k, v in row.items() if k in ReviewRun.model_fields})
        elif row.get("event") == "rescued" and rid in out:
            i = int(row.get("index") or 0)
            if 0 <= i < len(out[rid].findings):
                out[rid].findings[i].wish_id, out[rid].findings[i].rescued = row.get("wish_id"), True
    return sorted(out.values(), key=lambda r: _ts(r.at) or 0, reverse=True)


def status() -> ReviewStatus:
    last = _state().get("last_at")
    since = _since(trail.load(), last)
    return ReviewStatus(actions_since=since, due=since >= DUE_AFTER, running=_running.locked(), auto=llm.available(),
                        last_at=last, runs=runs()[:LOG_SHOWN])


def digest(actions: list[dict[str, Any]], limit: int = 400) -> str:
    """把操作轨迹压成模型读得动的一段：最近的若干条，加上几个汇总。 / Compress the trail into something the model can read."""
    recent = actions[-limit:]
    lines = []
    for a in recent:
        extra = f"（停了 {float(a.get('seconds') or 0):.0f} 秒）" if a.get("kind") == "dwell" else ""
        lines.append(f"{str(a.get('at', ''))[5:19]} {a.get('kind')} {str(a.get('url', ''))[:50]} {str(a.get('text', ''))[:80]}{extra}")
    clicks = Counter(str(a.get("text", "")) for a in actions if a.get("kind") == "click").most_common(15)
    errors = Counter(str(a.get("text", "")) for a in actions if a.get("kind") == "error").most_common(10)
    att = stats.attention(actions)
    parts = [
        f"一共 {len(actions)} 条操作，跨 {att.days} 天，在前台看了 {att.total_seconds / 60:.0f} 分钟，点了 {att.clicks} 次，问了小助手 {att.questions} 次。",
        "各页面停留（秒）：" + "、".join(f"{k} {v:.0f}" for k, v in sorted(att.by_page.items(), key=lambda kv: -kv[1])),
        "点得最多的：" + ("、".join(f"{t}×{n}" for t, n in clicks) or "（没有）"),
        "接口报错：" + ("、".join(f"{t}×{n}" for t, n in errors) or "（没有）"),
        f"候选留下 {att.proposals_kept} 条，没要 {att.proposals_dropped} 条。从没打开过的 idea 有 {len(att.never_opened)} 条。",
        "", "最近的操作（从早到晚）：", *lines,
    ]
    return "\n".join(parts)


def known() -> str:
    """许愿池里已有的愿望（各种状态都算），和以前回看时丢掉的，免得模型重复提。

    Wishes already in the pool (in any status) and findings dropped by earlier reviews, so the model does not repeat them.
    """
    pool = [f"- {w.title}（{w.status_label}）" for w in wishes.listing(group="all").wishes[:150]]
    out = "许愿池里已有的（各种状态都算）：\n" + ("\n".join(pool) or "（还没有）")
    dropped = [f.title for r in runs() for f in r.findings if f.wish_id is None][:20]
    if dropped:
        out += "\n\n以前回看时判为不重要、丢掉的：\n" + "\n".join(f"- {t}" for t in dropped)
    return out


SCHEMA = {
    "type": "object",
    "properties": {"wishes": {"type": "array", "items": {
        "type": "object",
        "properties": {"title": {"type": "string"}, "kind": {"type": "string"}, "stuck": {"type": "string"}, "suggestion": {"type": "string"},
                       "evidence": {"type": "string"}, "importance": {"type": "integer", "minimum": 1, "maximum": 5}, "reason": {"type": "string"}},
        "required": ["title", "kind", "stuck", "suggestion", "evidence", "importance", "reason"],
    }}},
    "required": ["wishes"],
}
SYSTEM = f"""你在帮一个人改进他自己用的工具 idea-loom（中文名「想法经纬」；world-sim 仓库的想法池界面：左侧菜单是无尽探索、想法（地图、列表、生成与候选、血缘四个视图）、开发、许愿池、自我进化（网页里的 Claude Code 会话）、统计，右侧有小助手）。
下面是他最近在这个界面里的操作记录。请从中看出这个工具哪里让他费劲了，提出最多 {MAX_FINDINGS} 条改进愿望，并给每条打重要程度。

要求：
- 只提从记录里看得出依据的。例如：在两页之间来回跳、同一个按钮反复点、某个接口总报错、某个功能从没用过、某类页面停留很久却没有后续操作。看不出什么就给空列表，不要硬凑。
- 每条说清楚：他卡在哪（stuck）、建议怎么改（suggestion）、你是从哪些操作里看出来的（evidence）。
- kind 从这些里选：unclear（界面不清楚）、missing（缺功能）、broken（出错）、structure（想法池的结构该改）、other。
- importance 是 1 到 5 的整数：5 = 经常卡住或出错，改了天天受益；4 = 明显费劲、反复出现；3 = 偶尔不顺；2 = 小毛病；1 = 只是猜测、依据很弱。
  {RECORD_AT} 分及以上的会直接记进许愿池，其余的丢掉，所以要严格：拿不准就给低分。reason 用一句话说为什么是这个分。
- 不要和"许愿池里已有的"重复；以前丢掉的，除非这次的依据明显更强，也不要再提。
- 用中文，平实，短。"""


def _new_id() -> str:
    return f"rev-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(2)}"


def _findings(value: Any) -> list[Finding]:
    out = []
    for x in value.get("wishes", []) if isinstance(value, dict) else []:
        if isinstance(x, dict) and str(x.get("title", "")).strip() and x.get("kind") in wishes.KIND_LABELS:
            try:
                importance = min(5, max(1, int(x.get("importance") or 1)))
            except (TypeError, ValueError):
                importance = 1
            out.append(Finding(title=str(x["title"]).strip(), kind=x["kind"], stuck=str(x.get("stuck", "")).strip(),
                               suggestion=str(x.get("suggestion", "")).strip(), evidence=str(x.get("evidence", "")).strip(),
                               importance=importance, reason=str(x.get("reason", "")).strip()))
    return out[:MAX_FINDINGS]


def _record(f: Finding) -> str:
    return wishes.record(title=f.title, kind=f.kind, stuck=f.stuck, suggestion=f.suggestion, by="review",
                         question=f"（回看操作轨迹时提出的；重要程度 {f.importance}：{f.reason}）")


def _review(trigger: Trigger) -> ReviewRun:
    """真正做一次回看。调用的人要先拿到 _running。 / Do one review; the caller must hold _running."""
    actions = trail.load()
    review = ReviewRun(id=_new_id(), at=wishes.now(), trigger=trigger, actions=len(actions))
    try:
        value = llm.ask(digest(actions) + "\n\n" + known(), system=SYSTEM, schema=SCHEMA, use_cache=False, purpose="review")
    except llm.LLMError as e:
        review.error = str(e)
        store.write_json(state_path(), {**_state(), "tried_at": review.at})
        store.append(log_path(), [{"event": "reviewed", **review.model_dump()}])
        raise
    review.findings = _findings(value)
    for f in review.findings:
        if f.importance >= RECORD_AT:
            f.wish_id = _record(f)
    store.write_json(state_path(), {"last_at": review.at})
    store.append(log_path(), [{"event": "reviewed", **review.model_dump()}])
    recorded = [f.title for f in review.findings if f.wish_id]
    if trigger == "auto" and recorded:
        notify.send(f"回看记了 {len(recorded)} 条愿望", "；".join(recorded), url="/wishes", tag="review")
    return review


def _claim() -> None:
    if len(trail.load()) < MIN_ACTIONS:
        raise ReviewError("操作记录还太少，过一阵再回看")
    if not _running.acquire(blocking=False):
        raise ReviewError("正在回看，等这次做完")


def run(trigger: Trigger = "manual") -> ReviewRun:
    """在当前线程里回看一次，做完才返回。 / Review once in this thread and return when done."""
    _claim()
    try:
        return _review(trigger)
    finally:
        _running.release()


def _background(trigger: Trigger) -> None:
    """在后台线程里回看；调用的人已经拿到 _running，做完由这里放开。

    Review in a background thread; the caller already holds _running, which is released here when done.
    """
    global _thread

    def work() -> None:
        try:
            _review(trigger)
        except Exception:  # noqa: BLE001 — 错误已经记在回看记录里 / the error is already in the review log
            pass
        finally:
            _running.release()

    _thread = threading.Thread(target=work, daemon=True, name=f"review-{trigger}")
    _thread.start()


def start() -> None:
    """手动"现在回看"：在后台开始，立刻返回；做没做完看 status().running。

    "Review now": start in the background and return at once; status().running tells whether it is done.
    """
    _claim()
    _background("manual")


def maybe_start(now: Optional[float] = None) -> bool:
    """到时候了就在后台自己回看一次，不等它做完。返回这次有没有开始。

    记操作的接口每次都会调它，所以它很便宜：最多每 CHECK_EVERY 秒才真正读一次轨迹。
    没有模型可用、已经在回看、或者上次回看刚失败，都不开始。

    Start a review in the background when one is due, without waiting for it; returns
    whether one was started. The trail route calls this on every write, so it is cheap: it
    reads the trail at most once every CHECK_EVERY seconds. Nothing starts when no model is
    available, a review is already running, or the last one failed recently.
    """
    global _checked_at
    now = time.time() if now is None else now
    if now - _checked_at < CHECK_EVERY or _running.locked():
        return False
    _checked_at = now
    state = _state()
    tried = _ts(str(state.get("tried_at") or ""))
    if tried is not None and now - tried < RETRY_AFTER:
        return False
    if _since(trail.load(), state.get("last_at")) < DUE_AFTER or not llm.available():
        return False
    if not _running.acquire(blocking=False):
        return False
    _background("auto")
    return True


def wait(timeout: float = 30.0) -> None:
    """等后台那次回看做完（测试用）。 / Wait for the background review to finish (for tests)."""
    if _thread is not None:
        _thread.join(timeout)


def rescue(run_id: str, index: int) -> str:
    """把一次回看里丢掉的一条捞回来，记进许愿池。返回愿望编号。

    Rescue a finding a review dropped and record it in the wish pool; returns the wish id.
    """
    found = next((r for r in runs() if r.id == run_id), None)
    if found is None or not 0 <= index < len(found.findings):
        raise ReviewError("回看记录里没有这一条")
    if found.findings[index].wish_id:
        raise ReviewError("这一条已经记进许愿池了")
    wish_id = _record(found.findings[index])
    store.append(log_path(), [{"at": wishes.now(), "id": run_id, "event": "rescued", "index": index, "wish_id": wish_id}])
    return wish_id
