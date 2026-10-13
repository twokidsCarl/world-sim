"""时间线的健全性检查：塞音处的音素边界和声音里能量的突变差多少。
A sanity check on the timeline: how far phone boundaries at stops are from the energy changes in the audio.

塞音在元音之间有一段闭塞（能量骤降），然后除阻（能量骤升）。这里在 5 ms 一步的能量包络上找这两个时刻，
和时间线里塞音的起点、终点比较。这只是粗检：送气塞音除阻后还有一段送气，时间线把它算在塞音里，所以"终点"的差会偏负。
Between vowels a stop has a closure (energy falls sharply) and then a release (energy rises sharply). Both moments are
located on an energy envelope with a 5 ms step and compared with the start and end of the stop in the timeline. A rough
check only: an aspirated stop has aspiration after its release, which the timeline counts as part of the stop, so the
difference at the end leans negative.
"""

from __future__ import annotations

import numpy as np

HOP = 0.005
WINDOW = 0.010
SEARCH = 0.080
MIN_DIP_DB = 10.0

EN_STOPS = frozenset({"P", "T", "K", "B", "D", "G"})
ZH_STOPS = frozenset({"b", "p", "d", "t", "g", "k"})


def envelope(pcm: np.ndarray, sample_rate: int) -> np.ndarray:
    """分贝的短时能量，每 HOP 秒一个值。 / Short-time energy in dB, one value every HOP seconds."""
    hop, win = round(HOP * sample_rate), round(WINDOW * sample_rate)
    n = max(0, (len(pcm) - win) // hop + 1)
    x = pcm.astype(np.float64)
    out = np.empty(n)
    for i in range(n):
        seg = x[i * hop : i * hop + win]
        out[i] = 10 * np.log10(np.mean(seg * seg) + 1e-12)
    return out


def _steepest(env: np.ndarray, centre: float, sign: int) -> float | None:
    """centre 附近 ±SEARCH 秒内，能量上升（sign=+1）或下降（-1）最陡处的时刻（看 15 ms 的差分）。
    The moment of the steepest rise (sign=+1) or fall (-1) of energy within ±SEARCH seconds of `centre` (a 15 ms difference)."""
    span = 3
    lo = max(0, round((centre - SEARCH) / HOP))
    hi = min(len(env) - span, round((centre + SEARCH) / HOP))
    if hi <= lo:
        return None
    diff = sign * (env[lo + span : hi + span] - env[lo:hi])
    k = int(np.argmax(diff))
    if diff[k] < MIN_DIP_DB:
        return None
    # 窗的中心 / the centre of the windows
    return (lo + k + span / 2) * HOP + WINDOW / 2


def stop_differences(pcm: np.ndarray, sample_rate: int, phonemes: list[dict], lang: str) -> dict[str, list[float]]:
    """返回两组差（秒）：闭塞开始（能量骤降的时刻 − 塞音的 t0）和除阻（能量骤升的时刻 − 塞音的 t1）。
    只看夹在两个音之间的塞音；找不到明显突变的不计。
    Two sets of differences in seconds: closure onset (time of the energy fall − the stop's t0) and release (time of
    the energy rise − the stop's t1). Only stops between two sounds are used; those without a clear change are skipped."""
    env = envelope(pcm, sample_rate)
    stops = EN_STOPS if lang == "en" else ZH_STOPS
    closure: list[float] = []
    release: list[float] = []
    for i, p in enumerate(phonemes):
        if p["phone"] not in stops or (lang == "zh" and p.get("part") != "initial"):
            continue
        if i == 0 or i + 1 >= len(phonemes) or phonemes[i - 1]["phone"] == "sil" or phonemes[i + 1]["phone"] == "sil":
            continue
        fall = _steepest(env, p["t0"], -1)
        rise = _steepest(env, p["t1"], +1)
        if fall is not None:
            closure.append(round(fall - p["t0"], 4))
        if rise is not None:
            release.append(round(rise - p["t1"], 4))
    return {"closure": closure, "release": release}


def summary(values: list[float]) -> dict:
    """个数、中位数、平均、绝对值的中位数和 90 分位（毫秒）。 / Count, median, mean, and the median and 90th percentile of the absolute value (ms)."""
    if not values:
        return {"n": 0}
    v = np.array(values) * 1000
    return {"n": len(values), "medianMs": round(float(np.median(v)), 1), "meanMs": round(float(np.mean(v)), 1), "sdMs": round(float(np.std(v)), 1),
            "medianAbsMs": round(float(np.median(np.abs(v))), 1), "p90AbsMs": round(float(np.percentile(np.abs(v), 90)), 1)}
