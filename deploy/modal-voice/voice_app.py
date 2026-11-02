"""Genita voice service: SeamlessM4T v2 text-to-speech on Modal (Meta open model, D3).

    POST /v1/tts   Authorization: Bearer <GENITA_VOICE_TOKEN>
      {"text": "Hey, you're back!", "lang": "eng"|"kor", "speaker": 0..199, "speed": 1.0, "tail_ms": 0}
    -> application/x-ndjson, one line per <= 1 s chunk:
      {"audio_base64": <PCM s16le 24 kHz mono>, "alignment": {"characters": [...],
       "character_start_times_seconds": [...], "character_end_times_seconds": [...]} | null}
      last line: {"done": true, "gen_ms": 87, "audio_ms": 2310, "speaker": 0}
    GET /healthz -> {"ok": true, "gpu": "...", "warm": true}

Why not `model.generate()`: for same-language TTS generate() first *translates* eng->eng
autoregressively (one decoder step per token, ~0.6 s on A10G, and it can paraphrase). Here the
text decoder is teacher-forced with the input tokens in one pass, which is exactly the pass
generate() itself runs afterwards to feed the unit model, so the speech is the same as
generate() would give for an exact copy, without the token-by-token loop.

Timing: the unit model predicts a duration (in 20 ms units) for every character, and the
vocoder predicts how many frames each unit lasts. Hooks capture both, so each character gets a
start/end time on the output audio (same shape as ElevenLabs with-timestamps).

Deploy: VOICE_GPU=L4 modal deploy voice_app.py   (needs Modal secret `genita-voice-auth`)
Scale: python scale.py warm|cold   (min_containers 1 / 0)
Bench: VOICE_GPU=H100 modal run voice_app.py::bench   (ephemeral app, stops when done)
"""
import os, time, json, math, base64, asyncio, threading

import modal

GPU = os.environ.get("VOICE_GPU", "L4")
APP = os.environ.get("VOICE_APP", "genita-voice")
MODEL_ID = "facebook/seamless-m4t-v2-large"
HF = "/cache/hf"
OUT_SR = 24000

vol = modal.Volume.from_name("genita-voice-cache", create_if_missing=True)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch==2.6.0", "transformers==4.56.2", "sentencepiece", "protobuf", "numpy<2", "scipy", "uroman",
                 "fastapi[standard]==0.115.6")
    .env({"HF_HOME": HF, "HF_HUB_OFFLINE": "1", "TOKENIZERS_PARALLELISM": "false"})
)
app = modal.App(APP)

LANGS = {"eng", "kor"}
MAX_CHARS = 400
REGION = os.environ.get("VOICE_REGION", "us")  # broad region = 1.15x price; "us-east" = 1.75x
# Daily cap (cost guard after 11/5, when Modal bills the card): requests per UTC day across containers.
# Over the cap -> 429 "daily_cap" and genita-server falls back to the app's own voice. 80% logs an ALERT line.
DAILY_CAP = int(os.environ.get("VOICE_DAILY_CAP", "20000"))
usage = modal.Dict.from_name("genita-voice-usage", create_if_missing=True)


class Usage:
    """Daily request counter shared by all containers. Each container owns one key `<day>|<container>` and
    only ever writes its own count there, so no update is lost; the day's total is the sum over the keys.
    Read at start (a new container sees today's usage before serving) and every 20 s after."""

    def __init__(self):
        import uuid
        self.cid = os.environ.get("MODAL_TASK_ID") or uuid.uuid4().hex[:12]
        self.lock = threading.Lock()
        self.day = self._today()
        self.mine = 0  # this container's requests today
        self.others = 0  # other containers' requests today, as of the last sync
        self.alerted = False
        self._sync()
        threading.Thread(target=self._loop, daemon=True).start()

    @staticmethod
    def _today():
        return time.strftime("%Y-%m-%d", time.gmtime())

    def hit(self) -> bool:
        with self.lock:
            day = self._today()
            if day != self.day:
                self.day, self.mine, self.others, self.alerted = day, 0, 0, False
            if self.mine + self.others >= DAILY_CAP:
                return False
            self.mine += 1
            return True

    def _sync(self):
        try:
            with self.lock:
                day, mine = self.day, self.mine
            if mine:
                usage[f"{day}|{self.cid}"] = mine
            others = sum(v for k, v in usage.items() if k.startswith(day + "|") and k != f"{day}|{self.cid}")
            with self.lock:
                if day == self.day:
                    self.others = others
                total = self.mine + self.others
                if total >= 0.8 * DAILY_CAP and not self.alerted:
                    self.alerted = True
                    print(f"ALERT genita-voice: {total}/{DAILY_CAP} requests today ({day} UTC)", flush=True)
        except Exception as e:  # never let accounting break synthesis
            print("usage sync failed:", str(e)[:120], flush=True)

    def _loop(self):
        while True:
            time.sleep(20)
            self._sync()


