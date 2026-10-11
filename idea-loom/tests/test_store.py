from idea_loom import store


def test_append_then_read(tmp_path):
    path = tmp_path / "a.jsonl"
    assert store.append(path, [{"n": 1}, {"n": 2}]) == 2
    store.append(path, [{"名": "中文"}])
    rows, bad = store.read_lines(path)
    assert rows == [{"n": 1}, {"n": 2}, {"名": "中文"}]
    assert bad == 0


def test_unreadable_lines_are_skipped_and_counted(tmp_path):
    path = tmp_path / "a.jsonl"
    path.write_text('{"n": 1}\nnot json\n[1, 2]\n\n{"n": 2}\n', encoding="utf-8")
    rows, bad = store.read_lines(path)
    assert rows == [{"n": 1}, {"n": 2}]
    assert bad == 2


def test_missing_file_reads_as_empty(tmp_path):
    assert store.read_lines(tmp_path / "none.jsonl") == ([], 0)


def test_write_json_is_atomic_and_readable(tmp_path):
    path = tmp_path / "x" / "f.json"
    store.write_json(path, {"a": "文"})
    assert store.read_json(path, None) == {"a": "文"}
    assert not path.with_suffix(".json.tmp").exists()
