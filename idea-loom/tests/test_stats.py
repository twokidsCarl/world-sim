"""统计：用一份手工构造的会话记录测，不读真的。 / Statistics, tested on hand-built transcripts."""

import json

import pytest
from fastapi.testclient import TestClient

from idea_loom import github, ideas, stats, store, tasks, trail
from idea_loom.server import app

client = TestClient(app)


def line(ts, cwd, *, mid=None, out=0, kind="assistant", content=None, tool=None, side=False):
    message = {"role": kind, "content": content if content is not None else []}
    if mid:
        message |= {"id": mid, "usage": {"input_tokens": 1, "output_tokens": out, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 5}}
    if tool:
        message["content"] = [{"type": "tool_use", "id": tool, "name": "Read", "input": {}}]
    return json.dumps({"type": kind, "timestamp": ts, "cwd": cwd, "message": message, "isSidechain": side}, ensure_ascii=False)


@pytest.fixture
def repo(tmp_path, monkeypatch, seeded):
    root = tmp_path / "repo"
    (root / "strata").mkdir(parents=True)
    (root / "strata" / "README.md").write_text("x")
    monkeypatch.setenv("IDEA_LOOM_REPO", str(root))
    monkeypatch.setenv("IDEA_LOOM_TRANSCRIPTS", str(tmp_path / "claude"))
    monkeypatch.setenv("IDEA_LOOM_RUNS", str(tmp_path / "runs"))
    monkeypatch.setattr(github, "pull_requests", lambda force=False: github.parse([
        {"number": 1, "title": "strata: 加入三维 / add 3D", "state": "MERGED", "createdAt": "2026-10-10T10:00:00Z", "mergedAt": "2026-10-10T10:00:20Z", "additions": 300, "deletions": 5, "url": "u1"},
        {"number": 2, "title": "strata: 修一个错", "state": "MERGED", "createdAt": "2026-10-10T11:00:00Z", "mergedAt": "2026-10-10T11:00:40Z", "additions": 100, "deletions": 50, "url": "u2"},
        {"number": 3, "title": "ideas: 第 5 批", "state": "MERGED", "createdAt": "2026-10-10T12:00:00Z", "mergedAt": "2026-10-10T12:00:10Z", "additions": 9, "deletions": 0, "url": "u3"},
        {"number": 4, "title": "没有前缀的标题", "state": "OPEN", "createdAt": "2026-10-10T12:00:00Z", "mergedAt": None, "additions": 1, "deletions": 0, "url": "u4"},
    ]))
    monkeypatch.setattr(stats, "code_lines", lambda repo, ref="origin/main": {"strata": {"lines": 1000, "files": 4, "by_language": {"TypeScript": 900, "CSS": 100}}})
    slug = stats._slug(root.resolve())
    home = tmp_path / "claude" / slug
    (home / "s1" / "subagents").mkdir(parents=True)
    cwd, sub = str(root.resolve()), str(root.resolve() / "strata")
    (home / "s1.jsonl").write_text("\n".join([
        line("2026-10-10T10:00:00Z", cwd, kind="user", content="我想做个模拟引擎\n第二行"),
        line("2026-10-10T10:00:10Z", sub, mid="m1", out=50),
        line("2026-10-10T10:00:11Z", sub, mid="m1", out=120, tool="t1"),   # 同一条回复的后一块，用量更新 / later block of the same reply
        line("2026-10-10T10:00:12Z", sub, kind="user", content=[{"type": "tool_result", "tool_use_id": "t1", "content": "x"}]),
        line("2026-10-10T10:01:00Z", sub, mid="m2", out=30, tool="t2"),
        line("2026-10-10T10:20:00Z", sub, kind="user", content="继续"),                       # 隔了 19 分钟：停过一次 / a 19-minute gap: one stop
        line("2026-10-10T10:20:30Z", sub, mid="m3", out=200),
        "not json",
    ]) + "\n")
    (home / "s1" / "subagents" / "agent-a.jsonl").write_text(line("2026-10-10T10:00:40Z", cwd, mid="m9", out=1000, side=True) + "\n")
    (home / "s1-copy.jsonl").write_text(line("2026-10-10T10:00:11Z", sub, mid="m1", out=120) + "\n")  # 续接的记录里重复的一条 / a repeat in a resumed transcript
    (home / "s2.jsonl").write_text("\n".join([
        line("2026-10-10T09:00:00Z", cwd, kind="user", content="<command-name>/plan</command-name><command-args>看看这个文件夹</command-args>"),
        line("2026-10-10T09:00:05Z", cwd, mid="m5", out=7),
    ]) + "\n")
    other = tmp_path / "claude" / (slug + "x-unrelated")
    other.mkdir()
    (other / "z.jsonl").write_text(line("2026-10-10T09:00:05Z", cwd, mid="zz", out=99999) + "\n")
    return root


def test_each_reply_is_counted_once_and_assigned_to_a_project(repo):
    s = stats.compute(force=True)
    by = {p.dir: p for p in s.projects}
    assert by["strata"].tokens.output == 120 + 30 + 200 + 1000  # 子代理在根目录跑，随它的会话归到 strata / the subagent ran at the root and follows its session
    assert by[stats.UNASSIGNED].tokens.output == 7
    assert s.totals.output == sum(p.tokens.output for p in s.projects) == 1357
    assert s.totals.messages == 5 and s.totals.cache_read == 50
    assert "ideas" in by and by["ideas"].prs == 1 and by["ideas"].tokens.output == 0


