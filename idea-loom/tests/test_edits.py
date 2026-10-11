import pytest
from fastapi.testclient import TestClient

from idea_loom import edits, ideas
from idea_loom.server import app

client = TestClient(app)


def test_create_takes_the_next_number_and_validates(seeded):
    new_id = edits.create(title="一片雪花", body="六个角。", level="L1", threads=["E"], kernel="粒子")
    assert new_id == "1.4"
    d = ideas.detail("1.4")
    assert (d.title, d.threads, d.kernel, d.status, d.origin.how) == ("一片雪花", ["E"], "粒子", "pool", "human")
    with pytest.raises(edits.EditError):
        edits.create(title="", body="x", level="L1")
    with pytest.raises(edits.EditError):
        edits.create(title="x", body="y", level="L99")
    with pytest.raises(edits.EditError):
        edits.create(title="x", body="y", level="L1", kernel="不存在的内核")


def test_number_of_a_merged_idea_is_not_reused(seeded):
    edits.merge("1.3", "1.2", reason="重复")
    assert edits.create(title="新的", body="正文。", level="L1") == "1.4"


def test_edit_is_a_no_op_when_nothing_changes(seeded):
    before = len(ideas.load_events()[0])
    edits.edit("1.2", title="沙堆")
    assert len(ideas.load_events()[0]) == before
    edits.edit("1.2", body="新的正文。")
    assert ideas.detail("1.2").body == "新的正文。"


def test_move_only_writes_what_changed(seeded):
    edits.move("1.1", threads=["E"])
    assert ideas.detail("1.1").history[0].event == "created"
    edits.move("1.1", threads=["A", "E"], clear_kernel=True)
    d = ideas.detail("1.1")
    assert d.threads == ["A", "E"] and d.kernel is None
    with pytest.raises(edits.EditError):
        edits.move("1.1", threads=["Z"])


def test_merge_rules(seeded):
    with pytest.raises(edits.EditError):
        edits.merge("1.2", "1.2")
    edits.merge("1.3", "1.2")
    with pytest.raises(edits.EditError):
        edits.merge("1.3", "1.1")  # 已并入的不能再并 / already merged
    with pytest.raises(edits.EditError):
        edits.merge("1.1", "1.3")  # 不能并进已并入的 / target is gone
    with pytest.raises(edits.EditError):
        edits.merge("1.1", "8.8")


def test_discard_restore_and_status(seeded):
    edits.discard("1.3", reason="不做了")
    with pytest.raises(edits.EditError):
        edits.discard("1.3")
    with pytest.raises(edits.EditError):
        edits.set_status("1.3", "building")
    edits.restore("1.3")
    with pytest.raises(edits.EditError):
        edits.restore("1.3")
    edits.set_status("1.3", "building")
    assert ideas.detail("1.3").status_label == "开发中"
    with pytest.raises(edits.EditError):
        edits.set_status("1.3", "merged")


def test_api_round_trip(seeded):
    r = client.post("/api/ideas", json={"title": "一片雪花", "body": "六个角。", "level": "L1", "threads": ["E"]})
    assert r.status_code == 200 and r.json()["id"] == "1.4"
    assert client.post("/api/ideas/1.4/edit", json={"body": "改过了。"}).json()["versions"] == 2
    assert client.post("/api/ideas/1.4/move", json={"kernel": "粒子"}).json()["kernel"] == "粒子"
    assert client.post("/api/ideas/1.4/merge", json={"target": "1.1", "reason": "同一件事"}).json()["merged_into"] == "1.1"
    assert client.post("/api/ideas/1.4/restore").json()["status"] == "pool"
    assert client.post("/api/ideas/1.4/discard", json={"reason": "试试"}).json()["status"] == "discarded"
    conflict = client.post("/api/ideas/1.4/discard", json={})
    assert conflict.status_code == 409 and "已丢弃" in conflict.json()["detail"]
    assert client.post("/api/ideas/9.9/edit", json={"title": "x"}).status_code == 409
