"""Unit tests for the pure-Python half of align.py (no torch, no GPU):
    cd deploy/modal-voice && python3 -m unittest test_align -v
"""
import unittest

from align import FILL_S, HOLD_S, MIN_SCORE, build_timing, hangul_units, latin_units, letters_of, plan


def labels(units):
    return [(u.letters, u.label) for u in units]


def even_spans(n, frames_per_letter=2, gap=1, prob=0.9, start=2):
    """n letter spans of `frames_per_letter` frames with `gap` blank frames between."""
    out, f = [], start
    for _ in range(n):
        out.append((f, f + frames_per_letter, prob))
        f += frames_per_letter + gap
    return out


class Romanize(unittest.TestCase):
    def test_english_digraphs_and_silent_e(self):
        self.assertEqual(labels(latin_units("the")), [("th", "TH"), ("e", "EH")])  # final e kept in "the"
        self.assertEqual(labels(latin_units("make")), [("m", "M"), ("a", "AE"), ("k", "K"), ("e", None)])
        self.assertEqual(labels(latin_units("food")), [("f", "F"), ("oo", "UW"), ("d", "D")])
        self.assertEqual(labels(latin_units("you")), [("y", "Y"), ("ou", "AW")])
        self.assertEqual(labels(latin_units("night")), [("n", "N"), ("i", "IH"), ("gh", None), ("t", "T")])

    def test_h_is_silent_unless_a_vowel_follows(self):
        self.assertEqual(labels(latin_units("oh")), [("o", "AO"), ("h", None)])
        self.assertEqual(labels(latin_units("hmm")), [("h", None), ("m", "M"), ("m", "M")])
        self.assertEqual(labels(latin_units("ahead"))[1], ("h", "HH"))

    def test_every_letter_is_alignable(self):
        # MMS_FA's dictionary is a-z and ' ; every unit's letters must come from it
        words = plan("Hey! Oh wow, you're back already? 네, 바로 저 모퉁이 돌면 있어요. Café naïve Mm-hm.")
        self.assertTrue(set(letters_of(words)) <= set("abcdefghijklmnopqrstuvwxyz"))

    def test_words_without_letters_are_dropped(self):
        self.assertEqual([w.text for w in plan("Hi — 3 ... ok")], ["Hi", "ok"])
        self.assertEqual(plan("... 123 !!"), [])

    def test_korean_jamo_romanization(self):
        # 네 = ㄴ + ㅔ
        self.assertEqual(labels(hangul_units("네")), [("n", "N"), ("e", "EH")])
        # 바로 = ㅂㅏ ㄹㅗ
        self.assertEqual(labels(hangul_units("바로")), [("b", "B"), ("a", "AA"), ("r", "L"), ("o", "OW")])
        # 돌면: final ㄹ before ㅁ stays a final l
        self.assertEqual(letters_of(plan("돌면")), "dolmyeon")

    def test_korean_final_links_onto_silent_initial(self):
        # 있어요: ㅆ is heard as the onset of 어
        self.assertEqual(letters_of(plan("있어요")), "isseoyo")
        # 읽어: cluster ㄺ splits, l stays, g moves
        self.assertEqual(letters_of(plan("읽어")), "ilgeo")
        # 강아지: ㅇ final never moves
        self.assertEqual(letters_of(plan("강아지")), "gangaji")

    def test_korean_letters_match_uroman(self):
        # MMS_FA was trained on uroman romanization; these are uroman 1.3's outputs (checked 11/3)
        uroman = {"까": "gga", "따": "dda", "빠": "bba", "짜": "jja", "싸": "ssa", "워": "weo", "의": "yi",
                  "좋아": "joha", "놓고": "nohgo", "있어요": "isseoyo", "강아지": "gangaji", "읽어": "ilgeo",
                  "돌면": "dolmyeon", "모퉁이": "motungi", "저녁은": "jeonyeogeun", "뭐": "mweo",
                  "생각이에요": "saenggagieyo", "같이": "gati", "드릴까요": "deurilggayo", "괜찮아": "gwaincanha",
                  "웨": "we", "외": "oe", "위": "wi", "얘": "yae", "예": "ye", "으": "eu", "앉아": "anja",
                  "닭": "dalg", "값이": "gabsi", "흙": "heulg", "많이": "manhi", "싫어": "silheo",
                  "했어": "haesseo", "학교": "haggyo", "국물": "gugmul"}
        for word, rom in uroman.items():
            self.assertEqual(letters_of(plan(word)), rom, word)

    def test_korean_labels_follow_pronunciation(self):
        # final ㅅ/ㅆ sound as t before a consonant, s when linked onto a silent ㅇ; final ㅎ is silent
        self.assertEqual(labels(hangul_units("있다"))[1], ("ss", "T"))
        self.assertEqual(labels(hangul_units("있어"))[1], ("ss", "S"))
        self.assertIn(("h", None), labels(hangul_units("좋아")))
        self.assertEqual(labels(hangul_units("닭")), [("d", "D"), ("a", "AA"), ("l", None), ("g", "K")])

    def test_mixed_script_word(self):
        self.assertEqual(letters_of(plan("OK네")), "okne")


