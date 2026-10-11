from conftest import ev

from idea_loom import ideas


def test_level_comes_from_the_id():
    assert ideas.level_of("4.2") == "L4"
    assert ideas.level_of("10.6") == "L10"
    assert ideas.level_of("纵 3") == "纵"


def test_next_id_never_reuses_a_number():
    used = ["4.1", "4.2", "4.9", "造 8", "10.1"]
    assert ideas.next_id("L4", used) == "4.10"
    assert ideas.next_id("造", used) == "造 9"
    assert ideas.next_id("L7", used) == "7.1"


def test_fold_creates_and_orders(seeded):
    s = ideas.state()
    assert [i.id for i in s.ideas] == ["1.1", "1.2", "1.3", "纵 1"]
    assert s.counts.live == 4
    assert s.ideas[0].kernel == "粒子"
    assert s.ideas[0].status_label == "在池"


def test_edit_keeps_every_version(seeded):
    ideas.append_events([ev(10, "1.2", "edited", title="沙堆与雪崩", body="新的正文。")])
    d = ideas.detail("1.2")
    assert d.title == "沙堆与雪崩" and d.versions == 2
    edited = d.history[0]
    assert edited.event == "edited"
    assert edited.before.title == "沙堆" and edited.after.body == "新的正文。"


def test_merge_marks_source_and_links_to_target(seeded):
    ideas.append_events([ev(10, "1.3", "merged_into", target="1.2", reason="同一个内核")])
    s = ideas.state()
    merged = next(i for i in s.ideas if i.id == "1.3")
    assert merged.status == "merged" and merged.merged_into == "1.2"
    assert s.counts.live == 3
    assert any(l.source == "1.3" and l.target == "1.2" and l.kind == "merged_into" for l in s.links)
    assert "1.3" not in s.coverage.by_level["L1"]


def test_discard_then_restore(seeded):
    ideas.append_events([ev(10, "1.3", "discarded", reason="重复")])
    assert ideas.detail("1.3").status == "discarded"
    ideas.append_events([ev(11, "1.3", "restored")])
    d = ideas.detail("1.3")
    assert d.status == "pool" and d.reason is None


def test_move_changes_position_and_can_clear_kernel(seeded):
    ideas.append_events([ev(10, "1.1", "moved", threads=["A", "E"], kernel=None)])
    d = ideas.detail("1.1")
    assert d.threads == ["A", "E"] and d.kernel is None
    assert d.history[0].text == "横线改为 A、E；取消内核归类"


def test_mentions_and_projects_come_from_the_body(seeded):
    s = ideas.state()
    by_id = {i.id: i for i in s.ideas}
    assert by_id["1.2"].mentions == ["1.1"]
    assert by_id["1.1"].projects == ["strata"]
    assert any(l.source == "1.1" and l.target == "1.2" and l.kind == "mentions" for l in s.links)


def test_coverage_counts_live_ideas_per_cell(seeded):
    cov = ideas.state().coverage
    assert cov.cells["L1"]["B"] == ["1.2", "1.3"]
    assert cov.cells["L1"]["C"] == []
    assert cov.untagged == ["纵 1"]


def test_kernel_counts_sorted_by_size(seeded):
    ideas.append_events([ev(10, "1.2", "moved", kernel="阈值与级联"), ev(11, "1.3", "moved", kernel="阈值与级联")])
    ks = ideas.state().kernels
    assert [(k.name, k.ideas) for k in ks] == [("阈值与级联", ["1.2", "1.3"]), ("粒子", ["1.1"])]


def test_events_for_unknown_ideas_are_ignored(seeded):
    ideas.append_events([ev(10, "9.9", "edited", title="x")])
    assert ideas.detail("9.9") is None


def test_unreadable_event_is_counted(seeded):
    with ideas.ideas_path().open("a", encoding="utf-8") as f:
        f.write('{"at": "x", "id": "1.1", "event": "not-an-event"}\n')
    assert ideas.state().unreadable == 1
