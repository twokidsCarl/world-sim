"""输入的核对和错误信息；清单；和 sim.json 的一致。都不需要模型。
Input validation and error messages; the registry; agreement with sim.json. None of this needs the model."""

from __future__ import annotations

import json
import re

import jsonschema
import pytest

from soma_tts import config, schema


def refused(payload):
    with pytest.raises(schema.RequestError) as info:
        schema.validate(payload)
    return info.value


def test_defaults_are_filled_in():
    assert schema.validate({"text": "Hello.", "lang": "en"}) == {"text": "Hello.", "lang": "en", "voice": "af_heart", "speed": 1.0}
    assert schema.validate({"text": "你好。", "lang": "zh", "speed": 1.25})["voice"] == "zf_001"


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ([], "(body)"),
        ({"lang": "en"}, "text"),
        ({"text": "Hi"}, "lang"),
        ({"text": "Hi", "lang": "fr"}, "lang"),
        ({"text": "", "lang": "en"}, "text"),
        ({"text": "x" * 301, "lang": "en"}, "text"),
        ({"text": 5, "lang": "en"}, "text"),
        ({"text": "你好", "lang": "en"}, "text"),
        ({"text": "Hello", "lang": "zh"}, "text"),
        ({"text": "你好 OK", "lang": "zh"}, "text"),
        ({"text": "Hi", "lang": "en", "voice": "zf_001"}, "voice"),
        ({"text": "Hi", "lang": "en", "speed": 0.1}, "speed"),
        ({"text": "Hi", "lang": "en", "speed": "fast"}, "speed"),
        ({"text": "Hi", "lang": "en", "speed": True}, "speed"),
        ({"text": "Hi", "lang": "en", "pitch": 2}, "pitch"),
    ],
)
def test_errors_name_the_field(payload, field):
    error = refused(payload)
    assert error.field == field
    body = error.body()
    # 中英都有，并且说了是哪个字段 / both languages, and the field is named
    assert body["detail"].startswith(f"{field}：") and f" / {field}: " in body["detail"]
    assert body["field"] == field


def test_errors_say_what_is_allowed():
    assert refused({"text": "Hi", "lang": "fr"}).allowed == ["en", "zh"]
    assert refused({"text": "Hi", "lang": "en", "voice": "nobody"}).allowed == schema.voices()["en"]
    assert refused({"text": "Hi", "lang": "en", "speed": 9}).allowed == {"minimum": schema.SPEED_MIN, "maximum": schema.SPEED_MAX}
    assert refused({"text": "Hi", "lang": "en", "pitch": 2}).allowed == ["lang", "speed", "text", "voice"]
    assert refused({"text": "x" * 400, "lang": "en"}).allowed == {"minLength": 1, "maxLength": schema.MAX_TEXT}


def test_schema_is_strict_and_agrees_with_validate():
    s = schema.input_schema()
    jsonschema.Draft202012Validator.check_schema(s)
    assert s["additionalProperties"] is False and s["required"] == ["text", "lang"]
    assert s["properties"]["text"]["maxLength"] == schema.MAX_TEXT
    assert {"minimum", "maximum"} <= set(s["properties"]["speed"])
    for prop in s["properties"].values():
        assert " / " in prop["description"]
    good = {"text": "Hello.", "lang": "en", "voice": "am_michael", "speed": 1.5}
    jsonschema.validate(good, s)
    schema.validate(good)
    for bad in ({"text": "Hello.", "lang": "en", "extra": 1}, {"text": "Hello.", "lang": "en", "speed": 3}, {"text": "Hello."}):
        assert list(jsonschema.Draft202012Validator(s).iter_errors(bad))
        refused(bad)


def test_reply_stays_under_one_megabyte_at_the_duration_cap():
    # 16 位、24 kHz、base64；再留出时间线的余量 / 16-bit, 24 kHz, base64; with room left for the timeline
    audio = schema.MAX_SECONDS * config.SAMPLE_RATE * 2 * 4 / 3
    assert audio + 100_000 < 1_000_000


def test_sim_json_declares_the_same_schema_and_a_valid_example():
    sim = json.loads((config.SERVER_DIR.parent / "sim.json").read_text(encoding="utf-8"))
    api = sim["api"]
    assert api["dir"] == "server" and api["health"] == "/api/health"
    assert "{port}" in api["run"] and api["run"][api["run"].index("--host") + 1] == "127.0.0.1"
    assert api["env"]["WORLD_SIM_STATE"] == "{state}"
    cap = next(c for c in sim["agent"]["capabilities"] if c["id"] == "tts")
    assert cap["http"] == {"method": "POST", "path": "/api/tts"} and cap["deterministic"] is True
    assert cap["input"] == schema.input_schema()
    jsonschema.validate(cap["example"], cap["input"])
    schema.validate(cap["example"])


def test_registry_has_licence_evidence_and_hashes():
    reg = config.registry()
    assert {m["lang"] for m in reg["models"]} == {"en", "zh"}
    for m in reg["models"]:
        assert m["licence"] == "Apache-2.0" and re.fullmatch(r"[0-9a-f]{40}", m["commit"])
        assert m["base"].startswith("https://huggingface.co/hexgrad/") and m["commit"] in m["base"]
        assert {"declared", "localUse", "generatedAudio"} <= set(m["evidence"])
        paths = {f["path"] for f in m["files"]}
        assert {m["config"], m["weights"]} <= paths and {f"voices/{v['id']}.pt" for v in m["voices"]} <= paths
        assert m["defaultVoice"] in {v["id"] for v in m["voices"]}
        for f in m["files"]:
            assert re.fullmatch(r"[0-9a-f]{64}", f["sha256"]) and f["bytes"] > 0
    text = config.REGISTRY.read_text(encoding="utf-8")
    assert "/Users/" not in text and not re.search(r"[\w.]+@[\w.]+\.\w+", text)


def test_state_directory_resolution(tmp_path, monkeypatch):
    monkeypatch.setenv("WORLD_SIM_STATE", str(tmp_path / "from-env"))
    assert config.state_dir() == (tmp_path / "from-env").resolve()
    assert config.state_dir(str(tmp_path / "explicit")) == (tmp_path / "explicit").resolve()
    # 没被替换的占位符当作没给 / an unsubstituted placeholder counts as not given
    assert config.state_dir("{state}") == (tmp_path / "from-env").resolve()
    monkeypatch.delenv("WORLD_SIM_STATE")
    snapshot = tmp_path / "play" / "soma" / "src-0123456789ab" / "soma" / "server"
    snapshot.mkdir(parents=True)
    monkeypatch.chdir(snapshot)
    assert config.state_dir("{state}") == (tmp_path / "play" / "soma" / "state").resolve()
