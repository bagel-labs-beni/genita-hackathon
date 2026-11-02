"""Word + phoneme timings for synthesized speech with Meta's MMS forced aligner (torchaudio MMS_FA,
Meta open weights, CC-BY-NC 4.0). Runs on the voice GPU next to SeamlessM4T v2.

The aligner takes romanized letters (a-z, '). Text -> letters is rule-based, no model:
  - Latin: lowercase, accents stripped; English letter groups (digraphs, silent final e) become ARPAbet
    labels, so the app's LipViseme(phoneme:) maps each one to a mouth shape.
  - Hangul: each syllable is split into jamo (initial / medial / final); letters are uroman's (what MMS_FA
    was trained on), labels follow pronunciation (coda vs. linked onto a following silent ㅇ).
  - Anything else (digits, other scripts, punctuation) is skipped; a word with no letters gets no timing.

Output (`timing`), all ms from the start of this request's audio:
  {"words": [{"w": "Hey", "s": 40, "e": 260}, ...], "phonemes": [{"p": "HH", "s": 40, "e": 90}, ...]}
CTC spans are spiky (a letter lasts 1-2 frames of 20 ms), so each phoneme is held until the next one
starts when the gap is short (< FILL_S). Around a real pause the audio itself decides (signal level, no model):
the last phoneme before it is held while the audio is still voiced (<= HOLD_S), and the first phoneme after it
starts at the speech onset (<= LEAD_S earlier than its CTC spike). Without level data: held TAIL_S.

Everything above the `Aligner` class is pure Python (unit-tested without torch: test_align.py).
"""
from __future__ import annotations

import threading
import time
import unicodedata
from dataclasses import dataclass, field

REV = "11/3-uroman-snap-hold50"  # reported by /healthz, so a deploy can be checked against the running container
FILL_S = 0.12  # gaps up to this are held by the previous phoneme (connected speech)
TAIL_S = 0.04  # before a pause, without level data: held this much longer than its CTC span
HOLD_S = 0.50  # before a pause: held while voiced, at most this long after its CTC span (Korean final 요 runs ~0.4 s)
LEAD_S = 0.12  # after a pause: starts at the speech onset, at most this much before its CTC spike
# Mean letter probability below this = the text does not match the audio: no timing. Low on purpose: the text is
# what was synthesized, and silent letters (the h in "oh", the w in "wow") score near 0 even when the alignment is
# right (isolated "Oh wow," = 0.09, "Hmm," = 0.07; a full sentence 0.6-0.9).
MIN_SCORE = 0.05
LETTERS = set("abcdefghijklmnopqrstuvwxyz'")


@dataclass
class Unit:
    letters: str
    label: str | None  # ARPAbet; None = silent (its time goes to the neighbouring phoneme)


@dataclass
class Word:
    text: str
    units: list[Unit] = field(default_factory=list)


# ---------------- Latin (English letter groups -> ARPAbet) ----------------
_VOWELS = set("aeiouy")
_DIGRAPHS: dict[str, list[tuple[str, str | None]]] = {
    "th": [("th", "TH")], "sh": [("sh", "SH")], "ch": [("ch", "CH")], "zh": [("zh", "ZH")],
    "ph": [("ph", "F")], "wh": [("wh", "W")], "ng": [("ng", "NG")], "ck": [("ck", "K")],
    "gh": [("gh", None)], "qu": [("q", "K"), ("u", "W")],
    "oo": [("oo", "UW")], "ee": [("ee", "IY")], "ea": [("ea", "IY")], "ie": [("ie", "IY")],
    "ei": [("ei", "IY")], "ey": [("ey", "EY")], "ai": [("ai", "EY")], "ay": [("ay", "EY")],
    "ou": [("ou", "AW")], "ow": [("ow", "OW")], "oa": [("oa", "OW")], "au": [("au", "AO")],
    "aw": [("aw", "AO")], "oi": [("oi", "OY")], "oy": [("oy", "OY")],
}
_SINGLE = {
    "a": "AE", "b": "B", "c": "K", "d": "D", "e": "EH", "f": "F", "g": "G", "h": "HH", "i": "IH",
    "j": "JH", "k": "K", "l": "L", "m": "M", "n": "N", "o": "AO", "p": "P", "q": "K", "r": "R",
    "s": "S", "t": "T", "u": "UH", "v": "V", "w": "W", "x": "K", "y": "IY", "z": "Z",
}


