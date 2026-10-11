"""语料：理论卡、案例、典型事实。每条都带出处；没有逐条核实过的出处不进入校准。
The corpus: theory cards, cases and stylised facts. Every entry cites its sources, and nothing whose sources have not each been verified is used for calibration.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal, Optional

import yaml
from pydantic import BaseModel, Field, model_validator

ROOT = Path(__file__).resolve().parents[2] / "corpus"


class Source(BaseModel):
    """一条出处。verified 只有在打开过能证实它的页面之后才能为真，checked 写明看的是哪一页、证实了什么。
    One source. verified may be true only after someone has opened a page that confirms it; checked records which page that was and what it confirmed.
    """

    work: str
    author: str
    year: Optional[int] = None
    locator: str = Field("", description="期刊卷期页码、章回、幕次 / journal volume, issue and pages; chapter; act and scene")
    url: str = ""
    verified: bool = False
    checked: str = Field("", description="核实方式：哪个页面证实了哪些信息 / how it was verified: which page confirmed what")

    @model_validator(mode="after")
    def _verified_needs_evidence(self):
        if self.verified and not (self.url and self.checked):
            raise ValueError(f"{self.work}: verified 为真时必须有 url 和 checked")
        return self


class Entry(BaseModel):
    id: str
    title: str
    sources: list[Source] = Field(min_length=1)
    en: dict = Field({}, description="正文各字段的英文，键见 EN_KEYS；列表与中文的列表等长 / English for the text fields, keys as in EN_KEYS; lists are as long as their Chinese counterparts")

    @property
    def verified(self) -> bool:
        return all(s.verified for s in self.sources)


class Parameter(BaseModel):
    name: str
    meaning: str


class Theory(Entry):
    """一个机制：它说人群里会发生什么、为什么。/ A mechanism: what it says happens in a population, and why."""

    title_en: str
    field: str
    claim: str = Field(description="机制，用自己的话写 / the mechanism, in our own words")
    formal: str = Field("", description="公式或规则的文字表述 / the formula or rule, stated in words")
    parameters: list[Parameter] = []
    predicts: list[str] = Field(description="如果机制成立，应当观察到什么 / what should be observed if the mechanism holds")
    in_engine: str = Field("", description="polis 引擎里哪一处实现了它；留空表示尚未实现 / where the polis engine implements it; empty means not yet implemented")


class Character(BaseModel):
    name: str
    role: str
    traits: str = ""


class Beat(BaseModel):
    what: str
    who: list[str] = []


class Case(Entry):
    """一个可以拿来做输入和校准的故事：谁、什么关系、依次发生了什么。
    A story that can serve as input and as a calibration case: who was involved, how they were related, and what happened in what order.
    """

    kind: Literal["drama", "novel", "idiom", "history"]
    setting: str
    summary: str
    people: list[Character]
    events: list[Beat] = Field(description="原作或史料里的事件顺序 / the order of events in the source text or historical record")
    outcome: str = Field(description="结局；模拟要复现的就是它 / the outcome; this is what the simulation has to reproduce")
    theories: list[str] = Field(description="这个故事体现了哪些理论卡，写 id / ids of the theory cards this story illustrates")


class Fact(Entry):
    """一条典型事实：研究里反复出现、模拟应当复现的定量或定性规律。
    A stylised fact: a quantitative or qualitative regularity that recurs in the research and that the simulation should reproduce.
    """

    statement: str
    kind: Literal["quantitative", "qualitative"]
    value: Optional[float] = None
    range: Optional[tuple[float, float]] = None
    unit: str = ""
    conditions: str = Field(description="这个结果是在什么条件下得到的 / the conditions under which this result was obtained")
    caveats: str = Field("", description="复现争议、适用范围 / replication disputes and limits of applicability")
    theories: list[str] = []
    metric: str = Field("", description="polis 里对应的可计算指标；留空表示尚未定义 / the corresponding computable metric in polis; empty means not yet defined")


KINDS: dict[str, type[Entry]] = {"theory": Theory, "cases": Case, "facts": Fact}

# en 里该有的键；值是与它等长的中文列表字段，没有对应列表的是 None
# Keys expected in en; the value names the Chinese list it must match in length, or None when it is not a list
EN_KEYS: dict[str, dict[str, str | None]] = {
    "theory": {"field": None, "claim": None, "formal": None, "parameters": "parameters", "predicts": "predicts", "in_engine": None, "checked": "sources"},
    "cases": {"title": None, "setting": None, "summary": None, "people": "people", "events": "events", "outcome": None, "checked": "sources"},
    "facts": {"title": None, "statement": None, "unit": None, "conditions": None, "caveats": None, "checked": "sources"},
}  # fmt: skip


def missing_english(kind: str, e: Entry) -> list[str]:
    """这一条缺哪些英文。/ Which pieces of English this entry lacks."""
    out = []
    for key, same_as in EN_KEYS[kind].items():
        if key not in e.en:
            out.append(key)
        elif same_as and len(e.en[key]) != len(getattr(e, same_as)):
            out.append(f"{key}（条数与 {same_as} 不一致）")
    return out


def load(kind: str, root: Path = ROOT) -> list[Entry]:
    out = []
    for path in sorted((root / kind).glob("*.yaml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        entry = KINDS[kind].model_validate({"id": path.stem} | data)
        if entry.id != path.stem:
            raise ValueError(f"{path.name}: id 必须与文件名一致")
        out.append(entry)
    return out


def check(root: Path = ROOT) -> tuple[dict[str, list[Entry]], list[str]]:
    """载入全部语料并做交叉检查，返回 (各类条目, 问题列表)。
    Load the whole corpus and cross-check it; returns (entries by kind, list of problems).
    """
    entries = {kind: load(kind, root) for kind in KINDS}
    known = {t.id for t in entries["theory"]}
    problems = []
    for kind in ("cases", "facts"):
        for e in entries[kind]:
            for ref in e.theories:  # type: ignore[attr-defined]
                if ref not in known:
                    problems.append(f"{kind}/{e.id}: 引用了不存在的理论卡 {ref}")
    for kind, es in entries.items():
        for e in es:
            if lack := missing_english(kind, e):
                problems.append(f"{kind}/{e.id}: 缺英文 {'、'.join(lack)}")
    return entries, problems
