"""通过本机的 `claude -p` 命令行调用大模型（子进程，不用 SDK，不需要 API key）。

设计照搬 mindloop/src/mindloop/llm.py：提示词从标准输入送入；在一个中性的临时目录里运行，
不把任何项目上下文带进去；不给工具；结果按 [模型, 系统提示, 提示词, schema] 缓存在磁盘上。
这里多做一件事：每次真实调用都往 runs/llm.jsonl 记一笔用量，供统计用。

Calls the model through the local `claude -p` CLI (a subprocess; no SDK, no API key).
The design follows mindloop/src/mindloop/llm.py: the prompt goes in on stdin; it runs
in a neutral temp directory so no project context leaks in; no tools; results are
cached on disk by [model, system, prompt, schema]. One addition: every real call is
logged with its usage to runs/llm.jsonl, for the statistics.

环境变量 / Environment:
    IDEA_LOOM_CLAUDE_BIN  claude 可执行文件 / the claude executable (default: `claude` on PATH)
    IDEA_LOOM_CACHE       磁盘缓存目录 / cache directory (default: <project>/.cache/llm)
    IDEA_LOOM_MODEL       缺省模型 / default model (default: sonnet)
    IDEA_LOOM_TIMEOUT     单次调用超时秒数 / per-call timeout in seconds (default: 180)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import time
import weakref
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from . import calls, store

DEFAULT_MODEL = "sonnet"
DEFAULT_TIMEOUT = 180.0
DEFAULT_SYSTEM = "你是一个简洁、准确的助手，只按要求输出，不加多余的话。"
CONCURRENCY = 4
ATTEMPTS = 2  # 首次 + 重试一次 / first try plus one retry

_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


class LLMError(RuntimeError):
    """claude 不可用、超时、出错，或输出不合要求。 / claude is missing, timed out, failed, or returned unusable output."""


def claude_bin() -> Optional[str]:
    env = os.environ.get("IDEA_LOOM_CLAUDE_BIN")
    if env:
        if os.path.isfile(env) and os.access(env, os.X_OK):
            return env
        return shutil.which(env)
    return shutil.which("claude")


def available() -> bool:
    if calls.remote():  # hub 自己没有 claude，看 worker 在不在 / the hub has no claude of its own; ask whether the worker is up
        return calls.worker_alive()
    return claude_bin() is not None


def default_model() -> str:
    return os.environ.get("IDEA_LOOM_MODEL") or DEFAULT_MODEL


def _timeout() -> float:
    try:
        return float(os.environ.get("IDEA_LOOM_TIMEOUT", ""))
    except ValueError:
        return DEFAULT_TIMEOUT


def cache_dir() -> Path:
    override = os.environ.get("IDEA_LOOM_CACHE")
    return Path(override) if override else Path(__file__).resolve().parents[2] / ".cache" / "llm"


def runs_dir() -> Path:
    return store.runs_dir()


def _neutral_cwd() -> str:
    path = Path(tempfile.gettempdir()) / "idea-loom-llm"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def _semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _semaphores.get(loop)
    if sem is None:
        sem = _semaphores[loop] = asyncio.Semaphore(CONCURRENCY)
    return sem


def cache_key(model: str, system: Optional[str], prompt: str, schema: Optional[dict]) -> str:
    blob = json.dumps([model, system, prompt, schema], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _cache_read(key: str) -> Any:
    try:
        return json.loads((cache_dir() / f"{key}.json").read_text(encoding="utf-8"))["value"]
    except (OSError, ValueError, KeyError):
        return None


def _cache_write(key: str, record: dict) -> None:
    try:
        store.write_json(cache_dir() / f"{key}.json", record)
    except OSError:
        pass  # 缓存写不了不影响结果 / a failed cache write does not affect the result


def build_argv(binary: str, model: str, system: Optional[str], schema: Optional[dict]) -> list[str]:
    argv = [
        binary, "-p", "--output-format", "json", "--model", model, "--tools", "",
        "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "",
        "--system-prompt", system or DEFAULT_SYSTEM,
    ]
    if schema is not None:
        argv += ["--json-schema", json.dumps(schema, ensure_ascii=False)]
    return argv


def extract_json(text: str) -> Any:
    """从一段文字里找出 JSON：先找代码块，再试全文，最后从第一个括号开始解。

    Find JSON in a piece of text: a fenced block first, then the whole text, then
    from the first bracket on.
    """
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    for candidate in ([fenced.group(1)] if fenced else []) + [text]:
        try:
            return json.loads(candidate)
        except ValueError:
            pass
    decoder = json.JSONDecoder()
    for m in re.finditer(r"[{\[]", text):
        try:
            return decoder.raw_decode(text[m.start():])[0]
        except ValueError:
            continue
    raise ValueError("输出里没有 JSON")


def result_object(stdout: str) -> dict:
    try:
        data = json.loads(stdout)
    except ValueError as e:
        raise LLMError(f"claude 输出不是 JSON: {stdout[:200]!r}") from e
    if isinstance(data, list):  # 个别版本输出事件数组 / some versions print an event array
        data = next((x for x in reversed(data) if isinstance(x, dict) and x.get("type") == "result"), None)
    if not isinstance(data, dict):
        raise LLMError("claude 输出里没有 result 对象")
    return data


def parse_output(stdout: str, schema: Optional[dict]) -> str | dict:
    data = result_object(stdout)
    if data.get("is_error"):
        raise LLMError(f"claude 报错: {str(data.get('result') or data.get('subtype'))[:300]}")
    result = data.get("result")
    if schema is None:
        if not isinstance(result, str) or not result.strip():
            raise LLMError("claude 返回了空结果")
        return result.strip()
    structured = data.get("structured_output")
    if not isinstance(structured, dict):
        try:
            structured = extract_json(result if isinstance(result, str) else "")
        except ValueError as e:
            raise LLMError(f"claude 没有按 schema 输出: {str(result)[:200]!r}") from e
    if not isinstance(structured, dict):
        raise LLMError("结构化输出不是对象")
    missing = [k for k in schema.get("required", []) if k not in structured]
    if missing:
        raise LLMError(f"结构化输出缺字段: {missing}")
    return structured


# 记 token 用的四项，名字和 Claude Code 的 usage 一样。 / The four token counts kept, named as in Claude Code's usage.
TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
_CAMEL = {"inputTokens": "input_tokens", "outputTokens": "output_tokens", "cacheReadInputTokens": "cache_read_input_tokens", "cacheCreationInputTokens": "cache_creation_input_tokens"}


def tokens_of(result: dict[str, Any]) -> dict[str, int]:
    """一条结果里的 token：有 modelUsage 就按模型加起来（它连子 Agent 和压缩都算上），没有就用 usage（只算主循环）。

    The tokens of one result: summed over models from modelUsage when present (it includes subagents and
    compaction), otherwise taken from usage (the main loop only).
    """
    per_model = result.get("modelUsage") if isinstance(result.get("modelUsage"), dict) else None
    if per_model:
        out = dict.fromkeys(TOKEN_KEYS, 0)
        for numbers in per_model.values():
            for camel, key in _CAMEL.items():
                out[key] += int((numbers or {}).get(camel) or 0) if isinstance(numbers, dict) else 0
        return out
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    return {key: int(usage.get(key) or 0) for key in TOKEN_KEYS}


def add_tokens(*parts: dict[str, Any]) -> dict[str, int]:
    """几份 token 逐项相加。 / Add several token counts item by item."""
    return {key: sum(int(p.get(key) or 0) for p in parts) for key in TOKEN_KEYS}


def usage_of(stdout: str) -> dict[str, Any]:
    """从输出里取用量和费用；取不到的项留空。 / Pull usage and cost from the output; missing items stay empty."""
    try:
        data = result_object(stdout)
    except LLMError:
        return {}
    return {"cost_usd": data.get("total_cost_usd"), **tokens_of(data)}


def log_call(purpose: str, model: str, seconds: float, usage: dict[str, Any], ok: bool) -> None:
    row = {
        "at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "purpose": purpose, "model": model, "seconds": round(seconds, 2), "ok": ok, **usage,
    }
    try:
        store.append(runs_dir() / "llm.jsonl", [row])
    except OSError:
        pass


async def _spawn(argv: list[str], prompt: str, timeout: float) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, cwd=_neutral_cwd(),
        )
    except OSError as e:
        raise LLMError(f"无法启动 claude: {e}") from e
    try:
        out, err = await asyncio.wait_for(proc.communicate(prompt.encode("utf-8")), timeout)
    except asyncio.TimeoutError:
        raise TimeoutError
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
    stdout = out.decode("utf-8", "replace")
    if proc.returncode != 0 and not stdout.strip():
        raise LLMError(f"claude 退出码 {proc.returncode}: {err.decode('utf-8', 'replace')[:300]}")
    return stdout


async def aask(
    prompt: str,
    system: Optional[str] = None,
    model: Optional[str] = None,
    schema: Optional[dict] = None,
    use_cache: bool = True,
    timeout: Optional[float] = None,
    purpose: str = "",
) -> str | dict:
    """问一次。不带 schema 返回文本，带 schema 返回 dict。失败抛 LLMError。

    use_cache=False 时既不读也不写缓存：生成类的调用每次都要新的结果。

    Ask once. Returns text without a schema and a dict with one; raises LLMError on
    failure. With use_cache=False the cache is neither read nor written: generating
    calls want a fresh result every time.
    """
    model = model or default_model()
    key = cache_key(model, system, prompt, schema)
    if use_cache:
        hit = _cache_read(key)
        if hit is not None:
            return hit
    binary = claude_bin()
    if binary is None and not calls.remote():
        raise LLMError("找不到 claude 命令（可用环境变量 IDEA_LOOM_CLAUDE_BIN 指定）")
    argv = build_argv(binary or "claude", model, system, schema)
    timeout = _timeout() if timeout is None else timeout
    last: Exception | None = None
    async with _semaphore():
        for _ in range(ATTEMPTS):
            started = time.monotonic()
            try:
                if calls.remote():
                    # hub 上：交给 worker 去跑，这里只给数据。 / On the hub: the worker runs it; only data is handed over.
                    try:
                        stdout = await asyncio.to_thread(calls.run, "llm", {"model": model, "system": system, "schema": schema, "prompt": prompt, "timeout": timeout}, timeout)
                    except RuntimeError as e:
                        raise LLMError(str(e)) from e
                else:
                    stdout = await _spawn(argv, prompt, timeout)
            except TimeoutError:
                log_call(purpose, model, time.monotonic() - started, {}, ok=False)
                raise LLMError(f"claude 超时（{timeout:g} 秒）") from None  # 超时不重试 / no retry after a timeout
            except LLMError as e:
                last = e
                log_call(purpose, model, time.monotonic() - started, {}, ok=False)
                continue
            try:
                value = parse_output(stdout, schema)
            except LLMError as e:
                last = e
                log_call(purpose, model, time.monotonic() - started, usage_of(stdout), ok=False)
                continue
            log_call(purpose, model, time.monotonic() - started, usage_of(stdout), ok=True)
            if use_cache:
                _cache_write(key, {"model": model, "system": system, "prompt": prompt, "schema": schema, "value": value})
            return value
    raise LLMError(f"claude 调用失败（已重试）: {last}") from last


def run_sync(coro):
    """在同步代码里跑一个协程；当前线程已有事件循环在跑就换个线程。

    Run a coroutine from sync code; use another thread if a loop is already running here.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    box: dict[str, Any] = {}

    def work() -> None:
        try:
            box["value"] = asyncio.run(coro)
        except BaseException as e:  # noqa: BLE001 — 原样带回调用线程 / re-raised in the caller
            box["error"] = e

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


def ask(prompt: str, **kw: Any) -> str | dict:
    """aask 的同步版本。 / The sync version of aask."""
    return run_sync(aask(prompt, **kw))