def latin_units(run: str) -> list[Unit]:
    """One run of Latin letters (lowercase a-z) -> letter groups with ARPAbet labels."""
    c = run
    silent_e = len(c) >= 3 and c[-1] == "e" and c[-2] not in _VOWELS and c[-3] in _VOWELS
    if silent_e:
        c = c[:-1]
    out: list[Unit] = []
    i = 0
    while i < len(c):
        d = _DIGRAPHS.get(c[i:i + 2]) if i + 1 < len(c) else None
        if d:
            out += [Unit(letters, label) for letters, label in d]
            i += 2
            continue
        ch = c[i]
        if ch == "h":  # h is only heard before a vowel ("hey", "ahead"; silent in "oh", "hmm")
            label = "HH" if i + 1 < len(c) and c[i + 1] in _VOWELS else None
        elif ch == "y":
            label = "Y" if i == 0 and len(c) > 1 and c[1] in _VOWELS else "IY"
        else:
            label = _SINGLE.get(ch)
        out.append(Unit(ch, label))
        i += 1
    if silent_e:
        out.append(Unit("e", None))
    return out


# ---------------- Hangul (jamo -> romanized letters + ARPAbet) ----------------
# Letters follow uroman (what MMS_FA was trained on: a fixed letter string per jamo, spelling-based);
# labels follow pronunciation (final consonants as codas, linked onto a following silent ㅇ as onsets).
# initial consonants (19): (letters, label); ㅇ is silent
_INITIAL = [("g", "G"), ("gg", "K"), ("n", "N"), ("d", "D"), ("dd", "T"), ("r", "L"), ("m", "M"), ("b", "B"),
            ("bb", "P"), ("s", "S"), ("ss", "S"), ("", None), ("j", "JH"), ("jj", "CH"), ("c", "CH"),
            ("k", "K"), ("t", "T"), ("p", "P"), ("h", "HH")]
# medial vowels (21): (letters, label) parts
_MEDIAL = [
    [("a", "AA")], [("ae", "EH")], [("y", "Y"), ("a", "AA")], [("y", "Y"), ("ae", "EH")],
    [("eo", "AO")], [("e", "EH")], [("y", "Y"), ("eo", "AO")], [("y", "Y"), ("e", "EH")],
    [("o", "OW")], [("w", "W"), ("a", "AA")], [("w", "W"), ("ai", "EH")], [("o", "W"), ("e", "EH")],
    [("y", "Y"), ("o", "OW")], [("u", "UW")], [("w", "W"), ("eo", "AO")], [("w", "W"), ("e", "EH")],
    [("w", "W"), ("i", "IY")], [("y", "Y"), ("u", "UW")], [("eu", "IH")], [("yi", "IY")], [("i", "IY")],
]
# final consonants (28, 0 = none): parts (letters, label as a coda, label when linked onto a silent ㅇ).
# A cluster keeps one consonant as the coda (the other part is silent) and links its second part.
_FINAL = [
    None,
    [("g", "K", "G")], [("gg", "K", "K")], [("g", "K", "K"), ("s", None, "S")], [("n", "N", "N")],
    [("n", "N", "N"), ("j", None, "JH")], [("n", "N", "N"), ("h", None, None)], [("d", "T", "D")],
    [("l", "L", "L")], [("l", None, "L"), ("g", "K", "G")], [("l", None, "L"), ("m", "M", "M")],
    [("l", "L", "L"), ("b", None, "B")], [("l", "L", "L"), ("s", None, "S")], [("l", "L", "L"), ("t", None, "T")],
    [("l", None, "L"), ("p", "P", "P")], [("l", "L", "L"), ("h", None, None)], [("m", "M", "M")],
    [("b", "P", "B")], [("b", "P", "P"), ("s", None, "S")], [("s", "T", "S")], [("ss", "T", "S")],
    [("ng", "NG", "NG")], [("j", "T", "JH")], [("c", "T", "CH")], [("k", "K", "K")], [("t", "T", "T")],
    [("p", "P", "P")], [("h", None, None)],
]


