"""首个场景：一句闲话如何挤垮一家钱庄。这里只放内容（地点、人物、说法），机制在 engine。

人物与地名均为本项目原创，不取自任何作品。
"""

from __future__ import annotations

from ..model import Intervention

TITLE = "通和钱庄挤兑"
DEFAULTS: dict = {}  # 这个场景对 Params 缺省值的改动
SETTING = (
    "民国年间的一座县城，千余口人。城中只有一家钱庄——通和。"
    "头一天夜里，更夫老周看见钱庄后门往外抬箱子。钱庄其实并不亏空。"
)

# (名字, 相对城心的方位角比例 0..1；None 为城心)
DISTRICTS = [
    ("庙前", None),
    ("东门", 0 / 7),
    ("河沿", 1 / 7),
    ("码头", 2 / 7),
    ("南巷", 3 / 7),
    ("西市", 4 / 7),
    ("北关", 5 / 7),
    ("学宫", 6 / 7),
]

# (名字, 类型, 所在街区, 相对街区中心的偏移, 营业时段)
VENUES = [
    ("通和钱庄", "bank", "庙前", (0, 0), (9, 16)),
    ("吴记茶馆", "teahouse", "庙前", (-70, 60), (13, 22)),
    ("临河茶社", "teahouse", "河沿", (30, -20), (13, 22)),
    ("西市菜场", "market", "西市", (20, 30), (6, 11)),
    ("码头早市", "market", "码头", (-20, 20), (6, 11)),
    ("城隍庙", "temple", "庙前", (60, -70), (7, 12)),
    ("县立学堂", "school", "学宫", (0, 10), (8, 16)),
]

# 主角。未写的字段沿用合成值。hub 为额外结交的人数。
CAST = [
    dict(key="banker", name="沈砚秋", role="通和钱庄掌柜", district="庙前", age=52, sex="m", education=2,
         persona="守了半辈子柜台，把信用看得比命重，不屑于向街坊解释。",
         trust_institution=0.95, depth=2, deposit=0, stake=0, hub=10),
    dict(key="witness", name="老周", role="更夫", district="北关", age=61, sex="m", education=0,
         persona="夜里打更，白天爱在茶馆里讲夜里见到的事。",
         trust_general=0.7, conformity=0.6, depth=0, deposit=40, stake=0.9, venues=["吴记茶馆"], hub=6),
    dict(key="teahouse", name="吴四嫂", role="茶馆老板娘", district="庙前", age=44, sex="f", education=1,
         persona="全城的消息都从她的茶桌上过，她自己什么都信三分。",
         trust_general=0.5, depth=1, deposit=320, stake=0.6, venues=["吴记茶馆"], hub=40),
    dict(key="reporter", name="陈望之", role="报馆访员", district="学宫", age=29, sex="m", education=3,
         persona="凡事要亲眼看过才肯落笔。",
         trust_general=0.35, conformity=0.2, media_use=0.95, depth=2, deposit=60, stake=0.4,
         venues=["吴记茶馆"], hub=14),
    dict(key="teacher", name="柳先生", role="教书先生", district="学宫", age=47, sex="m", education=3,
         persona="不信闲话，但也知道闲话信的人多了就成了真事。",
         trust_general=0.3, conformity=0.25, risk_aversion=0.5, depth=2, deposit=180, stake=0.7,
         venues=["县立学堂"], hub=8),
    dict(key="puller", name="阿福", role="黄包车夫", district="码头", age=26, sex="m", education=0,
         persona="一天拉二十趟车，听二十段话，转头就讲给下一位客人。",
         trust_general=0.75, conformity=0.7, depth=0, deposit=25, stake=0.95, hub=24),
    dict(key="widow", name="何寡妇", role="浆洗度日", district="河沿", age=55, sex="f", education=0,
         persona="亡夫留下的钱全存在通和，那是她的棺材本。",
         trust_general=0.6, risk_aversion=0.95, conformity=0.7, depth=0, deposit=260, stake=1.0, hub=2),
    dict(key="constable", name="赵巡长", role="巡警", district="南巷", age=38, sex="m", education=1,
         persona="上头说没事，他就说没事。",
         trust_institution=0.9, conformity=0.5, depth=1, deposit=90, stake=0.5, hub=10),
    dict(key="clerk", name="钱账房", role="米行账房", district="西市", age=41, sex="m", education=2,
         persona="算盘打得精，凡事先算别人会怎么算。",
         trust_general=0.4, conformity=0.3, risk_aversion=0.7, depth=2, deposit=450, stake=0.8,
         venues=["临河茶社"], hub=8),
    dict(key="draper", name="孙掌柜", role="布庄老板", district="东门", age=50, sex="m", education=2,
         persona="柜上的流水全走通和，钱庄一倒他也得关门。",
         trust_institution=0.6, risk_aversion=0.6, depth=1, deposit=2400, stake=0.9,
         venues=["吴记茶馆"], hub=12),
    dict(key="student", name="小满", role="学堂学生", district="学宫", age=17, sex="f", education=2,
         persona="把先生的话和街上的话都记在本子上，想弄明白哪个是真的。",
         trust_general=0.5, conformity=0.4, media_use=0.7, depth=1, deposit=0, stake=0,
         venues=["县立学堂"], hub=6),
    dict(key="seer", name="半仙", role="算命先生", district="西市", age=58, sex="m", education=1,
         persona="话到他嘴里总要重三分，越吓人越有人听。",
         trust_general=0.6, conformity=0.5, depth=1, deposit=30, stake=0.5, venues=["西市菜场"], hub=18),
]

