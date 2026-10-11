import json

import pytest
from fastapi.testclient import TestClient

import fake_claude
from idea_loom import ideas, ops
from idea_loom.server import app

client = TestClient(app)


@pytest.fixture
def log(tmp_path, monkeypatch, seeded):
    return fake_claude.install(tmp_path, monkeypatch)


def reply(monkeypatch, value):
    monkeypatch.setenv("FAKE_STRUCTURED", json.dumps(value, ensure_ascii=False))


def test_prompt_carries_the_style_rules_frame_target_and_existing(log, monkeypatch):
    reply(monkeypatch, {"ideas": [{"title": "一片雪花", "body": "第一行。\n第二行。", "level": "L1", "threads": ["E"], "kernel": "粒子", "why": "补 E"}]})
    ops.generate(ops.Target(level="L1", thread="B", text="要和火有关"), n=2)
    (call,) = fake_claude.calls(log)
    system = call["argv"][call["argv"].index("--system-prompt") + 1]
    assert "不要点名具体的论文" in system and "粒子：很多个点" in system and "L1 层1" in system
    assert "请为想法池写 2 条" in call["stdin"]
    assert "必须在这一层" in call["stdin"] and "必须在这条横线上" in call["stdin"] and "要和火有关" in call["stdin"]
    assert "1.2 沙堆" in call["stdin"] and "1.3 一点火星" in call["stdin"]  # 这一格已有的 / already in the cell
    assert "1.1 往上走一层：" not in call["stdin"].split("作为写法的样子")[0]  # 不在这一格的不算 / not in this cell


def test_generate_makes_open_proposals_and_writes_no_events(log, monkeypatch):
    reply(monkeypatch, {"ideas": [
        {"title": "一片雪花", "body": "六个角。", "level": "L1", "threads": ["E", "Z"], "kernel": "不存在", "why": "补 E"},
        {"title": "", "body": "没有标题的丢掉", "level": "L1", "why": ""},
    ]})
    before = len(ideas.load_events()[0])
    (p,) = ops.generate(ops.Target(level="L1", thread="B"))
    assert (p.kind, p.status, p.level, p.kernel) == ("idea", "open", "L1", None)
    assert p.threads == ["B", "E"]  # 非法的丢掉，要求的补上 / invalid dropped, required added
    assert len(ideas.load_events()[0]) == before
    assert [x.id for x in ops.load()] == [p.id]


def test_accepting_a_generated_idea_creates_it_with_its_origin(log, monkeypatch):
    reply(monkeypatch, {"ideas": [{"title": "一片雪花", "body": "六个角。", "level": "L1", "threads": [], "kernel": "粒子", "why": "w"}]})
    (p,) = ops.generate(ops.Target(like="1.2"))
    done = ops.accept(p.id, title="一片雪花（改过）")
    d = ideas.detail(done.result_id)
    assert (d.id, d.title, d.origin.how, d.kernel) == ("1.4", "一片雪花（改过）", "generate", "粒子")
    assert [(e.kind, e.target) for e in d.edges] == [("inspired_by", "1.2")]
    assert ops.load()[0].status == "accepted"
    with pytest.raises(ops.OpError, match="已经处理过"):
        ops.accept(p.id)


def test_refine_as_new_version_or_as_new_idea(log, monkeypatch):
    reply(monkeypatch, {"rewrites": [
        {"title": "沙堆", "body": "更尖的正文。", "direction": "问题更尖", "why": "原来的问题太泛"},
        {"title": "一次雪崩", "body": "只看一次。", "direction": "缩小", "why": "更小"},
    ]})
    a, b = ops.refine("1.2", hint="往地震上靠")
    assert a.kind == "rewrite" and a.idea_id == "1.2"
    assert "往地震上靠" in fake_claude.calls(log)[0]["stdin"]
    ops.accept(a.id)
    d = ideas.detail("1.2")
    assert d.body == "更尖的正文。" and d.versions == 2 and "问题更尖" in d.history[0].text
    made = ops.accept(b.id, as_new=True)
    child = ideas.detail(made.result_id)
    assert child.id == "1.4" and [(e.kind, e.target) for e in child.edges] == [("refined_from", "1.2")]


def test_fuse_creates_one_and_merges_the_sources(log, monkeypatch):
    reply(monkeypatch, {"title": "火与沙", "body": "两种崩溃。", "level": "L1", "threads": ["B"], "kernel": "阈值与级联", "why": "同一个内核"})
    p = ops.fuse(["1.2", "1.3", "1.2"])
    assert p.sources == ["1.2", "1.3"]
    done = ops.accept(p.id)
    s = ideas.state()
    by_id = {i.id: i for i in s.ideas}
    assert by_id[done.result_id].title == "火与沙"
    assert by_id["1.2"].merged_into == done.result_id and by_id["1.3"].status == "merged"
    assert {(l.source, l.kind) for l in s.links if l.target == done.result_id} >= {("1.2", "fused_from"), ("1.3", "fused_from")}
    with pytest.raises(ops.OpError):
        ops.fuse(["1.1"])
    with pytest.raises(ops.OpError, match="不在池里"):
        ops.fuse(["1.1", "1.2"])


