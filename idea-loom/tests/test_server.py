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


def test_health_says_when_the_code_on_disk_is_newer_than_the_running_process(seeded, monkeypatch):
    """改了后端的代码而没重启：页面要能知道。 / The backend code changed without a restart: the page must be able to tell."""
    from idea_loom import server

    client = TestClient(app, base_url="http://localhost:8767")
    monkeypatch.setattr(server, "_code_checked", (0.0, False))
    monkeypatch.setattr(server, "_STARTED", str(2**62))          # 进程比所有文件都新 / the process is newer than every file
    assert client.get("/api/health").json()["code_stale"] is False
    monkeypatch.setattr(server, "_code_checked", (0.0, False))
    monkeypatch.setattr(server, "_STARTED", str(10**18))         # 2001 年启动的进程 / a process started in 2001
    assert client.get("/api/health").json()["code_stale"] is True
