"""第五个场景：2011 年 12 月拉脱维亚 Swedbank 挤兑。事件顺序取自 corpus/cases/swedbank_latvia_2011.yaml。
Fifth scenario: the December 2011 run on Swedbank in Latvia. Event order from corpus/cases/swedbank_latvia_2011.yaml.

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

TITLE = "Swedbank 拉脱维亚挤兑（2011）"
TITLE_EN = "The run on Swedbank in Latvia (2011)"
SETTING = (
    "2011 年 12 月的拉脱维亚，三周前一家本地银行刚被接管。周五起关于 Swedbank 的传闻加剧；"
    "周日，社交网络和短信上说它要破产了，人们涌向取款机。银行经营正常。"
)
PUBLIC = "2011 年 12 月的拉脱维亚。三周前 Krajbanka 刚被当局接管，上个月立陶宛的 Snoras 也倒了。很多人的存款在 Swedbank。"
DEFAULTS = dict(ticks=120, start_hour=8)  # 12 月 9 日周五 08:00 起，共五天 / from Friday 9 December 08:00, five days
# 拉脱维亚有存款担保（每人每家机构上限 10 万欧元）。上限数字见于多家银行的披露文件；
# 2011 年 12 月是否已是这个数没有找到直接出处，这里只用"有没有"这一层。
# Latvia had a deposit guarantee (up to EUR 100,000 per depositor per institution, per several banks' disclosures).
# No direct source for the limit as of December 2011 was found; only the yes/no is used here.
DEPOSIT_INSURANCE = True

DISTRICTS = [
    ("里加老城", None),
    ("叶尔加瓦", 0 / 7),
    ("文茨皮尔斯", 1 / 7),
    ("泽姆加莱", 2 / 7),
    ("陶格夫匹尔斯", 3 / 7),
    ("利耶帕亚", 4 / 7),
    ("尤尔马拉", 5 / 7),
    ("瓦尔米耶拉", 6 / 7),
]

# 这场挤兑发生在周日的取款机前，所以"银行"全天开门。
# The run happened at cash machines on a Sunday, so the "bank" is open round the clock.
VENUES = [
    ("Swedbank 取款机", "bank", "里加老城", (0, 0), (0, 24)),
    ("咖啡馆", "teahouse", "尤尔马拉", (20, 30), (8, 21)),
    ("小酒馆", "teahouse", "叶尔加瓦", (30, -20), (11, 23)),
    ("中央市场", "market", "里加老城", (-70, 55), (7, 17)),
    ("火车站", "station", "里加老城", (60, -70), (6, 9)),
]

CAST = [
    dict(key="banker", name="银行行长", role="Swedbank 拉脱维亚首席执行官", district="里加老城", age=44, sex="m", education=3,
         persona="他知道这些说法有的不属实，有的简直荒唐。", trust_institution=0.95, depth=2, deposit=0, stake=0, hub=8),
    dict(key="witness", name="教师伊尔泽", role="中学教师", district="叶尔加瓦", age=38, sex="f", education=3,
         persona="三周前 Krajbanka 出事时，她的同事有钱卡在里面。", trust_general=0.6, conformity=0.6, depth=1,
         deposit=800, stake=0.6, hub=8),
    dict(key="driver", name="货车司机", role="货车司机", district="文茨皮尔斯", age=47, sex="m", education=1,
         persona="跑一趟外省，一路上听的都是同一件事。", trust_general=0.6, depth=0, deposit=300, stake=0.8, hub=24),
    dict(key="owner", name="小酒馆老板", role="小酒馆老板", district="叶尔加瓦", age=53, sex="m", education=1,
         persona="店里的流水都走 Swedbank。", risk_aversion=0.7, depth=1, deposit=2000, stake=0.9, venues=["小酒馆"], hub=30),
    dict(key="retiree", name="退休护士", role="退休护士", district="泽姆加莱", age=67, sex="f", education=2,
         persona="2008 年 Parex 出事她还记得清清楚楚。", risk_aversion=0.95, trust_institution=0.4, depth=0,
         deposit=1500, stake=1.0, venues=["咖啡馆"], hub=6),
]

RUMOR = [
    (0.75, ["听说 Swedbank 最近有点问题？", "Krajbanka 之后，下一个会不会是 Swedbank？"]),
    (1.05, ["Swedbank 在瑞典出事了。", "都在传 Swedbank 不稳。"]),
    (1.35, ["Swedbank 在爱沙尼亚已经停业了。", "Swedbank 的钱要取不出来了。"]),
    (1.75, ["Swedbank 在瑞典的取款机已经取不出钱。", "Swedbank 的取款机前已经排起了队。"]),
    (9.99, ["Swedbank 要破产了，快去取款机把钱取出来！", "明天 Swedbank 的卡就刷不了了，快去取钱！"]),
]
ORIGIN = "同事说，Krajbanka 之后轮到 Swedbank 了，它在瑞典已经出了事。"
ORIGIN_SEVERITY = 1.0
ORIGIN_BELIEF = 0.6
QUEUE_SEEN = "我看见 Swedbank 的取款机前排着长队。"
REBUTTAL = ["我刚取过，取款机照常吐钱。", "监管委员会说了，是谣言。", "总理说这是有人故意散布的。"]
TEXT_MESSAGE = "【转发】Swedbank 要破产了，瑞典那边的取款机已经取不出钱，快去取！"
NOTICE = "总理在政府会议上说：有关 Swedbank 的传闻毫无根据，是有人蓄意散布，拉脱维亚的银行体系稳定。"
GUARANTEE = "金融与资本市场委员会和 Swedbank 管理层：有关传闻不属实，银行日常和紧急情况下都能正常运作；取款机取空后几小时内补钞。"
FAILED = "Swedbank 付不出钱，停业了。"
SEED_THOUGHT = "Krajbanka 也是说没事，转眼就被接管了。得跟家里人说一声。"
NOTICE_THOUGHT = "加紧补钞，哪台机器空了几小时内补上。这些说法荒唐得很。"

# 史料：周日下午起现金需求升到十倍，人们"似乎是收到了令人不安的短信"。钟点定为 12:00。
# The record: demand rose tenfold from Sunday afternoon, people "apparently reacting to alarming text messages". 12:00 is set here.
TEXT_T = 48 + 4
# 史料：监管机构和银行管理层"周日晚"否认。钟点定为 21:00。
# The record: the regulator and the bank's management rejected the rumours "Sunday night". 21:00 is set here.
GUARANTEE_T = 48 + 13
# 史料：总理 12 月 12 日周一在政府会议上表态。钟点定为 10:00。
# The record: the prime minister spoke at a government session on Monday 12 December. 10:00 is set here.
NOTICE_T = 72 + 2

RECORD = dict(
    case="swedbank_latvia_2011",
    run_days=(3, 3),  # 挤兑发生在周日，即第 3 天 / the run took place on Sunday, day 3
    amount=0.015,  # 银行称自周日起取走约 3000 万拉特，为存款总额的 1.5% / the bank: about 30 million lats since Sunday, 1.5% of deposits
    runners=None,  # 史料没有取款人数 / the record gives no count of people who withdrew
)


def interventions(start_hour: int) -> list[Intervention]:
    """史料里的三件事：周日的短信和社交网络消息，当晚监管机构与银行否认，周一总理表态。
    Three things from the record: Sunday's text and social-media messages, the denial by regulator and bank that
    night, and the prime minister's statement on Monday.
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
