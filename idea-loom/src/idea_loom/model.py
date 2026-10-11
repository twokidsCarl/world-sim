"""数据契约：后端写、界面读，TypeScript 类型由此生成。

idea 的当前状态不直接存，由 data/ideas.jsonl 里的事件折叠得出。

The data contract: written by the backend, read by the UI; the TypeScript types
are generated from it. The current state of an idea is not stored; it is folded
from the events in data/ideas.jsonl.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Level = Literal["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "纵", "造", "规"]
Thread = Literal["A", "B", "C", "D", "E"]
Status = Literal["draft", "pool", "building", "built", "merged", "discarded"]
EdgeKind = Literal["refined_from", "fused_from", "split_from", "inspired_by", "merged_into"]
EventKind = Literal[
    "created", "edited", "moved", "status", "merged_into", "discarded", "restored", "noted", "translated"
]

STATUS_LABELS: dict[str, str] = {
    "draft": "候选",
    "pool": "在池",
    "building": "开发中",
    "built": "已做出",
    "merged": "已并入",
    "discarded": "已丢弃",
}
EDGE_LABELS: dict[str, str] = {
    "refined_from": "细化自",
    "fused_from": "融合自",
    "split_from": "拆分自",
    "inspired_by": "由它想到",
    "merged_into": "并入",
    "mentions": "提到",
}
EVENT_LABELS: dict[str, str] = {
    "created": "创建",
    "edited": "改写",
    "moved": "改位置",
    "status": "改状态",
    "merged_into": "并入",
    "discarded": "丢弃",
    "restored": "恢复",
    "noted": "说明",
    "translated": "译成英文",
}
BY_LABELS: dict[str, str] = {
    "import": "导入",
    "human": "手动",
    "assistant": "小助手",
    "generator": "模型",
    "claude-code": "Claude Code",
}


class Origin(BaseModel):
    """一条 idea 是怎么来的。 / Where an idea came from."""

    how: str = "human"  # import / human / generate / refine / fuse / assistant
    commit: Optional[str] = None
    pr: Optional[int] = None
    subject: Optional[str] = None  # 导入时是那次提交的标题 / commit subject, for imports
    prompt: Optional[str] = None  # 生成时用的输入 / the input used when generated


class Edge(BaseModel):
    kind: EdgeKind
    target: str


class IdeaEvent(BaseModel):
    """ideas.jsonl 的一行。只有与 event 相关的字段有值。

    One line of ideas.jsonl. Only the fields relevant to `event` are set.
    """

    at: str
    by: str = "human"
    id: str
    event: EventKind
    title: Optional[str] = None
    body: Optional[str] = None
    title_en: Optional[str] = None  # translated 事件带的英文 / the English carried by a translated event
    body_en: Optional[str] = None
    level: Optional[Level] = None
    threads: Optional[list[Thread]] = None
    kernel: Optional[str] = None
    status: Optional[Status] = None
    edges: Optional[list[Edge]] = None
    target: Optional[str] = None  # merged_into 的去向 / where a merged idea went
    reason: Optional[str] = None
    text: Optional[str] = None
    origin: Optional[Origin] = None


class Version(BaseModel):
    at: str
    by: str
    title: str
    body: str


class Idea(BaseModel):
    id: str
    title: str
    body: str
    level: Level
    threads: list[Thread] = Field(default_factory=list)
    kernel: Optional[str] = None
    status: Status = "pool"
    status_label: str = "在池"
    edges: list[Edge] = Field(default_factory=list)
    merged_into: Optional[str] = None
    reason: Optional[str] = None
    origin: Origin = Field(default_factory=Origin)
    created_at: str
    updated_at: str
    versions: int = 1
    # 英文版。中文改写之后英文就过期了，en_stale 为真，等重新翻译。
    # The English version. It goes stale when the Chinese is rewritten; en_stale is
    # then true until it is translated again.
    title_en: Optional[str] = None
    body_en: Optional[str] = None
    en_stale: bool = False
    mentions: list[str] = Field(default_factory=list)  # 正文里提到的其他 idea / other ideas named in the body
    projects: list[str] = Field(default_factory=list)  # 提到或已关联的子项目 / subprojects named or linked


class Link(BaseModel):
    """血缘图里的一条边，方向是 source → target。 / One lineage edge, source → target."""

    source: str
    target: str
    kind: str
    label: str


class HistoryItem(BaseModel):
    at: str
    by: str
    by_label: str
    event: EventKind
    event_label: str
    text: str
    pr: Optional[int] = None
    before: Optional[Version] = None
    after: Optional[Version] = None


class IdeaDetail(Idea):
    prompt_text: str  # 复制给 Claude 的那段 / the text to hand to Claude
    history: list[HistoryItem]
    links_out: list[Link]
    links_in: list[Link]


class LevelInfo(BaseModel):
    id: Level
    name: str
    unit: str = ""  # 基元 / the basic unit at this level
    emerges: str = ""  # 这一层新出现的东西 / what first appears at this level
    intro: str = ""  # 支线和纵线的一段说明 / intro paragraph for branches and verticals
    name_en: str = ""
    unit_en: str = ""
    emerges_en: str = ""
    intro_en: str = ""
    kind: Literal["ladder", "vertical", "branch"] = "ladder"


class ThreadInfo(BaseModel):
    id: Thread
    name: str
    short: str
    desc: str = ""
    name_en: str = ""
    short_en: str = ""
    desc_en: str = ""


class KernelInfo(BaseModel):
    name: str
    desc: str = ""
    project: Optional[str] = None
    name_en: str = ""
    desc_en: str = ""


class Frame(BaseModel):
    """想法池的骨架：层、横线、内核。 / The skeleton of the pool: levels, threads, kernels."""

    levels: list[LevelInfo]
    threads: list[ThreadInfo]
    kernels: list[KernelInfo]


class Project(BaseModel):
    dir: str
    tagline: str = ""
    tagline_en: str = ""
    level: Optional[Level] = None
    keywords: list[str] = Field(default_factory=list)  # 正文里出现这些词就算提到它 / words that count as a mention
    ideas: list[str] = Field(default_factory=list)  # 明确关联的 idea / explicitly linked ideas
    ui_url: Optional[str] = None  # 不再使用：界面的地址由统一入口给出 / no longer used: the UI address comes from the single entry point


class KernelCount(BaseModel):
    name: str
    desc: str
    project: Optional[str]
    ideas: list[str]
    name_en: str = ""
    desc_en: str = ""


class Coverage(BaseModel):
    """层 × 横线每格有几条（只算在池、开发中、已做出的）。

    Ideas per level × thread cell, counting only live ones (pool, building, built).
    """

    cells: dict[str, dict[str, list[str]]]  # level -> thread -> ids
    by_level: dict[str, list[str]]
    untagged: list[str]


class Counts(BaseModel):
    total: int
    by_status: dict[str, int]
    live: int


class State(BaseModel):
    frame: Frame
    projects: list[Project]
    ideas: list[Idea]
    links: list[Link]
    coverage: Coverage
    kernels: list[KernelCount]
    counts: Counts
    unreadable: int = 0
    labels: dict[str, dict[str, str]]
