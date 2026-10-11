"""给外来 Agent 的那一层：说明、数据集、想法池、计算、令牌、提议、MCP。

The layer for outside agents: descriptions, datasets, the idea pool, computations, tokens, proposals and MCP.
"""

import json
import subprocess

import httpx
import pytest
from fastapi.testclient import TestClient

import fake_claude as fc
from idea_loom import ops, suggestions
from idea_loom.agentapi import datasets, docs, mcp, run, spec, tokens
from idea_loom.server import app

T = {"zh": "中", "en": "en"}
SPEC = {
    "summary": {"zh": "一个演示项目。", "en": "A demo project."},
    "datasets": [
        {"id": "items", "title": T, "path": "data/items.json", "records": "items", "key": "id", "search": ["name", "tags"], "fields": ["id", "name"],
         "licence": "CC0 1.0", "provenance": {"zh": "手写的。", "en": "Hand-written."}},
        {"id": "notes", "title": T, "path": "notes/*/*.yaml", "licence": "MIT", "provenance": T},
        {"id": "table", "title": T, "path": "data/table.json", "licence": "MIT", "provenance": T},
    ],
    "capabilities": [
        {"id": "double", "title": T, "description": T, "http": {"method": "POST", "path": "/api/double"},
         "input": {"type": "object", "required": ["n"], "additionalProperties": False, "properties": {"n": {"type": "integer", "minimum": 0, "maximum": 100}}},
         "seconds": 2, "example": {"n": 2}},
        {"id": "lookup", "title": T, "description": T, "http": {"method": "GET", "path": "/api/thing/{id}"},
         "input": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}, "lang": {"type": "string"}}}, "deterministic": False, "example": {"id": "a"}},
    ],
}


