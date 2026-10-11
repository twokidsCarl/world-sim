"""按请求的主机名分发：<项目>.localhost 归那个模拟，别的归 idea-loom 自己。

模拟那边：/api/* 转给它自己的后端，其余是它构建出来的静态文件。
idea-loom 这边：带 Origin 头而且不是来自 idea-loom 自己页面的接口请求一律拒绝，
这样模拟页面里的脚本调不了 idea-loom 的接口；其余路径提供 idea-loom 自己构建好的界面。

Dispatch by the requested host name: <project>.localhost belongs to that simulation,
anything else to idea-loom itself. For a simulation, /api/* goes to its own backend and
the rest is its built static files. For idea-loom, an API request that carries an Origin
header not from idea-loom's own pages is refused, so a script inside a simulation page
cannot call idea-loom's API; other paths serve idea-loom's own built UI.
"""

from __future__ import annotations

import html
import mimetypes
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .. import config, store
from . import manifest, snapshot, supervisor

HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate", "host", "content-length"}


def sim_name(host: str) -> Optional[str]:
    """`strata.localhost:8767` → `strata`；idea-loom 自己的主机名 → None。 / The simulation named by a host header, if any."""
    name = host.split(":")[0].lower()
    suffix = "." + config.sim_domain()
    if name.endswith(suffix):
        sub = name[: -len(suffix)]
        return sub if manifest.NAME.match(sub) else None
    return None


def origin_allowed(origin: Optional[str]) -> bool:
    """没有 Origin 头（命令行、小助手的工具服务）放行；有的话必须是 idea-loom 自己的页面。

    No Origin header (command line, the assistant's tool server) passes; otherwise it must be one of idea-loom's own pages.
    """
    if not origin:
        return True
    return (urlparse(origin).hostname or "").lower() in config.own_hosts()


def ui_dist() -> Path:
    return Path(__file__).resolve().parents[3] / "web" / "dist"


def _status_page(name: str, state: snapshot.State, title: str) -> HTMLResponse:
    """模拟还没准备好时，在它的位置上显示的一页。 / The page shown in a simulation's place while it is not ready."""
    building = state.status in ("building", "missing")
    head = {"building": "正在构建… / Building…", "missing": "正在准备… / Preparing…", "failed": "构建失败 / Build failed"}.get(state.status, state.status)
    refresh = '<meta http-equiv="refresh" content="2">' if building else ""
    body = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">{refresh}<title>{html.escape(title)}</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4efe4;color:#1c1a17;font:15px/1.6 -apple-system,'PingFang SC',sans-serif}}
