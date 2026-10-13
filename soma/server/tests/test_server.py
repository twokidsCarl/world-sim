"""HTTP 接口。前半不需要模型（空的状态目录）；后半标了 model，模型没下载就跳过。
The HTTP routes. The first half needs no model (an empty state directory); the second half is marked `model` and is
skipped when the model is not downloaded."""

from __future__ import annotations

import base64
import hashlib
import json
import struct
import time

import pytest
from fastapi.testclient import TestClient

from soma_tts import config, schema, server
from soma_tts.engine import Engine


@pytest.fixture()
def bare(tmp_path, monkeypatch):
    """没有模型文件的服务。 / The service without model files."""
    monkeypatch.setattr(server, "engine", Engine(tmp_path))
    with TestClient(server.app) as client:
        yield client


def test_health_answers_fast_without_models(bare):
    started = time.monotonic()
    body = bare.get("/api/health").json()
    assert time.monotonic() - started < 1.0
    assert body["ok"] is True and body["service"] == "soma-tts" and body["ready"] == []
    assert {lang: v["status"] for lang, v in body["languages"].items()} == {"en": "missing", "zh": "missing"}
    assert body["languages"]["en"]["voices"] == schema.voices()["en"]


def test_voices_lists_languages_limits_and_schema(bare):
    body = bare.get("/api/tts/voices").json()
    assert {v["lang"] for v in body["voices"]} == {"en", "zh"}
    assert sum(1 for v in body["voices"] if v["default"]) == 2
    assert all(v["model"]["licence"] == "Apache-2.0" and v["ready"] is False for v in body["voices"])
    assert body["limits"]["maxTextLength"] == schema.MAX_TEXT and body["input"] == schema.input_schema()


@pytest.mark.parametrize(
    ("body", "status", "field"),
    [
        ("not json", 400, "(body)"),
        ('{"text": "Hi", "lang": "fr"}', 422, "lang"),
        ('{"text": "Hi", "lang": "en", "speed": 5}', 422, "speed"),
        ('{"text": "Hi", "lang": "en", "x": 1}', 422, "x"),
        ('{"text": "' + "x" * 9000 + '", "lang": "en"}', 413, "(body)"),
    ],
)
def test_bad_requests_are_refused_with_field_and_allowed(bare, body, status, field):
    response = bare.post("/api/tts", content=body)
    assert response.status_code == status
    reply = response.json()
    assert reply["field"] == field and reply["allowed"] is not None and field in reply["detail"]


def test_missing_model_is_a_503_that_says_how_to_fetch(bare):
    response = bare.post("/api/tts", json={"text": "Hello.", "lang": "en"})
    assert response.status_code == 503
    assert "soma_tts.fetch" in response.json()["detail"]


def test_all_routes_live_under_api():
    assert all(route.path.startswith("/api/") for route in server.app.routes)


# —— 以下需要模型 / the rest needs the model ——

EN = {"text": "Please bring five more books before noon.", "lang": "en"}
ZH = {"text": "我们一会儿去图书馆借几本绿色的书。", "lang": "zh"}


def check_timeline(result):
    """音素铺满整段声音、时间单调、每个都有长度；词落在音素的范围里。
    Phones cover the whole audio, times are monotone, each has a length; words lie within the phones."""
    ph = result["phonemes"]
    assert ph[0]["t0"] == 0 and abs(ph[-1]["t1"] - result["durationS"]) < 1e-6
    for a, b in zip(ph, ph[1:]):
        assert a["t1"] == b["t0"]
    assert all(p["t1"] > p["t0"] for p in ph)
    assert all(p["phone"] != "?" for p in ph)
    assert ph[0]["phone"] == "sil" and ph[-1]["phone"] == "sil"
    words = result["words"]
    assert all(w["t1"] > w["t0"] for w in words) and all(a["t1"] <= b["t0"] + 1e-9 for a, b in zip(words, words[1:]))
    for p in ph:
        if p["phone"] != "sil":
            w = words[p["word"]]
            assert w["t0"] - 1e-9 <= p["t0"] and p["t1"] <= w["t1"] + 1e-9


