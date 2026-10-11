"""第七个场景：2003 年 4 月印度 ICICI 银行挤兑。事件顺序取自 corpus/cases/icici_bank_2003.yaml。
Seventh scenario: the April 2003 run on ICICI Bank in India. Event order from corpus/cases/icici_bank_2003.yaml.

这个场景只用来做样本外检验。它的设定和通过标准（RECORD）在第二轮模型改动之前写定并合并，之后不再改；
写定之时没有运行过它。街区、人物和人口都是合成的；人物是虚构的普通储户，不对应任何真实的人。
This scenario exists only as an out-of-sample test. Its settings and pass criteria (RECORD) were written and merged
before the second round of model changes and are not to be edited afterwards; it had not been run when they were fixed.
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

TITLE = "ICICI 银行挤兑（2003）"
TITLE_EN = "The run on ICICI Bank (2003)"
SETTING = (
    "2003 年 4 月的印度古吉拉特邦，两年里已有二十多家合作银行倒闭。周五，一份地方报纸说 ICICI 银行出了问题，"
    "人们涌向取款机。银行经营正常。"
)
PUBLIC = "2003 年 4 月的印度古吉拉特邦。过去两年邦里有二十多家合作银行倒闭，不少人吃过亏。很多人的存款在 ICICI 银行。"
DEFAULTS = dict(ticks=96, start_hour=8)  # 4 月 11 日周五 08:00 起，共四天 / from Friday 11 April 08:00, four days
# 印度有存款保险（DICGC，1993 年 5 月起每人每行上限 10 万卢比）。
# India had deposit insurance (DICGC, a limit of Rs 100,000 per depositor per bank from May 1993).
DEPOSIT_INSURANCE = True

DISTRICTS = [
    ("艾哈迈达巴德", None),
    ("瓦尔萨德", 0 / 7),
    ("苏拉特", 1 / 7),
    ("拉杰果德", 2 / 7),
    ("阿嫩德", 3 / 7),
    ("巴罗达", 4 / 7),
    ("甘地讷格尔", 5 / 7),
    ("包纳加尔", 6 / 7),
]

VENUES = [
    ("ICICI 银行", "bank", "艾哈迈达巴德", (0, 0), (9, 17)),
    ("茶摊", "teahouse", "瓦尔萨德", (20, 30), (7, 21)),
    ("小吃店", "teahouse", "苏拉特", (30, -20), (8, 20)),
    ("布料市场", "market", "艾哈迈达巴德", (-70, 55), (9, 19)),
    ("火车站", "station", "艾哈迈达巴德", (60, -70), (6, 10)),
]

CAST = [
    dict(key="banker", name="银行执行董事", role="ICICI 银行执行董事", district="艾哈迈达巴德", age=48, sex="f", education=3,
         persona="她知道银行不缺钱，要紧的是别让哪一台取款机空掉。", trust_institution=0.95, depth=2, deposit=0, stake=0, hub=8),
    dict(key="witness", name="文员普丽娅", role="纺织厂文员", district="瓦尔萨德", age=31, sex="f", education=2,
         persona="舅舅的钱前年陷在一家倒掉的合作银行里，到现在没拿回来。", trust_general=0.6, conformity=0.6, depth=1,
         deposit=800, stake=0.6, hub=8),
    dict(key="driver", name="三轮车夫", role="机动三轮车夫", district="苏拉特", age=42, sex="m", education=1,
         persona="一天载几十个客，听几十种说法。", trust_general=0.6, depth=0, deposit=300, stake=0.8, hub=24),
    dict(key="owner", name="布商", role="布料市场里的批发商", district="艾哈迈达巴德", age=50, sex="m", education=1,
         persona="货款进出都走 ICICI 的账户。", risk_aversion=0.7, depth=1, deposit=2000, stake=0.9, venues=["布料市场"], hub=30),
    dict(key="retiree", name="退休教师", role="退休教师", district="阿嫩德", age=66, sex="m", education=3,
         persona="合作银行倒的那回，他排了三天队，一分钱没取到。", risk_aversion=0.95, trust_institution=0.3, depth=0,
         deposit=1500, stake=1.0, venues=["茶摊"], hub=6),
]

RUMOR = [
    (0.75, ["听说 ICICI 最近有点问题？", "股市大跌之后，银行会不会撑不住？"]),
    (1.05, ["ICICI 银行在股市里亏了很多。", "都在传 ICICI 周转不灵。"]),
    (1.35, ["ICICI 的钱不稳了。", "报上说 ICICI 出事了。"]),
    (1.75, ["ICICI 银行周转不了了。", "ICICI 的取款机前已经有人在排队。"]),
    (9.99, ["ICICI 银行就要关门了，有存款的快去取！", "取款机马上就要没钱了，快去取！"]),
]
ORIGIN = "瓦尔萨德城里在传：ICICI 银行缺现金了，可能要关门。"
ORIGIN_SEVERITY = 1.0
ORIGIN_BELIEF = 0.6
QUEUE_SEEN = "我看见 ICICI 的取款机前排着长队取钱。"
REBUTTAL = ["我去取款机取过了，照常出钱。", "储备银行说了，ICICI 资金充足。", "银行周日周一都照常开门。"]
TEXT_MESSAGE = "【本地报纸】ICICI 银行传出财务问题。"
NOTICE = "ICICI 银行声明：传闻毫无根据、纯属恶意，本行财务状况没有任何不利变化。"
GUARANTEE = "印度储备银行：ICICI 银行流动性充足，财务状况稳健；已安排向其分行和取款机供应足够的现金。"
FAILED = "ICICI 银行付不出钱，停业了。"
SEED_THOUGHT = "舅舅那笔钱就是这么没的。这回不能再等——先告诉家里人。"
NOTICE_THOUGHT = "钱是有的。运钞车加一倍，取款机不能空，周日周一也开门。"

# 史料：4 月 11 日周五，一份地方报纸刊出关于银行财务问题的传闻，同日取款机前挤满了人。钟点定为 10:00。
# The record: on Friday 11 April a local newspaper printed the rumour about the bank's finances, and ATMs were
# besieged the same day. 10:00 is set here.
TEXT_T = 2
# 史料：银行 4 月 11 日发表声明否认。钟点定为 16:00。
# The record: the bank issued its denial on 11 April. 16:00 is set here.
NOTICE_T = 8
# 史料：印度储备银行 4 月 12 日周六发表声明并安排供应现金。钟点定为 14:00。
# The record: the Reserve Bank of India issued its statement and arranged cash on Saturday 12 April. 14:00 is set here.
GUARANTEE_T = 24 + 6

RECORD = dict(
    case="icici_bank_2003",
    run_days=(1, 2),  # 挤兑发生在周五、周六 / the run took place on Friday and Saturday
    amount=0.0133,  # 4 月 11–13 日取走 550 crore 卢比，存款总额 41,316 crore / Rs 550 crore over 11–13 April against deposits of Rs 41,316 crore
    runners=None,  # 史料没有去取款的人数 / the record gives no count of those who withdrew
)


def interventions(start_hour: int) -> list[Intervention]:
    """史料里的三件事：周五地方报纸的报道，同日银行否认，周六储备银行表态并供应现金。
    Three things from the record: Friday's local newspaper report, the bank's denial the same day, and on Saturday
    the Reserve Bank's statement together with a supply of cash.
    """
    return [
        Intervention(t=TEXT_T, text=TEXT_MESSAGE, valence=1, strength=1.5, reach=0.3),
        Intervention(t=NOTICE_T, text=NOTICE, valence=-1, strength=1.2, reach=0.35),
        Intervention(t=GUARANTEE_T, text=GUARANTEE, valence=-1, strength=3.0, reach=0.9, cash=0.5),
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
