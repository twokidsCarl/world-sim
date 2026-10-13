"""合成：文字 → 记号 → Kokoro → 16 位 PCM 和音素时间线。
Synthesis: text → symbols → Kokoro → 16-bit PCM and a phoneme timeline.

模型在后台线程里加载，所以 /api/health 在加载期间也立刻回答。请求时不联网、不调用任何语言模型。
同样的输入得到同样的字节：每次合成前固定随机种子（解码器的声源里有随机相位和噪声），线程数也固定。
Models load in a background thread, so /api/health answers at once even while they load. Nothing goes to the network
at request time and no language model is called. The same input gives the same bytes: the random seed is fixed before
every synthesis (the decoder's source has random phase and noise) and so is the thread count.
"""

from __future__ import annotations

import io
import os
import struct
import sys
import threading
import time
import types
from pathlib import Path

from . import config, g2p_en, phones, schema

SEED = 20261013
THREADS = 4
AUDIBLE_DB = 35.0


class NotReady(Exception):
    """这种语言的模型还不能用。 / This language's model cannot be used yet."""

    def __init__(self, zh: str, en: str, status: int = 503):
        super().__init__(en)
        self.zh, self.en, self.status = zh, en, status

    def body(self) -> dict:
        return {"detail": f"{self.zh} / {self.en}", "field": None, "allowed": None}


