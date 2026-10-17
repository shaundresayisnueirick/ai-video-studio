"""AI Video Studio — local-first, single-user prototype."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from contextlib import contextmanager
import json
import mimetypes
import sqlite3
import uuid
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
UPLOADS = DATA / "uploads"
DB = DATA / "studio.sqlite3"
DATA.mkdir(exist_ok=True)
UPLOADS.mkdir(exist_ok=True)

@contextmanager
def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def init_db():
    with connect() as db:
        db.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, idea TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'flow', status TEXT NOT NULL DEFAULT 'Draft', data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")

def project(row):
    item = dict(row)
    item["data"] = json.loads(item["data"])
    return item

def local_ollama_models():
    """Inspect only the local Ollama service; never fall back to a cloud host."""
    request = urllib.request.Request("http://127.0.0.1:11434/api/tags")
    with urllib.request.urlopen(request, timeout=1.5) as response:
        payload = json.loads(response.read(1_000_000))
    return [m.get("name") for m in payload.get("models", []) if m.get("name")]

def make_local_story(idea, goal, duration, style, model):
    models = local_ollama_models()
    if model not in models:
        raise ValueError("Pilih model yang terpasang di Ollama lokal.")
    schema = {"alternatives": [{
        "title": "judul alternatif", "logline": "cerita dalam satu kalimat", "concept": "ringkasan konsep",
        "audience": "target penonton", "message": "pesan utama", "opening": "pembuka",
        "conflict": "konflik", "development": "perkembangan", "ending": "penutup",
        "characters": [{"name": "nama", "appearance": "tampilan", "role": "peran"}],
        "locations": [{"name": "nama lokasi", "description": "suasana"}],
        "scenes": [{
            "title": "judul", "purpose": "tujuan adegan", "visual": "yang terlihat",
            "action": "aksi", "expression": "ekspresi", "location": "lokasi", "time": "waktu",
            "camera": "framing dan gerak kamera", "lighting": "pencahayaan",
            "dialogue": "dialog/narasi", "duration": "durasi target"
        }]
    }]}
    prompt = (
        "Buat tepat 3 alternatif konsep yang berbeda untuk ide video, masing-masing dengan 3 adegan ringkas. "
        "Berbahasa Indonesia, mudah diproduksi, dan jangan menambah fakta penting yang tidak didukung ide. "
        "Tulis keluaran HANYA sebagai JSON valid yang mengikuti struktur contoh ini: "
        + json.dumps(schema, ensure_ascii=False)
        + f"\n\nJenis video: {goal}\nDurasi target: {duration}\nGaya visual: {style}\nIde pengguna: {idea}"
    )
    body = json.dumps({
        "model": model,
        "stream": False,
        "format": "json",
        "messages": [
            {"role": "system", "content": "Anda asisten produksi video. Buat draft yang bisa diedit, ringkas, realistis untuk klip pendek, dan berbahasa Indonesia."},
            {"role": "user", "content": prompt},
        ],
        "options": {"temperature": 0.5, "num_predict": 3500},
    }).encode()
    request = urllib.request.Request("http://127.0.0.1:11434/api/chat", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=180) as response:
        result = json.loads(response.read(2_000_000))
    draft = json.loads(result["message"]["content"])
    alternatives = draft.get("alternatives")
    if not isinstance(alternatives, list) or not alternatives:
        raise ValueError("Model belum menghasilkan alternatif cerita yang valid. Coba lagi atau gunakan kerangka manual.")
    normalized = []
    for alternative in alternatives[:3]:
        if not isinstance(alternative, dict) or not isinstance(alternative.get("scenes"), list) or not alternative["scenes"]:
            continue
        alternative["characters"] = alternative.get("characters", [])[:12]
        alternative["locations"] = alternative.get("locations", [])[:12]
        alternative["scenes"] = [{
            "id": str(uuid.uuid4()), "title": str(s.get("title", "Adegan"))[:120],
            "purpose": str(s.get("purpose", ""))[:1000], "visual": str(s.get("visual", ""))[:1500],
            "action": str(s.get("action", ""))[:1000], "expression": str(s.get("expression", ""))[:500],
            "location": str(s.get("location", ""))[:300], "time": str(s.get("time", ""))[:100],
            "camera": str(s.get("camera", ""))[:500], "lighting": str(s.get("lighting", ""))[:300],
            "dialogue": str(s.get("dialogue", ""))[:1000], "duration": str(s.get("duration", "5 detik"))[:50],
            "assetIds": [], "production": "Draft",
        } for s in alternative["scenes"][:8] if isinstance(s, dict)]
        if alternative["scenes"]:
            normalized.append(alternative)
    if not normalized:
        raise ValueError("Model belum menghasilkan adegan valid. Coba lagi atau gunakan kerangka manual.")
    return {"alternatives": normalized}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def send(self, status, body, content_type="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)
    def payload(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/ai/status":
            try:
                models = local_ollama_models()
                return self.send(200, json.dumps({"available": True, "models": models}))
            except Exception:
                return self.send(200, '{"available":false,"models":[]}')
        if path == "/api/projects":
            with connect() as db: rows = db.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
            return self.send(200, json.dumps([project(r) for r in rows]))
        if path.startswith("/api/projects/"):
            ident = path.split("/")[-1]
            with connect() as db: row = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
            return self.send(200, json.dumps(project(row))) if row else self.send(404, '{"error":"Proyek tidak ditemukan"}')
        if path.startswith("/uploads/"):
            name = Path(path.removeprefix("/uploads/")).name
            file = UPLOADS / name
            return self.send(200, file.read_bytes(), mimetypes.guess_type(file.name)[0] or "application/octet-stream") if file.is_file() else self.send(404, b"")
        relative = "index.html" if path == "/" else path.lstrip("/")
        file = (ROOT / "static" / relative).resolve()
        if ROOT.joinpath("static").resolve() not in file.parents and file != ROOT.joinpath("static").resolve(): return self.send(403, "Forbidden", "text/plain")
        if not file.is_file(): return self.send(404, "Tidak ditemukan", "text/plain; charset=utf-8")
        return self.send(200, file.read_bytes(), mimetypes.guess_type(file.name)[0] or "application/octet-stream")
    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/ai/story":
            try:
                body = self.payload()
                idea = str(body.get("idea", "")).strip()
                if not idea or len(idea) > 7000: return self.send(400, '{"error":"Isi ide (maks. 7.000 karakter) sebelum meminta draft."}')
                draft = make_local_story(idea, str(body.get("goal", ""))[:100], str(body.get("duration", "1 menit"))[:50], str(body.get("style", ""))[:100], str(body.get("model", "")))
                return self.send(200, json.dumps({"draft": draft}, ensure_ascii=False))
            except ValueError as exc:
                return self.send(400, json.dumps({"error": str(exc)}, ensure_ascii=False))
            except Exception:
                return self.send(502, '{"error":"AI lokal tidak merespons dengan draft yang valid. Coba lagi atau gunakan kerangka manual."}')
        if path == "/api/projects":
            body = self.payload()
            ident = str(uuid.uuid4())
            data = {"scenes": [], "assets": [], "notes": ""}
            with connect() as db:
                db.execute("INSERT INTO projects(id,title,goal,idea,platform,status,data) VALUES(?,?,?,?,?,?,?)", (ident, body.get("title", "Proyek baru"), body.get("goal", "Konten media sosial"), body.get("idea", ""), body.get("platform", "flow"), "Draft", json.dumps(data, ensure_ascii=False)))
                row = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
            return self.send(201, json.dumps(project(row), ensure_ascii=False))
        if path.startswith("/api/projects/") and path.endswith("/assets"):
            ident = path.split("/")[-2]
            filename = Path(self.headers.get("X-Filename", "referensi")).name
            content_type = self.headers.get("Content-Type", "application/octet-stream")
            if not content_type.startswith("image/"): return self.send(415, '{"error":"Hanya gambar yang didukung pada MVP."}')
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if len(raw) > 12_000_000: return self.send(413, '{"error":"Ukuran gambar maksimum 12 MB."}')
            suffix = Path(filename).suffix[:12] or ".img"
            saved = f"{ident}-{uuid.uuid4().hex}{suffix}"
            (UPLOADS / saved).write_bytes(raw)
            with connect() as db:
                row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
                if not row: (UPLOADS / saved).unlink(missing_ok=True); return self.send(404, '{"error":"Proyek tidak ditemukan"}')
                category = self.headers.get("X-Asset-Type", "Referensi umum")
                if category not in {"Karakter", "Lokasi", "Produk", "Adegan", "Referensi umum"}: category = "Referensi umum"
                data = json.loads(row["data"]); data.setdefault("assets", []).append({"id": str(uuid.uuid4()), "name": filename[:200], "url": f"/uploads/{saved}", "type": category})
                db.execute("UPDATE projects SET data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (json.dumps(data, ensure_ascii=False), ident))
            return self.send(201, json.dumps({"name": filename, "url": f"/uploads/{saved}"}, ensure_ascii=False))
        return self.send(404, '{"error":"Endpoint tidak ditemukan"}')
    def do_PUT(self):
        ident = urlparse(self.path).path.split("/")[-1]
        body = self.payload()
        with connect() as db:
            exists = db.execute("SELECT 1 FROM projects WHERE id=?", (ident,)).fetchone()
            if not exists: return self.send(404, '{"error":"Proyek tidak ditemukan"}')
            db.execute("UPDATE projects SET title=?,goal=?,idea=?,platform=?,status=?,data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (body.get("title", "Proyek"), body.get("goal", ""), body.get("idea", ""), body.get("platform", "flow"), body.get("status", "Draft"), json.dumps(body.get("data", {}), ensure_ascii=False), ident))
            row = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
        return self.send(200, json.dumps(project(row), ensure_ascii=False))
    def do_DELETE(self):
        ident = urlparse(self.path).path.split("/")[-1]
        with connect() as db:
            db.execute("DELETE FROM projects WHERE id=?", (ident,))
        for file in UPLOADS.glob(f"{ident}-*"): file.unlink(missing_ok=True)
        return self.send(204, "")

if __name__ == "__main__":
    init_db()
    print("AI Video Studio berjalan di http://127.0.0.1:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