def _syllable(ch: str) -> tuple[int, int, int] | None:
    v = ord(ch) - 0xAC00
    if not 0 <= v < 11172:
        return None
    return v // 588, (v % 588) // 28, v % 28


def hangul_units(run: str) -> list[Unit]:
    """One run of Hangul syllables -> jamo units (uroman letters + ARPAbet)."""
    sy = [_syllable(c) for c in run]
    out: list[Unit] = []
    for k, s in enumerate(sy):
        if s is None:
            continue
        ini, med, fin = s
        if ini != 11:
            out.append(Unit(*_INITIAL[ini]))
        out += [Unit(letters, label) for letters, label in _MEDIAL[med]]
        if fin:
            nxt = sy[k + 1] if k + 1 < len(sy) else None
            linked = nxt is not None and nxt[0] == 11
            out += [Unit(letters, onset if linked else coda) for letters, coda, onset in _FINAL[fin]]
    return out


def plan(text: str) -> list[Word]:
    """Spoken text -> words with their romanized units. Words without letters are dropped."""
    words: list[Word] = []
    for token in text.split():
        w = Word(token)
        latin, hangul = "", ""

        def flush():
            nonlocal latin, hangul
            if latin:
                w.units.extend(latin_units(latin))
                latin = ""
            if hangul:
                w.units.extend(hangul_units(hangul))
                hangul = ""

        for ch in token:
            if _syllable(ch) is not None:
                if latin:
                    flush()
                hangul += ch
                continue
            folded = unicodedata.normalize("NFKD", ch.lower())
            base = "".join(c for c in folded if not unicodedata.combining(c))
            if len(base) == 1 and "a" <= base <= "z":
                if hangul:
                    flush()
                latin += base
            else:
                flush()  # apostrophes, hyphens, digits, other scripts: word-internal break, no letter
        flush()
        w.units = [u for u in w.units if u.letters]
        if w.units:
            words.append(w)
    return words


def letters_of(words: list[Word]) -> str:
    return "".join(u.letters for w in words for u in w.units)


def build_timing(words: list[Word], spans: list[tuple[int, int, float]], frame_s: float, audio_s: float,
                 voiced: list[bool] | None = None) -> dict | None:
    """Letter spans (start frame incl., end frame excl., prob) in `letters_of(words)` order -> timing dict
    (ms), or None when the spans do not fit or the alignment is not confident. voiced: per frame (same
    frames as the spans), True where the audio is loud enough to be speech."""
    n = sum(len(u.letters) for w in words for u in w.units)
    if n == 0 or len(spans) != n:
        return None
    if sum(p for _, _, p in spans) / n < MIN_SCORE:
        return None
    # phonemes: [word index, label, start s, end s]
    ph: list[list] = []
    k = 0
    for wi, w in enumerate(words):
        pending_start: float | None = None  # silent unit at a word start: its time goes to the next phoneme
        for u in w.units:
            seg = spans[k:k + len(u.letters)]
            k += len(u.letters)
            s, e = seg[0][0] * frame_s, seg[-1][1] * frame_s
            if u.label is None:
                if ph and ph[-1][0] == wi:
                    ph[-1][3] = max(ph[-1][3], e)
                elif pending_start is None:
                    pending_start = s
                continue
            if pending_start is not None:
                s, pending_start = pending_start, None
            ph.append([wi, u.label, s, e])
    if not ph:
        return None
    def is_voiced(f: int) -> bool:
        return voiced is not None and 0 <= f < len(voiced) and voiced[f]

    # run boundaries first (CTC times), so a moved edge never decides its neighbour
    starts_run = [i == 0 or ph[i][2] - ph[i - 1][3] > FILL_S for i in range(len(ph))]
    ends_run = [i + 1 == len(ph) or starts_run[i + 1] for i in range(len(ph))]
    orig = [(p[2], p[3]) for p in ph]
    for i, p in enumerate(ph):
        if starts_run[i] and voiced is not None:
            floor = max(orig[i - 1][1] if i else 0.0, orig[i][0] - LEAD_S)
            f = int(round(orig[i][0] / frame_s))
            while f - 1 >= 0 and (f - 1) * frame_s >= floor - 1e-9 and is_voiced(f - 1):
                f -= 1
            p[2] = min(p[2], f * frame_s)
        if ends_run[i]:
            ceil = min(orig[i + 1][0] if i + 1 < len(ph) else audio_s, orig[i][1] + (HOLD_S if voiced is not None else TAIL_S))
            if voiced is None:
                p[3] = max(p[3], ceil)
            else:
                f = int(round(orig[i][1] / frame_s))
                while (f + 1) * frame_s <= ceil + 1e-9 and is_voiced(f):
                    f += 1
                p[3] = max(p[3], f * frame_s)
        else:
            p[3] = max(p[3], orig[i + 1][0])
    for i in range(1, len(ph)):  # a voiced gap pulled from both sides: split it
        if ph[i][2] < ph[i - 1][3]:
            mid = (ph[i][2] + ph[i - 1][3]) / 2
            ph[i - 1][3] = ph[i][2] = mid
    ms = lambda x: int(round(x * 1000))
    phonemes, word_out = [], []
    for p in ph:
        s, e = ms(p[2]), ms(p[3])
        phonemes.append({"p": p[1], "s": s, "e": max(e, s + 1)})
    for wi, w in enumerate(words):
        mine = [p for p in ph if p[0] == wi]
        if mine:
            s, e = ms(mine[0][2]), ms(mine[-1][3])
            word_out.append({"w": w.text, "s": s, "e": max(e, s + 1)})
    return {"words": word_out, "phonemes": phonemes}


