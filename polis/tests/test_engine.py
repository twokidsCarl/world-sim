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


def test_nobody_withdraws_when_every_threshold_is_out_of_reach():
    # attach 抬高的是有往来的人的门槛；bias 压到极低，等于人人的门槛都够不着
    # attach raises thresholds for people with ties to the bank; a very low bias puts every threshold out of reach
    _, r = simulate(bias=-99.0)
    assert not any(e["k"] == "queue" for e in r.events)
    assert r.failed_at is None


def test_threshold_is_fixed_per_person_and_ties_to_the_bank_raise_it():
    from polis import mind

    p = Params()
    loyal = mind.threshold(0.0, mind.attachment(20, True), p)
    new = mind.threshold(0.0, mind.attachment(0, False), p)
    assert loyal - new == pytest.approx(p.attach)
    args = (0.9, 1.0, 0.5, 0.8, 0.9, 0.8, 0.8, p)
    assert mind.withdraw_hazard(*args, thresh=-99.0) > 0
    assert mind.withdraw_hazard(*args, thresh=99.0) == 0


def test_insurance_shrinks_what_is_withdrawn_and_money_still_adds_up():
    from polis import mind

    assert mind.withdraw_fraction(0.0, 0.2) == 1.0
    assert mind.withdraw_fraction(0.8, 0.0) == pytest.approx(0.2)
    assert mind.withdraw_fraction(0.8, 1.0) == 1.0
    sc = trace.scenario_module("bea")
    # 压低门槛，保证有人去取 / thresholds lowered so that somebody does withdraw
    p = Params(scenario="bea", n=300, bias=3.0, **sc.DEFAULTS)
    p.interventions = sc.interventions(p.start_hour)
    pop = population.build(p, sc)
    deposit = np.array([x.deposit for x in pop.persons])
    insured = np.array([x.insured for x in pop.persons])
    assert (insured[deposit > 0] > 0).all() and 0.02 < (insured[deposit > 0] < 1).mean() < 0.1
    r = Sim(pop, p, sc).run()
    paid = {e["a"]: e["x"] for e in r.events if e["k"] == "withdraw"}
    assert paid and all(0 < x <= deposit[i] + 0.01 for i, x in paid.items())
    assert any(x < deposit[i] - 0.01 for i, x in paid.items())  # 有人只取了一部分 / somebody took only part
    if r.failed_at is None:
        cash = sum(iv.cash for iv in p.interventions)  # 当局运来的现金 / cash brought in by the authorities
        assert r.series.reserve[-1] == pytest.approx(0.30 + cash - sum(paid.values()) / deposit.sum(), abs=1e-3)


def test_institutional_deposits_sit_outside_the_run():
    pop, r = simulate(institutional=0.5)
    deposit = np.array([x.deposit for x in pop.persons])
    paid = sum(e["x"] for e in r.events if e["k"] == "withdraw")
    # 总额翻倍，准备金也翻倍 / the total doubles, and so does the reserve
    assert r.series.reserve[-1] == pytest.approx(0.30 - paid / (2 * deposit.sum()), abs=1e-3) or r.failed_at is not None


def test_new_person_fields_do_not_disturb_the_old_ones():
    pop, _ = simulate()
    x = pop.persons[pop.cast["widow"]]
    assert (x.name, x.deposit, x.stake) == ("何寡妇", 260.0, 1.0)
    assert all(p.tenure == 0 and not p.borrower for p in pop.persons if p.deposit == 0 and not p.protagonist)


def test_age_structure_follows_the_un_figures_where_a_scenario_has_them():
    assert population.age_profile("nowhere") is None
    assert population.age_profile("rumor_run")["place"] == "China"
    raw = np.arange(population.AGE_LO, population.AGE_HI)
    assert np.array_equal(population.ages(raw, None), raw)
    profile = population.age_profile("swedbank")
    assert (profile["place"], profile["year"]) == ("Latvia", 2011)
    w = population.age_weights(profile["counts"])
    assert len(w) == 66 and w.sum() == pytest.approx(1)
    _, child, youth, adult, old = profile["counts"]
    assert w[51:].sum() == pytest.approx(old / (child / 10 + youth + adult + old))  # 65 岁以上 / aged 65 and over
    sc = trace.scenario_module("swedbank")
    pop = population.build(Params(scenario="swedbank", n=3000, **sc.DEFAULTS), sc)
    age = np.array([x.age for x in pop.persons if not x.protagonist])
    assert age.min() >= 14 and age.max() <= 79
    assert (age >= 65).mean() == pytest.approx(w[51:].sum(), abs=0.03)
    assert "Latvia 2011" in pop.note and "Barro–Lee" in pop.note_en and pop.synthetic