def test_classify_skips_verticals_and_unchanged(log, monkeypatch):
    reply(monkeypatch, {"items": [
        {"id": "1.2", "threads": ["B"], "kernel": "阈值与级联", "why": "攒够了就倒"},
        {"id": "1.3", "threads": ["A", "B"], "kernel": "", "why": "没变"},
        {"id": "8.8", "threads": ["A"], "kernel": "粒子", "why": "不存在的"},
    ]})
    out = ops.classify()
    assert "一杯酒" not in fake_claude.calls(log)[0]["stdin"]
    assert [(p.idea_id, p.kernel) for p in out] == [("1.2", "阈值与级联")]
    ops.accept(out[0].id)
    assert ideas.detail("1.2").kernel == "阈值与级联"


def test_dedupe_only_keeps_pairs_inside_the_group(log, monkeypatch):
    reply(monkeypatch, {"pairs": [{"source": "1.3", "target": "1.2", "why": "都是阈值"}, {"source": "1.3", "target": "9.9", "why": "x"}, {"source": "1.2", "target": "1.2", "why": "x"}]})
    (p,) = ops.dedupe(level="L1")
    assert (p.kind, p.idea_id, p.target) == ("merge", "1.3", "1.2")
    ops.accept(p.id)
    assert ideas.detail("1.3").merged_into == "1.2"
    with pytest.raises(ops.OpError):
        ops.dedupe()


def test_dismiss_changes_nothing_in_the_pool(log, monkeypatch):
    reply(monkeypatch, {"ideas": [{"title": "x", "body": "y", "level": "L1", "why": ""}]})
    (p,) = ops.generate(ops.Target(level="L1"))
    before = len(ideas.load_events()[0])
    assert ops.dismiss(p.id).status == "dismissed"
    assert len(ideas.load_events()[0]) == before


def test_empty_model_answer_is_an_error_not_an_empty_success(log, monkeypatch):
    reply(monkeypatch, {"ideas": []})
    with pytest.raises(ops.OpError, match="再试一次"):
        ops.generate(ops.Target(level="L1"))


def test_api(log, monkeypatch):
    reply(monkeypatch, {"ideas": [{"title": "一片雪花", "body": "六个角。", "level": "L1", "why": "w"}]})
    r = client.post("/api/ops/generate", json={"target": {"level": "L1"}, "n": 1})
    assert r.status_code == 200
    pid = r.json()[0]["id"]
    listing = client.get("/api/proposals").json()
    assert listing["open"] == 1 and listing["model_ready"] is True and listing["proposals"][0]["op_label"] == "生成"
    assert client.post(f"/api/proposals/{pid}/accept", json={}).json()["result_id"] == "1.4"
    assert client.post(f"/api/proposals/{pid}/dismiss").status_code == 409
    monkeypatch.setenv("FAKE_MODE", "always_fail")
    assert client.post("/api/ops/refine", json={"idea_id": "1.1"}).status_code == 502


def test_translate_writes_events_and_marks_stale_after_a_rewrite(log, monkeypatch):
    reply(monkeypatch, {"items": [
        {"id": "1.1", "title_en": "One level up", "body_en": "Following strata: only particles so far."},
        {"id": "1.2", "title_en": "A sandpile", "body_en": "Grain by grain.\nSame kernel as 1.1?"},
        {"id": "1.3", "title_en": "A spark", "body_en": "It burns."},
        {"id": "纵 1", "title_en": "A glass of wine", "body_en": "From molecules to society."},
        {"id": "7.7", "title_en": "Unknown", "body_en": "ignored"},
    ]})
    assert ops.translate() == ["1.1", "1.2", "1.3", "纵 1"]
    assert "id: 1.2\ntitle: 沙堆" in fake_claude.calls(log)[0]["stdin"]
    d = ideas.detail("1.2")
    assert (d.title_en, d.en_stale) == ("A sandpile", False)
    assert ops.untranslated(ideas.current()[0]) == []
    from idea_loom import edits
    edits.edit("1.2", body="改过的正文。")
    assert ideas.detail("1.2").en_stale is True
    assert [i.id for i in ops.untranslated(ideas.current()[0])] == ["1.2"]
    edits.set_english("1.2", title_en="A sandpile", body_en="Rewritten.")
    assert ideas.detail("1.2").en_stale is False


def test_english_render_falls_back_to_chinese_for_untranslated(seeded):
    from idea_loom import edits, render
    edits.set_english("1.1", title_en="One level up", body_en="Following strata.")
    text = render.pool_en(ideas.state())
    assert "**1.1 One level up** (E)\nFollowing strata." in text
    assert "**1.2 沙堆** (B) *(not translated yet)*" in text
