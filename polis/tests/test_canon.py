"""对照原作与史料的检验本身要靠得住。/ The canonical checks themselves must be sound."""

from __future__ import annotations

import json

import numpy as np

from polis import calibrate as cal
from polis import canon, trace
from polis.cli import CALIBRATION
from polis.model import Params

SAVED = json.loads(CALIBRATION.read_text(encoding="utf-8"))["calibrated"]["params"]


def test_toyokawa_scenario_runs_and_is_reproducible():
    sc = trace.scenario_module("toyokawa")
    p = Params(scenario="toyokawa", n=300, **sc.DEFAULTS)
    (_, a), (_, b) = trace.run_only(p), trace.run_only(p)
    assert a.events == b.events and np.array_equal(a.frames, b.frames)
    assert a.frames.shape[0] == sc.DEFAULTS["ticks"] + 1
    assert a.messages[0].severity == sc.ORIGIN_SEVERITY


def test_toyokawa_cast_comes_from_the_case_file():
    from polis import corpus

    case = next(c for c in corpus.load("cases") if c.id == "toyokawa_shinkin_1973")
    sc = trace.scenario_module("toyokawa")
    # 史料里推动事情的几个人，场景里都得有 / the people who drive the record must exist in the scenario
    for letter in "ADEFHIJ":
        assert any(letter in x.name for x in case.people)
        assert any(letter in c["name"] for c in sc.CAST), letter


def test_idiom_checks_pass_under_saved_calibration_and_are_marked_fitted():
    checks = canon.sanren(Params(**SAVED))
    assert [c.passed for c in checks] == [1, 1, 1] and all(c.fitted for c in checks)


def test_toyokawa_checks_count_worlds_and_are_marked_fitted():
    checks = canon.toyokawa(SAVED, [1, 2], n=300)
    assert len(checks) == 4 and all(c.fitted for c in checks)
    assert all(0 <= c.passed <= c.runs == 2 for c in checks)


def test_bea_is_no_longer_counted_as_a_test():
    checks = canon.bea(SAVED, [1, 2], n=300)
    assert len(checks) == 4 and all(c.fitted for c in checks)
    assert all(0 <= c.passed <= c.runs == 2 for c in checks)


def test_held_out_scenarios_are_frozen_from_verified_cases():
    """只检查设定和标准本身，不运行这些场景。/ Checks the settings and criteria only; the scenarios are not run."""
    from polis import corpus, population

    cases = {c.id: c for c in corpus.load("cases")}
    assert not set(canon.HELD_OUT) & set(canon.SEEN)
    for name in canon.HELD_OUT + canon.SEEN:
        sc = trace.scenario_module(name)
        rec = sc.RECORD
        assert cases[rec["case"]].verified
        assert set(rec) == {"case", "run_days", "amount", "runners"}
        assert 0 < rec["amount"] < 1 and rec["run_days"][0] <= rec["run_days"][1]
        assert isinstance(sc.DEPOSIT_INSURANCE, bool)
        ivs = sc.interventions(sc.DEFAULTS["start_hour"])
        assert any(iv.t == sc.GUARANTEE_T and iv.valence == -1 for iv in ivs)
        assert all(0 <= iv.t < sc.DEFAULTS["ticks"] for iv in ivs)
        pop = population.build(Params(scenario=name, n=300, **sc.DEFAULTS), sc)
        assert {"banker", "witness"} <= pop.cast.keys()
        # 校准的目标里没有它们 / none of them is among the calibration targets
        assert not any(rec["case"] in t.source for t in cal.targets())


def test_judge_applies_the_factor_of_two_band():
    rec = dict(case="x", run_days=(1, 2), amount=0.02, runners=0.10)
    good = canon.judge(rec, True, 2.0, 0.03, 0.06, True)
    assert all(good.values()) and set(good) == {"survived", "on_day", "amount", "calm", "runners"}
    assert not canon.judge(rec, True, 2.0, 0.041, 0.06, True)["amount"]
    assert not canon.judge(rec, True, 2.0, 0.009, 0.06, True)["amount"]
    assert not canon.judge(rec, True, float("nan"), 0.0, 0.0, True)["on_day"]
    assert not canon.judge(rec, True, 3.0, 0.02, 0.21, True)["runners"]
    assert "runners" not in canon.judge(rec | {"runners": None}, True, 1.0, 0.02, 0.5, True)


def test_record_like_reports_each_feature():
    world = cal.record_like(SAVED, 1, 300)
    assert set(world) == {"ran", "on_day", "survived", "minority", "subsided"}
    assert all(isinstance(v, (bool, np.bool_)) for v in world.values())


def test_errand_is_an_unrelated_withdrawal_and_documented_ties_exist():
    sc = trace.scenario_module("toyokawa")
    p = Params(scenario="toyokawa", n=300, **sc.DEFAULTS)
    p.interventions = sc.interventions(p.start_hour)
    pop, r = trace.run_only(p)
    j, i = pop.cast["customer_j"], pop.cast["laundry_i"]
    assert any(e["k"] == "queue" and e["a"] == j and e["t"] == sc.ERRAND_T for e in r.events)
    assert any({t.a, t.b} == {j, i} for t in pop.ties)


def test_run_day_and_late_share():
    _, pop, r = cal.toyokawa({"bias": 3.0, "w_tell": 6.0, "share": 0.5}, 1, 300)  # 话传得快、门槛压低，保证有人去排队 / fast talk and low thresholds, so that people do queue
    p = Params(scenario="toyokawa", start_hour=8)
    queued = cal._queued_at(r, len(pop.persons))
    assert (queued >= 0).any()
    day = cal.run_day(pop, r, p)
    assert day >= 1 and day == (np.sort(queued[queued >= 0])[max(1, round(0.01 * sum(x.deposit > 0 for x in pop.persons))) - 1] + 8) // 24 + 1
    assert cal.late_share(r, len(pop.persons), -1) == 1.0
    assert cal.late_share(r, len(pop.persons), 10**6) == 0.0