@media (prefers-color-scheme:dark){{body{{background:#191714;color:#ece6d8}}pre{{background:#141210}}}}
main{{max-width:720px;padding:24px}}h1{{font:600 20px 'Songti SC',serif;margin:0 0 6px}}pre{{background:#ece5d6;padding:12px;border-radius:6px;white-space:pre-wrap;font:12px/1.5 Menlo,monospace;max-height:50vh;overflow:auto}}</style>
</head><body><main><h1>{html.escape(title)}</h1><p>{head}</p><pre>{html.escape(state.log[-3000:])}</pre>
<p style="color:#8f8675">{"这一页会自己刷新。 / This page refreshes by itself." if building else "修好之后在 idea-loom 里点重新构建。 / Rebuild from idea-loom once it is fixed."}</p></main></body></html>"""
    return HTMLResponse(body, status_code=503 if building else 500, headers={"cache-control": "no-store"})


def _static(root: Path, path: str) -> Response:
    target = (root / path.lstrip("/")).resolve()
    if root.resolve() not in target.parents and target != root.resolve():
        return Response("not found", status_code=404)
    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        # 没有扩展名的路径当作前端自己的路由，回到 index.html。 / A path without an extension is a client route: fall back to index.html.
        if "." not in path.rsplit("/", 1)[-1] and (root / "index.html").is_file():
            target = root / "index.html"
        else:
            return Response("not found", status_code=404)
    media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    cache = "no-cache" if target.suffix == ".html" else "public, max-age=300"
    return FileResponse(target, media_type=media, headers={"cache-control": cache})


async def _proxy(request: Request, port: int) -> Response:
    url = f"http://127.0.0.1:{port}{request.url.path}" + (f"?{request.url.query}" if request.url.query else "")
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=5.0))
    try:
        upstream = await client.send(client.build_request(request.method, url, headers=headers, content=await request.body()), stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        return JSONResponse({"detail": f"后端没有回应：{e}"}, status_code=502)

    async def body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    out = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP}
    return StreamingResponse(body(), status_code=upstream.status_code, headers=out)


async def serve_sim(name: str, request: Request) -> Response:
    try:
        sim = await run_in_threadpool(manifest.load, name)
    except (FileNotFoundError, ValueError) as e:
        return HTMLResponse(f"<p>没有名叫 {html.escape(name)} 的模拟。 / No simulation called {html.escape(name)}.</p><pre>{html.escape(str(e))}</pre>", status_code=404)
    # 只有带构建能力的角色（all、play）才在请求里触发构建。
    # Only roles that can build (all, play) trigger a build from a request.
    state = await run_in_threadpool(snapshot.ensure if config.serves_sims() else snapshot.status, name)
    is_api = sim.api is not None and (request.url.path == "/api" or request.url.path.startswith("/api/"))
    # 新版本在构建或构建失败时，继续用上一个构建成功的版本。
    # While a newer version builds or fails, keep serving the last good build.
    version = state.version if state.status == "ready" else state.serving
    if not version:
        if is_api:
            return JSONResponse({"detail": f"{name} 还没准备好（{state.status}）"}, status_code=503)
        return _status_page(name, state, sim.title.zh)
    if is_api:
        try:
            port = await run_in_threadpool(supervisor.ensure, sim, version)
        except supervisor.ApiError as e:
            return JSONResponse({"detail": str(e)}, status_code=502)
        return await _proxy(request, port)
    if request.method not in ("GET", "HEAD"):
        return Response("method not allowed", status_code=405)
    return _static(snapshot.web_root(sim, version), request.url.path)


class HostRouter:
    """包在 idea-loom 的应用外面的一层。 / A layer wrapped around idea-loom's app."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        name = sim_name(request.headers.get("host", ""))
        path = request.url.path
        if name is not None:
            if not config.serves_sims():
                return await Response("not found", status_code=404)(scope, receive, send)
            return await (await serve_sim(name, request))(scope, receive, send)
        if config.role() == "play":
            # play 角色只提供模拟和几个内部接口，没有 idea-loom 的界面和接口。
            # The play role serves simulations and a few internal routes; no idea-loom UI or API.
            if path.startswith("/internal/play/") or path == "/healthz":
                return await self.app(scope, receive, send)
            return await Response("not found", status_code=404)(scope, receive, send)
        if path.startswith(("/api/", "/internal/")) or path in ("/api", "/docs", "/openapi.json", "/healthz"):
            if not origin_allowed(request.headers.get("origin")):
                return await JSONResponse({"detail": "只接受来自 idea-loom 自己页面的请求"}, status_code=403)(scope, receive, send)
            return await self.app(scope, receive, send)
        dist = ui_dist()
        if request.method in ("GET", "HEAD") and (dist / "index.html").is_file():
            return await _static(dist, path)(scope, receive, send)
        if request.method in ("GET", "HEAD"):
            hint = "idea-loom 的界面还没有构建。运行 uv run idea-loom build-ui，或者用开发服务器：cd web && bun run dev。 / The idea-loom UI is not built yet. Run `uv run idea-loom build-ui`, or use the dev server: `cd web && bun run dev`."
            return await HTMLResponse(f"<p>{html.escape(hint)}</p>", status_code=503)(scope, receive, send)
        return await self.app(scope, receive, send)
