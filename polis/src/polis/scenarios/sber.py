"""第九个场景：2014 年 12 月俄罗斯储蓄银行（Sberbank）挤兑。事件顺序取自 corpus/cases/sberbank_2014.yaml。
Ninth scenario: the December 2014 run on Sberbank in Russia. Event order from corpus/cases/sberbank_2014.yaml.

这个场景只用来做样本外检验。它的设定和通过标准（RECORD）在第三轮模型改动之前写定并合并，之后不再改；
写定之时没有运行过它。街区、人物和人口都是合成的；人物是虚构的普通储户，不对应任何真实的人。
This scenario exists only as an out-of-sample test. Its settings and pass criteria (RECORD) were written and merged
before the third round of model changes and are not to be edited afterwards; it had not been run when they were fixed.
Districts, cast and population are synthetic; the characters are invented ordinary depositors, not real people.

凡是史料里没有数字的地方，用的是与东亚银行场景相同的预设（群发消息 1.5/0.3、声明 1.2/0.35、
起始说法的严重度 1.0 和可信度 0.6），没有为这个场景另设。史料里没有外部当局出面担保或运来现金，
所以这里没有"当局表态"那一条，只有银行自己的两次声明。史料只给了日期、没给钟点的事件，钟点是这里定的，逐条注明。
Where the record gives no number, the values are the same presets as the Bank of East Asia scenario (mass message
1.5/0.3, statement 1.2/0.35, origin severity 1.0 and belief 0.6); none was chosen for this scenario. The record has
no outside authority vouching for the bank or bringing cash, so there is no "authorities' statement" here, only the
bank's own two statements. Where the record gives a date but no hour, the hour is set here and marked.
"""

from __future__ import annotations

from ..model import Intervention
from . import rumor_run

TITLE = "俄罗斯储蓄银行挤兑（2014）"
TITLE_EN = "The run on Sberbank (2014)"
SETTING = (
    "2014 年 12 月的俄罗斯，卢布前一天刚暴跌。周三傍晚，匿名短信说储蓄银行的卡明天就要被封、存款取不出来，"
    "人们涌向取款机。银行经营正常。"
)
PUBLIC = "2014 年 12 月的俄罗斯。周二卢布一天之内暴跌，中央银行半夜把利率提到 17% 也没止住。很多人的存款在储蓄银行。"
DEFAULTS = dict(ticks=168, start_hour=8)  # 12 月 17 日周三 08:00 起，共七天 / from Wednesday 17 December 08:00, seven days
# 俄罗斯有存款保险。上限我没有在这次核对里取回原文，所以只记有无。
# Russia had deposit insurance. Its limit was not fetched in this round of checking, so only its existence is recorded.
DEPOSIT_INSURANCE = True

# 事发前人心有多不稳，按 scenarios/context.py 里的规则计：前一天卢布暴跌，居民的储蓄直接缩水（第一条）；
# 三十天内没有记载到存款银行被关或被接管（第二条）。
# How unsettled people were beforehand, by the rule in scenarios/context.py: the rouble collapsed the day before,
# cutting the value of household savings directly (item a); no deposit-taking bank is recorded as closed or taken
# over within thirty days (item b).
UNEASE = 1

DISTRICTS = [
    ("莫斯科中心", None),
    ("圣彼得堡", 0 / 7),
    ("叶卡捷琳堡", 1 / 7),
    ("新西伯利亚", 2 / 7),
    ("喀山", 3 / 7),
    ("下诺夫哥罗德", 4 / 7),
    ("罗斯托夫", 5 / 7),
    ("郊区新城", 6 / 7),
]

VENUES = [
    ("储蓄银行", "bank", "莫斯科中心", (0, 0), (9, 19)),
    ("咖啡馆", "teahouse", "圣彼得堡", (20, 30), (8, 22)),
    ("食堂", "teahouse", "叶卡捷琳堡", (30, -20), (7, 16)),
    ("集市", "market", "莫斯科中心", (-70, 55), (8, 18)),
    ("地铁站", "station", "莫斯科中心", (60, -70), (6, 10)),
]

CAST = [
    dict(key="banker", name="银行副行长", role="储蓄银行副行长", district="莫斯科中心", age=45, sex="m", education=3,
         persona="他知道钱是够的，卡住的是系统：人人同时在取款机上取现。", trust_institution=0.95, depth=2, deposit=0, stake=0, hub=8),
    dict(key="witness", name="会计奥莉加", role="小公司的会计", district="莫斯科中心", age=38, sex="f", education=3,
         persona="昨天眼看着工资换成美元少了两成，今天手机又响了。", trust_general=0.6, conformity=0.6, depth=1,
         deposit=800, stake=0.6, hub=8),
    dict(key="driver", name="出租车司机", role="出租车司机", district="郊区新城", age=44, sex="m", education=1,
         persona="一天载几十个客，听几十种说法。", trust_general=0.6, depth=0, deposit=300, stake=0.8, hub=24),
    dict(key="owner", name="集市摊主", role="集市里的水果摊主", district="莫斯科中心", age=50, sex="f", education=1,
         persona="摊上的流水都存在储蓄银行的卡里。", risk_aversion=0.7, depth=1, deposit=2000, stake=0.9, venues=["集市"], hub=30),
    dict(key="retiree", name="退休工程师", role="退休工程师", district="叶卡捷琳堡", age=68, sex="m", education=3,
         persona="1991 年存折上的钱一夜之间不值钱了，1998 年又来了一回。", risk_aversion=0.95, trust_institution=0.3, depth=0,
         deposit=1500, stake=1.0, venues=["食堂"], hub=6),
]