def test_education_and_trust_follow_the_curated_aggregates():
    import yaml

    load = lambda name: yaml.safe_load((population.CURATED / f"{name}.yaml").read_text(encoding="utf-8"))["profiles"]  # noqa: E731
    sc = trace.scenario_module("kaspi")
    pop = population.build(Params(scenario="kaspi", n=4000, **sc.DEFAULTS), sc)
    people = [x for x in pop.persons if not x.protagonist]
    shares = load("education")["kaspi"]["shares"]
    assert sum(shares) == pytest.approx(1, abs=1e-3)
    for level, share in enumerate(shares):
        assert np.mean([x.education == level for x in people]) == pytest.approx(share, abs=0.03)
    survey = load("trust")["kaspi"]
    assert np.mean([x.trust_general for x in people]) == pytest.approx(survey["neighbours"]["mean"], abs=0.03)
    assert np.mean([x.trust_institution for x in people]) == pytest.approx(survey["government"]["mean"], abs=0.03)
    # 虚构的通和场景有年龄和学历，没有信任 / the fictional scenario has age and education data but no trust data
    assert "rumor_run" in load("education") and "rumor_run" not in load("trust")
    flat = np.zeros(4)
    assert np.allclose(population.trusting(np.full(4, 0.5), survey["government"], np.array([0, 1, 2, 3]), np.full(4, 40)) - flat,
                       [survey["government"]["by_education"][0], survey["government"]["by_education"][0], survey["government"]["by_education_and_age"][1][1], survey["government"]["by_education_and_age"][2][1]])  # fmt: skip


def test_a_mass_message_makes_those_who_reason_about_others_expect_company():
    from polis import mind

    depth = np.array([0, 1, 2])
    quiet = mind.expectation(0.0, 0.0, depth)
    told = mind.expectation(0.0, 0.0, depth, public=0.3)
    assert np.allclose(quiet, 0) and told[0] == 0  # 0 层的人只数亲眼看见的 / level 0 counts only what it sees
    assert told[1] == pytest.approx(0.3) and told[2] > told[1]
    # 熟人说得更多时，以熟人的为准 / when acquaintances say more, their word wins
    assert mind.expectation(0.0, 1.0, 1, public=0.3) == pytest.approx(0.6)
    text = Intervention(t=5, text="群发", valence=1, strength=1.5, reach=0.5)
    # Kaspi 场景事发前人心不稳（UNEASE = 1）；通和场景是 0，群发消息在那里不带来这种估计
    # The Kaspi scenario is unsettled beforehand (UNEASE = 1); the Tonghe scenario scores 0, where a mass message brings no such estimate
    _, off = simulate(scenario="kaspi", interventions=[text], share=0, venue_share=0)
    _, on = simulate(scenario="kaspi", interventions=[text], share=0, venue_share=0, public=1.0)
    assert np.array_equal(off.frames[:5], on.frames[:5])
    assert on.frames[6, 2].mean() > off.frames[6, 2].mean()  # 第 2 路是"估计别人会去取" / channel 2 is the expectation of others
    _, calm_off = simulate(interventions=[text], share=0, venue_share=0)
    _, calm_on = simulate(interventions=[text], share=0, venue_share=0, public=1.0)
    assert np.array_equal(calm_off.frames, calm_on.frames)


def test_prior_unease_is_counted_from_the_record_and_raises_the_prior():
    from polis.scenarios import context

    assert [context.unease(trace.scenario_module(s)) for s in ("rumor_run", "bea", "kaspi", "fib", "sber")] == [0, 0, 1, 1, 1]
    _, flat = simulate(scenario="kaspi")
    _, raised = simulate(scenario="kaspi", unease=1.0)
    assert raised.frames[0, 0].mean() > flat.frames[0, 0].mean()
    _, a = simulate()
    _, b = simulate(unease=1.0)
    assert np.array_equal(a.frames, b.frames)  # 取值是 0 的场景不受影响 / a scenario scoring 0 is unaffected


def test_authority_scales_how_much_of_a_denial_lands():
    notice = Intervention(t=30, text="告示", strength=3.0, reach=1.0)
    _, none = simulate()
    _, full = simulate(interventions=[notice])
    _, half = simulate(interventions=[notice], authority=0.5)
    _, mute = simulate(interventions=[notice], authority=0.0)
    belief = lambda r: r.frames[30, 0].mean()  # noqa: E731
    assert belief(full) < belief(half) < belief(mute) == belief(none)


def test_a_closed_bank_pays_nothing_until_it_reopens():
    shut = Intervention(t=1, kind="close_venue", target=0, duration=40)
    pop, r = simulate(interventions=[shut], bias=3.0, w_tell=6.0, share=0.5)
    assert pop.venues[0].kind == "bank"
    paid = [e["t"] for e in r.events if e["k"] == "withdraw"]
    assert any(e["k"] == "queue" and e["t"] < 41 for e in r.events)  # 关着门也有人来排队 / people queue even while it is shut
    assert paid and min(paid) >= 41


def test_api_runs_a_bounded_simulation_and_explains_bad_input():
    from polis.server import app

    client = TestClient(app)
    body = {"scenario": "rumor_run", "seed": 7, "n": 300, "response": "none"}
    a = client.post("/api/simulate", json=body).json()
    assert a == client.post("/api/simulate", json=body).json()  # 同样的输入，同样的输出 / same input, same output
    assert a["input"]["calibrated"] and len(a["by_day"]) == a["ticks"] // 24 and a["record"] is None
    assert 0 <= a["withdrawn_share"] <= 1 and "zh" in a["caveat"]
    assert client.post("/api/simulate", json={"scenario": "kaspi", "n": 300}).json()["record"]["case"] == "kaspi_bank_2014"
    for bad, field in (({"scenario": "nope"}, "scenario"), ({"n": 5}, "n"), ({"llm": True}, "llm")):
        r = client.post("/api/simulate", json=bad)
        assert r.status_code == 422 and r.json()["detail"][0]["loc"][-1] == field
