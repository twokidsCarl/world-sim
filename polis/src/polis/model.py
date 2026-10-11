"""数据契约：人口、消息、事件、运行记录。引擎写、UI 读，TypeScript 类型由此生成。"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

SCHEMA = 1

TieKind = Literal["kin", "neighbor", "colleague", "friend"]
VenueKind = Literal["bank", "teahouse", "market", "temple", "school", "salon", "shop", "station"]

# 帧里 status 通道的取值
UNAWARE, AWARE, QUEUEING, WITHDREW, LOST = 0, 1, 2, 3, 4
STATUS_NAMES = ["未闻", "知情", "排队", "已取", "受损"]

FRAME_CHANNELS = ["belief", "fear", "expect", "status"]
BELIEF_CHANNEL = 0


class Person(BaseModel):
    """一个人的静态表征；随时间变化的心智状态在帧里。"""

    idx: int
    name: str
    protagonist: bool = False
    role: str = ""
    persona: str = ""
    # 人口属性
    age: int
    sex: Literal["f", "m"]
    education: int = Field(ge=0, le=3, description="0 不识字 1 蒙学 2 中学 3 高等")
    income: float = Field(ge=0, le=1, description="收入分位")
    # 稳定特质，均为 0..1
    trust_general: float
    trust_institution: float
    risk_aversion: float
    conformity: float
    media_use: float
    depth: int = Field(ge=0, le=2, description="揣度他人的层数 k")
    # 场景状态
    deposit: float = Field(description="存款，单位：元")
    stake: float = Field(ge=0, le=1, description="这笔存款对他有多要紧")
    # 社会位置
    household: int
    district: int
    workplace: Optional[int] = None
    venues: list[int] = []
    pos: tuple[float, float]


class Tie(BaseModel):
    a: int
    b: int
    kind: TieKind
    strength: float


class Venue(BaseModel):
    idx: int
    name: str
    kind: VenueKind
    pos: tuple[float, float]
    hours: tuple[int, int] = Field(description="营业时段 [开, 关)，24 小时制")


class District(BaseModel):
    idx: int
    name: str
    pos: tuple[float, float]
    radius: float


class Population(BaseModel):
    schema_: int = Field(SCHEMA, alias="schema")
    synthetic: bool
    note: str
    extent: float = Field(description="坐标范围 [0, extent]")
    bank: int = Field(description="钱庄在 venues 里的下标")
    cast: dict[str, int] = Field(description="主角的角色键 → persons 下标")
    persons: list[Person]
    ties: list[Tie]
    venues: list[Venue]
    districts: list[District]

    model_config = {"populate_by_name": True}


class Message(BaseModel):
    """一条说法。转述变形时产生子消息，parent 连成谱系。"""

    id: int
    parent: Optional[int] = None
    t: int
    author: Optional[int] = None
    valence: Literal[1, -1] = Field(description="1 谣言，-1 辟谣")
    severity: float
    text: str


class Intervention(BaseModel):
    """对模拟世界的一次外部干预。"""

    t: int
    kind: Literal["broadcast", "close_venue", "silence", "convince", "insurance"] = "broadcast"
    actor: Optional[int] = Field(None, description="broadcast：出面的人")
    target: Optional[int] = Field(None, description="close_venue：场所下标；silence / convince：人的下标")
    text: str = ""
    valence: Literal[1, -1] = -1
    strength: float = 1.5
    reach: float = Field(0.5, ge=0, le=1, description="broadcast：触达的人口比例")
    duration: int = Field(0, ge=0, description="close_venue：关几个小时，0 为一直关")
    value: float = Field(0.0, ge=0, le=1, description="insurance：存款保险赔付比例")


class Params(BaseModel):
    """一次运行的全部可调参数。相同参数必须产生相同记录。"""

    scenario: str = "rumor_run"
    seed: int = 1
    n: int = 1000
    ticks: int = 96
    start_hour: int = 20
    # 信念
    prior: float = 0.03
    w_tell: float = 2.6
    w_seen: float = 3.0
    novelty: float = 0.6
    corroborate: float = 0.5
    confirm: float = 0.4
    forget: float = 0.01
    # 传播
    share: float = 0.16
    stifle: float = 0.93
    mutate: float = 0.08
    venue_share: float = 0.25
    venue_audience: int = 3
    # 求证
    verify: float = 0.02
    w_verify: float = 2.5
    # 决策
    cost: float = 0.12
    lam: float = 12.0
    bias: float = -5.0
    hazard: float = 0.30
    perceived_reserve: float = 0.35
    # 钱庄
    reserve_ratio: float = 0.30
    tellers: float = 0.02
    interventions: list[Intervention] = []
    llm: bool = Field(False, description="主角是否交给大模型扮演")


class Event(BaseModel):
    """events.jsonl 的一行。键名取短，因为行数很多。"""

    t: int
    k: Literal["seed", "tell", "mutate", "queue", "withdraw", "verify", "broadcast", "intervene", "fail", "thought"]
    a: Optional[int] = Field(None, description="行动者")
    b: Optional[int] = Field(None, description="对象")
    m: Optional[int] = Field(None, description="消息 id")
    via: Optional[str] = Field(None, description="关系类型，或 venue:<idx>")
    p0: Optional[int] = Field(None, description="对象事前信念，百分数")
    p1: Optional[int] = Field(None, description="对象事后信念，百分数")
    x: Optional[str | float] = Field(None, description="文本或金额")


class Series(BaseModel):
    """每个 tick 的宏观量，长度都是 ticks + 1。"""

    aware: list[int]
    believers: list[int]
    queue: list[int]
    withdrew: list[int]
    reserve: list[float] = Field(description="钱庄现银占初始存款的比例")
    fear: list[float]


class Summary(BaseModel):
    peak_believers: int
    withdrew: int
    lost: int
    failed_at: Optional[int]
    messages: int
    events: int
    llm_calls: int = 0
    llm_failed: int = 0


class Manifest(BaseModel):
    schema_: int = Field(SCHEMA, alias="schema")
    run_id: str
    title: str
    setting: str
    params: Params
    n: int
    ticks: int
    channels: list[str] = FRAME_CHANNELS
    parent: Optional[str] = None
    branch_t: Optional[int] = None
    summary: Summary

    model_config = {"populate_by_name": True}
