"""校准：把语料里的典型事实变成可计算的指标，看模拟落在不在范围里，并搜索更合的参数。

目标很少而参数很多，所以这里得到的只是"与这几条事实不矛盾"的一组参数，不是被验证过的模型。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

from . import corpus, population, trace
from .engine import Result, Sim
from .model import BELIEF_CHANNEL, Intervention, Params, Population

# 搜索范围：只动决定"信不信、取不取、传不传"的几个量
SPACE: dict[str, tuple[float, float]] = {
    "w_tell": (1.0, 3.5),
    "w_seen": (0.5, 4.0),
    "share": (0.04, 0.25),
    "lam": (4.0, 16.0),
    "bias": (-8.0, -3.0),
    "hazard": (0.05, 0.5),
}


def _queued_at(result: Result, n: int) -> np.ndarray:
    """每个人第几个小时去排的队；没去的是 -1。"""
    at = np.full(n, -1)
    for e in result.events:
        if e["k"] == "queue":
            at[e["a"]] = e["t"]
    return at


def runner_share(pop: Population, result: Result) -> float:
    """储户里去取款（或去排了队）的比例。"""
    depositors = np.array([p.deposit > 0 for p in pop.persons])
    return float((_queued_at(result, len(pop.persons))[depositors] >= 0).mean())


def neighbor_lift(pop: Population, result: Result) -> float:
    """熟人先跑过的储户，自己跑的概率是没有这种熟人的储户的几倍。

    没跑的人按整段时间算"有没有熟人跑过"，所以这个比值偏保守。
    """
    n = len(pop.persons)
    at = _queued_at(result, n)
    first = np.full(n, np.inf)  # 熟人里最早跑的那个时刻
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


def correction_residual(pop: Population, result: Result, params: Params) -> float:
    """辟谣之后还剩多少：辟谣前已经相信的人，六小时后的平均信念占辟谣前的比例。"""
    if not params.interventions:
        return float("nan")
    t = min(iv.t for iv in params.interventions)
    belief = result.frames[:, BELIEF_CHANNEL].astype(float) / 255
    before, after = belief[t - 1], belief[min(t + 6, len(belief) - 1)]
    was = before > 0.5
    return float(after[was].mean() / before[was].mean()) if was.any() else float("nan")


def survived(pop: Population, result: Result) -> float:
    return float(result.failed_at is None)


@dataclass(frozen=True)
class Target:
    """一个校准目标。source 是语料条目，范围优先取自它；定性事实的范围写在这里。"""

    metric: str
    source: str
    lo: float
    hi: float
    why: str


def targets() -> list[Target]:
    facts = {f.id: f for f in corpus.load("facts") if f.verified}
    cases = {c.id: c for c in corpus.load("cases") if c.verified}
    out = []
    f = facts.get("bank_run_depositor_share")
    if f and f.range:  # type: ignore[attr-defined]
        out.append(Target("runner_share", f"facts/{f.id}", *f.range, "有储户级数据的挤兑里，去取款的储户所占比例"))  # type: ignore[attr-defined]
    if "bank_run_network_contagion" in facts:
        out.append(Target("neighbor_lift", "facts/bank_run_network_contagion", 1.0, 99.0, "熟人跑了，自己更可能跑"))
    if "correction_continued_influence" in facts:
        out.append(Target("correction_residual", "facts/correction_continued_influence", 0.0, 1.0, "辟谣有效，但消不干净"))
    if {"toyokawa_shinkin_1973", "bea_bank_run_2008"} <= cases.keys():
        out.append(Target("survived", "cases/toyokawa_shinkin_1973, cases/bea_bank_run_2008", 1.0, 1.0,
                          "两家银行都在当局公开担保之后撑住了"))  # fmt: skip
    return out


def guarantee(start_hour: int) -> list[Intervention]:
    """校准用的情境：与事实来源一致——钱庄健康，第二个营业日有可信的一方公开担保并当众摆出现银。"""
    t = (24 - start_hour) % 24 + 24 + 9
    return [Intervention(t=t, text="官银号告示：通和钱庄银根充足，本号担保照常兑付。现银已运抵柜上。", strength=3.0, reach=0.9)]


def measure(params: Params) -> dict[str, float]:
    sc = trace.scenario_module(params.scenario)
    pop = population.build(params, sc)
    result = Sim(pop, params, sc).run()
    return {
        "runner_share": runner_share(pop, result),
        "neighbor_lift": neighbor_lift(pop, result),
        "correction_residual": correction_residual(pop, result, params),
        "survived": survived(pop, result),
    }


def miss(value: float, t: Target) -> float:
    """离目标范围有多远，按范围宽度归一；在范围内是 0。量不出来按完全没中算。"""
    if np.isnan(value):
        return 1.0
    width = max(t.hi - t.lo, 0.05 * max(abs(t.hi), 1.0))
    return max(t.lo - value, value - t.hi, 0.0) / width


def evaluate(over: dict[str, float], seeds: list[int], n: int, ts: list[Target]) -> tuple[float, dict[str, float]]:
    """一组参数在几个种子上的平均表现：(总偏差, 各指标均值)。"""
    runs = []
    for seed in seeds:
        base = Params(seed=seed, n=n)
        runs.append(measure(base.model_copy(update=over | {"interventions": guarantee(base.start_hour)})))
    mean = {k: float(np.nanmean([r[k] for r in runs])) if not all(np.isnan(r[k]) for r in runs) else float("nan") for k in runs[0]}
    score = float(np.mean([sum(miss(r[t.metric], t) for t in ts) for r in runs]))
    return score, mean


def search(samples: int, seeds: list[int], n: int, rng_seed: int = 0, log: Callable[[str], None] = print):
    """随机搜索。返回 (目标, 默认参数的结果, 找到的最好参数, 它的结果)。"""
    ts = targets()
    rng = np.random.default_rng(rng_seed)
    default = evaluate({}, seeds, n, ts)
    best_over: dict[str, float] = {}
    best = default
    for i in range(samples):
        over = {k: round(float(rng.uniform(lo, hi)), 3) for k, (lo, hi) in SPACE.items()}
        got = evaluate(over, seeds, n, ts)
        if got[0] < best[0]:
            best_over, best = over, got
            log(f"  第 {i + 1} 组：偏差 {got[0]:.3f}")
        if best[0] == 0:
            break
    return ts, default, best_over, best
