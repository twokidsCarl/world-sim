"""开发任务：把一条 idea 交给某个子项目去做的一段工作。

任务是只追加的事件。状态从"待开工"开始；从界面触发 Claude Code 之后，由作业把它推到
"方案待批""进行中""已合并"。也可以手动改状态，对应你自己开会话去做的情况。

Development tasks: a piece of work that hands an idea to a subproject. Tasks are
append-only events. A task starts as "todo"; once Claude Code is triggered from the UI,
the job moves it through "plan ready", "running" and "merged". The status can also be
set by hand, for work done in a session of your own.
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from . import edits, ideas, store
from .model import Project

Status = Literal["todo", "planning", "plan_ready", "running", "merged", "failed", "cancelled"]
STATUS_LABELS: dict[str, str] = {
    "todo": "待开工", "planning": "出方案中", "plan_ready": "方案待批", "running": "进行中",
    "merged": "已合并", "failed": "失败", "cancelled": "取消",
}
COLUMNS: list[tuple[str, list[str]]] = [("待开工", ["todo"]), ("方案待批", ["planning", "plan_ready"]), ("进行中", ["running", "failed"]), ("已合并", ["merged"])]


class TaskError(ValueError):
    """这次改动做不了，原因写给人看。 / The change cannot be made; the message is for a person."""


class TaskNote(BaseModel):
    at: str
    by: str
    text: str


class Task(BaseModel):
    task_id: str
    idea_id: Optional[str] = None
    project: str
    title: str
    brief: str = ""
    status: Status = "todo"
    status_label: str = "待开工"
    pr: Optional[int] = None
    pr_url: Optional[str] = None
    job_id: Optional[str] = None
    created_at: str
    updated_at: str
    notes: list[TaskNote] = Field(default_factory=list)


def path() -> Path:
    return store.data_dir() / "tasks.jsonl"


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def fold(rows: list[dict[str, Any]]) -> dict[str, Task]:
    out: dict[str, Task] = {}
    for r in rows:
        tid, event, at = r.get("task_id"), r.get("event"), str(r.get("at", ""))
        if not isinstance(tid, str):
            continue
        if event == "created" and tid not in out:
            out[tid] = Task(task_id=tid, idea_id=r.get("idea_id"), project=str(r.get("project", "")), title=str(r.get("title", "")),
                            brief=str(r.get("brief", "")), created_at=at, updated_at=at)
            continue
        task = out.get(tid)
        if task is None:
            continue
        task.updated_at = at
        if event == "status" and r.get("status") in STATUS_LABELS:
            task.status = r["status"]
            if isinstance(r.get("pr"), int):
                task.pr, task.pr_url = r["pr"], r.get("pr_url")
            if r.get("note"):
                task.notes.insert(0, TaskNote(at=at, by=str(r.get("by", "human")), text=str(r["note"])))
        elif event == "job":
            task.job_id = r.get("job_id")
        elif event == "noted" and r.get("text"):
            task.notes.insert(0, TaskNote(at=at, by=str(r.get("by", "human")), text=str(r["text"])))
    for task in out.values():
        task.status_label = STATUS_LABELS[task.status]
    return out


def load() -> dict[str, Task]:
    return fold(store.read_lines(path())[0])


def listing() -> list[Task]:
    return sorted(load().values(), key=lambda t: t.updated_at, reverse=True)


def get(task_id: str) -> Task:
    task = load().get(task_id)
    if task is None:
        raise TaskError(f"没有编号为 {task_id} 的任务")
    return task


def _append(task_id: str, event: str, **fields: Any) -> None:
    store.append(path(), [{"at": now(), "task_id": task_id, "event": event, **{k: v for k, v in fields.items() if v is not None}}])


def link_project(project_dir: str, idea_id: str, linked: bool = True) -> list[Project]:
    """把一条 idea 和一个子项目关联起来（或取消）。项目不在名单里就加进去。

    Link an idea to a subproject (or unlink it). A project not yet listed is added.
    """
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", project_dir):
        raise TaskError("项目目录名要短、小写，只用字母、数字和连字符")
    pool, _, _, _ = ideas.current()
    if idea_id not in pool:
        raise TaskError(f"没有编号为 {idea_id} 的 idea")
    projects = ideas.load_projects()
    project = next((p for p in projects if p.dir == project_dir), None)
    if project is None:
        project = Project(dir=project_dir, level=pool[idea_id].level if pool[idea_id].level.startswith("L") else None)
        projects.append(project)
    if linked and idea_id not in project.ideas:
        project.ideas.append(idea_id)
    if not linked and idea_id in project.ideas:
        project.ideas.remove(idea_id)
    store.write_json(store.data_dir() / "projects.json", [p.model_dump() for p in projects])
    return projects


def create(*, project: str, title: str, brief: str = "", idea_id: Optional[str] = None) -> str:
    if not title.strip():
        raise TaskError("任务要有标题")
    if idea_id:
        link_project(project, idea_id)
        pool, _, _, _ = ideas.current()
        if pool[idea_id].status == "pool":
            edits.set_status(idea_id, "building")
    elif not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", project):
        raise TaskError("项目目录名要短、小写，只用字母、数字和连字符")
    task_id = f"task-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(2)}"
    _append(task_id, "created", idea_id=idea_id, project=project, title=title.strip()[:200], brief=brief.strip()[:4000])
    return task_id


def set_status(task_id: str, status: str, *, note: str = "", pr: Optional[int] = None, pr_url: Optional[str] = None, by: str = "human") -> None:
    get(task_id)
    if status not in STATUS_LABELS:
        raise TaskError("没有这个状态")
    _append(task_id, "status", status=status, note=note.strip() or None, pr=pr, pr_url=pr_url, by=by)


def attach_job(task_id: str, job_id: str) -> None:
    get(task_id)
    _append(task_id, "job", job_id=job_id)


def add_note(task_id: str, text: str, *, by: str = "human") -> None:
    get(task_id)
    if not text.strip():
        raise TaskError("说明不能空")
    _append(task_id, "noted", text=text.strip()[:2000], by=by)
