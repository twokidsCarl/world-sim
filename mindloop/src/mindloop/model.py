"""人与博弈的抽象。

两个人统一记作 a 和 b：
- 信号博弈（signaling）：a 是说话者，知道隐藏状态 θ，说出一句话 m；b 是听者，看到 m 后选行动。
- 同时博弈（simultaneous）：a 和 b 各自选一个行动，互相看不到，只能猜对方会怎么选。
"""

from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, model_validator

Role = Literal["a", "b"]


def other(role: str) -> str:
    return "b" if role == "a" else "a"


class Source(BaseModel):
    work: str
    author: str = ""
    year: str = ""
    locator: str = ""
    quote: str = ""
    url: str = ""
    verified: bool = False


class Person(BaseModel):
    name: str
    persona: str = ""
    goal: str = ""


class Message(BaseModel):
    text: str
    cost: float = 0.0


class Quadratic(BaseModel):
    """Crawford–Sobel 式收益：u_b = -(a-θ)²，u_a = -(a-θ-bias)²。"""

    state_values: list[float]
    action_values: list[float]
    bias: float = 0.0
    scale: float = 1.0


class Signaling(BaseModel):
    kind: Literal["signaling"] = "signaling"
    states: list[str]
    prior: list[float]
    messages: list[Message]
    actions: list[str]
    literal: list[list[float]]  # [M][Θ] 这句话字面上与状态 θ 的相容度
    u_a: list[list[float]] = Field(default_factory=list)  # [Θ][A]
    u_b: list[list[float]] = Field(default_factory=list)  # [Θ][A]
    quadratic: Optional[Quadratic] = None
    true_state: int = 0

    @model_validator(mode="after")
    def _check(self):
        if self.quadratic is not None:
            self.apply_bias(self.quadratic.bias)
        n_s, n_m, n_a = len(self.states), len(self.messages), len(self.actions)
        assert len(self.prior) == n_s, "prior 长度应等于 states"
        assert abs(sum(self.prior) - 1) < 1e-6, "prior 之和应为 1"
        assert len(self.literal) == n_m and all(len(r) == n_s for r in self.literal), "literal 应为 [M][Θ]"
        for name in ("u_a", "u_b"):
            u = getattr(self, name)
            assert len(u) == n_s and all(len(r) == n_a for r in u), f"{name} 应为 [Θ][A]"
        assert 0 <= self.true_state < n_s
        return self

    def apply_bias(self, bias: float) -> None:
        q = self.quadratic
        if q is None:
            return
        q.bias = bias
        self.u_b = [[-q.scale * (av - sv) ** 2 for av in q.action_values] for sv in q.state_values]
        self.u_a = [[-q.scale * (av - sv - bias) ** 2 for av in q.action_values] for sv in q.state_values]


class Simultaneous(BaseModel):
    kind: Literal["simultaneous"] = "simultaneous"
    actions_a: list[str]
    actions_b: list[str]
    salience_a: list[float]  # 第 0 层：不动脑筋时的直觉选择
    salience_b: list[float]
    u_a: list[list[float]]  # [A][B]
    u_b: list[list[float]]  # [A][B]

    @model_validator(mode="after")
    def _check(self):
        n_a, n_b = len(self.actions_a), len(self.actions_b)
        assert len(self.salience_a) == n_a and len(self.salience_b) == n_b
        for u in (self.u_a, self.u_b):
            assert len(u) == n_a and all(len(r) == n_b for r in u), "收益应为 [A][B]"
        return self


class Canonical(BaseModel):
    """原作中两个人实际想到第几层、做了什么。"""

    depth_a: Optional[int] = None
    depth_b: Optional[int] = None
    choice_a: Optional[str] = None
    choice_b: Optional[str] = None
    note: str = ""


class Case(BaseModel):
    id: str
    title: str
    title_en: str = ""  # 标题和看点的英文；其余文字只有中文 / English title and hook; the rest is Chinese only
    category: Literal["implicature", "bluff", "coordination", "cheap_talk", "common_knowledge"]
    hook: str = ""  # 一句话看点 / the one-line hook
    hook_en: str = ""
    summary: str = ""
    source: Source
    a: Person
    b: Person
    game: Optional[Union[Signaling, Simultaneous]] = Field(default=None, discriminator="kind")
    lam: float = 1.0
    canonical: Canonical = Field(default_factory=Canonical)
    layers: list[str] = Field(default_factory=list)  # 不可运行的案例：用文字讲清每一层
    theory: bool = False  # 抽象理论基准，而非具体场景

    @property
    def runnable(self) -> bool:
        return self.game is not None


CATEGORY_LABELS = {
    "implicature": "言外之意",
    "bluff": "虚张声势",
    "coordination": "默契协调",
    "cheap_talk": "话里有私心",
    "common_knowledge": "无限层 · 共同知识",
}
