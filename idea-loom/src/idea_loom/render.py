"""从当前状态生成 IDEAS.md 里由程序维护的三块：想法池、内核表、覆盖表。

IDEAS.md 里用成对的标记圈出这三块，标记之外的文字是手写的，原样保留。

Generate the three machine-maintained blocks of IDEAS.md from the current state:
the idea pool, the kernel table and the coverage table. Paired markers fence the
blocks; everything outside them is hand-written and kept as is.
"""

from __future__ import annotations

import re

from .ideas import LADDER, LIVE, THREADS, sort_key
from .model import State

BLOCKS = ("pool", "kernels", "coverage")


def begin(name: str) -> str:
    return f"<!-- idea-loom:{name}:begin 这一段由 idea-loom 生成，不要手改 -->"


def end(name: str) -> str:
    return f"<!-- idea-loom:{name}:end -->"


def pool(state: State) -> str:
    projects = {p.level: p.dir for p in state.projects if p.level}
    out: list[str] = []
    for level in state.frame.levels:
        ideas = [i for i in state.ideas if i.level == level.id and i.status in LIVE]
        if level.kind == "ladder":
            suffix = f"（已有：{projects[level.id]}）" if level.id in projects else ""
            out.append(f"### {level.id} {level.name}{suffix}")
        else:
            out.append(f"### {level.name}")
        out.append("")
        if level.intro:
            out += [level.intro, ""]
        for idea in sorted(ideas, key=lambda i: sort_key(i.id)):
            tags = f"（{'、'.join(idea.threads)}）" if idea.threads else ""
            out += [f"**{idea.id} {idea.title}**{tags}", idea.body, ""]
    return "\n".join(out).rstrip("\n")


def kernels(state: State) -> str:
    rows = ["| 内核 | 底下在算什么 | 已有 | 条数 | 归在这里的 idea |", "|---|---|---|---|---|"]
    for k in state.kernels:
        rows.append(f"| **{k.name}** | {k.desc} | {k.project or '—'} | {len(k.ideas)} | {'、'.join(k.ideas)} |")
    return "\n".join(rows)


def coverage(state: State) -> str:
    names = {lv.id: lv.name for lv in state.frame.levels}
    head = "| | " + " | ".join(f"{t.id} {t.short}" for t in state.frame.threads) + " |"
    rows = [head, "|---" * (len(state.frame.threads) + 1) + "|"]
    for level in LADDER:
        cells = [str(len(state.coverage.cells[level][t])) if state.coverage.cells[level][t] else "—" for t in THREADS]
        rows.append(f"| {level} {names.get(level, '')} | " + " | ".join(cells) + " |")
    return "\n".join(rows)


def blocks(state: State) -> dict[str, str]:
    return {"pool": pool(state), "kernels": kernels(state), "coverage": coverage(state)}


def apply(text: str, state: State) -> str:
    """把三块生成的内容填进标记之间。缺标记就报错，不猜位置。

    Fill the generated blocks in between their markers. A missing marker is an
    error; the position is never guessed.
    """
    for name, body in blocks(state).items():
        pattern = re.compile(re.escape(begin(name)) + r".*?" + re.escape(end(name)), re.S)
        if not pattern.search(text):
            raise ValueError(f"IDEAS.md 里找不到「{name}」这一块的标记")
        text = pattern.sub(lambda _m, b=body, n=name: f"{begin(n)}\n\n{b}\n\n{end(n)}", text, count=1)
    return text


# ---------- 英文版 / English edition ----------


def pool_en(state: State) -> str:
    projects = {p.level: p.dir for p in state.projects if p.level}
    out: list[str] = []
    for level in state.frame.levels:
        ideas = [i for i in state.ideas if i.level == level.id and i.status in LIVE]
        if level.kind == "ladder":
            suffix = f" (existing: {projects[level.id]})" if level.id in projects else ""
            out.append(f"### {level.id} {level.name_en or level.name}{suffix}")
        else:
            out.append(f"### {level.name_en or level.name}")
        out.append("")
        if level.intro_en or level.intro:
            out += [level.intro_en or level.intro, ""]
        for idea in sorted(ideas, key=lambda i: sort_key(i.id)):
            tags = f" ({', '.join(idea.threads)})" if idea.threads else ""
            if idea.title_en and idea.body_en:
                stale = " *(the Chinese has changed since this translation)*" if idea.en_stale else ""
                out += [f"**{idea.id} {idea.title_en}**{tags}{stale}", idea.body_en, ""]
            else:
                out += [f"**{idea.id} {idea.title}**{tags} *(not translated yet)*", idea.body, ""]
    return "\n".join(out).rstrip("\n")


def kernels_en(state: State) -> str:
    rows = ["| Kernel | What it computes | Existing | Count | Ideas |", "|---|---|---|---|---|"]
    for k in state.kernels:
        rows.append(f"| **{k.name_en or k.name}** | {k.desc_en or k.desc} | {k.project or '—'} | {len(k.ideas)} | {', '.join(k.ideas)} |")
    return "\n".join(rows)


def coverage_en(state: State) -> str:
    names = {lv.id: lv.name_en or lv.name for lv in state.frame.levels}
    head = "| | " + " | ".join(f"{t.id} {t.short_en or t.short}" for t in state.frame.threads) + " |"
    rows = [head, "|---" * (len(state.frame.threads) + 1) + "|"]
    for level in LADDER:
        cells = [str(len(state.coverage.cells[level][t])) if state.coverage.cells[level][t] else "—" for t in THREADS]
        rows.append(f"| {level} {names.get(level, '')} | " + " | ".join(cells) + " |")
    return "\n".join(rows)


def begin_en(name: str) -> str:
    return f"<!-- idea-loom:{name}:begin generated by idea-loom, do not edit by hand -->"


def apply_en(text: str, state: State) -> str:
    """英文版用同样的三块标记。 / The English edition uses the same three marked blocks."""
    parts = {"pool": pool_en(state), "kernels": kernels_en(state), "coverage": coverage_en(state)}
    for name, body in parts.items():
        pattern = re.compile(re.escape(begin_en(name)) + r".*?" + re.escape(end(name)), re.S)
        if not pattern.search(text):
            raise ValueError(f"IDEAS.en.md has no markers for the '{name}' block")
        text = pattern.sub(lambda _m, b=body, n=name: f"{begin_en(n)}\n\n{b}\n\n{end(n)}", text, count=1)
    return text
