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


def test_toyokawa_checks_are_held_out_and_counted_per_seed():
    checks = canon.toyokawa(SAVED, [1, 2], n=300)
    assert len(checks) == 6 and not any(c.fitted for c in checks)
    assert all(0 <= c.passed <= c.runs == 2 for c in checks)


def test_run_day_and_late_share():
    _, pop, r = cal.toyokawa({}, 1, 300)
    p = Params(scenario="toyokawa", start_hour=8)
    queued = cal._queued_at(r, len(pop.persons))
    assert (queued >= 0).any()
    day = cal.run_day(pop, r, p)
    assert day >= 1 and day == (np.sort(queued[queued >= 0])[max(1, round(0.01 * sum(x.deposit > 0 for x in pop.persons))) - 1] + 8) // 24 + 1
    assert cal.late_share(r, len(pop.persons), -1) == 1.0
    assert cal.late_share(r, len(pop.persons), 10**6) == 0.0
