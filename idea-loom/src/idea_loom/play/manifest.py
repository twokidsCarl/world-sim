"""名片 sim.json：一个子项目怎么被托管、有哪些卡片。

项目自己在 main 上的 `<项目>/sim.json` 优先；它还没提交时，用 idea-loom 带的临时名片
`idea-loom/data/play/<项目>.json`。

The card file sim.json: how a subproject is hosted and which cards it offers. The
project's own `<project>/sim.json` on main wins; until it exists, the interim file
`idea-loom/data/play/<project>.json` shipped with idea-loom is used.
"""

from __future__ import annotations

import json
import re
import subprocess
from typing import Literal, Optional

from pydantic import BaseModel, Field, ValidationError, model_validator

from .. import store

NAME = re.compile(r"^[a-z][a-z0-9-]{1,30}$")
REF = "origin/main"


class Text(BaseModel):
    zh: str
    en: str = ""


class Web(BaseModel):
    """要构建的前端。 / A frontend that needs building."""

    dir: str = "."
    build: list[list[str]] = Field(default_factory=lambda: [["bun", "install"], ["bunx", "vite", "build"]])
    dist: str = "dist"


class Static(BaseModel):
    """不用构建、直接提供的静态文件。 / Static files served as they are."""

    dir: str


class Api(BaseModel):
    """项目自己的后端。`run` 里的 {port} 由 idea-loom 填；接口都在 /api 下。

    The project's own backend. idea-loom fills in {port} in `run`; all routes live under /api.
    """

    dir: str = "."
    prepare: list[list[str]] = Field(default_factory=list)  # 构建时跑一次，例如装依赖 / run once at build time, e.g. installing dependencies
    run: list[str]
    health: str = "/api/health"
    env: dict[str, str] = Field(default_factory=dict)  # 值里可以用 {repo}、{state}、{port} / values may use {repo}, {state}, {port}


class Card(BaseModel):
    id: str
    title: Text
    hint: Text = Field(default_factory=lambda: Text(zh=""))
    idea: Optional[str] = None  # 它属于想法池里的哪一条 / which idea in the pool it belongs to
    url: str = "/"  # 直达这个场景的地址，相对于这个模拟自己的根 / deep link to the scenario, relative to the simulation's own root


class Sim(BaseModel):
    name: str
    title: Text
    level: Optional[str] = None
    ready: bool = True
    web: Optional[Web] = None
    static: Optional[Static] = None
    api: Optional[Api] = None
    cards: list[Card] = Field(default_factory=list)
    source: Literal["project", "interim"] = "interim"

    @model_validator(mode="after")
    def _check(self) -> "Sim":
        if not NAME.match(self.name):
            raise ValueError("名字要短、小写，只用字母、数字和连字符")
        if (self.web is None) == (self.static is None):
            raise ValueError("web 和 static 必须有且只有一个")
        seen: set[str] = set()
        for card in self.cards:
            if card.id in seen:
                raise ValueError(f"卡片编号重复：{card.id}")
            seen.add(card.id)
            if not card.url.startswith("/"):
                raise ValueError(f"卡片 {card.id} 的地址要以 / 开头")
        for part in [self.web.dir if self.web else "", self.web.dist if self.web else "", self.static.dir if self.static else "", self.api.dir if self.api else ""]:
            if part.startswith("/") or ".." in part.split("/"):
                raise ValueError("目录只能是项目里面的相对路径")
        if self.api is not None and not any("{port}" in arg for arg in self.api.run) and not any("{port}" in v for v in self.api.env.values()):
            raise ValueError("后端的启动命令或环境变量里要有 {port}")
        return self


class Problem(BaseModel):
    """一张读不出来的名片，连同原因。 / A card file that could not be read, with the reason."""

    name: str
    source: str
    error: str


def _from_main(name: str) -> Optional[str]:
    shown = subprocess.run(["git", "-C", str(store.repo_root()), "show", f"{REF}:{name}/sim.json"], capture_output=True, text=True)
    return shown.stdout if shown.returncode == 0 else None


def names() -> list[str]:
    """有名片的项目：临时名片里的，加上 main 上带 sim.json 的顶层目录。

    Projects with a card file: those with an interim one, plus top-level directories on main that carry a sim.json.
    """
    found = {p.stem for p in (store.data_dir() / "play").glob("*.json")}
    listed = subprocess.run(["git", "-C", str(store.repo_root()), "ls-tree", "-r", "--name-only", REF], capture_output=True, text=True).stdout
    found |= {line.split("/")[0] for line in listed.splitlines() if line.count("/") == 1 and line.endswith("/sim.json")}
    return sorted(n for n in found if NAME.match(n))


def load(name: str) -> Sim:
    text, source = _from_main(name), "project"
    if text is None:
        path = store.data_dir() / "play" / f"{name}.json"
        if not path.exists():
            raise FileNotFoundError(f"没有 {name} 的名片")
        text, source = path.read_text(encoding="utf-8"), "interim"
    raw = json.loads(text)
    if not isinstance(raw, dict):
        raise ValueError("名片要是一个对象")
    return Sim.model_validate({**raw, "name": name, "source": source})


def load_all() -> tuple[list[Sim], list[Problem]]:
    sims, problems = [], []
    for name in names():
        try:
            sims.append(load(name))
        except (ValueError, ValidationError, FileNotFoundError) as e:
            source = "project" if _from_main(name) is not None else "interim"
            problems.append(Problem(name=name, source=source, error=str(e).splitlines()[-1][:300] if isinstance(e, ValidationError) else str(e)[:300]))
    return sims, problems
