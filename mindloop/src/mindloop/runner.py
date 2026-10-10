"""一次完整的模拟：给定案例和两人的参数，算出两座塔、结局和层级走向。"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from . import narrative, recursion
from .cases import get_case
from .model import Case, Message, Signaling, Simultaneous

MAX_DEPTH = 12


class ExtraMessage(BaseModel):
    """用户自己加进来的一句话。"""

    text: str
    cost: float = 0.0
    literal: list[float]


class Params(BaseModel):
    case_id: str
    depth_a: Optional[int] = None  # 缺省 = 原作中的层数
    depth_b: Optional[int] = None
    lam_a: Optional[float] = None
    lam_b: Optional[float] = None
    bias: Optional[float] = None  # 仅 quadratic 收益的案例
    true_state: Optional[int] = None
    forced_a: Optional[int] = None  # 用户替 a 选
    forced_b: Optional[int] = None  # 用户替 b 选
    pins: dict[str, dict[str, dict[str, int]]] = Field(default_factory=dict)  # {a|b: {层: {行: 列}}}
    extra_messages: list[ExtraMessage] = Field(default_factory=list)
    ladder_depth: int = 12


def prepare(p: Params) -> tuple[Case, dict[str, int], dict[str, float]]:
    """按参数改好案例，返回 (案例, 两人的层数, 两人的理性度)。"""
    case = get_case(p.case_id)
    if case.game is None:
        raise ValueError(f"案例 {case.id} 只有文字讲解，不能运行")
    g = case.game
    if isinstance(g, Signaling):
        for em in p.extra_messages:
            if len(em.literal) != len(g.states):
                raise ValueError("extra_messages.literal 长度应等于状态数")
            g.messages.append(Message(text=em.text, cost=em.cost))
            g.literal.append(list(em.literal))
        if p.bias is not None:
            g.apply_bias(p.bias)
        if p.true_state is not None:
            if not 0 <= p.true_state < len(g.states):
                raise ValueError("true_state 越界")
            g.true_state = p.true_state
    clamp = lambda d, default: max(0, min(MAX_DEPTH, default if d is None else d))
    depth = {
        "a": clamp(p.depth_a, case.canonical.depth_a if case.canonical.depth_a is not None else 1),
        "b": clamp(p.depth_b, case.canonical.depth_b if case.canonical.depth_b is not None else 1),
    }
    lam = {"a": p.lam_a if p.lam_a is not None else case.lam, "b": p.lam_b if p.lam_b is not None else case.lam}
    return case, depth, lam


def _canonical_match(case: Case, tower_a, tower_b, out: dict) -> Optional[dict]:
    c = case.canonical
    if c.choice_a is None and c.choice_b is None:
        return None
    a_cols, b_cols = tower_a[-1].cols, tower_b[-1].cols
    res = {
        "a": None if c.choice_a is None else a_cols[out["choice_a"]] == c.choice_a,
        "b": None if c.choice_b is None else b_cols[out["choice_b"]] == c.choice_b,
    }
    res["all"] = all(v for v in (res["a"], res["b"]) if v is not None)
    return res


def compute(p: Params) -> dict:
    case, depth, lam = prepare(p)
    g = case.game
    towers = {r: recursion.tower(g, r, depth[r], lam, p.pins.get(r, {})) for r in ("a", "b")}
    out = recursion.outcome(g, towers["a"][-1], towers["b"][-1], p.forced_a, p.forced_b)
    ladder_depth = max(2, min(MAX_DEPTH, p.ladder_depth))

    tower_json = {}
    for r in ("a", "b"):
        levels = []
        for j, lv in enumerate(towers[r]):
            d = lv.to_dict()
            d["line"] = narrative.template_line(case, towers[r], r, j, out)
            d["focus_row"] = narrative.focus_row(g, lv, out)
            levels.append(d)
        tower_json[r] = levels

    game_json = g.model_dump()
    if isinstance(g, Signaling):
        game_json["messages"] = [m.model_dump() for m in g.messages]

    result = {
        "case": case.model_dump(exclude={"game"}),
        "game": game_json,
        "depth": depth,
        "lam": lam,
        "towers": tower_json,
        "outcome": out,
        "analysis": recursion.analyze(g, ladder_depth, lam),
        "equilibrium": recursion.equilibrium(g, lam),
        "canonical_match": _canonical_match(case, towers["a"], towers["b"], out),
        "played": {},
    }
    # 用户亲自下场时：这个选择相当于想了几层
    if p.forced_a is not None:
        row = g.true_state if isinstance(g, Signaling) else 0
        result["played"]["a"] = recursion.equivalent_depth(g, "a", lam, row, p.forced_a)
    if p.forced_b is not None:
        row = out["choice_a"] if isinstance(g, Signaling) else 0
        result["played"]["b"] = recursion.equivalent_depth(g, "b", lam, row, p.forced_b)
    return result


def case_card(case: Case) -> dict:
    return {
        "id": case.id,
        "title": case.title,
        "category": case.category,
        "hook": case.hook,
        "runnable": case.runnable,
        "theory": case.theory,
        "kind": case.game.kind if case.game else None,
        "source": case.source.model_dump(),
        "a": case.a.name,
        "b": case.b.name,
    }
