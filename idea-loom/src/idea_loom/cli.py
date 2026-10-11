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


@app.command()
def serve(port: int = 8767, host: str = "127.0.0.1") -> None:
    """启动后端。 / Start the backend."""
    import os

    import uvicorn

    os.environ.setdefault("IDEA_LOOM_API", f"http://{host}:{port}")  # 小助手的工具要回调这个地址 / the assistant's tools call back here
    uvicorn.run("idea_loom.server:app", host=host, port=port, log_level="warning")


if __name__ == "__main__":
    app()
