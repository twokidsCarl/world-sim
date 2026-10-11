"""连续推进：主人给一个子项目事先批准"接下来最多做 N 个里程碑"。

每一步仍然先出方案、由程序重跑测试、走 PR；只是方案不再等人批。范围靠这几样限制：
Claude 只能改这个子项目的目录（权限规则）；测试两轮没过就失败，这条线随之停掉并通知；
步数用完就停；每天的作业上限和订阅额度的暂停线照样管着它。
它不会发现"这一步加了新的依赖"这类事——那要看 PR。

Chains: the owner approves "at most N more milestones" for a subproject in advance. Every
step still plans first, has its tests re-run by the program and goes through a PR; only the
plan no longer waits for approval. The scope is bounded by these: Claude can edit that
subproject's directory only (permission rules); tests failing after two repair rounds fail
the step, which stops the chain and notifies the owner; the chain ends when its steps run
out; and the daily job cap and the allowance pause still apply. It does not notice things
like a step adding a new dependency — that is for the PR to show.
"""

from __future__ import annotations

from pathlib import Path

from . import github, ideas, llm, ops, store, tasks

MAX_STEPS = 10


def _path() -> Path:
    return store.runs_dir() / "worker" / "chains.json"


def _read() -> dict[str, dict]:
    raw = store.read_json(_path(), {})
    return {str(k): v for k, v in raw.items() if isinstance(v, dict)} if isinstance(raw, dict) else {}


def load() -> dict[str, int]:
    """每个子项目还剩几步。 / How many steps each subproject has left."""
    return {k: int(v.get("left") or 0) for k, v in _read().items()}


def last_job(directory: str) -> str:
    """这条线最近开的那个作业。 / The job this chain started most recently."""
    return str(_read().get(directory, {}).get("last") or "")


def approve(directory: str, steps: int) -> dict[str, int]:
    """给这个子项目批准接下来最多几步；0 就是停。 / Approve at most this many more steps for the subproject; 0 stops it."""
    if directory not in {p.dir for p in ideas.load_projects()}:
        raise ValueError("没有这个子项目")
    if not 0 <= steps <= MAX_STEPS:
        raise ValueError(f"步数要在 0 到 {MAX_STEPS} 之间")
    chains = _read()
    if steps:
        chains[directory] = {"left": steps, "last": ""}
    else:
        chains.pop(directory, None)
    store.write_json(_path(), chains)
    return load()


def stop(directory: str) -> None:
    chains = _read()
    if chains.pop(directory, None) is not None:
        store.write_json(_path(), chains)


def use(directory: str, job_id: str) -> int:
    """用掉一步，并记下这一步是哪个作业。 / Use up one step and record which job it is."""
    chains = _read()
    left = max(0, int(chains.get(directory, {}).get("left") or 0) - 1)
    chains[directory] = {"left": left, "last": job_id}
    store.write_json(_path(), chains)
    return left


def propose(directory: str, repo: Path | None = None) -> str:
    """让模型读这个子项目的 README 和最近的合并请求，提议下一个里程碑，建成一个任务。返回任务编号。

    Have the model read the subproject's README and recent PRs and propose the next milestone as a task. Returns the task id.
    """
    project = next((p for p in ideas.load_projects() if p.dir == directory), None)
    if project is None:
        raise ValueError("没有这个子项目")
    readme = (repo or store.repo_root()) / directory / "README.md"
    text = readme.read_text(encoding="utf-8")[:9000] if readme.exists() else "（还没有 README）"
    recent = [p for p in github.pull_requests() if p.scope == directory][-15:]
    pool, _, _, _ = ideas.current()
    linked = [pool[i] for i in project.ideas if i in pool]
    prompt = (f"子项目 `{directory}`（{project.tagline}）。\n\n它的 README：\n{text}\n\n最近合并的 PR（从早到晚）：\n"
              + ("\n".join(f"- #{p.number} {p.title}" for p in recent) or "（还没有）")
              + ("\n\n它对应的 idea：\n" + "\n\n".join(ops.idea_text(i) for i in linked) if linked else "")
              + "\n\n请提议它的下一个里程碑：一件一次能做完、做完能看出差别的事。title 一句话；brief 三五句，说清做什么、做到什么算完、不做什么。用中文。")
    schema = {"type": "object", "properties": {"title": {"type": "string"}, "brief": {"type": "string"}}, "required": ["title", "brief"]}
    value = llm.ask(prompt, system="你在帮一个人决定一个模拟项目下一步做什么。只依据给你的材料，不要编造项目里没有的东西。", schema=schema, use_cache=False, purpose="advance")
    assert isinstance(value, dict)
    return tasks.create(project=directory, title=str(value["title"]), brief=str(value["brief"]), idea_id=linked[0].id if linked else None)
