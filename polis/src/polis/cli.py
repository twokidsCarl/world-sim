"""命令行：跑模拟、看记录、起服务。"""

from __future__ import annotations

import json
import os
from pathlib import Path

import typer

from . import model, trace

app = typer.Typer(add_completion=False, help="polis：平行社会模拟器")


def runs_dir() -> Path:
    return Path(os.environ.get("POLIS_RUNS", Path(__file__).resolve().parents[2] / "runs"))


def _line(m: model.Manifest) -> str:
    s = m.summary
    end = f"第 {s.failed_at} 小时钱庄倒闭，{s.lost} 人受损" if s.failed_at is not None else "钱庄撑住了"
    return f"{m.run_id}  {m.n} 人 × {m.ticks} 小时  最多 {s.peak_believers} 人相信  {s.withdrew} 人取款  {end}"


@app.command()
def run(
    scenario: str = typer.Argument("rumor_run"),
    seed: int = typer.Option(1, "--seed", "-s"),
    n: int = typer.Option(1000, "--n", "-n", help="人口"),
    ticks: int = typer.Option(96, "--ticks", "-t", help="模拟多少小时"),
    quiet: bool = typer.Option(False, "--no-notice", help="掌柜不贴告示（去掉默认干预）"),
    label: str = typer.Option("", "--label", "-l", help="记录名后缀"),
):
    """跑一次模拟，记录写入 runs/。"""
    params = model.Params(scenario=scenario, seed=seed, n=n, ticks=ticks)
    if not quiet:
        params.interventions = trace.scenario_module(scenario).interventions(params.start_hour)
    m = trace.simulate(params, runs_dir(), label or ("quiet" if quiet else ""))
    typer.echo(_line(m))


@app.command("list")
def list_():
    """列出已有的运行记录。"""
    for m in trace.list_runs(runs_dir()):
        typer.echo(_line(m))


@app.command()
def schema():
    """输出数据契约的 JSON Schema（供生成 TypeScript 类型）。"""
    from pydantic.json_schema import models_json_schema

    kinds = [model.Manifest, model.Population, model.Message, model.Series, model.Event]
    _, defs = models_json_schema([(k, "serialization") for k in kinds], ref_template="#/$defs/{model}")
    typer.echo(json.dumps({"title": "Contract", "type": "object", **_plain(defs)}, ensure_ascii=False, indent=2))


def _plain(node, top: bool = True):
    """去掉字段级 title，把元组写成 json2ts 认得的形式，否则生成的类型满是别名和 unknown。"""
    if isinstance(node, list):
        return [_plain(x, False) for x in node]
    if not isinstance(node, dict):
        return node
    out = {k: _plain(v, k == "$defs") for k, v in node.items() if k != "title" or top or not isinstance(v, str)}
    if "prefixItems" in out:
        out["items"] = out.pop("prefixItems")
    return out


@app.command("corpus")
def corpus_check():
    """检查语料：格式、交叉引用，并列出还没核实出处的条目。"""
    from . import corpus

    try:
        entries, problems = corpus.check()
    except ValueError as e:  # 含 pydantic 的校验错误
        typer.echo(f"语料格式有误：{e}", err=True)
        raise typer.Exit(1)
    names = {"theory": "理论卡", "cases": "案例", "facts": "典型事实"}
    for kind, items in entries.items():
        ok = sum(e.verified for e in items)
        typer.echo(f"{names[kind]}：{len(items)} 条，其中 {ok} 条出处全部核实")
        for e in items:
            for s in e.sources:
                if not s.verified:
                    typer.echo(f"  未核实  {kind}/{e.id}  {s.author}《{s.work}》")
    for p in problems:
        typer.echo(f"  问题  {p}", err=True)
    if problems:
        raise typer.Exit(1)


@app.command()
def serve(port: int = typer.Option(8766, "--port", "-p")):
    """启动 API，供 web/ 读取运行记录。"""
    import uvicorn

    uvicorn.run("polis.server:app", host="127.0.0.1", port=port)
