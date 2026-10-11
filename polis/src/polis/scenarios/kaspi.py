"""第六个场景：2014 年 2 月哈萨克斯坦 Kaspi 银行挤兑。事件顺序取自 corpus/cases/kaspi_bank_2014.yaml。
Sixth scenario: the February 2014 run on Kaspi Bank in Kazakhstan. Event order from corpus/cases/kaspi_bank_2014.yaml.

这个场景只用来做样本外检验。它的设定和通过标准（RECORD）在模型改动之前写定并合并，之后不再改；
写定之时没有运行过它。街区、人物和人口都是合成的；人物是虚构的普通储户，不对应任何真实的人。
This scenario exists only as an out-of-sample test. Its settings and pass criteria (RECORD) were written and merged
before the model was changed and are not to be edited afterwards; it had not been run when they were fixed.
Districts, cast and population are synthetic; the characters are invented ordinary depositors, not real people.

凡是史料里没有数字的地方，用的是与东亚银行场景相同的预设（群发消息 1.5/0.3、声明 1.2/0.35、
当局表态 3.0/0.9 并补足现金 0.5、起始说法的严重度 1.0 和可信度 0.6），没有为这个场景另设。
史料只给了日期、没给钟点的事件，钟点是这里定的，逐条注明。
Where the record gives no number, the values are the same presets as the Bank of East Asia scenario (mass message
1.5/0.3, statement 1.2/0.35, the authorities' statement 3.0/0.9 with cash 0.5, origin severity 1.0 and belief 0.6);
none was chosen for this scenario. Where the record gives a date but no hour, the hour is set here and marked.
"""

from __future__ import annotations

from ..model import Intervention
from . import rumor_run

TITLE = "Kaspi 银行挤兑（2014）"
TITLE_EN = "The run on Kaspi Bank (2014)"
SETTING = (
    "2014 年 2 月的哈萨克斯坦，坚戈一周前刚贬值近两成。周二，一条匿名群发的消息说 Kaspi 等三家银行即将破产。"
    "银行经营正常。"
)
PUBLIC = "2014 年 2 月的哈萨克斯坦。一周前坚戈一夜之间贬值近两成，人人都在担心自己的钱。很多人的存款在 Kaspi 银行。"
DEFAULTS = dict(ticks=96, start_hour=8)  # 2 月 18 日周二 08:00 起，共四天 / from Tuesday 18 February 08:00, four days
# 哈萨克斯坦有存款担保基金（2015 年 4 月之前坚戈存款上限为 500 万坚戈，见于银行公告对 2015 年修法的说明）。
# Kazakhstan had a deposit insurance fund (limit 5 million tenge for tenge deposits until April 2015, per bank
# notices describing the 2015 amendment).
DEPOSIT_INSURANCE = True

DISTRICTS = [
    ("阿拉木图中心", None),
    ("阿斯塔纳", 0 / 7),
    ("奇姆肯特", 1 / 7),
    ("卡拉干达", 2 / 7),
    ("阿克托别", 3 / 7),
    ("阿特劳", 4 / 7),
    ("巴甫洛达尔", 5 / 7),
    ("塔拉兹", 6 / 7),
]

VENUES = [
    ("Kaspi 银行", "bank", "阿拉木图中心", (0, 0), (9, 17)),
    ("茶馆", "teahouse", "奇姆肯特", (20, 30), (8, 21)),
    ("食堂", "teahouse", "卡拉干达", (30, -20), (7, 15)),
    ("绿色巴扎", "market", "阿拉木图中心", (-70, 55), (7, 17)),
    ("地铁站", "station", "阿拉木图中心", (60, -70), (7, 10)),
]

CAST = [
    dict(key="banker", name="银行行长", role="Kaspi 银行行长", district="阿拉木图中心", age=40, sex="m", education=3,
         persona="他知道银行不缺钱，难的是把现金及时运到每家分行。", trust_institution=0.95, depth=2, deposit=0, stake=0, hub=8),
    dict(key="witness", name="店员阿依古丽", role="手机店店员", district="阿拉木图中心", age=29, sex="f", education=2,
         persona="上周存款一夜缩水两成，她还没缓过来，手机又响了。", trust_general=0.6, conformity=0.6, depth=1,
         deposit=800, stake=0.6, hub=8),
    dict(key="driver", name="出租车司机", role="出租车司机", district="阿斯塔纳", age=45, sex="m", education=1,
         persona="一天载几十个客，听几十种说法。", trust_general=0.6, depth=0, deposit=300, stake=0.8, hub=24),
    dict(key="owner", name="巴扎摊主", role="巴扎里的干果摊主", district="阿拉木图中心", age=51, sex="f", education=1,
         persona="摊上的流水都走 Kaspi。", risk_aversion=0.7, depth=1, deposit=2000, stake=0.9, venues=["绿色巴扎"], hub=30),
    dict(key="retiree", name="退休工程师", role="退休工程师", district="卡拉干达", age=65, sex="m", education=3,
         persona="九十年代存款化为乌有的事，他经历过一回。", risk_aversion=0.95, trust_institution=0.3, depth=0,
         deposit=1500, stake=1.0, venues=["食堂"], hub=6),
]

