"""目录和想法池：Agent 的第一站。 / The catalogue and the idea pool: an agent's first stop."""

from __future__ import annotations

from typing import Any, Optional

from .. import config, ideas
from ..play import manifest
from . import spec

API = "/api/v1"


class NotFound(LookupError):
    """没有这个东西；消息里告诉 Agent 有哪些。 / No such thing; the message tells an agent what exists."""


def _origin(name: str, port: str) -> str:
    return config.sim_origin(name, port)


def catalog(port: str = "8767") -> dict[str, Any]:
    """这里有什么：每个项目是什么、有哪些数据集和计算、有多少张可以直达的卡片。

    What is here: what each project is, which datasets and computations it offers, and how many deep-linkable cards it has.
    """
    specs, problems = spec.load_all()
    sims = {s.name: s for s in manifest.load_all()[0]}
    projects = []
    for name in sorted(set(specs) | set(sims)):
        sim, agent = sims.get(name), specs.get(name)
        projects.append({
            "name": name,
            "title": sim.title.model_dump() if sim else {"zh": name, "en": name},
            "level": sim.level if sim else None,
            "summary": agent.summary.model_dump() if agent else {"zh": "", "en": ""},
            "ui": _origin(name, port) if sim and sim.ready else None,
            "cards": len(sim.cards) if sim else 0,
            "datasets": [{"id": d.id, "title": d.title.model_dump(), "licence": d.licence, "describe": f"{API}/datasets/{name}/{d.id}/schema"} for d in (agent.datasets if agent else [])],
            "capabilities": [{"id": c.id, "title": c.title.model_dump(), "deterministic": c.deterministic, "describe": f"{API}/capabilities/{name}/{c.id}"} for c in (agent.capabilities if agent else [])],
        })
    pool, _, _, _ = ideas.current()
    live = [i for i in pool.values() if i.status in ("pool", "building", "built")]
    frame = ideas.load_frame()
    return {
        "about": {
            "zh": "world-sim：从物理定律一层层往上，一直模拟到文明。这里是一组模拟项目、它们整理的数据，和一个想法池。",
            "en": "world-sim: from the laws of physics up to civilisation, one layer at a time. A set of simulation projects, the data they curated, and a pool of ideas.",
        },
        "start_here": {
            "zh": "先看 projects 里各项目的 summary；数据用 datasets 的 describe 地址看结构再查；计算用 capabilities 的 describe 地址看输入和例子再跑；想法池用 /api/v1/ideas?q=。",
            "en": "Read each project's summary under `projects`; for data, open a dataset's `describe` URL to see its shape, then query it; for computations, open a capability's `describe` URL for its input and an example, then run it; search the idea pool with /api/v1/ideas?q=.",
        },
        "projects": projects,
        "ideas": {"live": len(live), "search": f"{API}/ideas?q=", "levels": [{"id": lv.id, "name": {"zh": lv.name, "en": lv.name_en}} for lv in frame.levels],
                  "threads": [{"id": th.id, "name": {"zh": th.name, "en": th.name_en}} for th in frame.threads]},
        "problems": problems,
        "docs": {"llms_txt": "/llms.txt", "full": "/llms-full.txt", "openapi": "/openapi.json", "mcp": "/mcp"},
    }


def project_spec(name: str) -> spec.AgentSpec:
    try:
        found = spec.load(name)
    except ValueError as e:
        raise NotFound(f"{name} 的说明读不出来：{e}") from e
    if found is None:
        raise NotFound(f"没有 {name!r} 这个项目。有的：{', '.join(spec.names())}")
    return found


def dataset(name: str, dataset_id: str) -> spec.Dataset:
    agent = project_spec(name)
    found = agent.dataset(dataset_id)
    if found is None:
        raise NotFound(f"{name} 没有 {dataset_id!r} 这个数据集。有的：{', '.join(d.id for d in agent.datasets) or '（没有数据集）'}")
    return found


def capability(name: str, capability_id: str) -> spec.Capability:
    agent = project_spec(name)
    found = agent.capability(capability_id)
    if found is None:
        raise NotFound(f"{name} 没有 {capability_id!r} 这个能力。有的：{', '.join(c.id for c in agent.capabilities) or '（没有可调用的计算）'}")
    return found


