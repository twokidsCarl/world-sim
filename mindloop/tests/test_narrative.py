import asyncio

import pytest
from fastapi.testclient import TestClient

from fake_claude_helper import calls, install
from mindloop import export, lexicon, narrative, runner
from mindloop.cases import get_case


@pytest.fixture
def fake(tmp_path, monkeypatch):
    return install(tmp_path, monkeypatch)


@pytest.fixture
def client(fake):
    from mindloop.server import app

    return TestClient(app)


def build(case_id="kongchengji", **kw):
    case, depth, lam, towers, out = export.build(runner.Params(case_id=case_id, **kw))
    return case, towers, out


# ---------- 模板句 ----------


def test_template_lines_signaling(fake):
    case, towers, out = build()
    ta = towers["a"]
    top = narrative.template_line(case, ta, "a", 3, out)
    assert top == "实情是城中无兵：对方见「大开城门抚琴」会退兵 → 我就「大开城门抚琴」"
    l2 = narrative.template_line(case, ta, "a", 2, out)
    assert "城中有伏兵" in l2 and l2.endswith("→ 退兵") and "100%" in l2
    l1 = narrative.template_line(case, ta, "a", 1, out)
    assert "若城中无兵，我就「紧闭城门死守」" in l1 and "若城中有伏兵，我就「大开城门抚琴」" in l1
    l0 = narrative.template_line(case, ta, "a", 0, out)
    assert "照字面" in l0 and "90%" in l0 and l0.endswith("→ 进攻")
    # 同一层在对方的塔里结论相同
    assert narrative.template_line(case, towers["b"], "b", 2, out) == l2


def test_template_lines_simultaneous_give_the_reason(fake):
    case, towers, out = build("poe_even_odd", depth_a=2, depth_b=3)
    assert narrative.template_line(case, towers["a"], "a", 0, out) == "我不多想，凭直觉选「出单」"
    assert narrative.template_line(case, towers["a"], "a", 1, out) == "对方会选「出单」→ 我选「猜单」"
    assert narrative.template_line(case, towers["b"], "b", 3, out) == "对方会选「出双」→ 我选「猜双」"


def test_template_line_every_layer_is_nonempty_and_deterministic(fake):
    for cid in ("kongchengji", "poe_even_odd"):
        for da in range(5):
            case, towers, out = build(cid, depth_a=da, depth_b=da + 1)
            for r in ("a", "b"):
                for j in range(len(towers[r])):
                    line = narrative.template_line(case, towers[r], r, j, out)
                    assert line and line == narrative.template_line(case, towers[r], r, j, out)
                    assert narrative.focus_row(case.game, towers[r][j], out) >= 0


def test_runner_compute_still_works(fake):
    res = runner.compute(runner.Params(case_id="kongchengji"))
    assert all(lv["line"] for r in ("a", "b") for lv in res["towers"][r])


# ---------- 独白 ----------


def test_nesting_path(fake):
    case, towers, out = build()
    assert narrative.nesting_path(case, towers["a"], 3) == "这是【诸葛亮】本人此刻的真实想法"
    assert narrative.nesting_path(case, towers["a"], 1) == "这是【诸葛亮】想象中的【司马懿】想象中的【诸葛亮】的想法"
    assert narrative.nesting_path(case, towers["b"], 0) == "这是【司马懿】想象中的【诸葛亮】想象中的【司马懿】的想法"
    assert narrative.nesting_path(case, towers["a"], 2, "neutral") == "这是【甲】想象中的【乙】的想法"


def test_prompt_contains_path_inner_belief_and_conclusion(fake, monkeypatch):
    monkeypatch.setenv("FAKE_RESULT", "「他素来谨慎，敢开门必有埋伏，退！」")
    case, towers, out = build()
    res = asyncio.run(narrative.monologue(case, towers["a"], "a", 2, out))
    assert res == {"text": "他素来谨慎，敢开门必有埋伏，退！", "source": "claude"}  # 去掉了外层引号
    (call,) = calls(fake)
    prompt = call["stdin"]
    assert "这是【诸葛亮】想象中的【司马懿】的想法" in prompt
    assert case.a.persona in prompt and case.b.goal in prompt
    assert "街亭失守" in prompt
    # 这一层以为内层怎么想（第 1 层的结论，带人名）
    assert "若城中无兵，诸葛亮就「紧闭城门死守」" in prompt
    # 这一层必须得出的结论，含把握程度
    assert "【必须得出的结论】诸葛亮在城中有伏兵时才会「大开城门抚琴」→ 司马懿断定是城中有伏兵（100%）→ 退兵" in prompt
    assert "60" in prompt and "第一人称" in prompt
    assert "--system-prompt" in call["argv"]


