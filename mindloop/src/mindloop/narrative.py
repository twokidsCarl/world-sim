"""把每一层的数值结论说成人话。

template_line：即时的、确定性的一句结论（不调用模型）。
monologue    ：经 claude -p 生成的内心独白（见 llm.py）。
"""

from __future__ import annotations

import re

from . import llm
from .model import Case, Signaling, other
from .recursion import Level

MAX_LISTED_STATES = 4
MONOLOGUE_SYSTEM = (
    "你是一位擅长写人物心理的小说家。你只输出人物的内心独白本身："
    "不加引号、不加人名、不加解释、不分行。"
)


def focus_row(game, lv: Level, out: dict) -> int:
    """这一层最该看哪一行：说话者看真实状态那行，听者看实际听到的那句话那行。"""
    if not isinstance(game, Signaling):
        return 0
    return out["true_state"] if lv.role == "a" else out["choice_a"]


# ---------- 一句话结论 ----------


def _is_self(tower: list[Level], owner: str, j: int) -> bool:
    """第 j 层是不是塔主本人此刻的真实想法（塔顶），而不是谁想象出来的人。"""
    return j == len(tower) - 1 and tower[j].role == owner


def _join(items: list[str]) -> str:
    return "或".join(items)


def _simultaneous_line(tower: list[Level], j: int, me: str, you: str) -> str:
    lv = tower[j]
    pick = lv.cols[lv.choice()]
    if 0 in lv.pinned:
        return f"{me}认定要选「{pick}」"
    if j == 0:
        return f"{me}不多想，凭直觉选「{pick}」"
    inner = tower[j - 1]
    return f"{you}会选「{inner.cols[inner.choice()]}」→ {me}选「{pick}」"


def _speaker_line(g: Signaling, tower: list[Level], owner: str, j: int, out: dict, me: str, you: str) -> str:
    lv = tower[j]
    inner = tower[j - 1] if j > 0 else None  # 听者那一层：policy[话][行动]

    def reaction(m: int) -> str:
        return inner.cols[inner.choice(m)]

    if _is_self(tower, owner, j):  # 本人知道实情，只说眼下这一种情况
        t = out["true_state"]
        m = lv.choice(t)
        if t in lv.pinned:
            return f"实情是{g.states[t]}：{me}认定要「{lv.cols[m]}」"
        if inner is None:
            return f"实情是{g.states[t]}：{me}不绕弯，照字面就「{lv.cols[m]}」"
        return f"实情是{g.states[t]}：{you}见「{lv.cols[m]}」会{reaction(m)} → {me}就「{lv.cols[m]}」"

    # 别人想象中的说话者：不知道处于哪种情况，是一张「若…就…」的表
    rows = list(range(len(lv.rows)))
    tail = ""
    if len(rows) > MAX_LISTED_STATES:
        rows, tail = [out["true_state"]], "（其余情况略）"
    groups: dict[int, list[int]] = {}
    for r in rows:
        groups.setdefault(lv.choice(r), []).append(r)
    subject = "" if inner is None else me
    parts = []
    for m, rs in groups.items():
        cond = "无论哪种情况，" if len(rs) == len(lv.rows) > 1 else f"若{_join([lv.rows[r] for r in rs])}，"
        why = f"（料{you}会{reaction(m)}）" if inner is not None and not any(r in lv.pinned for r in rs) else ""
        verb = "都" if cond.startswith("无论") else "就"
        parts.append(f"{cond}{subject}{verb}「{lv.cols[m]}」{why}")
    body = "；".join(parts) + tail
    return f"{me}不绕弯，照字面来：{body}" if inner is None else body