def wav_bytes(pcm16: bytes, sample_rate: int = config.SAMPLE_RATE) -> bytes:
    """单声道 16 位 PCM 的 WAV。 / A mono 16-bit PCM WAV."""
    out = io.BytesIO()
    out.write(b"RIFF" + struct.pack("<I", 36 + len(pcm16)) + b"WAVEfmt ")
    out.write(struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
    out.write(b"data" + struct.pack("<I", len(pcm16)) + pcm16)
    return out.getvalue()


def zh_speed_factor(symbols: int) -> float:
    """v1.1-zh 的模型卡附带的示例（samples/make_zh.py）里的做法：记号多于约 83 个时放慢，抵消它读长句时越读越快。
    From the sample script published with the v1.1-zh model card (samples/make_zh.py): slow down past about 83 symbols,
    which offsets the model's rushing on long sentences."""
    speed = 0.8
    if symbols <= 83:
        speed = 1.0
    elif symbols < 183:
        speed = 1 - (symbols - 83) / 500
    return speed * 1.1


class Engine:
    def __init__(self, state: Path | None = None):
        self.state = state or config.state_dir()
        self.status: dict[str, str] = {}
        self.errors: dict[str, str] = {}
        self.load_seconds: dict[str, float] = {}
        self._models: dict[str, object] = {}
        self._voices: dict[tuple[str, str], object] = {}
        self._g2p: dict[str, object] = {}
        self._lock = threading.Lock()
        self._loaded = {lang: threading.Event() for lang in config.languages()}
        self._thread: threading.Thread | None = None
        self._warnings: list[dict] = []
        for lang in config.languages():
            self.status[lang] = "missing" if config.missing_files(self.state, config.model_for(lang)) else "pending"

    # —— 加载 / loading ——

    def start(self) -> None:
        """在后台加载所有已下载的模型。 / Load every downloaded model in the background."""
        if self._thread is None:
            self._thread = threading.Thread(target=self._load_all, name="soma-tts-load", daemon=True)
            self._thread.start()

    def _load_all(self) -> None:
        for lang in config.languages():
            if self.status[lang] != "pending":
                self._loaded[lang].set()
                continue
            self.status[lang] = "loading"
            started = time.monotonic()
            try:
                self._load(lang)
                self.status[lang] = "ready"
            except Exception as e:  # noqa: BLE001 — 原因写进 health / the reason goes into health
                self.status[lang] = "error"
                self.errors[lang] = f"{type(e).__name__}: {e}"[:300]
            self.load_seconds[lang] = round(time.monotonic() - started, 2)
            self._loaded[lang].set()

    def _prepare_runtime(self) -> None:
        # 不联网 / no network
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        # kokoro 的包在导入时会导入 misaki.espeak（需要 GPL 的 espeak-ng，这里没有装）；先放一个空模块顶替它。
        # Importing the kokoro package imports misaki.espeak (which needs the GPL espeak-ng, not installed here); an
        # empty module stands in for it.
        if "misaki.espeak" not in sys.modules:
            import misaki

            stub = types.ModuleType("misaki.espeak")
            sys.modules["misaki.espeak"] = stub
            misaki.espeak = stub  # type: ignore[attr-defined]
        import torch

        torch.set_num_threads(THREADS)

    def _load(self, lang: str) -> None:
        # 建模型时的参数初始化会用掉全局随机数；和合成用同一把锁，免得打乱合成的随机序列。
        # Building a model draws from the global random generator for parameter initialisation; it takes the same lock
        # as synthesis so that it cannot disturb the random sequence of a synthesis.
        with self._lock:
            self._load_locked(lang)

    def _load_locked(self, lang: str) -> None:
        self._prepare_runtime()
        import torch
        from kokoro import KModel

        model = config.model_for(lang)
        root = config.models_dir(self.state) / model["id"]
        repo = model["source"].split("huggingface.co/")[1]
        net = KModel(repo_id=repo, config=str(root / model["config"]), model=str(root / model["weights"])).eval()
        for v in model["voices"]:
            # 当作不可信数据：只按张量读 / untrusted data: read as tensors only
            self._voices[(lang, v["id"])] = torch.load(root / "voices" / f"{v['id']}.pt", weights_only=True, map_location="cpu")
        if lang == "en":
            from misaki import en

            self._g2p[lang] = en.G2P(trf=False, british=False, fallback=self._fallback, unk="")
        else:
            import jieba

            # jieba 默认把词典缓存写到系统临时目录；改到状态目录 / jieba caches its dictionary in the system temp directory by default; moved to the state directory
            cache = config.cache_dir(self.state) / "jieba"
            cache.mkdir(parents=True, exist_ok=True)
            jieba.dt.tmp_dir = str(cache)
            jieba.setLogLevel(60)
            from misaki import zh

            self._g2p[lang] = zh.ZHG2P(version="1.1", unk="", en_callable=lambda _text: "")
        self._models[lang] = net

    def _fallback(self, token) -> tuple[str, int]:
        ps = g2p_en.spell_out(token.text)
        if ps:
            self._warnings.append({"word": token.text, "note": "不在词典里，按拼写规则读，读音可能不准 / not in the dictionary; pronounced by spelling rules and possibly wrong"})
        else:
            self._warnings.append({"word": token.text, "note": "读不出来，已跳过 / cannot be pronounced; skipped"})
        return ps, 1

    def ready(self, lang: str) -> bool:
        return self.status.get(lang) == "ready"

    def wait(self, lang: str, seconds: float) -> None:
        """等这种语言的模型加载完；不能用就抛 NotReady。 / Wait for the language's model; raises NotReady when unusable."""
        if self.status[lang] == "missing":
            missing = config.missing_files(self.state, config.model_for(lang))
            raise NotReady(
                f"{lang} 的模型文件还没下载（缺 {len(missing)} 个）。先运行：uv run --extra model python -m soma_tts.fetch --state <状态目录>",
                f"the model files for {lang} are not downloaded ({len(missing)} missing). Run first: uv run --extra model python -m soma_tts.fetch --state <state directory>",
            )
        self.start()
        if not self._loaded[lang].wait(seconds):
            raise NotReady(f"{lang} 的模型还在加载，过几秒再试", f"the model for {lang} is still loading; retry in a few seconds")
        if self.status[lang] != "ready":
            raise NotReady(f"{lang} 的模型加载失败：{self.errors.get(lang, '')}", f"the model for {lang} failed to load: {self.errors.get(lang, '')}")

    # —— 文字转记号 / text to symbols ——

    def _english(self, text: str, vocab: dict) -> tuple[list[phones.Unit], list[str]]:
        _, tokens = self._g2p["en"](text)
        units: list[phones.Unit] = []
        words: list[str] = []
        for tk in tokens:
            ps = tk.phonemes or ""
            spoken = any(c in phones.EN_SYMBOLS for c in ps)
            index = None
            if spoken:
                index = len(words)
                words.append(tk.text)
            units += [phones.Unit(c, 0, index) for c in ps if c in vocab]
            units += [phones.Unit(c, 0, None) for c in (tk.whitespace or "") if c in vocab]
        return units, words

    def _mandarin(self, text: str, vocab: dict) -> tuple[list[phones.Unit], list[str]]:
        import cn2an
        from misaki import zh

        g2p = self._g2p["zh"]
        text = zh.ZHG2P.map_punctuation(cn2an.transform(text, "an2cn"))
        _, tokens = g2p.frontend(text)
        units: list[phones.Unit] = []
        words: list[str] = []
        for tk in tokens:
            ps = tk.phonemes or ""
            spoken = any(c in phones.ZH_INITIALS or c in phones.ZH_FINALS for c in ps)
            index = None
            if spoken:
                index = len(words)
                words.append(tk.text)
            elif tk.phonemes is None and tk.text.strip():
                self._warnings.append({"word": tk.text, "note": "读不出来，已跳过 / cannot be pronounced; skipped"})
            units += [phones.Unit(c, 0, index) for c in ps if c in vocab]
            units += [phones.Unit(c, 0, None) for c in (tk.whitespace or "") if c in vocab]
        return units, words

    # —— 合成 / synthesis ——

    def synthesize(self, request: dict, wait_seconds: float = 60.0) -> dict:
        """request 是 schema.validate 的输出。返回 /api/tts 的结果，但 audio 还是 PCM 字节（键 pcm16）。
        `request` is the output of schema.validate. Returns the /api/tts result with the audio still as PCM bytes (key
        pcm16)."""
        lang = request["lang"]
        self.wait(lang, wait_seconds)
        import numpy as np
        import torch

        model = config.model_for(lang)
        net = self._models[lang]
        with self._lock:
            self._warnings = []
            units, word_texts = (self._english if lang == "en" else self._mandarin)(request["text"], net.vocab)
            warnings = self._warnings
            # 去掉首尾的空格记号 / drop leading and trailing space symbols
            while units and units[0].symbol in phones.SPACES:
                units.pop(0)
            while units and units[-1].symbol in phones.SPACES:
                units.pop()
            if not word_texts:
                raise schema.RequestError("text", "里面没有能读出来的内容", "contains nothing that can be spoken", "words in the chosen language")
            if len(units) > schema.MAX_SYMBOLS:
                raise schema.RequestError("text", f"太长：转成 {len(units)} 个发音记号，模型一次最多 {schema.MAX_SYMBOLS} 个，请缩短", f"too long: it becomes {len(units)} pronunciation symbols and the model takes at most {schema.MAX_SYMBOLS}; shorten it", {"maxSymbols": schema.MAX_SYMBOLS})
            speed = request["speed"] * (zh_speed_factor(len(units)) if lang == "zh" else 1.0)
            ids = torch.LongTensor([[0, *[net.vocab[u.symbol] for u in units], 0]])
            pack = self._voices[(lang, request["voice"])]
            torch.manual_seed(SEED)
            started = time.monotonic()
            with torch.no_grad():
                audio, pred_dur = net.forward_with_tokens(ids, pack[len(units) - 1], speed)
            elapsed = time.monotonic() - started
        frames = [int(x) for x in pred_dur.reshape(-1).tolist()]
        samples = audio.reshape(-1).cpu().numpy()
        frame_samples = round(phones.FRAME_SECONDS * config.SAMPLE_RATE)
        if len(frames) != len(units) + 2 or len(samples) != sum(frames) * frame_samples:
            raise RuntimeError(f"时长和声音对不上 / durations do not match the audio: {len(frames)} durations for {len(units)} symbols, {len(samples)} samples for {sum(frames)} frames")
        duration = len(samples) / config.SAMPLE_RATE
        if duration > schema.MAX_SECONDS:
            raise schema.RequestError("text", f"合成出来有 {duration:.1f} 秒，超过上限 {schema.MAX_SECONDS:g} 秒（返回要小于 1 MB）；请缩短文字或调高 speed", f"the audio would be {duration:.1f} s, over the {schema.MAX_SECONDS:g} s cap (the reply must stay under 1 MB); shorten the text or raise speed", {"maxSeconds": schema.MAX_SECONDS})
        for u, n in zip(units, frames[1:-1]):
            u.frames = n
        # 每帧有没有声音：比最响的一帧低 AUDIBLE_DB 以内算有 / whether each frame has sound: within AUDIBLE_DB of the loudest frame
        power = (samples.astype(np.float64).reshape(-1, frame_samples) ** 2).mean(axis=1)
        audible = (power > power.max() * 10 ** (-AUDIBLE_DB / 10)).tolist() if power.max() > 0 else None
        segs = (phones.english_segments if lang == "en" else phones.mandarin_segments)(units, frames[0], frames[-1], audible)
        phone_list, words = phones.timeline(segs, word_texts)
        pcm16 = (np.clip(samples, -1.0, 1.0) * 32767.0).round().astype("<i2").tobytes()
        return {
            "sampleRate": config.SAMPLE_RATE,
            "durationS": round(duration, 4),
            "pcm16": pcm16,
            "lang": lang,
            "voice": request["voice"],
            "speed": request["speed"],
            "phonemes": phone_list,
            "words": words,
            "symbols": "".join(u.symbol for u in units),
            "warnings": warnings,
            "model": {"name": model["name"], "version": model["version"], "licence": model["licence"], "source": model["source"], "commit": model["commit"]},
            "synthesisSeconds": round(elapsed, 3),
            "units": [(u.symbol, u.frames) for u in units],
            "edgeFrames": (frames[0], frames[-1]),
        }
