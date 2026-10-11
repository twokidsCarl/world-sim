"""对照原作与史料：案例里写明的事，模拟里有没有发生。

Canonical checks: does the simulation reproduce what the source texts and records say happened.

校准用过的目标、以及结果已经看过并据此改过模型的案例，在这里标为 fitted；其余是 held-out，只有后者算得上检验。
Targets used in calibration, and cases whose results were seen and acted on, are marked fitted; the rest are held out,
and only those count as tests.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import calibrate as cal
from .model import BELIEF_CHANNEL, Params


@dataclass(frozen=True)
class Check:
    case: str
    what: str  # 原作或史料里的说法 / what the source says
    got: str  # 模拟里的结果 / what the simulation produced
    passed: int  # 对上的次数 / runs that matched
    runs: int
    fitted: bool  # 是否被拿去校准过 / whether calibration used it


def sanren(params: Params) -> list[Check]:
    """三人成虎：魏王的三句回答。/ The king's three answers in the Zhanguo Ce passage."""
    one, two, three = cal.sanren_chenghu(params)
    rows = [("一人言市有虎——王曰：否", one, one < 0.2), ("二人言——王曰：寡人疑之矣", two, 0.2 <= two < 0.5), ("三人言——王曰：寡人信之矣", three, three >= 0.5)]
    return [Check("sanren_chenghu", what, f"信 {p:.0%}", int(ok), 1, True) for what, p, ok in rows]


def toyokawa(over: dict[str, float], seeds: list[int], n: int = 1000) -> list[Check]:
    """丰川信用金库：按史料的时间线重演许多个平行世界，数每件事在多少个世界里发生了。
    Toyokawa Shinkin: replay many parallel worlds on the recorded timeline and count in how many each thing happened.

    史料只是其中一个世界。一句玩笑在多数世界里不了了之并不算错；要看的是像史料的世界占多少、
    以及有没有大量世界走向史料里没有发生的结局（金库倒闭）。
    丰川参与了校准（见 calibrate.toyokawa_like）并且影响过模型的改动，所以这里都标为 fitted。
    The record is one world among many. A joke that goes nowhere in most worlds is not an error; what matters is how
    many worlds resemble the record and whether many end in something that did not happen (the bank failing).
    Toyokawa is used in calibration and shaped changes to the model, so every check here is marked fitted.
    """
    worlds = [cal.record_like(over, seed, n) for seed in seeds]
    k = len(seeds)
    count = lambda key: sum(w[key] for w in worlds)  # noqa: E731
    like = sum(all(w.values()) for w in worlds)
    collapsed = k - count("survived")
    quiet = sum(not w["ran"] and w["survived"] for w in worlds)
    case = "toyokawa_shinkin_1973"
    return [
        Check(case, "五件事全部相符：第 6 天前后起挤兑、少数人取款、担保后平息、金库不倒", f"{like}/{k} 个世界", like, k, True),
        Check(case, "金库没有倒闭", f"{count('survived')}/{k} 个世界撑住，{collapsed} 个倒闭", count("survived"), k, True),
        Check(case, "担保之前确实发生了挤兑", f"{count('ran')}/{k} 个世界；另有 {quiet} 个世界里玩笑不了了之", count("ran"), k, True),
        Check(case, "担保两天之后基本没人再去取", f"{count('subsided')}/{k} 个世界", count("subsided"), k, True),
    ]


def bea(over: dict[str, float], seeds: list[int], n: int = 1000) -> list[Check]:
    """东亚银行 2008：曾经是样本外检验，现在不是了。
    Bank of East Asia 2008: once the out-of-sample test, no longer.

    它的设定在第一次运行前定下、没有参与校准；但结果（规模差了两个数量级）已经看过，并且正是这个结果引出了
    对"谁会去取"的重新设计。所以从那以后它标为 fitted，真正的检验见 held_out。
    Its settings were fixed before the first run and it took no part in calibration. But its result (the scale was
    off by two orders of magnitude) has been seen, and that result is what prompted the redesign of who withdraws.
    From then on it is marked fitted; the real tests are in held_out.
    """
    from .scenarios import bea as sc

    survived, day, amount, calm = [], [], [], []
    for seed in seeds:
        params = Params(scenario="bea", seed=seed, n=n, **(sc.DEFAULTS | over))
        params.interventions = sc.interventions(params.start_hour)
        pop, r = cal.trace.run_only(params)
        survived.append(r.failed_at is None)
        day.append(cal.run_day(pop, r, params))
        total = sum(p.deposit for p in pop.persons)
        amount.append(sum(e["x"] for e in r.events if e["k"] == "withdraw") / total)
        calm.append(cal.late_share(r, n, sc.GUARANTEE_T + 48) <= 0.1)
    k = len(seeds)
    days = [d for d in day if not np.isnan(d)]
    case = "bea_bank_run_2008"
    return [
        Check(case, "银行没有倒闭", f"{sum(survived)}/{k} 个世界撑住", sum(survived), k, True),
        Check(case, "周三（第 3 天）出现挤兑；有来源说周二下午已有人去", f"{len(days)}/{k} 个世界发生挤兑" + (f"，平均第 {np.mean(days):.1f} 天" if days else ""),
              sum(2 <= d <= 3 for d in days), k, True),  # fmt: skip
        Check(case, "被提走的存款不到总额的 2%（银行公布 0.67%）", f"平均 {np.mean(amount):.1%}，最多 {max(amount):.1%}", sum(x < 0.02 for x in amount), k, True),
        Check(case, "不到两天平息", f"{sum(calm)}/{k} 个世界", sum(calm), k, True),
    ]


