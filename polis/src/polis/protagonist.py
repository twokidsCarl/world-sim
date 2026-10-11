"""主角：在关键时刻把"怎么想、怎么办"交给大模型，引擎只负责把决定落到世界里。
Protagonists: at key moments the model decides what a named character thinks and does; the engine applies it.

信念和恐惧仍由数值引擎计算，模型看到的是"你心里信了几成"，它决定的是行动和说出口的话。
调用失败时返回 None，引擎退回数值规则，所以没有模型也能跑。
Belief and fear stay numeric. The model is shown them and chooses an action and the words spoken.
A failed call yields None and the engine falls back to its numeric rule, so everything runs without a model.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Literal, Optional

from . import llm

Action = Literal["wait", "withdraw", "verify", "tell", "reassure"]
TONE = {"轻": 0.7, "照实": 1.0, "重": 1.5}  # 说出口的话有多重 / how harsh the spoken version is

SYSTEM = "你在扮演一个模拟社会里的人物。严格按人物的身份、处境和年代来想和说，只输出要求的 JSON。"

SCHEMA = {
    "type": "object",
    "properties": {
        "thought": {"type": "string", "description": "第一人称的一句心里话，不超过 50 字"},
        "action": {"type": "string", "enum": ["wait", "withdraw", "verify", "tell", "reassure"]},
        "say": {"type": "string", "description": "选 tell 或 reassure 时对熟人说的那句话，不超过 30 字；否则留空"},
        "tone": {"type": "string", "enum": list(TONE)},
    },
    "required": ["thought", "action", "say", "tone"],
    "additionalProperties": False,
}


@dataclass
class Context:
    """做决定时一个主角知道的全部。/ Everything a protagonist knows at the moment of deciding."""

    setting: str
    bank: str
    clock: str
    name: str
    role: str
    age: int
    persona: str
    deposit: float
    stake: float
    tenure: float
    borrower: bool
    covered: float
    risk_aversion: float
    conformity: float
    trust_institution: float
    depth: int
    belief: float
    fear: float
    heard: list[str]
    queue: int
    acquaintances_ran: float
    can_withdraw: bool


@dataclass
class Decision:
    thought: str
    action: Action
    say: str = ""
    tone: float = 1.0


def _level(x: float, words: tuple[str, str, str]) -> str:
    return words[0] if x < 0.35 else words[1] if x < 0.7 else words[2]


DEPTH = [
    "你只看眼前看得见的事。",
    "你会多想一步：跟你说这事的人多半自己是信的，信的人迟早会去取。",
    "你习惯琢磨别人怎么想：就算钱庄没事，人人都以为别人要取，它也会被取空。",
]


def prompt(c: Context) -> str:
    money = (
        f"你在{c.bank}存了 {c.deposit:.0f} 元，这笔钱对你{_level(c.stake, ('不算要紧', '相当要紧', '是全部的指望'))}。"
        if c.can_withdraw
        else f"你在{c.bank}没有存款。"
    )
    if c.can_withdraw:
        money += f"你和这家银行往来了 {c.tenure:.0f} 年" + ("，在这里还有贷款。" if c.borrower else "。")
        if c.covered > 0:
            money += f"你听说存款有保险，自己估计大约 {c.covered:.0%} 的钱保得住。"
    temper = "、".join(
        [
            _level(c.risk_aversion, ("不大怕吃亏", "怕吃亏", "最怕吃亏")),
            _level(c.conformity, ("凡事自己拿主意", "多少会看别人怎么做", "别人怎么做你就怎么做")),
            _level(c.trust_institution, ("不信官面上的话", "对官面上的话半信半疑", "信官面上的话")),
        ]
    )
    heard = "\n".join(f"- {h}" for h in c.heard) or "- （还没有人跟你说过什么）"
    seen = f"{c.bank}门口排着 {c.queue} 个人" if c.queue else f"{c.bank}门口没有人排队"
    options = ["wait：先看看再说"]
    if c.can_withdraw:
        options.append("withdraw：现在就去把钱取出来")
    options += ["verify：自己去柜上看一眼、问一问", "tell：把这事讲给熟人听", "reassure：劝熟人别信"]
    return f"""【场景】{c.setting}
【你是谁】{c.name}，{c.role}，{c.age} 岁。{c.persona}
【你的处境】{money}你这个人{temper}。{DEPTH[c.depth]}
【现在】{c.clock}
【你听到的】
{heard}
【你看到的】{seen}；你认识的人里大约有 {c.acquaintances_ran:.0%} 已经去取钱了。
【你心里】对“{c.bank}要出事”信了 {c.belief:.0%}；{_level(c.fear, ('并不怎么慌', '有些发慌', '慌得厉害'))}。
【你可以】
{chr(10).join('- ' + o for o in options)}

以第一人称写一句心里话（不超过 50 字，口吻合乎人物身份与年代），选一个行动。
若选 tell 或 reassure，写出你会对熟人说的那句话（不超过 30 字），并标出说得轻、照实还是重；否则 say 留空、tone 填“照实”。"""


@dataclass
class Director:
    """把一批主角的处境交给模型，收回决定。/ Sends a batch of contexts to the model and collects decisions."""

    model: Optional[str] = None
    calls: int = 0
    cached: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)

    def decide(self, contexts: list[Context]) -> list[Optional[Decision]]:
        return llm.run_sync(self._decide(contexts)) if contexts else []

    async def _decide(self, contexts: list[Context]) -> list[Optional[Decision]]:
        return list(await asyncio.gather(*(self._one(c) for c in contexts)))

    async def _one(self, c: Context) -> Optional[Decision]:
        self.calls += 1
        try:
            out, hit = await llm.aask_meta(prompt(c), system=SYSTEM, model=self.model, schema=SCHEMA)
        except llm.LLMError as e:
            self.failed += 1
            self.errors.append(f"{c.name}: {e}")
            return None
        self.cached += hit
        action = out["action"] if isinstance(out, dict) else None
        if action not in ("wait", "withdraw", "verify", "tell", "reassure") or (action == "withdraw" and not c.can_withdraw):
            action = "wait"  # 模型选了做不到的事，就当它先看看 / an impossible choice is treated as waiting
        return Decision(
            thought=str(out["thought"]).strip()[:120],
            action=action,
            say=str(out.get("say", "")).strip()[:60],
            tone=TONE.get(out.get("tone", "照实"), 1.0),
        )