@pytest.mark.model
def test_english_timeline(engine):
    result = engine.synthesize(schema.validate(EN))
    check_timeline(result)
    assert result["sampleRate"] == 24000 and len(result["pcm16"]) == round(result["durationS"] * 24000) * 2
    assert 2.0 < result["durationS"] < 5.0
    sounds = [p for p in result["phonemes"] if p["phone"] != "sil"]
    assert [p["phone"] for p in sounds[:4]] == ["P", "L", "IY", "Z"]
    assert sounds[2]["stress"] == 1 and sounds[0]["stress"] is None
    assert all(p["phone"].isupper() and not any(c.isdigit() for c in p["phone"]) for p in sounds)
    assert [w["text"] for w in result["words"]] == ["Please", "bring", "five", "more", "books", "before", "noon"]
    assert result["model"] == {"name": "Kokoro-82M", "version": "v1.0", "licence": "Apache-2.0", "source": "https://huggingface.co/hexgrad/Kokoro-82M", "commit": config.model_for("en")["commit"]}
    # 平均每个音 40–200 毫秒 / 40–200 ms per phone on average
    mean = sum(p["t1"] - p["t0"] for p in sounds) / len(sounds)
    assert 0.04 < mean < 0.2


@pytest.mark.model
def test_mandarin_timeline(engine):
    result = engine.synthesize(schema.validate(ZH))
    check_timeline(result)
    sounds = [p for p in result["phonemes"] if p["phone"] != "sil"]
    parts = {p["part"] for p in sounds}
    assert parts == {"initial", "final", "erhua"}
    assert all(p["tone"] in (1, 2, 3, 4, 5) for p in sounds if p["part"] != "initial") and all(p["tone"] is None for p in sounds if p["part"] == "initial")
    names = [p["phone"] for p in sounds]
    # 绿 lü、去 qu（ü 写作 v）、书 sh、借 j / 绿 lü, 去 qu (ü written v), 书 sh, 借 j
    assert "v" in names and "sh" in names and "j" in names and "q" in names
    assert "".join(w["text"] for w in result["words"]) == "我们一会儿去图书馆借几本绿色的书"
    assert result["model"]["version"] == "v1.1-zh"


@pytest.mark.model
def test_same_input_same_bytes(engine):
    for request in (EN, ZH, {**EN, "voice": "am_michael", "speed": 1.3}):
        a = server.build_reply(engine.synthesize(schema.validate(request)))
        other = engine.synthesize(schema.validate({"text": "Something else in between.", "lang": "en"}))
        assert other["pcm16"]
        b = server.build_reply(engine.synthesize(schema.validate(request)))
        assert hashlib.sha256(a).hexdigest() == hashlib.sha256(b).hexdigest()
        assert len(a) < 1_000_000


@pytest.mark.model
def test_speed_changes_duration_and_long_audio_is_refused(engine):
    slow = engine.synthesize(schema.validate({**EN, "speed": 0.7}))
    fast = engine.synthesize(schema.validate({**EN, "speed": 1.5}))
    assert slow["durationS"] > fast["durationS"] * 1.5
    long_text = " ".join(["The quick brown fox jumps over the lazy dog near the river bank."] * 4)
    with pytest.raises(schema.RequestError) as info:
        engine.synthesize(schema.validate({"text": long_text, "lang": "en", "speed": 0.5}))
    assert info.value.field == "text" and info.value.allowed == {"maxSeconds": schema.MAX_SECONDS}


@pytest.mark.model
def test_unknown_word_is_spoken_by_rule_and_reported(engine):
    result = engine.synthesize(schema.validate({"text": "The blorptastic cat.", "lang": "en"}))
    check_timeline(result)
    assert [w["word"] for w in result["warnings"]] == ["blorptastic"]
    assert "blorptastic" in [w["text"] for w in result["words"]]


@pytest.mark.model
def test_http_round_trip_returns_a_wav_and_caches(engine, tmp_path, monkeypatch):
    monkeypatch.setattr(server, "engine", engine)
    monkeypatch.setattr(engine, "state", engine.state)
    monkeypatch.setattr(config, "cache_dir", lambda _state: tmp_path / "cache")
    with TestClient(server.app) as client:
        first = client.post("/api/tts", json=EN)
        assert first.status_code == 200 and len(first.content) < 1_000_000
        body = first.json()
        wav = base64.b64decode(body["audio"])
        assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE"
        fmt, channels, rate, _, _, bits = struct.unpack("<HHIIHH", wav[20:36])
        assert (fmt, channels, rate, bits) == (1, 1, 24000, 16)
        assert len(wav) - 44 == round(body["durationS"] * 24000) * 2
        assert list(body) == ["sampleRate", "durationS", "lang", "voice", "speed", "audio", "audioFormat", "phonemes", "words", "symbols", "warnings", "model"]
        again = client.post("/api/tts", content=json.dumps({"lang": "en", "text": EN["text"], "speed": 1}))
        assert again.content == first.content
        assert len(list((tmp_path / "cache" / "audio").glob("*.json"))) == 1
        health = client.get("/api/health").json()
        assert "en" in health["ready"]
