"""把一次模拟连同每一层的独白导出成一条 JSON 记录。"""

from __future__ import annotations

import asyncio

from . import narrative, recursion, runner
from .model import Case
from .recursion import Level


def build(p: runner.Params) -> tuple[Case, dict[str, int], dict[str, float], dict[str, list[Level]], dict]:
    """按参数算出两座塔和结局，与 runner.compute 完全同一套算法（含钉住、代选、自加的话）。"""
    case, depth, lam = runner.prepare(p)
    g = case.game
    towers = {r: recursion.tower(g, r, depth[r], lam, p.pins.get(r, {})) for r in ("a", "b")}
    out = recursion.outcome(g, towers["a"][-1], towers["b"][-1], p.forced_a, p.forced_b)
    return case, depth, lam, towers, out


async def narrate(p: runner.Params, use_llm: bool = True, persona_mode: str = "original", regenerate: bool = False) -> dict:
    """两座塔，每层带 line（模板句）和 monologue（独白）。"""
    case, depth, lam, towers, out = build(p)

    async def one(r: str, j: int) -> dict:
        d = towers[r][j].to_dict()
        d["line"] = narrative.template_line(case, towers[r], r, j, out)
        d["nesting"] = narrative.nesting_path(case, towers[r], j, persona_mode)
        if use_llm:
            m = await narrative.monologue(case, towers[r], r, j, out, persona_mode, regenerate)
        else:
            m = {"text": d["line"], "source": "template"}
        d["monologue"], d["monologue_source"] = m["text"], m["source"]
        return d

    keys = [(r, j) for r in ("a", "b") for j in range(len(towers[r]))]
    layers = await asyncio.gather(*(one(r, j) for r, j in keys))
    tower_json: dict[str, list[dict]] = {"a": [], "b": []}
    for (r, _), d in zip(keys, layers):
        tower_json[r].append(d)
    return {
        "case_id": case.id,
        "case": case.model_dump(exclude={"source"}),
        "source": case.source.model_dump(),
        "persona_mode": persona_mode,
        "depth": depth,
        "lam": lam,
        "towers": tower_json,
        "outcome": out,
    }
