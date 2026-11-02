"""Stream tests for the timing line (no GPU): needs the `modal` package only to import voice_app.
    cd deploy/modal-voice && <modal venv>/bin/python -m unittest test_voice_stream -v
"""
import asyncio
import json
import time
import unittest

import voice_app as va

PCM = b"\x01\x00" * 24000 * 2  # 2 s of audio -> 3 lines (300 ms, 1 s, 0.7 s)
TIMING = {"words": [{"w": "Hey", "s": 40, "e": 300}], "phonemes": [{"p": "HH", "s": 40, "e": 90}]}


class FakeAligner:
    def __init__(self, result=None, delay=0.0, error=None):
        self.result, self.delay, self.error = result, delay, error
        self.called_at = None

    def align(self, wav16, text):
        self.called_at = time.perf_counter()
        time.sleep(self.delay)
        if self.error:
            raise self.error
        return self.result, 12.5


def run(aligner, wait_ms=200):
    async def go():
        out = []
        async for line in va.aligned_lines(PCM, None, 80, 2000, 72, [0.0] * 16000, "Hey", aligner, wait_ms=wait_ms):
            out.append((time.perf_counter(), json.loads(line)))
        return out
    return asyncio.run(go())


class TimingLine(unittest.TestCase):
    def test_audio_lines_are_the_same_as_without_alignment(self):
        plain = [json.loads(x) for x in va.chunk_lines(PCM, None, 80, 2000, 72)]
        got = [j for _, j in run(FakeAligner(TIMING))]
        audio = [j for j in got if "audio_base64" in j]
        self.assertEqual(audio, [j for j in plain if "audio_base64" in j])

    def test_timing_line_after_audio_before_done(self):
        got = [j for _, j in run(FakeAligner(TIMING))]
        kinds = ["audio" if "audio_base64" in j else "timing" if "timing" in j else "done" for j in got]
        self.assertEqual(kinds, ["audio", "audio", "audio", "timing", "done"])
        self.assertEqual(got[3]["timing"], TIMING)
        self.assertEqual(got[-1]["align_ms"], 12.5)

    def test_first_audio_goes_out_before_the_aligner_starts(self):
        a = FakeAligner(TIMING)
        got = run(a)
        self.assertLess(got[0][0], a.called_at)

    def test_aligner_error_sends_no_timing(self):
        got = [j for _, j in run(FakeAligner(error=RuntimeError("cuda")))]
        self.assertFalse(any("timing" in j for j in got))
        self.assertTrue(got[-1]["done"])
        self.assertEqual(sum("audio_base64" in j for j in got), 3)

    def test_no_result_sends_no_timing(self):
        got = [j for _, j in run(FakeAligner(None))]
        self.assertFalse(any("timing" in j for j in got))

    def test_late_aligner_sends_no_timing_and_does_not_hold_the_stream(self):
        t0 = time.perf_counter()
        got = run(FakeAligner(TIMING, delay=0.5), wait_ms=50)
        self.assertFalse(any("timing" in j for _, j in got))
        self.assertLess(got[-1][0] - t0, 0.4)
        self.assertNotIn("align_ms", got[-1][1])


if __name__ == "__main__":
    unittest.main()