@pytest.fixture
def world(seeded, tmp_path, monkeypatch):
    """一个小仓库：main 上有 demo 项目的数据；说明用临时的那份。 / A small repository with a demo project's data on main and an interim description."""
    repo = tmp_path / "repo"
    (repo / "demo" / "data").mkdir(parents=True)
    (repo / "demo" / "notes" / "a").mkdir(parents=True)
    items = [{"id": f"i{n}", "name": f"Item {n}", "tags": ["甲" if n % 2 else "乙"], "big": "x" * 50, "nested": {"kind": "odd" if n % 2 else "even"}} for n in range(1, 31)]
    (repo / "demo" / "data" / "items.json").write_text(json.dumps({"about": "x", "items": items}, ensure_ascii=False))
    (repo / "demo" / "data" / "table.json").write_text(json.dumps({"k1": {"v": 1}, "k2": {"v": 2}}))
    (repo / "demo" / "notes" / "a" / "first.yaml").write_text("title: 第一条\nverified: true\n", encoding="utf-8")
    (repo / "demo" / "notes" / "a" / "second.yaml").write_text("title: 第二条\nverified: false\n", encoding="utf-8")
    (repo / "demo" / "secret.json").write_text("{}")
    for args in (["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "x"], ["update-ref", "refs/remotes/origin/main", "HEAD"]):
        subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
    monkeypatch.setenv("IDEA_LOOM_REPO", str(repo))
    (seeded / "agent").mkdir()
    (seeded / "agent" / "demo.json").write_text(json.dumps(SPEC, ensure_ascii=False), encoding="utf-8")
    datasets._cache.clear()
    return TestClient(app, base_url="http://localhost:8767")


def test_descriptions_are_validated(world, seeded):
    assert spec.load("demo").source == "interim" and spec.load("nothere") is None
    for change, message in [
        ({"datasets": [{**SPEC["datasets"][0], "licence": " "}]}, "要写明许可"),
        ({"datasets": [{**SPEC["datasets"][0], "path": "../other/x.json"}]}, "相对路径"),
        ({"datasets": [{**SPEC["datasets"][0], "path": "data/x.csv"}]}, "JSON 或 YAML"),
        ({"datasets": [SPEC["datasets"][0], SPEC["datasets"][0]]}, "重复"),
        ({"capabilities": [{**SPEC["capabilities"][0], "http": {"method": "POST", "path": "/monologue"}}]}, "/api/"),
        ({"capabilities": [{**SPEC["capabilities"][0], "seconds": 900}]}, "耗时"),
    ]:
        (seeded / "agent" / "demo.json").write_text(json.dumps({**SPEC, **change}, ensure_ascii=False), encoding="utf-8")
        with pytest.raises(ValueError, match=message):
            spec.load("demo")
    assert spec.load_all()[1].keys() == {"demo"}                    # 坏的说明进 problems，不拖垮别的 / a broken one is reported, not fatal


def test_catalogue_lists_what_exists(world):
    c = world.get("/api/v1/catalog").json()
    (demo,) = [p for p in c["projects"] if p["name"] == "demo"]
    assert [d["id"] for d in demo["datasets"]] == ["items", "notes", "table"] and [k["id"] for k in demo["capabilities"]] == ["double", "lookup"]
    assert demo["summary"]["en"] == "A demo project." and c["ideas"]["live"] == 4 and c["problems"] == {}
    assert world.get(demo["datasets"][0]["describe"]).json()["records"] == 30


def test_dataset_queries(world):
    get = lambda q: world.get(f"/api/v1/datasets/demo/{q}")  # noqa: E731
    info = get("items/schema").json()
    assert (info["records"], info["key"], info["licence"], info["sample"]) == (30, "id", "CC0 1.0", {"id": "i1", "name": "Item 1"})
    page = get("items?limit=5").json()
    assert (page["total"], page["count"], page["next"], page["records"][0]) == (30, 5, 5, {"id": "i1", "name": "Item 1"})     # 默认字段 / default fields
    assert page["licence"] == "CC0 1.0" and page["provenance"]["en"] == "Hand-written." and len(page["version"]) == 12
    assert get("items?limit=5&after=28").json()["next"] is None
    assert [r["id"] for r in get("items?q=item+甲&limit=3").json()["records"]] == ["i1", "i3", "i5"]                          # 每个词都要中 / every word must match
    assert get("items?q=xxxx").json()["total"] == 0                                                                           # big 不在搜索的字段里 / `big` is not a searched field
    assert get("items?key=i7&fields=*").json()["records"][0]["nested"] == {"kind": "odd"}
    assert get("items?where=nested.kind=even&where=id=i2&fields=id,nested.kind").json()["records"] == [{"id": "i2", "nested.kind": "even"}]
    assert [r["_id"] for r in get("table").json()["records"]] == ["k1", "k2"]                                                 # 对象的键变成 _id / object keys become _id
    notes = get("notes?where=verified=true").json()
    assert notes["total"] == 1 and notes["records"][0] == {"_id": "first", "_group": "a", "title": "第一条", "verified": True}   # 每个文件一条 / one record per file
    for query, status, text in [("items?key=nope", 422, "没有键是"), ("items?where=colour=red", 422, "没有 'colour' 这个字段"), ("items?where=bad", 422, "字段=值"),
                                ("items?limit=500", 422, "limit"), ("nope", 404, "items, notes, table"), ("../demo/secret", 404, "")]:
        r = get(query)
        assert r.status_code == status and text in r.text and ("hint" in r.json() or status == 404), query
    assert world.get("/api/v1/datasets/nowhere/items").json()["error"].startswith("没有 'nowhere' 这个项目")


def test_big_replies_are_cut_and_say_so(world, monkeypatch):
    monkeypatch.setattr(datasets, "MAX_BYTES", 400)
    page = world.get("/api/v1/datasets/demo/items?fields=*&limit=20").json()
    assert page["truncated"] is True and 0 < page["count"] < 20 and page["next"] == page["count"]


def test_idea_pool(world):
    found = world.get("/api/v1/ideas", params={"q": "沙堆"}).json()
    assert found["total"] == 1 and found["ideas"][0]["id"] == "1.2" and "body" not in found["ideas"][0] and "full=true" in found["note"]
    assert "一粒一粒" in world.get("/api/v1/ideas", params={"q": "沙堆", "full": "true"}).json()["ideas"][0]["body"]
    assert world.get("/api/v1/ideas", params={"limit": 200}).json()["total"] == 4
    assert world.get("/api/v1/ideas", params={"level": "L1", "thread": "B"}).json()["total"] == 2
    one = world.get("/api/v1/ideas/1.2").json()
    assert one["title"] == "沙堆" and one["history"] and one["cards"] == []
    missing = world.get("/api/v1/ideas/9.9")
    assert missing.status_code == 404 and "ideas?q=" in missing.json()["error"]


def backend(seen):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, dict(request.url.params), request.headers["host"], request.content.decode()))
        if request.url.path == "/api/double":
            n = json.loads(request.content)["n"]
            return httpx.Response(400, json={"detail": "七不行"}) if n == 7 else httpx.Response(200, json={"twice": 2 * n})
        return httpx.Response(200, text="x" * (2_000_000 if "huge" in request.url.path else 10))

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_run_validates_bounds_and_wraps_the_result(world):
    seen = []
    demo = spec.load("demo")
    out = run.run("demo", demo.capability("double"), {"n": 21}, client=backend(seen))
    assert out["result"] == {"twice": 42} and out["deterministic"] is True and out["input"] == {"n": 21} and len(out["version"]) == 12
    assert seen[0][:2] == ("POST", "/api/double") and seen[0][3] == "demo.localhost:8767" and json.loads(seen[0][4]) == {"n": 21}
    run.run("demo", demo.capability("lookup"), {"id": "a/b ?", "lang": "zh"}, client=backend(seen))
    assert seen[1][1] == "/api/thing/a/b ?" and seen[1][2] == {"lang": "zh"}          # 路径参数转义后填进去，其余进查询串 / path parameters are escaped in, the rest go to the query
    for payload, status, text in [({"n": 500}, 422, "n: 500 is greater than"), ({"n": 1, "extra": 1}, 422, "extra"), ({}, 422, "'n' is a required"), ([1], 422, "JSON 对象"), ({"n": 7}, 400, "七不行")]:
        with pytest.raises(run.RunError) as e:
            run.run("demo", demo.capability("double"), payload, client=backend(seen))
        assert e.value.status == status and text in e.value.error and "example" in (e.value.hint + " example").lower()
    with pytest.raises(run.RunError) as e:
        run.run("demo", demo.capability("lookup"), {"id": "huge"}, client=backend(seen))
    assert e.value.status == 413
    bad = world.post("/api/v1/run/demo/double", json={"n": "two"})
    assert bad.status_code == 422 and "Allowed fields: n" in bad.json()["hint"]
    assert world.post("/api/v1/run/demo/nope", json={}).status_code == 404


