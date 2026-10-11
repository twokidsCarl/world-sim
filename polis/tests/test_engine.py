"""引擎的不变量：可复现、守恒、退化情形，以及记录能读回来。
Engine invariants: reproducibility, conservation, degenerate cases, and records that read back.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from polis import population, trace
from polis.engine import Sim
from polis.model import LOST, QUEUEING, WITHDREW, Event, Intervention, Message, Params, Population

SMALL = dict(n=300, ticks=72)


def simulate(**over):
    p = Params(**(SMALL | over))
    sc = trace.scenario_module(p.scenario)
    pop = population.build(p, sc)
    return pop, Sim(pop, p, sc).run()


def test_same_seed_same_bytes(tmp_path):
    p = Params(**SMALL)
    trace.simulate(p, tmp_path / "a")
    trace.simulate(p, tmp_path / "b")
    for name in trace.FILES:
        assert (tmp_path / "a" / "rumor_run-s1" / name).read_bytes() == (tmp_path / "b" / "rumor_run-s1" / name).read_bytes()


def test_different_seed_differs():
    assert simulate(seed=1)[1].events != simulate(seed=2)[1].events


def test_money_is_conserved():
    pop, r = simulate()
    deposit = np.array([x.deposit for x in pop.persons])
    paid = sum(e["x"] for e in r.events if e["k"] == "withdraw")
    assert paid == deposit[r.frames[-1, 3] == WITHDREW].sum()
    assert r.series.reserve[-1] == pytest.approx(0.30 - paid / deposit.sum(), abs=1e-4)
    assert min(r.series.reserve) >= 0


def test_only_depositors_queue():
    pop, r = simulate()
    deposit = np.array([x.deposit for x in pop.persons])
    acted = np.isin(r.frames[:, 3], (QUEUEING, WITHDREW, LOST)).any(axis=0)
    assert not acted[deposit == 0].any()
    assert not acted[pop.cast["banker"]]


def test_nobody_believes_words_that_carry_no_weight():
    _, r = simulate(w_tell=0, w_seen=0)
    assert max(r.series.believers) <= 1  # 只有亲眼看见的更夫 / only the watchman, who saw it himself
    assert r.failed_at is None


def test_silence_means_no_spread():
    _, r = simulate(share=0, venue_share=0, w_seen=0)
    assert not any(e["k"] == "tell" for e in r.events)
    assert r.failed_at is None


def test_eager_talkers_reach_everyone():
    _, r = simulate(share=1.0, stifle=1.0)
    assert r.series.aware[-1] >= 0.95 * SMALL["n"]


def test_intervention_leaves_population_and_past_untouched():
    notice = Intervention(t=30, text="告示", strength=3.0, reach=1.0)
    pop_a, a = simulate()
    pop_b, b = simulate(interventions=[notice])
    assert pop_a == pop_b
    assert np.array_equal(a.frames[:30], b.frames[:30])
    assert not np.array_equal(a.frames[30:], b.frames[30:])
    assert b.frames[30, 0].mean() < a.frames[30, 0].mean()


def test_trace_roundtrip_matches_contract(tmp_path):
    m = trace.simulate(Params(**SMALL), tmp_path)
    run = tmp_path / m.run_id
    frames = trace.load_frames(run)
    assert frames.shape == (m.ticks + 1, 4, m.n)
    events = [Event.model_validate(e) for e in trace.load_events(run)]
    assert len(events) == m.summary.events
    assert [e.t for e in events] == sorted(e.t for e in events)
    pop = Population.model_validate_json((run / "population.json").read_text(encoding="utf-8"))
    assert all(p.idx == i for i, p in enumerate(pop.persons))
    messages = [Message.model_validate(x) for x in json.loads((run / "messages.json").read_text(encoding="utf-8"))]
    assert all(x.parent is None or x.parent < x.id for x in messages)


def test_api_serves_runs(tmp_path, monkeypatch):
    from polis.server import app

    monkeypatch.setenv("POLIS_RUNS", str(tmp_path))
    m = trace.simulate(Params(**SMALL), tmp_path)
    client = TestClient(app)
    assert [r["run_id"] for r in client.get("/api/runs").json()] == [m.run_id]
    assert len(client.get(f"/api/runs/{m.run_id}/frames.bin").content) == (m.ticks + 1) * 4 * m.n
    assert client.get(f"/api/runs/{m.run_id}/secrets.txt").status_code == 404
    assert client.get("/api/runs/nope/manifest.json").status_code == 404