def test_prompt_level0_and_owner_top(fake):
    case, towers, out = build()
    _, p0 = narrative.build_prompt(case, towers["a"], "a", 0, out)
    assert "不假思索、按字面" in p0
    _, p3 = narrative.build_prompt(case, towers["a"], "a", 3, out)
    assert "这是【诸葛亮】本人此刻的真实想法" in p3 and "诸葛亮清楚实情：城中无兵" in p3
    assert "实情是城中无兵：司马懿见「大开城门抚琴」会退兵 → 诸葛亮就「大开城门抚琴」" in p3


def test_prompt_neutral_hides_names_and_personas(fake):
    case, towers, out = build()
    _, p = narrative.build_prompt(case, towers["a"], "a", 1, out, "neutral")
    assert "诸葛亮" not in p and "司马懿" not in p and "蜀汉丞相" not in p
    assert "这是【甲】想象中的【乙】想象中的【甲】的想法" in p
    assert "目标：让乙不要攻城" in p


def test_prompt_simultaneous(fake):
    case, towers, out = build("poe_even_odd", depth_a=2, depth_b=3)
    _, p = narrative.build_prompt(case, towers["b"], "b", 2, out)
    assert "这是【猜的男孩】想象中的【藏弹珠的孩子】的想法" in p
    assert "【必须得出的结论】猜的男孩会选「猜单」→ 藏弹珠的孩子选「出双」" in p


def test_monologue_cache_and_regenerate(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "count")
    monkeypatch.setenv("FAKE_RESULT", "独白")
    case, towers, out = build()
    run = lambda **kw: asyncio.run(narrative.monologue(case, towers["b"], "b", 2, out, **kw))
    assert run() == {"text": "独白0", "source": "claude"}
    assert run() == {"text": "独白0", "source": "cache"}
    assert run(regenerate=True) == {"text": "独白1", "source": "claude"}
    assert len(calls(fake)) == 2
    assert run(persona_mode="neutral")["source"] == "claude"  # 换了口吻是另一条提示词


def test_monologue_fallback_when_unavailable(fake, monkeypatch):
    monkeypatch.setenv("MINDLOOP_CLAUDE_BIN", "/nonexistent/claude-xyz")
    case, towers, out = build()
    res = asyncio.run(narrative.monologue(case, towers["a"], "a", 3, out))
    assert res == {"text": narrative.template_line(case, towers["a"], "a", 3, out), "source": "fallback"}
    assert calls(fake) == []


def test_monologue_fallback_when_call_fails(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "always_fail")
    case, towers, out = build()
    res = asyncio.run(narrative.monologue(case, towers["a"], "a", 0, out))
    assert res["source"] == "fallback" and res["text"] == narrative.template_line(case, towers["a"], "a", 0, out)


# ---------- 自写话语 ----------


def test_lexicon_estimate(fake, monkeypatch):
    monkeypatch.setenv("FAKE_STRUCTURED", '{"cost": 0.5, "literal": [1.4, 0.25]}')
    case = get_case("kongchengji")
    res = asyncio.run(lexicon.estimate(case, " 城头遍插旌旗 "))
    assert res == {"text": "城头遍插旌旗", "cost": 0.5, "literal": [1.0, 0.25], "source": "claude"}  # 截到 0..1
    call = calls(fake)[0]
    assert "--json-schema" in call["argv"]
    assert "城头遍插旌旗" in call["stdin"] and "大开城门抚琴" in call["stdin"] and "[0.9, 0.1]" in call["stdin"]
    assert asyncio.run(lexicon.estimate(case, "城头遍插旌旗"))["source"] == "cache"


def test_lexicon_fallbacks(fake, monkeypatch):
    case = get_case("kongchengji")
    monkeypatch.setenv("FAKE_STRUCTURED", '{"cost": 0, "literal": [0.5]}')  # 长度不对
    assert asyncio.run(lexicon.estimate(case, "甲"))["source"] == "fallback"
    monkeypatch.setenv("MINDLOOP_CLAUDE_BIN", "/nonexistent/claude-xyz")
    assert asyncio.run(lexicon.estimate(case, "乙")) == {"text": "乙", "cost": 0.0, "literal": [0.5, 0.5], "source": "fallback"}
    with pytest.raises(ValueError):
        asyncio.run(lexicon.estimate(get_case("poe_even_odd"), "丙"))


