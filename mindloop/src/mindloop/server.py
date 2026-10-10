"""本地服务：给浏览器界面提供计算与独白。"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pydantic import BaseModel

from . import export, lexicon, llm, narrative, runner
from .cases import all_cases
from .cases import get_case as load_case
from .model import CATEGORY_LABELS, Signaling

WEB = Path(__file__).parent / "web"

app = FastAPI(title="mindloop")


@app.get("/api/cases")
def list_cases() -> dict:
    cards = [runner.case_card(c) for c in all_cases().values()]
    return {
        "categories": [
            {"id": cid, "label": label, "cases": [c for c in cards if c["category"] == cid]}
            for cid, label in CATEGORY_LABELS.items()
        ]
    }


@app.get("/api/cases/{case_id}")
def get_case(case_id: str) -> dict:
    cases = all_cases()
    if case_id not in cases:
        raise HTTPException(404, f"没有这个案例: {case_id}")
    return cases[case_id].model_dump()


@app.post("/api/compute")
def compute(p: runner.Params) -> dict:
    try:
        return runner.compute(p)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---------- 大模型：独白与自写话语（经本机 claude -p） ----------


class MonologueRequest(runner.Params):
    owner: str  # 'a' | 'b'：谁脑中的塔
    level: int  # 塔里的第几层
    regenerate: bool = False
    persona_mode: str = "original"  # 'original' | 'neutral'


class LexiconRequest(BaseModel):
    case_id: str
    text: str


@app.get("/api/health")
def health() -> dict:
    return {"claude": llm.available()}


@app.post("/api/monologue")
async def monologue(req: MonologueRequest) -> dict:
    if req.owner not in ("a", "b"):
        raise HTTPException(400, "owner 应为 'a' 或 'b'")
    if req.persona_mode not in ("original", "neutral"):
        raise HTTPException(400, "persona_mode 应为 'original' 或 'neutral'")
    try:
        case, _, _, towers, out = export.build(req)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    tower = towers[req.owner]
    if not 0 <= req.level < len(tower):
        raise HTTPException(400, f"level 应在 0..{len(tower) - 1} 之间")
    return await narrative.monologue(case, tower, req.owner, req.level, out, req.persona_mode, req.regenerate)


@app.post("/api/lexicon")
async def lexicon_estimate(req: LexiconRequest) -> dict:
    if not req.text.strip():
        raise HTTPException(400, "text 不能为空")
    try:
        case = load_case(req.case_id)
    except KeyError as e:
        raise HTTPException(404, str(e))
    if not isinstance(case.game, Signaling):
        raise HTTPException(400, f"案例 {case.id} 不是信号博弈，不能自己加话")
    return await lexicon.estimate(case, req.text)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
