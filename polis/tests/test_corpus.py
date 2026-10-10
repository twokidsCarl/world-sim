"""语料的格式约束：出处必须有据可查，引用必须对得上。"""

from __future__ import annotations

import pytest
import yaml

from polis import corpus

SOURCE = dict(work="某书", author="某人", year=1950, url="https://example.org/x", verified=True, checked="出版社页面确认")
THEORY = dict(title="阈值", title_en="Threshold", field="社会学", claim="……", predicts=["……"], sources=[SOURCE])


def write(root, kind, name, data):
    (root / kind).mkdir(parents=True, exist_ok=True)
    (root / kind / f"{name}.yaml").write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")


def test_loads_and_takes_id_from_filename(tmp_path):
    write(tmp_path, "theory", "threshold", THEORY)
    (t,) = corpus.load("theory", tmp_path)
    assert t.id == "threshold" and t.verified


def test_verified_source_needs_url_and_note(tmp_path):
    write(tmp_path, "theory", "threshold", THEORY | {"sources": [SOURCE | {"checked": ""}]})
    with pytest.raises(ValueError, match="verified"):
        corpus.load("theory", tmp_path)


def test_entry_is_unverified_if_any_source_is(tmp_path):
    loose = dict(work="另一本", author="某人", verified=False)
    write(tmp_path, "theory", "threshold", THEORY | {"sources": [SOURCE, loose]})
    assert not corpus.load("theory", tmp_path)[0].verified


def test_an_entry_must_cite_something(tmp_path):
    write(tmp_path, "theory", "threshold", THEORY | {"sources": []})
    with pytest.raises(ValueError):
        corpus.load("theory", tmp_path)


def test_dangling_theory_reference_is_reported(tmp_path):
    write(tmp_path, "theory", "threshold", THEORY)
    fact = dict(title="S 形", statement="……", kind="qualitative", conditions="……", theories=["threshold", "nope"], sources=[SOURCE])
    write(tmp_path, "facts", "s_curve", fact)
    _, problems = corpus.check(tmp_path)
    assert problems == ["facts/s_curve: 引用了不存在的理论卡 nope"]


def test_shipped_corpus_is_well_formed():
    _, problems = corpus.check()
    assert problems == []


def test_api_serves_corpus_and_calibration():
    from fastapi.testclient import TestClient

    from polis.server import app

    client = TestClient(app)
    body = client.get("/api/corpus").json()
    assert {len(body[k]) for k in ("theory", "cases", "facts")} == {12, 7, 10}
    assert all("verified" in e and e["sources"] for kind in body.values() for e in kind)
    cal = client.get("/api/calibration").json()
    assert {t["metric"] for t in cal["targets"]} >= {"runner_share", "survived"}
