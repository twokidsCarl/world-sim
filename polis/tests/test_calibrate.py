"""校准：指标量的是它说的东西，目标只来自核实过的语料。
Calibration: each metric measures what it claims to, and targets come only from verified corpus entries.
"""

from __future__ import annotations

import math

import numpy as np

from polis import calibrate as cal
from polis import population, trace
from polis.engine import Result, Sim
from polis.model import Params, Series


def run(**over):
    p = Params(n=300, ticks=72, **over)
    sc = trace.scenario_module(p.scenario)
    pop = population.build(p, sc)
    return p, pop, Sim(pop, p, sc).run()


def fake(pop, queued: dict[int, int]) -> Result:
    events = [{"t": t, "k": "queue", "a": i} for i, t in sorted(queued.items(), key=lambda x: x[1])]
    return Result([], events, np.zeros((1, 4, len(pop.persons)), dtype=np.uint8), Series(**{k: [] for k in Series.model_fields}), None)


def test_runner_share_counts_depositors_who_queued():
    _, pop, _ = run()
    depositors = [p.idx for p in pop.persons if p.deposit > 0]
    assert cal.runner_share(pop, fake(pop, {})) == 0
    assert cal.runner_share(pop, fake(pop, {i: 5 for i in depositors[:10]})) == 10 / len(depositors)


def test_neighbor_lift_is_high_when_running_follows_ties():
    _, pop, _ = run()
    deposit = {p.idx: p.deposit > 0 for p in pop.persons}
    a = next(t for t in pop.ties if deposit[t.a] and deposit[t.b])
    # 只有一对熟人先后去排队：跑的人里有人是跟着熟人跑的，没有熟人跑过的人里也有一个跑了
    # Only one pair of acquaintances queue, one after the other: one runner followed an acquaintance, and one person with no acquaintance who had run also ran
    assert cal.neighbor_lift(pop, fake(pop, {a.a: 3, a.b: 9})) > 1


def test_miss_is_zero_inside_the_range_and_grows_outside():
    t = cal.Target("runner_share", "x", 0.03, 0.09, "")
    assert cal.miss(0.05, t) == 0
    assert 0 < cal.miss(0.12, t) < cal.miss(0.30, t)
    assert cal.miss(float("nan"), t) == 1


def test_targets_come_from_verified_corpus_entries():
    ts = {t.metric: t for t in cal.targets()}
    assert (ts["runner_share"].lo, ts["runner_share"].hi) == (0.029, 0.087)
    assert all(t.source for t in ts.values())


def test_correction_residual_needs_a_correction():
    p, pop, r = run()
    assert math.isnan(cal.correction_residual(pop, r, p))
    p, pop, r = run(interventions=cal.guarantee(20))
    assert 0 <= cal.correction_residual(pop, r, p) <= 1.2


def test_saved_calibration_holds_the_fictional_bank_under_a_guarantee():
    import json

    from polis.cli import CALIBRATION

    saved = json.loads(CALIBRATION.read_text(encoding="utf-8"))
    for seed in (1, 2):
        m = cal.measure(saved["calibrated"]["params"], seed, saved["n"])
        assert m["survived"] == 1 and m["sanren_steps"] == 3


def test_nobody_withdraws_when_it_is_not_worth_the_trip():
    from polis import mind

    p = Params()
    calm = mind.withdraw_hazard(0.02, 1.0, 0.0, 0.0, 0.5, 0.5, 0.5, p)
    alarmed = mind.withdraw_hazard(0.9, 1.0, 0.0, 0.5, 0.9, 0.5, 0.5, p)
    assert calm == 0 and alarmed > 0


def test_vague_versions_press_less_than_alarming_ones():
    from polis import mind

    assert mind.urgency(0.6) < mind.urgency(1.0) < mind.urgency(2.0) == 1.0
    assert mind.share_drive(0.5, mind.urgency(0.6), 0.0, 0.5) < mind.share_drive(0.5, mind.urgency(2.0), 0.0, 0.5)
    assert mind.reach(0.1, False) < mind.reach(0.1, True) == 1.0


def test_three_men_make_a_tiger_under_saved_calibration():
    import json

    from polis.cli import CALIBRATION

    params = Params(**json.loads(CALIBRATION.read_text(encoding="utf-8"))["calibrated"]["params"])
    one, two, three = cal.sanren_chenghu(params)
    assert one < 0.2 <= two < 0.5 <= three


def test_same_voice_repeating_counts_less_than_a_new_voice():
    from polis import mind

    p = Params()
    again = mind.tell_delta(1, 1.0, 0.5, repeats=1, others=0, L=-2.0, education=0, p=p)
    another = mind.tell_delta(1, 1.0, 0.5, repeats=0, others=1, L=-2.0, education=0, p=p)
    first = mind.tell_delta(1, 1.0, 0.5, repeats=0, others=0, L=-2.0, education=0, p=p)
    assert again < first < another
