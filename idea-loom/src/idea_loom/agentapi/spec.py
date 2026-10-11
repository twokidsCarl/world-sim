"""sim.json 里的 `agent` 一节：一个子项目给 Agent 的说明。

项目自己在 main 上的 sim.json 里有这一节就用它的；还没有的，用 idea-loom 带的临时说明
`idea-loom/data/agent/<项目>.json`。

The `agent` section of sim.json: what a subproject offers to agents. The section in the
project's own sim.json on main wins; until it exists, the interim description
`idea-loom/data/agent/<project>.json` shipped with idea-loom is used.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, ValidationError, model_validator

from .. import store
from ..play import manifest
from ..play.manifest import Text

ID = re.compile(r"^[a-z][a-z0-9_-]{0,40}$")


def _inside(path: str) -> bool:
    return bool(path) and not path.startswith("/") and ".." not in path.split("/")


class Dataset(BaseModel):
    """一个数据集：指向仓库里的文件，加上怎么取记录、哪些字段能搜、许可和出处。

    A dataset: a pointer to files in the repository plus how to take records from them, which
    fields are searchable, the licence and the provenance.
    """

    id: str
    title: Text
    description: Text = Field(default_factory=lambda: Text(zh=""))
    path: str  # 相对于项目目录；可以带 * 通配，这时每个文件是一条记录 / relative to the project directory; with a * each file is one record
    records: str = ""  # 文件里记录在哪：点分路径，空是根 / where the records sit in the file: a dotted path, empty for the root
    key: str = "_id"  # 哪个字段是这条记录的键 / the field that keys a record
    search: list[str] = Field(default_factory=list)  # 搜索时看哪些字段，空是全部 / fields searched, all when empty
    fields: list[str] = Field(default_factory=list)  # 不指定时返回哪些字段，空是全部 / fields returned by default, all when empty
    licence: str  # 必须写明；没有许可声明的数据不对外 / required: data without a stated licence is not offered
    provenance: Text  # 来历和可信程度：谁整理的、核实到什么程度 / where it comes from and how far it was checked

    @model_validator(mode="after")
    def _check(self) -> "Dataset":
        if not ID.match(self.id):
            raise ValueError(f"数据集的编号 {self.id!r} 要小写，只用字母、数字、下划线和连字符")
        if not _inside(self.path):
            raise ValueError(f"数据集 {self.id} 的路径只能是项目里面的相对路径")
        if not self.path.endswith((".json", ".yaml", ".yml")):
            raise ValueError(f"数据集 {self.id} 只能是 JSON 或 YAML 文件")
        if not self.licence.strip():
            raise ValueError(f"数据集 {self.id} 要写明许可")
        return self


class Http(BaseModel):
    method: Literal["GET", "POST"] = "GET"
    path: str  # 项目后端的接口，可以带 {参数} / a route of the project's backend, may contain {parameters}


class Capability(BaseModel):
    """一次有界的、确定性的计算。不调用模型，不写仓库。

    One bounded, deterministic computation. It calls no model and writes nothing to the repository.
    """

    id: str
    title: Text
    description: Text
    http: Http
    input: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})  # JSON Schema
    output: Text = Field(default_factory=lambda: Text(zh=""))  # 返回的是什么，一段话 / what comes back, in a sentence
    deterministic: bool = True
    seconds: float = 10  # 大致要多久；超过三倍就掐掉 / roughly how long; cut off at three times this
    example: dict[str, Any] = Field(default_factory=dict)  # 一个能直接跑的输入 / an input that runs as it is

    @model_validator(mode="after")
    def _check(self) -> "Capability":
        if not ID.match(self.id):
            raise ValueError(f"能力的编号 {self.id!r} 要小写，只用字母、数字、下划线和连字符")
        if not self.http.path.startswith("/api/") or ".." in self.http.path:
            raise ValueError(f"能力 {self.id} 的接口要在 /api/ 下")
        if self.input.get("type") != "object":
            raise ValueError(f"能力 {self.id} 的输入要是一个 JSON Schema 对象")
        if not 0 < self.seconds <= 120:
            raise ValueError(f"能力 {self.id} 的耗时要在 0 到 120 秒之间")
        return self


class AgentSpec(BaseModel):
    summary: Text
    datasets: list[Dataset] = Field(default_factory=list)
    capabilities: list[Capability] = Field(default_factory=list)
    source: Literal["project", "interim"] = "interim"

    @model_validator(mode="after")
    def _check(self) -> "AgentSpec":
        for kind, items in (("数据集", self.datasets), ("能力", self.capabilities)):
            ids = [x.id for x in items]
            if len(ids) != len(set(ids)):
                raise ValueError(f"{kind}的编号有重复")
        return self

    def dataset(self, dataset_id: str) -> Optional[Dataset]:
        return next((d for d in self.datasets if d.id == dataset_id), None)

    def capability(self, capability_id: str) -> Optional[Capability]:
        return next((c for c in self.capabilities if c.id == capability_id), None)


def _interim_dir():
    return store.data_dir() / "agent"


def names() -> list[str]:
    found = set(manifest.names()) | {p.stem for p in _interim_dir().glob("*.json")}
    return sorted(n for n in found if manifest.NAME.match(n))


def load(name: str) -> Optional[AgentSpec]:
    """这个项目给 Agent 的说明；没有就是 None。坏的说明会抛 ValueError。

    The project's description for agents, or None when it has none. A broken one raises ValueError.
    """
    if not manifest.NAME.match(name):
        return None
    raw, source = None, "project"
    text = manifest._from_main(name)
    if text is not None:
        try:
            whole = json.loads(text)
            raw = whole.get("agent") if isinstance(whole, dict) else None
        except ValueError:
            raw = None
    if raw is None:
        path = _interim_dir() / f"{name}.json"
        if not path.exists():
            return None
        raw, source = json.loads(path.read_text(encoding="utf-8")), "interim"
    if not isinstance(raw, dict):
        raise ValueError("agent 一节要是一个对象")
    try:
        return AgentSpec.model_validate({**raw, "source": source})
    except ValidationError as e:
        raise ValueError("；".join(str(err.get("msg", "")).removeprefix("Value error, ") for err in e.errors())) from e


def load_all() -> tuple[dict[str, AgentSpec], dict[str, str]]:
    """（各项目的说明，读不出来的项目和原因）。 / (each project's description, projects that failed and why)."""
    specs: dict[str, AgentSpec] = {}
    problems: dict[str, str] = {}
    for name in names():
        try:
            spec = load(name)
        except ValueError as e:
            problems[name] = str(e)
            continue
        if spec is not None:
            specs[name] = spec
    return specs, problems
