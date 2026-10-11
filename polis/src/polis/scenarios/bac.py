"""第四个场景：2004 年 8 月哥斯达黎加 BAC San José 银行挤兑。事件顺序取自 corpus/cases/bac_san_jose_2004.yaml。
Fourth scenario: the August 2004 run on BAC San José in Costa Rica. Event order from corpus/cases/bac_san_jose_2004.yaml.

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

TITLE = "BAC 圣何塞银行挤兑（2004）"
TITLE_EN = "The run on BAC San José (2004)"
SETTING = (
    "2004 年 8 月的哥斯达黎加。监管机构几天前刚冻结了一家券商的资金。"
    "周一起，市面上流传政府要冻结 BAC 圣何塞银行的资金。银行经营正常。"
)
PUBLIC = "2004 年 8 月的哥斯达黎加。监管机构上周刚冻结了一家券商的资金，上个月还冻结过一家银行。很多人的存款在 BAC 圣何塞银行。"
DEFAULTS = dict(ticks=120, start_hour=8)  # 8 月 9 日周一 08:00 起，共五天 / from Monday 9 August 08:00, five days
# 2004 年哥斯达黎加的私营银行没有存款保险（存款保障基金由 2020 年的第 9816 号法设立）。
# 这一条是从"基金 2020 年才设立"推出来的，没有找到直接写明 2004 年情况的出处。
# Private banks in Costa Rica had no deposit insurance in 2004 (the deposit guarantee fund was created by Law 9816
# in 2020). This is inferred from the fund's creation date; no source stating the 2004 position directly was found.
DEPOSIT_INSURANCE = False

DISTRICTS = [
    ("市中心", None),
    ("帕瓦斯", 0 / 7),
    ("莫拉维亚", 1 / 7),
    ("埃斯卡苏", 2 / 7),
    ("德桑帕拉多斯", 3 / 7),
    ("埃雷迪亚", 4 / 7),
    ("阿拉胡埃拉", 5 / 7),
    ("卡塔戈", 6 / 7),
]

VENUES = [
    ("BAC 圣何塞银行", "bank", "市中心", (0, 0), (9, 17)),
    ("咖啡馆", "teahouse", "埃雷迪亚", (20, 30), (7, 21)),
    ("小饭馆", "teahouse", "德桑帕拉多斯", (30, -20), (7, 15)),
    ("中央市场", "market", "市中心", (-70, 55), (6, 14)),
    ("公交总站", "station", "市中心", (60, -70), (6, 9)),
]

CAST = [
    dict(key="banker", name="银行总经理", role="BAC 圣何塞银行总经理", district="市中心", age=45, sex="m", education=3,
         persona="分行的现金已经备足，他知道银行没有问题。", trust_institution=0.95, depth=2, deposit=0, stake=0, hub=8),
    dict(key="witness", name="会计玛尔塔", role="事务所会计", district="市中心", age=34, sex="f", education=3,
         persona="上周那家券商被冻结，她的客户就有钱卡在里面。", trust_general=0.6, conformity=0.6, depth=1,
         deposit=800, stake=0.6, hub=8),
    dict(key="driver", name="出租车司机", role="出租车司机", district="帕瓦斯", age=50, sex="m", education=1,
         persona="一天载几十个客，听几十种说法。", trust_general=0.6, depth=0, deposit=300, stake=0.8, hub=24),
    dict(key="owner", name="小饭馆老板娘", role="小饭馆老板娘", district="德桑帕拉多斯", age=52, sex="f", education=1,
         persona="店里的流水都走这家银行。", risk_aversion=0.7, depth=1, deposit=2000, stake=0.9, venues=["小饭馆"], hub=30),
    dict(key="retiree", name="退休职员", role="退休的公务员", district="埃雷迪亚", age=66, sex="m", education=2,
         persona="一万美元的积蓄都在一个户口里。", risk_aversion=0.95, trust_institution=0.6, depth=0,
         deposit=1500, stake=1.0, venues=["咖啡馆"], hub=6),
]

RUMOR = [
    (0.75, ["听说 BAC 最近有点问题？", "上周冻结了券商，下一个会不会是 BAC？"]),
    (1.05, ["监管局要查 BAC 圣何塞银行。", "都在传政府要动 BAC。"]),
    (1.35, ["政府要冻结 BAC 的资金。", "BAC 的钱要取不出来了。"]),
    (1.75, ["监管局马上要接管 BAC。", "BAC 已经有人在排队取钱。"]),
    (9.99, ["BAC 要关门了，有存款的快去取！", "明天 BAC 的账户就要被冻结，快去取钱！"]),
]
ORIGIN = "客户说，政府冻结了那家券商之后，下一个要冻结的是 BAC 圣何塞银行。"
ORIGIN_SEVERITY = 1.0
ORIGIN_BELIEF = 0.6
QUEUE_SEEN = "我看见 BAC 的分行门口排着长队取钱。"
REBUTTAL = ["我去分行问过了，照常付款。", "中央银行行长在电视上说了，是谣言。", "他们从来没讨论过要动这家银行。"]
NOTICE = "BAC 圣何塞银行声明：传闻毫无根据，各分行现金充足，所有提款照付。"
GUARANTEE = "中央银行行长在电视记者会上说：有关 BAC 圣何塞银行的传闻不实，该行偿付得起、流动性充足，从未讨论过对它采取措施。"
FAILED = "BAC 圣何塞银行付不出钱，停业了。"
SEED_THOUGHT = "券商说冻就冻了。要是银行也这样——得跟家里人说一声。"
NOTICE_THOUGHT = "分行的现金备足了，营业到多晚都行。谁来取都照付。"

# 史料：中央银行行长周三在电视记者会上否认。钟点史料没有给，这里定为 10:00。
# The record: the central bank president's televised denial on Wednesday. The hour is not given; 10:00 is set here.
GUARANTEE_T = 48 + 2

# 写定的通过标准，数字出自案例文件。比例一律要求落在史料数字的二分之一到两倍之间。
# The fixed pass criteria, with numbers from the case file. Shares must fall between half and twice the recorded figure.
RECORD = dict(
    case="bac_san_jose_2004",
    run_days=(1, 2),  # 挤兑发生在周一、周二 / the run took place on Monday and Tuesday
    amount=0.018,  # 到周三下午累计约 900 万美元，按"500 万为 1%"折算 / about $9 million by Wednesday afternoon, at "$5 million is 1%"
    runners=None,  # 史料没有客户总数 / the record gives no total customer count
)


def interventions(start_hour: int) -> list[Intervention]:
    """史料里只有一次有日期的公开回应：周三中央银行行长的电视记者会。
    The record dates only one public response: the central bank president's televised press conference on Wednesday.
    """
    return [Intervention(t=GUARANTEE_T, text=GUARANTEE, valence=-1, strength=3.0, reach=0.9, cash=0.5)]


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
