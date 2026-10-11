"""对外给 AI Agent 的那一面：sim.json 的 agent 一节，和 compute 对坏输入的回答。
The side offered to outside AI agents: the `agent` section of sim.json, and how compute answers bad input.
"""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mindloop.cases import all_cases
from mindloop.server import app

ROOT = Path(__file__).resolve().parents[1]
AGENT = json.loads((ROOT / "sim.json").read_text(encoding="utf-8"))["agent"]
CAP = AGENT["capabilities"][0]
client = TestClient(app)


def post(**body):
    return client.post("/api/compute", json=body)


def test_example_runs_and_is_small():
    r = client.post(CAP["http"]["path"], json=CAP["example"])
    assert r.status_code == 200
    assert len(r.content) < 1_000_000
    assert r.json() == client.post(CAP["http"]["path"], json=CAP["example"]).json()  # 确定 / deterministic


def test_schema_lists_exactly_the_parameters():
    from mindloop.runner import Params

    assert set(CAP["input"]["properties"]) == set(Params.model_fields)
    assert CAP["input"]["additionalProperties"] is False
    for name, prop in CAP["input"]["properties"].items():
        assert " / " in prop["description"], name  # 中英都有 / both languages


def test_summary_counts_match_the_library():
    cases = all_cases().values()
    runnable = sum(1 for c in cases if c.runnable)
    for text in AGENT["summary"].values():
        assert str(len(cases)) in text and str(runnable) in text
    verified = sum(1 for c in cases if c.source.verified)
    assert str(verified) in AGENT["datasets"][0]["provenance"]["en"]


def test_every_case_has_english_title_and_hook():
    for c in all_cases().values():
        assert c.title_en and c.hook_en, c.id


def test_largest_reply_stays_under_the_limit():
    for c in all_cases().values():
        if c.runnable:
            r = post(case_id=c.id, depth_a=12, depth_b=12)
            assert r.status_code == 200 and len(r.content) < 1_000_000, c.id


@pytest.mark.parametrize(
    "body, status, field",
    [
        ({"case_id": "nope"}, 404, "case_id"),
        ({"case_id": "hongmen"}, 400, "case_id"),
        ({"case_id": "kongchengji", "forced_a": 9}, 400, "forced_a"),
        ({"case_id": "kongchengji", "forced_b": -1}, 400, "forced_b"),
        ({"case_id": "keynes_beauty", "forced_a": 5}, 400, "forced_a"),
        ({"case_id": "kongchengji", "true_state": 5}, 400, "true_state"),
        ({"case_id": "schelling_nyc", "true_state": 0}, 400, "true_state"),
        ({"case_id": "kongchengji", "bias": 0.3}, 400, "bias"),
        ({"case_id": "kongchengji", "lam_a": -3}, 400, "lam_a"),
        ({"case_id": "kongchengji", "pins": {"b": {"1": {"0": 7}}}}, 400, "pins.b.1.0"),
        ({"case_id": "kongchengji", "pins": {"b": {"1": {"5": 0}}}}, 400, "pins.b.1"),
        ({"case_id": "kongchengji", "pins": {"c": {}}}, 400, "pins"),
        ({"case_id": "kongchengji", "pins": {"a": {"x": {"0": 0}}}}, 400, "pins.a"),
        ({"case_id": "kongchengji", "extra_messages": [{"text": "x", "literal": [0.5]}]}, 400, "extra_messages[0].literal"),
        ({"case_id": "kongchengji", "extra_messages": [{"text": "x", "literal": [0, 0]}]}, 400, "extra_messages[0].literal"),
        ({"case_id": "kongchengji", "extra_messages": [{"text": " ", "literal": [1, 0]}]}, 400, "extra_messages[0].text"),
        ({"case_id": "keynes_beauty", "extra_messages": [{"text": "x", "literal": [1]}]}, 400, "extra_messages"),
    ],
)
def test_bad_input_names_the_field_in_both_languages(body, status, field):
    r = post(**body)
    assert r.status_code == status, r.text
    detail = r.json()["detail"]
    assert detail.startswith(field + "："), detail
    assert f" / {field}: " in detail, detail


def test_counterfactual_parameters_still_work():
    assert post(case_id="crawford_sobel", bias=0.2).json()["game"]["quadratic"]["bias"] == 0.2
    assert post(case_id="kongchengji", forced_a=1).json()["outcome"]["choice_a"] == 1
    assert post(case_id="kongchengji", pins={"b": {"1": {"0": 0}, "9": {"0": 0}}}).status_code == 200  # 比塔深的层忽略 / deeper than the tower: ignored
    r = post(case_id="kongchengji", extra_messages=[{"text": "半开城门", "literal": [0.5, 0.5]}], forced_a=2)
    assert r.status_code == 200 and r.json()["outcome"]["choice_a"] == 2