class Timing(unittest.TestCase):
    FRAME = 0.02

    def test_shape_matches_the_app(self):
        words = plan("Hey you")
        t = build_timing(words, even_spans(len(letters_of(words))), self.FRAME, 1.0)
        self.assertEqual(set(t), {"words", "phonemes"})
        self.assertEqual([w["w"] for w in t["words"]], ["Hey", "you"])
        for w in t["words"]:
            self.assertEqual(set(w), {"w", "s", "e"})
            self.assertIsInstance(w["s"], int)
            self.assertGreater(w["e"], w["s"])
        for p in t["phonemes"]:
            self.assertEqual(set(p), {"p", "s", "e"})
            self.assertGreater(p["e"], p["s"])
        self.assertEqual([p["p"] for p in t["phonemes"]], ["HH", "EY", "Y", "AW"])

    def test_short_gaps_are_held_so_the_mouth_does_not_flicker_to_rest(self):
        words = plan("Hey you")
        t = build_timing(words, even_spans(len(letters_of(words)), gap=3), self.FRAME, 1.0)
        ph = t["phonemes"]
        for a, b in zip(ph, ph[1:]):
            self.assertEqual(a["e"], b["s"])  # 60 ms gaps < FILL_S: contiguous

    def test_a_pause_is_not_filled(self):
        words = plan("Hey you")
        n = len(letters_of(words))
        pause = int(FILL_S / self.FRAME) + 10  # frames
        k = len(letters_of(plan("Hey")))
        spans = even_spans(k) + [(s + pause, e + pause, p) for s, e, p in even_spans(n - k, start=3 * k + 2)]
        t = build_timing(words, spans, self.FRAME, 2.0)
        hey, you = t["words"]
        self.assertLess(hey["e"] + 100, you["s"])

    def test_silent_letters_extend_the_previous_phoneme(self):
        words = plan("make")
        t = build_timing(words, even_spans(4), self.FRAME, 1.0)
        self.assertEqual([p["p"] for p in t["phonemes"]], ["M", "AE", "K"])
        # the silent e's frames (10..12 -> 200..240 ms) belong to K
        self.assertGreaterEqual(t["phonemes"][-1]["e"], 240)

    def test_times_are_ms_from_the_start_of_the_audio(self):
        words = plan("a")
        t = build_timing(words, [(10, 12, 0.9)], self.FRAME, 1.0)
        self.assertEqual(t["phonemes"][0]["s"], 200)
        self.assertEqual(t["words"][0]["s"], 200)

    def test_a_run_before_a_pause_is_held_while_the_audio_is_still_voiced(self):
        # CTC puts the last letter on a 1-2 frame spike; the vowel keeps sounding after it
        words = plan("Hey")
        spans = [(3, 4, 0.9), (7, 8, 0.9), (11, 12, 0.9)]  # last letter ends at frame 12 = 240 ms
        voiced = [False] * 3 + [True] * 17 + [False] * 30  # sound until frame 20 = 400 ms
        t = build_timing(words, spans, self.FRAME, 1.0, voiced=voiced)
        self.assertEqual(t["phonemes"][-1]["e"], 400)
        self.assertEqual(t["words"][0]["e"], 400)

    def test_a_run_after_a_pause_starts_at_the_speech_onset(self):
        # "I'm" starts with a vowel; CTC spikes its first letter ~3 frames into the sound
        words = plan("I'm")
        spans = [(13, 14, 0.9), (17, 18, 0.9)]
        voiced = [False] * 10 + [True] * 12 + [False] * 10  # onset at frame 10 = 200 ms
        t = build_timing(words, spans, self.FRAME, 1.0, voiced=voiced)
        self.assertEqual(t["words"][0]["s"], 200)
        self.assertEqual(t["phonemes"][0]["s"], 200)

    def test_snapping_never_crosses_the_neighbouring_run_or_goes_far(self):
        words = plan("Hey you")
        n = len(letters_of(words))
        spans = [(2, 3, 0.9), (5, 6, 0.9), (8, 9, 0.9)] + [(30 + 3 * k, 31 + 3 * k, 0.9) for k in range(n - 3)]
        voiced = [True] * 60  # never quiet: hold is capped, runs do not overlap
        t = build_timing(words, spans, self.FRAME, 2.0, voiced=voiced)
        hey, you = t["words"]
        self.assertLessEqual(hey["e"], you["s"])
        self.assertLessEqual(hey["e"], 180 + round(HOLD_S * 1000))
        self.assertGreaterEqual(you["s"], 600 - 120)

    def test_a_voiced_gap_is_split_not_double_booked(self):
        words = plan("Hey you")
        n = len(letters_of(words))
        spans = [(2, 3, 0.9), (5, 6, 0.9), (8, 9, 0.9)] + [(20 + 2 * k, 21 + 2 * k, 0.9) for k in range(n - 3)]
        t = build_timing(words, spans, self.FRAME, 2.0, voiced=[True] * 60)  # 220 ms gap, all voiced
        ph = t["phonemes"]
        for a, b in zip(ph, ph[1:]):
            self.assertLessEqual(a["e"], b["s"])

    def test_fallback_none_on_span_count_mismatch(self):
        words = plan("Hey you")
        self.assertIsNone(build_timing(words, even_spans(3), self.FRAME, 1.0))

    def test_fallback_none_when_alignment_is_not_confident(self):
        words = plan("Hey you")
        spans = even_spans(len(letters_of(words)), prob=MIN_SCORE / 2)
        self.assertIsNone(build_timing(words, spans, self.FRAME, 1.0))

    def test_fallback_none_without_letters(self):
        self.assertIsNone(build_timing(plan("..."), [], self.FRAME, 1.0))

    def test_korean_sentence_timing(self):
        words = plan("네, 바로 저 모퉁이 돌면 있어요.")
        t = build_timing(words, even_spans(len(letters_of(words))), self.FRAME, 3.0)
        self.assertEqual([w["w"] for w in t["words"]], ["네,", "바로", "저", "모퉁이", "돌면", "있어요."])
        starts = [p["s"] for p in t["phonemes"]]
        self.assertEqual(starts, sorted(starts))


if __name__ == "__main__":
    unittest.main()
