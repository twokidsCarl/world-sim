"""把 data/raw/ 里下载来的原始数据算成汇总数，写进 data/curated/。原始文件不进 git，汇总数进。
Turn the raw downloads under data/raw/ into aggregates under data/curated/. The raw files stay out of git; the
aggregates go in.

要重新生成，先把两份原始文件下载到下面写的位置，再运行 `uv run polis curate`。
To regenerate, download the two raw files to the places named below and run `uv run polis curate`.
"""

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
import yaml

PROJECT = Path(__file__).resolve().parents[2]
RAW = PROJECT / "data" / "raw"
CURATED = PROJECT / "data" / "curated"

# https://wellcome.org/reports/wellcome-global-monitor-covid-19/2020 的「Full dataset in .csv」，解压后的文件
# The unpacked "Full dataset in .csv" from the Wellcome Global Monitor 2020 page
WELLCOME = RAW / "wellcome2020" / "csv" / "wgm_full_wave2_public_file_final (1)_csv.csv"
# https://barrolee.github.io/BarroLeeDataSet/BLData/BL_v3_MF1564.csv
BARRO_LEE = RAW / "barrolee" / "BL_v3_MF1564.csv"

# 场景 → (Wellcome 里的国家名, Barro–Lee 里的国家名, Barro–Lee 取哪一年)。
# Barro–Lee 每五年一个数，取离事件最近的一年。通和场景是虚构的民国县城：教育取能拿到的最早的中国数字（1950），不取信任。
# Scenario → (country name in Wellcome, country name in Barro–Lee, Barro–Lee year). Barro–Lee is five-yearly, so the
# year nearest the event is used. The Tonghe scenario is a fictional Republican-era county town: its education takes
# the earliest Chinese figure available (1950) and it takes no trust data.
PLACES: dict[str, tuple[str | None, str, int]] = {
    "rumor_run": (None, "China", 1950),
    "toyokawa": ("Japan", "Japan", 1975),
    "bea": ("Hong Kong", "China, Hong Kong Special Administrative Region", 2010),
    "bac": ("Costa Rica", "Costa Rica", 2005),
    "swedbank": ("Latvia", "Latvia", 2010),
    "kaspi": ("Kazakhstan", "Kazakhstan", 2015),
    "icici": ("India", "India", 2005),
    "fib": ("Bulgaria", "Bulgaria", 2015),
}

# 「非常信任 / 有些信任 / 不太信任 / 完全不信任」换成 1、2/3、1/3、0；「不知道 / 拒答」不计
# "A lot / some / not much / not at all" become 1, 2/3, 1/3, 0; "don't know / refused" is left out
SCORE = {"1": 1.0, "2": 2 / 3, "3": 1 / 3, "4": 0.0}
AGE_BANDS = [(15, 29), (30, 49), (50, 200)]
MIN_CELL = 30  # 不到这么多人的格子不单独报数 / cells with fewer respondents are not reported on their own


def education() -> dict:
    rows = {(r["country"], int(r["year"])): r for r in csv.DictReader(BARRO_LEE.open(encoding="utf-8-sig"))}
    out = {}
    for scenario, (_, country, year) in PLACES.items():
        r = rows[(country, year)]
        shares = np.array([float(r[k]) for k in ("lu", "lp", "ls", "lh")])
        out[scenario] = {"place": country, "year": year, "shares": [round(float(x), 4) for x in shares / shares.sum()]}
    return out


def _mean(rows: list[dict], key: str) -> tuple[float, float, int]:
    """加权平均、加权标准差、有效人数。/ Weighted mean, weighted standard deviation, and the number who answered."""
    v = np.array([SCORE[r[key]] for r in rows if r[key] in SCORE])
    w = np.array([float(r["WGT"]) for r in rows if r[key] in SCORE])
    if len(v) == 0:
        return float("nan"), float("nan"), 0
    m = float(np.average(v, weights=w))
    return m, float(np.sqrt(np.average((v - m) ** 2, weights=w))), len(v)


