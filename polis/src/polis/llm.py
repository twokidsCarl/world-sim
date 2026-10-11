"""通过本机的 `claude -p` 命令行调用大模型（子进程，不用 SDK，不需要 API key）。移植自 mindloop/llm.py。
Calls the model through the local `claude -p` CLI (a subprocess; no SDK, no API key). Ported from mindloop/llm.py.

    claude -p --output-format json --model <m> --tools "" --no-session-persistence
           --strict-mcp-config --setting-sources "" --system-prompt <s> [--json-schema <schema>]

提示词从标准输入送入；在一个中性的临时目录里运行，不会把任何项目上下文带进去。
结果按（模型、系统提示、提示词、schema）的哈希缓存在磁盘上，所以同一次模拟重跑不会再花钱，也不会变。
The prompt goes in on stdin and the process runs in a neutral temp directory, so no project context leaks in.
Results are cached on disk by a hash of (model, system, prompt, schema): re-running the same simulation is free and stable.

环境变量 / Environment:
    POLIS_CLAUDE_BIN   claude 可执行文件 / the claude executable (default: `claude` on PATH)
    POLIS_CACHE        缓存目录 / cache directory (default: <project>/.cache/llm)
    POLIS_MODEL        缺省模型 / default model (default: sonnet)
    POLIS_TIMEOUT      单次调用超时秒数 / per-call timeout in seconds (default: 90)
    POLIS_CONCURRENCY  同时跑几个调用 / calls in flight at once (default: 4)
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
ATTEMPTS = 2  # 首次 + 重试一次

_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


class LLMError(RuntimeError):
    """claude 不可用、超时、出错，或输出不合要求。"""


# ---------- 配置 ----------


def claude_bin() -> Optional[str]:
    """claude 可执行文件的路径；找不到返回 None。"""
    env = os.environ.get("POLIS_CLAUDE_BIN")
    if env:
        if os.path.isfile(env) and os.access(env, os.X_OK):
            return env
        return shutil.which(env)
    return shutil.which("claude")


def available() -> bool:
    return claude_bin() is not None


def default_model() -> str:
    return os.environ.get("POLIS_MODEL") or DEFAULT_MODEL


def cache_dir() -> Path:
    env = os.environ.get("POLIS_CACHE")
    return Path(env) if env else Path(__file__).resolve().parents[2] / ".cache" / "llm"


def _timeout() -> float:
    try:
        return float(os.environ.get("POLIS_TIMEOUT", DEFAULT_TIMEOUT))
    except ValueError:
        return DEFAULT_TIMEOUT


def _neutral_cwd() -> str:
    d = Path(tempfile.gettempdir()) / "polis-llm"
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


def _semaphore() -> asyncio.Semaphore:
    """全模块共用的并发上限（每个事件循环一把，避免跨循环复用出错）。
    One module-wide concurrency limit, kept per event loop so it is never reused across loops.
    """
    loop = asyncio.get_running_loop()
    sem = _semaphores.get(loop)
    if sem is None:
        try:
            limit = max(1, int(os.environ.get("POLIS_CONCURRENCY", CONCURRENCY)))
        except ValueError:
            limit = CONCURRENCY
        sem = _semaphores[loop] = asyncio.Semaphore(limit)
    return sem


# ---------- 缓存 ----------


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
        pass  # 缓存写不进去不影响结果


# ---------- 调用 ----------


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
    """从一段文字里抠出 JSON（容忍 ```json 围栏和前后的闲话）。"""
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
    """解析 `claude -p --output-format json` 的标准输出。"""
    try:
        data = json.loads(stdout)
    except ValueError as e:
        raise LLMError(f"claude 输出不是 JSON: {stdout[:200]!r}") from e
    if isinstance(data, list):  # 个别版本输出事件数组，最后一个是 result
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
    """同 aask，另外告诉你结果是否来自缓存：返回 (结果, 是否命中缓存)。"""
    model = model or default_model()
    key = cache_key(model, system, prompt, schema)
    if use_cache:
        hit = _cache_read(key)
        if hit is not None:
            return hit, True
    binary = claude_bin()
    if binary is None:
        raise LLMError("找不到 claude 命令（可用环境变量 POLIS_CLAUDE_BIN 指定）")
    argv = build_argv(binary, model, system, schema)
    timeout = _timeout() if timeout is None else timeout
    last: Exception | None = None
    async with _semaphore():
        for _ in range(ATTEMPTS):
            try:
                value = parse_output(await _spawn(argv, prompt, timeout), schema)
            except TimeoutError:
                raise LLMError(f"claude 超时（{timeout:g} 秒）") from None  # 超时不重试，免得再等一轮
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
    """
    return (await aask_meta(prompt, system, model, schema, use_cache, timeout))[0]


def run_sync(coro):
    """在同步代码里跑一个协程；若当前线程已有事件循环在跑，就换个线程。"""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    box: dict[str, Any] = {}

    def work():
        try:
            box["value"] = asyncio.run(coro)
        except BaseException as e:  # noqa: BLE001 — 原样带回调用线程
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
    """aask 的同步版本。"""
    return run_sync(aask(prompt, system, model, schema, use_cache, timeout))
