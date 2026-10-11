"""通过本机的 `claude -p` 命令行调用大模型（子进程，不用 SDK，不需要 API key）。

Call the model through the local `claude -p` command line (a subprocess; no SDK, no API key).

    claude -p --output-format json --model <m> --tools "" --no-session-persistence
           --strict-mcp-config --setting-sources "" --system-prompt <s> [--json-schema <schema>]

提示词从标准输入送入（不经 shell，也不受命令行长度限制）；在一个中性的临时目录里运行，
这样不会把任何项目上下文带进去。返回的 JSON 里 `result` 是文本，带 schema 时
`structured_output` 是结构化结果。

The prompt goes in on standard input (no shell involved, no command-line length limit); the
command runs in a neutral temporary directory so that no project context comes along. In the
returned JSON, `result` is the text and, when a schema is given, `structured_output` is the
structured result.

环境变量 / Environment variables:
    MINDLOOP_CLAUDE_BIN  claude 可执行文件（缺省在 PATH 里找 `claude`）
                         claude executable (default: look up `claude` on PATH)
    MINDLOOP_CACHE       磁盘缓存目录 / disk cache directory
                         （缺省 $WORLD_SIM_STATE/llm；再没有就是 <项目根>/.cache/llm）
                         (default $WORLD_SIM_STATE/llm, else <project root>/.cache/llm)
    MINDLOOP_MODEL       缺省模型（缺省 sonnet） / default model (default sonnet)
    MINDLOOP_TIMEOUT     单次调用超时秒数（缺省 90） / per-call timeout in seconds (default 90)
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
import weakref
from pathlib import Path
from typing import Any, Optional

DEFAULT_MODEL = "sonnet"
DEFAULT_TIMEOUT = 90.0
DEFAULT_SYSTEM = "你是一个简洁、准确的助手，只按要求输出，不加多余的话。"
CONCURRENCY = 4
ATTEMPTS = 2  # 首次 + 重试一次 / first try + one retry

_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


class LLMError(RuntimeError):
    """claude 不可用、超时、出错，或输出不合要求。

    claude is unavailable, timed out, failed, or produced output that does not meet the requirements.
    """


# ---------- 配置 / Configuration ----------


def claude_bin() -> Optional[str]:
    """claude 可执行文件的路径；找不到返回 None。

    Path of the claude executable; None if it cannot be found.
    """
    env = os.environ.get("MINDLOOP_CLAUDE_BIN")
    if env:
        if os.path.isfile(env) and os.access(env, os.X_OK):
            return env
        return shutil.which(env)
    return shutil.which("claude")


def available() -> bool:
    return claude_bin() is not None


def default_model() -> str:
    return os.environ.get("MINDLOOP_MODEL") or DEFAULT_MODEL


def cache_dir() -> Path:
    """缓存写到哪里：MINDLOOP_CACHE > $WORLD_SIM_STATE/llm > <项目根>/.cache/llm。

    Where the cache goes. Under the shared host (idea-loom) the project directory is a
    snapshot that is replaced on every release, so run-time data belongs in WORLD_SIM_STATE.
    """
    env = os.environ.get("MINDLOOP_CACHE")
    if env:
        return Path(env)
    state = os.environ.get("WORLD_SIM_STATE")
    if state:
        return Path(state) / "llm"
    return Path(__file__).resolve().parents[2] / ".cache" / "llm"


def _timeout() -> float:
    try:
        return float(os.environ.get("MINDLOOP_TIMEOUT", DEFAULT_TIMEOUT))
    except ValueError:
        return DEFAULT_TIMEOUT


def _neutral_cwd() -> str:
    d = Path(tempfile.gettempdir()) / "mindloop-llm"
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


def _semaphore() -> asyncio.Semaphore:
    """全模块共用的并发上限（每个事件循环一把，避免跨循环复用出错）。

    Module-wide concurrency limit (one semaphore per event loop, so none is reused across loops).
    """
    loop = asyncio.get_running_loop()
    sem = _semaphores.get(loop)
    if sem is None:
        sem = _semaphores[loop] = asyncio.Semaphore(CONCURRENCY)
    return sem


# ---------- 缓存 / Cache ----------


def cache_key(model: str, system: Optional[str], prompt: str, schema: Optional[dict]) -> str:
    blob = json.dumps([model, system, prompt, schema], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _cache_read(key: str) -> Any:
    try:
        return json.loads((cache_dir() / f"{key}.json").read_text(encoding="utf-8"))["value"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _cache_write(key: str, record: dict) -> None:
    try:
        d = cache_dir()
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f"{key}.{os.getpid()}.{threading.get_ident()}.tmp"
        tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, d / f"{key}.json")
    except OSError:
        pass  # 缓存写不进去不影响结果 / a failed cache write does not affect the result


# ---------- 调用 / Calling ----------


def build_argv(binary: str, model: str, system: Optional[str], schema: Optional[dict]) -> list[str]:
    argv = [
        binary,
        "-p",
        "--output-format", "json",
        "--model", model,
        "--tools", "",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--system-prompt", system or DEFAULT_SYSTEM,
    ]  # fmt: skip
    if schema is not None:
        argv += ["--json-schema", json.dumps(schema, ensure_ascii=False)]
    return argv


def extract_json(text: str) -> Any:
    """从一段文字里抠出 JSON（容忍 ```json 围栏和前后的闲话）。

    Dig the JSON out of a piece of text (tolerates ```json fences and chatter before or after).
    """
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    for candidate in ([fenced.group(1)] if fenced else []) + [text]:
        try:
            return json.loads(candidate)
        except ValueError:
            pass
    dec = json.JSONDecoder()
    for m in re.finditer(r"[{\[]", text):
        try:
            return dec.raw_decode(text[m.start():])[0]
        except ValueError:
            continue
    raise ValueError("输出里没有 JSON")


def parse_output(stdout: str, schema: Optional[dict]) -> str | dict:
    """解析 `claude -p --output-format json` 的标准输出。

    Parse the standard output of `claude -p --output-format json`.
    """
    try:
        data = json.loads(stdout)
    except ValueError as e:
        raise LLMError(f"claude 输出不是 JSON: {stdout[:200]!r}") from e
    if isinstance(data, list):  # 个别版本输出事件数组，最后一个是 result / some versions emit an event array; the last item is the result
        data = next((x for x in reversed(data) if isinstance(x, dict) and x.get("type") == "result"), None)
    if not isinstance(data, dict):
        raise LLMError("claude 输出里没有 result 对象")
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


async def _spawn(argv: list[str], prompt: str, timeout: float) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=_neutral_cwd(),
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


async def aask_meta(
    prompt: str,
    system: Optional[str] = None,
    model: Optional[str] = None,
    schema: Optional[dict] = None,
    use_cache: bool = True,
    timeout: Optional[float] = None,
) -> tuple[str | dict, bool]:
    """同 aask，另外告诉你结果是否来自缓存：返回 (结果, 是否命中缓存)。

    Same as aask, but also tells you whether the result came from the cache: returns (result, cache hit).
    """
    model = model or default_model()
    key = cache_key(model, system, prompt, schema)
    if use_cache:
        hit = _cache_read(key)
        if hit is not None:
            return hit, True
    binary = claude_bin()
    if binary is None:
        raise LLMError("找不到 claude 命令（可用环境变量 MINDLOOP_CLAUDE_BIN 指定）")
    argv = build_argv(binary, model, system, schema)
    timeout = _timeout() if timeout is None else timeout
    last: Exception | None = None
    async with _semaphore():
        for _ in range(ATTEMPTS):
            try:
                value = parse_output(await _spawn(argv, prompt, timeout), schema)
            except TimeoutError:
                raise LLMError(f"claude 超时（{timeout:g} 秒）") from None  # 超时不重试，免得再等一轮 / no retry on timeout, to avoid waiting a whole round again
            except LLMError as e:
                last = e
                continue
            _cache_write(key, {"model": model, "system": system, "prompt": prompt, "schema": schema, "value": value})
            return value, False
    raise LLMError(f"claude 调用失败（已重试）: {last}") from last


async def aask(
    prompt: str,
    system: Optional[str] = None,
    model: Optional[str] = None,
    schema: Optional[dict] = None,
    use_cache: bool = True,
    timeout: Optional[float] = None,
) -> str | dict:
    """问一次。不带 schema 返回文本，带 schema 返回 dict。失败抛 LLMError。

    use_cache=False 只跳过读缓存（强制重新生成），结果仍会写入缓存。

    Ask once. Returns text without a schema, a dict with one. Raises LLMError on failure.

    use_cache=False only skips the cache read (forcing regeneration); the result is still written to the cache.
    """
    return (await aask_meta(prompt, system, model, schema, use_cache, timeout))[0]


def run_sync(coro):
    """在同步代码里跑一个协程；若当前线程已有事件循环在跑，就换个线程。

    Run a coroutine from synchronous code; if this thread already has a running event loop, use another thread.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    box: dict[str, Any] = {}

    def work():
        try:
            box["value"] = asyncio.run(coro)
        except BaseException as e:  # noqa: BLE001 — 原样带回调用线程 / carried back to the calling thread as-is
            box["error"] = e

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


def ask(
    prompt: str,
    system: Optional[str] = None,
    model: Optional[str] = None,
    schema: Optional[dict] = None,
    use_cache: bool = True,
    timeout: Optional[float] = None,
) -> str | dict:
    """aask 的同步版本。 / Synchronous version of aask."""
    return run_sync(aask(prompt, system, model, schema, use_cache, timeout))
