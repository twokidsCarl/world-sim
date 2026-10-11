"""数据契约：人口、消息、事件、运行记录。引擎写、UI 读，TypeScript 类型由此生成。
The data contract: population, messages, events and run records. The engine writes it, the UI reads it, and the TypeScript types are generated from it.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

SCHEMA = 1

TieKind = Literal["kin", "neighbor", "colleague", "friend"]
VenueKind = Literal["bank", "teahouse", "market", "temple", "school", "salon", "shop", "station"]

# 帧里 status 通道的取值 / values of the status channel in a frame
UNAWARE, AWARE, QUEUEING, WITHDREW, LOST = 0, 1, 2, 3, 4
STATUS_NAMES = ["未闻", "知情", "排队", "已取", "受损"]

FRAME_CHANNELS = ["belief", "fear", "expect", "status"]
BELIEF_CHANNEL = 0


class Person(BaseModel):
    """一个人的静态表征；随时间变化的心智状态在帧里。
    The static description of one person; the mental state that changes over time lives in the frames.
    """

    idx: int
    name: str
    protagonist: bool = False
    role: str = ""
    persona: str = ""
    # 人口属性 / demographics
    age: int
    sex: Literal["f", "m"]
    education: int = Field(ge=0, le=3, description="0 不识字 1 蒙学 2 中学 3 高等 / 0 illiterate, 1 elementary, 2 secondary, 3 higher")
    income: float = Field(ge=0, le=1, description="收入分位 / income quantile")
    # 稳定特质，均为 0..1 / stable traits, all in 0..1
    trust_general: float
    trust_institution: float
    risk_aversion: float
    conformity: float
    media_use: float
    depth: int = Field(ge=0, le=2, description="揣度他人的层数 k / k, how many levels deep this person reasons about others")
    # 场景状态 / scenario state
    deposit: float = Field(description="存款，单位：元 / deposit, in yuan")
    stake: float = Field(ge=0, le=1, description="这笔存款对他有多要紧 / how much this deposit matters to them")
    tenure: float = Field(0, ge=0, description="与这家银行往来的年数 / years this person has banked here")
    borrower: bool = Field(False, description="是否在这家银行有贷款 / whether they also borrow from this bank")
    insured: float = Field(0, ge=0, le=1, description="存款中受存款保险保障的比例 / share of the deposit covered by deposit insurance")
    resolve: float = Field(0, description="沉得住气的程度，标准正态的一次抽样；越大越不容易去取 / steadiness, one standard-normal draw; the larger, the less readily they withdraw")
    # 社会位置 / social position
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
    name_en: str = ""
    kind: VenueKind
    pos: tuple[float, float]
    hours: tuple[int, int] = Field(description="营业时段 [开, 关)，24 小时制 / opening hours [open, close), 24-hour clock")


class District(BaseModel):
    idx: int
    name: str
    name_en: str = ""
    pos: tuple[float, float]
    radius: float


class Population(BaseModel):
    schema_: int = Field(SCHEMA, alias="schema")
    synthetic: bool
    note: str
    note_en: str = ""
    extent: float = Field(description="坐标范围 [0, extent] / coordinates run over [0, extent]")
    bank: int = Field(description="钱庄在 venues 里的下标 / index of the bank in venues")
    cast: dict[str, int] = Field(description="主角的角色键 → persons 下标 / protagonist role key → index into persons")
    persons: list[Person]
    ties: list[Tie]
    venues: list[Venue]
    districts: list[District]

    model_config = {"populate_by_name": True}


class Message(BaseModel):
    """一条说法。转述变形时产生子消息，parent 连成谱系。
    One version of the story. When it changes in the retelling a child message is created; the parent links form its lineage.
    """

    id: int
    parent: Optional[int] = None
    t: int
    author: Optional[int] = None
    valence: Literal[1, -1] = Field(description="1 谣言，-1 辟谣 / 1 rumour, -1 correction")
    severity: float
    text: str


class Intervention(BaseModel):
    """对模拟世界的一次外部干预。/ One outside intervention in the simulated world."""

    t: int
    kind: Literal["broadcast", "close_venue", "silence", "convince", "insurance", "errand"] = "broadcast"
    actor: Optional[int] = Field(None, description="broadcast：出面的人 / broadcast: the person who makes the announcement")
    target: Optional[int] = Field(None, description="close_venue：场所下标；silence / convince / errand：人的下标 / close_venue: venue index; silence and convince: person index")
    role: Optional[str] = Field(None, description="用主角的角色键指定对象，代替 target / name the target by cast key instead of index")
    text: str = ""
    valence: Literal[1, -1] = -1
    strength: float = 1.5
    reach: float = Field(0.5, ge=0, le=1, description="broadcast：触达的人口比例 / broadcast: share of the population reached")
    duration: int = Field(0, ge=0, description="close_venue：关几个小时，0 为一直关 / close_venue: hours closed; 0 means closed for good")
    cash: float = Field(0.0, ge=0, description="broadcast：随告示运到柜上的现银，按存款总额的比例 / cash delivered with the notice, as a share of total deposits")
    value: float = Field(0.0, ge=0, le=1, description="insurance：存款保险赔付比例 / insurance: share of a lost deposit that is paid back")


class Params(BaseModel):
    """一次运行的全部可调参数。相同参数必须产生相同记录。
    Every tunable parameter of a run. The same parameters must produce the same record.
    """

    scenario: str = "rumor_run"
    seed: int = 1
    n: int = 1000
    ticks: int = 96
    start_hour: int = 20
    # 信念 / belief
    prior: float = 0.03
    w_tell: float = 2.6
    w_seen: float = 3.0
    novelty: float = 0.6
    corroborate: float = 0.5
    confirm: float = 0.4
    forget: float = 0.01
    # 传播 / spread
    share: float = 0.16
    stifle: float = 0.93
    mutate: float = 0.08
    venue_share: float = 0.25
    venue_audience: int = 3
    # 求证 / verification
    verify: float = 0.02
    w_verify: float = 2.5
    # 决策 / decision
    cost: float = 0.12
    lam: float = 12.0
    bias: float = -5.0
    hazard: float = 0.30
    perceived_reserve: float = 0.35
    spread: float = Field(2.0, ge=0, description="各人门槛的离散程度：0 表示人人一样 / how far individual thresholds differ; 0 means everyone is alike")
    public: float = Field(0.0, ge=0, description="收到群发消息的人，估计同样收到的人里有多少会去取（乘以消息触达的比例）；0 表示群发消息不带来这种估计 / of those a mass message reached, the share a recipient assumes will withdraw (times the message's reach); 0 means a mass message carries no such assumption")
    authority: float = Field(1.0, ge=0, description="辟谣和担保的告示实际有几成力度 / the fraction of a denial's or guarantee's stated strength that actually lands")
    attach: float = Field(2.0, ge=0, description="与银行的往来把门槛抬高多少 / how much ties to the bank raise the threshold")
    # 钱庄 / the bank
    reserve_ratio: float = 0.30
    institutional: float = Field(0, ge=0, lt=1, description="存款总额中属于企业和机构的比例；它们不在传话网里，也不来排队 / share of all deposits held by firms and institutions, which are outside the rumour network and do not queue")
    tellers: float = 0.02
    interventions: list[Intervention] = []
    llm: bool = Field(False, description="主角是否交给大模型扮演 / whether the model plays the protagonists")


class Event(BaseModel):
    """events.jsonl 的一行。键名取短，因为行数很多。
    One line of events.jsonl. Keys are short because there are a great many lines.
    """

    t: int
    k: Literal["seed", "tell", "mutate", "queue", "withdraw", "verify", "broadcast", "intervene", "fail", "thought"]
    a: Optional[int] = Field(None, description="行动者 / actor")
    b: Optional[int] = Field(None, description="对象 / target")
    m: Optional[int] = Field(None, description="消息 id / message id")
    via: Optional[str] = Field(None, description="关系类型，或 venue:<idx> / tie kind, or venue:<idx>")
    p0: Optional[int] = Field(None, description="对象事前信念，百分数 / target's belief beforehand, in percent")
    p1: Optional[int] = Field(None, description="对象事后信念，百分数 / target's belief afterwards, in percent")
    x: Optional[str | float] = Field(None, description="文本或金额 / text or amount")


class Series(BaseModel):
    """每个 tick 的宏观量，长度都是 ticks + 1。
    Aggregate quantities per tick; every list has length ticks + 1.
    """

    aware: list[int]
    believers: list[int]
    queue: list[int]
    withdrew: list[int]
    reserve: list[float] = Field(description="钱庄现银占初始存款的比例 / the bank's cash as a share of initial deposits")
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
    title_en: str = ""
    setting_en: str = ""
    params: Params
    n: int
    ticks: int
    channels: list[str] = FRAME_CHANNELS
    parent: Optional[str] = None
    branch_t: Optional[int] = None
    summary: Summary

    model_config = {"populate_by_name": True}
