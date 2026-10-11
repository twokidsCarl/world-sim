"""用模型做的操作：生成、细化、融合、归类、查重。

每个操作只产出"提议"，存在 runs/proposals.jsonl 里（不进 git）。接受一条提议时才
通过 edits 写事件；不接受就什么都不改。

Model-backed operations: generate, refine, fuse, classify, dedupe. Each one only
produces proposals, kept in runs/proposals.jsonl (not in git). Events are written
through `edits` only when a proposal is accepted; otherwise nothing changes.
"""

from __future__ import annotations

import random
import uuid
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from . import edits, ideas, llm, store
from .model import Edge, Frame, Idea, Origin

PROMPTS = Path(__file__).parent / "prompts"
ProposalKind = Literal["idea", "rewrite", "position", "merge"]
ProposalStatus = Literal["open", "accepted", "dismissed"]
OP_LABELS = {"generate": "生成", "refine": "细化", "fuse": "融合", "classify": "归类", "dedupe": "查重", "assistant": "小助手提议"}
KIND_LABELS = {"idea": "新的一条", "rewrite": "改写", "position": "改位置", "merge": "合并"}


class Proposal(BaseModel):
    """模型的一条提议。 / One proposal from the model."""

    id: str
    at: str
    op: str
    op_label: str = ""
    kind: ProposalKind
    kind_label: str = ""
    status: ProposalStatus = "open"
    request: str = ""  # 当时要它做什么 / what it was asked for
    why: str = ""
    # kind == idea / rewrite
    title: Optional[str] = None
    body: Optional[str] = None
    level: Optional[str] = None
    threads: list[str] = Field(default_factory=list)
    kernel: Optional[str] = None
    direction: Optional[str] = None
    # 涉及的已有 idea / existing ideas involved
    idea_id: Optional[str] = None  # rewrite、position 的对象；merge 的 source
    target: Optional[str] = None  # merge 的去向
    sources: list[str] = Field(default_factory=list)  # 融合自 / 细化自
    result_id: Optional[str] = None  # 接受后产生或改动的 idea


class OpError(ValueError):
    """这次操作做不了，原因写给人看。 / The operation cannot run; the message is for a person."""


def proposals_path() -> Path:
    return llm.runs_dir() / "proposals.jsonl"


def load() -> list[Proposal]:
    rows, _ = store.read_lines(proposals_path())
    latest: dict[str, Proposal] = {}
    for row in rows:
        try:
            p = Proposal.model_validate(row)
        except ValueError:
            continue
        p.op_label = OP_LABELS.get(p.op, p.op)
        p.kind_label = KIND_LABELS[p.kind]
        latest[p.id] = p  # 后写的一行覆盖先写的 / a later line replaces an earlier one
    return sorted(latest.values(), key=lambda p: p.at, reverse=True)


def _save(items: list[Proposal]) -> None:
    store.append(proposals_path(), [p.model_dump(exclude={"op_label", "kind_label"}) for p in items])


def _new(op: str, kind: ProposalKind, request: str, **fields: Any) -> Proposal:
    return Proposal(id=uuid.uuid4().hex[:12], at=edits.now(), op=op, kind=kind, request=request, **fields)


# ---------- 提示词 / prompts ----------


def frame_text(frame: Frame) -> str:
    lines = ["层（从小到大）："]
    for lv in frame.levels:
        if lv.kind == "ladder":
            lines.append(f"- {lv.id} {lv.name}：基元是{lv.unit}；这一层新出现的是{lv.emerges}")
        else:
            lines.append(f"- {lv.id}（{lv.name}）：{lv.intro}")
    lines += ["", "横线（同一种机制在不同层的样子）："]
    lines += [f"- {t.id} {t.name}：{t.desc}" for t in frame.threads]
    lines += ["", "内核（底下跑的是哪一种计算）："]
    lines += [f"- {k.name}：{k.desc}" for k in frame.kernels]
    return "\n".join(lines)


def system_prompt(frame: Frame) -> str:
    return (PROMPTS / "style.md").read_text(encoding="utf-8").replace("{frame}", frame_text(frame))


def idea_text(idea: Idea) -> str:
    tags = f"（{'、'.join(idea.threads)}）" if idea.threads else ""
    kernel = f"  [内核：{idea.kernel}]" if idea.kernel else ""
    return f"{idea.id} {idea.title}{tags}{kernel}\n{idea.body}"