# ---------- 服务端点 ----------


def test_health(client, monkeypatch):
    assert client.get("/api/health").json() == {"claude": True}
    monkeypatch.setenv("MINDLOOP_CLAUDE_BIN", "/nonexistent/claude-xyz")
    assert client.get("/api/health").json() == {"claude": False}


def test_monologue_endpoint(client, fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "count")
    monkeypatch.setenv("FAKE_RESULT", "独白")
    body = {"case_id": "kongchengji", "owner": "a", "level": 2}
    assert client.post("/api/monologue", json=body).json() == {"text": "独白0", "source": "claude"}
    assert client.post("/api/monologue", json=body).json() == {"text": "独白0", "source": "cache"}
    assert client.post("/api/monologue", json={**body, "regenerate": True}).json() == {"text": "独白1", "source": "claude"}
    r = client.post("/api/monologue", json={**body, "persona_mode": "neutral"})
    assert r.status_code == 200 and "【甲】" in calls(fake)[-1]["stdin"]


def test_monologue_endpoint_recomputes_tower_from_params(client, fake):
    # 把司马懿塔里的第 1 层（想象中的诸葛亮）钉成「无兵也开门」，第 2 层的结论随之改变
    body = {"case_id": "kongchengji", "owner": "b", "level": 2, "depth_b": 2, "pins": {"b": {"1": {"0": 0, "1": 1}}}}
    assert client.post("/api/monologue", json=body).status_code == 200
    prompt = calls(fake)[-1]["stdin"]
    computed = runner.compute(runner.Params(**{k: v for k, v in body.items() if k not in ("owner", "level")}))
    line = computed["towers"]["b"][2]["line"]
    assert "进攻" in line
    assert line.replace("对方", "诸葛亮").replace("我", "司马懿") in prompt


def test_monologue_endpoint_errors(client, monkeypatch):
    post = lambda **kw: client.post("/api/monologue", json={"case_id": "kongchengji", "owner": "a", "level": 0, **kw})
    assert post(owner="c").status_code == 400
    assert post(level=4).status_code == 400  # 诸葛亮原作想到第 3 层
    assert post(level=-1).status_code == 400
    assert post(level=4, depth_a=4).status_code == 200
    assert post(persona_mode="pirate").status_code == 400
    assert post(case_id="nope").status_code == 404
    monkeypatch.setenv("MINDLOOP_CLAUDE_BIN", "/nonexistent/claude-xyz")
    assert post().json()["source"] == "fallback"


def test_lexicon_endpoint(client, monkeypatch):
    monkeypatch.setenv("FAKE_STRUCTURED", '{"cost": 0, "literal": [0.2, 0.8]}')
    r = client.post("/api/lexicon", json={"case_id": "kongchengji", "text": "城头遍插旌旗"})
    assert r.json() == {"text": "城头遍插旌旗", "cost": 0.0, "literal": [0.2, 0.8], "source": "claude"}
    assert client.post("/api/lexicon", json={"case_id": "kongchengji", "text": "  "}).status_code == 400
    assert client.post("/api/lexicon", json={"case_id": "poe_even_odd", "text": "出单"}).status_code == 400
    assert client.post("/api/lexicon", json={"case_id": "nope", "text": "x"}).status_code == 404


# ---------- 导出 ----------


def test_export_record(fake, monkeypatch):
    monkeypatch.setenv("FAKE_RESULT", "一段独白")
    rec = asyncio.run(export.narrate(runner.Params(case_id="kongchengji")))
    assert rec["case_id"] == "kongchengji" and rec["source"]["work"] == "《三国演义》"
    assert [len(rec["towers"][r]) for r in ("a", "b")] == [4, 3]
    assert all(lv["line"] and lv["monologue"] == "一段独白" for r in ("a", "b") for lv in rec["towers"][r])
    assert rec["outcome"]["choice_b"] == 1
    n = len(calls(fake))
    assert 1 <= n <= 7
    off = asyncio.run(export.narrate(runner.Params(case_id="kongchengji"), use_llm=False))
    assert all(lv["monologue"] == lv["line"] and lv["monologue_source"] == "template" for lv in off["towers"]["a"])
    assert len(calls(fake)) == n