# 第一轮的三起：结果已经看过（挤兑要么不发生、要么太大），并据此决定再改一轮模型，所以不再算检验。
# The first round's three: their results have been seen (a run either did not happen or was far too large) and prompted
# another round of model changes, so they no longer count as tests.
SEEN = ("bac", "swedbank", "kaspi")
# 第二轮的两起：设定和标准在第二轮模型改动之前合并。
# The second round's two: their settings and criteria were merged before the second round of model changes.
HELD_OUT = ("icici", "fib")


def judge(record: dict, survived: bool, day: float, amount: float, runners: float, calm: bool) -> dict[str, bool]:
    """一个世界对不对得上史料。标准在模型改动之前写定：比例要落在史料数字的二分之一到两倍之间。
    Whether one world matches the record. The criteria were fixed before the model was changed: a share must fall
    between half and twice the recorded figure.
    """
    lo, hi = record["run_days"]
    out = {
        "survived": bool(survived),
        "on_day": bool(lo <= day <= hi),  # 没发生挤兑时 day 是 nan，算没对上 / day is nan when no run happened, which counts as a miss
        "amount": bool(record["amount"] / 2 <= amount <= record["amount"] * 2),
        "calm": bool(calm),
    }
    if record["runners"] is not None:
        out["runners"] = bool(record["runners"] / 2 <= runners <= record["runners"] * 2)
    return out


def held_out(scenario: str, over: dict[str, float], seeds: list[int], n: int = 1000) -> list[Check]:
    """样本外检验：场景设定和通过标准（场景模块里的 RECORD）都在模型改动之前合并，之后不改。
    The out-of-sample test: the scenario's settings and its pass criteria (RECORD in the scenario module) were merged
    before the model was changed and are not edited afterwards.

    SEEN 里的案例用同一套标准重跑，但标为 fitted：它们的结果已经影响过模型。
    Cases in SEEN are rerun against the same criteria but marked fitted: their results have already shaped the model.

    "平息"指当局表态两天之后才去排队的人不超过全部挤兑者的一成，与东亚银行的检验同一口径。
    "Calm" means that no more than a tenth of all runners joined the queue later than two days after the
    authorities' statement, the same definition as in the Bank of East Asia check.
    """
    sc = cal.trace.scenario_module(scenario)
    rec = sc.RECORD
    worlds, amounts, shares, days = [], [], [], []
    for seed in seeds:
        params = Params(scenario=scenario, seed=seed, n=n, **(sc.DEFAULTS | over))
        params.interventions = sc.interventions(params.start_hour)
        pop, r = cal.trace.run_only(params)
        total = sum(p.deposit for p in pop.persons)
        amount = sum(e["x"] for e in r.events if e["k"] == "withdraw") / total
        share = cal.runner_share(pop, r)
        day = cal.run_day(pop, r, params)
        calm = cal.late_share(r, n, sc.GUARANTEE_T + 48) <= 0.1
        worlds.append(judge(rec, r.failed_at is None, day, amount, share, calm))
        amounts.append(amount), shares.append(share), days.append(day)
    k = len(seeds)
    count = lambda key: sum(w[key] for w in worlds)  # noqa: E731
    ran = [d for d in days if not np.isnan(d)]
    lo, hi = rec["run_days"]
    when = f"第 {lo} 天" if lo == hi else f"第 {lo}–{hi} 天"
    case = rec["case"]
    fitted = scenario in SEEN
    out = [
        Check(case, "全部相符", f"{sum(all(w.values()) for w in worlds)}/{k} 个世界", sum(all(w.values()) for w in worlds), k, fitted),
        Check(case, "银行没有倒闭", f"{count('survived')}/{k} 个世界撑住", count("survived"), k, fitted),
        Check(case, f"{when}出现挤兑", f"{len(ran)}/{k} 个世界发生挤兑" + (f"，平均第 {np.mean(ran):.1f} 天" if ran else ""), count("on_day"), k, fitted),
        Check(case, f"被提走的存款约为总额的 {rec['amount']:.1%}（要求在一半到两倍之间）", f"平均 {np.mean(amounts):.1%}，最少 {min(amounts):.1%}，最多 {max(amounts):.1%}", count("amount"), k, fitted),
    ]  # fmt: skip
    if rec["runners"] is not None:
        out.append(Check(case, f"去取款的储户约占 {rec['runners']:.0%}（要求在一半到两倍之间）", f"平均 {np.mean(shares):.1%}", count("runners"), k, fitted))
    out.append(Check(case, "当局表态两天后基本没人再去取", f"{count('calm')}/{k} 个世界", count("calm"), k, fitted))
    return out