def trust() -> dict:
    by_country: dict[str, list[dict]] = {}
    wanted = {c for c, _, _ in PLACES.values() if c}
    for r in csv.DictReader(WELLCOME.open(encoding="utf-8-sig")):
        if r["COUNTRYNEW"] in wanted:
            by_country.setdefault(r["COUNTRYNEW"], []).append(r)
    out = {}
    for scenario, (country, _, _) in PLACES.items():
        if country is None:
            continue
        rows = by_country[country]
        entry: dict = {"place": country, "year": 2020, "respondents": len(rows)}
        for name, key in (("neighbours", "W5A"), ("government", "W5B")):
            m, sd, n = _mean(rows, key)
            cells = []
            for edu in ("1", "2", "3"):
                line = []
                for lo, hi in AGE_BANDS:
                    cell = [r for r in rows if r["Education"] == edu and r["Age"].strip().isdigit() and lo <= int(r["Age"]) <= hi]
                    cm, _, cn = _mean(cell, key)
                    line.append(round(cm, 3) if cn >= MIN_CELL else None)
                cells.append(line)
            by_edu = []
            for edu in ("1", "2", "3"):
                em, _, en = _mean([r for r in rows if r["Education"] == edu], key)
                by_edu.append(round(em, 3) if en >= MIN_CELL else None)
            entry[name] = {"mean": round(m, 3), "sd": round(sd, 3), "answered": n, "by_education": by_edu, "by_education_and_age": cells}
        out[scenario] = entry
    return out


EDUCATION_HEADER = """\
# 15–64 岁人口按最高学历的构成。只有汇总数。
# Educational attainment of the population aged 15–64. Aggregates only.
#
# 来源 / Source: Robert J. Barro and Jong-Wha Lee, "A New Data Set of Educational Attainment in the World, 1950–2010",
#   Journal of Development Economics 104 (2013): 184–198; 数据集第 3 版 / dataset version 3 (2021 update),
#   https://barrolee.github.io/BarroLeeDataSet/
# 版权归 Barro 与 Lee 所有；这里只引用了六个国家/年份各四个百分比，并注明出处。原始文件不在仓库里。
# Copyright Barro and Lee. Only four percentages for each of six country-years are quoted here, with attribution.
# The raw file is not in the repository.
#
# shares 依次是：没上过学、小学、中学、高等（原表的 lu、lp、ls、lh，归一到 1）。
# shares are, in order: no schooling, primary, secondary, tertiary (lu, lp, ls, lh in the original, rescaled to 1).
# 年份是原表里离事件最近的一年；通和场景是虚构的民国县城，取的是能拿到的最早的中国数字。
# The year is the one in the original nearest the event; Tonghe is a fictional Republican-era county town and takes
# the earliest Chinese figure available.
"""

TRUST_HEADER = """\
# 对邻里和对本国政府的信任，按学历和年龄分组的平均分。只有汇总数，没有个体记录。
# Trust in neighbours and in the national government: mean scores by education and age group. Aggregates only; no
# individual records.
#
# 来源 / Source: Wellcome Global Monitor 2020: Covid-19（Wellcome Trust，由 Gallup 调查 / fieldwork by Gallup），
#   https://wellcome.org/reports/wellcome-global-monitor-covid-19/2020
# 该页面公开提供数据下载，但没有写明数据的许可；2018 年那一轮在 UK Data Service 上标的是 CC BY 4.0。
# 这里只发表由它算出的分组平均数并注明出处，原始文件不在仓库里。
# The page offers the data for public download but states no licence for it; the 2018 wave is marked CC BY 4.0 on
# the UK Data Service. Only group means computed from it are published here, with attribution; the raw file is not in
# the repository.
#
# 题目是「你有多信任……」，答案「非常 / 有些 / 不太 / 完全不」换成 1、2/3、1/3、0，「不知道 / 拒答」不计；用全国权重加权。
# The question is "How much do you trust …"; "a lot / some / not much / not at all" are scored 1, 2/3, 1/3, 0, "don't
# know / refused" is left out, and the national weights are applied.
# by_education 的三项是：小学及以下、中学、高等。by_education_and_age 每行再按 15–29、30–49、50 岁以上分三格；
# 不足 30 人的格子写 null，用的时候退回上一层。
# by_education has three entries: elementary or less, secondary, tertiary. Each row of by_education_and_age splits
# that level into ages 15–29, 30–49 and 50+; a cell with fewer than 30 respondents is null and falls back a level.
# 注意年份：调查是 2020 年做的，而各场景的事件发生在 1973 到 2014 年之间。
# Mind the year: the survey is from 2020, while the scenarios' events took place between 1973 and 2014.
"""


def write() -> list[Path]:
    CURATED.mkdir(parents=True, exist_ok=True)
    out = []
    for name, header, data in (("education", EDUCATION_HEADER, education()), ("trust", TRUST_HEADER, trust())):
        path = CURATED / f"{name}.yaml"
        path.write_text(header + yaml.safe_dump({"profiles": data}, allow_unicode=True, sort_keys=False, width=200), encoding="utf-8")
        out.append(path)
    return out
