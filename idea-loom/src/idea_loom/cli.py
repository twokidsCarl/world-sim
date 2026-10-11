"""命令行入口。 / Command-line entry point."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import typer

from . import ideas, importer, ops, render, store, sync
from . import wishes as wish_store

app = typer.Typer(help="idea-loom：world-sim 的想法池", no_args_is_help=True)


@app.command("import")
def import_(force: bool = typer.Option(False, "--force", help="覆盖已有的事件日志")) -> None:
    """从 IDEAS.md 的 git 历史导入，生成 data/ 下的事件日志。 / Import from the git history of IDEAS.md."""
    try:
        result = importer.run(force=force)
    except FileExistsError as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(1)
    typer.echo(f"读了 {result['commits']} 个提交，写了 {result['events']} 条事件，当前 {result['ideas']} 条 idea。")


@app.command()
def status() -> None:
    """想法池现在有多少条。 / How many ideas the pool holds now."""
    s = ideas.state()
    typer.echo(f"共 {s.counts.total} 条，其中在池 {s.counts.live} 条。")
    for key, n in s.counts.by_status.items():
        if n:
            typer.echo(f"  {s.labels['status'][key]}：{n}")
    if s.unreadable:
        typer.echo(f"有 {s.unreadable} 行读不出来。", err=True)


@app.command("render")
def render_(
    block: Optional[str] = typer.Option(None, help="只输出一块：pool / kernels / coverage"),
    write: bool = typer.Option(False, "--write", help="写回 IDEAS.md 里标记圈出的三块"),
) -> None:
    """生成 IDEAS.md 里由程序维护的部分。 / Generate the machine-maintained parts of IDEAS.md."""
    s = ideas.state()
    if write:
        for name, apply in (("IDEAS.md", render.apply), ("IDEAS.en.md", render.apply_en)):
            path = store.repo_root() / name
            if path.exists():
                path.write_text(apply(path.read_text(encoding="utf-8"), s), encoding="utf-8")
                typer.echo(f"已更新 {path}")
        return
    parts = render.blocks(s)
    typer.echo(parts[block] if block else "\n\n".join(parts[b] for b in render.BLOCKS))


@app.command()
def translate() -> None:
    """把还没有英文的 idea 译成英文。 / Translate ideas that have no English yet."""
    pool, _, _, _ = ideas.current()
    todo = ops.untranslated(pool)
    typer.echo(f"要翻译 {len(todo)} 条…")
    done = ops.translate()
    typer.echo(f"译好 {len(done)} 条。")


@app.command("sync")
def sync_(title: Optional[str] = typer.Option(None, help="PR 的标题 / PR title")) -> None:
    """重新生成 IDEAS.md，把想法池的改动提交成一个 PR。 / Regenerate IDEAS.md and open a PR."""
    st = sync.status()
    typer.echo(f"未同步的事件：{st.pending}；IDEAS.md {'需要更新' if st.ideas_md_stale else '是最新的'}。")
    result = sync.run(title)
    typer.echo(result.message + (f" {result.pr_url}" if result.pr_url else ""))
    if not result.ok:
        raise typer.Exit(1)


@app.command()
def schema() -> None:
    """输出数据契约的 JSON Schema，前端类型由它生成。 / Print the JSON Schema of the data contract."""
    from pydantic.json_schema import models_json_schema

    from .model import IdeaDetail, State

    _, defs = models_json_schema([(State, "serialization"), (IdeaDetail, "serialization"), (sync.SyncStatus, "serialization"), (sync.SyncResult, "serialization"), (ops.Proposal, "serialization")])
    # 后端序列化时每个字段都会写出来，所以在类型里全部标成必有。
    # The backend always serialises every field, so mark them all required in the types.
    for definition in defs["$defs"].values():
        if "properties" in definition:
            definition["required"] = list(definition["properties"])
    root = {
        "title": "Contract",
        "type": "object",
        "properties": {"state": {"$ref": "#/$defs/State"}, "idea": {"$ref": "#/$defs/IdeaDetail"}},
        "required": ["state", "idea"],
        **defs,
    }
    typer.echo(json.dumps(root, ensure_ascii=False, indent=2))


wishes_app = typer.Typer(help="许愿池：给处理愿望的 Claude Code 会话用 / the wish pool, for the Claude Code session handling a wish", no_args_is_help=True)
app.add_typer(wishes_app, name="wishes")


def _wish(fn, *args, **kw) -> None:
    try:
        fn(*args, **kw)
    except wish_store.WishError as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(1)


@wishes_app.command("list")
def wishes_list(status: Optional[str] = typer.Option(None, help="open / accepted / done / declined / withdrawn")) -> None:
    """未处理和已采纳的愿望，遇到次数多的在前。 / Open and accepted wishes, most often met first."""
    for w in wish_store.listing(status).wishes:
        typer.echo(f"{w.wish_id}  [{w.status_label}] ×{w.occurrences}  {w.kind_label}  {w.title}")


@wishes_app.command("show")
def wishes_show(wish_id: str) -> None:
    """一条愿望的全部内容。 / Everything about one wish."""
    try:
        w = wish_store.get(wish_id)
    except wish_store.WishError as e:
        typer.echo(str(e), err=True)
        raise typer.Exit(1)
    typer.echo(f"{w.wish_id}  [{w.status_label}] ×{w.occurrences}  {w.kind_label}\n{w.title}\n\n卡在哪：{w.stuck}\n建议：{w.suggestion}")
    if w.where:
        typer.echo(f"出在：{w.where.title} {w.where.url}")
    for seen in w.seen:
        typer.echo(f"  遇到 {seen.at}：{seen.question}")
    for n in w.notes:
        typer.echo(f"  说明（{n.by_label}）：{n.text}")


@wishes_app.command("accept")
def wishes_accept(wish_id: str, note: str = typer.Option("", help="一句说明")) -> None:
    """采纳：这条归你做了，内容从此冻结。 / Accept: it is yours now and its text is frozen."""
    _wish(wish_store.set_status, wish_id, "accepted", note=note)


@wishes_app.command("note")
def wishes_note(wish_id: str, text: str = typer.Option(..., help="说明的内容")) -> None:
    """加一条说明。 / Add a note."""
    _wish(wish_store.add_note, wish_id, text)


@wishes_app.command("link")
def wishes_link(wish_id: str, pr: Optional[int] = typer.Option(None), plan: Optional[str] = typer.Option(None, help="方案的链接"),
                title: str = typer.Option(""), url: Optional[str] = typer.Option(None)) -> None:
    """关联一个方案或合并请求。 / Link a plan or a pull request."""
    if pr is not None:
        _wish(wish_store.add_link, wish_id, "pr", title=title, url=url, pr=pr)
    elif plan:
        _wish(wish_store.add_link, wish_id, "plan", title=title, url=plan)
    else:
        typer.echo("要给 --pr 或 --plan", err=True)
        raise typer.Exit(2)


@wishes_app.command("done")
def wishes_done(wish_id: str, pr: int = typer.Option(..., help="合并了的 PR 编号"), note: str = typer.Option("")) -> None:
    """做完了。只有真的合并了才标。 / Done. Only once it is really merged."""
    _wish(wish_store.set_status, wish_id, "done", note=note, pr=pr)


@wishes_app.command("decline")
def wishes_decline(wish_id: str, note: str = typer.Option(..., help="为什么不做")) -> None:
    """不做，要写原因。 / Decline, with a reason."""
    _wish(wish_store.set_status, wish_id, "declined", note=note)


play_app = typer.Typer(help="统一入口里托管的模拟 / the simulations hosted by the single entry point", no_args_is_help=True)
app.add_typer(play_app, name="play")


@play_app.command("status")
def play_status() -> None:
    """每个模拟的构建状态。 / The build state of every simulation."""
    from .play import manifest, snapshot, supervisor

    sims, problems = manifest.load_all()
    for sim in sims:
        state = snapshot.status(sim.name)
        api = "后端在跑" if supervisor.running(sim.name) else ("有后端" if sim.api else "纯静态")
        typer.echo(f"{sim.name:10} {state.status:9} {state.version[:12] or '-':12} {len(sim.cards):3} 张卡  {api}  名片来自{'项目' if sim.source == 'project' else ' idea-loom（临时）'}{'  有新版本' if state.stale else ''}")
    for p in problems:
        typer.echo(f"{p.name}: 名片读不出来：{p.error}", err=True)


@play_app.command("build")
def play_build(name: Optional[str] = typer.Argument(None, help="不给就全部构建"), wait: bool = typer.Option(True, help="等它做完")) -> None:
    """取 main 的快照并构建。 / Take a snapshot of main and build it."""
    import time

    from .play import manifest, snapshot

    snapshot.fetch(max_age=0)
    targets = [name] if name else manifest.names()
    for n in targets:
        snapshot.ensure(n, force=True)
    while wait and any(snapshot.status(n).status == "building" for n in targets):
        time.sleep(1)
    for n in targets:
        state = snapshot.status(n)
        typer.echo(f"{n}: {state.status}")
        if state.status == "failed":
            typer.echo(state.log[-1200:], err=True)


db_app = typer.Typer(help="数据库：设了 IDEA_LOOM_DB 时事件日志存在这里 / the database that holds the event logs when IDEA_LOOM_DB is set", no_args_is_help=True)
app.add_typer(db_app, name="db")


def _need_db() -> None:
    if store.db_path() is None:
        typer.echo("没有设置 IDEA_LOOM_DB：现在用的是文件。 / IDEA_LOOM_DB is not set: files are in use.")
        raise typer.Exit(1)


@db_app.command("status")
def db_status() -> None:
    """每条日志有多少事件。 / How many events each log holds."""
    _need_db()
    typer.echo(str(store.db_path()))
    for stream, n in store.counts().items():
        typer.echo(f"  {stream:<10} {n}")


@db_app.command("import")
def db_import(main: bool = typer.Option(True, help="也把 origin/main 上的事件文件并进来 / also merge the event files on origin/main")) -> None:
    """把现有的事件文件并进数据库。可以反复做，不会重复。 / Merge the existing event files into the database. Repeatable without duplicates."""
    from . import cloud

    _need_db()
    for label, added in (("文件 / files", cloud.migrate_files()), ("main", cloud.import_from_main() if main else {})):
        for stream, n in added.items():
            typer.echo(f"{label}  {stream:<10} +{n}")


@db_app.command("export")
def db_export(out: str = typer.Argument(..., help="导出到哪个目录 / the directory to export into")) -> None:
    """把 idea、愿望、任务导出成仓库里那种事件文件。 / Export ideas, wishes and tasks as the event files the repository holds."""
    from pathlib import Path

    _need_db()
    target = Path(out)
    target.mkdir(parents=True, exist_ok=True)
    for stream in store.DATA_STREAMS:
        text = store.export_text(stream)
        (target / f"{stream}.jsonl").write_text(text, encoding="utf-8")
        typer.echo(f"{stream:<10} {text.count(chr(10))}")


@app.command("worker")
def worker_(once: bool = typer.Option(False, help="只看一遍队列就退出 / look over the queue once and exit")) -> None:
    """云端跑作业的进程：从队列里取主人批准过的事来做。 / The process that runs jobs in the cloud, taking what the owner approved from the queue."""
    from . import worker

    w = worker.Worker()
    if once:
        typer.echo(json.dumps(w.tick(), ensure_ascii=False))
    else:
        w.loop()


@app.command("build-ui")
def build_ui() -> None:
    """把 idea-loom 自己的界面构建成静态文件，由后端直接提供。 / Build idea-loom's own UI into static files served by the backend."""
    import subprocess

    web = store.repo_root() / "idea-loom" / "web"
    for command in (["bun", "install"], ["bunx", "vite", "build"]):
        typer.echo("$ " + " ".join(command))
        if subprocess.run(command, cwd=web).returncode != 0:
            raise typer.Exit(1)
    typer.echo("好了。现在只要 uv run idea-loom serve 一个进程。")


@app.command()
def serve(port: int = 8767, host: str = "127.0.0.1") -> None:
    """启动后端。 / Start the backend."""
    import os

    import uvicorn

    from .play import host as play_host

    if not (play_host.ui_dist() / "index.html").is_file():
        typer.echo("界面还没有构建：先运行 uv run idea-loom build-ui（或者另开一个终端 cd web && bun run dev 用开发服务器）。", err=True)
    typer.echo(f"打开 http://localhost:{port}")
    os.environ.setdefault("IDEA_LOOM_API", f"http://{host}:{port}")  # 小助手的工具要回调这个地址 / the assistant's tools call back here
    uvicorn.run("idea_loom.server:app", host=host, port=port, log_level="warning")


if __name__ == "__main__":
    app()
