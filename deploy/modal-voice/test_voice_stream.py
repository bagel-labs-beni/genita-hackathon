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
        self.calls = 0

    def align(self, wav16, text):
        self.calls += 1
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


def drain():
    """The aligner thread is shared by the module: let a previous test's slow job finish."""
    t0 = time.time()
    while va.align_queued() and time.time() - t0 < 5:
        time.sleep(0.01)


class TimingLine(unittest.TestCase):
    setUp = staticmethod(drain)
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


class Overload(unittest.TestCase):
    """Codex P1 (11/3): late alignments must not pile up and starve synthesis of threads."""
    setUp = staticmethod(drain)

    def streams(self, aligner, n, wait_ms=50):
        async def one():
            return [json.loads(x) async for x in va.aligned_lines(PCM, None, 80, 2000, 72, [0.0] * 16000, "Hey", aligner, wait_ms=wait_ms)]

        async def go():
            res = await asyncio.gather(*[one() for _ in range(n)])
            t0 = time.perf_counter()
            await asyncio.to_thread(lambda: None)  # what eng.render needs: a default-executor thread
            return res, (time.perf_counter() - t0) * 1000
        return asyncio.run(go())

    def test_a_busy_aligner_skips_instead_of_queueing(self):
        a = FakeAligner(TIMING, delay=0.3)
        res, _ = self.streams(a, 8)
        self.assertLessEqual(a.calls, va.ALIGN_MAX_QUEUED)
        self.assertTrue(all(r[-1]["done"] for r in res))
        self.assertTrue(all(sum("audio_base64" in j for j in r) == 3 for r in res))

    def test_alignment_never_holds_the_synthesis_threads(self):
        a = FakeAligner(TIMING, delay=0.3)
        _, ms = self.streams(a, 40)
        self.assertLess(ms, 100)


if __name__ == "__main__":
    unittest.main()


class GpuQueue(unittest.TestCase):
    """D27 capacity: a request that cannot get the GPU in QUEUE_WAIT_MS answers busy instead of queueing past the
    server's first-byte timeout."""

    def engine(self):
        import threading
        e = object.__new__(va.Engine)
        e.lock = threading.Lock()
        e._synth = lambda *a: ("wav", None, 1.0)
        return e

    def test_free_gpu_synthesizes(self):
        self.assertEqual(self.engine().synth("hi", "eng", 0)[0], "wav")

    def test_held_gpu_raises_busy_after_the_queue_wait(self):
        e = self.engine()
        old = va.QUEUE_WAIT_MS
        va.QUEUE_WAIT_MS = 50
        try:
            e.lock.acquire()
            t0 = time.perf_counter()
            with self.assertRaises(va.Busy):
                e.synth("hi", "eng", 0)
            self.assertLess(time.perf_counter() - t0, 0.5)
        finally:
            va.QUEUE_WAIT_MS = old
            e.lock.release()
        self.assertEqual(e.synth("hi", "eng", 0)[0], "wav", "the lock is free again after a busy answer")

    def test_queue_wait_is_below_the_server_timeout(self):
        self.assertLess(va.QUEUE_WAIT_MS + 500, 4000)
        self.assertGreaterEqual(va.MAX_INPUTS, va.TARGET_INPUTS)
