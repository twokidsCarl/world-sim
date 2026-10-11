"""校准：把语料里的典型事实变成可计算的指标，看模拟落在不在范围里，并搜索更合的参数。
Calibration: turn the stylised facts in the corpus into computable metrics, check whether the simulation falls inside their ranges, and search for parameters that fit better.

目标很少而参数很多，所以这里得到的只是"与这几条事实不矛盾"的一组参数，不是被验证过的模型。
There are few targets and many parameters, so what comes out is only a parameter set that does not contradict these few facts, not a validated model.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

from . import corpus, mind, trace
from .engine import Result
from .model import BELIEF_CHANNEL, Intervention, Params, Population
from .scenarios import toyokawa as tk

# 搜索范围：只动决定"信不信、取不取、传不传"的几个量。
# bias 的下限不放得更低：再低会落进"人人都信却没人去取"的解，目标对得上，道理却不对。
# Search space. The floor on bias is deliberate: below it the search finds fits where nearly everyone believes and nobody acts.
SPACE: dict[str, tuple[float, float]] = {
    "w_tell": (1.0, 3.5),
    "corroborate": (0.0, 1.5),
    "w_seen": (0.5, 4.0),
    "share": (0.04, 0.25),
    "lam": (4.0, 16.0),
    "bias": (-8.0, -3.0),
    "hazard": (0.05, 0.5),
    "spread": (0.5, 5.0),
}


def _queued_at(result: Result, n: int) -> np.ndarray:
    """每个人第几个小时去排的队；没去的是 -1。/ The tick at which each person joined the queue; -1 if they never did."""
    at = np.full(n, -1)
    for e in result.events:
        if e["k"] == "queue":
            at[e["a"]] = e["t"]
    return at


def runner_share(pop: Population, result: Result) -> float:
    """储户里去取款（或去排了队）的比例。/ Share of depositors who withdrew or joined the queue."""
    depositors = np.array([p.deposit > 0 for p in pop.persons])
    return float((_queued_at(result, len(pop.persons))[depositors] >= 0).mean())


def neighbor_lift(pop: Population, result: Result) -> float:
    """熟人先跑过的储户，自己跑的概率是没有这种熟人的储户的几倍。
    How many times more likely a depositor is to run when an acquaintance ran first, compared with depositors who had no such acquaintance.

    没跑的人按整段时间算"有没有熟人跑过"，所以这个比值偏保守。
    For those who never ran, "an acquaintance ran" is judged over the whole run, so the ratio errs on the low side.
    """
    n = len(pop.persons)
    at = _queued_at(result, n)
    first = np.full(n, np.inf)  # 熟人里最早跑的那个时刻 / when the earliest of their acquaintances ran
    for t in pop.ties:
        for i, j in ((t.a, t.b), (t.b, t.a)):
            if at[j] >= 0:
                first[i] = min(first[i], at[j])
    depositors = np.array([p.deposit > 0 for p in pop.persons])
    ran = at >= 0
    exposed = np.where(ran, first < at, np.isfinite(first))
    a, b = ran[depositors & exposed], ran[depositors & ~exposed]
    if len(a) == 0 or len(b) == 0:
        return float("nan")
    return float(min(99.0, a.mean() / max(b.mean(), 1e-9)))


def correction_residual(pop: Population, result: Result, params: Params, t: int | None = None) -> float:
    """辟谣之后还剩多少：辟谣前已经相信的人，六小时后的平均信念占辟谣前的比例。
    What survives a correction: mean belief six hours later, as a share of before, among those who believed.
    t 缺省取最早的一次干预。/ t defaults to the earliest intervention.
    """
    if not params.interventions:
        return float("nan")
    t = min(iv.t for iv in params.interventions) if t is None else t
    belief = result.frames[:, BELIEF_CHANNEL].astype(float) / 255
    before, after = belief[t - 1], belief[min(t + 6, len(belief) - 1)]
    was = before > 0.5
    return float(after[was].mean() / before[was].mean()) if was.any() else float("nan")


def survived(pop: Population, result: Result) -> float:
    return float(result.failed_at is None)


def sanren_chenghu(params: Params) -> list[float]:
    """三人成虎：一位不轻信的听者，先后从三个同僚口中听到同一件离奇的事，每次之后信了几分。
    Three men make a tiger: a sceptical listener hears the same unlikely story from three colleagues in turn; returns their belief after each telling.

    只用 mind.tell_delta，不跑模拟。听者的设定是这里定的：事前只信 3%，对同僚是寻常的信任。
    Uses only mind.tell_delta, with no simulation run. The listener is defined here: a 3% prior and ordinary trust in colleagues.
    """
    L = float(mind.logit(0.03))
    trust = 0.5 * (0.4 + 0.6 * 0.5)
    out = []
    for others in range(3):
        L += mind.tell_delta(1, 1.0, trust, 0, others, L, 1, params)
        out.append(float(mind.sigmoid(L)))
    return out


def sanren_steps(params: Params) -> float:
    """《战国策》里魏王的三句回答对上了几句：一人言——否；二人言——疑之；三人言——信之。
    How many of the King of Wei's three answers in the Zhanguo Ce are matched: one man says it, no; two, I begin to doubt; three, I believe it.

    "否 / 疑 / 信"与信念数值的对应是这里定的：不到两成、两成到五成、过半。
    The mapping from no / doubt / believe to belief values is set here: under 20%, 20% to 50%, and over half.
    """
    one, two, three = sanren_chenghu(params)
    return float((one < 0.2) + (0.2 <= two < 0.5) + (three >= 0.5))


@dataclass(frozen=True)
class Target:
    """一个校准目标。source 是语料条目，范围优先取自它；定性事实的范围写在这里。
    One calibration target. source is the corpus entry, and the range is taken from it where it gives one; ranges for qualitative facts are set here.
    """

    metric: str
    source: str
    lo: float
    hi: float
    why: str
    why_en: str = ""


def targets() -> list[Target]:
    facts = {f.id: f for f in corpus.load("facts") if f.verified}
    cases = {c.id: c for c in corpus.load("cases") if c.verified}
    out = []
    f = facts.get("bank_run_depositor_share")
    if f and f.range:  # type: ignore[attr-defined]
        out.append(Target("runner_share", f"facts/{f.id}", *f.range, "有储户级数据的挤兑里，去取款的储户所占比例",
                          "In runs with depositor-level data, the share of depositors who withdrew"))  # type: ignore[attr-defined]
    if "bank_run_network_contagion" in facts:
        out.append(Target("neighbor_lift", "facts/bank_run_network_contagion", 1.0, 99.0, "熟人跑了，自己更可能跑",
                          "A depositor is more likely to run once an acquaintance has"))
    if "correction_continued_influence" in facts:
        out.append(Target("correction_residual", "facts/correction_continued_influence", 0.0, 1.0, "辟谣有效，但消不干净",
                          "A correction works but leaves a residue"))
    if {"toyokawa_shinkin_1973", "bea_bank_run_2008"} <= cases.keys():
        out.append(Target("survived", "cases/toyokawa_shinkin_1973, cases/bea_bank_run_2008", 1.0, 1.0,
                          "两家银行都在当局公开担保之后撑住了", "Both banks held once the authorities publicly vouched for them"))  # fmt: skip
    if "toyokawa_shinkin_1973" in cases:
        out.append(Target("toyokawa_like", "cases/toyokawa_shinkin_1973", 0.3, 1.0,
                          "丰川：每十个平行世界里至少有三个像史料那样——第 6 天前后起挤兑、少数人取款、担保后平息、金库不倒（三成的下限是这里定的）",
                          "Toyokawa: at least three in ten parallel worlds resemble the record, with a run starting around day 6, a minority withdrawing, calm after the guarantee and the bank surviving (the three-in-ten floor is set here)"))  # fmt: skip
    if "bea_bank_run_2008" in cases:
        out.append(Target("bea_amount", "cases/bea_bank_run_2008", 0.0, 0.02,
                          "东亚银行：被提走的存款不到总额的 2%（主席事后的说法；银行公布的是 0.67%）。这个案例的结果已经看过，所以拿来校准、不再算检验",
                          "Bank of East Asia: under 2% of deposits withdrawn (the chairman's later account; the bank reported 0.67%). The result of this case has been seen, so it is used for calibration and no longer counts as a test"))  # fmt: skip
    if "sanren_chenghu" in cases:
        out.append(Target("sanren_steps", "cases/sanren_chenghu", 3.0, 3.0, "一人说不信，两人说起疑，三人说就信了",
                          "One man says it and is not believed, two and doubt sets in, three and it is believed"))
    return out


def guarantee(start_hour: int) -> list[Intervention]:
    """校准用的情境：与事实来源一致——钱庄健康，第二个营业日有可信的一方公开担保并当众摆出现银。
    The situation used for calibration, matching the sources behind the facts: the bank is sound, and on the second business day a credible party guarantees it publicly and puts cash on display.
    """
    t = (24 - start_hour) % 24 + 24 + 9
    return [Intervention(t=t, text="官银号告示：通和钱庄银根充足，本号担保照常兑付。现银已运抵柜上。", strength=3.0, reach=0.9, cash=0.5)]


def run_day(pop: Population, result: Result, params: Params) -> float:
    """挤兑从第几天开始：累计去排队的人达到储户的 1% 的那一天（开场当天算第 1 天）。没发生则为 nan。
    The day the run starts: the day on which the people who have joined the queue so far reach 1% of depositors, counting the opening day as day 1. nan if that never happens.
    """
    depositors = sum(p.deposit > 0 for p in pop.persons)
    at = np.sort(_queued_at(result, len(pop.persons)))
    at = at[at >= 0]
    need = max(1, round(0.01 * depositors))
    return float((at[need - 1] + params.start_hour) // 24 + 1) if len(at) >= need else float("nan")


def late_share(result: Result, n: int, after: int) -> float:
    """去排队的人里，有多大比例是在 after 这个时刻之后才去的。没人排队则为 0。
    Share of all runners who joined the queue later than tick `after`; 0 if nobody ran.
    """
    at = _queued_at(result, n)
    at = at[at >= 0]
    return float((at > after).mean()) if len(at) else 0.0


def toyokawa(over: dict[str, float], seed: int, n: int):
    """按史料的回应时间跑一遍丰川场景。/ Run the Toyokawa scenario once with the recorded response times."""
    sc = trace.scenario_module("toyokawa")
    params = Params(scenario="toyokawa", seed=seed, n=n, **(sc.DEFAULTS | over))
    params.interventions = sc.interventions(params.start_hour)
    return params, *trace.run_only(params)


def record_like(over: dict[str, float], seed: int, n: int) -> dict[str, bool]:
    """这一个丰川世界里，史料的几件事各自发生了没有。
    For one Toyokawa world, whether each thing the record says happened did happen.
    """
    params, pop, r = toyokawa(over, seed, n)
    depositors = sum(p.deposit > 0 for p in pop.persons)
    at = _queued_at(r, len(pop.persons))
    at = at[at >= 0]
    before = int((at < tk.GUARANTEE_T).sum())
    day = run_day(pop, r, params)
    return {
        "ran": before >= max(2, round(0.01 * depositors)),  # 担保之前确实有人去挤兑 / a run did start before the guarantee
        "on_day": bool(5 <= day <= 7),  # 第 6 天前后开始 / it began around day 6
        "survived": r.failed_at is None,
        "minority": len(at) <= 0.2 * depositors,  # 去取的是少数 / only a minority ran
        "subsided": late_share(r, len(pop.persons), tk.GUARANTEE_T + 48) <= 0.1,  # 担保两天后平息 / over two days after the guarantee
    }


def toyokawa_like(over: dict[str, float], seeds: list[int], n: int) -> float:
    """多少比例的丰川世界与史料五件事全部相符。史料只是其中一个世界，所以不要求是 1。
    The share of Toyokawa worlds in which all five things match. The record is one world among many, so 1 is not expected.
    """
    return float(np.mean([all(record_like(over, s, n).values()) for s in seeds]))


def bea_amount(over: dict[str, float], seed: int, n: int) -> float:
    """东亚银行场景里被提走的存款占总额的比例；银行倒了算全部。
    Share of all deposits withdrawn in the Bank of East Asia scenario; a failed bank counts as everything.
    """
    sc = trace.scenario_module("bea")
    params = Params(scenario="bea", seed=seed, n=n, **(sc.DEFAULTS | over))
    params.interventions = sc.interventions(params.start_hour)
    pop, r = trace.run_only(params)
    if r.failed_at is not None:
        return 1.0
    return float(sum(e["x"] for e in r.events if e["k"] == "withdraw") / sum(p.deposit for p in pop.persons))


def measure(over: dict[str, float], seed: int, n: int) -> dict[str, float]:
    """一组参数、一个种子下的全部校准指标，都在通和场景加可信担保的情形下量。
    All calibration metrics for one parameter set and one seed, measured on the fictional scenario with a credible guarantee.

    丰川和东亚银行两个场景另外各跑一遍，见 evaluate 和 bea_amount。
    The Toyokawa and Bank of East Asia scenarios are each run separately; see evaluate and bea_amount.
    """
    base = Params(seed=seed, n=n)
    params = base.model_copy(update=over | {"interventions": guarantee(base.start_hour)})
    pop, result = trace.run_only(params)
    return {
        "runner_share": runner_share(pop, result),
        "neighbor_lift": neighbor_lift(pop, result),
        "correction_residual": correction_residual(pop, result, params),
        "survived": survived(pop, result),
        "sanren_steps": sanren_steps(params),
        "bea_amount": bea_amount(over, seed, n),
    }


def miss(value: float, t: Target) -> float:
    """离目标范围有多远，按范围宽度归一；在范围内是 0。量不出来按完全没中算。
    Distance from the target range, normalised by the width of the range; 0 inside it. A metric that cannot be measured counts as a full miss.
    """
    if np.isnan(value):
        return 1.0
    width = max(t.hi - t.lo, 0.05 * max(abs(t.hi), 1.0))
    return max(t.lo - value, value - t.hi, 0.0) / width


def evaluate(over: dict[str, float], seeds: list[int], n: int, ts: list[Target]) -> tuple[float, dict[str, float]]:
    """一组参数在几个种子上的平均表现：(总偏差, 各指标均值)。
    How one parameter set does on average over several seeds: (total miss, mean of each metric).
    """
    runs = [measure(over, seed, n) for seed in seeds]
    like = toyokawa_like(over, seeds, n)
    for r in runs:
        r["toyokawa_like"] = like
    mean = {k: float(np.nanmean([r[k] for r in runs])) if not all(np.isnan(r[k]) for r in runs) else float("nan") for k in runs[0]}
    score = float(np.mean([sum(miss(r[t.metric], t) for t in ts) for r in runs]))
    return score, mean


def search(samples: int, seeds: list[int], n: int, rng_seed: int = 0, log: Callable[[str], None] = print):
    """随机搜索。返回 (目标, 默认参数的结果, 找到的最好参数, 它的结果)。
    Random search. Returns (targets, result for the default parameters, best parameters found, their result).
    """
    ts = targets()
    rng = np.random.default_rng(rng_seed)
    default = evaluate({}, seeds, n, ts)
    best_over: dict[str, float] = {}
    best = default
    for i in range(samples):
        # 前一半在整个范围里撒点，后一半在当前最好的一组附近微调
        # The first half samples the whole space; the second half perturbs the best set found so far
        local = i >= samples // 2 and best_over
        # 只看参数就能判的目标先过一遍筛，省下跑模拟的时间
        # Targets that can be judged from the parameters alone are screened first, which saves simulation runs
        for _ in range(2000):
            over = {
                k: round(float(np.clip(rng.normal(best_over[k], 0.08 * (hi - lo)), lo, hi) if local else rng.uniform(lo, hi)), 3)
                for k, (lo, hi) in SPACE.items()
            }
            if sanren_steps(Params(**over)) == 3:
                break
        got = evaluate(over, seeds, n, ts)
        if got[0] < best[0]:
            best_over, best = over, got
            log(f"  第 {i + 1} 组：偏差 {got[0]:.3f}")
        if best[0] == 0:
            break
    return ts, default, best_over, best
