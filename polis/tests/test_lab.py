"""实验台：分叉只改变干预之后的世界；各种干预确实起作用；集成给出分布。
The lab: a branch changes the world only after its intervention; each kind of intervention has an effect; an ensemble yields a distribution.
"""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from polis import lab, trace
from polis.model import Intervention, Params

SMALL = dict(n=300, ticks=72)


@pytest.fixture
def root(tmp_path):
    trace.simulate(Params(**SMALL), tmp_path)
    return tmp_path


def frames(root, run_id):
    return trace.load_frames(root / run_id)


def test_branch_shares_the_past_and_records_its_parent(root):
    m = lab.branch(root, "rumor_run-s1", [Intervention(t=30, text="告示", strength=3, reach=1)])
    assert (m.parent, m.branch_t) == ("rumor_run-s1", 30)
    a, b = frames(root, "rumor_run-s1"), frames(root, m.run_id)
    assert np.array_equal(a[:30], b[:30]) and not np.array_equal(a[30:], b[30:])
    assert trace.load_population(root / m.run_id) == trace.load_population(root / "rumor_run-s1")


def test_branching_a_branch_keeps_earlier_interventions(root):
    one = lab.branch(root, "rumor_run-s1", [Intervention(t=30, text="告示")])
    two = lab.branch(root, one.run_id, [Intervention(t=40, kind="insurance", value=0.9)])
    assert [iv.t for iv in two.params.interventions] == [30, 40]
    assert two.parent == one.run_id and two.run_id != one.run_id
    assert lab.branch(root, one.run_id, [Intervention(t=40, kind="insurance", value=0.9)]).run_id == two.run_id


def test_bad_interventions_are_refused(root):
    for iv in (Intervention(t=0, text="x"), Intervention(t=999, text="x"), Intervention(t=5, kind="silence"), Intervention(t=5, kind="close_venue", target=99)):
        with pytest.raises(ValueError):
            lab.branch(root, "rumor_run-s1", [iv])
    with pytest.raises(ValueError):
        lab.branch(root, "rumor_run-s1", [])


def tells(root, run_id, **match):
    return [e for e in trace.load_events(root / run_id) if e["k"] == "tell" and all(e.get(k) == v for k, v in match.items())]


def test_silenced_person_stops_talking(root):
    witness = trace.load_population(root / "rumor_run-s1").cast["witness"]
    assert tells(root, "rumor_run-s1", a=witness)
    m = lab.branch(root, "rumor_run-s1", [Intervention(t=1, kind="silence", target=witness)])
    assert not tells(root, m.run_id, a=witness)


def test_closed_venue_goes_quiet(root):
    busiest = max(range(7), key=lambda v: len(tells(root, "rumor_run-s1", via=f"venue:{v}")))
    assert tells(root, "rumor_run-s1", via=f"venue:{busiest}")
    m = lab.branch(root, "rumor_run-s1", [Intervention(t=1, kind="close_venue", target=busiest)])
    assert not tells(root, m.run_id, via=f"venue:{busiest}")


def test_convinced_person_speaks_for_the_bank(root):
    pop = trace.load_population(root / "rumor_run-s1")
    i = pop.cast["teahouse"]
    m = lab.branch(root, "rumor_run-s1", [Intervention(t=10, kind="convince", target=i)])
    assert frames(root, m.run_id)[10, 0, i] < 20
    messages = {x["id"]: x for x in __import__("json").loads((root / m.run_id / "messages.json").read_text(encoding="utf-8"))}
    said = [messages[e["m"]]["valence"] for e in tells(root, m.run_id, a=i) if e["t"] > 10]
    assert said and set(said) == {-1}


def test_insurance_means_fewer_people_run(root):
    m = lab.branch(root, "rumor_run-s1", [Intervention(t=1, kind="insurance", value=1.0)])
    base = trace.load_manifest(root / "rumor_run-s1").summary
    assert m.summary.withdrew + m.summary.lost < base.withdrew + base.lost or m.summary.failed_at is None


def test_ensemble_gives_bands_and_is_cached(root):
    e = lab.ensemble(root, "rumor_run-s1", k=4)
    assert e["k"] == 4 and 0 <= e["failed"] <= 4
    band = e["bands"]["withdrew"]
    assert len(band["mid"]) == SMALL["ticks"] + 1
    assert all(lo <= mid <= hi for lo, mid, hi in zip(band["lo"], band["mid"], band["hi"]))
    assert lab.ensemble(root, "rumor_run-s1", k=4) == e


def test_api_branch_and_ensemble(root, monkeypatch):
    from polis.server import app

    monkeypatch.setenv("POLIS_RUNS", str(root))
    client = TestClient(app)
    r = client.post("/api/runs/rumor_run-s1/branch", json={"interventions": [{"t": 20, "kind": "insurance", "value": 0.8}]})
    assert r.status_code == 200 and r.json()["parent"] == "rumor_run-s1"
    assert client.get(f"/api/runs/{r.json()['run_id']}/series.json").status_code == 200
    assert client.post("/api/runs/rumor_run-s1/branch", json={"interventions": []}).status_code == 422
    assert client.post("/api/runs/nope/branch", json={"interventions": []}).status_code == 404
    assert client.post("/api/runs/rumor_run-s1/ensemble?k=3").json()["k"] == 3
    assert client.post("/api/runs/rumor_run-s1/ensemble?k=500").status_code == 422
