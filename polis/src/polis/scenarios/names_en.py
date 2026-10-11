"""各场景的标题、简介和地名的英文。人名、谣言的各种说法和心里话保持中文原文，不在这里。
English for each scenario's title, setting and place names. People's names, the wordings of the rumour and
characters' thoughts stay in the original Chinese and are not here.

单独放一个文件，是因为三个样本外场景的模块在写定之后不再改动。
This lives in a file of its own because the three held-out scenario modules are not edited once fixed.
"""

from __future__ import annotations

TITLE = {
    "rumor_run": "The run on Tonghe Bank",
    "toyokawa": "The Toyokawa Shinkin Bank run (1973)",
    "bea": "The Bank of East Asia run (2008)",
    "bac": "The run on BAC San José (2004)",
    "swedbank": "The run on Swedbank in Latvia (2011)",
    "kaspi": "The run on Kaspi Bank (2014)",
}

SETTING = {
    "rumor_run": (
        "A county town of a thousand-odd people in Republican-era China, with a single bank: Tonghe. "
        "On the first night Old Zhou the watchman sees boxes carried out of its back door. The bank is in fact sound."
    ),
    "toyokawa": (
        "December 1973, a small town in Aichi Prefecture, Japan, uneasy after the oil crisis. On the commuter train on "
        "the morning of 8 December, two schoolgirls tease a classmate who has just been hired by the credit union: "
        "\"Credit unions are dangerous, you know.\" The bank is sound."
    ),
    "bea": (
        "Hong Kong, September 2008, just after Lehman Brothers collapsed. From Monday word goes round that the Bank of "
        "East Asia is in trouble; on Tuesday an anonymous mass text says it is already being run on. The bank is sound."
    ),
    "bac": (
        "Costa Rica, August 2004. Days earlier regulators froze a brokerage's funds. From Monday word goes round that "
        "the government will freeze the funds of BAC San José. The bank is sound."
    ),
    "swedbank": (
        "Latvia, December 2011, three weeks after a local bank was taken over. Rumours about Swedbank intensify from "
        "Friday; on Sunday social media and text messages say it is going bankrupt and people rush to its cash "
        "machines. The bank is sound."
    ),
    "kaspi": (
        "Kazakhstan, February 2014, a week after the tenge lost nearly a fifth of its value. On Tuesday an anonymous "
        "mass message says Kaspi and two other banks are about to go bankrupt. The bank is sound."
    ),
}

# 场所和街区：中文名 → 英文名 / venues and districts: Chinese name → English name
NAMES = {
    "rumor_run": {
        "庙前": "Temple Front", "东门": "East Gate", "河沿": "Riverside", "码头": "The Wharf", "南巷": "South Lane",
        "西市": "West Market", "北关": "North Gate", "学宫": "The Academy",
        "通和钱庄": "Tonghe Bank", "吴记茶馆": "Wu's Teahouse", "临河茶社": "Riverside Teahouse",
        "西市菜场": "West Market", "码头早市": "Wharf Morning Market", "城隍庙": "City God Temple", "县立学堂": "County School",
    },
    "toyokawa": {
        "站前": "Station Front", "本町": "Honmachi", "东町": "Higashimachi", "河边": "Riverside", "南町": "Minamimachi",
        "西町": "Nishimachi", "北町": "Kitamachi", "新田": "Shinden",
        "丰川信用金库": "Toyokawa Shinkin Bank", "美容院": "Beauty salon", "洗衣店": "Laundry", "商店街": "Shopping street",
        "车站": "Station", "高中": "High school",
    },
    "bea": {
        "中环": "Central", "湾仔": "Wan Chai", "北角": "North Point", "观塘": "Kwun Tong", "旺角": "Mong Kok",
        "深水埗": "Sham Shui Po", "荃湾": "Tsuen Wan", "沙田": "Sha Tin",
        "东亚银行": "Bank of East Asia", "茶餐厅": "Cha chaan teng", "酒楼": "Restaurant", "街市": "Wet market", "地铁站": "MTR station",
    },
    "bac": {
        "市中心": "City centre", "帕瓦斯": "Pavas", "莫拉维亚": "Moravia", "埃斯卡苏": "Escazú", "德桑帕拉多斯": "Desamparados",
        "埃雷迪亚": "Heredia", "阿拉胡埃拉": "Alajuela", "卡塔戈": "Cartago",
        "BAC 圣何塞银行": "BAC San José", "咖啡馆": "Café", "小饭馆": "Soda", "中央市场": "Central Market", "公交总站": "Bus terminal",
    },
    "swedbank": {
        "里加老城": "Riga Old Town", "叶尔加瓦": "Jelgava", "文茨皮尔斯": "Ventspils", "泽姆加莱": "Zemgale",
        "陶格夫匹尔斯": "Daugavpils", "利耶帕亚": "Liepāja", "尤尔马拉": "Jūrmala", "瓦尔米耶拉": "Valmiera",
        "Swedbank 取款机": "Swedbank cash machines", "咖啡馆": "Café", "小酒馆": "Tavern", "中央市场": "Central Market", "火车站": "Railway station",
    },
    "kaspi": {
        "阿拉木图中心": "Central Almaty", "阿斯塔纳": "Astana", "奇姆肯特": "Shymkent", "卡拉干达": "Karaganda", "阿克托别": "Aktobe",
        "阿特劳": "Atyrau", "巴甫洛达尔": "Pavlodar", "塔拉兹": "Taraz",
        "Kaspi 银行": "Kaspi Bank", "茶馆": "Teahouse", "食堂": "Canteen", "绿色巴扎": "Green Bazaar", "地铁站": "Metro station",
    },
}  # fmt: skip


def name(scenario: str, zh: str) -> str:
    return NAMES.get(scenario, {}).get(zh, "")
