import pytest

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


# ---------- 数据库存法 / the database backend ----------


@pytest.fixture
def db(seeded, tmp_path, monkeypatch):
    """先用文件写好 seeded 的四条，再切到数据库。 / The four seeded ideas are written as files first, then the database is switched on."""
    monkeypatch.setenv("IDEA_LOOM_DB", str(tmp_path / "db" / "loom.sqlite"))
    return seeded


def test_database_holds_the_shared_logs_and_nothing_else(db, tmp_path):
    from idea_loom import cloud, edits, ideas, trail
    from idea_loom.trail import Action

    assert store.stream_of(db / "ideas.jsonl") == "ideas" and store.stream_of(store.runs_dir() / "trail.jsonl") == "trail"
    assert store.stream_of(db / "play" / "x.jsonl") is None and store.stream_of(store.runs_dir() / "jobs" / "j1" / "events.jsonl") is None
    assert ideas.current()[0] == {}                       # 库是空的，文件里的还没并进来 / the database is empty until the files are merged in
    assert cloud.migrate_files() == {"ideas": 4} and cloud.migrate_files() == {"ideas": 0}
    assert sorted(ideas.current()[0]) == ["1.1", "1.2", "1.3", "纵 1"]
    before = (db / "ideas.jsonl").read_text(encoding="utf-8")
    assert store.export_text("ideas") == before           # 导出和文件一模一样 / the export equals the file
    new_id = edits.create(title="新的", body="在云端写的。", level="L1")
    assert new_id == "1.4" and (db / "ideas.jsonl").read_text(encoding="utf-8") == before  # 文件没被动过 / the file was not touched
    assert store.export_text("ideas").startswith(before) and store.export_text("ideas").count("\n") == 5
    trail.append([Action(at="2026-10-11T08:00:00Z", kind="click", url="/", text="x")])
    assert len(trail.load()) == 1 and not (store.runs_dir() / "trail.jsonl").exists()
    assert store.counts() == {"ideas": 5, "trail": 1}


def test_import_is_idempotent_and_keeps_identical_rows(db):
    a, b = {"at": "t1", "v": 1}, {"at": "t2", "v": 2}
    assert store.import_rows("wishes", [a, a, b]) == 3      # 两条一模一样的都留着 / both identical rows are kept
    assert store.import_rows("wishes", [a, a, b]) == 0
    assert store.import_rows("wishes", [a, a, b, a, {"at": "t3", "v": 3}]) == 2   # 只进新的 / only the new ones
    assert [r["v"] for r in store.read_lines(db / "wishes.jsonl")[0]] == [1, 1, 2, 1, 3]
    store.append(db / "wishes.jsonl", [b])                  # 云端又写了一条和 b 一样的 / the cloud writes another identical to b
    assert store.import_rows("wishes", [a, a, b, a]) == 0   # 仓库里那份还是旧的，不会把它当成新的 / the repository copy is older; nothing is new
    assert store.import_rows("wishes", [a, a, b, a, b, b]) == 1
    assert store.import_rows("ideas", [a]) == 1             # 不同的日志互不相干 / logs do not affect each other


def test_rows_committed_by_other_sessions_reach_the_database(db, tmp_path, monkeypatch):
    import subprocess

    from idea_loom import cloud, ideas

    repo = tmp_path / "repo"
    (repo / "idea-loom" / "data").mkdir(parents=True)

    def git(*args):
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.com", *args], check=True, capture_output=True)

    def commit(text):
        (repo / "idea-loom" / "data" / "ideas.jsonl").write_text(text, encoding="utf-8")
        git("add", "-A"), git("commit", "-qm", "x"), git("update-ref", "refs/remotes/origin/main", "HEAD")

    git("init", "-q")
    monkeypatch.setenv("IDEA_LOOM_REPO", str(repo))
    seeded_text = (db / "ideas.jsonl").read_text(encoding="utf-8")
    commit(seeded_text)
    assert cloud.import_from_main() == {"ideas": 4}
    extra = '{"at": "2026-01-02T00:00:00+00:00", "body": "别的会话提交的。", "by": "human", "event": "created", "id": "2.1", "level": "L2", "title": "别处来的"}\n'
    commit(seeded_text + extra + "读不出来的一行\n")
    assert cloud.import_from_main() == {"ideas": 1} and cloud.import_from_main() == {"ideas": 0}
    assert "2.1" in ideas.current()[0]
    assert cloud.seed_data() == []                           # 事件日志不再往数据目录里拷 / event logs are no longer copied into the data directory


def test_two_people_creating_at_once_get_different_ids(db):
    from concurrent.futures import ThreadPoolExecutor

    from idea_loom import cloud, edits

    cloud.migrate_files()
    with ThreadPoolExecutor(8) as pool:
        ids = list(pool.map(lambda i: edits.create(title=f"并发 {i}", body="同时写的。", level="L3"), range(24)))
    assert len(set(ids)) == 24 and sorted(ids, key=lambda x: int(x.split(".")[1])) == [f"3.{n}" for n in range(1, 25)]


def test_sync_from_the_hub_is_refused_in_database_mode(db):
    from idea_loom import sync

    st = sync.status()
    assert st.can_sync is False and "worker 每 15 分钟自动导出" in (st.reason or "")
