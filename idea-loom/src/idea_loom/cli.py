"""命令行入口。 / Command-line entry point."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import typer

from . import ideas, importer, ops, render, store, sync

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


@app.command()
def serve(port: int = 8767, host: str = "127.0.0.1") -> None:
    """启动后端。 / Start the backend."""
    import uvicorn

    uvicorn.run("idea_loom.server:app", host=host, port=port, log_level="warning")


if __name__ == "__main__":
    app()
