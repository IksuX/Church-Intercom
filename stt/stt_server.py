"""Interkom STT – lokalna transkrypcja mowy (faster-whisper).

POST /transcribe?lang=pl&prompt=...&hotwords=...&who=...   body: nagranie (wav, webm/opus, mp4/aac…)
  -> {"text": "...", "seconds": 1.23, "audio": 3.4, "confidence": 0.8}
GET  /health  -> stan, model, jakość, procesor, statystyki szybkości
POST /model   body {"name": "small"}  -> zmiana modelu w locie (ładuje w tle, stary działa do końca)
POST /settings body {"quality": "fast|balanced|accurate"}
POST /bench   -> ponowna transkrypcja ostatniego nagrania bieżącymi ustawieniami (test szybkości)
GET  /recent  -> ostatnie nagrania z transkrypcjami (tylko w pamięci, do strojenia jakości)
GET  /recent/<id>/audio ; POST /recent/<id>/redo -> odsłuch / ponowna transkrypcja bieżącymi ustawieniami

Model pobiera się raz do /models (wolumen), potem działa offline.
"""
import io
import json
import math
import os
import re
import threading
import time
import traceback
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("STT_PORT", "8001"))
CORES = os.cpu_count() or 2
THREADS = int(os.environ.get("WHISPER_THREADS", str(CORES)))
MAX_BYTES = 8 * 1024 * 1024
SETTINGS = os.path.join(os.environ.get("HF_HOME", "/models"), "stt-settings.json")
MODELS = ["tiny", "base", "small", "medium", "large-v3-turbo"]
# jakość dekodowania: więcej wariantów (beam) = mniej przekręconych słów, ale wolniej
QUALITY = {
    "fast": {"beam_size": 1, "temperature": 0.0},
    "balanced": {"beam_size": 3, "temperature": 0.0},
    "accurate": {"beam_size": 5, "best_of": 5, "temperature": [0.0, 0.2, 0.4]},
}
VAD = {"threshold": 0.4, "min_speech_duration_ms": 150, "min_silence_duration_ms": 700, "speech_pad_ms": 500}
FAKE = os.environ.get("STT_FAKE") == "1"  # tylko do testów bez modelu

# Typowe „zmyślenia” Whispera po polsku (z napisów filmowych / YouTube) – usuwany jest tylko taki fragment, nie cała wypowiedź
HALLUCINATIONS = re.compile(
    r"(amara\.org|napisy (wykonane|stworzone|przygotowane|by|:)|napisał[ao]? |dziękuję za (uwagę|obejrzenie|oglądanie)|"
    r"dzięki za (obejrzenie|oglądanie)|(za)?subskrybuj|zostaw (łapkę|suba|lajka)|do (zobaczenia|usłyszenia) w (następnym|kolejnym)|"
    r"zapraszam (na|do) (kolejn|następn)|tłumaczenie:|korekta:|transkrypcja:|telewizja polska|www\.\S+|^\W*(muzyka|\[muzyka\]|♪+)\W*$)",
    re.IGNORECASE,
)


def has_avx2():
    try:
        with open("/proc/cpuinfo") as f:
            return "avx2" in f.read()
    except OSError:
        return None


def auto_model():
    # słabszy procesor (≤2 rdzenie) → base, mocniejszy → small
    return "base" if CORES <= 2 else "small"


def read_settings():
    try:
        with open(SETTINGS) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_settings(patch):
    try:
        os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
        with open(SETTINGS, "w") as f:
            json.dump({**read_settings(), **patch}, f)
    except OSError as e:
        print(f"[stt] nie zapisano ustawień: {e}", flush=True)


def wanted_model():
    m = read_settings().get("model")
    if m in MODELS:
        return m
    env = os.environ.get("WHISPER_MODEL", "auto")
    return env if env in MODELS else auto_model()


def quality():
    q = read_settings().get("quality") or os.environ.get("WHISPER_QUALITY", "balanced")
    return q if q in QUALITY else "balanced"


state = {"model": None, "name": None, "loading": None, "ready": False, "error": None}
stats = deque(maxlen=20)
recent = deque(maxlen=20)  # ostatnie nagrania (tylko w pamięci) – odsłuch i porównanie w panelu
lock = threading.Lock()
AVX2 = has_avx2()