class Engine:
    """Loads Seamless once; synth() is thread-safe (one GPU call at a time)."""

    def __init__(self):
        import torch
        from transformers import AutoProcessor, SeamlessM4Tv2ForTextToSpeech
        t0 = time.time()
        self.torch = torch
        self.proc = AutoProcessor.from_pretrained(MODEL_ID)
        self.model = SeamlessM4Tv2ForTextToSpeech.from_pretrained(MODEL_ID, torch_dtype=torch.float16).to("cuda").eval()
        self.gc = self.model.generation_config
        self.lock = threading.Lock()
        self.load_s = time.time() - t0
        self._cap = {}
        self._speed = 1.0
        t2u_dec = self.model.t2u_model.model.decoder
        t2u_dec.duration_predictor.register_forward_hook(self._char_dur_hook)
        self.model.vocoder.dur_predictor.register_forward_hook(self._unit_dur_hook)
        self.id_to_char = {v: k for k, v in self.gc.char_to_id.items()}
        self.warm = False

    # --- hooks: scale + capture predicted durations ---
    def _char_dur_hook(self, _m, _inp, out):
        torch = self.torch
        if self._speed != 1.0:
            # durations are exp(out)-1 frames; slower/faster speech = scale them
            out = torch.log1p(torch.expm1(out.float()).clamp(min=0) / self._speed).to(out.dtype)
        # exactly the model's own rounding, in the model's dtype (fp16), so timings match the samples
        self._cap["char_dur"] = torch.clamp(torch.round(torch.expm1(out)).long(), min=1)
        return out

    def _unit_dur_hook(self, _m, _inp, out):
        torch = self.torch
        self._cap["unit_dur"] = torch.clamp(torch.round(torch.expm1(out)).long(), min=1)
        return out

    def synth(self, text: str, lang: str, speaker: int, speed: float = 1.0):
        with self.lock:
            return self._synth(text, lang, speaker, speed)

    def _synth(self, text, lang, speaker, speed):
        torch = self.torch
        from transformers.models.seamless_m4t_v2.modeling_seamless_m4t_v2 import _compute_new_attention_mask
        m, gc = self.model, self.gc
        t0 = time.perf_counter()
        self._speed = max(0.7, min(1.4, float(speed)))
        self._cap = {}
        enc_in = self.proc(text=text, src_lang=lang, return_tensors="pt").to("cuda")
        ids = enc_in["input_ids"]  # [src_lang, tokens..., eos]
        toks = ids[:, 1:-1]
        eos = gc.eos_token_id
        dec_start = m.config.decoder_start_token_id
        lang_id = gc.text_decoder_lang_to_code_id[lang]
        seq = torch.cat([torch.tensor([[dec_start, lang_id]], device="cuda"), toks, torch.tensor([[eos]], device="cuda")], dim=1)
        with torch.inference_mode():
            enc = m.text_encoder(input_ids=ids, attention_mask=enc_in["attention_mask"]).last_hidden_state
            t2u_in = m.text_decoder(input_ids=seq[:, :-1], encoder_hidden_states=enc,
                                    encoder_attention_mask=enc_in["attention_mask"]).last_hidden_state
            pad = gc.pad_token_id
            t2u_ids = seq[:, 2:-1]
            t2u_ids = torch.masked_fill(t2u_ids, t2u_ids == eos, pad)
            subwords = m._indices_to_subwords(t2u_ids)
            ccount = m._count_character_length_in_subword(t2u_ids, subwords, pad_token_id=pad)
            z = ccount.new_zeros((1, 1))
            ccount = torch.cat([z, ccount, z], dim=1)
            char_ids = m._get_char_input_ids(t2u_ids, subwords, ccount, pad_token_id=pad)
            seq_lens = (seq[:, :-1] != pad).int().sum(1)
            mask = _compute_new_attention_mask(t2u_in, seq_lens)
            out = m.t2u_model(inputs_embeds=t2u_in, char_input_ids=char_ids, char_count_per_id=ccount, attention_mask=mask)
            units = out[0].argmax(dim=-1)
            pmask = out[1].bool()
            units = units.masked_fill((units == m.config.t2u_eos_token_id) | (~pmask), m.config.t2u_pad_token_id)
            units = torch.where(units == m.config.t2u_pad_token_id, units, units - m.config.vocoder_offset)
            voc_lang = torch.tensor([[gc.vocoder_lang_code_to_id[lang]]], device="cuda")
            spk = torch.tensor([[int(speaker)]], device="cuda")
            wav, wav_len = m.vocoder(input_ids=units, speaker_id=spk, lang_id=voc_lang)
        wav = wav[0, : int(wav_len.reshape(-1)[0])].float().cpu().numpy()
        gen_ms = (time.perf_counter() - t0) * 1000
        chars = [self.id_to_char.get(int(c), "?") for c in char_ids[0].tolist()]
        align = self._align(chars, len(wav))
        return wav, align, gen_ms

    def _align(self, chars, n_samples):
        """Per-character (start_s, end_s) on the 16 kHz output, from char -> units -> frames."""
        cd = self._cap.get("char_dur")
        ud = self._cap.get("unit_dur")
        if cd is None or ud is None:
            return None
        cd = cd.reshape(-1).tolist()[: len(chars)]
        ud = ud.reshape(-1).tolist()
        frames_total = sum(ud) or 1
        spf = n_samples / frames_total  # samples per vocoder frame (320 at 16 kHz)
        # unit index -> cumulative frame start
        cum = [0]
        for d in ud:
            cum.append(cum[-1] + d)
        res, u = [], 0
        for ch, d in zip(chars, cd):
            a, b = min(u, len(ud)), min(u + d, len(ud))
            res.append((ch, cum[a] * spf / 16000, cum[b] * spf / 16000))
            u += d
        return res

    def render(self, text, lang, speaker, speed=1.0, tail_ms=0):
        """-> (pcm16 bytes @24 kHz, alignment dict, gen_ms, audio_ms)."""
        import numpy as np
        from scipy.signal import resample_poly
        wav, align, gen_ms = self.synth(text, lang, speaker, speed)
        # trim leading/trailing near-silence (keep 40 ms), shift timings
        thr = 0.01 * (float(np.abs(wav).max()) or 1.0)
        loud = np.nonzero(np.abs(wav) > thr)[0]
        lead_cut = 0
        if len(loud):
            lead_cut = max(0, int(loud[0]) - 640)
            end = min(len(wav), int(loud[-1]) + 640)
            wav = wav[lead_cut:end]
        peak = float(np.abs(wav).max() or 1.0)
        wav = wav * min(1.0, 0.95 / peak)
        out = resample_poly(wav, 3, 2).astype(np.float32)  # 16 kHz -> 24 kHz
        if tail_ms > 0:
            out = np.concatenate([out, np.zeros(int(OUT_SR * min(tail_ms, 1500) / 1000), np.float32)])
        pcm = (np.clip(out, -1, 1) * 32767).astype("<i2").tobytes()
        audio_ms = len(out) / OUT_SR * 1000
        alignment = None
        if align:
            off = lead_cut / 16000
            dur = len(out) / OUT_SR
            chars, st, en = [], [], []
            for ch, a, b in align:
                if ch == "▁":
                    ch = " "
                if not chars and ch == " ":
                    continue
                chars.append(ch)
                st.append(round(min(max(0.0, a - off), dur), 3))
                en.append(round(min(max(0.0, b - off), dur), 3))
            alignment = {"characters": chars, "character_start_times_seconds": st, "character_end_times_seconds": en}
        return pcm, alignment, gen_ms, audio_ms


