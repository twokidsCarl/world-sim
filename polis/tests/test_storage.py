"""记录放在哪里：可写的目录和随项目带着的只读记录。
Where runs live: the writable directory and the read-only runs that ship with the project.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from polis import lab, trace
from polis.model import Intervention, Params

SMALL = dict(n=300, ticks=72)


def test_state_directory_comes_from_the_shared_host(monkeypatch, tmp_path):
    monkeypatch.delenv("POLIS_RUNS", raising=False)
    assert trace.runs_dir() == trace.PROJECT / "runs"
    monkeypatch.setenv("WORLD_SIM_STATE", str(tmp_path))
    assert trace.runs_dir() == tmp_path / "runs"
    monkeypatch.setenv("POLIS_RUNS", str(tmp_path / "mine"))
    assert trace.runs_dir() == tmp_path / "mine"


def test_bundled_runs_are_listed_found_and_never_written_to(monkeypatch, tmp_path):
    shipped, state = tmp_path / "shipped", tmp_path / "state"
    m = trace.simulate(Params(**SMALL), shipped)
    before = sorted(p.name for p in (shipped / m.run_id).iterdir())
    monkeypatch.setenv("POLIS_BUNDLED", str(shipped))
    state.mkdir()

    assert [r.run_id for r in trace.list_runs(state)] == [m.run_id]
    assert trace.find(m.run_id, state) == shipped / m.run_id

    child = lab.branch(state, m.run_id, [Intervention(t=20, kind="insurance", value=0.9)])
    assert trace.find(child.run_id, state) == state / child.run_id
    lab.ensemble(state, m.run_id, k=2)
    assert lab.ensemble_path(state, m.run_id).is_file()
    assert sorted(p.name for p in (shipped / m.run_id).iterdir()) == before
    assert {r.run_id for r in trace.list_runs(state)} == {m.run_id, child.run_id}


def test_find_refuses_names_that_escape_the_directory(tmp_path):
    for bad in ("", "..", "../x", ".hidden", "_ensemble", "a/b"):
        assert trace.find(bad, tmp_path) is None


def test_api_health_and_missing_ensemble(monkeypatch, tmp_path):
    from polis.server import app

    monkeypatch.setenv("POLIS_RUNS", str(tmp_path))
    m = trace.simulate(Params(**SMALL), tmp_path)
    client = TestClient(app)
    assert client.get("/api/health").json() == {"ok": True}
    assert client.get(f"/api/runs/{m.run_id}/ensemble.json").json() is None
    client.post(f"/api/runs/{m.run_id}/ensemble?k=2")
    assert client.get(f"/api/runs/{m.run_id}/ensemble.json").json()["k"] == 2


def test_showcase_runs_use_scenarios_and_responses_that_exist():
    from polis import cli

    for scenario, seed, response in cli.SHOWCASE:
        sc = trace.scenario_module(scenario)
        assert response in cli._responses(sc)


def test_sim_json_cards_point_at_runs_that_exist_after_prepare():
    from polis import cli

    sim = json.loads((trace.PROJECT / "sim.json").read_text(encoding="utf-8"))
    made = {f"{s}-s{seed}-cal" + ("" if r == "notice" else f"-{r}") for s, seed, r in cli.SHOWCASE}
    shipped = {p.name for p in (trace.PROJECT / "samples").iterdir() if p.is_dir()}
    for card in sim["cards"]:
        assert card["title"]["zh"] and card["title"]["en"] and card["hint"]["zh"] and card["hint"]["en"]
        assert card["url"].startswith("/")
        if "run=" in card["url"]:
            run = card["url"].split("run=")[1].split("&")[0]
            assert run in made | shipped, run
