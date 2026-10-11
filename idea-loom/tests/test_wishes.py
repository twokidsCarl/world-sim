import pytest

from idea_loom import wishes


def make(**kw):
    base = dict(title="地图上看不出哪格是空的", kind="unclear", stuck="找了半天", suggestion="空格画斜线")
    return wishes.record(**{**base, **kw})


def test_record_and_list(data):
    wid = make(where={"url": "/", "title": "地图"}, question="哪格是空的？")
    w = wishes.get(wid)
    assert (w.status, w.occurrences, w.kind_label, w.where.title) == ("open", 1, "界面不清楚", "地图")
    assert w.seen[0].question == "哪格是空的？" and wid in w.copy_text
    listing = wishes.listing()
    assert [x.wish_id for x in listing.wishes] == [wid] and listing.counts["open"] == 1
    with pytest.raises(wishes.WishError):
        make(kind="nope")
    with pytest.raises(wishes.WishError):
        make(title="  ")


def test_seeing_it_again_bumps_and_can_widen_while_open(data):
    wid = make()
    wishes.see_again(wid, title="地图和想法池都看不出空缺", question="想法池里呢？")
    w = wishes.get(wid)
    assert (w.occurrences, w.title, len(w.seen)) == (2, "地图和想法池都看不出空缺", 2)


def test_accepted_wish_is_frozen_but_takes_notes(data):
    wid = make()
    wishes.set_status(wid, "accepted")
    wishes.see_again(wid, title="想改标题", note="在 idea 页也遇到了")
    w = wishes.get(wid)
    assert (w.title, w.occurrences, w.notes[0].text) == ("地图上看不出哪格是空的", 2, "在 idea 页也遇到了")
    with pytest.raises(wishes.WishError, match="不能再改写"):
        wishes.edit(wid, title="x")
    with pytest.raises(wishes.WishError):
        wishes.withdraw(wid)


def test_list_is_sorted_by_how_often_it_was_met(data):
    a, b = make(title="甲"), make(title="乙")
    wishes.see_again(b)
    assert [w.title for w in wishes.listing().wishes] == ["乙", "甲"]


def test_withdraw_and_restore(data):
    wid = make()
    wishes.withdraw(wid)
    assert wishes.listing().wishes == [] and wishes.listing("withdrawn").wishes[0].wish_id == wid
    with pytest.raises(wishes.WishError):
        wishes.see_again(wid)
    wishes.restore(wid)
    assert wishes.get(wid).status == "open"


def test_status_rules(data):
    wid = make()
    with pytest.raises(wishes.WishError, match="不能直接"):
        wishes.set_status(wid, "done", pr=1)
    with pytest.raises(wishes.WishError, match="原因"):
        wishes.set_status(wid, "declined")
    wishes.set_status(wid, "accepted")
    with pytest.raises(wishes.WishError, match="合并请求"):
        wishes.set_status(wid, "done")
    wishes.add_link(wid, "pr", title="改地图", url="https://example.test/pull/9", pr=9)
    wishes.set_status(wid, "done", pr=9, note="空格画了斜线")
    w = wishes.get(wid)
    assert (w.status_label, w.pr, w.status_note, w.links[0].pr) == ("已做完", 9, "空格画了斜线", 9)
    assert [h.event for h in w.history][:3] == ["status", "linked", "status"]


def test_open_titles_for_the_assistant(data):
    a = make(title="甲")
    wishes.set_status(make(title="乙"), "declined", note="不做")
    assert wishes.open_titles() == [(a, "甲", 1, "未处理")]