RUMOR = [
    (0.75, ["听说 Kaspi 最近有点问题？", "贬值之后，银行会不会撑不住？"]),
    (1.05, ["Kaspi 银行贬值里亏了很多。", "都在传有三家银行不稳。"]),
    (1.35, ["Kaspi 的钱不稳了。", "三家银行要出事，Kaspi 是其中一家。"]),
    (1.75, ["Kaspi 银行周转不了了。", "Kaspi 的分行已经有人在排队取钱。"]),
    (9.99, ["Kaspi 银行就要破产了，有存款的快去取！", "三家银行马上宣布破产，快去取钱！"]),
]
ORIGIN = "手机上收到一条消息：Kaspi、Alliance、CenterCredit 三家银行即将破产，赶快把存款取出来。"
ORIGIN_SEVERITY = 1.0
ORIGIN_BELIEF = 0.6
QUEUE_SEEN = "我看见 Kaspi 的分行门口排着长队取钱。"
REBUTTAL = ["我去分行取过了，照常付款。", "国家银行说了，消息是假的。", "总统说了，不会让哪家银行倒。"]
TEXT_MESSAGE = "【转发】Kaspi、Alliance、CenterCredit 三家银行即将破产，赶快把存款取出来！"
NOTICE = "总统表示：2009 年没有让银行倒闭，现在也不会。"
GUARANTEE = "国家银行行长：有关三家银行的消息虚假、有误导性，是挑衅；已与各大银行行长会面，银行稳定。Kaspi 向各分行运送平日五倍的现金，所有提款照付。"
FAILED = "Kaspi 银行付不出钱，停业了。"
SEED_THOUGHT = "上周说贬就贬了，谁也没提前说一声。这回不能再等——先告诉家里人。"
NOTICE_THOUGHT = "钱是有的，难的是把现金运到每家分行。运五倍过去，谁来取都照付。"

# 史料：消息 2 月 18 日周二发出，同日储户涌到分行。钟点定为 10:00。
# The record: the messages went out on Tuesday 18 February and depositors rushed to branches the same day. 10:00 is set here.
TEXT_T = 2
# 史料：国家银行同日（周二）称消息虚假。钟点定为 16:00。
# The record: the National Bank called the messages false the same day (Tuesday). 16:00 is set here.
GUARANTEE_T = 8
# 史料：总统 2 月 21 日周五表态。钟点定为 10:00。
# The record: the president spoke on Friday 21 February. 10:00 is set here.
NOTICE_T = 72 + 2

RECORD = dict(
    case="kaspi_bank_2014",
    run_days=(1, 1),  # 消息发出当天就挤兑 / the run began the day the messages went out
    amount=0.09,  # 三天取走 400 亿坚戈，存款总额 4420 亿 / 40 billion tenge in three days against a deposit base of 442 billion
    runners=0.10,  # 约一成储户 / about a tenth of depositors
)


def interventions(start_hour: int) -> list[Intervention]:
    """史料里的三件事：周二的群发消息，同日国家银行否认，周五总统表态。
    Three things from the record: Tuesday's mass message, the National Bank's denial the same day, and the
    president's statement on Friday.
    """
    return [
        Intervention(t=TEXT_T, text=TEXT_MESSAGE, valence=1, strength=1.5, reach=0.3),
        Intervention(t=GUARANTEE_T, text=GUARANTEE, valence=-1, strength=3.0, reach=0.9, cash=0.5),
        Intervention(t=NOTICE_T, text=NOTICE, valence=-1, strength=1.2, reach=0.35),
    ]


def rumor_text(severity: float, pick: int) -> str:
    for cap, texts in RUMOR:
        if severity < cap:
            return texts[pick % len(texts)]
    return RUMOR[-1][1][0]


def thought(kind: str, **kw) -> str:
    if kind == "seed":
        return SEED_THOUGHT
    if kind == "notice":
        return NOTICE_THOUGHT
    return rumor_run.thought(kind, **kw).replace("钱庄", "银行")
