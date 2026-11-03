"""post.py: same length, nothing moves in time, emotion pitch by varispeed (no GPU).
    cd deploy/modal-voice && <modal venv>/bin/python -m unittest test_post -v
"""
import unittest

import numpy as np

import post

FS = post.FS


def clause(sec=1.5, tail_ms=170):
    t = np.arange(int(FS * sec)) / FS
    f0 = 180 + 20 * np.sin(2 * np.pi * 1.5 * t)
    x = 0.3 * np.sin(2 * np.pi * np.cumsum(f0) / FS) * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t) ** 2)
    x[: int(0.04 * FS)] = 0
    return np.concatenate([x, np.zeros(int(FS * tail_ms / 1000))]).astype(np.float32), tail_ms


def onset_ms(y):
    env = np.convolve(np.abs(y), np.ones(48) / 48, "same")
    return np.argmax(env > 0.1 * env.max()) / FS * 1000


class Polish(unittest.TestCase):
    def test_same_length_and_no_time_shift(self):
        x, tail = clause()
        y = post.polish(x, tail, last=False, breath_db=-40.0)
        self.assertEqual(len(y), len(x))
        self.assertLess(abs(onset_ms(y) - onset_ms(x)), 2.0)
        self.assertLessEqual(float(np.max(np.abs(y))), 0.971)

    def test_silence_and_tiny_clauses_pass_through(self):
        z = np.zeros(FS, np.float32)
        self.assertTrue(np.array_equal(post.polish(z), z))
        short = np.full(100, 0.1, np.float32)
        self.assertTrue(np.array_equal(post.polish(short), short))

    def test_breath_only_inside_a_long_pause_and_never_on_the_last_clause(self):
        x, tail = clause(tail_ms=200)
        voiced = len(x) - int(FS * 0.2)
        with_b = post.polish(x, 200, last=False, rough_db=0, deess=False, air=0, breath_db=-30.0)
        last = post.polish(x, 200, last=True, rough_db=0, deess=False, air=0, breath_db=-30.0)
        self.assertGreater(float(np.abs(with_b[voiced:]).max()), 0)
        self.assertEqual(float(np.abs(last[voiced:]).max()), 0)


class Emotion(unittest.TestCase):
    def test_neutral_or_unknown_is_unchanged(self):
        x, tail = clause()
        self.assertEqual(post.pitch_ratio(None), 1.0)
        self.assertEqual(post.pitch_ratio("neutral"), 1.0)
        self.assertIs(post.tone(x, "neutral"), x)

    def test_varispeed_shortens_by_the_ratio_and_raises_the_pitch(self):
        r = post.pitch_ratio("excited")
        self.assertAlmostEqual(12 * np.log2(r), 1.5, places=6)
        t = np.arange(16000) / 16000
        w = np.sin(2 * np.pi * 200 * t).astype(np.float32)
        y = post.varispeed(w, r)
        self.assertLess(abs(len(y) - len(w) / r), 3)
        f = np.fft.rfftfreq(len(y), 1 / 16000)[np.argmax(np.abs(np.fft.rfft(y)))]
        self.assertLess(abs(f - 200 * r), 3.0)

    def test_every_emotion_shift_is_small(self):
        for e in post.SHIFT_ST:
            self.assertLessEqual(abs(12 * np.log2(post.pitch_ratio(e))), 2.0, e)

    def test_tone_keeps_length_and_silence(self):
        x, tail = clause()
        for e in ("excited", "warm", "sad", "teasing"):
            y = post.tone(x, e)
            self.assertEqual(len(y), len(x))
            self.assertLess(float(np.abs(y[-int(FS * 0.1):]).max()), 1e-4, f"{e}: the pause stays silent (filter ring dies in a few ms)")


if __name__ == "__main__":
    unittest.main()
