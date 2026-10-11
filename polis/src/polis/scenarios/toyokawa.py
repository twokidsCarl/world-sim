"""第二个场景：1973 年丰川信用金库挤兑。人物、事件顺序取自 corpus/cases/toyokawa_shinkin_1973.yaml。

人物沿用史料里的匿名代号。街区是示意，不是真实地理；人口、存款、关系网都是合成的。
"""

from __future__ import annotations

from ..model import Intervention
from . import rumor_run

TITLE = "丰川信用金库挤兑（1973）"
SETTING = (
    "1973 年 12 月，日本爱知县的一座小镇，石油危机之后人心不定。"
    "12 月 8 日早上的通勤列车上，两个女学生对刚被信用金库录用的同学开了句玩笑：「信用金库很危险哦。」"
    "金库经营正常。"
)
PUBLIC = "1973 年 12 月，日本爱知县的一座小镇，石油危机之后物价飞涨、人心不定。镇上人的存款多在丰川信用金库。"
DEFAULTS = dict(ticks=264, start_hour=8)  # 12 月 8 日 08:00 起，共十一天

DISTRICTS = [
    ("站前", None),
    ("本町", 0 / 7),
    ("东町", 1 / 7),
    ("河边", 2 / 7),
    ("南町", 3 / 7),
    ("西町", 4 / 7),
    ("北町", 5 / 7),
    ("新田", 6 / 7),
]

VENUES = [
    ("丰川信用金库", "bank", "站前", (0, 0), (9, 15)),
    ("美容院", "salon", "本町", (20, 30), (9, 19)),
    ("洗衣店", "shop", "站前", (-70, 55), (8, 19)),
    ("商店街", "market", "西町", (20, 30), (9, 19)),
    ("车站", "station", "站前", (60, -70), (6, 9)),
    ("高中", "school", "新田", (0, 10), (8, 16)),
]

CAST = [
    dict(key="banker", name="金库理事", role="丰川信用金库的负责人", district="站前", age=55, sex="m", education=3,
         persona="金库经营正常，他以为一纸声明就够了。", trust_institution=0.95, depth=1, deposit=0, stake=0, hub=8),
    dict(key="witness", name="女学生A", role="已被金库录用的高中生", district="新田", age=18, sex="f", education=2,
         persona="把同学的玩笑当了真，当晚就去问亲戚。", trust_general=0.75, conformity=0.6, depth=0, deposit=0, stake=0,
         venues=["高中", "车站"], hub=2),
    dict(key="relative_d", name="亲戚D", role="A 的亲戚", district="北町", age=46, sex="f", education=1,
         persona="听了半句就认定说的是丰川信用金库，马上打电话去问。", trust_general=0.7, depth=0, deposit=300, stake=0.7, hub=4),
    dict(key="relative_e", name="亲戚E", role="住在金库总店附近", district="站前", age=50, sex="f", education=1,
         persona="被人一问，自己也拿不准，转头又去问别人。", trust_general=0.6, depth=1, deposit=400, stake=0.7,
         venues=["美容院"], hub=6),
    dict(key="salon", name="美容院老板F", role="美容院经营者", district="本町", age=42, sex="f", education=1,
         persona="店里人来人往，听来的话总要再讲给下一位客人。", trust_general=0.6, conformity=0.6, depth=1,
         deposit=500, stake=0.6, venues=["美容院"], hub=30),
    dict(key="laundry_h", name="洗衣店老板H", role="洗衣店经营者", district="站前", age=48, sex="m", education=1,
         persona="七年前一家金融机构倒闭时吃过亏，听到这类消息格外上心。", risk_aversion=0.95, trust_institution=0.25,
         depth=1, deposit=1800, stake=0.95, venues=["洗衣店"], hub=12),
    dict(key="laundry_i", name="洗衣店老板娘I", role="H 的妻子", district="站前", age=45, sex="f", education=1,
         persona="看见别人在取钱，就认定事情是真的，立刻去取，并且见人就说。", risk_aversion=0.95, conformity=0.85,
         trust_general=0.8, depth=0, deposit=1800, stake=0.95, venues=["洗衣店"], hub=20),
    dict(key="customer_j", name="顾客J", role="来洗衣店借电话的生意人", district="东町", age=40, sex="m", education=2,
         persona="对传闻一无所知，只是要付一笔货款。", trust_general=0.4, depth=1, deposit=1200, stake=0.3,
         venues=["洗衣店"], hub=4),
    dict(key="radio", name="无线电爱好者", role="业余无线电玩家", district="河边", age=30, sex="m", education=2,
         persona="一按通话键，半个镇子都听得见。", trust_general=0.6, conformity=0.5, depth=1, deposit=200, stake=0.5, hub=60),
    dict(key="taxi", name="出租车司机", role="送客去金库支店", district="南町", age=38, sex="m", education=1,
         persona="一天之内听着乘客的说法从「好像危险」变成「明天不开门」。", trust_general=0.6, depth=1, deposit=150,
         stake=0.6, venues=["车站"], hub=24),
]

RUMOR = [
    (0.75, ["听说信用金库有点危险，是真的吗？", "丰川信用金库是不是不太妙？"]),
    (1.05, ["丰川信用金库好像有危险。", "都在说丰川信用金库危险。"]),
    (1.35, ["丰川信用金库危险了。", "丰川信用金库不行了，有人已经在取钱。"]),
    (1.75, ["丰川信用金库要倒了。", "金库的职员卷了钱跑了。"]),
    (9.99, ["丰川信用金库明天卷帘门就不会再开了！", "理事长都自杀了，快去取钱！"]),
]
ORIGIN = "同学说信用金库很危险——是真的吗？"
ORIGIN_SEVERITY = 0.6
ORIGIN_BELIEF = 0.5
QUEUE_SEEN = "我看见有人急着去信用金库取钱。"
REBUTTAL = ["我去窗口看过了，照常付款。", "报上登了，那是谣言。", "日本银行都出面担保了。"]
NOTICE = "丰川信用金库声明：本库经营正常，请勿听信流言。"
GUARANTEE = "日本银行表示：丰川信用金库经营健全。各报同日报道此事系谣言，成堆的现金已摆在柜台前。"
FAILED = "丰川信用金库付不出钱，关门了。"

NOTICE_T = 6 * 24 + 1  # 12 月 14 日 09:00，金库自己的声明
GUARANTEE_T = 6 * 24 + 10  # 12 月 14 日 18:00，媒体集中报道、日本银行表态


def interventions(start_hour: int) -> list[Intervention]:
    """史料里的两次回应：金库自己的声明，以及当晚起媒体辟谣、日本银行担保并摆出现金。"""
    return [
        Intervention(t=NOTICE_T, text=NOTICE, valence=-1, strength=1.2, reach=0.35),
        Intervention(t=GUARANTEE_T, text=GUARANTEE, valence=-1, strength=3.0, reach=0.9),
    ]


def rumor_text(severity: float, pick: int) -> str:
    for cap, texts in RUMOR:
        if severity < cap:
            return texts[pick % len(texts)]
    return RUMOR[-1][1][0]


def thought(kind: str, **kw) -> str:
    if kind == "seed":
        return "她们说信用金库很危险。我明年就要去那里上班了——得找人问问。"
    if kind == "notice":
        return "发一份声明。本库经营正常，流言自己会散的。"
    return rumor_run.thought(kind, **kw).replace("钱庄", "金库").replace("柜上", "窗口")