def _listener_line(g: Signaling, tower: list[Level], j: int, out: dict, me: str, you: str) -> str:
    lv = tower[j]
    m = out["choice_a"]
    guess = int(lv.belief[m].argmax())
    p = float(lv.belief[m][guess])
    act = lv.cols[lv.choice(m)]
    seen, state, pct = lv.rows[m], g.states[guess], f"{p:.0%}"
    if j == 0:
        return f"{me}见「{seen}」，照字面看多半是{state}（{pct}）→ {act}"
    inner = tower[j - 1]  # 说话者那一层：policy[状态][话]
    senders = [r for r in range(len(inner.rows)) if inner.choice(r) == m]
    verdict = "断定是" if p >= 0.9 else "估计多半是"
    if not senders:
        return f"{you}本不该「{seen}」→ {me}只好照字面猜是{state}（{pct}）→ {act}"
    if len(senders) == len(inner.rows):
        return f"{you}无论哪种情况都会「{seen}」，看不出虚实 → {me}估计是{state}（{pct}）→ {act}"
    when = _join([inner.rows[r] for r in senders])
    return f"{you}在{when}时才会「{seen}」→ {me}{verdict}{state}（{pct}）→ {act}"


def _line(case: Case, tower: list[Level], owner: str, j: int, out: dict, me: str, you: str) -> str:
    g = case.game
    if not isinstance(g, Signaling):
        return _simultaneous_line(tower, j, me, you)
    if tower[j].role == "a":
        return _speaker_line(g, tower, owner, j, out, me, you)
    return _listener_line(g, tower, j, out, me, you)


def template_line(case: Case, tower: list[Level], owner: str, j: int, out: dict) -> str:
    """第 j 层的一句话结论，以这一层所模拟的那个人的口吻（「我」与「对方」）。"""
    return _line(case, tower, owner, j, out, "我", "对方")


# ---------- 内心独白 ----------


def _flat(text: str) -> str:
    """把多行文字并成一行；中文之间不留空格。"""
    text = " ".join(text.split())
    return re.sub(r"(?<=[^\x00-\x7f]) | (?=[^\x00-\x7f])", "", text)


def _names(case: Case, persona_mode: str) -> dict[str, str]:
    if persona_mode == "neutral":
        return {"a": "甲", "b": "乙"}
    return {"a": case.a.name, "b": case.b.name}


def _neutralize(case: Case, text: str) -> str:
    """把原名换成甲/乙（长的名字先换，免得互相包含时换坏）。"""
    for name, alias in sorted(((case.a.name, "甲"), (case.b.name, "乙")), key=lambda x: -len(x[0])):
        if name:
            text = text.replace(name, alias)
    return text


def nesting_path(case: Case, tower: list[Level], j: int, persona_mode: str = "original") -> str:
    """第 j 层在塔里的位置，用大白话说：谁想象中的谁想象中的谁。"""
    names = _names(case, persona_mode)
    chain = [f"【{names[tower[k].role]}】" for k in range(len(tower) - 1, j - 1, -1)]
    if len(chain) == 1:
        return f"这是{chain[0]}本人此刻的真实想法"
    return f"这是{'想象中的'.join(chain)}的想法"


