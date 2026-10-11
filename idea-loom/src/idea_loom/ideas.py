"""把事件折叠成想法池的当前状态，并算出血缘、覆盖表和内核计数。

Fold events into the current state of the pool, and derive lineage, the
coverage table and the kernel counts.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable, Optional

from . import store
from .model import (
    BY_LABELS,
    EDGE_LABELS,
    EVENT_LABELS,
    STATUS_LABELS,
    Counts,
    Coverage,
    Edge,
    Frame,
    HistoryItem,
    Idea,
    IdeaDetail,
    IdeaEvent,
    KernelCount,
    Link,
    Origin,
    Project,
    State,
    Version,
)

LADDER = [f"L{n}" for n in range(1, 11)]
LEVELS = LADDER + ["纵", "造", "规"]
THREADS = ["A", "B", "C", "D", "E"]
LIVE = ("pool", "building", "built")

ID_RE = r"(?:\d{1,2}\.\d{1,2}|[纵造规] \d{1,2})"
_MENTION = re.compile(r"(?<![\d.])(" + ID_RE + r")(?![\d.])")


def ideas_path() -> Path:
    return store.data_dir() / "ideas.jsonl"


def level_of(idea_id: str) -> str:
    """层由编号决定：4.2 在 L4，纵 1 在纵线。 / The id decides the level: 4.2 is in L4, 纵 1 in the verticals."""
    if idea_id[0] in "纵造规":
        return idea_id[0]
    return f"L{int(idea_id.split('.')[0])}"


def sort_key(idea_id: str) -> tuple[int, int]:
    if idea_id[0] in "纵造规":
        return (11 + "纵造规".index(idea_id[0]), int(idea_id.split(" ")[1]))
    major, minor = idea_id.split(".")
    return (int(major), int(minor))


def next_id(level: str, used: Iterable[str]) -> str:
    """这一层的下一个编号。用过的编号（包括已并入、已丢弃的）永不复用。

    The next id at this level. Ids that were ever used, including merged and
    discarded ones, are never reused.
    """
    nums = [sort_key(i)[1] for i in used if level_of(i) == level]
    n = max(nums, default=0) + 1
    return f"{level} {n}" if level in "纵造规" else f"{level[1:]}.{n}"


def load_events(path: Optional[Path] = None) -> tuple[list[IdeaEvent], int]:
    rows, bad = store.read_lines(path or ideas_path())
    events: list[IdeaEvent] = []
    for row in rows:
        try:
            events.append(IdeaEvent.model_validate(row))
        except ValueError:
            bad += 1
    return events, bad


def _apply(ideas: dict[str, Idea], history: dict[str, list[Version]], e: IdeaEvent) -> None:
    if e.event == "created":
        if e.id in ideas:
            return
        status = e.status or "pool"
        ideas[e.id] = Idea(
            id=e.id,
            title=e.title or "",
            body=e.body or "",
            level=e.level or level_of(e.id),  # type: ignore[arg-type]
            threads=sorted(e.threads or []),
            kernel=e.kernel,
            status=status,
            edges=list(e.edges or []),
            origin=e.origin or Origin(how=e.by),
            created_at=e.at,
            updated_at=e.at,
        )
        history[e.id] = [Version(at=e.at, by=e.by, title=e.title or "", body=e.body or "")]
        return
    idea = ideas.get(e.id)
    if idea is None:
        return
    idea.updated_at = e.at
    if e.event == "edited":
        if e.title is not None:
            idea.title = e.title
        if e.body is not None:
            idea.body = e.body
        history[e.id].append(Version(at=e.at, by=e.by, title=idea.title, body=idea.body))
    elif e.event == "moved":
        if e.level is not None:
            idea.level = e.level
        if e.threads is not None:
            idea.threads = sorted(e.threads)
        if "kernel" in e.model_fields_set:
            idea.kernel = e.kernel
    elif e.event == "status":
        if e.status is not None:
            idea.status = e.status
    elif e.event == "merged_into":
        idea.status = "merged"
        idea.merged_into = e.target
        idea.reason = e.reason
        if e.target:
            idea.edges = [x for x in idea.edges if x.kind != "merged_into"]
            idea.edges.append(Edge(kind="merged_into", target=e.target))
    elif e.event == "discarded":
        idea.status = "discarded"
        idea.reason = e.reason
    elif e.event == "restored":
        idea.status = e.status or "pool"
        idea.merged_into = None
        idea.reason = None
        idea.edges = [x for x in idea.edges if x.kind != "merged_into"]


def fold(events: Iterable[IdeaEvent]) -> tuple[dict[str, Idea], dict[str, list[Version]]]:
    ideas: dict[str, Idea] = {}
    history: dict[str, list[Version]] = {}
    for e in events:
        _apply(ideas, history, e)
    for idea in ideas.values():
        idea.status_label = STATUS_LABELS[idea.status]
        idea.versions = len(history[idea.id])
    return ideas, history


def mentions(idea: Idea, known: Iterable[str]) -> list[str]:
    known_set = set(known)
    found: list[str] = []
    for m in _MENTION.finditer(idea.body):
        ref = m.group(1)
        if ref != idea.id and ref in known_set and ref not in found:
            found.append(ref)
    return found


def project_refs(idea: Idea, projects: list[Project]) -> list[str]:
    text = idea.body.lower()
    refs = []
    for p in projects:
        if idea.id in p.ideas or any(k.lower() in text for k in p.keywords):
            refs.append(p.dir)
    return refs


def links(ideas: dict[str, Idea]) -> list[Link]:
    """全池的血缘边。方向统一为"从哪来 → 到哪去"。

    All lineage edges of the pool, always directed from origin to result.
    """
    out: list[Link] = []
    for idea in ideas.values():
        for e in idea.edges:
            if e.target not in ideas:
                continue
            if e.kind == "merged_into":
                out.append(Link(source=idea.id, target=e.target, kind=e.kind, label=EDGE_LABELS[e.kind]))
            else:
                out.append(Link(source=e.target, target=idea.id, kind=e.kind, label=EDGE_LABELS[e.kind]))
        for ref in idea.mentions:
            out.append(Link(source=ref, target=idea.id, kind="mentions", label=EDGE_LABELS["mentions"]))
    return out


def coverage(ideas: dict[str, Idea]) -> Coverage:
    cells: dict[str, dict[str, list[str]]] = {lv: {t: [] for t in THREADS} for lv in LEVELS}
    by_level: dict[str, list[str]] = {lv: [] for lv in LEVELS}
    untagged: list[str] = []
    for idea in sorted(ideas.values(), key=lambda i: sort_key(i.id)):
        if idea.status not in LIVE:
            continue
        by_level[idea.level].append(idea.id)
        if not idea.threads:
            untagged.append(idea.id)
        for t in idea.threads:
            cells[idea.level][t].append(idea.id)
    return Coverage(cells=cells, by_level=by_level, untagged=untagged)


def kernel_counts(ideas: dict[str, Idea], frame: Frame) -> list[KernelCount]:
    out = []
    for k in frame.kernels:
        ids = [i.id for i in ideas.values() if i.kernel == k.name and i.status in LIVE]
        out.append(KernelCount(name=k.name, desc=k.desc, project=k.project, ideas=sorted(ids, key=sort_key)))
    out.sort(key=lambda k: -len(k.ideas))
    return out


def load_frame() -> Frame:
    return Frame.model_validate(store.read_json(store.data_dir() / "frame.json", {"levels": [], "threads": [], "kernels": []}))


def load_projects() -> list[Project]:
    return [Project.model_validate(p) for p in store.read_json(store.data_dir() / "projects.json", [])]


def labels() -> dict[str, dict[str, str]]:
    return {"status": STATUS_LABELS, "edge": EDGE_LABELS, "event": EVENT_LABELS, "by": BY_LABELS}


def current() -> tuple[dict[str, Idea], dict[str, list[Version]], list[IdeaEvent], int]:
    events, bad = load_events()
    ideas, history = fold(events)
    projects = load_projects()
    for idea in ideas.values():
        idea.mentions = mentions(idea, ideas)
        idea.projects = project_refs(idea, projects)
    return ideas, history, events, bad


def state() -> State:
    ideas, _, _, bad = current()
    frame = load_frame()
    ordered = sorted(ideas.values(), key=lambda i: sort_key(i.id))
    by_status: dict[str, int] = {s: 0 for s in STATUS_LABELS}
    for idea in ordered:
        by_status[idea.status] += 1
    return State(
        frame=frame,
        projects=load_projects(),
        ideas=ordered,
        links=links(ideas),
        coverage=coverage(ideas),
        kernels=kernel_counts(ideas, frame),
        counts=Counts(total=len(ordered), by_status=by_status, live=sum(by_status[s] for s in LIVE)),
        unreadable=bad,
        labels=labels(),
    )


def prompt_text(idea: Idea) -> str:
    """复制给 Claude 的那段：只有正文，不带编号和标记。

    The text to hand to Claude: the body only, without id or tags.
    """
    return idea.body.strip()


def _event_text(e: IdeaEvent, ideas: dict[str, Idea]) -> str:
    if e.event == "created":
        how = (e.origin.how if e.origin else e.by) or e.by
        subject = e.origin.subject if e.origin and e.origin.subject else ""
        return {"import": f"随「{subject}」进入想法池" if subject else "导入"}.get(how, "创建")
    if e.event == "edited":
        return e.text or "改写了正文"
    if e.event == "moved":
        parts = []
        if e.level is not None:
            parts.append(f"层改为 {e.level}")
        if e.threads is not None:
            parts.append("横线改为 " + ("、".join(e.threads) if e.threads else "无"))
        if "kernel" in e.model_fields_set:
            parts.append(f"内核归到「{e.kernel}」" if e.kernel else "取消内核归类")
        return "；".join(parts) or "改了位置"
    if e.event == "merged_into":
        target = ideas.get(e.target or "")
        name = f"{e.target} {target.title}" if target else (e.target or "")
        return f"并入 {name}" + (f"：{e.reason}" if e.reason else "")
    if e.event == "discarded":
        return "丢弃" + (f"：{e.reason}" if e.reason else "")
    if e.event == "restored":
        return "恢复到想法池"
    if e.event == "status":
        return f"状态改为「{STATUS_LABELS.get(e.status or '', e.status)}」"
    return e.text or ""


def detail(idea_id: str) -> Optional[IdeaDetail]:
    ideas, history, events, _ = current()
    idea = ideas.get(idea_id)
    if idea is None:
        return None
    items: list[HistoryItem] = []
    version = 0
    versions = history[idea_id]
    for e in events:
        if e.id != idea_id:
            continue
        before = after = None
        if e.event == "created":
            after = versions[0]
        elif e.event == "edited":
            version += 1
            before, after = versions[version - 1], versions[version]
        items.append(
            HistoryItem(
                at=e.at,
                by=e.by,
                by_label=BY_LABELS.get(e.by, e.by),
                event=e.event,
                event_label=EVENT_LABELS[e.event],
                text=_event_text(e, ideas),
                pr=e.origin.pr if e.origin else None,
                before=before,
                after=after,
            )
        )
    all_links = links(ideas)
    return IdeaDetail(
        **idea.model_dump(),
        prompt_text=prompt_text(idea),
        history=list(reversed(items)),
        links_out=[l for l in all_links if l.source == idea_id],
        links_in=[l for l in all_links if l.target == idea_id],
    )


def append_events(events: list[IdeaEvent]) -> None:
    rows: list[dict[str, Any]] = [e.model_dump(exclude_unset=True, exclude_none=False) for e in events]
    store.append(ideas_path(), rows)