# 谣言按严重程度分档：(严重度上限, 几种说法)
RUMOR = [
    (0.75, ["听说通和钱庄近来周转有些紧。", "通和那边好像不大顺，你听说了没有？"]),
    (1.05, ["有人看见通和钱庄半夜往外抬箱子。", "更夫说，通和后门昨夜抬出去好几口箱子。"]),
    (1.35, ["通和钱庄的现银叫东家连夜运走了。", "通和库里的银子昨夜全抬空了。"]),
    (1.75, ["通和钱庄亏空了，东家已经跑了。", "通和的东家卷了银子跑了，掌柜还瞒着。"]),
    (9.99, ["通和明天就关门，存的钱一个子儿也拿不回来！", "官府明天就来封通和的门，快去取钱！"]),
]
ORIGIN = "我昨夜亲眼看见，通和钱庄后门往外抬箱子。"
ORIGIN_SEVERITY = 1.0  # 最初那句话有多重
ORIGIN_BELIEF = 0.6  # 说出它的人自己信几分
QUEUE_SEEN = "我看见有人急着去通和取钱。"
REBUTTAL = [
    "我亲自去柜上看了，通和照常兑付。",
    "我问过了，那晚抬的是旧账册，不是银子。",
    "通和没事，我刚取了又存回去了。",
]
NOTICE = "通和钱庄告示：本号银根充足，照常兑付，切勿听信谣言。"

FAILED = "通和钱庄兑不出银子，关门了。"


def interventions(start_hour: int) -> list[Intervention]:
    """默认剧本里唯一的干预：第二个营业日开门时掌柜贴出告示。"""
    t = (24 - start_hour) % 24 + 24 + 9
    return [Intervention(t=t, text=NOTICE, valence=-1, strength=1.2, reach=0.35)]


def rumor_text(severity: float, pick: int) -> str:
    for cap, texts in RUMOR:
        if severity < cap:
            return texts[pick % len(texts)]
    return RUMOR[-1][1][0]


def thought(kind: str, *, depth: int, src: str = "", text: str = "", belief: float = 0, expect: float = 0) -> str:
    """主角在关键时刻的一句心里话，由状态直接拼出（M6 换成 LLM 独白）。"""
    pct = round(belief * 100)
    others = round(expect * 100)
    if kind == "seed":
        return "半夜三更往外抬箱子，抬的能是什么？明儿得跟茶馆里的人说说。"
    if kind == "heard":
        return f"{src}说：「{text}」我信它{_tenths(pct)}。"
    if kind == "believe":
        return f"说的人多了，怕不是空穴来风。我现在信了{_tenths(pct)}。"
    if kind == "doubt":
        return f"细想又不大像。我只信{_tenths(pct)}了。"
    if kind == "queue":
        if depth == 0:
            return "人人都在取，我也得去取。"
        if depth == 1:
            return f"信的人迟早都要去取，我估摸有{others}%的人会去。去晚了就没有了。"
        return f"钱庄有没有事已经不要紧——人人都以为别人要取，它就真会被取空。我估摸{others}%的人会去，我不能做最后一个。"
    if kind == "withdraw":
        return "钱拿到手了，心才落回肚子里。"
    if kind == "verify":
        return f"我自己去柜上看了一眼。现在我只信{_tenths(pct)}。"
    if kind == "notice":
        return "贴张告示出去。本号几十年的信用，还怕几句闲话？"
    if kind == "lost":
        return "门关了。我的钱还在里面。"
    if kind == "failed":
        return "库里的银子本来是够的。是他们自己把它取空的。"
    return ""


def _tenths(pct: int) -> str:
    n = max(0, min(10, round(pct / 10)))
    return "十成" if n == 10 else ("不到一成" if n == 0 else "一二三四五六七八九"[n - 1] + "成")
