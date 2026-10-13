"""POST /api/tts 的输入：一份 JSON Schema，和能让调用方自己改对的错误信息。
The input of POST /api/tts: one JSON Schema, and error messages a caller can fix its request from.

这一份 schema 和 sim.json 里 agent.capabilities 的 input 是同一份（测试里核对）。
This schema is the same as the `input` under agent.capabilities in sim.json (a test checks that).
"""

from __future__ import annotations

import re
from typing import Any

from . import config

MAX_TEXT = 300
SPEED_MIN, SPEED_MAX = 0.5, 2.0
# 返回要小于 1 MB：16 位、24 kHz 的 WAV 经 base64 后约 64 KB / 秒。
# The reply has to stay under 1 MB: 16-bit 24 kHz WAV in base64 is about 64 KB a second.
MAX_SECONDS = 13.0
# 模型一次最多读这么多个记号 / the model reads at most this many symbols at once
MAX_SYMBOLS = 510

_CJK = re.compile(r"[一-鿿]")
_LATIN = re.compile(r"[A-Za-z]")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class RequestError(Exception):
    """一条能照着改的错误：哪个字段、允许什么。 / An error to act on: which field, and what is allowed."""

    def __init__(self, field: str, zh: str, en: str, allowed: Any = None, status: int = 422):
        super().__init__(en)
        self.field, self.zh, self.en, self.allowed, self.status = field, zh, en, allowed, status

    def body(self) -> dict:
        return {"detail": f"{self.field}：{self.zh} / {self.field}: {self.en}", "field": self.field, "allowed": self.allowed}


def voices() -> dict[str, list[str]]:
    return {m["lang"]: [v["id"] for v in m["voices"]] for m in config.registry()["models"]}


def input_schema() -> dict:
    all_voices = [v for vs in voices().values() for v in vs]
    return {
        "type": "object",
        "required": ["text", "lang"],
        "additionalProperties": False,
        "properties": {
            "text": {
                "type": "string", "minLength": 1, "maxLength": MAX_TEXT,
                "description": f"要读的文字，1 到 {MAX_TEXT} 个字符。lang 为 en 时是英文；为 zh 时是汉字（数字会读成中文，不能夹拉丁字母）。合成出的声音超过 {MAX_SECONDS:g} 秒会报错，请缩短。 / The text to speak, 1 to {MAX_TEXT} characters. English for lang en; Chinese characters for lang zh (digits are read in Chinese; Latin letters are not accepted). Audio longer than {MAX_SECONDS:g} s is refused: shorten the text.",
            },
            "lang": {"type": "string", "enum": config.languages(), "description": "语言：en 英语（美式），zh 普通话。 / Language: en English (American), zh Mandarin."},
            "voice": {
                "type": "string", "enum": all_voices,
                "description": "声音；不给就用这种语言的默认声音。英语：" + "、".join(voices()["en"]) + "；普通话：" + "、".join(voices()["zh"]) + "。 / Voice; the language's default when omitted. English: " + ", ".join(voices()["en"]) + "; Mandarin: " + ", ".join(voices()["zh"]) + ".",
            },
            "speed": {"type": "number", "minimum": SPEED_MIN, "maximum": SPEED_MAX, "default": 1.0, "description": f"语速倍数，{SPEED_MIN:g} 到 {SPEED_MAX:g}，默认 1。 / Speaking rate multiplier, {SPEED_MIN:g} to {SPEED_MAX:g}; default 1."},
        },
    }


def validate(payload: Any) -> dict:
    """核对输入，返回补齐默认值的请求；不合规就抛 RequestError。
    Check the input and return the request with defaults filled in; raises RequestError otherwise."""
    schema = input_schema()
    props = schema["properties"]
    if not isinstance(payload, dict):
        raise RequestError("(body)", "请求体要是一个 JSON 对象", "the body must be a JSON object", {"example": {"text": "Hello.", "lang": "en"}})
    for key in payload:
        if key not in props:
            raise RequestError(key, "没有这个字段", "unknown field", sorted(props))
    for key in schema["required"]:
        if key not in payload:
            raise RequestError(key, "必须给出", "is required", props[key].get("enum") or props[key]["type"])
    text, lang = payload["text"], payload["lang"]
    if not isinstance(lang, str) or lang not in props["lang"]["enum"]:
        raise RequestError("lang", f"要是 {' 或 '.join(props['lang']['enum'])}", f"must be one of {props['lang']['enum']}", props["lang"]["enum"])
    if not isinstance(text, str):
        raise RequestError("text", "要是字符串", "must be a string", "string")
    if not text.strip() or len(text) > MAX_TEXT:
        raise RequestError("text", f"长度要在 1 到 {MAX_TEXT} 个字符之间（现在是 {len(text)}）", f"must be 1 to {MAX_TEXT} characters long (it is {len(text)})", {"minLength": 1, "maxLength": MAX_TEXT})
    if _CONTROL.search(text):
        raise RequestError("text", "不能有控制字符", "must not contain control characters", "printable text")
    if lang == "en" and not re.search(r"[A-Za-z0-9]", text):
        raise RequestError("text", "lang 为 en 时要有英文字母或数字", "needs Latin letters or digits when lang is en", "English text")
    if lang == "zh":
        if not _CJK.search(text) and not re.search(r"[0-9]", text):
            raise RequestError("text", "lang 为 zh 时要有汉字", "needs Chinese characters when lang is zh", "Chinese text")
        if _LATIN.search(text):
            raise RequestError("text", "lang 为 zh 时不能夹拉丁字母，请写成汉字，或另发一个 lang 为 en 的请求", "must not contain Latin letters when lang is zh: write them in Chinese characters, or send a separate request with lang en", "Chinese characters, digits and punctuation")
    allowed_voices = voices()[lang]
    voice = payload.get("voice")
    if voice is None:
        voice = config.model_for(lang)["defaultVoice"]
    elif not isinstance(voice, str) or voice not in allowed_voices:
        raise RequestError("voice", f"lang 为 {lang} 时可用的声音是 {'、'.join(allowed_voices)}", f"for lang {lang} the voices are {allowed_voices}", allowed_voices)
    speed = payload.get("speed", 1.0)
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not (SPEED_MIN <= speed <= SPEED_MAX):
        raise RequestError("speed", f"要是 {SPEED_MIN:g} 到 {SPEED_MAX:g} 之间的数", f"must be a number from {SPEED_MIN:g} to {SPEED_MAX:g}", {"minimum": SPEED_MIN, "maximum": SPEED_MAX})
    return {"text": text, "lang": lang, "voice": voice, "speed": round(float(speed), 3)}