def test_tokens_and_proposals_queue_without_any_model_call(world, tmp_path, monkeypatch):
    from test_auth import cloud as cloud_fixture  # noqa: F401

    log = fc.install(tmp_path, monkeypatch)
    monkeypatch.setenv("IDEA_LOOM_OWNER", "Carl")
    monkeypatch.setenv("IDEA_LOOM_SESSION_SECRET", "s")
    monkeypatch.setenv("IDEA_LOOM_PUBLIC_URL", "https://loom.example.com")
    monkeypatch.setenv("IDEA_LOOM_SIM_DOMAIN", "sim.example.com")
    c = TestClient(app, base_url="https://loom.example.com")
    reader, proposer = tokens.create("reader", ["read"]), tokens.create("builder bot", ["propose"])
    assert proposer["token"].startswith("wsk_") and proposer["scopes"] == ["propose", "read"] and "hash" not in json.dumps(tokens.listing())
    with pytest.raises(ValueError, match="同名"):
        tokens.create("reader", ["read"])
    idea = {"title": "谣言的半衰期", "body": "一条谣言在小镇里能活多久。\n去查有没有测过的。", "level": "L8", "why": "池里没有讲寿命的"}
    auth = lambda t: {"authorization": f"Bearer {t['token']}"}  # noqa: E731
    assert c.get("/api/v1/catalog").status_code == 200                                    # 读不要令牌 / reading needs no token
    for headers in ({}, auth(reader), {"authorization": "Bearer wsk_made_up"}):
        r = c.post("/api/v1/proposals/idea", json=idea, headers=headers)
        assert r.status_code == 401 and "propose scope" in r.json()["hint"]
    assert c.get("/api/wishes", headers=auth(proposer)).status_code == 401                 # 令牌不是登录身份 / a token is not a signed-in identity
    assert c.post("/api/ops/generate", json={}, headers=auth(proposer)).status_code == 401
    queued = c.post("/api/v1/proposals/idea", json=idea, headers=auth(proposer)).json()
    wish = c.post("/api/v1/proposals/wish", json={"title": "想按年份筛语料", "stuck": "只能全文搜"}, headers=auth(proposer)).json()
    assert queued["status"] == "waiting" and wish["status"] == "waiting"
    bad = c.post("/api/v1/proposals/idea", json={**idea, "level": "L99"}, headers=auth(proposer))
    assert bad.status_code == 422 and "level 要从这些里选" in bad.json()["error"]
    items = {s.id: s for s in suggestions.listing()}
    assert items[queued["queued"]].by == "agent:builder bot" and items[queued["queued"]].kind == "idea" and ops.load() == []   # 只在队列里 / only in the queue
    suggestions.accept(queued["queued"])
    (candidate,) = ops.load()
    assert candidate.title == "谣言的半衰期" and candidate.status == "open" and world.get("/api/v1/ideas", params={"q": "半衰期"}).json()["total"] == 0  # 放行后是候选，还不是 idea / a candidate after acceptance, not yet an idea
    from idea_loom import wishes

    assert wishes.get(suggestions.accept(wish["queued"]).wish_id).source == "agent:builder bot"
    assert tokens.revoke(proposer["id"]) and c.post("/api/v1/proposals/wish", json={"title": "x"}, headers=auth(proposer)).status_code == 401
    assert fc.calls(log) == []                                                             # 全程没有调用模型 / no model call at any point