def _fill(name: str, **values: Any) -> str:
    text = (PROMPTS / f"{name}.md").read_text(encoding="utf-8")
    for key, value in values.items():
        text = text.replace("{" + key + "}", str(value))
    return text


def _live(pool: dict[str, Idea]) -> list[Idea]:
    return sorted((i for i in pool.values() if i.status in ideas.LIVE), key=lambda i: ideas.sort_key(i.id))


def _clean_position(frame: Frame, level: Any, threads: Any, kernel: Any) -> tuple[Optional[str], list[str], Optional[str]]:
    """模型给的位置不合法的部分直接丢掉，不让它进提议。 / Drop any invalid part of a position the model gave."""
    levels = {lv.id for lv in frame.levels}
    kernels = {k.name for k in frame.kernels}
    lv = level if level in levels else None
    th = sorted({t for t in (threads or []) if t in ideas.THREADS}) if isinstance(threads, list) else []
    return lv, th, kernel if kernel in kernels else None


IDEA_ITEM = {
    "type": "object",
    "properties": {
        "title": {"type": "string"}, "body": {"type": "string"}, "level": {"type": "string"},
        "threads": {"type": "array", "items": {"type": "string"}}, "kernel": {"type": "string"}, "why": {"type": "string"},
    },
    "required": ["title", "body", "level", "why"],
}


def _list_schema(key: str, item: dict) -> dict:
    return {"type": "object", "properties": {key: {"type": "array", "items": item}}, "required": [key]}


def _items(value: Any, key: str) -> list[dict]:
    got = value.get(key) if isinstance(value, dict) else None
    return [x for x in got if isinstance(x, dict)] if isinstance(got, list) else []


# ---------- 操作 / operations ----------


class Target(BaseModel):
    """生成的目标：一个格子、一层、一种内核、照着某一条，或一句话。 / What to generate for."""

    level: Optional[str] = None
    thread: Optional[str] = None
    kernel: Optional[str] = None
    like: Optional[str] = None
    text: str = ""


def describe(target: Target, frame: Frame, pool: dict[str, Idea]) -> str:
    parts = []
    if target.level:
        lv = next((x for x in frame.levels if x.id == target.level), None)
        parts.append(f"层：{target.level} {lv.name if lv else ''}（必须在这一层）")
    if target.thread:
        t = next((x for x in frame.threads if x.id == target.thread), None)
        parts.append(f"横线：{target.thread} {t.name if t else ''}（必须在这条横线上）")
    if target.kernel:
        parts.append(f"内核：{target.kernel}（底下必须是这一种计算；层由你选，尽量选这个内核还没到过的层）")
    if target.like and target.like in pool:
        parts.append(f"从这一条出发，写和它相邻但不同的：\n{idea_text(pool[target.like])}")
    if target.text.strip():
        parts.append(f"另外的要求：{target.text.strip()}")
    return "\n".join(parts) or "不限位置。优先写到条目少的格子里去。"


def generate(target: Target, n: int = 3) -> list[Proposal]:
    n = max(1, min(6, n))
    pool, _, _, _ = ideas.current()
    frame = ideas.load_frame()
    live = _live(pool)
    same = [i for i in live if (not target.level or i.level == target.level) and (not target.thread or target.thread in i.threads) and (not target.kernel or i.kernel == target.kernel)]
    if not (target.level or target.thread or target.kernel):
        same = []
    examples = random.Random(len(live)).sample(live, min(3, len(live)))
    request = describe(target, frame, pool)
    prompt = _fill(
        "generate", n=n, target=request,
        existing="\n".join(f"- {i.id} {i.title}：{i.body.splitlines()[0]}" for i in same[:40]) or "（这个位置还是空的）",
        examples="\n\n".join(idea_text(i) for i in examples),
        titles="、".join(f"{i.id} {i.title}" for i in live),
        levels="、".join(lv.id for lv in frame.levels),
    )
    value = llm.ask(prompt, system=system_prompt(frame), schema=_list_schema("ideas", IDEA_ITEM), use_cache=False, purpose="generate")
    out = []
    for item in _items(value, "ideas")[:n]:
        level, threads, kernel = _clean_position(frame, target.level or item.get("level"), item.get("threads"), target.kernel or item.get("kernel"))
        title, body = str(item.get("title", "")).strip(), str(item.get("body", "")).strip()
        if not title or not body or level is None:
            continue
        if target.thread and target.thread not in threads:
            threads = sorted(threads + [target.thread])
        out.append(_new("generate", "idea", request, title=title, body=body, level=level, threads=threads, kernel=kernel,
                        why=str(item.get("why", "")).strip(), sources=[target.like] if target.like and target.like in pool else []))
    if not out:
        raise OpError("模型没有给出可用的 idea，再试一次")
    _save(out)
    return out