def load_model(name):
    state["loading"] = name
    try:
        if FAKE:
            state.update(model="fake", name=name, ready=True, error=None)
            return
        from faster_whisper import WhisperModel

        t = time.time()
        print(f"[stt] Ładuję model '{name}' (pierwszy raz: pobieranie)…", flush=True)
        m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=THREADS)
        with lock:  # podmiana dopiero, gdy nowy model jest gotowy
            state.update(model=m, name=name, ready=True, error=None)
        stats.clear()
        print(f"[stt] Model '{name}' gotowy w {time.time() - t:.1f} s", flush=True)
    except Exception as e:  # noqa: BLE001
        state["error"] = f"{name}: {e}"
        print(f"[stt] BŁĄD ładowania modelu {name}: {e}", flush=True)
    finally:
        state["loading"] = None


def clean(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= 2 and not text.isalnum():
        return ""
    return text


REPEAT = re.compile(r"(\b.{3,60}?[,.!?]?\s+)(?:\1){2,}", re.IGNORECASE)


def looks_looped(text: str, dur: float) -> bool:
    """Zapętlenie: ta sama fraza wiele razy albo nierealnie dużo tekstu jak na długość nagrania."""
    return bool(REPEAT.search(text + " ")) or len(text) > 25 * max(dur, 1) + 40


def collapse(text: str) -> str:
    return REPEAT.sub(lambda m: m.group(1), text + " ").strip()


class AudioError(Exception):
    pass


def prepare(audio):
    """Cisza → None. Cichy mówca → wzmocnienie. Krótki margines ciszy na brzegach (pierwsze/ostatnie słowo)."""
    import numpy as np

    audio = audio - float(np.mean(audio)) if len(audio) else audio
    frames = audio[: len(audio) // 320 * 320].reshape(-1, 320)  # ramki 20 ms
    if not len(frames):
        return None, 0.0
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    voiced = float(np.mean(rms > 0.006))  # udział ramek z dźwiękiem (próg bezwzględny – klip PTT bywa w całości mową)
    peak = float(np.percentile(np.abs(audio), 99.7))
    if peak < 0.012 or voiced < 0.03:  # praktycznie cisza – Whisper by tu „coś” zmyślił
        return None, voiced
    gain = min(8.0, 0.6 / peak)
    if gain > 1.3:
        audio = np.clip(audio * gain, -1.0, 1.0)
    pad = np.zeros(int(16000 * 0.3), dtype=np.float32)
    return np.concatenate([pad, audio.astype(np.float32), pad]), voiced


def segment_ok(s) -> bool:
    if s.no_speech_prob > 0.6 and s.avg_logprob < -0.7:
        return False  # model sam uważa, że to nie mowa
    if getattr(s, "compression_ratio", 0) > 2.6:
        return False  # powtarzający się tekst
    if HALLUCINATIONS.search(s.text):
        return False
    return True


def run(audio, dur, lang, prompt, hotwords, safe=False, vad=True):
    q = QUALITY[quality()]
    opts = dict(language=lang, condition_on_previous_text=False, without_timestamps=True,
                compression_ratio_threshold=2.4, log_prob_threshold=-1.0, no_speech_threshold=0.6, **q)
    if vad:
        opts.update(vad_filter=True, vad_parameters=VAD)
    if not safe:
        # podpowiedź + limit nowych tokenów muszą zmieścić się w 448 tokenach modelu (≈2 znaki na token po polsku)
        hint_tokens = (len(prompt or "") + len(hotwords or "")) // 2 + 8
        opts.update(initial_prompt=prompt or None, hotwords=hotwords or None,
                    max_new_tokens=max(32, min(int(dur * 8) + 24, 440 - hint_tokens)), repetition_penalty=1.05)
    segments, _info = state["model"].transcribe(audio, **opts)
    segs = [s for s in segments if segment_ok(s)]
    text = " ".join(s.text for s in segs)
    total = sum(max(len(s.text), 1) for s in segs)
    try:
        conf = sum(math.exp(s.avg_logprob) * max(len(s.text), 1) for s in segs) / total if total else 0.0
    except (TypeError, ValueError, OverflowError):
        conf = 0.5
    return text, conf, segs


def decode(data: bytes):
    """Dekoduje nagranie do 16 kHz mono float32 (własny dekoder – niezależny od zmian w PyAV).
    Gdy plik jest uszkodzony/ucięty – bierze tyle, ile się da."""
    import av
    import numpy as np

    out, err = [], None
    try:
        with av.open(io.BytesIO(data), mode="r") as c:
            if not c.streams.audio:
                raise AudioError("w pliku nie ma ścieżki dźwięku")
            res = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
            try:
                for pkt in c.demux(c.streams.audio[0]):
                    try:
                        for fr in pkt.decode():
                            out += [r.to_ndarray().reshape(-1) for r in res.resample(fr)]
                    except av.error.FFmpegError as e:
                        err = err or e
            except av.error.FFmpegError as e:
                err = err or e
            try:
                out += [r.to_ndarray().reshape(-1) for r in res.resample(None)]
            except (av.error.FFmpegError, ValueError):
                pass
    except AudioError:
        raise
    except Exception as e:  # noqa: BLE001
        err = e
    if not out:
        raise AudioError(f"plik nieczytelny ({type(err).__name__}: {str(err)[:80]})" if err else "brak dźwięku w pliku")
    if err:
        print(f"[stt] nagranie uszkodzone – odczytano część ({type(err).__name__})", flush=True)
    return np.concatenate(out).astype(np.float32) / 32768.0


def transcribe(data: bytes, lang: str, prompt, hotwords=""):
    audio = decode(data)
    dur = len(audio) / 16000
    if dur < 0.2:
        raise AudioError(f"nagranie puste ({dur:.2f} s dźwięku)")
    if FAKE:
        return f"[test] {dur:.1f} s audio", dur, 0.4 if dur < 1.5 else 0.9
    audio, voiced = prepare(audio)
    if audio is None:
        return "", dur, 0.0  # cisza
    prompt = (prompt or "").strip()[:160]
    hotwords = (hotwords or "").strip()[:400]
    try:
        text, conf, segs = run(audio, dur, lang, prompt, hotwords)
    except Exception as e:  # noqa: BLE001
        print(f"[stt] model zgłosił błąd ({type(e).__name__}: {e}) – ponawiam w trybie podstawowym", flush=True)
        prompt = hotwords = ""
        text, conf, segs = run(audio, dur, lang, None, None, safe=True)
    if (prompt or hotwords) and looks_looped(text, dur):
        print("[stt] wykryto zapętlenie – ponawiam bez podpowiedzi słów", flush=True)
        text, conf, segs = run(audio, dur, lang, None, None)
    if not text.strip() and voiced > 0.25 and dur < 20:
        # detektor mowy mógł odrzucić cichą/krótką wypowiedź – druga próba bez niego, przyjęta tylko przy wysokiej pewności
        t2, c2, s2 = run(audio, dur, lang, prompt, hotwords, vad=False)
        if t2.strip() and c2 > 0.55 and all(x.no_speech_prob < 0.5 for x in s2):
            text, conf = t2, c2
    if looks_looped(text, dur):
        text = collapse(text)
        conf = min(conf, 0.3)
    return clean(text), dur, conf


def keep_failed(data: bytes, ctype: str):
    """Zachowuje 10 ostatnich nieudanych nagrań do diagnozy (data/stt-models/failed)."""
    try:
        d = os.path.join(os.path.dirname(SETTINGS), "failed")
        os.makedirs(d, exist_ok=True)
        ext = "mp4" if "mp4" in ctype else "ogg" if "ogg" in ctype else "webm" if "webm" in ctype else "bin"
        with open(os.path.join(d, f"{time.strftime('%Y%m%d-%H%M%S')}.{ext}"), "wb") as f:
            f.write(data)
        for old in sorted(os.listdir(d))[:-10]:
            os.remove(os.path.join(d, old))
    except OSError:
        pass


def summary():
    if not stats:
        return None
    rtf = sum(s["rtf"] for s in stats) / len(stats)
    return {"count": len(stats), "avgRtf": round(rtf, 2), "last": stats[-1]}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        try:
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            print("[stt] klient rozłączył się przed odpowiedzią (zbyt długa transkrypcja)", flush=True)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if 0 < n <= MAX_BYTES else None

    def _find(self, rid):
        return next((r for r in recent if r["id"] == rid), None)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            return self._json(200, {
                "ok": True, "model": state["name"], "ready": state["ready"], "loading": state["loading"],
                "error": state["error"], "models": MODELS, "auto": auto_model(), "quality": quality(),
                "cpu": {"cores": CORES, "threads": THREADS, "avx2": AVX2}, "stats": summary(),
            })
        if u.path == "/recent":
            return self._json(200, {"items": [{k: v for k, v in r.items() if k != "data"} for r in reversed(recent)]})
        m = re.fullmatch(r"/recent/([a-z0-9]+)/audio", u.path)
        if m:
            r = self._find(m.group(1))
            if not r:
                return self._json(404, {"error": "nagranie już usunięte"})
            self.send_response(200)
            self.send_header("content-type", r["ctype"])
            self.send_header("content-length", str(len(r["data"])))
            self.end_headers()
            self.wfile.write(r["data"])
            return None
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            body = json.loads(self._body() or b"{}") if u.path in ("/model", "/settings") else None
        except ValueError:
            body = {}
        if u.path == "/model":
            name = body.get("name")
            if name not in MODELS:
                return self._json(400, {"error": "nieznany model"})
            write_settings({"model": name})
            if name != state["name"] and state["loading"] != name:
                threading.Thread(target=load_model, args=(name,), daemon=True).start()
            return self._json(202, {"ok": True, "loading": name})
        if u.path == "/recent/clear":
            recent.clear()
            return self._json(200, {"ok": True})
        if u.path == "/settings":
            if body.get("quality") not in QUALITY:
                return self._json(400, {"error": "nieznana jakość"})
            write_settings({"quality": body["quality"]})
            stats.clear()
            return self._json(200, {"ok": True, "quality": quality()})

        redo = re.fullmatch(r"/recent/([a-z0-9]+)/redo", u.path)
        entry = None
        if u.path == "/bench" or redo:
            entry = self._find(redo.group(1)) if redo else (recent[-1] if recent else None)
            if not entry:
                return self._json(400, {"error": "Brak nagrania – najpierw powiedz coś przez interkom."})
            data, ctype = entry["data"], entry["ctype"]
            lang, prompt, hotwords, who = entry["lang"], entry["prompt"], entry["hotwords"], entry["who"]
        elif u.path == "/transcribe":
            data = self._body()
            if not data:
                return self._json(413, {"error": "zły rozmiar nagrania"})
            ctype = (self.headers.get("content-type") or "application/octet-stream").split(";")[0]
            lang = (q.get("lang") or ["pl"])[0]
            prompt = (q.get("prompt") or [""])[0]
            hotwords = (q.get("hotwords") or [""])[0]
            who = (q.get("who") or [""])[0][:60]
        else:
            return self._json(404, {"error": "not found"})

        if not state["ready"]:
            return self._json(503, {"error": "model się ładuje" if not state["error"] else state["error"]})
        info = f"{ctype}, {len(data) / 1024:.1f} kB"
        t = time.time()
        try:
            with lock:  # jedna transkrypcja naraz – CPU i tak jest wąskim gardłem
                text, dur, conf = transcribe(data, lang, prompt, hotwords)
        except AudioError as e:
            print(f"[stt] złe nagranie ({info}): {e}", flush=True)
            keep_failed(data, ctype)
            return self._json(422, {"error": f"złe nagranie z telefonu: {e} [{info}]"})
        except Exception as e:  # noqa: BLE001
            print(f"[stt] błąd transkrypcji ({info}):", flush=True)
            traceback.print_exc()
            keep_failed(data, ctype)
            return self._json(500, {"error": f"błąd modelu: {type(e).__name__}: {str(e)[:120]}"})
        dt = time.time() - t
        rtf = dt / max(dur, 0.1)
        res = {"text": text, "seconds": round(dt, 2), "audio": round(dur, 1), "confidence": round(conf, 2), "model": state["name"], "quality": quality()}
        stats.append({"audio": round(dur, 1), "seconds": round(dt, 2), "rtf": round(rtf, 2), "model": state["name"]})
        print(f"[stt] {state['name']}/{quality()}: {dur:.1f} s mowy → {dt:.2f} s ({rtf:.2f}×, pewność {conf:.2f}): {text!r}", flush=True)
        if entry is not None:
            entry["redo"] = res
        else:
            rid = f"{int(time.time() * 1000):x}"
            recent.append({"id": rid, "ts": int(time.time() * 1000), "who": who, "ctype": ctype, "data": data, "lang": lang,
                           "prompt": prompt, "hotwords": hotwords, **res})
        self._json(200, res)

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    name = wanted_model()
    threading.Thread(target=load_model, args=(name,), daemon=True).start()
    print(f"[stt] Nasłuchuję na http://{HOST}:{PORT} (model: {name}, jakość: {quality()}, rdzenie: {CORES}, AVX2: {AVX2})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
