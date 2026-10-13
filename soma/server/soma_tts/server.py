"""HTTP 接口：/api/health、/api/tts/voices、POST /api/tts。只绑 127.0.0.1，端口来自启动参数。
The HTTP routes: /api/health, /api/tts/voices and POST /api/tts. Binds to 127.0.0.1 only; the port is an argument.

    uv run --extra model uvicorn soma_tts.server:app --host 127.0.0.1 --port <端口 / port>
    uv run --extra model python -m soma_tts.server --port <端口 / port>

写的东西（合成结果的缓存、分词词典的缓存）都在环境变量 WORLD_SIM_STATE 指的目录里；没设时用临时目录。
Everything written (the cache of results, the word-segmentation dictionary cache) goes under the directory named by
the WORLD_SIM_STATE environment variable, or a temporary directory when it is unset.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from . import __version__, config, schema
from .engine import Engine, NotReady, wav_bytes

MAX_BODY = 8192
MAX_CACHED = 200
MAX_REPLY = 950_000

engine = Engine()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    engine.start()
    yield


app = FastAPI(title="soma-tts", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


def _voices() -> list[dict]:
    out = []
    for model in config.registry()["models"]:
        for v in model["voices"]:
            out.append({"id": v["id"], "lang": model["lang"], "sex": v["sex"], "accent": v["accent"], "default": v["id"] == model["defaultVoice"],
                        "ready": engine.ready(model["lang"]), "model": {"name": model["name"], "version": model["version"], "licence": model["licence"]}})
    return out


@app.get("/api/health")
def health() -> dict:
    """立刻回答，模型还在加载时也是。languages 里每种语言是 missing、pending、loading、ready 或 error。
    Answers at once, also while a model loads. Each language under `languages` is missing, pending, loading, ready or error."""
    return {
        "ok": True,
        "service": "soma-tts",
        "version": __version__,
        "languages": {lang: {"status": engine.status[lang], "voices": schema.voices()[lang], **({"error": engine.errors[lang]} if lang in engine.errors else {})} for lang in config.languages()},
        "ready": [lang for lang in config.languages() if engine.ready(lang)],
    }


@app.get("/api/tts/voices")
def voices() -> dict:
    return {"voices": _voices(), "limits": {"maxTextLength": schema.MAX_TEXT, "maxSeconds": schema.MAX_SECONDS, "speed": [schema.SPEED_MIN, schema.SPEED_MAX]}, "input": schema.input_schema()}


def _cache_path(request: dict):
    model = config.model_for(request["lang"])
    key = hashlib.sha256(json.dumps([__version__, model["commit"], request], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return config.cache_dir(engine.state) / "audio" / f"{key}.json"


def _store(path, body: bytes) -> None:
    """写缓存；写不了不算错。超过 MAX_CACHED 个时删最旧的。
    Write the cache; failing to is not an error. Past MAX_CACHED entries the oldest are removed."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.part")
        tmp.write_bytes(body)
        os.replace(tmp, path)
        entries = sorted(path.parent.glob("*.json"), key=lambda p: p.stat().st_mtime)
        for old in entries[: max(0, len(entries) - MAX_CACHED)]:
            old.unlink(missing_ok=True)
    except OSError:
        pass


def build_reply(result: dict) -> bytes:
    """引擎的结果 → 回复的字节（键的顺序固定，所以同样的输入得到同样的字节）。
    The engine's result → the reply bytes (key order is fixed, so the same input gives the same bytes)."""
    body = {k: result[k] for k in ("sampleRate", "durationS", "lang", "voice", "speed")}
    body["audio"] = base64.b64encode(wav_bytes(result["pcm16"], result["sampleRate"])).decode("ascii")
    body["audioFormat"] = "audio/wav; mono, 16-bit PCM, base64"
    for k in ("phonemes", "words", "symbols", "warnings", "model"):
        body[k] = result[k]
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


@app.post("/api/tts")
async def tts(request: Request) -> Response:
    raw = await request.body()
    try:
        if len(raw) > MAX_BODY:
            raise schema.RequestError("(body)", f"请求体超过 {MAX_BODY} 字节", f"the body is over {MAX_BODY} bytes", {"maxBytes": MAX_BODY}, status=413)
        try:
            payload = json.loads(raw)
        except ValueError:
            raise schema.RequestError("(body)", "不是合法的 JSON", "is not valid JSON", {"example": {"text": "Hello.", "lang": "en"}}, status=400) from None
        req = schema.validate(payload)
        path = _cache_path(req)
        if path.is_file():
            return Response(path.read_bytes(), media_type="application/json")
        from starlette.concurrency import run_in_threadpool

        result = await run_in_threadpool(engine.synthesize, req)
        body = build_reply(result)
        if len(body) > MAX_REPLY:
            raise schema.RequestError("text", f"结果有 {len(body)} 字节，超过上限；请缩短文字", f"the reply would be {len(body)} bytes, over the cap; shorten the text", {"maxBytes": MAX_REPLY})
        _store(path, body)
        return Response(body, media_type="application/json")
    except (schema.RequestError, NotReady) as e:
        return JSONResponse(e.body(), status_code=e.status)


def main(argv: list[str] | None = None) -> int:
    import uvicorn

    parser = argparse.ArgumentParser(description="soma 的语音合成后端 / the speech-synthesis backend of soma")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args(argv)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
