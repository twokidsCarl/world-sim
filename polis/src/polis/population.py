"""人口合成：个体属性、住处、关系网、场所。只依赖种子，与干预无关。
Population synthesis: personal attributes, homes, the tie network and venues. It depends only on the seed, never on interventions.

年龄结构在有对应地方和年份的场景里取自联合国《世界人口展望》（data/curated/age_structure.yaml）；
其余的边际分布都是占位假设，所以 Population.synthetic 仍为 True。
Where a scenario has a real place and year, the age structure comes from the UN World Population Prospects
(data/curated/age_structure.yaml). Every other marginal distribution is a placeholder assumption, so
Population.synthetic stays True.
"""

from __future__ import annotations

import math
from functools import cache
from pathlib import Path
from types import ModuleType

import numpy as np
import yaml

from .model import District, Params, Person, Population, Tie, Venue
from .scenarios import names_en

EXTENT = 1000.0
CURATED = Path(__file__).resolve().parents[2] / "data" / "curated"
AGE_LO, AGE_HI = 14, 80  # 模拟里的人从 14 岁到 79 岁 / people in the simulation are aged 14 to 79

SURNAMES = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤"
GIVEN_M = "福贵顺发财旺根生水木金土山海林森明亮德仁义礼智信忠孝勇刚强平安康宁"
GIVEN_F = "秀英兰芳桂珍凤翠梅菊莲荷云霞月娥巧慧淑贞玉珠银香春秋冬雪琴素"

# 各类场所：一个成年人成为常客的概率（学校只收读书的年轻人）
# Per kind of venue, the probability that an adult becomes a regular (schools take only young people with some schooling)
JOIN = {"teahouse": 0.18, "market": 0.40, "temple": 0.15, "school": 0.5, "salon": 0.12, "shop": 0.2, "station": 0.25}

KIN, NEIGHBOR, COLLEAGUE, FRIEND = "kin", "neighbor", "colleague", "friend"
STRENGTH = {KIN: 0.9, NEIGHBOR: 0.45, COLLEAGUE: 0.5, FRIEND: 0.6}


