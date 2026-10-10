"""命令行入口。"""

from __future__ import annotations

import typer

from . import recursion, runner
from .cases import all_cases
from .model import CATEGORY_LABELS, Signaling

app = typer.Typer(help="mindloop：两人「我猜你猜我」互动模拟器", no_args_is_help=True)


@app.command("list")
def list_cmd():
    """列出案例库。"""
    cases = all_cases().values()
    for cid, label in CATEGORY_LABELS.items():
        typer.echo(f"\n【{label}】")
        for c in (c for c in cases if c.category == cid):
            mark = "▶" if c.runnable else "·"
            typer.echo(f"  {mark} {c.id:<22} {c.title}  —— {c.source.work} {c.source.locator}")


@app.command()
def run(
    case_id: str,
    depth_a: int = typer.Option(None, "--depth-a", "-a", help="a 想到第几层（缺省为原作）"),
    depth_b: int = typer.Option(None, "--depth-b", "-b", help="b 想到第几层（缺省为原作）"),
    lam: float = typer.Option(None, "--lam", help="两人的理性度"),
):
    """跑一次，打印两个人脑中的塔和结局。"""
    res = runner.compute(runner.Params(case_id=case_id, depth_a=depth_a, depth_b=depth_b, lam_a=lam, lam_b=lam))
    case = res["case"]
    typer.echo(f"{case['title']}  ——  {case['source']['work']} {case['source']['locator']}")
    for r in ("a", "b"):
        me, you = case[r]["name"], case["b" if r == "a" else "a"]["name"]
        typer.echo(f"\n{me}（想到第 {res['depth'][r]} 层）")
        for lv in reversed(res["towers"][r]):
            indent = "  " * (res["depth"][r] - lv["level"] + 1)
            who = me if lv["role"] == r else you
            typer.echo(f"{indent}[{lv['level']}] {who}：{lv['line']}")
    out = res["outcome"]
    ta, tb = res["towers"]["a"][-1], res["towers"]["b"][-1]
    typer.echo(f"\n结局：{case['a']['name']}「{ta['cols'][out['choice_a']]}」 / {case['b']['name']}「{tb['cols'][out['choice_b']]}」")
    typer.echo(f"收益：{out['payoff_a']:+.1f} / {out['payoff_b']:+.1f}")
    if res["canonical_match"]:
        typer.echo("与原作一致 ✓" if res["canonical_match"]["all"] else "与原作不同 ✗")


@app.command()
def sweep(case_id: str, depth: int = typer.Option(10, "--depth", "-d"), lam: float = typer.Option(None, "--lam")):
    """层数一路加深：每层两人的结论、指标，以及最终是收敛还是震荡。"""
    case, _, lams = runner.prepare(runner.Params(case_id=case_id, lam_a=lam, lam_b=lam))
    g = case.game
    res = recursion.analyze(g, depth, lams)
    row_a = g.true_state if isinstance(g, Signaling) else 0
    typer.echo(f"{case.title}：{case.a.name} vs {case.b.name}")
    for lv in res["levels"]:
        a, b, m = lv["a"], lv["b"], lv["metrics"]
        ca = a["cols"][a["choice"][row_a]]
        row_b = a["choice"][row_a] if isinstance(g, Signaling) else 0
        cb = b["cols"][b["choice"][row_b]]
        extra = "  ".join(f"{k}={v:.2f}" for k, v in m.items())
        typer.echo(f"  第{lv['d']:>2}层  {ca} ｜ {cb}    {extra}")
    verdict = {"converged": "收敛", "cycle": f"震荡，周期 {res['period']}", "unsettled": "尚未稳定"}[res["verdict"]]
    typer.echo(f"走向：{verdict}（从第 {res['settles_at']} 层起）" if res["settles_at"] is not None else f"走向：{verdict}")
    eq = recursion.equilibrium(g, lams)
    typer.echo("无限层极限：" + "  ".join(f"{k}={v:.2f}" for k, v in eq["metrics"].items()))


@app.command()
def serve(port: int = typer.Option(8765, "--port", "-p"), host: str = "127.0.0.1"):
    """启动界面。"""
    import uvicorn

    typer.echo(f"打开 http://{host}:{port}")
    uvicorn.run("mindloop.server:app", host=host, port=port, log_level="warning")


# ---------- 大模型相关：独白、导出、测评（经本机 claude -p） ----------


