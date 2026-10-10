"""语料：理论卡、案例、典型事实。每条都带出处；没有逐条核实过的出处不进入校准。"""

from __future__ import annotations

from pathlib import Path
from typing import Literal, Optional

import yaml
from pydantic import BaseModel, Field, model_validator

ROOT = Path(__file__).resolve().parents[2] / "corpus"


class Source(BaseModel):
    """一条出处。verified 只有在打开过能证实它的页面之后才能为真，checked 写明看的是哪一页、证实了什么。"""

    work: str
    author: str
    year: Optional[int] = None
    locator: str = Field("", description="期刊卷期页码、章回、幕次")
    url: str = ""
    verified: bool = False
    checked: str = Field("", description="核实方式：哪个页面证实了哪些信息")

    @model_validator(mode="after")
    def _verified_needs_evidence(self):
        if self.verified and not (self.url and self.checked):
            raise ValueError(f"{self.work}: verified 为真时必须有 url 和 checked")
        return self


class Entry(BaseModel):
    id: str
    title: str
    sources: list[Source] = Field(min_length=1)

    @property
    def verified(self) -> bool:
        return all(s.verified for s in self.sources)


class Parameter(BaseModel):
    name: str
    meaning: str


class Theory(Entry):
    """一个机制：它说人群里会发生什么、为什么。"""

    title_en: str
    field: str
    claim: str = Field(description="机制，用自己的话写")
    formal: str = Field("", description="公式或规则的文字表述")
    parameters: list[Parameter] = []
    predicts: list[str] = Field(description="如果机制成立，应当观察到什么")
    in_engine: str = Field("", description="polis 引擎里哪一处实现了它；留空表示尚未实现")


class Character(BaseModel):
    name: str
    role: str
    traits: str = ""


class Beat(BaseModel):
    what: str
    who: list[str] = []


class Case(Entry):
    """一个可以拿来做输入和校准的故事：谁、什么关系、依次发生了什么。"""

    kind: Literal["drama", "novel", "idiom", "history"]
    setting: str
    summary: str
    people: list[Character]
    events: list[Beat] = Field(description="原作或史料里的事件顺序")
    outcome: str = Field(description="结局；模拟要复现的就是它")
    theories: list[str] = Field(description="这个故事体现了哪些理论卡，写 id")


class Fact(Entry):
    """一条典型事实：研究里反复出现、模拟应当复现的定量或定性规律。"""

    statement: str
    kind: Literal["quantitative", "qualitative"]
    value: Optional[float] = None
    range: Optional[tuple[float, float]] = None
    unit: str = ""
    conditions: str = Field(description="这个结果是在什么条件下得到的")
    caveats: str = Field("", description="复现争议、适用范围")
    theories: list[str] = []
    metric: str = Field("", description="polis 里对应的可计算指标；留空表示尚未定义")


KINDS: dict[str, type[Entry]] = {"theory": Theory, "cases": Case, "facts": Fact}


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
    """载入全部语料并做交叉检查，返回 (各类条目, 问题列表)。"""
    entries = {kind: load(kind, root) for kind in KINDS}
    known = {t.id for t in entries["theory"]}
    problems = []
    for kind in ("cases", "facts"):
        for e in entries[kind]:
            for ref in e.theories:  # type: ignore[attr-defined]
                if ref not in known:
                    problems.append(f"{kind}/{e.id}: 引用了不存在的理论卡 {ref}")
    return entries, problems
