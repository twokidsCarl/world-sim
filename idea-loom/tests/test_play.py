"""统一入口：在临时仓库里用一个极小的假项目测。 / The single entry point, tested with a tiny fake project in a throwaway repository."""

import json
import subprocess
import sys
import time

import pytest
from fastapi.testclient import TestClient

from idea_loom import store
from idea_loom.play import host, manifest, snapshot, supervisor
from idea_loom.server import app

BACKEND = '''
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        self._send({"path": self.path, "state": os.environ.get("WORLD_SIM_STATE", ""), "extra": os.environ.get("EXTRA", "")})
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        self._send({"echo": self.rfile.read(n).decode(), "origin": self.headers.get("origin")})

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
'''


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def commit(repo, message="x"):
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message)
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")


@pytest.fixture
def repo(tmp_path, monkeypatch, seeded):
    root = tmp_path / "repo"
    data = root / "idea-loom" / "data"
    (data / "play").mkdir(parents=True)
    for f in seeded.iterdir():
        if f.is_file():
            (data / f.name).write_bytes(f.read_bytes())
    demo = root / "demo"
    (demo / "site" / "assets").mkdir(parents=True)
    (demo / "site" / "template.html").write_text("<!doctype html><title>demo</title><p>版本一</p>")
    (demo / "site" / "assets" / "app.js").write_text("console.log(1)")
    (demo / "server.py").write_text(BACKEND)
    (demo / "sim.json").write_text(json.dumps({
        "title": {"zh": "演示", "en": "Demo"}, "level": "L1",
        "web": {"dir": "site", "build": [["sh", "-c", "mkdir -p out/assets && cp template.html out/index.html && cp assets/app.js out/assets/app.js"]], "dist": "out"},
        "api": {"run": [sys.executable, "server.py", "{port}"], "health": "/api/health", "env": {"EXTRA": "{repo}|{port}"}},
        "cards": [{"id": "one", "title": {"zh": "第一张", "en": "First"}, "idea": "1.2", "url": "/?scenario=one"},
                  {"id": "two", "title": {"zh": "第二张"}, "idea": "9.9", "url": "/#two"}],
    }, ensure_ascii=False))
    (data / "play" / "flat.json").write_text(json.dumps({"title": {"zh": "静态的"}, "static": {"dir": "."}, "cards": []}, ensure_ascii=False))
    (root / "flat").mkdir()
    (root / "flat" / "index.html").write_text("<p>flat</p>")
    (root / ".gitignore").write_text("runs/\n")
    git(root, "init", "-q", "-b", "main")
    commit(root, "init")
    monkeypatch.setenv("IDEA_LOOM_DATA", str(data))
    monkeypatch.setenv("IDEA_LOOM_REPO", str(root))
    monkeypatch.setenv("IDEA_LOOM_RUNS", str(tmp_path / "runs"))
    monkeypatch.setattr(snapshot, "fetch", lambda max_age=60.0: None)
    # 构建同步跑，测试才确定。 / Build in-process so the tests are deterministic.
    real_ensure = snapshot.ensure

    def ensure(name, force=False):
        state = snapshot.status(name)
        current = snapshot.version(name)
        if current and (force or state.status in ("missing",) or state.version != current):
            return snapshot.build(name)
        return state

    monkeypatch.setattr(snapshot, "ensure", ensure)
    yield root
    for name in ("demo", "flat"):
        supervisor.stop(name)
    _ = real_ensure


def get(path, sim=None, **kw):
    client = TestClient(app, base_url=f"http://{sim}.localhost:8767" if sim else "http://localhost:8767")
    return client.get(path, **kw)


def test_host_names():
    assert host.sim_name("strata.localhost:8767") == "strata"
    assert host.sim_name("localhost:8767") is None and host.sim_name("127.0.0.1:8767") is None
    assert host.sim_name("Bad_Name.localhost") is None and host.sim_name("a.b.localhost") is None
    assert host.origin_allowed(None) and host.origin_allowed("http://localhost:5187") and host.origin_allowed("http://127.0.0.1:8767")
    assert not host.origin_allowed("http://strata.localhost:8767") and not host.origin_allowed("https://example.com")


def test_manifest_from_project_and_interim_and_validation(repo):
    sims, problems = manifest.load_all()
    assert [(s.name, s.source, len(s.cards)) for s in sims] == [("demo", "project", 2), ("flat", "interim", 0)] and problems == []
    for bad, why in [({"title": {"zh": "x"}}, "有且只有一个"), ({"title": {"zh": "x"}, "static": {"dir": "../up"}}, "相对路径"),
                     ({"title": {"zh": "x"}, "static": {"dir": "."}, "api": {"run": ["x"]}}, "{port}"),
                     ({"title": {"zh": "x"}, "static": {"dir": "."}, "cards": [{"id": "a", "title": {"zh": "a"}}, {"id": "a", "title": {"zh": "b"}}]}, "重复")]:
        with pytest.raises(ValueError, match=why):
            manifest.Sim.model_validate({**bad, "name": "x1"})
    (store.data_dir() / "play" / "broken.json").write_text("{not json")
    sims, problems = manifest.load_all()
    assert [p.name for p in problems] == ["broken"] and len(sims) == 2


