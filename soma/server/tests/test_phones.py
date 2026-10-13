"""记号和帧数 → 时间线（纯函数，不需要模型）。 / Symbols and frames → the timeline (pure functions; no model needed)."""

from __future__ import annotations

from soma_tts import g2p_en, phones
from soma_tts.phones import Unit


def units(spec, word=0):
    return [Unit(sym, n, w) for sym, n, w in spec]


def check_cover(segs, total_half):
    assert segs[0].start == 0 and segs[-1].end == total_half
    for a, b in zip(segs, segs[1:]):
        assert a.end == b.start
    assert all(s.end > s.start for s in segs)


def test_english_stress_er_and_spaces():
    # "bˈI wˈɔTəɹ." buy water
    spec = [("b", 2, 0), ("ˈ", 2, 0), ("I", 4, 0), (" ", 2, None), ("w", 2, 1), ("ˈ", 1, 1), ("ɔ", 3, 1), ("T", 1, 1), ("ə", 2, 1), ("ɹ", 2, 1), (".", 4, None)]
    lead, trail = 8, 2
    segs = phones.english_segments(units(spec), lead, trail)
    total = 2 * (lead + trail + sum(n for _, n, _ in spec))
    check_cover(segs, total)
    assert [s.phone for s in segs] == ["sil", "B", "AY", "W", "AO", "DX", "ER", "sil"]
    by = {s.phone: s for s in segs}
    assert by["AY"].extra["stress"] == 1 and by["AO"].extra["stress"] == 1 and by["ER"].extra["stress"] == 0 and by["B"].extra["stress"] is None
    assert by["ER"].symbol == "əɹ"
    # 重音记号的帧并入元音；空格对半分；整体提前 SHIFT_HALF / the stress mark's frames join the vowel; the space is halved; all shifted by SHIFT_HALF
    assert by["AY"].end - by["AY"].start == 2 * (2 + 4) + 2
    assert by["B"].start == 2 * lead - phones.SHIFT_HALF
    phone_list, words = phones.timeline(segs, ["buy", "water"])
    assert [w["text"] for w in words] == ["buy", "water"]
    assert words[0]["t0"] == phone_list[1]["t0"] and words[1]["t1"] == phone_list[-2]["t1"]
    assert phone_list[-1]["t1"] == round(total * phones.HALF, 4)


def test_schwa_r_before_a_vowel_stays_two_phones():
    # "əɹˈIv" arrive
    segs = phones.english_segments(units([("ə", 2, 0), ("ɹ", 2, 0), ("ˈ", 1, 0), ("I", 4, 0), ("v", 2, 0)]), 6, 4)
    assert [s.phone for s in segs] == ["sil", "AX", "R", "AY", "V", "sil"]


def test_mandarin_tones_erhua_and_parts():
    # 院儿 "元R4" + 去 "ㄑㄩ4"
    spec = [("元", 4, 0), ("R", 2, 0), ("4", 2, 0), ("/", 2, None), ("ㄑ", 2, 1), ("ㄩ", 3, 1), ("4", 3, 1), (".", 3, None)]
    segs = phones.mandarin_segments(units(spec), 6, 2)
    check_cover(segs, 2 * (6 + 2 + sum(n for _, n, _ in spec)))
    assert [(s.phone, s.extra.get("part"), s.extra.get("tone")) for s in segs] == [
        ("sil", None, None), ("van", "final", 4), ("r", "erhua", 4), ("q", "initial", None), ("v", "final", 4), ("sil", None, None)]
    assert segs[1].symbol == "元"


def test_every_model_symbol_has_a_phone():
    assert len(phones.ZH_INITIALS) == 21 and len(set(phones.ZH_INITIALS.values())) == 21
    assert len(set(phones.ZH_FINALS.values())) == len(phones.ZH_FINALS) == 38
    for name in ("v", "ve", "van", "vn", "ii", "iii", "er"):
        assert name in phones.ZH_FINALS.values()
    standard = "AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH UH UW V W Y Z ZH".split()
    assert set(standard) <= set(phones.ARPABET) and set(phones.ARPABET) - set(standard) == {"AX", "IX", "DX"}


def test_pauses_follow_the_audio():
    # 最后一个音名义上很长，但后面一大半没有声音；第一个音其实在起始记号里就开始了。
    # The last sound is nominally long but most of it is silent; the first sound really starts inside the begin symbol.
    spec = [("m", 2, 0), ("ɑ", 4, 0), ("p", 10, 0), (".", 4, None)]
    lead, trail = 10, 2
    frames = lead + trail + sum(n for _, n, _ in spec)
    audible = [False] * frames
    for f in range(7, 17):
        audible[f] = True
    segs = phones.english_segments(units(spec), lead, trail, audible)
    check_cover(segs, 2 * frames)
    assert [s.phone for s in segs] == ["sil", "M", "AA", "P", "sil"]
    assert segs[1].start == 2 * 7
    assert segs[3].end == 2 * 17
    # 全是静音时每个音仍然有长度 / with no sound at all every phone still has a length
    quiet = phones.english_segments(units(spec), lead, trail, [False] * frames)
    check_cover(quiet, 2 * frames)


def test_spelling_fallback_gives_known_symbols():
    for word, expect in (("xyzzy", "ksˈizi"), ("make", "mˈAk"), ("", ""), ("123", "")):
        assert g2p_en.spell_out(word) == expect
    for word in ("blorptastic", "Quizzaciously", "o'neill"):
        out = g2p_en.spell_out(word)
        assert out and all(c in phones.EN_SYMBOLS or c in phones.STRESS for c in out)