class MmsEngine:
    """Backup voice: Meta MMS-TTS (VITS) eng/kor. No character timing (alignment null -> the app aligns from text)."""

    def __init__(self):
        import torch
        from transformers import VitsModel, AutoTokenizer
        self.torch = torch
        self.m = {l: (VitsModel.from_pretrained(f"facebook/mms-tts-{l}").to("cuda").eval(), AutoTokenizer.from_pretrained(f"facebook/mms-tts-{l}"))
                  for l in ("eng", "kor")}
        self.lock = threading.Lock()
        self._uroman = None

    def render(self, text, lang, speaker=0, speed=1.0, tail_ms=0):
        import numpy as np
        from scipy.signal import resample_poly
        t0 = time.perf_counter()
        model, tk = self.m[lang]
        if getattr(tk, "is_uroman", False):
            if self._uroman is None:
                import uroman
                self._uroman = uroman.Uroman()
            text = self._uroman.romanize_string(text)
        with self.lock, self.torch.inference_mode():
            model.speaking_rate = max(0.7, min(1.4, float(speed)))
            w = model(**tk(text, return_tensors="pt").to("cuda")).waveform[0].float().cpu().numpy()
        out = resample_poly(w / max(1e-6, float(np.abs(w).max())) * 0.95, 3, 2).astype(np.float32)
        if tail_ms > 0:
            out = np.concatenate([out, np.zeros(int(OUT_SR * min(tail_ms, 1500) / 1000), np.float32)])
        return (np.clip(out, -1, 1) * 32767).astype("<i2").tobytes(), None, (time.perf_counter() - t0) * 1000, len(out) / OUT_SR * 1000