def test_snapshot_builds_from_main_not_from_the_working_tree(repo):
    (repo / "demo" / "site" / "template.html").write_text("<p>工作目录里没提交的改动</p>")
    state = snapshot.ensure("demo")
    assert state.status == "ready" and state.version == snapshot.version("demo")
    page = get("/", sim="demo")
    assert page.status_code == 200 and "版本一" in page.text and "没提交" not in page.text
    assert get("/assets/app.js", sim="demo").text == "console.log(1)"
    assert get("/some/client/route", sim="demo").text == page.text  # 前端自己的路由 / a client-side route
    assert get("/assets/missing.js", sim="demo").status_code == 404
    assert get("/../../etc/passwd", sim="demo").status_code in (404, 200) and "root:" not in get("/..%2f..%2fetc/passwd", sim="demo").text


def test_rebuild_only_when_the_version_on_main_changes(repo):
    first = snapshot.ensure("demo")
    assert snapshot.ensure("demo").built_at == first.built_at
    (repo / "demo" / "site" / "template.html").write_text("<p>版本二</p>")
    commit(repo, "v2")
    assert snapshot.status("demo").stale is True
    second = snapshot.ensure("demo")
    assert second.version != first.version and "版本二" in get("/", sim="demo").text
    assert len(list(snapshot.base("demo").glob("src-*"))) == 1  # 旧的快照清掉了 / the old snapshot is gone


def test_failed_build_shows_its_log_in_place_of_the_simulation(repo):
    raw = json.loads((repo / "demo" / "sim.json").read_text())
    raw["web"]["build"] = [["sh", "-c", "echo 编译错误：第 3 行; exit 1"]]
    (repo / "demo" / "sim.json").write_text(json.dumps(raw, ensure_ascii=False))
    commit(repo, "break")
    page = get("/", sim="demo")
    assert page.status_code == 500 and "构建失败" in page.text and "编译错误：第 3 行" in page.text
    assert get("/api/x", sim="demo").status_code == 503
    assert get("/", sim="nope").status_code == 404


def test_a_broken_new_version_keeps_the_last_good_build_in_use(repo):
    good = snapshot.ensure("demo")
    raw = json.loads((repo / "demo" / "sim.json").read_text())
    raw["web"]["build"] = [["sh", "-c", "exit 1"]]
    (repo / "demo" / "sim.json").write_text(json.dumps(raw, ensure_ascii=False))
    commit(repo, "break")
    page = get("/", sim="demo")
    assert page.status_code == 200 and "版本一" in page.text
    state = snapshot.status("demo")
    assert (state.status, state.serving) == ("failed", good.version)
    assert get("/api/hello", sim="demo").status_code == 200
    demo = next(s for s in get("/api/play").json()["sims"] if s["name"] == "demo")
    assert (demo["status"], demo["playable"]) == ("failed", True)


def test_backend_is_started_on_demand_and_proxied(repo):
    assert supervisor.running("demo") is None
    r = get("/api/hello?x=1", sim="demo")
    assert r.status_code == 200
    body = r.json()
    assert body["path"] == "/api/hello?x=1" and body["state"].endswith("play/demo/state") and body["extra"].startswith(str(repo) + "|")
    first = supervisor.running("demo")
    assert first is not None
    client = TestClient(app, base_url="http://demo.localhost:8767")
    assert client.post("/api/echo", content="你好").json()["echo"] == "你好"
    assert supervisor.running("demo")["pid"] == first["pid"]  # 复用同一个进程 / the same process is reused
    assert supervisor.reap_idle(now=time.time() + supervisor.IDLE_SECONDS + 5) == ["demo"]
    assert supervisor.running("demo") is None
    assert client.post("/", content="x").status_code == 405


def test_idea_loom_api_refuses_requests_from_simulation_origins(repo):
    assert get("/api/health").status_code == 200
    assert get("/api/health", headers={"origin": "http://localhost:5187"}).status_code == 200
    blocked = get("/api/health", headers={"origin": "http://demo.localhost:8767"})
    assert blocked.status_code == 403 and "只接受" in blocked.json()["detail"]
    client = TestClient(app, base_url="http://localhost:8767")
    assert client.post("/api/jobs/x/approve", json={}, headers={"origin": "http://demo.localhost:8767"}).status_code == 403


def test_play_listing(repo):
    view = get("/api/play").json()
    demo = next(s for s in view["sims"] if s["name"] == "demo")
    assert (demo["origin"], demo["status"], demo["source"], demo["has_api"], demo["cards"]) == ("http://demo.localhost:8767", "ready", "project", True, 2)
    cards = {c["key"]: c for c in view["cards"]}
    assert cards["demo/one"]["url"] == "http://demo.localhost:8767/?scenario=one" and cards["demo/one"]["idea"] == "1.2"
    assert cards["demo/two"]["idea"] is None  # 指向不存在的 idea 就不挂 / a card pointing at a missing idea is left unlinked
    assert TestClient(app, base_url="http://localhost:8767").post("/api/play/nope/build").status_code == 404


