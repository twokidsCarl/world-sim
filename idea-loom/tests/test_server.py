from fastapi.testclient import TestClient

from idea_loom.server import app

client = TestClient(app)


def test_state(seeded):
    r = client.get("/api/state")
    assert r.status_code == 200
    body = r.json()
    assert body["counts"]["total"] == 4
    assert [t["id"] for t in body["frame"]["threads"]] == list("ABCDE")
    assert body["labels"]["status"]["merged"] == "已并入"


def test_idea_detail_and_missing(seeded):
    r = client.get("/api/ideas/纵 1")
    assert r.status_code == 200
    assert r.json()["prompt_text"] == "从分子到社会。"
    assert client.get("/api/ideas/99.9").status_code == 404


def test_health_carries_version_marks(tmp_path, monkeypatch):
    """health 保留 ok，并带上进程启动记号和界面构建记号。
    health keeps ok and carries the process start mark and the UI build mark.
    """
    import os

    from idea_loom.play import host as play_host

    monkeypatch.setattr(play_host, "ui_dist", lambda: tmp_path)
    # 没有构建：ui 是 None。 / No build: ui is None.
    first = client.get("/api/health").json()
    assert first["ok"] is True
    assert isinstance(first["started"], str) and first["started"]
    assert first["ui"] is None
    # 有了构建：ui 是 index.html 的修改时间（毫秒）。 / With a build: ui is the modification time of index.html in milliseconds.
    index = tmp_path / "index.html"
    index.write_text("<!doctype html>", encoding="utf-8")
    os.utime(index, (1_000, 1_000))
    built = client.get("/api/health").json()
    assert built["ui"] == 1_000_000
    # 重新构建后 ui 变了，started 在同一个进程里不变。 / A rebuild changes ui; started stays the same within one process.
    os.utime(index, (2_000, 2_000))
    rebuilt = client.get("/api/health").json()
    assert rebuilt["ui"] == 2_000_000
    assert rebuilt["started"] == first["started"]
