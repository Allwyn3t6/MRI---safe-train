"""MRISafe Twin local server: static files + an optional local AI proxy.

    python server/server.py            # http://localhost:8000
    python server/server.py --port 8080

The coach works without this server: it answers from the built-in knowledge base
(simulator/knowledge-base.js) in the browser. This server only adds an optional
generated-answer model. Use a free, local one such as Ollama (no key, no internet):

    ollama pull llama3.1
    AI_BASE_URL=http://localhost:11434/v1  AI_MODEL=llama3.1   (in server/.env)

Any other OpenAI-style /chat/completions API also works (LM Studio, OpenAI, Groq).
The key, if one is needed, stays in server/.env and never reaches the browser.

Standard library only (Python 3.8+). No pip install needed.
"""
import argparse
import json
import mimetypes
import os
import pathlib
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE.parent / "simulator"

MAX_BODY = 24_000          # bytes accepted from the browser
MAX_FIELD = 700            # characters per text field sent to the model
MAX_LIST = 12              # items per list sent to the model
RULE_ID = re.compile(r"\bR-[A-Z]+-\d{2}\b")


# --------------------------------------------------------------------------- config
def load_env(path):
    """Read KEY=VALUE lines into os.environ (existing variables win)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def config_from_env(env=None):
    env = os.environ if env is None else env
    provider = (env.get("AI_PROVIDER") or "").strip().lower()
    if not provider:
        provider = "openai_compatible" if env.get("AI_BASE_URL") else "none"
    if provider not in ("openai_compatible", "none"):
        provider = "none"  # Azure and other providers were removed; the knowledge-base coach answers instead
    temp = env.get("AI_TEMPERATURE", "0.3").strip()
    cfg = {
        "provider": provider,
        "base_url": (env.get("AI_BASE_URL") or "").rstrip("/"),
        "api_key": env.get("AI_API_KEY") or "",
        "model": env.get("AI_MODEL") or "",
        "max_tokens": int(env.get("AI_MAX_TOKENS") or 450),
        # Reasoning models (o-series, gpt-5) want max_completion_tokens and no temperature.
        "max_tokens_param": env.get("AI_MAX_TOKENS_PARAM") or "max_tokens",
        "temperature": float(temp) if temp else None,
        "timeout": float(env.get("AI_TIMEOUT") or 30),
        "rate_per_min": int(env.get("AI_RATE_PER_MIN") or 20),
    }
    return cfg


def provider_ready(cfg):
    if cfg["provider"] == "openai_compatible":
        return bool(cfg["base_url"] and cfg["model"])
    return False


def public_status(cfg):
    ready = provider_ready(cfg)
    model = cfg["model"]
    return {"ok": True, "configured": ready, "provider": cfg["provider"] if ready else "none", "model": model if ready else ""}


# --------------------------------------------------------------------------- prompts
def clip(v, n=MAX_FIELD):
    if v is None:
        return ""
    s = str(v)
    return s if len(s) <= n else s[: n - 1] + "…"


def clean(obj, depth=0):
    """Bound the size of anything the browser sends before it reaches the model."""
    if depth > 4:
        return None
    if isinstance(obj, dict):
        return {clip(k, 40): clean(v, depth + 1) for k, v in list(obj.items())[:30]}
    if isinstance(obj, list):
        return [clean(v, depth + 1) for v in obj[:MAX_LIST]]
    if isinstance(obj, (int, float, bool)) or obj is None:
        return obj
    return clip(obj)


COACH_RULES = (
    "You are the MRI safety coach inside an educational simulator. "
    "Use ONLY the rule text and recorded events in the JSON you are given. "
    "Do not invent events, patient details, device conditions, test results or safety requirements. "
    "The rule engine's decision is final; never suggest that a blocked step was actually acceptable. "
    "Write for a trainee radiographer or biomedical engineering student, in plain English, addressing them as 'you'. "
    "Always cite the rule id in square brackets, for example [R-EQ-03]. "
    "This is a training simulation, not clinical advice."
)

TUTOR_RULES = (
    "You are a tutor for biomedical engineering students learning MRI scanner hardware and physics "
    "through a 3D simulator. Use the chapter notes as your main source. You may add standard textbook "
    "knowledge, but say when values vary between scanners or sources. Keep it accurate; if you are not sure, say so. "
    "Do not give clinical, patient-specific or site-specific safety instructions; refer those to the local MR safety officer. "
    "Answer in at most 150 words unless asked for more. Use short paragraphs or a short list."
)


def build_messages(payload):
    """Return (messages, task) for a browser request. Raises ValueError for bad input."""
    if not isinstance(payload, dict):
        raise ValueError("Request must be a JSON object.")
    task = payload.get("task")
    ctx = clean(payload.get("context") or {})
    if task == "explain":
        if not isinstance(ctx, dict) or not ctx.get("violations"):
            raise ValueError("explain needs context.violations.")
        sys_msg = COACH_RULES + (
            " Reply in at most 110 words with three short parts: what happened (with the rule id), "
            "why it matters, and the one thing to do next."
        )
        user = "Explain this recorded mistake to the trainee.\n\n" + json.dumps(ctx, ensure_ascii=False)
        return [{"role": "system", "content": sys_msg}, {"role": "user", "content": user}], task
    if task == "debrief":
        if not isinstance(ctx, dict) or "score" not in ctx:
            raise ValueError("debrief needs context.score.")
        sys_msg = COACH_RULES + (
            " Write a trainer-facing debrief of one simulated session as four bullet points: overall result, "
            "what went well, mistakes (cite rule ids), and the recommended focus for the next attempt. "
            "At most 150 words. Only mention rule ids that appear in the JSON."
        )
        user = "Session summary:\n\n" + json.dumps(ctx, ensure_ascii=False)
        return [{"role": "system", "content": sys_msg}, {"role": "user", "content": user}], task
    if task in ("tutor", "quiz"):
        if task == "quiz":
            q = ("Ask me ONE multiple-choice question (four options, A–D) about this chapter. "
                 "Do not reveal the answer until I reply.")
        else:
            q = clip(payload.get("question"), 500).strip()
            if not q:
                raise ValueError("tutor needs a question.")
        notes = json.dumps(ctx, ensure_ascii=False)
        msgs = [{"role": "system", "content": TUTOR_RULES + "\n\nChapter notes (JSON):\n" + notes}]
        for turn in (payload.get("history") or [])[-6:]:
            if isinstance(turn, dict) and turn.get("role") in ("user", "assistant"):
                msgs.append({"role": turn["role"], "content": clip(turn.get("content"), 600)})
        msgs.append({"role": "user", "content": q})
        return msgs, task
    raise ValueError("Unknown task. Use explain, debrief, tutor or quiz.")


def check_grounding(task, payload, text):
    """Light checks that the model stayed inside the evidence. Returns (ok, note)."""
    ctx = payload.get("context") or {}
    provided = set(RULE_ID.findall(json.dumps(ctx)))
    mentioned = set(RULE_ID.findall(text or ""))
    if task == "explain":
        if provided and not (mentioned & provided):
            return False, "The AI reply did not cite the rule that was broken. Rely on the rule card."
        if mentioned - provided:
            return False, "The AI reply mentions a rule that was not part of this mistake. Rely on the rule card."
    if task == "debrief" and (mentioned - provided):
        return False, "The AI debrief mentions rules that do not appear in the session log."
    return True, ""


# --------------------------------------------------------------------------- provider calls
def provider_request(cfg, messages):
    """Build (url, headers, body) for the configured provider."""
    body = {"messages": messages, cfg["max_tokens_param"]: cfg["max_tokens"]}
    if cfg["temperature"] is not None:
        body["temperature"] = cfg["temperature"]
    if cfg["provider"] == "openai_compatible":
        url = f'{cfg["base_url"]}/chat/completions'
        headers = {"Content-Type": "application/json"}
        if cfg["api_key"]:
            headers["Authorization"] = f'Bearer {cfg["api_key"]}'
        body["model"] = cfg["model"]
    else:
        raise RuntimeError("No AI provider configured.")
    return url, headers, json.dumps(body).encode("utf-8")


def call_provider(cfg, messages):
    url, headers, data = provider_request(cfg, messages)
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=cfg["timeout"]) as r:
            out = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", {}).get("message", "")
        except Exception:
            pass
        raise RuntimeError(f"Provider returned HTTP {e.code}. {clip(detail, 200)}".strip())
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach the AI provider ({e.reason}).")
    try:
        text = out["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError("Unexpected response from the AI provider.")
    if isinstance(text, list):  # some APIs return content parts
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    return (text or "").strip()


class RateLimiter:
    def __init__(self, per_min):
        self.per_min, self.hits, self.lock = per_min, [], threading.Lock()

    def allow(self):
        now = time.time()
        with self.lock:
            self.hits = [t for t in self.hits if now - t < 60]
            if len(self.hits) >= self.per_min:
                return False
            self.hits.append(now)
            return True


# --------------------------------------------------------------------------- HTTP
def safe_path(root, url_path):
    """Map a URL path to a file under root, or None if it escapes root."""
    rel = urllib.request.url2pathname(url_path.split("?", 1)[0].split("#", 1)[0]).lstrip("/\\")
    if rel in ("", "."):
        rel = "index.html"
    full = (root / rel).resolve()
    try:
        full.relative_to(root.resolve())
    except ValueError:
        return None
    if full.is_dir():
        full = full / "index.html"
    return full


class Handler(SimpleHTTPRequestHandler):
    cfg = None
    limiter = None

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def _json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/status"):
            return self._json(200, public_status(self.cfg))
        p = safe_path(SITE, self.path)
        if p is None or not p.is_file():
            self.send_error(404, "Not found")
            return
        ctype = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
        if p.suffix in (".js", ".mjs"):
            ctype = "text/javascript"
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self.path.startswith("/api/ai"):
            return self._json(404, {"ok": False, "error": "Not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return self._json(413, {"ok": False, "error": "Request too large."})
        try:
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
            messages, task = build_messages(payload)
        except (ValueError, json.JSONDecodeError) as e:
            return self._json(400, {"ok": False, "error": str(e)})
        if not provider_ready(self.cfg):
            return self._json(503, {"ok": False, "error": "AI is not configured on this server. See server/.env.example."})
        if not self.limiter.allow():
            return self._json(429, {"ok": False, "error": "Too many AI requests. Wait a minute and try again."})
        t0 = time.time()
        try:
            text = call_provider(self.cfg, messages)
        except RuntimeError as e:
            return self._json(502, {"ok": False, "error": str(e)})
        grounded, note = check_grounding(task, payload, text)
        sys.stderr.write(f"  ai task={task} {int((time.time() - t0) * 1000)} ms grounded={grounded}\n")
        st = public_status(self.cfg)
        return self._json(200, {"ok": True, "text": text, "grounded": grounded, "note": note, "provider": st["provider"], "model": st["model"]})


def make_server(host, port, tries=10):
    """Bind to the port, or the next free one if it is busy (e.g. an old server window)."""
    last = None
    for p in range(port, port + tries):
        try:
            return ThreadingHTTPServer((host, p), Handler), p
        except OSError as e:
            last = e
            print(f"Port {p} is busy, trying {p + 1}...")
    raise SystemExit(f"Could not open a port between {port} and {port + tries - 1}: {last}")


def main():
    # Plain ASCII output so any Windows console code page can print it.
    try:
        sys.stdout.reconfigure(errors="replace")
        sys.stderr.reconfigure(errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="MRISafe Twin local server")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 only on a trusted network")
    ap.add_argument("--open", action="store_true", help="open the app in the default browser")
    args = ap.parse_args()
    if not (SITE / "index.html").is_file():
        raise SystemExit(f"Cannot find {SITE / 'index.html'}. Unzip the whole MRISafe-Twin folder and run this file from inside it.")
    load_env(HERE / ".env")
    cfg = config_from_env()
    Handler.cfg = cfg
    Handler.limiter = RateLimiter(cfg["rate_per_min"])
    st = public_status(cfg)
    srv, port = make_server(args.host, args.port)
    url = f"http://127.0.0.1:{port}/"
    print("")
    print("  MRISafe Twin is running.")
    print(f"  Open this address in Chrome or Edge:  {url}")
    print(f"  (serving {SITE})")
    if st["configured"]:
        print(f"  Coach: offline knowledge base + local AI model ({st['model']})")
    else:
        print("  Coach: offline knowledge base (no AI model configured; optional, see server/.env.example)")
    print("  Keep this window open while you use the app. Press Ctrl+C to stop.")
    print("")
    sys.stdout.flush()
    if args.open:
        import webbrowser
        threading.Timer(1.0, webbrowser.open, (url,)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()
