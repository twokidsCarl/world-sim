"""命令行：跑模拟、看记录、起服务。/ The command line: run simulations, list records, start the server."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

import typer

from . import model, trace

app = typer.Typer(add_completion=False, help="polis：平行社会模拟器 / polis: a parallel-society simulator")


CALIBRATION = Path(__file__).resolve().parents[2] / "calibration.json"


def runs_dir() -> Path:
    return Path(os.environ.get("POLIS_RUNS", Path(__file__).resolve().parents[2] / "runs"))


def _line(m: model.Manifest) -> str:
    s = m.summary
    end = f"第 {s.failed_at} 小时倒闭，{s.lost} 人受损" if s.failed_at is not None else "撑住了"
    return f"{m.run_id}  {m.n} 人 × {m.ticks} 小时  最多 {s.peak_believers} 人相信  {s.withdrew} 人取款  {end}"


@app.command()
def run(
    scenario: str = typer.Argument("rumor_run"),
    seed: int = typer.Option(1, "--seed", "-s"),
    n: int = typer.Option(1000, "--n", "-n", help="人口 / population size"),
    ticks: Optional[int] = typer.Option(None, "--ticks", "-t", help="模拟多少小时（缺省由场景决定）/ hours to simulate (the scenario sets the default)"),
    response: str = typer.Option("notice", "--response", "-r", help="谁出面回应：notice 场景里原有的回应 / guarantee 可信一方担保 / none 无人回应 / who responds: notice = the scenario's own response, guarantee = a guarantee from a credible party, none = nobody"),
    calibrated: bool = typer.Option(False, "--calibrated", "-c", help="用 calibration.json 里校准过的参数 / use the calibrated parameters in calibration.json"),
    llm: bool = typer.Option(False, "--llm", help="主角交给大模型扮演（走本机 claude 命令）/ let the model play the protagonists"),
    label: str = typer.Option("", "--label", "-l", help="记录名后缀 / suffix for the run id"),
):
    """跑一次模拟，记录写入 runs/。/ Run one simulation and write the record to runs/."""
    from . import calibrate as cal

    over = json.loads(CALIBRATION.read_text(encoding="utf-8"))["calibrated"]["params"] if calibrated else {}
    sc = trace.scenario_module(scenario)
    params = model.Params(scenario=scenario, seed=seed, n=n, **(sc.DEFAULTS | over | ({"ticks": ticks} if ticks else {})))
    responses = {
        "notice": sc.interventions,
        "guarantee": cal.guarantee,
        "none": lambda start_hour: [],
    }
    if response not in responses:
        raise typer.BadParameter(f"只能是 {' / '.join(responses)}", param_hint="--response")
    params.interventions = responses[response](params.start_hour)
    params.llm = llm
    parts = ["cal" if calibrated else "", "" if response == "notice" else response, "llm" if llm else ""]
    m = trace.simulate(params, runs_dir(), label or "-".join(x for x in parts if x))
    typer.echo(_line(m))
    if llm:
        typer.echo(f"模型调用 {m.summary.llm_calls} 次，其中 {m.summary.llm_failed} 次失败后退回数值规则")


@app.command("list")
def list_():
    """列出已有的运行记录。/ List the existing run records."""
    for m in trace.list_runs(runs_dir()):
        typer.echo(_line(m))


@app.command()
def schema():
    """输出数据契约的 JSON Schema（供生成 TypeScript 类型）。/ Print the JSON Schema of the data contract, from which the TypeScript types are generated."""
    from pydantic.json_schema import models_json_schema

    from . import corpus

    kinds = [model.Manifest, model.Population, model.Message, model.Series, model.Event, corpus.Theory, corpus.Case, corpus.Fact]
    _, defs = models_json_schema([(k, "serialization") for k in kinds], ref_template="#/$defs/{model}")
    typer.echo(json.dumps({"title": "Contract", "type": "object", **_plain(defs)}, ensure_ascii=False, indent=2))


def _plain(node, top: bool = True):
    """去掉字段级 title，把元组写成 json2ts 认得的形式，否则生成的类型满是别名和 unknown。
    Drop field-level titles and write tuples in the form json2ts understands; otherwise the generated types are full of aliases and unknown.
    """
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
    """检查语料：格式、交叉引用，并列出还没核实出处的条目。/ Check the corpus: format and cross-references, and list entries whose sources are not yet verified."""
    from . import corpus

    try:
        entries, problems = corpus.check()
    except ValueError as e:  # 含 pydantic 的校验错误 / includes pydantic validation errors
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
def calibrate(
    samples: int = typer.Option(60, "--samples", help="随机试多少组参数 / how many random parameter sets to try"),
    seeds: int = typer.Option(3, "--seeds", help="每组参数跑几个种子 / seeds to run for each parameter set"),
    n: int = typer.Option(600, "--n", "-n", help="人口 / population size"),
    save: bool = typer.Option(False, "--save", help="把找到的参数写入 calibration.json / write the parameters found to calibration.json"),
):
    """对照语料里的典型事实，报告默认参数的偏差，并搜索更合的参数。/ Report how far the default parameters miss the stylised facts in the corpus, and search for a better fit."""
    from . import calibrate as cal

    ts, default, over, best = cal.search(samples, list(range(1, seeds + 1)), n, log=typer.echo)
    typer.echo(f"\n{'指标':<22}{'目标范围':<16}{'默认参数':<12}{'校准后':<12}出处")
    for t in ts:
        row = [f"[{t.lo:g}, {t.hi:g}]", f"{default[1][t.metric]:.3f}", f"{best[1][t.metric]:.3f}"]
        typer.echo(f"{t.metric:<22}{row[0]:<20}{row[1]:<16}{row[2]:<15}{t.source}")
    typer.echo(f"总偏差：默认 {default[0]:.3f} → 校准后 {best[0]:.3f}")
    typer.echo(f"参数：{over or '默认参数已是最好'}")
    if save and over:
        path = CALIBRATION
        report = {
            "note": "随机搜索得到的一组与目标不矛盾的参数；目标少、参数多，不是唯一解。",
            "samples": samples, "seeds": seeds, "n": n,
            "targets": [t.__dict__ for t in ts],
            "default": {"miss": default[0], "metrics": default[1]},
            "calibrated": {"miss": best[0], "metrics": best[1], "params": over},
        }  # fmt: skip
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        typer.echo(f"已写入 {path.name}")


@app.command()
def canon(seeds: int = typer.Option(30, "--seeds", help="丰川场景跑几个种子 / seeds for the Toyokawa replay")):
    """对照原作与史料，逐条看模拟对上了没有。/ Check the simulation against the source texts and records."""
    from . import canon as cn

    over = json.loads(CALIBRATION.read_text(encoding="utf-8"))["calibrated"]["params"] if CALIBRATION.is_file() else {}
    fresh = list(range(101, 101 + seeds))  # 校准用的是 1 起的种子，这里换一批 / calibration used seeds from 1; these are different
    checks = cn.sanren(model.Params(**over)) + cn.toyokawa(over, fresh) + cn.bea(over, fresh)
    for c in checks:
        mark = "对上" if c.passed == c.runs else ("部分" if c.passed else "没对上")
        kind = "校准过" if c.fitted else "样本外"
        typer.echo(f"[{mark}] {c.case}  {c.what}  →  {c.got}  （{kind}）")
    held = [c for c in checks if not c.fitted]
    typer.echo(f"样本外检验：{sum(c.passed for c in held)}/{sum(c.runs for c in held)} 次对上")


@app.command()
def serve(port: int = typer.Option(8766, "--port", "-p")):
    """启动 API，供 web/ 读取运行记录。/ Start the API that web/ reads run records from."""
    import uvicorn

    uvicorn.run("polis.server:app", host="127.0.0.1", port=port)
