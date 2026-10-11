"""主角交给模型时：决定被如实落到世界里，模型答不上来也照样跑完。
Model-played protagonists: decisions are applied faithfully, and a silent model never stops a run.
"""

from __future__ import annotations

import json
import stat

import pytest

from polis import llm, population, trace
from polis.engine import Sim
from polis.model import QUEUEING, WITHDREW, Params
from polis.protagonist import Context, Decision, Director, prompt


class Scripted:
    """按名字给出固定决定的假导演。/ A stand-in director with a fixed decision per character."""

    def __init__(self, by_name: dict[str, Decision | None], default: Decision | None = Decision("再看看。", "wait")):
        self.by_name, self.default, self.seen = by_name, default, []

    def decide(self, contexts: list[Context]):
        self.seen += contexts
        return [self.by_name.get(c.name, self.default) for c in contexts]


def run(director, **over):
    p = Params(n=300, ticks=72, **over)
    sc = trace.scenario_module(p.scenario)
    pop = population.build(p, sc)
    return pop, Sim(pop, p, sc, director).run()


def test_witness_is_asked_and_its_words_enter_the_world():
    d = Scripted({"老周": Decision("这事得说出去。", "tell", "通和连夜把银子运走了！", 1.5)})
    pop, r = run(d)
    said = [m for m in r.messages if m.author == pop.cast["witness"] and m.text == "通和连夜把银子运走了！"]
    assert said and said[0].severity == 1.5 and said[0].parent == 0
    assert any(e["k"] == "tell" and e["m"] == said[0].id for e in r.events)
    assert {"k": "thought", "a": pop.cast["witness"], "x": "这事得说出去。", "via": "llm"}.items() <= next(e for e in r.events if e.get("via") == "llm").items()


def test_withdraw_decision_puts_them_in_the_queue_and_only_models_decide_for_them():
    pop, r = run(Scripted({}, Decision("取出来才安心。", "withdraw")))
    cast = {i for i in pop.cast.values() if pop.persons[i].deposit > 0 and i != pop.cast["banker"]}
    queued = {e["a"] for e in r.events if e["k"] == "queue"}
    aware = {i for i in cast if r.frames[:, 3, i].max() > 0}
    assert aware and aware <= queued
    pop, r = run(Scripted({}))  # 人人都说再看看 / everyone waits
    assert not any(r.frames[:, 3, i].max() in (QUEUEING, WITHDREW) for i in cast)


def test_context_tells_the_model_what_the_character_knows():
    d = Scripted({})
    pop, _ = run(d)
    c = next(c for c in d.seen if c.heard)
    text = prompt(c)
    assert c.name in text and c.heard[-1] in text and "通和钱庄" in text
    student = next(c for c in d.seen if not c.can_withdraw)
    assert "withdraw" not in prompt(student) and "没有存款" in prompt(student)


def test_overnight_decision_to_check_happens_when_the_bank_opens():
    pop, r = run(Scripted({"老周": Decision("天亮去柜上看看。", "verify")}))
    witness = pop.cast["witness"]
    checks = [e["t"] for e in r.events if e["k"] == "verify" and e["a"] == witness]
    # 20 点开场，老周第 1 小时（21 点）被问到；钱庄第 13 小时（9 点）才开门
    # The run opens at 20:00 and the witness is asked at tick 1; the bank first opens at tick 13
    assert checks and checks[0] == 13


def test_silent_model_falls_back_and_run_completes():
    pop, r = run(Scripted({}, None))
    assert len(r.frames) == 73 and not any(e.get("via") == "llm" for e in r.events)


def test_banker_is_never_played_by_the_model():
    d = Scripted({})
    pop, _ = run(d)
    assert pop.persons[pop.cast["banker"]].name not in {c.name for c in d.seen}


@pytest.fixture
def fake_claude(tmp_path, monkeypatch):
    """一个假的 claude 命令：把收到的提示词记下来，回一段固定的结构化输出。
    A fake claude executable that logs its prompt and returns a fixed structured answer.
    """
    log = tmp_path / "calls.log"
    script = tmp_path / "claude"
    answer = {"type": "result", "is_error": False, "result": "", "structured_output": {"thought": "先去看看。", "action": "verify", "say": "", "tone": "照实"}}
    script.write_text(f"#!/bin/sh\ncat >> {log}\necho >> {log}\ncat <<'EOF'\n{json.dumps(answer, ensure_ascii=False)}\nEOF\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("POLIS_CLAUDE_BIN", str(script))
    monkeypatch.setenv("POLIS_CACHE", str(tmp_path / "cache"))
    return log


def context(**over) -> Context:
    base = dict(setting="县城。", bank="通和钱庄", clock="第 2 天 8 点", name="何寡妇", role="浆洗度日", age=55, persona="棺材本全在通和。",
                deposit=260, stake=1.0, risk_aversion=0.95, conformity=0.7, trust_institution=0.5, depth=0, belief=0.4, fear=0.5,
                heard=["阿福（朋友）说：「通和要倒了。」"], queue=12, acquaintances_ran=0.2, can_withdraw=True)  # fmt: skip
    return Context(**(base | over))


def test_director_calls_claude_parses_and_caches(fake_claude):
    d = Director()
    (a,) = d.decide([context()])
    assert (a.action, a.thought, a.tone) == ("verify", "先去看看。", 1.0)
    assert "何寡妇" in fake_claude.read_text(encoding="utf-8")
    (b,) = d.decide([context()])
    assert b == a and (d.calls, d.cached, d.failed) == (2, 1, 0)
    assert fake_claude.read_text(encoding="utf-8").count("【你是谁】") == 1  # 第二次没有再起进程 / second call hit the cache


def test_director_returns_none_when_claude_is_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("POLIS_CLAUDE_BIN", str(tmp_path / "nope"))
    monkeypatch.setenv("POLIS_CACHE", str(tmp_path / "cache"))
    d = Director()
    assert d.decide([context()]) == [None] and d.failed == 1 and not llm.available()


def test_impossible_choice_becomes_waiting(fake_claude, monkeypatch):
    d = Director()
    (a,) = d.decide([context(can_withdraw=False, deposit=0)])
    assert a.action == "verify"
    monkeypatch.setattr(llm, "aask_meta", lambda *a, **k: _answer({"thought": "取！", "action": "withdraw", "say": "", "tone": "重"}))
    (b,) = d.decide([context(can_withdraw=False, deposit=0, name="小满")])
    assert b.action == "wait"


async def _answer(value):
    return value, False