def chunk_lines(pcm: bytes, alignment, gen_ms, audio_ms, speaker, first_ms=300, chunk_ms=1000):
    """NDJSON lines: a short first piece (first_ms, so playback can start after a few KB even over a slow
    link), then <= chunk_ms pieces; each piece carries the characters that start in it (times stay
    relative to the start of this request's audio, like ElevenLabs)."""
    first = int(OUT_SR * first_ms / 1000) * 2
    step = int(OUT_SR * chunk_ms / 1000) * 2
    bounds = [0, min(len(pcm), first)]
    while bounds[-1] < len(pcm):
        bounds.append(min(len(pcm), bounds[-1] + step))
    n = len(bounds) - 1
    for i in range(n):
        a, b = bounds[i], bounds[i + 1]
        t0, t1 = a / 2 / OUT_SR, b / 2 / OUT_SR
        al = None
        if alignment:
            idx = [k for k, s in enumerate(alignment["character_start_times_seconds"]) if (t0 <= s < t1) or (i == n - 1 and s >= t1)]
            if idx:
                al = {key: [alignment[key][k] for k in idx] for key in alignment}
        yield json.dumps({"audio_base64": base64.b64encode(pcm[a:b]).decode(), "alignment": al}) + "\n"
    yield json.dumps({"done": True, "gen_ms": round(gen_ms), "audio_ms": round(audio_ms), "speaker": speaker}) + "\n"


WARM_LINES = [("Hey! Oh wow, you're back already?", "eng"), ("네, 바로 저 모퉁이 돌면 있어요.", "kor"),
              ("Hmm,", "eng"), ("So, what are you thinking for dinner tonight? Want me to take a look at what's in your fridge?", "eng")]


@app.cls(image=image, gpu=GPU, volumes={"/cache": vol}, secrets=[modal.Secret.from_name("genita-voice-auth")],
         region=REGION, min_containers=0, max_containers=3, scaledown_window=300, timeout=120)
@modal.concurrent(max_inputs=8)
class Voice:
    @modal.enter()
    def load(self):
        self.engine = Engine()
        for t, l in WARM_LINES * 2:
            self.engine.render(t, l, 0)
        try:
            self.mms = MmsEngine()
            self.mms.render("warm up", "eng")
            self.mms.render("준비", "kor")  # loads uroman for Korean
        except Exception as e:  # backup only; Seamless still serves
            self.mms = None
            print("mms backup unavailable:", str(e)[:160])
        self.usage = Usage()
        self.engine.warm = True
        print(f"voice: loaded in {self.engine.load_s:.1f}s on {self.engine.torch.cuda.get_device_name(0)}")

    @modal.asgi_app(label=APP)
    def web(self):
        import hmac
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse, StreamingResponse
        api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
        token = os.environ["GENITA_VOICE_TOKEN"].encode()
        eng, mms, use = self.engine, self.mms, self.usage

        def authed(req: Request) -> bool:
            got = req.headers.get("authorization", "").removeprefix("Bearer ").strip().encode()
            return hmac.compare_digest(got, token)

        @api.get("/healthz")
        def health():
            return {"ok": True, "warm": eng.warm, "gpu": eng.torch.cuda.get_device_name(0), "mms": mms is not None}

        @api.post("/v1/tts")
        async def tts(req: Request):
            if not authed(req):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            try:
                body = await req.json()
            except Exception:
                return JSONResponse({"error": "bad_json"}, status_code=400)
            text = str(body.get("text", "")).strip()
            lang = body.get("lang", "eng")
            speaker = body.get("speaker", 0)
            if not text or len(text) > MAX_CHARS or lang not in LANGS or not isinstance(speaker, int) or not 0 <= speaker < 200:
                return JSONResponse({"error": "bad_request"}, status_code=400)
            try:
                speed = float(body.get("speed", 1.0) or 1.0)
                tail = int(body.get("tail_ms", 0) or 0)
            except (TypeError, ValueError):
                return JSONResponse({"error": "bad_request"}, status_code=400)
            if not math.isfinite(speed) or not 0.7 <= speed <= 1.4 or not 0 <= tail <= 1500:
                return JSONResponse({"error": "bad_request"}, status_code=400)
            model = body.get("model", "seamless")
            if model not in ("seamless", "mms") or (model == "mms" and mms is None):
                return JSONResponse({"error": "bad_model"}, status_code=400)
            if not use.hit():
                return JSONResponse({"error": "daily_cap"}, status_code=429)
            pcm, al, gen_ms, audio_ms = await asyncio.to_thread((mms if model == "mms" else eng).render, text, lang, speaker, speed, tail)
            return StreamingResponse(chunk_lines(pcm, al, gen_ms, audio_ms, speaker), media_type="application/x-ndjson")

        return api


