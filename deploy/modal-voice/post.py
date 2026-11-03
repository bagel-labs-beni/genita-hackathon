"""Post-processing for the Seamless voice (11/3, Chelsea: "post-processing yes, but it must not cost quality; add
emotion"). Classic DSP only (numpy/scipy), no model, no sample files.

Measured on the 4 V04 voices (UTMOS22 + NISQA, numbers in the PR), only what does not cost quality is on:
  - polish(): a -1 dB cut of the rough 3 kHz band (grid winner of 48 combos: UTMOS -0.002, NISQA +0.008 vs raw).
    The exciter, de-esser and synthesized inhale are implemented but off (each lowered NISQA); WORLD resynthesis,
    PSOLA and compression/loudness were tried and dropped (UTMOS -0.1 to -0.7).
  - emotion: pitch by varispeed (Seamless synthesizes r times slower, the audio is resampled r times shorter: pitch x r,
    same length as the plain synth; the character timing is scaled by r and the aligner runs on the final audio),
    plus a small brightness/level tone per emotion. Every emotion stays within 0.1 UTMOS of the raw voice.
polish() and tone() never move a sample in time.
"""
import math

import numpy as np
from scipy.signal import butter, sosfilt, lfilter

FS = 24000

POLISH = {"rough_db": -1.0, "deess": False, "air": 0.0, "breath_db": None}  # 11/3 grid winner (48 combos, n=24): UTMOS -0.002, NISQA +0.008 vs raw; exciter, de-esser and inhale each lowered NISQA, so they stay off

# label (genita-server EMOTION_SPEED keys) -> tone (brightness/level). Pitch: SHIFT_ST below.
EMOTIONS = {
    "excited": {"shift_st": 1.5, "range": 1.15, "gain_db": 1.0, "bright_db": 1.5, "end_st": 0.0},
    "happy": {"shift_st": 1.0, "range": 1.1, "gain_db": 0.5, "bright_db": 1.5, "end_st": 0.0},
    "surprised": {"shift_st": 1.5, "range": 1.15, "gain_db": 1.0, "bright_db": 1.0, "end_st": 1.5},
    "teasing": {"shift_st": 0.8, "range": 1.12, "gain_db": 0.5, "bright_db": 1.0, "end_st": 2.0},
    "playful": {"shift_st": 0.8, "range": 1.12, "gain_db": 0.5, "bright_db": 1.0, "end_st": 2.0},
    "warm": {"shift_st": -0.5, "range": 1.0, "gain_db": 0.0, "bright_db": -1.5, "end_st": -1.0},
    "sad": {"shift_st": -1.2, "range": 0.85, "gain_db": -0.9, "bright_db": -1.2, "end_st": -1.5},  # 0.6x: NISQA
    "whisper": {"shift_st": -0.5, "range": 0.9, "gain_db": -2.0, "bright_db": -1.0, "end_st": -1.0},
}


def _peak(f0, gain_db, q, fs=FS):
    a = 10 ** (gain_db / 40); w = 2 * math.pi * f0 / fs; al = math.sin(w) / (2 * q)
    b = [1 + al * a, -2 * math.cos(w), 1 - al * a]; d = [1 + al / a, -2 * math.cos(w), 1 - al / a]
    return np.array([[b[0] / d[0], b[1] / d[0], b[2] / d[0], 1.0, d[1] / d[0], d[2] / d[0]]])


def _shelf(f0, gain_db, fs=FS, s=0.8):
    a = 10 ** (gain_db / 40); w = 2 * math.pi * f0 / fs; c = math.cos(w)
    al = math.sin(w) / 2 * math.sqrt((a + 1 / a) * (1 / s - 1) + 2)
    b0 = a * ((a + 1) + (a - 1) * c + 2 * math.sqrt(a) * al); b1 = -2 * a * ((a - 1) + (a + 1) * c)
    b2 = a * ((a + 1) + (a - 1) * c - 2 * math.sqrt(a) * al); a0 = (a + 1) - (a - 1) * c + 2 * math.sqrt(a) * al
    a1 = 2 * ((a - 1) - (a + 1) * c); a2 = (a + 1) - (a - 1) * c - 2 * math.sqrt(a) * al
    return np.array([[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]])


_BAND = butter(4, [3800, 7600], "bandpass", fs=FS, output="sos")
_AIR = butter(4, [8200, 11500], "bandpass", fs=FS, output="sos")
_SIB = butter(2, [5000, 8000], "bandpass", fs=FS, output="sos")
_BREATH = butter(2, [600, 3200], "bandpass", fs=FS, output="sos")


