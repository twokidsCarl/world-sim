"""回看：让模型读一遍你最近在界面里的操作，自己提出最多三条改进这个工具的愿望。

它只提议，记不记由你定。提议不落盘；你点了"记下"才进许愿池。

Review: have the model read your recent actions in the UI and propose up to three
wishes for improving this tool. It only proposes; you decide what gets recorded.
Proposals are not stored, and one enters the wish pool only when you accept it.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from pydantic import BaseModel

from . import llm, stats, store, trail, wishes

DUE_AFTER = 300  # 攒够这么多条操作，就提醒可以回看了 / remind once this many actions have piled up


class Suggestion(BaseModel):
    title: str
    kind: str
    stuck: str
    suggestion: str
    evidence: str = ""  # 它是从哪些操作里看出来的 / which actions it was drawn from


class ReviewStatus(BaseModel):
    actions_since: int
    due: bool
    last_at: str | None = None


def _ts(text: str) -> float | None:
    from datetime import datetime

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _state() -> dict[str, Any]:
    return store.read_json(llm.runs_dir() / "review.json", {})


def status() -> ReviewStatus:
    last = _state().get("last_at")
    cut = _ts(last) if last else None
    # 浏览器记的时间是 UTC，后端记的带本地时区，所以要化成时刻再比。
    # The browser records UTC and the backend a local offset, so compare instants, not strings.
    since = sum(1 for a in trail.load() if cut is None or (_ts(str(a.get("at", ""))) or 0) > cut)
    return ReviewStatus(actions_since=since, due=since >= DUE_AFTER, last_at=last)


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


SCHEMA = {
    "type": "object",
    "properties": {"wishes": {"type": "array", "items": {
        "type": "object",
        "properties": {"title": {"type": "string"}, "kind": {"type": "string"}, "stuck": {"type": "string"}, "suggestion": {"type": "string"}, "evidence": {"type": "string"}},
        "required": ["title", "kind", "stuck", "suggestion", "evidence"],
    }}},
    "required": ["wishes"],
}
SYSTEM = """你在帮一个人改进他自己用的工具 idea-loom（world-sim 仓库的想法池界面：地图、想法池、生成与候选、血缘、开发、许愿池、统计，右侧有小助手）。
下面是他最近在这个界面里的操作记录。请从中看出这个工具哪里让他费劲了，提出最多三条改进愿望。

要求：
- 只提从记录里看得出依据的。例如：在两页之间来回跳、同一个按钮反复点、某个接口总报错、某个功能从没用过、某类页面停留很久却没有后续操作。看不出什么就给空列表，不要硬凑。
- 每条说清楚：他卡在哪（stuck）、建议怎么改（suggestion）、你是从哪些操作里看出来的（evidence）。
- kind 从这些里选：unclear（界面不清楚）、missing（缺功能）、broken（出错）、structure（想法池的结构该改）、other。
- 不要和"许愿池里已有的"重复。
- 用中文，平实，短。"""


def run() -> list[Suggestion]:
    actions = trail.load()
    if len(actions) < 10:
        raise ValueError("操作记录还太少，过一阵再回看")
    known = "\n".join(f"- {title}（{status}）" for _, title, _, status in wishes.open_titles()) or "（还没有）"
    value = llm.ask(digest(actions) + "\n\n许愿池里已有的：\n" + known, system=SYSTEM, schema=SCHEMA, use_cache=False, purpose="review")
    out = []
    for x in value.get("wishes", []) if isinstance(value, dict) else []:
        if isinstance(x, dict) and str(x.get("title", "")).strip() and x.get("kind") in wishes.KIND_LABELS:
            out.append(Suggestion(title=str(x["title"]).strip(), kind=x["kind"], stuck=str(x.get("stuck", "")).strip(),
                                  suggestion=str(x.get("suggestion", "")).strip(), evidence=str(x.get("evidence", "")).strip()))
    store.write_json(llm.runs_dir() / "review.json", {"last_at": wishes.now()})
    return out[:3]