def test_card_history_and_attention_from_play_events(repo):
    from idea_loom import stats, trail

    A = lambda kind, card, seconds=0.0, idea="": trail.Action(at="2026-10-11T08:00:00Z", kind=kind, url="/play", text=card, seconds=seconds, idea=idea, card=card)
    trail.append([A("play", "demo/one", 40, "1.2"), A("play", "demo/one", 2, "1.2"), A("like", "demo/one"), A("play", "demo/two", 3), A("like", "demo/two"), A("unlike", "demo/two")])
    h = trail.card_history()
    assert (h["demo/one"].views, h["demo/one"].seconds, h["demo/one"].quick_skips, h["demo/one"].liked) == (2, 42.0, 1, True)
    assert (h["demo/two"].views, h["demo/two"].quick_skips, h["demo/two"].liked) == (1, 1, False)
    assert get("/api/play").json()["history"]["demo/one"]["liked"] is True
    a = stats.attention(trail.load())
    assert a.by_page == {"/play": 45.0} and [(i.id, i.seconds) for i in a.ideas] == [("1.2", 42.0)]


def test_cloud_domain_and_roles(repo, monkeypatch):
    from idea_loom import config
    from idea_loom.play import keeper

    monkeypatch.setenv("IDEA_LOOM_SIM_DOMAIN", "sim.example.com")
    monkeypatch.setenv("IDEA_LOOM_PUBLIC_URL", "https://loom.example.com")
    assert host.sim_name("demo.sim.example.com") == "demo" and host.sim_name("demo.localhost:8767") is None
    assert host.sim_name("loom.example.com") is None and host.sim_name("sim.example.com") is None
    assert config.sim_origin("demo", "8767") == "https://demo.sim.example.com"
    assert host.origin_allowed("https://loom.example.com") and not host.origin_allowed("https://demo.sim.example.com")
    assert not host.origin_allowed("http://localhost:5187")  # 云端不认本机的来源 / local origins are not trusted in the cloud

    cloud = lambda h: TestClient(app, base_url=f"https://{h}")
    assert "版本一" in cloud("demo.sim.example.com").get("/").text
    view = cloud("loom.example.com").get("/api/play").json()
    assert next(s for s in view["sims"] if s["name"] == "demo")["origin"] == "https://demo.sim.example.com"
    assert cloud("loom.example.com").get("/internal/tls-ask?domain=demo.sim.example.com").status_code == 200
    assert cloud("loom.example.com").get("/internal/tls-ask?domain=loom.example.com").status_code == 200
    assert cloud("loom.example.com").get("/internal/tls-ask?domain=evil.sim.example.com").status_code == 404
    assert cloud("loom.example.com").get("/internal/tls-ask?domain=example.org").status_code == 404

    # hub 角色不提供模拟；play 角色不提供 idea-loom 的接口。
    # The hub role serves no simulations; the play role serves no idea-loom API.
    monkeypatch.setenv("IDEA_LOOM_ROLE", "hub")
    assert cloud("demo.sim.example.com").get("/").status_code == 404
    assert cloud("loom.example.com").get("/api/health").status_code == 200
    assert cloud("loom.example.com").post("/api/play/demo/build").status_code == 503  # 没配 play 的地址 / no play address configured
    monkeypatch.setenv("IDEA_LOOM_ROLE", "play")
    monkeypatch.setenv("IDEA_LOOM_INTERNAL_TOKEN", "s3cret")
    assert cloud("demo.sim.example.com").get("/").status_code == 200
    assert cloud("loom.example.com").get("/api/state").status_code == 404
    assert cloud("play").get("/healthz").json()["role"] == "play"
    assert cloud("play").post("/internal/play/build/demo", headers={"x-internal-token": "wrong"}).status_code == 403
    assert cloud("play").post("/internal/play/build/demo", headers={"x-internal-token": "s3cret"}).json()["status"] == "ready"
    assert keeper.tick()["demo"] == "ready"


def test_cloud_bootstrap_clones_once_and_seeds_only_missing_data(repo, tmp_path, monkeypatch):
    from idea_loom import cloud

    clone = tmp_path / "srv" / "repo"
    data = tmp_path / "srv" / "data"
    monkeypatch.setenv("IDEA_LOOM_REPO", str(clone))
    monkeypatch.setenv("IDEA_LOOM_DATA", str(data))
    assert cloud.has_clone() is False and cloud.seed_data() == [] and cloud.ensure_clone() is False  # 没给地址 / no URL given
    monkeypatch.setenv("IDEA_LOOM_REPO_URL", str(repo))
    assert cloud.ensure_clone() is True and cloud.ensure_clone() is True
    git(clone, "update-ref", "refs/remotes/origin/main", "HEAD")
    copied = cloud.seed_data()
    assert "idea-loom/data/ideas.jsonl" in copied and "idea-loom/data/play/flat.json" in copied
    assert (data / "ideas.jsonl").read_bytes() == (repo / "idea-loom" / "data" / "ideas.jsonl").read_bytes()
    (data / "ideas.jsonl").write_text("云端后来写的\n")
    assert cloud.seed_data() == [] and (data / "ideas.jsonl").read_text() == "云端后来写的\n"
