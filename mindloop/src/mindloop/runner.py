"""一次完整的模拟：给定案例和两人的参数，算出两座塔、结局和层级走向。
One full simulation: from a case and both people's parameters, compute the two towers, the outcome and the level-by-level trend.
"""

from __future__ import annotations

import math
from typing import Optional

from pydantic import BaseModel, Field

from . import narrative, recursion
from .cases import get_case
from .model import Case, Message, Signaling, Simultaneous

MAX_DEPTH = 12
MAX_LAM = 50.0
MAX_BIAS = 10.0
MAX_COST = 100.0
MAX_EXTRA = 8  # 一次最多加几句话 / extra messages allowed per request
MAX_TEXT = 200


class ExtraMessage(BaseModel):
    """用户自己加进来的一句话。 / A sentence added by the user."""

    text: str
    cost: float = 0.0
    literal: list[float]


class Params(BaseModel):
    case_id: str
    depth_a: Optional[int] = None  # 缺省 = 原作中的层数 / default: the depth in the source story
    depth_b: Optional[int] = None
    lam_a: Optional[float] = None
    lam_b: Optional[float] = None
    bias: Optional[float] = None  # 仅 quadratic 收益的案例 / quadratic-payoff cases only
    true_state: Optional[int] = None
    forced_a: Optional[int] = None  # 用户替 a 选 / the user chooses for a
    forced_b: Optional[int] = None  # 用户替 b 选 / the user chooses for b
    pins: dict[str, dict[str, dict[str, int]]] = Field(default_factory=dict)  # {a|b: {层 level: {行 row: 列 col}}}
    extra_messages: list[ExtraMessage] = Field(default_factory=list)
    ladder_depth: int = 12


def _bad(field: str, zh: str, en: str) -> ValueError:
    """一条能照着改的错误：哪个字段、允许什么。 / An error one can act on: which field, what is allowed."""
    return ValueError(f"{field}：{zh} / {field}: {en}")


def _index(field: str, value: Optional[int], options: list[str]) -> None:
    if value is not None and not 0 <= value < len(options):
        listed = "、".join(f"{i}={o}" for i, o in enumerate(options))
        raise _bad(field, f"应在 0..{len(options) - 1} 之间（{listed}），收到 {value}", f"must be an index in 0..{len(options) - 1}, got {value}")


def _check_extra(p: Params, g) -> None:
    if not p.extra_messages:
        return
    if not isinstance(g, Signaling):
        raise _bad("extra_messages", "只有信号博弈的案例能加话", "only signaling-game cases take extra messages")
    if len(p.extra_messages) > MAX_EXTRA:
        raise _bad("extra_messages", f"最多 {MAX_EXTRA} 句", f"at most {MAX_EXTRA} items")
    n = len(g.states)
    for i, em in enumerate(p.extra_messages):
        f = f"extra_messages[{i}]"
        if not em.text.strip() or len(em.text) > MAX_TEXT:
            raise _bad(f"{f}.text", f"不能为空，最长 {MAX_TEXT} 字", f"must be non-empty and at most {MAX_TEXT} characters")
        if not (math.isfinite(em.cost) and abs(em.cost) <= MAX_COST):
            raise _bad(f"{f}.cost", f"应在 ±{MAX_COST:g} 之间", f"must be within ±{MAX_COST:g}")
        if len(em.literal) != n:
            raise _bad(f"{f}.literal", f"长度应等于状态数 {n}（{'、'.join(g.states)}）", f"needs one number per state, {n} in all")
        if not all(math.isfinite(x) and 0 <= x <= 1 for x in em.literal) or sum(em.literal) <= 0:
            raise _bad(f"{f}.literal", "每个数应在 0..1 之间，且不能全是 0", "each number must be in 0..1 and not all may be 0")