def refine(idea_id: str, n: int = 3, hint: str = "") -> list[Proposal]:
    pool, _, _, _ = ideas.current()
    idea = pool.get(idea_id)
    if idea is None:
        raise OpError(f"没有编号为 {idea_id} 的 idea")
    frame = ideas.load_frame()
    schema = _list_schema("rewrites", {
        "type": "object",
        "properties": {"title": {"type": "string"}, "body": {"type": "string"}, "direction": {"type": "string"}, "why": {"type": "string"}},
        "required": ["title", "body", "direction", "why"],
    })
    prompt = _fill("refine", n=max(1, min(5, n)), idea=idea_text(idea), extra=f"- 用户另外的要求：{hint.strip()}" if hint.strip() else "")
    value = llm.ask(prompt, system=system_prompt(frame), schema=schema, use_cache=False, purpose="refine")
    out = [
        _new("refine", "rewrite", hint.strip() or "细化这一条", idea_id=idea_id, title=str(x["title"]).strip(), body=str(x["body"]).strip(),
             direction=str(x.get("direction", "")).strip(), why=str(x.get("why", "")).strip(), level=idea.level, threads=idea.threads,
             kernel=idea.kernel, sources=[idea_id])
        for x in _items(value, "rewrites") if str(x.get("title", "")).strip() and str(x.get("body", "")).strip()
    ]
    if not out:
        raise OpError("模型没有给出可用的改写，再试一次")
    _save(out)
    return out


def fuse(idea_ids: list[str]) -> Proposal:
    pool, _, _, _ = ideas.current()
    ids = list(dict.fromkeys(idea_ids))
    if len(ids) < 2:
        raise OpError("融合至少要选两条")
    missing = [i for i in ids if i not in pool or pool[i].status not in ideas.LIVE]
    if missing:
        raise OpError(f"这几条不在池里：{'、'.join(missing)}")
    frame = ideas.load_frame()
    prompt = _fill("fuse", ideas="\n\n".join(idea_text(pool[i]) for i in ids), levels="、".join(lv.id for lv in frame.levels))
    value = llm.ask(prompt, system=system_prompt(frame), schema=IDEA_ITEM, use_cache=False, purpose="fuse")
    assert isinstance(value, dict)
    level, threads, kernel = _clean_position(frame, value.get("level"), value.get("threads"), value.get("kernel"))
    title, body = str(value.get("title", "")).strip(), str(value.get("body", "")).strip()
    if not title or not body:
        raise OpError("模型没有给出可用的融合稿，再试一次")
    p = _new("fuse", "idea", "融合 " + "、".join(ids), title=title, body=body, level=level or pool[ids[0]].level,
             threads=threads, kernel=kernel, why=str(value.get("why", "")).strip(), sources=ids)
    _save([p])
    return p


def classify(idea_ids: Optional[list[str]] = None) -> list[Proposal]:
    """给还没归类的（或指定的）idea 提议横线和内核。 / Propose threads and a kernel for unclassified (or given) ideas."""
    pool, _, _, _ = ideas.current()
    frame = ideas.load_frame()
    chosen = [pool[i] for i in idea_ids if i in pool] if idea_ids else [i for i in _live(pool) if i.kernel is None or not i.threads]
    chosen = [i for i in chosen if i.level != "纵"][:25]  # 纵线不归类 / verticals are not classified
    if not chosen:
        raise OpError("没有需要归类的 idea")
    schema = _list_schema("items", {
        "type": "object",
        "properties": {"id": {"type": "string"}, "threads": {"type": "array", "items": {"type": "string"}}, "kernel": {"type": "string"}, "why": {"type": "string"}},
        "required": ["id", "threads", "kernel", "why"],
    })
    value = llm.ask(_fill("classify", ideas="\n\n".join(idea_text(i) for i in chosen)), system=system_prompt(frame), schema=schema, use_cache=False, purpose="classify")
    known = {i.id: i for i in chosen}
    out = []
    for x in _items(value, "items"):
        idea = known.get(str(x.get("id", "")).strip())
        if idea is None:
            continue
        _, threads, kernel = _clean_position(frame, None, x.get("threads"), x.get("kernel"))
        if threads == idea.threads and kernel == idea.kernel:
            continue
        out.append(_new("classify", "position", "归类", idea_id=idea.id, title=idea.title, threads=threads or idea.threads,
                        kernel=kernel or idea.kernel, level=idea.level, why=str(x.get("why", "")).strip()))
    _save(out)
    return out


