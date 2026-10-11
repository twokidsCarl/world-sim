"""读 IDEAS.md：条目、层表、横线、内核表。

Parse IDEAS.md: entries, the level table, threads and the kernel table.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .ideas import ID_RE

ENTRY = re.compile(r"^\*\*(" + ID_RE + r") (.+?)\*\*(?:（([A-E](?:、[A-E])*)）)?\s*$")
ID_TOKEN = re.compile(ID_RE)


@dataclass
class Entry:
    id: str
    title: str
    threads: list[str]
    body: str


@dataclass
class Parsed:
    entries: list[Entry] = field(default_factory=list)
    kernels: dict[str, str] = field(default_factory=dict)  # idea id -> 内核名 / kernel name
    kernel_rows: list[tuple[str, str, str]] = field(default_factory=list)  # 名、说明、已有项目 / name, description, existing project
    levels: list[tuple[str, str, str, str]] = field(default_factory=list)  # L1、名、基元、新出现的 / id, name, unit, what emerges
    threads: list[tuple[str, str, str]] = field(default_factory=list)  # A、名、说明 / id, name, description
    intros: dict[str, str] = field(default_factory=dict)  # 纵/造/规 -> 一段说明 / intro paragraph


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse(text: str) -> Parsed:
    out = Parsed()
    lines = text.split("\n")
    i = 0
    group = ""
    while i < len(lines):
        line = lines[i]
        m = ENTRY.match(line)
        if m:
            body: list[str] = []
            i += 1
            while i < len(lines) and lines[i].strip() and not lines[i].startswith(("**", "#", "---")):
                body.append(lines[i].rstrip())
                i += 1
            threads = m.group(3).split("、") if m.group(3) else []
            out.entries.append(Entry(m.group(1), m.group(2).strip(), threads, "\n".join(body)))
            continue
        if line.startswith("### "):
            head = line[4:].strip()
            group = next((g for g in "纵造规" if head.startswith(("纵线", f"支线 {g}")) and (g == "纵" or f"支线 {g}" in head)), "")
            if head.startswith("纵线"):
                group = "纵"
            if group and i + 2 < len(lines) and lines[i + 1].strip() == "" and lines[i + 2].strip() and not ENTRY.match(lines[i + 2]):
                out.intros.setdefault(group, lines[i + 2].strip())
        elif line.startswith("| L") and re.match(r"^\| L\d+ ", line):
            c = _cells(line)
            if len(c) == 4:
                lv, _, name = c[0].partition(" ")
                out.levels.append((lv, name, c[1], c[2]))
        elif line.startswith("| **") and line.count("|") >= 6:
            c = _cells(line)
            if len(c) != 5 or not c[3].isdigit():  # 第 1 节的项目表也是这种开头 / the project table in section 1 starts the same way
                i += 1
                continue
            name = c[0].strip("*")
            project = None if c[2] in ("—", "-", "") else c[2]
            out.kernel_rows.append((name, c[1], project or ""))
            for ref in ID_TOKEN.findall(c[4]):
                out.kernels[ref] = name
        else:
            t = re.match(r"^- \*\*([A-E]) (.+?)\*\*：(.*)$", line)
            if t:
                out.threads.append((t.group(1), t.group(2), t.group(3).strip()))
        i += 1
    return out
