import json

import numpy as np
import pytest
from typer.testing import CliRunner

from fake_claude_helper import calls, install
from mindloop import bench, recursion, runner


@pytest.fixture
def fake(tmp_path, monkeypatch):
    return install(tmp_path, monkeypatch)


def test_parse_depths():
    assert bench.parse_depths("0..4") == [0, 1, 2, 3, 4]
    assert bench.parse_depths("3,1, 1") == [1, 3]
    with pytest.raises(ValueError):
        bench.parse_depths("-1..2")


def test_generate_items_are_valid_and_match_engine(fake):
    items = bench.generate(range(5))
    assert items and {it["case_id"] for it in items} == {"kongchengji", "poe_even_odd"}
    assert len({it["id"] for it in items}) == len(items)
    assert {it["depth"] for it in items} == {0, 1, 2, 3, 4}
    ladders = {}
    for it in items:
        assert set(it) >= {"id", "case_id", "depth", "role", "question", "options", "answer_index"}
        assert it["role"] in ("a", "b") and len(it["options"]) >= 2
        assert 0 <= it["answer_index"] < len(it["options"])
        if it["case_id"] not in ladders:
            case, _, lam = runner.prepare(runner.Params(case_id=it["case_id"]))
            ladders[it["case_id"]] = recursion.ladder(case.game, 4, lam)
        row = ladders[it["case_id"]][it["role"]][it["depth"]].policy[int(it["id"].rsplit("-r", 1)[1])]
        order = np.argsort(row)[::-1]
        assert order[0] == it["answer_index"]
        assert row[order[0]] - row[order[1]] >= bench.MARGIN  # 标准答案明显领先
        json.dumps(it)  # 可序列化


def test_questions_are_anonymous_and_self_contained(fake):
    for it in bench.generate([0, 2]):
        q = it["question"] + "".join(it["options"])
        for leak in ("诸葛亮", "司马懿", "城", "琴", "弹珠", "男孩", "单", "双"):
            assert leak not in q
        assert "甲" in q and "乙" in q
        assert "第 0 层" in q and "第 k-1 层" in q and "得分" in q
        assert f"第 {it['depth']} 层" in q.split("问题：")[1]
    sig = next(it for it in bench.generate([2]) if it["id"] == "kongchengji-b2-r0")
    assert "字面含义" in sig["question"] and "S1 为 0.9" in sig["question"] and "甲得 -10，乙得 10" in sig["question"]
    assert sig["options"] == ["X1", "X2"] and sig["answer_index"] == 1  # 第 2 层的听者见开门则退
    sim = next(it for it in bench.generate([1]) if it["id"] == "poe_even_odd-b1-r0")
    assert "A1 70%" in sim["question"] and sim["options"] == ["B1", "B2"] and sim["answer_index"] == 0


def test_margin_filter(fake):
    assert len(bench.generate(range(5), margin=0.999999)) < len(bench.generate(range(5), margin=0.0))


def test_run_scoring_with_fake(fake, monkeypatch):
    items = bench.generate(range(5))
    monkeypatch.setenv("FAKE_STRUCTURED", '{"answer_index": 0}')
    res = bench.run(items)
    expect = sum(it["answer_index"] == 0 for it in items)
    assert 0 < expect < len(items)
    assert (res["n"], res["correct"], res["errors"]) == (len(items), expect, 0)
    assert res["accuracy"] == pytest.approx(expect / len(items))
    assert sum(d["n"] for d in res["by_depth"].values()) == len(items)
    for depth, d in res["by_depth"].items():
        mine = [it for it in items if it["depth"] == depth]
        assert d["correct"] == sum(it["answer_index"] == 0 for it in mine)
        assert d["accuracy"] == pytest.approx(d["correct"] / len(mine))
    call = calls(fake)[0]
    assert "--json-schema" in call["argv"] and "answer_index" in call["stdin"] and "0. " in call["stdin"]


def test_run_counts_failures_as_wrong(fake, monkeypatch):
    items = bench.generate([1])
    monkeypatch.setenv("FAKE_MODE", "always_fail")
    res = bench.run(items)
    assert res["correct"] == 0 and res["errors"] == len(items) and res["accuracy"] == 0


def test_cli_generate_and_run(fake, tmp_path, monkeypatch):
    from mindloop.cli import app

    out = tmp_path / "bench.jsonl"
    cli = CliRunner()
    r = cli.invoke(app, ["bench", "generate", "--out", str(out), "--depths", "0..2"])
    assert r.exit_code == 0, r.output
    items = bench.read_jsonl(out)
    assert items and max(it["depth"] for it in items) == 2
    monkeypatch.setenv("FAKE_STRUCTURED", '{"answer_index": 1}')
    r = cli.invoke(app, ["bench", "run", str(out), "--limit", "5"])
    assert r.exit_code == 0, r.output
    correct = sum(it["answer_index"] == 1 for it in items[:5])
    assert f"{correct}/5" in r.output and "第 0层" in r.output
    assert len(calls(fake)) == 5


def test_cli_narrate_and_export(fake, tmp_path, monkeypatch):
    from mindloop.cli import app

    monkeypatch.setenv("FAKE_RESULT", "假独白一句")
    cli = CliRunner()
    r = cli.invoke(app, ["narrate", "kongchengji"])
    assert r.exit_code == 0, r.output
    assert r.output.count("假独白一句") == 7 and "诸葛亮（想到第 3 层）" in r.output
    out = tmp_path / "rec.jsonl"
    r = cli.invoke(app, ["export", "poe_even_odd", "--depth-a", "1", "--depth-b", "2", "--out", str(out), "--no-llm"])
    assert r.exit_code == 0, r.output
    rec = json.loads(out.read_text(encoding="utf-8"))
    assert rec["depth"] == {"a": 1, "b": 2} and rec["towers"]["b"][2]["monologue_source"] == "template"
