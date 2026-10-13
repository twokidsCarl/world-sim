"""词典里没有的英文单词：按拼写规则给出一个大致的读音（misaki 的记号）。
English words missing from the dictionary: a rough pronunciation from spelling rules (in misaki's symbols).

misaki 原本用 espeak-ng（GPL-3）兜底，这里不装它。规则很粗，只求口形大致对；用到时会写进返回的 warnings。
misaki would fall back on espeak-ng (GPL-3), which is not installed here. The rules are crude and only aim at a
roughly right mouth shape; every use is reported under `warnings` in the reply.
"""

from __future__ import annotations

import re

# 从长到短匹配 / matched longest first
_RULES: list[tuple[str, str]] = [
    ("tion", "ʃən"), ("sion", "ʒən"), ("ough", "O"), ("augh", "ɔ"), ("eigh", "A"), ("igh", "I"),
    ("tch", "ʧ"), ("dge", "ʤ"), ("sch", "sk"), ("ch", "ʧ"), ("sh", "ʃ"), ("th", "θ"), ("ph", "f"), ("wh", "w"),
    ("ck", "k"), ("ng", "ŋ"), ("qu", "kw"), ("gh", "ɡ"), ("kn", "n"), ("wr", "ɹ"),
    ("ee", "i"), ("ea", "i"), ("oo", "u"), ("ou", "W"), ("ow", "O"), ("oi", "Y"), ("oy", "Y"), ("ai", "A"),
    ("ay", "A"), ("au", "ɔ"), ("aw", "ɔ"), ("oa", "O"), ("ie", "i"), ("ei", "A"), ("ey", "i"), ("ue", "u"),
    ("ew", "u"), ("ar", "ɑɹ"), ("er", "əɹ"), ("ir", "ɜɹ"), ("ur", "ɜɹ"), ("or", "ɔɹ"),
    ("a", "æ"), ("b", "b"), ("c", "k"), ("d", "d"), ("e", "ɛ"), ("f", "f"), ("g", "ɡ"), ("h", "h"), ("i", "ɪ"),
    ("j", "ʤ"), ("k", "k"), ("l", "l"), ("m", "m"), ("n", "n"), ("o", "ɑ"), ("p", "p"), ("q", "k"), ("r", "ɹ"),
    ("s", "s"), ("t", "t"), ("u", "ʌ"), ("v", "v"), ("w", "w"), ("x", "ks"), ("y", "i"), ("z", "z"),
]
_VOWELS = "əiuɑɔɛɜɪʊʌAIWYOæ"
_LONG = {"a": "A", "e": "i", "i": "I", "o": "O", "u": "u"}


def spell_out(word: str) -> str:
    """字母 → 记号；在第一个元音前加主重音。没有字母时返回空串。
    Letters → symbols, with primary stress before the first vowel. Returns an empty string when there are no letters."""
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return ""
    out = ""
    i = 0
    # 词尾不发音的 e 让前面的元音读长音（make、time）/ a silent final e lengthens the vowel before it (make, time)
    magic = len(w) >= 3 and w[-1] == "e" and w[-2] not in "aeiou" and w[-3] in _LONG and (len(w) == 3 or w[-4] not in "aeiou")
    if magic:
        w = w[:-1]
    while i < len(w):
        if magic and i == len(w) - 2:
            out += _LONG[w[i]]
            i += 1
            continue
        if w[i] == "c" and i + 1 < len(w) and w[i + 1] in "eiy":
            out += "s"
            i += 1
            continue
        if i > 0 and w[i] == w[i - 1] and w[i] not in "aeiou":
            i += 1
            continue
        for letters, symbols in _RULES:
            if w.startswith(letters, i):
                out += symbols
                i += len(letters)
                break
    first = next((k for k, c in enumerate(out) if c in _VOWELS), None)
    return out if first is None else out[:first] + "ˈ" + out[first:]