# ---------------- bench (ephemeral: `modal run voice_app.py::bench`) ----------------
BENCH_LINES = {
    "1-casual": "Hey! Oh wow, you're back already? How was the rest of your day?",
    "2-comfort": "Hey... that sounds really hard. I'm right here, okay? Take your time. We can just sit with it for a bit.",
    "3-laugh": "Wait, you put the pineapple in the fridge door? Haha, okay, that's honestly kind of genius.",
    "4-question": "So, what are you thinking for dinner tonight? Want me to take a look at what's in your fridge?",
    "5-interp-en": "Hi, is there a good gukbap place around here? It's my first time in this area.",
    "first-clause": "Oh wow,",
}


@app.function(image=image, gpu=GPU, volumes={"/cache": vol}, timeout=1200)
def bench_remote(reps: int = 5, speakers: str = "", with_generate: bool = True):
    import numpy as np, statistics
    eng = Engine()
    for t, l in WARM_LINES * 3:
        eng.render(t, l, 0)
    gpu = eng.torch.cuda.get_device_name(0)
    res = {"gpu": gpu, "load_s": round(eng.load_s, 1), "lines": {}}
    for k, t in BENCH_LINES.items():
        ms = []
        for _ in range(reps):
            t0 = time.perf_counter(); pcm, al, g, a = eng.render(t, "eng", 0); ms.append((time.perf_counter() - t0) * 1000)
        res["lines"][k] = {"p50_ms": round(statistics.median(ms), 1), "max_ms": round(max(ms), 1), "audio_ms": round(a)}
    ko = [eng.render("네, 바로 저 모퉁이 돌면 있어요. 제가 같이 가 드릴까요?", "kor", 0) for _ in range(reps)]
    res["korean_gen_ms"] = round(statistics.median([x[2] for x in ko]), 1)
    files = {}
    for k, t in BENCH_LINES.items():
        pcm, al, g, a = eng.render(t, "eng", 0)
        files[f"fast-{k}.pcm"] = pcm
        if k == "1-casual":
            res["alignment_sample"] = al
    if with_generate:
        # reference: stock generate() eng->eng, to confirm the fast path sounds the same and is faster
        torch = eng.torch
        g_ms = []
        for k, t in BENCH_LINES.items():
            inp = eng.proc(text=t, src_lang="eng", return_tensors="pt").to("cuda")
            torch.cuda.synchronize(); t0 = time.perf_counter()
            with torch.inference_mode():
                w = eng.model.generate(**inp, tgt_lang="eng", speaker_id=0)[0]
            torch.cuda.synchronize(); g_ms.append((time.perf_counter() - t0) * 1000)
            from scipy.signal import resample_poly
            w = resample_poly(w[0].float().cpu().numpy(), 3, 2)
            files[f"generate-{k}.pcm"] = (np.clip(w / max(1e-6, np.abs(w).max()) * 0.95, -1, 1) * 32767).astype("<i2").tobytes()
        res["generate_p50_ms"] = round(statistics.median(g_ms), 1)
    return res, files


@app.local_entrypoint()
def bench(reps: int = 5, out: str = ""):
    import pathlib, subprocess
    res, files = bench_remote.remote(reps)
    print(json.dumps({k: v for k, v in res.items() if k != "alignment_sample"}, indent=1))
    al = res.get("alignment_sample")
    if al:
        print("align:", "".join(al["characters"])[:80], al["character_start_times_seconds"][:12])
    if out:
        d = pathlib.Path(out); d.mkdir(parents=True, exist_ok=True)
        (d / f"bench-{GPU}.json").write_text(json.dumps(res, indent=1, ensure_ascii=False))
        for n, b in files.items():
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "-", "-b:a", "64k",
                            str(d / n.replace(".pcm", f"-{GPU}.mp3"))], input=b, check=True)