def build_prompt(case: Case, tower: list[Level], owner: str, j: int, out: dict, persona_mode: str = "original") -> tuple[str, str]:
    """返回 (system, prompt)。"""
    g = case.game
    lv = tower[j]
    neutral = persona_mode == "neutral"
    names = _names(case, persona_mode)
    me, you = names[lv.role], names[other(lv.role)]
    fix = (lambda s: _neutralize(case, s)) if neutral else (lambda s: s)

    people = []
    for r, person in (("a", case.a), ("b", case.b)):
        bits = [] if neutral or not person.persona else [person.persona.strip()]
        if person.goal:
            bits.append(f"目标：{fix(person.goal.strip())}")
        people.append(f"- {names[r]}：{' '.join(bits)}")

    if isinstance(g, Signaling):
        rules = (
            f"只有{names['a']}知道实情（{_join(g.states)}），{names['b']}看不到，只能从{names['a']}的举动来判断。"
            f"{names['a']}可以：{'、'.join(m.text for m in g.messages)}。"
            f"{names['b']}随后可以：{'、'.join(g.actions)}。"
        )
        if lv.role == "b":
            knows = f"{me}不知道实情，只看到{you}「{g.messages[out['choice_a']].text}」。"
        elif _is_self(tower, owner, j):
            knows = f"{me}清楚实情：{g.states[out['true_state']]}。"
        else:
            knows = (
                f"这位{me}是别人揣摩出来的，揣摩者并不知道实情，所以独白要把各种情况下各自的打算都交代到"
                "（「若……便……；若……则……」），每种情况只用一个短句。"
            )
    else:
        rules = (
            f"两人同时各做一个选择，互相看不到，只能猜对方。"
            f"{names['a']}可选：{'、'.join(g.actions_a)}。{names['b']}可选：{'、'.join(g.actions_b)}。"
        )
        knows = f"{me}看不到{you}的选择。"

    if j == 0:
        inner = f"这一层的{me}不假思索、按字面（凭直觉）理解，完全不去揣摩{you}的心思。"
        depth_rule = f"独白里不能出现任何对{you}心思的揣测，只有直觉或字面的反应。"
    else:
        inner_line = _line(case, tower, owner, j - 1, out, you, me)
        inner = f"这一层的{me}认定{you}是这样想的：{inner_line}"
        depth_rule = (
            f"独白要体现「因为{you}会那样想／那样做，所以我这样」这一步，而且只有这一步："
            f"不要再往更深处推（比如「{you}料到我会料到……」），也不要退回到不揣摩{you}的直觉反应。"
        )

    conclusion = _line(case, tower, owner, j, out, me, you)
    voice = (
        "用平实的现代口语。"
        if neutral
        else "语气要贴合这个人物的身份、性情与时代（古人用浅近的半文半白，今人用口语，孩子说孩子话）。"
    )
    prompt = "\n".join(
        [
            f"【场景】{fix(_flat(case.summary))}",
            "（场景简介里若提到了结局，那只是原故事的走向；这一次未必如此，一切以下面的设定为准。）",
            "【人物】",
            *people,
            f"【局面】{rules}",
            f"【这是谁的想法】{nesting_path(case, tower, j, persona_mode)}。请替这最后一位{me}写内心独白。{knows}",
            f"【他眼中的对方】{inner}",
            f"【必须得出的结论】{conclusion}",
            "",
            "请写这位人物此刻的内心独白，要求：",
            f"1. 第一人称（「我」是{me}），1–2 句，连标点严格不超过 60 个汉字，宁短勿长，不说废话。{voice}",
            "2. 独白必须恰好落到上面的结论上：选择、判断都与之一致，不能改变或含糊，也不要添加结论里没有的打算；括号里的百分比是把握程度，用语气体现即可，不要写数字。",
            f"3. {depth_rule}",
            "4. 全新写作，不要引用或化用任何已有作品的原句。",
            "5. 只输出独白本身，不要引号、人名前缀、解释或换行。",
        ]
    )
    return MONOLOGUE_SYSTEM, prompt


def _clean(text: str) -> str:
    text = " ".join(str(text).split())
    pairs = {"「": "」", "“": "”", '"': '"', "『": "』", "'": "'"}
    while len(text) >= 2 and text[0] in pairs and text[-1] == pairs[text[0]]:
        text = text[1:-1].strip()
    return text


async def monologue(
    case: Case,
    tower: list[Level],
    owner: str,
    j: int,
    out: dict,
    persona_mode: str = "original",
    regenerate: bool = False,
) -> dict:
    """第 j 层的内心独白：{"text", "source": "claude" | "cache" | "fallback"}。绝不向调用方抛异常。"""
    fallback = {"text": template_line(case, tower, owner, j, out), "source": "fallback"}
    try:
        if not llm.available():
            return fallback
        system, prompt = build_prompt(case, tower, owner, j, out, persona_mode)
        value, cached = await llm.aask_meta(prompt, system=system, use_cache=not regenerate)
        text = _clean(value if isinstance(value, str) else "")
        if not text:
            return fallback
        return {"text": text, "source": "cache" if cached else "claude"}
    except Exception:  # noqa: BLE001 — 独白只是锦上添花，出什么错都退回模板句
        return fallback