def prepare(p: Params) -> tuple[Case, dict[str, int], dict[str, float]]:
    """按参数改好案例，返回 (案例, 两人的层数, 两人的理性度)。参数不对时抛 ValueError。
    Apply the parameters to the case and return (case, both depths, both rationalities). Raises ValueError on a bad parameter.
    """
    case = get_case(p.case_id)
    if case.game is None:
        raise _bad("case_id", f"案例 {case.id} 只有文字讲解，不能运行", f"case {case.id} is a prose-only reader and cannot be computed")
    g = case.game
    for name, v in (("lam_a", p.lam_a), ("lam_b", p.lam_b)):
        if v is not None and not (math.isfinite(v) and 0 <= v <= MAX_LAM):
            raise _bad(name, f"应在 0..{MAX_LAM:g} 之间，收到 {v}", f"must be between 0 and {MAX_LAM:g}, got {v}")
    _check_extra(p, g)
    if p.bias is not None:
        if not isinstance(g, Signaling) or g.quadratic is None:
            raise _bad("bias", f"案例 {case.id} 没有偏差参数（只有二次收益的案例有，如 crawford_sobel）", f"case {case.id} has no bias parameter (only quadratic-payoff cases such as crawford_sobel do)")
        if not (math.isfinite(p.bias) and abs(p.bias) <= MAX_BIAS):
            raise _bad("bias", f"应在 ±{MAX_BIAS:g} 之间", f"must be within ±{MAX_BIAS:g}")
    if isinstance(g, Signaling):
        for em in p.extra_messages:
            g.messages.append(Message(text=em.text, cost=em.cost))
            g.literal.append(list(em.literal))
        if p.bias is not None:
            g.apply_bias(p.bias)
        _index("true_state", p.true_state, g.states)
        if p.true_state is not None:
            g.true_state = p.true_state
        _index("forced_a", p.forced_a, [m.text for m in g.messages])
        _index("forced_b", p.forced_b, g.actions)
    else:
        if p.true_state is not None:
            raise _bad("true_state", f"案例 {case.id} 是同时博弈，没有隐藏的实情", f"case {case.id} is a simultaneous game and has no hidden state")
        _index("forced_a", p.forced_a, g.actions_a)
        _index("forced_b", p.forced_b, g.actions_b)
    clamp = lambda d, default: max(0, min(MAX_DEPTH, default if d is None else d))
    depth = {
        "a": clamp(p.depth_a, case.canonical.depth_a if case.canonical.depth_a is not None else 1),
        "b": clamp(p.depth_b, case.canonical.depth_b if case.canonical.depth_b is not None else 1),
    }
    lam = {"a": p.lam_a if p.lam_a is not None else case.lam, "b": p.lam_b if p.lam_b is not None else case.lam}
    return case, depth, lam


def _as_int(field: str, text: str) -> int:
    try:
        return int(text)
    except (TypeError, ValueError):
        raise _bad(field, f"键应是整数，收到 {text!r}", f"keys must be integers, got {text!r}") from None


def check_pins(pins: dict, towers: dict[str, list]) -> None:
    """钉子的行列要落在那一层的表里；比塔还深的层不算错，只是用不上。
    A pin's row and column must exist in that level's table; levels deeper than the tower are not an error, merely unused.
    """
    for r, by_level in pins.items():
        if r not in ("a", "b"):
            raise _bad("pins", f"第一层的键应是 a 或 b，收到 {r!r}", f"top-level keys must be 'a' or 'b', got {r!r}")
        for lv_key, rows in by_level.items():
            j = _as_int(f"pins.{r}", lv_key)
            if j < 0:
                raise _bad(f"pins.{r}", f"层号不能是负数，收到 {j}", f"a level cannot be negative, got {j}")
            if j >= len(towers[r]):
                continue
            lv = towers[r][j]
            for row_key, col in rows.items():
                f = f"pins.{r}.{j}"
                row = _as_int(f, row_key)
                if not 0 <= row < len(lv.rows):
                    raise _bad(f, f"行应在 0..{len(lv.rows) - 1} 之间，收到 {row}", f"row must be in 0..{len(lv.rows) - 1}, got {row}")
                if not 0 <= col < len(lv.cols):
                    listed = "、".join(f"{i}={c}" for i, c in enumerate(lv.cols))
                    raise _bad(f"{f}.{row}", f"列应在 0..{len(lv.cols) - 1} 之间（{listed}），收到 {col}", f"column must be in 0..{len(lv.cols) - 1}, got {col}")


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
    check_pins(p.pins, towers)
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
    # 用户亲自下场时：这个选择相当于想了几层 / when the user plays: how many levels of thought this choice equals
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
