"""第八个场景：2014 年 6 月保加利亚第一投资银行（FIB）挤兑。事件顺序取自 corpus/cases/fib_bulgaria_2014.yaml。
Eighth scenario: the June 2014 run on First Investment Bank (FIB) in Bulgaria. Event order from corpus/cases/fib_bulgaria_2014.yaml.

这个场景只用来做样本外检验。它的设定和通过标准（RECORD）在第二轮模型改动之前写定并合并，之后不再改；
写定之时没有运行过它。街区、人物和人口都是合成的；人物是虚构的普通储户，不对应任何真实的人。
This scenario exists only as an out-of-sample test. Its settings and pass criteria (RECORD) were written and merged
before the second round of model changes and are not to be edited afterwards; it had not been run when they were fixed.
Districts, cast and population are synthetic; the characters are invented ordinary depositors, not real people.

凡是史料里没有数字的地方，用的是与东亚银行场景相同的预设（群发消息 1.5/0.3、声明 1.2/0.35、
当局表态 3.0/0.9 并补足现金 0.5、起始说法的严重度 1.0 和可信度 0.6），没有为这个场景另设。
有一个数出自史料：运来的现金（0.16），即 12 亿列弗的国家存款比 75.35 亿列弗的存款总额。
史料只给了日期、没给钟点的事件，钟点是这里定的，逐条注明。
Where the record gives no number, the values are the same presets as the Bank of East Asia scenario (mass message
1.5/0.3, statement 1.2/0.35, the authorities' statement 3.0/0.9 with cash 0.5, origin severity 1.0 and belief 0.6);
none was chosen for this scenario. One number does come from the record: the cash brought in (0.16), which is the
state deposit of BGN 1.2 billion against deposits of BGN 7,535 million. Where the record gives a date but no hour, the hour is set here and marked.
"""

from __future__ import annotations

from ..model import Intervention
from . import rumor_run

TITLE = "第一投资银行挤兑（2014）"
TITLE_EN = "The run on First Investment Bank (2014)"
SETTING = (
    "2014 年 6 月的保加利亚，一周前第四大银行刚被中央银行接管。周五，短信、电子邮件和电话里说第一投资银行也没钱了，"
    "人们涌向分行。银行经营正常。"
)
PUBLIC = "2014 年 6 月的保加利亚。一周前 Corpbank 遭挤兑后被中央银行接管，储户的钱至今取不出来。很多人的存款在第一投资银行。"
DEFAULTS = dict(ticks=168, start_hour=8)  # 6 月 27 日周五 08:00 起，共七天，到 7 月 3 日 / from Friday 27 June 08:00, seven days, to 3 July
# 保加利亚有存款保险（上限 196,000 列弗，见于各银行的储户须知；这个上限从哪一天起生效我没有核到）。
# Bulgaria had deposit insurance (a limit of BGN 196,000, per banks' depositor notices; the date it took effect was
# not confirmed).
DEPOSIT_INSURANCE = True

DISTRICTS = [
    ("索非亚中心", None),
    ("普罗夫迪夫", 0 / 7),
    ("瓦尔纳", 1 / 7),
    ("布尔加斯", 2 / 7),
    ("鲁塞", 3 / 7),
    ("旧扎戈拉", 4 / 7),
    ("普列文", 5 / 7),
    ("柳林区", 6 / 7),
]

VENUES = [
    ("第一投资银行", "bank", "索非亚中心", (0, 0), (9, 17)),
    ("咖啡馆", "teahouse", "普罗夫迪夫", (20, 30), (8, 21)),
    ("小酒馆", "teahouse", "瓦尔纳", (30, -20), (11, 22)),
    ("妇女市场", "market", "索非亚中心", (-70, 55), (7, 17)),
    ("地铁站", "station", "索非亚中心", (60, -70), (7, 10)),
]

CAST = [
    dict(key="banker", name="银行行长", role="第一投资银行行长", district="索非亚中心", age=47, sex="m", education=3,
         persona="他知道账上的钱够，难的是分行和取款机里的现金跟不跟得上。", trust_institution=0.95, depth=2, deposit=0, stake=0, hub=8),
    dict(key="witness", name="会计伊凡娜", role="小公司的会计", district="索非亚中心", age=34, sex="f", education=3,
         persona="同事的工资卡在 Corpbank 里，一个星期了一分钱取不出来。", trust_general=0.6, conformity=0.6, depth=1,
         deposit=800, stake=0.6, hub=8),
    dict(key="driver", name="出租车司机", role="出租车司机", district="柳林区", age=45, sex="m", education=1,
         persona="一天载几十个客，听几十种说法。", trust_general=0.6, depth=0, deposit=300, stake=0.8, hub=24),
    dict(key="owner", name="市场摊主", role="妇女市场里的菜摊主", district="索非亚中心", age=52, sex="f", education=1,
         persona="摊上的流水都存在第一投资银行。", risk_aversion=0.7, depth=1, deposit=2000, stake=0.9, venues=["妇女市场"], hub=30),
    dict(key="retiree", name="退休工程师", role="退休工程师", district="普罗夫迪夫", age=67, sex="m", education=3,
         persona="1996 年银行成片倒闭、存款化为乌有的事，他经历过一回。", risk_aversion=0.95, trust_institution=0.3, depth=0,
         deposit=1500, stake=1.0, venues=["咖啡馆"], hub=6),
]