def build(params: Params, scenario: ModuleType) -> Population:
    rng = np.random.default_rng([params.seed, 0])
    n = params.n

    districts = _districts(scenario)
    venues = _venues(scenario, districts)
    bank = next(v.idx for v in venues if v.kind == "bank")

    # 住户与住处 / households and homes
    district_of = np.sort(rng.integers(0, len(districts), n))
    household = np.zeros(n, dtype=int)
    pos = np.zeros((n, 2))
    h = -1
    left = 0
    for i in range(n):
        if left == 0 or district_of[i] != district_of[i - 1]:
            h += 1
            left = int(rng.choice([1, 2, 3, 4, 5], p=[0.10, 0.20, 0.30, 0.25, 0.15]))
            d = districts[district_of[i]]
            home = np.array(d.pos) + rng.normal(0, d.radius * 0.42, 2)
        household[i] = h
        pos[i] = np.clip(home + rng.normal(0, 7, 2), 10, EXTENT - 10)
        left -= 1

    # 属性与特质 / attributes and traits
    profile = age_profile(params.scenario)
    age = ages(rng.integers(AGE_LO, AGE_HI, n), profile)
    sex = rng.choice(["f", "m"], n)
    education = rng.choice(4, n, p=[0.35, 0.35, 0.22, 0.08])
    income = np.clip(0.6 * rng.random(n) + 0.13 * education + rng.normal(0, 0.06, n), 0, 1)
    trust_general = rng.beta(3, 3, n)
    trust_institution = np.clip(rng.beta(3, 3, n) + 0.002 * (age - 40), 0, 1)
    risk_aversion = rng.beta(4, 3, n)
    conformity = np.clip(rng.beta(4, 3, n) - 0.05 * education, 0, 1)
    media_use = np.clip(0.15 + 0.22 * education + rng.normal(0, 0.12, n), 0, 1)
    depth = rng.choice(3, n, p=[0.30, 0.45, 0.25])

    has_account = (age >= 18) & (rng.random(n) < 0.25 + 0.6 * income)
    deposit = np.where(has_account, np.round(30 * np.exp(2.2 * income + rng.normal(0, 0.5, n))), 0.0)
    stake = np.where(has_account, np.clip(0.3 + 0.5 * (1 - income) + rng.normal(0, 0.12, n), 0.05, 1), 0.0)

    # 与银行的关系，用单独的随机流，所以不改变上面任何一项 / ties to the bank, on a stream of their own so nothing above changes
    # 这三项的分布是占位假设 / the distributions of these three are placeholder assumptions
    bank_rng = np.random.default_rng([params.seed, 2])
    tenure = np.where(has_account, np.minimum(age - 18, bank_rng.gamma(2.0, 5.0, n)), 0.0).clip(0)
    borrower = has_account & (bank_rng.random(n) < 0.15)
    resolve = bank_rng.normal(0, 1, n)
    # 有存款保险的场景：上限定在储户存款的 95 分位，即约 5% 的储户余额超过上限
    # 这个比例取自 Iyer 与 Puri 的量级（定期 6.6%、活期 1% 的储户超过上限），见 corpus/facts/bank_run_depositor_share.yaml
    # Where the scenario has deposit insurance, the cap sits at the 95th percentile of deposits, so about 5% of
    # depositors hold more than it. The order of magnitude is Iyer and Puri's (6.6% of term and 1% of transaction
    # depositors above the limit); see corpus/facts/bank_run_depositor_share.yaml
    cap = np.quantile(deposit[has_account], 0.95) if getattr(scenario, "DEPOSIT_INSURANCE", False) and has_account.any() else 0.0

    n_work = max(1, n // 25)
    weights = 1.0 / np.arange(1, n_work + 1) ** 0.6
    works = (age >= 16) & (age <= 65) & (rng.random(n) < 0.7)
    workplace = np.where(works, rng.choice(n_work, n, p=weights / weights.sum()), -1)

    names = [_name(rng, s) for s in sex]

    # 场所的常客 / venue regulars
    member: list[list[int]] = [[] for _ in range(n)]
    for kind, p_join in JOIN.items():
        places = [v for v in venues if v.kind == kind]
        if not places:
            continue
        for i in range(n):
            if kind == "school" and not (age[i] < 22 and education[i] >= 1):
                continue
            if kind != "school" and age[i] < 18:
                continue
            if rng.random() < p_join:
                near = min(places, key=lambda v: math.dist(v.pos, pos[i]))
                member[i].append(near.idx)

    # 关系 / ties
    ties: dict[tuple[int, int], str] = {}

    def link(a: int, b: int, kind: str) -> None:
        if a != b:
            ties.setdefault((min(a, b), max(a, b)), kind)

    for i in range(1, n):
        j = i - 1
        while j >= 0 and household[j] == household[i]:
            link(i, j, KIN)
            j -= 1
    for d in range(len(districts)):
        idx = np.flatnonzero(district_of == d)
        if len(idx) < 3:
            continue
        for i in idx:
            dist = np.hypot(*(pos[idx] - pos[i]).T)
            near = idx[np.argsort(dist, kind="stable")[1:13]]
            for j in rng.choice(near, min(2, len(near)), replace=False):
                link(int(i), int(j), NEIGHBOR)
    for w in range(n_work):
        idx = np.flatnonzero(workplace == w)
        if len(idx) < 2:
            continue
        for i in idx:
            for j in rng.choice(idx, min(2, len(idx)), replace=False):
                link(int(i), int(j), COLLEAGUE)
    for i in range(n):
        if rng.random() < 0.8:
            link(i, int(rng.integers(0, n)), FRIEND)

    # 主角：在指定街区里挑一个成年人，覆写其属性 / protagonists: pick an adult in the named district and override their attributes
    overrides: dict[int, dict] = {}
    cast: dict[str, int] = {}
    venue_by_name = {v.name: v.idx for v in venues}
    district_by_name = {d.name: d.idx for d in districts}
    for spec in scenario.CAST:
        spec = dict(spec)
        pool = [
            i
            for i in np.flatnonzero(district_of == district_by_name[spec.pop("district")])
            if age[i] >= 18 and i not in overrides
        ]
        i = int(rng.choice(pool))
        key = spec.pop("key")
        for name in spec.pop("venues", []):
            if venue_by_name[name] not in member[i]:
                member[i].append(venue_by_name[name])
        for j in rng.choice(n, spec.pop("hub", 0), replace=False):
            link(i, int(j), FRIEND)
        overrides[i] = spec | {"protagonist": True}
        cast[key] = i
    # 场景写明的关系（史料里谁认识谁）/ ties the scenario spells out (who knew whom in the record)
    for a, b, kind in getattr(scenario, "TIES", []):
        ties[(min(cast[a], cast[b]), max(cast[a], cast[b]))] = kind
    keys = list(cast.values())
    for a in keys:
        for b in rng.choice(keys, 2, replace=False):
            link(a, int(b), FRIEND)

    persons = []
    for i in range(n):
        fields = dict(
            idx=i, name=names[i], age=int(age[i]), sex=str(sex[i]), education=int(education[i]),
            income=_r(income[i]), trust_general=_r(trust_general[i]), trust_institution=_r(trust_institution[i]),
            risk_aversion=_r(risk_aversion[i]), conformity=_r(conformity[i]), media_use=_r(media_use[i]),
            depth=int(depth[i]), deposit=float(deposit[i]), stake=_r(stake[i]),
            tenure=round(float(tenure[i]), 1), borrower=bool(borrower[i]), resolve=_r(resolve[i]),
            household=int(household[i]), district=int(district_of[i]),
            workplace=int(workplace[i]) if workplace[i] >= 0 else None,
            venues=sorted(member[i]), pos=(round(float(pos[i, 0]), 1), round(float(pos[i, 1]), 1)),
        )  # fmt: skip
        fields |= overrides.get(i, {})
        # 保险按最终的存款算，主角被覆写过的存款也一样 / insurance follows the final deposit, including a protagonist's overridden one
        if fields["deposit"] > 0:
            fields.setdefault("insured", _r(min(1.0, cap / fields["deposit"])))
        persons.append(Person(**fields))

    return Population(
        synthetic=True,
        note=(
            f"合成人口：年龄结构取自联合国《世界人口展望》（{profile['place']} {profile['year']}），其余属性与特质的分布是占位假设。"
            if profile
            else "合成人口：属性与特质的分布都是占位假设，没有对齐任何数据。"
        ),
        note_en=(
            f"Synthetic population: the age structure follows the UN World Population Prospects ({profile['place']} {profile['year']}); every other distribution is a placeholder assumption."
            if profile
            else "Synthetic population: every distribution is a placeholder assumption, aligned with no data."
        ),
        extent=EXTENT,
        bank=bank,
        cast=cast,
        persons=persons,
        ties=[Tie(a=a, b=b, kind=k, strength=STRENGTH[k]) for (a, b), k in sorted(ties.items())],
        venues=venues,
        districts=districts,
    )


@cache
def _age_table() -> dict:
    return yaml.safe_load((CURATED / "age_structure.yaml").read_text(encoding="utf-8"))


def age_profile(scenario: str) -> dict | None:
    """这个场景的年龄结构；虚构的场景没有。/ The age structure for a scenario; fictional ones have none."""
    return _age_table()["profiles"].get(scenario)


def age_weights(counts: list[int]) -> np.ndarray:
    """把五个年龄组的人数摊成 14 到 79 岁每一岁的权重。
    Spread the five age-group counts into a weight for each single year of age from 14 to 79.

    组内按均匀摊：14 岁取 5–14 岁组的十分之一；65 岁以上整组摊在 65–79 岁上（数据没有更细的分组，这是这里的假设）。
    Counts are spread evenly within a group: age 14 takes a tenth of the 5–14 group, and the whole 65+ group is
    spread over 65–79 (the data has no finer split; that is an assumption made here).
    """
    _, child, youth, adult, old = counts
    w = np.concatenate([[child / 10], np.full(10, youth / 10), np.full(40, adult / 40), np.full(15, old / 15)])
    return w / w.sum()


def ages(raw: np.ndarray, profile: dict | None) -> np.ndarray:
    """把均匀抽出的年龄换成符合年龄结构的年龄；没有年龄结构时原样返回。
    Turn uniformly drawn ages into ages that follow the age structure; without one they are returned unchanged.

    按分位数对应，不另外抽随机数，所以人口里与年龄无关的部分逐项不变。
    The mapping is by quantile and draws no further random numbers, so everything in the population that does not
    depend on age stays exactly as it was.
    """
    if profile is None:
        return raw
    u = (raw - AGE_LO + 0.5) / (AGE_HI - AGE_LO)
    return AGE_LO + np.searchsorted(np.cumsum(age_weights(profile["counts"])), u).clip(0, AGE_HI - AGE_LO - 1)


def _districts(scenario: ModuleType) -> list[District]:
    out = []
    c = EXTENT / 2
    for i, (name, turn) in enumerate(scenario.DISTRICTS):
        if turn is None:
            out.append(District(idx=i, name=name, name_en=names_en.name(scenario.__name__.rsplit(".", 1)[-1], name), pos=(c, c), radius=95))
        else:
            a = 2 * math.pi * turn - math.pi / 2
            out.append(District(idx=i, name=name, name_en=names_en.name(scenario.__name__.rsplit(".", 1)[-1], name),
                                pos=(round(c + 330 * math.cos(a), 1), round(c + 330 * math.sin(a), 1)), radius=110))  # fmt: skip
    return out


def _venues(scenario: ModuleType, districts: list[District]) -> list[Venue]:
    by_name = {d.name: d for d in districts}
    out = []
    for i, (name, kind, district, (dx, dy), hours) in enumerate(scenario.VENUES):
        x, y = by_name[district].pos
        out.append(Venue(idx=i, name=name, name_en=names_en.name(scenario.__name__.rsplit(".", 1)[-1], name), kind=kind, pos=(x + dx, y + dy), hours=hours))
    return out


def _name(rng: np.random.Generator, sex: str) -> str:
    given = GIVEN_F if sex == "f" else GIVEN_M
    s = SURNAMES[int(rng.integers(len(SURNAMES)))]
    a, b = (given[int(k)] for k in rng.integers(len(given), size=2))
    return s + a + (b if b != a and rng.random() < 0.6 else "")


def _r(x: float) -> float:
    return round(float(x), 3)
