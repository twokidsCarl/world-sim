"""第三个场景：2008 年 9 月香港东亚银行挤兑。事件顺序取自 corpus/cases/bea_bank_run_2008.yaml。
Third scenario: the September 2008 run on the Bank of East Asia in Hong Kong. Event order from the corpus case file.

这个场景原本只用来做样本外检验：它的设定在第一次运行之前就定下，之后不再调。结果看过之后它不再算检验（见 canon.bea）。
街区、人物和人口都是合成的；人物是虚构的普通储户，不对应任何真实的人。
This scenario was built as an out-of-sample test: its settings were fixed before the first run and are not tuned.
Once its result had been seen it stopped counting as a test (see canon.bea).
Districts, cast and population are synthetic; the characters are invented ordinary depositors, not real people.

凡是史料里没有数字的地方（群发短信触及多少人、有多可信），用的是实验台里早已存在的预设值，没有为这个场景另设。
Where the record gives no number (how many the mass text reached, how credible it was), the values are the
presets that already existed in the lab, not ones chosen for this scenario.
"""

from __future__ import annotations

from ..model import Intervention
from . import rumor_run

TITLE = "东亚银行挤兑（2008）"
SETTING = (
    "2008 年 9 月的香港，雷曼兄弟刚刚倒闭。周一起，市面上流传东亚银行出了问题；"
    "周二，一条匿名群发的短信说它已经在被挤兑。银行经营正常。"
)
PUBLIC = "2008 年 9 月的香港，雷曼兄弟上周刚刚倒闭，人人都在担心自己的钱。很多人的存款在东亚银行。"
DEFAULTS = dict(ticks=120, start_hour=8)  # 周一 08:00 起，共五天 / from Monday 08:00, five days
# 香港有存款保障计划，当时上限 10 万港元（金管局 2008 年 9 月 24 日新闻稿，见案例文件）。
# Hong Kong had a Deposit Protection Scheme, capped at HK$100,000 at the time (HKMA press release of 24 September 2008; see the case file).
DEPOSIT_INSURANCE = True

DISTRICTS = [
    ("中环", None),
    ("湾仔", 0 / 7),
    ("北角", 1 / 7),
    ("观塘", 2 / 7),
    ("旺角", 3 / 7),
    ("深水埗", 4 / 7),
    ("荃湾", 5 / 7),
    ("沙田", 6 / 7),
]

VENUES = [
    ("东亚银行", "bank", "中环", (0, 0), (9, 17)),
    ("茶餐厅", "teahouse", "旺角", (20, 30), (7, 22)),
    ("酒楼", "teahouse", "北角", (30, -20), (7, 15)),
    ("街市", "market", "深水埗", (20, 30), (6, 12)),
    ("地铁站", "station", "中环", (60, -70), (7, 10)),
]

CAST = [
    dict(key="banker", name="分行经理", role="东亚银行分行经理", district="中环", age=48, sex="m", education=3,
         persona="数字他都清楚，资本充足率是法定要求的两倍。", trust_institution=0.95, depth=2, deposit=0, stake=0, hub=8),
    dict(key="witness", name="文员阿欣", role="写字楼文员", district="湾仔", age=31, sex="f", education=3,
         persona="午饭时听同事说东亚有事，回头就讲给家里人。", trust_general=0.6, conformity=0.6, depth=1,
         deposit=800, stake=0.6, hub=8),
    dict(key="driver", name="的士司机", role="的士司机", district="深水埗", age=52, sex="m", education=1,
         persona="一天载几十个客，听几十种说法。", trust_general=0.6, depth=0, deposit=300, stake=0.8, hub=24),
    dict(key="owner", name="茶餐厅老板", role="茶餐厅老板", district="旺角", age=55, sex="m", education=1,
         persona="店里的流水都走东亚。", risk_aversion=0.7, depth=1, deposit=2000, stake=0.9, venues=["茶餐厅"], hub=30),
    dict(key="teacher", name="退休教师", role="退休教师", district="北角", age=68, sex="f", education=3,
         persona="一辈子的积蓄都在一个户口里，只求今晚睡得安心。", risk_aversion=0.95, trust_institution=0.6, depth=0,
         deposit=1500, stake=1.0, venues=["酒楼"], hub=6),
    dict(key="homemaker", name="主妇", role="主妇", district="沙田", age=44, sex="f", education=2,
         persona="收到短信，转头就发给了一班姊妹。", conformity=0.8, trust_general=0.7, depth=0,
         deposit=600, stake=0.7, venues=["街市"], hub=20),
]

RUMOR = [
    (0.75, ["听说东亚银行最近有点问题？", "东亚是不是也买了雷曼的东西？"]),
    (1.05, ["东亚银行在雷曼和 AIG 上有风险。", "都在传东亚银行出事了。"]),
    (1.35, ["东亚银行亏了很多钱。", "东亚的钱不稳了。"]),
    (1.75, ["东亚银行周转不了了。", "东亚银行已经有人在挤提。"]),
    (9.99, ["东亚银行正在被挤提，有存款的快去取！", "东亚要被接管了，快去取钱！"]),
]
ORIGIN = "同事说东亚银行在雷曼上亏了钱，有点问题。"
ORIGIN_SEVERITY = 1.0
ORIGIN_BELIEF = 0.6
QUEUE_SEEN = "我看见东亚银行门口有人排队提款。"
REBUTTAL = ["我去分行问过了，照常提款。", "金管局说了，传闻毫无根据。", "存款有保障，不用慌。"]
TEXT_MESSAGE = "【转发】东亚银行正在被挤提，有存款的快去取！"
NOTICE = "东亚银行声明：有关传闻毫无根据，本行财务稳健，所有提款照付，分行延长营业时间。"
GUARANTEE = "金管局发言人：有关东亚银行的传闻毫无根据，该行资本充足、流动资金充裕；存款受存款保障计划保障，金管局可随时提供流动资金。"
FAILED = "东亚银行付不出钱，停业了。"

TEXT_T = 24 + 6  # 周二 14:00，匿名群发短信 / Tuesday 14:00, the anonymous mass text
NOTICE_T = 48 + 2  # 周三 10:00，银行否认 / Wednesday 10:00, the bank's denial
GUARANTEE_T = 48 + 6  # 周三 14:00，金管局表态 / Wednesday 14:00, the monetary authority's statement


def interventions(start_hour: int) -> list[Intervention]:
    """史料里的三件事：周二的群发短信，周三银行否认，同日金管局表态并承诺流动性。
    Three things from the record: Tuesday's mass text, the bank's denial on Wednesday, and the monetary
    authority's statement and liquidity pledge the same day.
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
        return "同事说得有板有眼。雷曼都能倒，东亚难说。回去跟家里人讲一声。"
    if kind == "notice":
        return "发声明，延长营业，谁来提都照付。数字摆在那里，不怕。"
    return rumor_run.thought(kind, **kw).replace("钱庄", "银行")