def dedupe(level: Optional[str] = None, kernel: Optional[str] = None) -> list[Proposal]:
    pool, _, _, _ = ideas.current()
    frame = ideas.load_frame()
    group = [i for i in _live(pool) if (not level or i.level == level) and (not kernel or i.kernel == kernel)]
    if not (level or kernel):
        raise OpError("查重要先选一层或一种内核")
    if len(group) < 2:
        raise OpError("这一组不到两条，没什么可查的")
    schema = _list_schema("pairs", {
        "type": "object",
        "properties": {"source": {"type": "string"}, "target": {"type": "string"}, "why": {"type": "string"}},
        "required": ["source", "target", "why"],
    })
    value = llm.ask(_fill("dedupe", ideas="\n\n".join(idea_text(i) for i in group)), system=system_prompt(frame), schema=schema, use_cache=False, purpose="dedupe")
    ids = {i.id for i in group}
    out = []
    for x in _items(value, "pairs"):
        source, target = str(x.get("source", "")).strip(), str(x.get("target", "")).strip()
        if source in ids and target in ids and source != target:
            out.append(_new("dedupe", "merge", f"查重：{level or kernel}", idea_id=source, target=target,
                            title=f"{source} {pool[source].title} → {target} {pool[target].title}", why=str(x.get("why", "")).strip()))
    _save(out)
    return out


# ---------- 取舍 / accept or dismiss ----------


def _find(proposal_id: str) -> Proposal:
    p = next((x for x in load() if x.id == proposal_id), None)
    if p is None:
        raise OpError("没有这条提议")
    if p.status != "open":
        raise OpError("这条提议已经处理过了")
    return p


def accept(proposal_id: str, *, as_new: bool = False, title: Optional[str] = None, body: Optional[str] = None) -> Proposal:
    """接受一条提议。可以先改标题和正文再接受；改写类的可以选择另存为新的一条。

    Accept a proposal. The title and body may be edited first; a rewrite may be
    accepted as a new idea instead of a new version.
    """
    p = _find(proposal_id)
    title = (title if title is not None else p.title or "").strip()
    body = (body if body is not None else p.body or "").strip()
    try:
        if p.kind == "idea":
            kind = "fused_from" if p.op == "fuse" else "inspired_by"
            edge_list = [Edge(kind=kind, target=s) for s in p.sources]  # type: ignore[arg-type]
            how = {"generate": "generate", "fuse": "fuse", "assistant": "assistant"}.get(p.op, p.op)
            p.result_id = edits.create(title=title, body=body, level=p.level or "L1", threads=p.threads, kernel=p.kernel,
                                       by="assistant" if p.op == "assistant" else "generator",
                                       origin=Origin(how=how, prompt=p.request), edges=edge_list or None)
            if p.op == "fuse":
                for source in p.sources:
                    edits.merge(source, p.result_id, reason=p.why or "融合", by="generator")
        elif p.kind == "rewrite":
            assert p.idea_id
            if as_new:
                p.result_id = edits.create(title=title, body=body, level=p.level or "L1", threads=p.threads, kernel=p.kernel, by="generator",
                                           origin=Origin(how="refine", prompt=p.request), edges=[Edge(kind="refined_from", target=p.idea_id)])
            else:
                edits.edit(p.idea_id, title=title, body=body, by="generator", text=f"细化（{p.direction}）：{p.why}" if p.direction else p.why)
                p.result_id = p.idea_id
        elif p.kind == "position":
            assert p.idea_id
            edits.move(p.idea_id, threads=p.threads, kernel=p.kernel, by="generator")
            p.result_id = p.idea_id
        elif p.kind == "merge":
            assert p.idea_id and p.target
            edits.merge(p.idea_id, p.target, reason=p.why, by="generator")
            p.result_id = p.target
    except edits.EditError as e:
        raise OpError(str(e)) from e
    p.status = "accepted"
    _save([p])
    return p


def dismiss(proposal_id: str) -> Proposal:
    p = _find(proposal_id)
    p.status = "dismissed"
    _save([p])
    return p