def voiced_frames(wav16, frames: int) -> list[bool]:
    """Per aligner frame: is the audio loud enough to be speech (RMS above 5% of the utterance's p95)?"""
    import numpy as np
    x = np.asarray(wav16, dtype=np.float32)
    if frames <= 0 or not len(x):
        return []
    edges = np.linspace(0, len(x), frames + 1).astype(int)
    rms = np.array([float(np.sqrt(np.mean(x[a:b] ** 2))) if b > a else 0.0 for a, b in zip(edges[:-1], edges[1:])])
    thr = max(1e-4, 0.05 * float(np.percentile(rms, 95)))
    return [bool(r > thr) for r in rms]


# ---------------- GPU aligner ----------------
class Aligner:
    """MMS_FA (wav2vec2 CTC, 1,130 languages, romanized letters). align() is thread-safe."""

    SR = 16000

    def __init__(self, device: str = "cuda"):
        import torch
        import torchaudio
        t0 = time.time()
        self.torch = torch
        self.F = torchaudio.functional
        bundle = torchaudio.pipelines.MMS_FA
        self.model = bundle.get_model(with_star=False).to(device).eval()
        self.dict = bundle.get_dict(star=None)
        self.device = device
        self.lock = threading.Lock()
        self.load_s = time.time() - t0
        self.rev = REV

    def align(self, wav16, text: str) -> tuple[dict | None, float]:
        """wav16: float32 mono 16 kHz, the request's audio from its first sample. -> (timing | None, ms)."""
        t0 = time.perf_counter()
        torch, F = self.torch, self.F
        words = plan(text)
        letters = letters_of(words)
        if not letters or len(wav16) < self.SR // 10:
            return None, (time.perf_counter() - t0) * 1000
        with self.lock, torch.inference_mode():
            x = torch.from_numpy(wav16).to(self.device).unsqueeze(0)
            emission, _ = self.model(x)
            frames = emission.shape[1]
            targets = torch.tensor([[self.dict[c] for c in letters]], dtype=torch.int32, device=self.device)
            ali, scores = F.forced_align(emission, targets, blank=0)
            ali, scores = ali[0].cpu(), scores[0].exp().cpu()
        spans = F.merge_tokens(ali, scores)
        frame_s = len(wav16) / self.SR / frames
        timing = build_timing(words, [(s.start, s.end, float(s.score)) for s in spans], frame_s, len(wav16) / self.SR,
                              voiced=voiced_frames(wav16, frames))
        return timing, (time.perf_counter() - t0) * 1000
