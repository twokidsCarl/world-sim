"""测试用的假 claude：一个可执行的 Python 脚本，绝不联网。

行为由环境变量控制：
    FAKE_LOG         每次被调用追加一行 JSON：{"argv", "stdin", "cwd"}
    FAKE_MODE        ok | fail_once | garbage_once | always_fail | sleep | count | result_only
    FAKE_RESULT      result 字段的文本
    FAKE_STRUCTURED  带 --json-schema 时 structured_output 的 JSON
"""

from __future__ import annotations

import json
import shutil
import stat
import sys
from pathlib import Path

REAL_CASES = Path(__file__).resolve().parents[1] / "cases"
CASE_FILES = ["bluff/kongchengji.yaml", "bluff/poe_even_odd.yaml"]

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
result = os.environ.get("FAKE_RESULT", "你好")
if mode == "count":
    result += str(n)
out = {{"type": "result", "is_error": False, "result": result}}
if "--json-schema" in sys.argv:
    structured = os.environ.get("FAKE_STRUCTURED", "{{}}")
    if mode == "result_only":
        out["result"] = "好的，答案如下：\n```json\n" + structured + "\n```"
    else:
        out["result"] = structured
        out["structured_output"] = json.loads(structured)
print(json.dumps(out, ensure_ascii=False))
'''


def install(tmp_path: Path, monkeypatch) -> Path:
    """装好假 claude、独立的缓存目录和一份只含两个已知案例的案例库；返回日志文件路径。"""
    binary = tmp_path / "fake-claude"
    binary.write_text(SCRIPT.format(python=sys.executable), encoding="utf-8")
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "calls.jsonl"
    cases = tmp_path / "cases"
    for rel in CASE_FILES:
        (cases / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REAL_CASES / rel, cases / rel)
    monkeypatch.setenv("MINDLOOP_CLAUDE_BIN", str(binary))
    monkeypatch.setenv("MINDLOOP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("MINDLOOP_CASES", str(cases))
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.delenv("MINDLOOP_MODEL", raising=False)
    monkeypatch.delenv("MINDLOOP_TIMEOUT", raising=False)
    for k in ("FAKE_MODE", "FAKE_RESULT", "FAKE_STRUCTURED"):
        monkeypatch.delenv(k, raising=False)
    return log


def calls(log: Path) -> list[dict]:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
