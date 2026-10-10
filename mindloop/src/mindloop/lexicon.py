"""用户自己写的一句话 → 这句话的字面含义行和代价（仅信号博弈）。"""

from __future__ import annotations

from . import llm
from .model import Case, Signaling
from .narrative import _flat

SYSTEM = "你是语用学家，负责给一句话标注「字面语义」。只按给定的 JSON 结构作答。"


def schema(n_states: int) -> dict:
    return {
        "type": "object",
        "properties": {
            "cost": {"type": "number", "description": "代价，不小于 0"},
            "literal": {
                "type": "array",
                "items": {"type": "number"},
                "description": f"恰好 {n_states} 个 0 到 1 之间的数，按状态顺序",
            },
        },
        "required": ["cost", "literal"],
        "additionalProperties": False,
    }


def build_prompt(case: Case, text: str) -> str:
    g = case.game
    states = "、".join(f"({i + 1}) {s}" for i, s in enumerate(g.states))
    examples = "\n".join(
        f"- 「{m.text}」 → literal = {[round(float(x), 2) for x in row]}，cost = {m.cost:g}"
        for m, row in zip(g.messages, g.literal)
    )
    max_cost = max((m.cost for m in g.messages), default=0.0)
    cost_hint = (
        f"已有话语的 cost 在 0 到 {max_cost:g} 之间，请用同一把尺子。"
        if max_cost > 0
        else "已有话语的 cost 都是 0；除非这句话明显更伤面子、更露骨或更费事，否则给 0，最多不超过 2。"
    )
    return "\n".join(
        [
            f"【场景】{_flat(case.summary)}",
            f"【说话者】{case.a.name}　【听者】{case.b.name}",
            f"【隐藏状态】只有说话者知道，按顺序为：{states}",
            "【已有的话语及其标注（作为刻度参考）】",
            examples,
            "",
            f"现在说话者改说（或改做）：「{text}」",
            "",
            "请标注两样东西：",
            f"1. literal：长度为 {len(g.states)} 的数组，按上面状态的顺序，每个数在 0 到 1 之间。"
            "它表示：只看字面，在该状态下说这句话有多真实、多自然（1 = 完全贴切，0 = 字面上明显不符）。"
            "只按字面意思判断，不要考虑一个聪明的听者会从中推断出什么言外之意；"
            "一句对各状态都说得通的含糊话，各项应当都比较高且接近。",
            f"2. cost：说这句话给说话者带来的代价（太直白、失礼、伤面子、费力）。{cost_hint}",
        ]
    )


def _fallback(n: int, text: str) -> dict:
    return {"text": text, "cost": 0.0, "literal": [round(1.0 / n, 4)] * n, "source": "fallback"}


async def estimate(case: Case, text: str) -> dict:
    """返回 {"text", "cost", "literal": [每个状态一个 0..1 的数], "source"}。离线时退回均匀行。"""
    g = case.game
    if not isinstance(g, Signaling):
        raise ValueError(f"案例 {case.id} 不是信号博弈，没有话语可加")
    text = text.strip()
    n = len(g.states)
    try:
        if not llm.available():
            return _fallback(n, text)
        value, cached = await llm.aask_meta(build_prompt(case, text), system=SYSTEM, schema=schema(n))
        literal = [min(1.0, max(0.0, float(x))) for x in value["literal"]]
        if len(literal) != n:
            return _fallback(n, text)
        cost = max(0.0, float(value["cost"]))
        return {
            "text": text,
            "cost": round(cost, 3),
            "literal": [round(x, 3) for x in literal],
            "source": "cache" if cached else "claude",
        }
    except Exception:  # noqa: BLE001
        return _fallback(n, text)
