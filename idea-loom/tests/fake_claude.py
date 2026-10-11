"""测试用的假 claude：一个可执行的 Python 脚本，绝不联网。照搬自 mindloop/tests/fake_claude_helper.py。

A fake claude for tests: an executable Python script that never touches the network.
Adapted from mindloop/tests/fake_claude_helper.py.

行为由环境变量控制 / Controlled by environment variables:
    FAKE_LOG         每次被调用追加一行 / one line per call: {"argv", "stdin", "cwd"}
    FAKE_MODE        ok | fail_once | garbage_once | always_fail | sleep | result_only
    FAKE_RESULT      result 字段的文本 / the text of `result`
    FAKE_STRUCTURED  structured_output 的 JSON；可以是一个列表，按调用次序轮流用
                     JSON for `structured_output`; may be a list, used in call order
"""

from __future__ import annotations

import json
import stat
import sys
from pathlib import Path

SCRIPT = r'''#!{python}
import json, os, sys, time
stdin = sys.stdin.read()
log = os.environ["FAKE_LOG"]
n = sum(1 for _ in open(log)) if os.path.exists(log) else 0
with open(log, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "stdin": stdin, "cwd": os.getcwd()}}) + "\n")
mode = os.environ.get("FAKE_MODE", "ok")
if mode == "sleep":
    time.sleep(30)
if mode == "always_fail" or (mode == "fail_once" and n == 0):
    sys.stderr.write("boom")
    sys.exit(1)
if mode == "garbage_once" and n == 0:
    print("this is not json")
    sys.exit(0)
out = {{"type": "result", "is_error": False, "result": os.environ.get("FAKE_RESULT", "你好"),
       "total_cost_usd": 0.0123, "usage": {{"input_tokens": 100, "output_tokens": 20}}}}
if "--json-schema" in sys.argv:
    structured = json.loads(os.environ.get("FAKE_STRUCTURED", "{{}}"))
    if isinstance(structured, list):
        structured = structured[min(n, len(structured) - 1)]
    if mode == "result_only":
        out["result"] = "好的，答案如下：\n```json\n" + json.dumps(structured, ensure_ascii=False) + "\n```"
    else:
        out["result"] = json.dumps(structured, ensure_ascii=False)
        out["structured_output"] = structured
print(json.dumps(out, ensure_ascii=False))
'''


def install(tmp_path: Path, monkeypatch) -> Path:
    """装好假 claude、独立的缓存和运行目录；返回调用日志的路径。

    Install the fake claude with its own cache and runs directories; returns the call log path.
    """
    binary = tmp_path / "fake-claude"
    binary.write_text(SCRIPT.format(python=sys.executable), encoding="utf-8")
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "calls.jsonl"
    monkeypatch.setenv("IDEA_LOOM_CLAUDE_BIN", str(binary))
    monkeypatch.setenv("IDEA_LOOM_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("IDEA_LOOM_RUNS", str(tmp_path / "runs"))
    monkeypatch.setenv("FAKE_LOG", str(log))
    for k in ("IDEA_LOOM_MODEL", "IDEA_LOOM_TIMEOUT", "FAKE_MODE", "FAKE_RESULT", "FAKE_STRUCTURED"):
        monkeypatch.delenv(k, raising=False)
    return log


def calls(log: Path) -> list[dict]:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