def describe_capability(name: str, capability_id: str) -> dict[str, Any]:
    cap = capability(name, capability_id)
    return {"project": name, "capability": cap.id, "title": cap.title.model_dump(), "description": cap.description.model_dump(),
            "input": cap.input, "output": cap.output.model_dump(), "deterministic": cap.deterministic, "seconds": cap.seconds,
            "example": cap.example, "how_to_run": f"POST {API}/run/{name}/{cap.id} with the input as the JSON body"}


# ---------- 想法池 / the idea pool ----------

BRIEF = ("id", "title", "title_en", "level", "threads", "kernel", "status", "projects")


def _brief(idea: Any, full: bool) -> dict[str, Any]:
    out = {k: getattr(idea, k) for k in BRIEF}
    if full:
        out["body"] = idea.body
        out["body_en"] = idea.body_en
    return out


def search_ideas(q: str = "", level: str = "", thread: str = "", kernel: str = "", project: str = "", status: str = "",
                 limit: int = 20, after: int = 0, full: bool = False) -> dict[str, Any]:
    """搜想法池。默认只看还活着的（在池、在做、做成了），只给标题和位置；full 为真才带正文。

    真 Agent 试下来的教训：带着正文的整池结果太大，Agent 读不完，只好一小块一小块地搜。
    所以默认只给标题——整个池一次就能看完——要正文再用 full 或者取单条。

    Search the idea pool; by default only live ideas (in the pool, being built, built), with
    titles and positions only; bodies come with `full`. Learned from trying a real agent: the
    whole pool with bodies was too big to read, forcing it to search in small pieces. Titles
    by default let the whole pool be seen in one go; bodies come with `full` or one idea at a time.
    """
    if not 1 <= limit <= 200:
        raise ValueError("limit 要在 1 到 200 之间")
    pool, _, _, _ = ideas.current()
    items = sorted(pool.values(), key=lambda i: ideas.sort_key(i.id))
    wanted = {status} if status else {"pool", "building", "built"}
    items = [i for i in items if i.status in wanted]
    if level:
        items = [i for i in items if i.level == level]
    if thread:
        items = [i for i in items if thread in i.threads]
    if kernel:
        items = [i for i in items if (i.kernel or "") == kernel]
    if project:
        items = [i for i in items if project in i.projects]
    for term in q.lower().split():
        items = [i for i in items if term in f"{i.id} {i.title} {i.title_en or ''} {i.body} {i.body_en or ''} {i.kernel or ''}".lower()]
    page = items[after:after + limit]
    reached = after + len(page)
    return {"total": len(items), "count": len(page), "next": reached if reached < len(items) else None, "ideas": [_brief(i, full) for i in page],
            "note": None if full else "Titles only. Add full=true for the bodies, or GET /api/v1/ideas/{id} for one idea with its history."}


def get_idea(idea_id: str) -> dict[str, Any]:
    """一条 idea 的全文、历史、血缘，以及做它的项目和能打开的卡片。 / One idea in full: text, history, lineage, the projects building it and the cards that open it."""
    found = ideas.detail(idea_id)
    if found is None:
        raise NotFound(f"没有 {idea_id!r} 这条 idea。用 {API}/ideas?q= 搜一下。")
    out = found.model_dump()
    out["cards"] = [{"project": s.name, "id": c.id, "title": c.title.model_dump(), "hint": c.hint.model_dump()}
                    for s in manifest.load_all()[0] for c in s.cards if c.idea == idea_id]
    return out


def card_url(project: str, card_id: str, port: str = "8767") -> Optional[dict[str, Any]]:
    for sim in manifest.load_all()[0]:
        if sim.name == project:
            for card in sim.cards:
                if card.id == card_id:
                    return {"project": project, "id": card.id, "title": card.title.model_dump(), "hint": card.hint.model_dump(),
                            "url": _origin(project, port) + card.url, "note": "这个地址要在浏览器里打开，给人看的。 / Open this in a browser; it is for a person to look at."}
    return None


def cards(project: str = "", idea: str = "", port: str = "8767") -> list[dict[str, Any]]:
    out = []
    for sim in manifest.load_all()[0]:
        if project and sim.name != project:
            continue
        for card in sim.cards:
            if idea and card.idea != idea:
                continue
            out.append({"project": sim.name, "id": card.id, "title": card.title.model_dump(), "hint": card.hint.model_dump(), "idea": card.idea,
                        "url": _origin(sim.name, port) + card.url})
    return out