def _print_narration(rec: dict) -> None:
    case = rec["case"]
    src = rec["source"]
    typer.echo(f"{case['title']}  ——  {src['work']} {src['locator']}")
    for r in ("a", "b"):
        me, you = case[r]["name"], case["b" if r == "a" else "a"]["name"]
        typer.echo(f"\n{me}（想到第 {rec['depth'][r]} 层）")
        for lv in reversed(rec["towers"][r]):
            indent = "  " * (rec["depth"][r] - lv["level"] + 1)
            who = me if lv["role"] == r else you
            typer.echo(f"{indent}[{lv['level']}] {who}：{lv['line']}")
            typer.echo(f"{indent}    ↳ {lv['monologue']}  ({lv['monologue_source']})")
    out = rec["outcome"]
    ta, tb = rec["towers"]["a"][-1], rec["towers"]["b"][-1]
    typer.echo(f"\n结局：{case['a']['name']}「{ta['cols'][out['choice_a']]}」 / {case['b']['name']}「{tb['cols'][out['choice_b']]}」")


@app.command()
def narrate(
    case_id: str,
    depth_a: int = typer.Option(None, "--depth-a", "-a", help="a 想到第几层（缺省为原作）"),
    depth_b: int = typer.Option(None, "--depth-b", "-b", help="b 想到第几层（缺省为原作）"),
    neutral: bool = typer.Option(False, "--neutral", help="隐去人名与人设（甲/乙）"),
    regenerate: bool = typer.Option(False, "--regenerate", help="不读缓存，重新生成"),
):
    """打印两座塔，每一层配一段由 claude 生成的内心独白。"""
    from . import export as export_mod
    from . import llm

    if not llm.available():
        typer.echo("（找不到 claude 命令，独白退回模板句）", err=True)
    p = runner.Params(case_id=case_id, depth_a=depth_a, depth_b=depth_b)
    rec = llm.run_sync(export_mod.narrate(p, persona_mode="neutral" if neutral else "original", regenerate=regenerate))
    _print_narration(rec)


@app.command("export")
def export_cmd(
    case_id: str,
    depth_a: int = typer.Option(None, "--depth-a", "-a"),
    depth_b: int = typer.Option(None, "--depth-b", "-b"),
    out: str = typer.Option(None, "--out", "-o", help="追加写入这个 .jsonl 文件（缺省打印到屏幕）"),
    no_llm: bool = typer.Option(False, "--no-llm", help="不调用模型，独白用模板句代替"),
):
    """导出一条 JSON 记录：案例、出处、两座塔（每层带模板句和独白）、结局。"""
    import json

    from . import export as export_mod
    from . import llm

    p = runner.Params(case_id=case_id, depth_a=depth_a, depth_b=depth_b)
    rec = llm.run_sync(export_mod.narrate(p, use_llm=not no_llm))
    line = json.dumps(rec, ensure_ascii=False)
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        typer.echo(f"已写入 {out}")
    else:
        typer.echo(line)


bench_app = typer.Typer(help="递归心智选择题：由引擎出题并给标准答案", no_args_is_help=True)
app.add_typer(bench_app, name="bench")


@bench_app.command("generate")
def bench_generate(
    out: str = typer.Option("bench.jsonl", "--out", "-o"),
    depths: str = typer.Option("0..4", "--depths", help="如 0..4 或 0,2,4"),
    margin: float = typer.Option(None, "--margin", help="标准答案至少领先第二名多少概率（缺省 0.2）"),
):
    """为每个可运行案例、每个层数出题，写成 JSONL。"""
    from . import bench

    try:
        ds = bench.parse_depths(depths)
    except ValueError as e:
        raise typer.BadParameter(str(e))
    items = bench.generate(ds, bench.MARGIN if margin is None else margin)
    bench.write_jsonl(items, out)
    per_depth = {d: sum(1 for it in items if it["depth"] == d) for d in ds}
    typer.echo(f"已写入 {out}：{len(items)} 题，来自 {len({it['case_id'] for it in items})} 个案例")
    typer.echo("各层题数：" + "  ".join(f"第{d}层 {n}" for d, n in per_depth.items()))


@bench_app.command("run")
def bench_run(
    path: str,
    model: str = typer.Option(None, "--model", "-m", help="缺省 sonnet（或环境变量 MINDLOOP_MODEL）"),
    limit: int = typer.Option(None, "--limit", "-n", help="只做前 N 题"),
    no_cache: bool = typer.Option(False, "--no-cache", help="不读缓存"),
):
    """让模型作答，打印总正确率和各层正确率。"""
    from . import bench, llm

    if not llm.available():
        typer.echo("找不到 claude 命令，无法测评", err=True)
        raise typer.Exit(1)
    items = bench.read_jsonl(path)
    if limit is not None:
        items = items[:limit]
    res = bench.run(items, model=model, use_cache=not no_cache)
    typer.echo(f"模型 {res['model']}：{res['correct']}/{res['n']} = {res['accuracy']:.1%}（瞎猜约 {res['chance']:.1%}）")
    for d, s in res["by_depth"].items():
        typer.echo(f"  第{d:>2}层  {s['correct']}/{s['n']} = {s['accuracy']:.1%}")
    if res["errors"]:
        typer.echo(f"其中 {res['errors']} 题调用失败或答非所问，按错计。")


if __name__ == "__main__":
    app()