def rpc(client, method, params=None, mid=1):
    return client.post("/mcp", json={"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}).json()


def test_mcp_offers_the_same_things_as_http(world):
    hello = rpc(world, "initialize", {"protocolVersion": "2025-03-26"})["result"]
    assert hello["serverInfo"]["name"] == "world-sim" and "catalog" in hello["instructions"] and hello["capabilities"] == {"tools": {}}
    assert world.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code == 202
    names = [t["name"] for t in rpc(world, "tools/list")["result"]["tools"]]
    assert names == [t["name"] for t in mcp.TOOLS] and names[0] == "catalog" and len(names) == 10

    def tool(name, **args):
        result = rpc(world, "tools/call", {"name": name, "arguments": args})["result"]
        return result["isError"], json.loads(result["content"][0]["text"])

    assert tool("catalog")[1] == world.get("/api/v1/catalog").json()
    via_http = world.get("/api/v1/datasets/demo/items", params={"q": "甲", "where": ["nested.kind=odd"], "fields": "id", "limit": 2}).json()
    assert tool("query_dataset", project="demo", dataset="items", q="甲", where=["nested.kind=odd"], fields=["id"], limit=2) == (False, via_http)
    assert tool("describe_dataset", project="demo", dataset="items")[1]["records"] == 30
    assert tool("describe_capability", project="demo", capability="double")[1]["example"] == {"n": 2}
    assert tool("get_idea", id="纵 1")[1]["title"] == "一杯酒"
    assert tool("search_ideas", q="火星")[1]["ideas"][0]["id"] == "1.3"
    error, body = tool("query_dataset", project="demo", dataset="nope")
    assert error is True and "items, notes, table" in body["error"]
    error, body = tool("run", project="demo", capability="double", input={"n": -1})
    assert error is True and "Allowed fields: n" in body["hint"]
    assert tool("nope")[0] is True and rpc(world, "nope")["error"]["code"] == -32601
    assert world.get("/mcp").status_code == 405


def test_generated_documents_follow_the_descriptions(world):
    short = world.get("/llms.txt").text
    assert short.startswith("# world-sim\n") and "/api/v1/catalog" in short and "- **demo**" in short and "data [items](http://localhost:8767/api/v1/datasets/demo/items/schema)" in short
    full = docs.llms_full("https://x.example")
    assert "### data: items" in full and "Records: 30 · key field: `id`" in full and '"n": 2' in full and "POST https://x.example/api/v1/run/demo/double" in full
    assert "Licence: CC0 1.0" in full and "Hand-written." in full
