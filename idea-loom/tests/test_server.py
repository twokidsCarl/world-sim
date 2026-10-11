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