RUMOR = [
    (0.75, ["听说储蓄银行的卡要出问题？", "卢布这么跌，银行会不会限制取钱？"]),
    (1.05, ["储蓄银行可能要限制取现。", "都在传储蓄银行的卡要被封。"]),
    (1.35, ["储蓄银行的卡明天就不能用了。", "储蓄银行要被国际支付系统切断。"]),
    (1.75, ["储蓄银行已经不给取钱了。", "储蓄银行的取款机前已经排起了队。"]),
    (9.99, ["储蓄银行明天封卡、存款冻结，有钱的快去取！", "存款马上就取不出来了，快去取款机！"]),
]
ORIGIN = "手机上收到一条短信：储蓄银行就要被国际支付系统切断，卡要被封，存款会被冻结。"
ORIGIN_SEVERITY = 1.0
ORIGIN_BELIEF = 0.6
QUEUE_SEEN = "我看见储蓄银行的取款机前排着长队取钱。"
REBUTTAL = ["我去取款机取过了，照常出钱。", "银行说了，不限制取现。", "Visa 和万事达都说卡照常能用。"]
TEXT_MESSAGE = "【转发】储蓄银行 12 月 18 日起封卡，存款冻结，赶快把钱取出来！"
NOTICE = "储蓄银行声明：本行卢布和外币资金充足，没有也不会对取现设任何限制；Visa 和万事达确认继续支持本行的卡。"
GUARANTEE = "储蓄银行副行长在电视上说：系统的压力已经过去，资金外流已经开始回落。"
FAILED = "储蓄银行付不出钱，停业了。"
SEED_THOUGHT = "昨天说跌就跌了，谁也没提前说一声。这回不能再等——先告诉家里人。"
NOTICE_THOUGHT = "钱是够的。别多说，越解释越乱；把取款机装满，让系统撑住。"

# 史料：12 月 17 日周三 17:00 之后，搜索引擎上关于储蓄银行封卡的查询骤增。钟点出自史料。
# The record: after 17:00 on Wednesday 17 December, search queries about Sberbank cards being blocked surged. The
# hour is from the record.
TEXT_T = 9
# 史料：银行 12 月 18 日周四发表声明；当天被取走约 3000 亿卢布，网上银行一度中断。钟点定为 12:00。
# The record: the bank issued its statement on Thursday 18 December; about RUB 300 billion left that day and online
# banking was briefly disrupted. 12:00 is set here.
NOTICE_T = 24 + 4
# 史料：12 月 19 日周五，副行长在电视上说外流已经开始回落。钟点定为 12:00。
# 这是史料里最后一次公开回应，"事后平息"从这里起算；它是银行自己的话，所以用的是"声明"的预设，不是"当局表态"的。
# The record: on Friday 19 December the deputy chairman said on television that the outflow had begun to decline.
# 12:00 is set here. It is the last public response in the record, so "calm afterwards" is counted from it; being
# the bank's own words, it uses the "statement" preset, not the "authorities' statement" one.
GUARANTEE_T = 48 + 4

RECORD = dict(
    case="sberbank_2014",
    run_days=(1, 2),  # 周三傍晚起，周四是高峰 / from Wednesday evening, peaking on Thursday
    # 一周取走 1.3 万亿卢布；个人存款 2014 年年中为 7.96 万亿（俄罗斯会计准则），两个数相隔半年。
    # RUB 1.3 trillion in a week; individuals' deposits were RUB 7.96 trillion in mid-2014 (Russian standards), the
    # two figures being half a year apart.
    amount=0.163,
    runners=None,  # 史料没有去取款的人数 / the record gives no count of those who withdrew
)


def interventions(start_hour: int) -> list[Intervention]:
    """史料里的三件事：周三傍晚的群发短信，周四银行的声明，周五副行长在电视上的话。
    Three things from the record: Wednesday evening's mass texts, the bank's statement on Thursday, and the deputy
    chairman's words on television on Friday.
    """
    return [
        Intervention(t=TEXT_T, text=TEXT_MESSAGE, valence=1, strength=1.5, reach=0.3),
        Intervention(t=NOTICE_T, text=NOTICE, valence=-1, strength=1.2, reach=0.35),
        Intervention(t=GUARANTEE_T, text=GUARANTEE, valence=-1, strength=1.2, reach=0.35),
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
