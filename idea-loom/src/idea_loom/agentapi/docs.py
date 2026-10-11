"""给 Agent 读的文档，全部由各项目的说明生成：llms.txt、llms-full.txt、AGENTS.md。

因为是生成的，接口和数据变了它跟着变；不会出现"文档说有、实际没有"。

Documents for agents, all generated from the projects' descriptions: llms.txt, llms-full.txt
and AGENTS.md. Being generated, they follow the API and the data; "documented but not there"
cannot happen.
"""

from __future__ import annotations

import json
from typing import Any

from . import catalog as cat
from . import spec

API = cat.API


def _lines(base: str) -> tuple[dict[str, Any], dict[str, spec.AgentSpec]]:
    return cat.catalog(), spec.load_all()[0]


def llms_txt(base: str = "") -> str:
    """短的那份：有什么、从哪儿进。 / The short one: what is here and where to go in."""
    c, specs = _lines(base)
    out = [
        "# world-sim",
        "",
        f"> {c['about']['en']}",
        f"> {c['about']['zh']}",
        "",
        "Everything below is read-only or a bounded, deterministic computation. No key is needed to read; nothing here calls a language model.",
        "以下都是只读的，或者是有界的、确定性的计算。读不需要密钥；这里没有任何东西会调用语言模型。",
        "",
        "## Start here / 从这里开始",
        "",
        f"- [Catalogue]({base}{API}/catalog): every project, dataset and computation as JSON. Call this first. / 目录：全部项目、数据集和计算，JSON。先调它。",
        f"- [Full reference]({base}/llms-full.txt): every dataset and computation with its fields, input schema and a runnable example. / 完整说明：每个数据集和计算的字段、输入和能直接跑的例子。",
        f"- [OpenAPI]({base}/openapi.json) · MCP endpoint: `{base}/mcp` (or locally `uv run idea-loom mcp`).",
        "",
        "## Projects / 项目",
        "",
    ]
    for p in c["projects"]:
        out.append(f"- **{p['name']}** — {p['title']['en'] or p['title']['zh']} / {p['title']['zh']}: {p['summary']['en']}")
        for d in p["datasets"]:
            out.append(f"  - data [{d['id']}]({base}{d['describe']}): {d['title']['en']} / {d['title']['zh']} ({d['licence']})")
        for k in p["capabilities"]:
            out.append(f"  - run [{k['id']}]({base}{k['describe']}): {k['title']['en']} / {k['title']['zh']}")
    out += [
        "",
        "## Idea pool / 想法池",
        "",
        f"- [Search]({base}{API}/ideas?q=rumour): `{API}/ideas?q=&level=&thread=&kernel=&project=&full=` — titles by default, bodies with `full=true`; {c['ideas']['live']} live ideas, each a short prompt that can be handed to an agent to build a simulation. / 搜索想法池。",
        f"- One idea with history and lineage: `{API}/ideas/{{id}}` / 一条 idea 的全文、历史和血缘。",
        "",
        "## Conventions / 约定",
        "",
        "- JSON in, JSON out. Errors are `{\"error\": …, \"hint\": …}`; the hint says how to fix the request. / 只收发 JSON；错误带 hint，说明怎么改。",
        "- Dataset queries: `?q=words&where=field=value&key=K&fields=a,b&limit=20&after=0`; `next` in the reply is the `after` for the next page. / 数据集的查询参数。",
        "- Every dataset reply carries `licence` and `provenance`. Read them: some data is machine-gathered and unreviewed. / 每次返回都带许可和出处，有些数据是机器汇集、没有经人核对的。",
        "- Text fields come in Chinese and English where both exist (`zh`/`en`, or `x`/`x_en`). / 文字有中英两版时都给。",
    ]
    return "\n".join(out) + "\n"


def llms_full(base: str = "") -> str:
    """长的那份：每个数据集的字段和一条样例，每个计算的输入和例子。 / The long one: fields and a sample for every dataset, input and example for every computation."""
    from . import datasets

    c, specs = _lines(base)
    out = [llms_txt(base), "---", "", "# Full reference / 完整说明", ""]
    for name, agent in specs.items():
        out += [f"## {name}", "", agent.summary.en, "", agent.summary.zh, ""]
        for d in agent.datasets:
            try:
                info = datasets.describe(name, d)
            except datasets.DatasetError as e:
                out += [f"### data: {d.id}", "", f"(unavailable: {e})", ""]
                continue
            out += [
                f"### data: {d.id} — {d.title.en} / {d.title.zh}", "",
                d.description.en, "", d.description.zh, "",
                f"- Query: `GET {base}{API}/datasets/{name}/{d.id}?q=…&where=field=value&key=…&fields=a,b&limit=20&after=0`",
                f"- Records: {info['records']} · key field: `{d.key}` · searched: {', '.join(d.search) or 'all fields'}",
                f"- Fields: {', '.join(f'`{k}` ({v})' for k, v in info['fields'].items())}",
                f"- Licence: {d.licence}",
                f"- Provenance: {d.provenance.en}", f"- 出处：{d.provenance.zh}", "",
                "Sample record / 一条样例:", "", "```json", json.dumps(info["sample"], ensure_ascii=False, indent=2), "```", "",
            ]
        for k in agent.capabilities:
            out += [
                f"### run: {k.id} — {k.title.en} / {k.title.zh}", "",
                k.description.en, "", k.description.zh, "",
                f"- Run: `POST {base}{API}/run/{name}/{k.id}` with the input as the JSON body",
                f"- Deterministic: {'yes' if k.deterministic else 'no (depends on an external service)'} · typical time: {k.seconds:g} s",
                f"- Returns: {k.output.en} / {k.output.zh}", "",
                "Input schema / 输入:", "", "```json", json.dumps(k.input, ensure_ascii=False, indent=2), "```", "",
                "Example input / 例子:", "", "```json", json.dumps(k.example, ensure_ascii=False), "```", "",
            ]
    return "\n".join(out) + "\n"