RUMOR = [
    (0.75, ["听说第一投资银行最近有点问题？", "Corpbank 之后，下一家会不会是它？"]),
    (1.05, ["第一投资银行的钱也紧了。", "都在传又有一家银行不稳。"]),
    (1.35, ["第一投资银行的钱不稳了。", "下一家出事的就是第一投资银行。"]),
    (1.75, ["第一投资银行周转不了了。", "第一投资银行的分行已经有人在排队取钱。"]),
    (9.99, ["第一投资银行就要被接管了，有存款的快去取！", "它马上跟 Corpbank 一样关门，快去取钱！"]),
]
ORIGIN = "手机上收到一条消息：第一投资银行没有现金了，赶快把存款取出来。"
ORIGIN_SEVERITY = 1.0
ORIGIN_BELIEF = 0.6
QUEUE_SEEN = "我看见第一投资银行的分行门口排着长队取钱。"
REBUTTAL = ["我去分行取过了，照常付款。", "中央银行说了，这是有人蓄意攻击。", "总统说了，没有银行危机。"]
TEXT_MESSAGE = "【转发】第一投资银行没有现金了，赶快把存款取出来！"
NOTICE = "保加利亚国家银行：有人散布不实的恶意传言，无端地有组织攻击保加利亚的银行。"
GUARANTEE = "总统与各党领袖紧急会商后表示：没有银行危机，只有信任危机和犯罪攻击。政府向第一投资银行存入 12 亿列弗，欧盟委员会同日批准流动性支持方案。"
FAILED = "第一投资银行付不出钱，停业了。"
SEED_THOUGHT = "Corpbank 的人到现在一分钱都取不出来。这回不能再等——先告诉家里人。"
NOTICE_THOUGHT = "账上的钱是够的，缺的是分行里的现钞。先关门补现金，周一照常开。"

BANK = 0  # 银行在 VENUES 里的位置 / the bank's position in VENUES

# 史料：6 月 27 日周五，短信、电子邮件和电话散布消息，同日储户涌到分行。钟点定为 10:00。
# The record: on Friday 27 June text messages, e-mails and phone calls spread the claim and depositors rushed to
# branches the same day. 10:00 is set here.
TEXT_T = 2
# 史料：银行 6 月 27 日"午后不久"暂时关门，以便给分行和取款机补充现金。钟点定为 13:00，关到当日营业结束。
# 周六周日是否营业史料没有说，这里没有另外关门。
# The record: the bank closed temporarily "in the early afternoon" of 27 June to replenish cash in branches and ATMs.
# 13:00 is set here, lasting to the end of that business day. The record does not say whether it opened at the
# weekend, and no further closure is set here.
CLOSE_T = 5
CLOSE_HOURS = 4
# 史料：中央银行就"有组织攻击"发表声明。报道里写的是"昨天"，我取为挤兑当日周五；钟点定为 14:00。
# The record: the central bank's statement about an "organised attack". The report says "yesterday", taken here as
# the Friday of the run; 14:00 is set here.
NOTICE_T = 6
# 史料：6 月 29 日周日，总统召集各党领袖紧急会商并表态；同日国家向银行存入 12 亿列弗、欧盟委员会批准流动性方案。钟点定为 18:00。
# The record: on Sunday 29 June the president convened party leaders and made his statement; the same day the state
# placed its BGN 1.2 billion deposit and the European Commission approved the liquidity scheme. 18:00 is set here.
GUARANTEE_T = 48 + 10
CASH = 0.16  # 12 亿 ÷ 75.35 亿 / 1.2 billion ÷ 7.535 billion

RECORD = dict(
    case="fib_bulgaria_2014",
    run_days=(1, 1),  # 消息发出当天就挤兑 / the run began the day the messages went out
    # 6 月 27 日一天流出 7.88 亿列弗（10.5%），6 月 20 日到 7 月 3 日共付出 14.24 亿（18.9%），存款总额 75.35 亿。
    # 模拟的是 6 月 27 日到 7 月 3 日，真实数字在这两者之间，史料没有单列；取两者的几何平均。
    # BGN 788 million left on 27 June alone (10.5%) and BGN 1,424 million was paid out from 20 June to 3 July (18.9%),
    # against deposits of BGN 7,535 million. The simulation covers 27 June to 3 July; the true figure lies between
    # the two and is not given separately, so their geometric mean is used.
    amount=0.14,
    runners=None,  # 史料没有去取款的人数 / the record gives no count of those who withdrew
)


def interventions(start_hour: int) -> list[Intervention]:
    """史料里的四件事：周五的群发消息，午后银行暂时关门，同日中央银行的声明，周日总统表态和国家存款。
    Four things from the record: Friday's mass messages, the bank's temporary closure that afternoon, the central
    bank's statement the same day, and on Sunday the president's statement with the state deposit.
    """
    return [
        Intervention(t=TEXT_T, text=TEXT_MESSAGE, valence=1, strength=1.5, reach=0.3),
        Intervention(t=CLOSE_T, kind="close_venue", target=BANK, duration=CLOSE_HOURS),
        Intervention(t=NOTICE_T, text=NOTICE, valence=-1, strength=1.2, reach=0.35),
        Intervention(t=GUARANTEE_T, text=GUARANTEE, valence=-1, strength=3.0, reach=0.9, cash=CASH),
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
