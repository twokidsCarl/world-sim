"""下载模型文件到状态目录并校验 sha256。 / Download the model files into the state directory and verify their sha256.

    uv run --extra model python -m soma_tts.fetch --state <目录 / directory>

只从 models.json 里写明的地址（模型的官方发布处，固定到某次提交）下载；文件当作不可信数据，只用
torch.load(weights_only=True) 读。已经在且校验通过的文件不再下载。
Downloads only from the addresses in models.json (each model's official distribution, pinned to a commit); the files
are treated as untrusted data and read with torch.load(weights_only=True) only. Files already present and verified
are not downloaded again.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import urllib.request
from pathlib import Path

from . import config

USER_AGENT = "soma-tts/0.1 (world-sim)"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch_one(url: str, target: Path, size: int, sha256: str, timeout: float = 60.0) -> str:
    """返回 "ok"（已在）或 "downloaded"；校验不过就抛错并删掉临时文件。
    Returns "ok" (already there) or "downloaded"; raises and removes the temporary file when verification fails."""
    if target.is_file() and target.stat().st_size == size and sha256_of(target) == sha256:
        return "ok"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    h = hashlib.sha256()
    got = 0
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response, tmp.open("wb") as out:
            while True:
                block = response.read(1 << 20)
                if not block:
                    break
                got += len(block)
                if got > size:
                    raise RuntimeError(f"{url}: 比清单里的 {size} 字节大 / larger than the {size} bytes in the registry")
                h.update(block)
                out.write(block)
        if got != size or h.hexdigest() != sha256:
            raise RuntimeError(f"{url}: 大小或 sha256 与清单不符 / size or sha256 differs from the registry (got {got} bytes, {h.hexdigest()})")
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    return "downloaded"


def fetch_all(state: Path, langs: list[str] | None = None, log=print) -> None:
    for model in config.registry()["models"]:
        if langs and model["lang"] not in langs:
            continue
        root = config.models_dir(state) / model["id"]
        for f in model["files"]:
            result = fetch_one(model["base"] + f["path"], root / f["path"], f["bytes"], f["sha256"])
            log(f"{result:10s} {model['id']}/{f['path']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="下载并校验语音模型 / download and verify the speech models")
    parser.add_argument("--state", default=None, help="状态目录；缺省取 WORLD_SIM_STATE / the state directory; defaults to WORLD_SIM_STATE")
    parser.add_argument("--lang", action="append", choices=config.languages(), help="只下载这种语言的模型 / only this language's model")
    args = parser.parse_args(argv)
    state = config.state_dir(args.state)
    print(f"状态目录 / state directory: {state}")
    try:
        fetch_all(state, args.lang)
    except Exception as e:  # noqa: BLE001 — 原因要留给人看 / the reason must reach a person
        print(f"失败 / failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