def test_session_run_time_volume_and_stops(repo):
    s = stats.compute(force=True)
    s1 = next(x for x in s.sessions if x.id == "s1")
    assert (s1.project, s1.title, s1.prompts, s1.tool_calls, s1.subagents) == ("strata", "我想做个模拟引擎", 2, 2, 1)
    assert [(g.start[11:19], g.end[11:19], g.seconds, g.output_tokens) for g in s1.segments] == [("10:00:00", "10:01:00", 60.0, 1150), ("10:20:00", "10:20:30", 30.0, 200)]
    assert s1.active_seconds == 90.0
    s2 = next(x for x in s.sessions if x.id == "s2")
    assert (s2.project, s2.title, s2.prompts) == (stats.UNASSIGNED, "看看这个文件夹", 1)
    assert not any(x.id == "z" for x in s.sessions)  # 名字只是前缀相同的别的目录不算 / a directory that merely shares the prefix is not ours


def test_sessions_can_be_assigned_by_hand(repo):
    store.write_json(store.data_dir() / "sessions.json", {"s2": "strata"})
    s = stats.compute(force=True)
    assert not any(p.dir == stats.UNASSIGNED for p in s.projects)
    assert next(p for p in s.projects if p.dir == "strata").tokens.output == 1357


def test_prs_code_and_ratios(repo):
    p = next(x for x in stats.compute(force=True).projects if x.dir == "strata")
    assert (p.prs, p.merged, p.additions, p.deletions, p.median_merge_seconds) == (2, 2, 400, 55, 30.0)
    assert (p.lines, p.files, p.by_language) == (1000, 4, {"TypeScript": 900, "CSS": 100})
    assert p.tokens_per_line == 1.4 and p.tokens_per_pr == 675
    assert github.scope_of("idea-loom: 想法池 / pool") == "idea-loom" and github.scope_of("没有前缀") == ""


def test_attention_from_the_trail(repo):
    ideas.append_events([])
    trail.append([
        trail.Action(at="2026-10-11T08:00:00+07:00", kind="navigate", url="/ideas/1.2", text="1.2 沙堆", idea="1.2"),
        trail.Action(at="2026-10-11T08:01:00+07:00", kind="dwell", url="/ideas/1.2", text="1.2 沙堆", seconds=60, idea="1.2"),
        trail.Action(at="2026-10-11T08:02:00+07:00", kind="dwell", url="/ideas/1.3?x=1", text="1.3", seconds=30, idea="1.3"),
        trail.Action(at="2026-10-11T08:02:30+07:00", kind="dwell", url="/", text="地图", seconds=20),
        trail.Action(at="2026-10-11T08:03:00+07:00", kind="click", url="/", text="按内核"),
        trail.Action(at="2026-10-12T08:03:00+07:00", kind="ask", url="/", text="这一页讲什么"),
    ])
    a = stats.compute(force=True).attention
    assert (a.total_seconds, a.clicks, a.questions, a.days) == (110.0, 1, 1, 2)
    assert a.by_page == {"/ideas": 90.0, "/": 20.0}
    assert [(i.id, i.seconds, i.opens) for i in a.ideas] == [("1.2", 60.0, 1), ("1.3", 30.0, 0)]
    assert a.never_opened == ["1.1", "纵 1"]
    assert a.cells["L1"]["B"] == 60.0 + 15.0 and a.cells["L1"]["A"] == 15.0  # 1.3 在 A、B 两条线上，各算一半 / 1.3 sits on A and B, half each
    assert a.by_level == {"L1": 90.0}


def test_tasks_and_project_links(repo):
    tid = tasks.create(project="strata", title="加入引力", brief="先做二维", idea_id="1.1")
    t = tasks.get(tid)
    assert (t.status_label, t.project, t.idea_id) == ("待开工", "strata", "1.1")
    assert ideas.detail("1.1").status == "building"
    assert "1.1" in next(p for p in ideas.load_projects() if p.dir == "strata").ideas
    tasks.set_status(tid, "merged", note="合并了", pr=7, pr_url="u")
    t = tasks.get(tid)
    assert (t.status, t.pr, t.notes[0].text) == ("merged", 7, "合并了")
    new = tasks.create(project="sandpile", title="沙堆的第一版", idea_id="1.2")
    assert any(p.dir == "sandpile" and p.ideas == ["1.2"] and p.level == "L1" for p in ideas.load_projects())
    assert ideas.detail("1.2").projects == ["sandpile"]
    with pytest.raises(tasks.TaskError):
        tasks.create(project="Bad Name", title="x", idea_id="1.3")
    with pytest.raises(tasks.TaskError):
        tasks.create(project="strata", title=" ")
    assert [x.task_id for x in tasks.listing()][0] in (tid, new)


def test_api(repo):
    r = client.post("/api/tasks", json={"project": "strata", "title": "加入引力", "idea_id": "1.1"})
    assert r.status_code == 200
    tid = r.json()["task_id"]
    assert client.post(f"/api/tasks/{tid}/status", json={"status": "running"}).json()["status_label"] == "进行中"
    assert client.post(f"/api/tasks/{tid}/status", json={"status": "nope"}).status_code == 409
    projects = client.get("/api/projects").json()
    strata = next(p for p in projects if p["dir"] == "strata")
    assert (strata["prs"], strata["merged"], strata["has_readme"], strata["ui_up"]) == (2, 2, True, False)
    assert "1.1" in strata["ideas"] and strata["recent"][0]["number"] == 2
    assert client.post("/api/projects/strata/link", json={"idea_id": "1.3"}).status_code == 200
    assert client.post("/api/projects/strata/link", json={"idea_id": "9.9"}).status_code == 409
    assert client.get("/api/stats?refresh=true").json()["totals"]["output"] == 1357
