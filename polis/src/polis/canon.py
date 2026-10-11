"""对照原作与史料：案例里写明的事，模拟里有没有发生。

Canonical checks: does the simulation reproduce what the source texts and records say happened.

校准用过的目标在这里标为 fitted；没用过的是 held-out，只有后者算得上检验。
Targets used in calibration are marked fitted; the rest are held out, and only those count as tests.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import calibrate as cal
from .model import BELIEF_CHANNEL, Params
from .scenarios import toyokawa as tk


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
    """丰川信用金库：按史料的回应时间重演。/ Toyokawa Shinkin replayed with the recorded response times."""
    survived, day, escalated, lingered, share, late = [], [], [], [], [], []
    for seed in seeds:
        params, pop, r = cal.toyokawa(over, seed, n)
        survived.append(r.failed_at is None)
        day.append(cal.run_day(pop, r, params))

        # 越传越重：担保前一天传的话，比头两天传的话说得更重
        # Escalation: what was being said the day before the guarantee is harsher than in the first two days
        severity = {m.id: m.severity for m in r.messages if m.valence == 1}
        said = [(e["t"], severity[e["m"]]) for e in r.events if e["k"] == "tell" and e["m"] in severity]
        early = [s for t, s in said if t <= 48]
        late = [s for t, s in said if tk.GUARANTEE_T - 24 <= t < tk.GUARANTEE_T]
        escalated.append(bool(early and late and np.mean(late) > np.mean(early)))

        # 辟谣之后谣言没有立刻消失：两天后信的人少了，但还有
        # The rumour outlives its correction: two days on, fewer believe it, but some still do
        belief = r.frames[:, BELIEF_CHANNEL] > 127
        before, after = int(belief[tk.GUARANTEE_T - 1].sum()), int(belief[min(tk.GUARANTEE_T + 48, len(belief) - 1)].sum())
        lingered.append(0 < after < before)
        share.append(cal.runner_share(pop, r))
        late.append(cal.late_share(r, n, tk.GUARANTEE_T + 48))

    k = len(seeds)
    days = [d for d in day if not np.isnan(d)]
    case = "toyokawa_shinkin_1973"
    return [
        Check(case, "金库撑到了当局出面，没有倒闭", f"{sum(survived)}/{k} 次撑住", sum(survived), k, False),
        Check(case, "玩笑之后第 6 天才开始挤兑（容差一天）", f"平均第 {np.mean(days):.1f} 天" if days else "没有发生挤兑",
              sum(5 <= d <= 7 for d in days), k, False),  # fmt: skip
        Check(case, "去取款的只是少数储户（按事实库的 3%–9%）", f"平均 {np.mean(share):.0%}", sum(0.029 <= x <= 0.087 for x in share), k, False),
        Check(case, "担保两天之后基本没人再去取", f"{sum(x <= 0.1 for x in late)}/{k} 次平息", sum(x <= 0.1 for x in late), k, False),
        Check(case, "说法从「好像危险」升级到「明天不开门」", f"{sum(escalated)}/{k} 次越传越重", sum(escalated), k, False),
        Check(case, "担保之后仍有人相信金库已经倒了", f"{sum(lingered)}/{k} 次还有人信", sum(lingered), k, False),
    ]