def _rms(x):
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if len(x) else 0.0


def _same_len(y, n):
    return y[:n] if len(y) >= n else np.concatenate([y, np.zeros(n - len(y), np.float32)])


def polish(x, tail_ms=0, last=True, rough_db=None, deess=None, air=None, breath_db="default"):
    """x: float32 24 kHz clause including its tail. Same length out."""
    p = POLISH
    rough_db = p["rough_db"] if rough_db is None else rough_db
    deess = p["deess"] if deess is None else deess
    air = p["air"] if air is None else air
    breath_db = p["breath_db"] if breath_db == "default" else breath_db
    y = np.asarray(x, dtype=np.float32)
    if len(y) < int(0.03 * FS) or not np.any(y):
        return y.copy()
    if rough_db:
        y = sosfilt(_peak(3000, rough_db, 1.0), y)
    if deess:
        sb = sosfilt(_SIB, y)
        a = 1 - math.exp(-1 / (0.005 * FS))
        env = np.sqrt(np.maximum(lfilter([a], [1, a - 1], sb * sb), 1e-12))
        over = np.clip(20 * np.log10(env / (_rms(y) + 1e-9)) + 12, 0, 6)  # only where 5-8 kHz is > -12 dB re the clause
        y = y - sb * (1 - 10 ** (-over / 20))
    if air:
        b = sosfilt(_BAND, y)
        h = sosfilt(_AIR, np.abs(b))
        hr = _rms(h)
        if hr > 0:
            y = y + air * h * (_rms(b) / hr)
    if breath_db is not None and not last and tail_ms >= 160:
        n = int(min(0.16, tail_ms / 1000 * 0.8) * FS)
        br = sosfilt(_BREATH, np.random.default_rng(len(y)).standard_normal(n)) * np.sin(np.linspace(0, math.pi, n)) ** 1.5
        voiced = y[: len(y) - int(tail_ms * FS / 1000)]
        br *= (_rms(voiced) * 10 ** (breath_db / 20)) / (_rms(br) + 1e-12)
        e = len(y) - int(0.01 * FS)
        y = y.copy(); y[e - n: e] += br
    pk = float(np.max(np.abs(y)))
    if pk > 0.97:
        y = y * (0.97 / pk)
    return y.astype(np.float32)


# ---- pitch by varispeed (11/3, after PSOLA cost -0.25 UTMOS even at 60 % strength) ----
# Seamless synthesizes a little slower (speed / r) and the audio is resampled r times shorter: pitch x r, same length
# as the plain synth at `speed`, no resynthesis artefacts (formants move with it, like a slightly brighter/darker voice).
SHIFT_ST = {"excited": 1.5, "happy": 1.0, "surprised": 1.5, "teasing": 0.8, "playful": 0.8, "warm": -0.5, "sad": -0.5, "whisper": -0.5}
# 11/3 n=24 (4 voices x 6 lines) vs raw UTMOS 4.136 / NISQA 4.687: excited -0.06/+0.00, warm -0.07/-0.06, teasing -0.05/-0.02
# all within 0.1 at full strength; sad at full strength (-0.8 st) cost NISQA -0.12, at 0.6x +0.01/-0.05, so sad is 0.6x


STRENGTH = 1.0  # scales every emotion move (pitch and tone); set from the 11/3 n=24 check, see the PR


def pitch_ratio(emotion, strength=None):
    strength = STRENGTH if strength is None else strength
    st = SHIFT_ST.get((emotion or "").lower(), 0.0) * strength
    return 2 ** (st / 12)


def varispeed(wav16, r):
    """r > 1: pitch up r, length / r (polyphase resample, 16 kHz in and out)."""
    if abs(r - 1) < 1e-4:
        return wav16
    from fractions import Fraction
    from scipy.signal import resample_poly
    f = Fraction(1 / r).limit_denominator(200)
    return resample_poly(wav16, f.numerator, f.denominator).astype(np.float32)


def tone(x, emotion, strength=None):
    """brightness + level for the emotion (no resynthesis), same length."""
    strength = STRENGTH if strength is None else strength
    e = EMOTIONS.get((emotion or "").lower())
    if not e:
        return x
    y = np.asarray(x, np.float32)
    if e["bright_db"]:
        y = sosfilt(_shelf(4000, e["bright_db"] * strength), y).astype(np.float32)
    if e["gain_db"]:
        y = y * 10 ** (e["gain_db"] * strength / 20)
    pk = float(np.max(np.abs(y))) if len(y) else 0.0
    return (y * (0.97 / pk) if pk > 0.97 else y).astype(np.float32)
