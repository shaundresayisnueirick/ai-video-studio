"""AI Video Studio — local-first, single-user prototype."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse
from contextlib import contextmanager
import copy
import json
import mimetypes
from datetime import datetime, timezone
import os
import sqlite3
import stat
import socket
import struct
import uuid
import urllib.request
import urllib.error
import production_package
import zlib

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"

def load_env_file(path):
    """Read KEY=VALUE lines from a local .env file. Existing non-empty environment variables win; values are never printed."""
    try:
        lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    except (FileNotFoundError, UnicodeDecodeError):
        return
    for raw in lines:
        line = raw.strip()
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key or line.startswith("#") or not all(ch.isalnum() or ch == "_" for ch in key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not os.environ.get(key, "").strip():
            os.environ[key] = value

GEMINI_KEY_SOURCE = "environment" if os.environ.get("GEMINI_API_KEY", "").strip() else None
load_env_file(ROOT / ".env")
if GEMINI_KEY_SOURCE is None and os.environ.get("GEMINI_API_KEY", "").strip():
    GEMINI_KEY_SOURCE = "file"
UPLOADS = DATA / "uploads"
DB = DATA / "studio.sqlite3"
MAX_ASSET_BYTES = 12_000_000
MAX_JSON_BODY_BYTES = 1_000_000
PRODUCTION_SCHEMA_VERSION = 1
MAX_IMAGE_PIXELS = 80_000_000
MAX_DECODED_IMAGE_BYTES = 128_000_000
MAX_VIDEO_BYTES = 50_000_000
VIDEO_CHUNK_BYTES = 65_536
MAX_RESULT_NOTE = 500
VIDEO_RESULT_STATUSES = ("kandidat", "utama", "revisi")
VIDEO_TYPES = {
    "video/mp4": (".mp4", lambda head: head[4:8] == b"ftyp"),
    "video/webm": (".webm", lambda head: head[:4] == b"\x1aE\xdf\xa3"),
}

class _NotFound(Exception): pass
class _BadScene(Exception): pass
class _MissingFile(Exception): pass
GEMINI_MODEL = "gemini-3.1-flash-lite"
GEMINI_API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
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
    data = normalize_production_data(json.loads(item["data"]), item)
    # The saved package is owned by the server: it is written only through the production-package endpoint.
    stored = data.pop("productionPackage", None)
    if stored is not None:
        data["productionPackage"] = production_package.view_for_project(stored, data["assets"])
    item["data"] = data
    return item

def _as_list(value):
    return value if isinstance(value, list) else []

INVALID_PROJECT_ID = '{"error":"ID proyek tidak valid."}'

def valid_project_id(value):
    # Project ids are canonical UUIDs; anything else must never reach a file name or glob pattern.
    try:
        return str(uuid.UUID(value)) == value
    except (TypeError, ValueError):
        return False

def normalize_production_data(value, project_fields=None):
    """Add the versioned production contract while retaining legacy fields."""
    if not isinstance(value, dict):
        raise ValueError("Data proyek harus berupa objek JSON.")
    data = dict(value)
    for key in ("scenes", "assets"):
        if key in data and not isinstance(data[key], list):
            raise ValueError(f"Field {key} harus berupa daftar.")
    for key in ("checks", "projectBrief", "storyPlan", "entities", "productionSettings", "assemblyPlan", "approvals", "audioDirector"):
        if key in data and data[key] is not None and not isinstance(data[key], dict):
            raise ValueError(f"Field {key} harus berupa objek.")
    data.setdefault("schemaVersion", PRODUCTION_SCHEMA_VERSION)
    data.setdefault("scenes", [])
    data.setdefault("assets", [])
    data.setdefault("checks", {})
    data["scenes"] = _as_list(data["scenes"])
    data["assets"] = _as_list(data["assets"])
    data["videoResults"] = _as_list(data.get("videoResults"))
    data["checks"] = data["checks"] if isinstance(data["checks"], dict) else {}

    fields = project_fields or {}
    brief = dict(data.get("projectBrief")) if isinstance(data.get("projectBrief"), dict) else {}
    brief.setdefault("idea", fields.get("idea", ""))
    brief.setdefault("videoType", fields.get("goal", ""))
    brief.setdefault("audience", "")
    brief.setdefault("keyMessage", data.get("message", ""))
    brief.setdefault("visualStyle", data.get("style", ""))
    if data.get("duration"):
        brief["targetDuration"] = data["duration"]
    else:
        brief.setdefault("targetDuration", "")
    brief.setdefault("characterNotes", data.get("character", ""))
    brief.setdefault("locationNotes", data.get("world", ""))
    data["projectBrief"] = brief

    story = dict(data.get("storyPlan")) if isinstance(data.get("storyPlan"), dict) else {}
    legacy_story = data.get("story") if isinstance(data.get("story"), dict) else {}
    for key in ("title", "logline", "concept", "opening", "conflict", "development", "ending", "audience"):
        story.setdefault(key, legacy_story.get(key, ""))
    story.setdefault("approvalStatus", "draft")
    data["storyPlan"] = story

    source_entities = data.get("entities") if isinstance(data.get("entities"), dict) else {}
    entities = dict(source_entities)
    for key in ("characters", "products", "locations"):
        if key in entities and not isinstance(entities[key], list):
            raise ValueError(f"entities.{key} harus berupa daftar.")
    legacy_characters = _as_list(data.get("characters"))
    legacy_locations = _as_list(data.get("locations"))
    entities.setdefault("characters", legacy_characters)
    entities.setdefault("products", [])
    entities.setdefault("locations", legacy_locations)
    for key in ("characters", "products", "locations"):
        entities[key] = _as_list(entities[key])
    data["entities"] = entities

    normalized_scenes = []
    for index, source in enumerate(data["scenes"]):
        if not isinstance(source, dict):
            raise ValueError(f"Adegan nomor {index + 1} harus berupa objek.")
        scene = dict(source)
        for key in ("characterIds", "productIds", "assetIds", "referenceAssetIds"):
            if key in scene and not isinstance(scene[key], list):
                raise ValueError(f"Field {key} pada adegan harus berupa daftar.")
        for key in ("audio", "audioPlan", "continuityIn", "continuityOut", "productionChecklist"):
            if key in scene and scene[key] is not None and not isinstance(scene[key], dict):
                raise ValueError(f"Field {key} pada adegan harus berupa objek.")
        scene.setdefault("id", f"legacy-scene-{index + 1}")
        scene["narrativePurpose"] = scene.get("purpose", scene.get("narrativePurpose", ""))
        scene["visualDescription"] = scene.get("visual", scene.get("visualDescription", ""))
        scene.setdefault("characterIds", [])
        scene.setdefault("productIds", [])
        scene.setdefault("locationId", "")
        scene["referenceAssetIds"] = scene.get("assetIds", scene.get("referenceAssetIds", []))
        scene.setdefault("camera", "")
        scene.setdefault("lighting", "")
        scene.setdefault("dialogue", "")
        scene.setdefault("audio", {"voiceover": "", "music": "", "effects": []})
        legacy_audio = scene["audio"] if isinstance(scene["audio"], dict) else {}
        if "audioPlan" not in scene:
            legacy_dialogue = scene.get("dialogue", "")
            dialogue_items = ([{"speakerName": "", "speakerId": "", "voiceProfileId": "", "voiceProfile": "", "text": legacy_dialogue, "emotion": "", "delivery": ""}] if isinstance(legacy_dialogue, str) and legacy_dialogue.strip() else [])
            scene["audioPlan"] = {
                "required": bool(dialogue_items or legacy_audio.get("voiceover") or legacy_audio.get("music") or legacy_audio.get("effects")),
                "dialogue": dialogue_items,
                "voiceover": {"narratorName": "", "narratorId": "", "voiceProfileId": "", "voiceProfile": "", "text": legacy_audio.get("voiceover", "") if isinstance(legacy_audio.get("voiceover", ""), str) else "", "emotion": "", "delivery": ""},
                "music": {"description": legacy_audio.get("music", "") if isinstance(legacy_audio.get("music", ""), str) else "", "mood": "", "continuityId": "", "transition": ""},
                "ambience": [],
                "soundEffects": legacy_audio.get("effects", []) if isinstance(legacy_audio.get("effects", []), list) else [],
            }
        plan = scene["audioPlan"]
        if not isinstance(plan, dict): raise ValueError("audioPlan pada adegan harus berupa objek.")
        plan.setdefault("required", False)
        if not isinstance(plan["required"], bool): raise ValueError("audioPlan.required harus berupa boolean.")
        for key in ("dialogue", "ambience", "soundEffects"):
            if key in plan and not isinstance(plan[key], list): raise ValueError(f"audioPlan.{key} harus berupa daftar.")
        plan.setdefault("dialogue", []); plan.setdefault("ambience", []); plan.setdefault("soundEffects", [])
        for item in plan["dialogue"]:
            if not isinstance(item, dict): raise ValueError("Setiap dialog harus berupa objek.")
            for key in ("speakerName", "speakerId", "voiceProfileId", "voiceProfile", "text", "emotion", "delivery"):
                if key in item and not isinstance(item[key], str): raise ValueError(f"Dialog {key} harus berupa teks.")
                item.setdefault(key, "")
        voiceover = plan.get("voiceover", {})
        music = plan.get("music", {})
        if not isinstance(voiceover, dict) or not isinstance(music, dict): raise ValueError("Voice-over dan musik harus berupa objek.")
        plan["voiceover"], plan["music"] = voiceover, music
        for obj, keys in ((voiceover, ("narratorName", "narratorId", "voiceProfileId", "voiceProfile", "text", "emotion", "delivery")), (music, ("description", "mood", "continuityId", "transition"))):
            for key in keys:
                if key in obj and not isinstance(obj[key], str): raise ValueError(f"Audio {key} harus berupa teks.")
                obj.setdefault(key, "")
        if any(not isinstance(item, str) for item in plan["ambience"] + plan["soundEffects"]): raise ValueError("Ambience dan efek suara harus berupa teks.")
        # Keep the old fields populated for existing consumers and project files.
        scene["dialogue"] = "\n".join(item["text"] for item in plan["dialogue"] if item["text"])
        scene["audio"] = {"voiceover": voiceover["text"], "music": music["description"], "effects": list(plan["soundEffects"])}
        scene.setdefault("duration", "5 detik")
        scene.setdefault("continuityIn", {})
        scene.setdefault("continuityOut", {})
        scene.setdefault("approvalStatus", "draft")
        scene.setdefault("productionStatus", scene.get("production", "Draft"))
        checklist = dict(scene.get("productionChecklist")) if isinstance(scene.get("productionChecklist"), dict) else {}
        checklist_present = isinstance(source.get("productionChecklist"), dict) or any(f"scene-{scene['id']}-{key}" in data["checks"] for key in ("assets", "prompt", "generated", "collected"))
        for key in ("assets", "prompt", "generated", "collected", "audio"):
            check_key = f"scene-{scene['id']}-{key}"
            if check_key in data["checks"]:
                checklist[key] = bool(data["checks"][check_key])
            else:
                checklist.setdefault(key, False)
            data["checks"][f"scene-{scene['id']}-{key}"] = bool(checklist[key])
        scene["productionChecklist"] = checklist
        if checklist_present:
            scene["productionStatus"] = "collected" if checklist["collected"] else "in_progress" if checklist["generated"] else "prompt_ready" if checklist["prompt"] else "references_ready" if checklist["assets"] else "Draft"
        scene["characterIds"] = _as_list(scene["characterIds"])
        scene["productIds"] = _as_list(scene["productIds"])
        scene["referenceAssetIds"] = _as_list(scene["referenceAssetIds"])
        scene["purpose"] = scene["narrativePurpose"]
        scene["visual"] = scene["visualDescription"]
        scene["assetIds"] = scene["referenceAssetIds"]
        scene["production"] = scene["productionStatus"]
        for key in ("characterIds", "productIds", "referenceAssetIds"):
            if any(not isinstance(value, str) for value in scene[key]):
                raise ValueError(f"Referensi {key} pada adegan harus berupa ID teks.")
        if not isinstance(scene["continuityIn"], dict) or not isinstance(scene["continuityOut"], dict):
            raise ValueError("Data kesinambungan adegan harus berupa objek JSON.")
        normalized_scenes.append(scene)
    data["scenes"] = normalized_scenes

    settings = dict(data.get("productionSettings")) if isinstance(data.get("productionSettings"), dict) else {}
    settings.setdefault("platform", fields.get("platform", "flow"))
    settings.setdefault("aspectRatio", "")
    settings.setdefault("model", "")
    data["productionSettings"] = settings
    assembly = dict(data.get("assemblyPlan")) if isinstance(data.get("assemblyPlan"), dict) else {}
    assembly.setdefault("status", "not_started")
    assembly.setdefault("clips", [])
    assembly.setdefault("audioTracks", [])
    assembly.setdefault("exportSettings", {})
    data["assemblyPlan"] = assembly
    data["audioDirector"] = data.get("audioDirector") if isinstance(data.get("audioDirector"), dict) else {}
    data["audioDirector"].setdefault("continuityNotes", "")
    if not isinstance(data["audioDirector"]["continuityNotes"], str): raise ValueError("audioDirector.continuityNotes harus berupa teks.")
    approvals = dict(data.get("approvals")) if isinstance(data.get("approvals"), dict) else {}
    approvals.setdefault("story", story["approvalStatus"])
    data["approvals"] = approvals
    return data

def _validate_png(raw):
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("PNG signature tidak valid.")
    pos, width, height, color_type, bit_depth = 8, 0, 0, None, None
    seen_ihdr = seen_idat = seen_iend = seen_plte = idat_closed = False
    compressed = bytearray()
    while pos < len(raw):
        if pos + 12 > len(raw): raise ValueError("Chunk PNG terpotong.")
        length = struct.unpack_from(">I", raw, pos)[0]
        kind = raw[pos + 4:pos + 8]
        end = pos + 12 + length
        if end > len(raw): raise ValueError("Chunk PNG terpotong.")
        payload = raw[pos + 8:pos + 8 + length]
        expected_crc = struct.unpack_from(">I", raw, pos + 8 + length)[0]
        if zlib.crc32(kind + payload) & 0xffffffff != expected_crc:
            raise ValueError("CRC PNG tidak valid.")
        if not seen_ihdr:
            if kind != b"IHDR" or length != 13: raise ValueError("IHDR PNG tidak valid.")
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            valid_depths = {0:{1,2,4,8,16}, 2:{8,16}, 3:{1,2,4,8}, 4:{8,16}, 6:{8,16}}
            if not width or not height or width * height > MAX_IMAGE_PIXELS: raise ValueError("Dimensi PNG tidak valid atau terlalu besar.")
            if color_type not in valid_depths or bit_depth not in valid_depths[color_type] or compression or filtering or interlace not in (0,1):
                raise ValueError("Format IHDR PNG tidak didukung atau tidak valid.")
            seen_ihdr = True
        elif kind == b"IHDR":
            raise ValueError("PNG memiliki lebih dari satu IHDR.")
        elif kind == b"PLTE":
            if seen_idat or not length or length % 3 or length > 768: raise ValueError("Palette PNG tidak valid.")
            seen_plte = True
        elif kind == b"IDAT":
            if seen_iend or idat_closed: raise ValueError("Urutan chunk PNG tidak valid.")
            compressed.extend(payload)
            seen_idat = True
        elif kind == b"IEND":
            if length or not seen_idat or end != len(raw): raise ValueError("IEND PNG tidak valid.")
            seen_iend = True
            pos = end
            break
        else:
            if seen_idat and not seen_iend: idat_closed = True
            if kind[0] & 0x20 == 0 and kind not in (b"tRNS",):
                raise ValueError("Chunk kritis PNG tidak didukung.")
        if seen_idat and kind not in (b"IDAT", b"IEND"):
            idat_closed = True
        pos = end
    if not (seen_ihdr and seen_idat and seen_iend): raise ValueError("PNG belum lengkap.")
    if color_type == 3 and not seen_plte: raise ValueError("PNG berpalet harus memiliki PLTE.")

    channels = {0:1, 2:3, 3:1, 4:2, 6:4}[color_type]
    passes = [(0,0,1,1)] if interlace == 0 else [(0,0,8,8),(4,0,8,8),(0,4,4,8),(2,0,4,4),(0,2,2,4),(1,0,1,2),(0,1,1,2)]
    rows = []
    for x0, y0, dx, dy in passes:
        pass_width = max(0, (width - x0 + dx - 1) // dx)
        pass_height = max(0, (height - y0 + dy - 1) // dy)
        if pass_width and pass_height:
            row_bytes = (pass_width * channels * bit_depth + 7) // 8
            rows.append((row_bytes, pass_height))
    decoded_length = sum((row_bytes + 1) * count for row_bytes, count in rows)
    if decoded_length > MAX_DECODED_IMAGE_BYTES: raise ValueError("Data gambar PNG terlalu besar untuk diproses dengan aman.")
    decoder = zlib.decompressobj()
    decoded = decoder.decompress(bytes(compressed), decoded_length + 1)
    if len(decoded) > decoded_length or decoder.unconsumed_tail or not decoder.eof or decoder.unused_data or len(decoded) != decoded_length:
        raise ValueError("Data gambar PNG terkompresi tidak valid.")
    offset = 0
    for row_bytes, count in rows:
        for _ in range(count):
            if decoded[offset] > 4: raise ValueError("Filter baris PNG tidak valid.")
            offset += row_bytes + 1

def _validate_jpeg(raw):
    if not raw.startswith(b"\xff\xd8"):
        raise ValueError("JPEG signature tidak valid.")
    pos, has_frame, has_scan, ended = 2, False, False, False
    frame_markers = {0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf}
    while pos < len(raw):
        if raw[pos] != 0xff: raise ValueError("Marker JPEG tidak valid.")
        while pos < len(raw) and raw[pos] == 0xff: pos += 1
        if pos >= len(raw): raise ValueError("Marker JPEG terpotong.")
        marker = raw[pos]
        pos += 1
        if marker == 0xd9:
            ended = True
            if pos != len(raw): raise ValueError("Ada data setelah marker akhir JPEG.")
            break
        if marker in (0xd8, 0x00): raise ValueError("Marker JPEG tidak valid.")
        if marker == 0x01 or 0xd0 <= marker <= 0xd7: continue
        if pos + 2 > len(raw): raise ValueError("Segmen JPEG terpotong.")
        length = struct.unpack_from(">H", raw, pos)[0]
        if length < 2 or pos + length > len(raw): raise ValueError("Panjang segmen JPEG tidak valid.")
        segment = raw[pos + 2:pos + length]
        pos += length
        if marker in frame_markers:
            if len(segment) < 6: raise ValueError("Frame JPEG tidak lengkap.")
            height, width, components = struct.unpack_from(">HHB", segment, 1)
            if not width or not height or width * height > MAX_IMAGE_PIXELS or not components or len(segment) != 6 + components * 3:
                raise ValueError("Dimensi atau komponen frame JPEG tidak valid.")
            has_frame = True
        elif marker == 0xda:
            if not has_frame or len(segment) < 4: raise ValueError("Scan JPEG tidak memiliki frame yang valid.")
            components = segment[0]
            if not components or len(segment) != 4 + components * 2: raise ValueError("Header scan JPEG tidak valid.")
            has_scan = True
            while pos < len(raw):
                if raw[pos] != 0xff:
                    pos += 1
                    continue
                marker_start = pos
                pos += 1
                while pos < len(raw) and raw[pos] == 0xff: pos += 1
                if pos >= len(raw): raise ValueError("Data scan JPEG terpotong.")
                next_marker = raw[pos]
                if next_marker == 0x00 or 0xd0 <= next_marker <= 0xd7:
                    pos += 1
                    continue
                pos = marker_start
                break
    if not (has_frame and has_scan and ended): raise ValueError("JPEG tidak lengkap.")

def _skip_gif_subblocks(raw, pos):
    total = 0
    while True:
        if pos >= len(raw): raise ValueError("Blok data GIF terpotong.")
        length = raw[pos]
        pos += 1
        if length == 0: return pos, total
        if pos + length > len(raw): raise ValueError("Blok data GIF terpotong.")
        pos += length
        total += length

def _validate_gif(raw):
    if len(raw) < 14 or raw[:6] not in (b"GIF87a", b"GIF89a"):
        raise ValueError("Header GIF tidak valid.")
    width, height = struct.unpack_from("<HH", raw, 6)
    if not width or not height or width * height > MAX_IMAGE_PIXELS: raise ValueError("Dimensi GIF tidak valid atau terlalu besar.")
    packed = raw[10]
    pos = 13
    if packed & 0x80:
        pos += 3 * (1 << ((packed & 0x07) + 1))
        if pos > len(raw): raise ValueError("Palette GIF terpotong.")
    has_image = False
    while pos < len(raw):
        marker = raw[pos]
        pos += 1
        if marker == 0x3b:
            if not has_image or pos != len(raw): raise ValueError("Trailer GIF tidak valid.")
            return
        if marker == 0x21:
            if pos >= len(raw): raise ValueError("Ekstensi GIF terpotong.")
            pos += 1
            pos, _ = _skip_gif_subblocks(raw, pos)
        elif marker == 0x2c:
            if pos + 9 > len(raw): raise ValueError("Deskriptor gambar GIF terpotong.")
            image_width, image_height = struct.unpack_from("<HH", raw, pos + 4)
            image_packed = raw[pos + 8]
            pos += 9
            if not image_width or not image_height or image_width * image_height > MAX_IMAGE_PIXELS: raise ValueError("Frame GIF tidak valid atau terlalu besar.")
            if image_packed & 0x80:
                pos += 3 * (1 << ((image_packed & 0x07) + 1))
                if pos > len(raw): raise ValueError("Palette frame GIF terpotong.")
            if pos >= len(raw) or not 2 <= raw[pos] <= 8: raise ValueError("Kode kompresi GIF tidak valid.")
            pos, image_data = _skip_gif_subblocks(raw, pos + 1)
            if not image_data: raise ValueError("Data frame GIF kosong.")
            has_image = True
        else:
            raise ValueError("Blok GIF tidak dikenal.")
    raise ValueError("GIF tidak memiliki trailer akhir.")

def _validate_webp(raw):
    if len(raw) < 20 or raw[:4] != b"RIFF" or raw[8:12] != b"WEBP" or struct.unpack_from("<I", raw, 4)[0] != len(raw) - 8:
        raise ValueError("Container WebP tidak valid.")
    pos, has_image = 12, False
    while pos < len(raw):
        if pos + 8 > len(raw): raise ValueError("Chunk WebP terpotong.")
        kind = raw[pos:pos+4]
        length = struct.unpack_from("<I", raw, pos+4)[0]
        start, end = pos + 8, pos + 8 + length
        if end > len(raw): raise ValueError("Chunk WebP terpotong.")
        payload = raw[start:end]
        if kind == b"VP8X":
            if length != 10: raise ValueError("Header VP8X tidak valid.")
            width = 1 + int.from_bytes(payload[4:7], "little")
            height = 1 + int.from_bytes(payload[7:10], "little")
            if width * height > MAX_IMAGE_PIXELS: raise ValueError("Dimensi WebP terlalu besar.")
        elif kind == b"VP8 ":
            if length < 10 or payload[3:6] != b"\x9d\x01\x2a": raise ValueError("Frame VP8 tidak valid.")
            width = struct.unpack_from("<H", payload, 6)[0] & 0x3fff
            height = struct.unpack_from("<H", payload, 8)[0] & 0x3fff
            if not width or not height or width * height > MAX_IMAGE_PIXELS: raise ValueError("Dimensi WebP tidak valid atau terlalu besar.")
            has_image = True
        elif kind == b"VP8L":
            if length < 5 or payload[0] != 0x2f: raise ValueError("Frame VP8L tidak valid.")
            width = 1 + ((payload[2] & 0x3f) << 8) + payload[1]
            height = 1 + ((payload[4] & 0x0f) << 10) + (payload[3] << 2) + (payload[2] >> 6)
            if width * height > MAX_IMAGE_PIXELS: raise ValueError("Dimensi WebP terlalu besar.")
            has_image = True
        pos = end + (length & 1)
    if pos != len(raw) or not has_image: raise ValueError("WebP tidak memiliki frame gambar yang valid.")

def validate_image(raw, declared_type):
    """Validate supported raster image structure using only the Python standard library."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        image_type, extension, validator = "image/png", ".png", _validate_png
    elif raw.startswith(b"\xff\xd8"):
        image_type, extension, validator = "image/jpeg", ".jpg", _validate_jpeg
    elif raw.startswith((b"GIF87a", b"GIF89a")):
        image_type, extension, validator = "image/gif", ".gif", _validate_gif
    elif raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        image_type, extension, validator = "image/webp", ".webp", _validate_webp
    else:
        raise ValueError("Format gambar tidak didukung. Gunakan PNG, JPEG, GIF, atau WebP.")
    if declared_type.split(";", 1)[0].strip().lower() != image_type:
        raise ValueError("Tipe file tidak cocok dengan isi gambar.")
    validator(raw)
    return image_type, extension

def local_ollama_models():
    """Inspect only the local Ollama service; never fall back to a cloud host."""
    request = urllib.request.Request("http://127.0.0.1:11434/api/tags")
    with urllib.request.urlopen(request, timeout=1.5) as response:
        payload = json.loads(response.read(1_000_000))
    return [m.get("name") for m in payload.get("models", []) if m.get("name")]

def story_schema_example():
    return {"alternatives": [{
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

def story_prompt(idea, goal, duration, style, details=None):
    return (
        "Buat tepat 3 alternatif konsep untuk ide video, masing-masing dengan 3 adegan ringkas. "
        "Ketiga alternatif harus memegang inti dan pesan utama yang sama; yang berbeda hanya cara penyajian. "
        "Berbahasa Indonesia, mudah diproduksi, dan jangan menambah fakta penting yang tidak didukung ide.\n"
        + production_package.FIDELITY_RULES
        + production_package.details_block(details or {})
        + "Tulis keluaran HANYA sebagai JSON valid yang mengikuti struktur contoh ini: "
        + json.dumps(story_schema_example(), ensure_ascii=False)
        + f"\n\nJenis video: {goal}\nDurasi target: {duration}\nGaya visual: {style}\nIde pengguna: {idea}"
    )

# Limits are checked and reported, never cut. A draft that exceeds them is rejected so the user can retry.
STORY_LIMITS = {"title": 120, "purpose": 1000, "visual": 1500, "action": 1000, "expression": 500, "location": 300,
                "time": 100, "camera": 500, "lighting": 300, "dialogue": 1000, "duration": 50}
MAX_STORY_ALTERNATIVES = 3
MAX_STORY_SCENES = 12
MAX_STORY_ITEMS = 12

def _story_text(scene, key, default, number):
    value = str(scene.get(key, default))
    if len(value) > STORY_LIMITS[key]:
        raise ValueError(f"Adegan nomor {number}: kolom {key} terlalu panjang ({len(value)} karakter, maks. {STORY_LIMITS[key]}). Coba lagi.")
    return value

def normalize_story_draft(draft):
    alternatives = draft.get("alternatives") if isinstance(draft, dict) else None
    if not isinstance(alternatives, list) or not alternatives:
        raise ValueError("Model belum menghasilkan alternatif cerita yang valid. Coba lagi atau gunakan kerangka manual.")
    if len(alternatives) > MAX_STORY_ALTERNATIVES:
        raise ValueError(f"Model menghasilkan {len(alternatives)} alternatif; maksimal {MAX_STORY_ALTERNATIVES}. Coba lagi.")
    normalized = []
    for number, alternative in enumerate(alternatives, 1):
        if not isinstance(alternative, dict) or not isinstance(alternative.get("scenes"), list) or not alternative["scenes"]:
            raise ValueError(f"Alternatif nomor {number} tidak memiliki adegan. Coba lagi.")
        scenes = alternative["scenes"]
        if len(scenes) > MAX_STORY_SCENES:
            raise ValueError(f"Alternatif nomor {number} memuat {len(scenes)} adegan; maksimal {MAX_STORY_SCENES}. Coba lagi.")
        for key in ("characters", "locations"):
            items = alternative.get(key, [])
            if not isinstance(items, list) or len(items) > MAX_STORY_ITEMS:
                raise ValueError(f"Daftar {key} pada alternatif nomor {number} tidak valid atau lebih dari {MAX_STORY_ITEMS}. Coba lagi.")
        alternative["characters"] = alternative.get("characters", [])
        alternative["locations"] = alternative.get("locations", [])
        normalized_scenes = []
        for index, scene in enumerate(scenes, 1):
            if not isinstance(scene, dict):
                raise ValueError(f"Adegan nomor {index} pada alternatif {number} harus berupa objek. Coba lagi.")
            item = {"id": str(uuid.uuid4()), "assetIds": [], "production": "Draft"}
            for key, default in {**{key: "" for key in STORY_LIMITS}, "title": "Adegan", "duration": "5 detik"}.items():
                item[key] = _story_text(scene, key, default, index)
            normalized_scenes.append(item)
        alternative["scenes"] = normalized_scenes
        normalized.append(alternative)
    return {"alternatives": normalized}

class GeminiProviderError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status

def gemini_generate_text(prompt, max_output_tokens):
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise GeminiProviderError(503, "GEMINI_API_KEY belum terbaca oleh server. Isi file .env di folder proyek (sejajar dengan app.py), simpan, lalu jalankan ulang server. Gemini tidak dijalankan.")
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.5, "maxOutputTokens": max_output_tokens},
    }).encode("utf-8")
    request = urllib.request.Request(
        GEMINI_API_URL,
        data=body,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read(2_000_001)
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise GeminiProviderError(429, "Batas permintaan atau kuota Gemini tercapai. Periksa kuota akun/API; tidak ada fallback otomatis.") from None
        if exc.code in (401, 403):
            raise GeminiProviderError(502, "Gemini menolak autentikasi atau akses API. Periksa GEMINI_API_KEY dan izin proyek.") from None
        raise GeminiProviderError(502, f"Gemini API mengembalikan kesalahan HTTP {exc.code}. Tidak ada fallback otomatis.") from None
    except (TimeoutError, socket.timeout):
        raise GeminiProviderError(504, "Permintaan Gemini melewati batas waktu. Coba lagi nanti; tidak ada fallback otomatis.") from None
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise GeminiProviderError(504, "Permintaan Gemini melewati batas waktu. Coba lagi nanti; tidak ada fallback otomatis.") from None
        raise GeminiProviderError(502, "Gemini API tidak dapat dijangkau. Periksa koneksi; tidak ada fallback otomatis.") from None

    if len(raw) > 2_000_000:
        raise GeminiProviderError(502, "Respons Gemini terlalu besar untuk diproses.")
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
        raise GeminiProviderError(502, "Respons Gemini kosong atau tidak valid. Coba lagi.") from None
    candidates = payload.get("candidates") if isinstance(payload, dict) else None
    if not candidates:
        reason = (payload.get("promptFeedback") or {}).get("blockReason") if isinstance(payload, dict) else None
        raise GeminiProviderError(502, f"Gemini tidak mengembalikan jawaban{f' (alasan: {str(reason)[:40]})' if reason else ''}. Ubah ide lalu coba lagi.")
    candidate = candidates[0] if isinstance(candidates[0], dict) else {}
    reason = str(candidate.get("finishReason") or "STOP")
    if reason == "MAX_TOKENS":
        raise GeminiProviderError(502, "Respons Gemini terpotong karena terlalu panjang. Coba lagi dengan ide yang lebih ringkas.")
    if reason != "STOP":
        raise GeminiProviderError(502, f"Gemini menghentikan respons (alasan: {reason[:40]}). Ubah ide lalu coba lagi.")
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(part["text"] for part in parts if isinstance(part, dict) and isinstance(part.get("text"), str))
    if not text.strip():
        raise GeminiProviderError(502, "Respons Gemini kosong. Coba lagi.")
    return text

def request_text(body, key, limit, default=""):
    """Text from the request. Longer text is refused with a message, never cut."""
    value = str(body.get(key, default) or "")
    if len(value) > limit:
        raise production_package.ProductionPackageError(f"Isian {key} terlalu panjang (maks. {limit} karakter).")
    return value

def make_gemini_story(idea, goal, duration, style, details=None):
    text = gemini_generate_text(story_prompt(idea, goal, duration, style, details), 3500)
    try:
        draft = json.loads(production_package.strip_json_fence(text))
    except json.JSONDecodeError:
        raise GeminiProviderError(502, "Respons Gemini bukan JSON cerita yang valid. Coba lagi.") from None
    try:
        return normalize_story_draft(draft)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise GeminiProviderError(502, str(exc) if isinstance(exc, ValueError) else "Respons Gemini tidak sesuai struktur cerita yang diharapkan.") from None

def make_gemini_understanding(idea, goal, duration, style, details, answers=""):
    text = gemini_generate_text(production_package.understanding_prompt(idea, goal, duration, style, details, answers), 3000)
    try:
        raw = json.loads(production_package.strip_json_fence(text))
    except json.JSONDecodeError:
        raise GeminiProviderError(502, "Respons Gemini bukan JSON pemahaman ide yang valid. Coba lagi.") from None
    try:
        return production_package.validate_understanding(raw)
    except production_package.ProductionPackageError as exc:
        raise GeminiProviderError(502, f"Pemahaman dari Gemini tidak valid: {exc}") from None

def make_gemini_production(idea, goal, duration, style, limits, assets, details=None, understanding=None):
    prompt = production_package.package_prompt(idea, goal, duration, style, assets, limits, details, understanding)
    text = gemini_generate_text(prompt, 12000)
    try:
        raw = json.loads(production_package.strip_json_fence(text))
    except json.JSONDecodeError:
        raise GeminiProviderError(502, "Respons Gemini bukan JSON paket produksi yang valid. Coba lagi.") from None
    try:
        return production_package.validate_package(raw, assets, limits, production_package.parse_target_seconds(duration), require_english=True)
    except production_package.ProductionPackageError as exc:
        raise GeminiProviderError(502, f"Paket produksi dari Gemini tidak valid: {exc}") from None

def make_local_story(idea, goal, duration, style, model, details=None):
    models = local_ollama_models()
    if model not in models:
        raise ValueError("Pilih model yang terpasang di Ollama lokal.")
    prompt = story_prompt(idea, goal, duration, style, details)
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
    return normalize_story_draft(draft)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def read_body(self, length):
        return self.rfile.read(length)
    def send(self, status, body, content_type="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)
    def payload(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except (TypeError, ValueError):
            self.send(400, json.dumps({"error": "Ukuran permintaan tidak valid."}, ensure_ascii=False))
            return None
        if length < 0:
            self.send(400, json.dumps({"error": "Ukuran permintaan tidak valid."}, ensure_ascii=False))
            return None
        if length > MAX_JSON_BODY_BYTES:
            self.send(413, json.dumps({"error": "Data permintaan melebihi batas 1 MB."}, ensure_ascii=False))
            return None
        raw = self.read_body(length)
        if len(raw) != length:
            self.send(400, json.dumps({"error": "Isi permintaan terpotong."}, ensure_ascii=False))
            return None
        try:
            payload = json.loads(raw or b"{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send(400, json.dumps({"error": "Format JSON tidak valid."}, ensure_ascii=False))
            return None
        if not isinstance(payload, dict):
            self.send(400, json.dumps({"error": "Isi permintaan harus berupa objek JSON."}, ensure_ascii=False))
            return None
        return payload
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/ai/gemini/status":
            configured = bool(os.environ.get("GEMINI_API_KEY", "").strip())
            return self.send(200, json.dumps({"configured": configured, "source": GEMINI_KEY_SOURCE if configured else None}))
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
    def do_HEAD(self):
        # Lets the browser tell a missing upload (404) from one that exists, without downloading it.
        path = urlparse(self.path).path
        if not path.startswith("/uploads/"): return self.send(404, b"")
        file = UPLOADS / Path(path.removeprefix("/uploads/")).name
        if not file.is_file(): return self.send(404, b"")
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(file.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(file.stat().st_size))
        self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/ai/understanding":
            try:
                body = self.payload()
                if body is None: return
                idea = str(body.get("idea", "")).strip()
                if not idea or len(idea) > 7000: return self.send(400, '{"error":"Isi ide (maks. 7.000 karakter) sebelum memeriksa pemahaman."}')
                understanding = make_gemini_understanding(
                    idea, request_text(body, "goal", 100), request_text(body, "duration", 50), request_text(body, "style", 100),
                    production_package.project_details(body), request_text(body, "answers", 1000))
                return self.send(200, json.dumps({"understanding": understanding}, ensure_ascii=False))
            except production_package.ProductionPackageError as exc:
                return self.send(400, json.dumps({"error": str(exc)}, ensure_ascii=False))
            except GeminiProviderError as exc:
                return self.send(exc.status, json.dumps({"error": str(exc)}, ensure_ascii=False))
            except Exception:
                return self.send(502, '{"error":"Gemini tidak merespons dengan pemahaman ide yang valid. Coba lagi."}')
        if path == "/api/ai/production":
            try:
                body = self.payload()
                if body is None: return
                limits = production_package.model_limits(body.get("model_key"))
                project_id = str(body.get("project_id", "")).strip()[:64]
                if not project_id: return self.send(400, '{"error":"Simpan proyek terlebih dahulu sebelum membuat paket produksi."}')
                with connect() as db: row = db.execute("SELECT idea, data FROM projects WHERE id=?", (project_id,)).fetchone()
                if not row: return self.send(404, '{"error":"Proyek tidak ditemukan"}')
                data = json.loads(row["data"])
                # The package is only made from a summary the user confirmed for the idea that is saved on the server.
                understanding = production_package.confirmed_understanding(data.get("understanding"), row["idea"])
                idea = str(row["idea"] or "").strip()
                if not idea or len(idea) > 7000: return self.send(400, '{"error":"Isi ide (maks. 7.000 karakter) sebelum membuat konsep."}')
                if str(body.get("idea", "")).strip() != idea:
                    return self.send(409, '{"error":"Ide di layar berbeda dari ide yang tersimpan. Simpan proyek, lalu konfirmasi ulang pemahaman."}')
                goal = request_text(body, "goal", 100)
                duration = request_text(body, "duration", 50)
                style = request_text(body, "style", 100)
                assets = [item for item in (data.get("assets") or []) if isinstance(item, dict)]
                if body.get("include_images"):
                    if production_package.photo_consent_required(assets) and body.get("consent_photos") is not True:
                        return self.send(400, json.dumps({"error": "Foto orang hanya boleh dikirim ke Gemini setelah Anda menyetujuinya. Centang persetujuan terlebih dahulu."}, ensure_ascii=False))
                    return self.send(501, json.dumps({"error": "Pengiriman gambar ke Gemini belum tersedia pada tahap ini. Konsep dibuat dari ide dan daftar gambar yang diunggah saja."}, ensure_ascii=False))
                package = make_gemini_production(idea, goal, duration, style, limits, assets, production_package.project_details(data), understanding)
                return self.send(200, json.dumps({"package": package}, ensure_ascii=False))
            except production_package.ProductionPackageError as exc:
                return self.send(400, json.dumps({"error": str(exc)}, ensure_ascii=False))
            except GeminiProviderError as exc:
                return self.send(exc.status, json.dumps({"error": str(exc)}, ensure_ascii=False))
            except Exception:
                return self.send(502, '{"error":"Gemini tidak merespons dengan paket produksi yang valid. Coba lagi."}')
        if path == "/api/ai/story":
            try:
                body = self.payload()
                if body is None: return
                idea = str(body.get("idea", "")).strip()
                if not idea or len(idea) > 7000: return self.send(400, '{"error":"Isi ide (maks. 7.000 karakter) sebelum meminta draft."}')
                goal = request_text(body, "goal", 100)
                duration = request_text(body, "duration", 50, "1 menit")
                style = request_text(body, "style", 100)
                details = production_package.project_details(body)
                provider = str(body.get("provider", "ollama")).strip().lower()
                if provider == "gemini":
                    draft = make_gemini_story(idea, goal, duration, style, details)
                elif provider == "ollama":
                    draft = make_local_story(idea, goal, duration, style, str(body.get("model", "")), details)
                else:
                    return self.send(400, '{"error":"Provider AI tidak dikenal. Pilih Ollama atau Gemini."}')
                return self.send(200, json.dumps({"draft": draft}, ensure_ascii=False))
            except GeminiProviderError as exc:
                return self.send(exc.status, json.dumps({"error": str(exc)}, ensure_ascii=False))
            except ValueError as exc:
                return self.send(400, json.dumps({"error": str(exc)}, ensure_ascii=False))
            except Exception:
                return self.send(502, '{"error":"AI lokal tidak merespons dengan draft yang valid. Coba lagi atau gunakan kerangka manual."}')
        if path == "/api/projects":
            body = self.payload()
            if body is None: return
            ident = str(uuid.uuid4())
            data = normalize_production_data({"scenes": [], "assets": [], "notes": ""}, body)
            with connect() as db:
                db.execute("INSERT INTO projects(id,title,goal,idea,platform,status,data) VALUES(?,?,?,?,?,?,?)", (ident, body.get("title", "Proyek baru"), body.get("goal", "Konten media sosial"), body.get("idea", ""), body.get("platform", "flow"), "Draft", json.dumps(data, ensure_ascii=False)))
                row = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
            return self.send(201, json.dumps(project(row), ensure_ascii=False))
        if path.startswith("/api/projects/") and path.endswith("/video-results"):
            return self.save_video_result(path.split("/")[-2])
        if path.startswith("/api/projects/") and path.endswith("/assets"):
            ident = path.split("/")[-2]
            if not valid_project_id(ident): return self.send(400, INVALID_PROJECT_ID)
            filename = Path(self.headers.get("X-Filename", "referensi")).name
            content_type = self.headers.get("Content-Type", "application/octet-stream")
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except (TypeError, ValueError):
                return self.send(400, '{"error":"Ukuran unggahan tidak valid."}')
            if content_length <= 0: return self.send(400, '{"error":"File gambar kosong."}')
            if content_length > MAX_ASSET_BYTES: return self.send(413, '{"error":"Ukuran gambar maksimum 12 MB."}')
            raw = self.read_body(content_length) if hasattr(self, "read_body") else self.rfile.read(content_length)
            if len(raw) != content_length: return self.send(400, '{"error":"Unggahan gambar terpotong."}')
            try:
                _detected_type, suffix = validate_image(raw, content_type)
            except ValueError as exc:
                return self.send(415, json.dumps({"error": str(exc)}, ensure_ascii=False))
            saved = f"{ident}-{uuid.uuid4().hex}{suffix}"
            saved_path = UPLOADS / saved
            file_created = False
            try:
                with saved_path.open("xb") as output:
                    file_created = True
                    output.write(raw)
                with connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
                    if not row:
                        if file_created: saved_path.unlink(missing_ok=True)
                        return self.send(404, '{"error":"Proyek tidak ditemukan"}')
                    category = self.headers.get("X-Asset-Type", "Referensi umum")
                    if category not in {"Karakter", "Lokasi", "Produk", "Adegan", "Referensi umum"}: category = "Referensi umum"
                    asset = {"id": str(uuid.uuid4()), "name": filename[:200], "url": f"/uploads/{saved}", "type": category}
                    data = json.loads(row["data"]); data.setdefault("assets", []).append(asset)
                    db.execute("UPDATE projects SET data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (json.dumps(data, ensure_ascii=False), ident))
            except Exception:
                if file_created: saved_path.unlink(missing_ok=True)
                return self.send(500, '{"error":"Gagal menyimpan gambar ke proyek."}')
            return self.send(201, json.dumps({"name": filename, "url": f"/uploads/{saved}", "asset": asset}, ensure_ascii=False))
        return self.send(404, '{"error":"Endpoint tidak ditemukan"}')
    def save_video_result(self, ident):
        if not valid_project_id(ident): return self.send(400, INVALID_PROJECT_ID)
        filename =Path(self.headers.get("X-Filename", "hasil-video")).name[:200] or "hasil-video"
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        scene_id = self.headers.get("X-Scene-Id", "")
        note = unquote(self.headers.get("X-Result-Note", ""))
        if len(note) > MAX_RESULT_NOTE: return self.send(400, json.dumps({"error": "Catatan hasil maksimum 500 karakter."}, ensure_ascii=False))
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except (TypeError, ValueError):
            return self.send(400, '{"error":"Ukuran unggahan tidak valid."}')
        if length <= 0: return self.send(400, '{"error":"File video kosong."}')
        if content_type not in VIDEO_TYPES: return self.send(415, json.dumps({"error": "Format video harus MP4 atau WebM."}, ensure_ascii=False))
        if length > MAX_VIDEO_BYTES: return self.send(413, json.dumps({"error": "Ukuran video maksimum 50 MB."}, ensure_ascii=False))
        suffix, matches_format = VIDEO_TYPES[content_type]
        partial = UPLOADS / f".{ident}.partial-{uuid.uuid4().hex}"
        saved_path = UPLOADS / f"{ident}-{uuid.uuid4().hex}{suffix}"
        head, remaining = b"", length
        try:
            # Stream the body to disk in pieces so a large video never sits fully in memory.
            with partial.open("xb") as output:
                while remaining > 0:
                    chunk = self.rfile.read(min(VIDEO_CHUNK_BYTES, remaining))
                    if not chunk: break
                    if len(head) < 12: head += chunk[:12 - len(head)]
                    output.write(chunk)
                    remaining -= len(chunk)
        except OSError:
            partial.unlink(missing_ok=True)
            return self.send(500, '{"error":"Gagal menyimpan video. Tidak ada hasil yang tersimpan."}')
        if remaining:
            partial.unlink(missing_ok=True)
            return self.send(400, '{"error":"Unggahan video terpotong. Tidak ada hasil yang tersimpan."}')
        if not matches_format(head):
            partial.unlink(missing_ok=True)
            return self.send(415, json.dumps({"error": "Isi file tidak sesuai dengan format video yang dipilih."}, ensure_ascii=False))
        record, results = None, None
        try:
            with connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
                if not row: raise _NotFound()
                data = json.loads(row["data"])
                if not any(isinstance(scene, dict) and scene.get("id") == scene_id for scene in _as_list(data.get("scenes"))): raise _BadScene()
                partial.replace(saved_path)
                record = {"id": str(uuid.uuid4()), "sceneId": scene_id, "name": filename, "url": f"/uploads/{saved_path.name}", "type": content_type,
                          "size": length, "addedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "note": note, "status": "kandidat"}
                results = _as_list(data.get("videoResults")) + [record]
                data["videoResults"] = results
                db.execute("UPDATE projects SET data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (json.dumps(data, ensure_ascii=False), ident))
        except (_NotFound, _BadScene, Exception) as exc:
            partial.unlink(missing_ok=True)
            saved_path.unlink(missing_ok=True)
            if isinstance(exc, _NotFound): return self.send(404, '{"error":"Proyek tidak ditemukan"}')
            if isinstance(exc, _BadScene): return self.send(400, '{"error":"Adegan tidak ditemukan di proyek ini."}')
            return self.send(500, '{"error":"Gagal menyimpan hasil video. Tidak ada hasil yang tersimpan."}')
        return self.send(201, json.dumps({"result": record, "videoResults": results}, ensure_ascii=False))

    def update_video_result(self, ident, result_id):
        if not valid_project_id(ident): return self.send(400, INVALID_PROJECT_ID)
        body = self.payload()
        if body is None: return
        status, note = body.get("status"), body.get("note")
        if status is not None and status not in VIDEO_RESULT_STATUSES:
            return self.send(400, json.dumps({"error": "Status hasil harus kandidat, utama, atau revisi."}, ensure_ascii=False))
        if note is not None and (not isinstance(note, str) or len(note) > MAX_RESULT_NOTE):
            return self.send(400, json.dumps({"error": "Catatan hasil maksimum 500 karakter."}, ensure_ascii=False))
        try:
            with connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
                if not row: raise _NotFound()
                data = json.loads(row["data"])
                results = _as_list(data.get("videoResults"))
                target = next((item for item in results if isinstance(item, dict) and item.get("id") == result_id), None)
                if target is None: raise _NotFound()
                if status is not None:
                    if status == "utama":
                        # A result whose file is gone cannot be the main result: the saved state must match the files.
                        if not (UPLOADS / Path(str(target.get("url", ""))).name).is_file(): raise _MissingFile()
                        # One main result per scene: the previous main result becomes a candidate.
                        for item in results:
                            if isinstance(item, dict) and item is not target and item.get("sceneId") == target.get("sceneId") and item.get("status") == "utama":
                                item["status"] = "kandidat"
                    target["status"] = status
                if note is not None: target["note"] = note
                data["videoResults"] = results
                db.execute("UPDATE projects SET data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (json.dumps(data, ensure_ascii=False), ident))
        except _NotFound:
            return self.send(404, '{"error":"Hasil video tidak ditemukan"}')
        except _MissingFile:
            return self.send(400, '{"error":"File hasil tidak ditemukan, sehingga tidak bisa dijadikan hasil utama. Unggah ulang video."}')
        except sqlite3.Error:
            return self.send(500, '{"error":"Gagal menyimpan perubahan hasil. Data tidak berubah."}')
        return self.send(200, json.dumps({"result": target, "videoResults": results}, ensure_ascii=False))

    def save_production_package(self, ident):
        if not valid_project_id(ident): return self.send(400, INVALID_PROJECT_ID)
        body = self.payload()
        if body is None: return
        try:
            package = body.get("package")
            target = production_package.parse_stored_target(body.get("targetSeconds"))
            with connect() as db:
                # Read inside the write transaction so a video result committed meanwhile is not overwritten.
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
                if not row: return self.send(404, '{"error":"Proyek tidak ditemukan"}')
                data = json.loads(row["data"])
                data.pop("productionPackage", None)
                if package is not None:
                    assets = [item for item in data.get("assets") or [] if isinstance(item, dict)]
                    saved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    data["productionPackage"] = production_package.prepare_for_storage(package, assets, target, saved_at)
                db.execute("UPDATE projects SET data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (json.dumps(data, ensure_ascii=False), ident))
                saved = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
        except production_package.ProductionPackageError as exc:
            return self.send(400, json.dumps({"error": str(exc)}, ensure_ascii=False))
        except sqlite3.Error:
            return self.send(500, '{"error":"Gagal menyimpan paket produksi. Data proyek tidak berubah."}')
        return self.send(200, json.dumps(project(saved), ensure_ascii=False))
    def do_PUT(self):
        path = urlparse(self.path).path
        parts = path.split("/")
        if path.startswith("/api/projects/") and len(parts) == 6 and parts[4] == "video-results":
            return self.update_video_result(parts[3], parts[5])
        if path.startswith("/api/projects/") and path.endswith("/production-package"):
            return self.save_production_package(path.split("/")[-2])
        ident = path.split("/")[-1]
        if not valid_project_id(ident): return self.send(400, INVALID_PROJECT_ID)
        body = self.payload()
        if body is None: return
        try:
            data = normalize_production_data(body.get("data", {}), body)
        except ValueError as exc:
            return self.send(400, json.dumps({"error": str(exc)}, ensure_ascii=False))
        with connect() as db:
            # The stored data is read inside the write transaction: an upload committed after a plain read would be overwritten.
            db.execute("BEGIN IMMEDIATE")
            exists = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            if not exists: return self.send(404, '{"error":"Proyek tidak ditemukan"}')
            # Keep the stored package: autosave sends a whole snapshot that may be older than the saved package.
            data.pop("productionPackage", None)
            stored_data = json.loads(exists["data"])
            stored = stored_data.get("productionPackage")
            # Video results are owned by the server: autosave cannot add, remove, or overwrite them.
            data["videoResults"] = _as_list(stored_data.get("videoResults"))
            if stored is not None: data["productionPackage"] = stored
            db.execute("UPDATE projects SET title=?,goal=?,idea=?,platform=?,status=?,data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (body.get("title", "Proyek"), body.get("goal", ""), body.get("idea", ""), body.get("platform", "flow"), body.get("status", "Draft"), json.dumps(data, ensure_ascii=False), ident))
            row = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
        return self.send(200, json.dumps(project(row), ensure_ascii=False))
    def do_DELETE(self):
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        if len(parts) == 5 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "assets":
            ident, asset_id = parts[2], parts[4]
            if not valid_project_id(ident): return self.send(400, INVALID_PROJECT_ID)
            quarantine = None
            original_path = None
            old_data = None
            old_raw_data = None
            updated = None
            updated_raw_data = None
            response_body = None
            deletion_complete = False

            def file_state(candidate_path):
                try:
                    info = candidate_path.stat()
                except FileNotFoundError:
                    return "missing"
                return "file" if stat.S_ISREG(info.st_mode) else "other"

            def write_raw_data(value, expected_raw=None):
                with connect() as db:
                    if expected_raw is None:
                        result = db.execute("UPDATE projects SET data=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                                            (value, ident))
                    else:
                        result = db.execute(
                            "UPDATE projects SET data=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND data=?",
                            (value, ident, expected_raw),
                        )
                    if result.rowcount != 1:
                        raise RuntimeError("Proyek berubah bersamaan; metadata aset tidak ditimpa.")

            def read_raw_data():
                with connect() as db:
                    row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
                return row["data"] if row else None

            def read_data():
                raw = read_raw_data()
                return json.loads(raw) if raw is not None else None

            def prepare_response():
                with connect() as db:
                    row = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
                if not row:
                    raise RuntimeError("Proyek tidak ditemukan setelah perubahan aset.")
                return json.dumps({"assetId": asset_id, "project": project(row)}, ensure_ascii=False)

            def failure_response(message):
                return self.send(500, json.dumps({"error": message}, ensure_ascii=False))

            def rollback(error):
                if original_path is None:
                    return failure_response(
                        f"Penghapusan gagal sebelum operasi filesystem dimulai ({error}); "
                        "tidak ada pemulihan file yang diklaim. Data aset tidak diubah oleh penghapusan ini."
                    )
                try:
                    source_state = file_state(original_path)
                    quarantine_state = file_state(quarantine) if quarantine else "missing"
                except OSError as inspect_error:
                    return failure_response(
                        f"Operasi penghapusan gagal ({error}); keadaan file tidak dapat diperiksa ({inspect_error}). "
                        "Konsistensi belum dapat diverifikasi; jangan ulangi penghapusan sebelum pemeriksaan manual."
                    )

                restore_error = None
                if source_state == "missing" and quarantine_state == "file":
                    try:
                        os.replace(quarantine, original_path)
                    except OSError as exc:
                        restore_error = exc
                    try:
                        source_state = file_state(original_path)
                        quarantine_state = file_state(quarantine)
                    except OSError as inspect_error:
                        return failure_response(
                            f"Operasi penghapusan gagal ({error}); pemulihan file tidak dapat diverifikasi "
                            f"({restore_error or inspect_error}). Metadata tidak dipulihkan. Perlu pemeriksaan manual."
                        )

                if source_state == "file" and quarantine_state == "missing":
                    metadata_restore_error = None
                    try:
                        current_raw = read_raw_data()
                    except Exception as exc:
                        return failure_response(
                            f"File aset tersedia di lokasi asal, tetapi metadata tidak dapat dibaca ({exc}); "
                            "rollback belum terverifikasi. Perlu pemeriksaan manual."
                        )
                    if current_raw == updated_raw_data:
                        try:
                            write_raw_data(old_raw_data, updated_raw_data)
                            current_raw = read_raw_data()
                        except Exception as exc:
                            metadata_restore_error = exc
                            try:
                                current_raw = read_raw_data()
                            except Exception as inspect_error:
                                return failure_response(
                                    f"File aset tersedia, tetapi pemulihan metadata gagal ({exc}) dan "
                                    f"keadaan database tidak dapat diverifikasi ({inspect_error}). Perlu pemeriksaan manual."
                                )
                    if current_raw == old_raw_data:
                        return failure_response(f"Penghapusan gagal; file dan metadata lama terverifikasi. ({error})")
                    if metadata_restore_error:
                        return failure_response(
                            f"File aset tersedia di lokasi asal, tetapi pemulihan metadata database gagal "
                            f"({metadata_restore_error}). Metadata terbaru tidak ditimpa; konsistensi perlu diperiksa manual."
                        )
                    return failure_response(
                        "File aset tersedia di lokasi asal, tetapi metadata proyek berubah bersamaan atau "
                        "berbeda dari snapshot penghapusan. Perubahan database tidak ditimpa; "
                        "konsistensi perlu diperiksa manual."
                    )

                if source_state == "missing" and quarantine_state == "missing":
                    # The physical file is confirmed absent; clear its stale asset and scene links.
                    try:
                        current_raw = read_raw_data()
                    except Exception as exc:
                        return failure_response(
                            f"File aset sudah tidak ada, tetapi metadata tidak dapat dibaca ({exc}). "
                            "Status proyek perlu diperiksa manual."
                        )
                    if current_raw == old_raw_data:
                        try:
                            write_raw_data(updated_raw_data, old_raw_data)
                            current_raw = read_raw_data()
                        except Exception as exc:
                            try:
                                current_raw = read_raw_data()
                            except Exception as inspect_error:
                                return failure_response(
                                    f"File aset sudah tidak ada, tetapi pembersihan metadata gagal ({exc}) "
                                    f"dan keadaan database tidak dapat diverifikasi ({inspect_error})."
                                )
                    if current_raw == updated_raw_data:
                        try:
                            return self.send(200, prepare_response())
                        except Exception as exc:
                            return failure_response(
                                f"Metadata aset yang sudah tidak memiliki file berhasil dibersihkan, "
                                f"tetapi respons proyek gagal disiapkan ({exc})."
                            )
                    return failure_response(
                        "File aset sudah tidak ada, tetapi metadata proyek berubah bersamaan dan tidak ditimpa. "
                        "Periksa kemungkinan referensi aset yang sudah tidak tersedia."
                    )

                try:
                    current_data = read_data()
                except Exception as inspect_error:
                    current_data = None
                    restore_error = restore_error or inspect_error
                if source_state == "missing" and quarantine_state == "file":
                    detail = "File tetap berada di karantina dan pemulihan ke lokasi asal gagal."
                elif source_state == "file" and quarantine_state == "file":
                    detail = "File sumber dan karantina sama-sama ada; keduanya dipertahankan."
                else:
                    detail = f"Keadaan file tidak dikenal (sumber: {source_state}, karantina: {quarantine_state})."
                if current_data == old_data:
                    detail += " Metadata lama masih tersimpan."
                elif current_data == updated:
                    detail += " Metadata sudah melepas aset dan referensinya."
                else:
                    detail += " Metadata berubah bersamaan atau statusnya tidak dapat diverifikasi; tidak ditimpa."
                if restore_error:
                    detail += f" Detail pemulihan: {restore_error}."
                return failure_response(f"Penghapusan gagal. {detail} Perlu pemeriksaan manual.")

            try:
                with connect() as db:
                    row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
                    if not row:
                        return self.send(404, '{"error":"Proyek tidak ditemukan"}')
                    old_raw_data = row["data"]
                    old_data = json.loads(old_raw_data)
                    assets = _as_list(old_data.get("assets"))
                    asset = next((item for item in assets if isinstance(item, dict) and item.get("id") == asset_id), None)
                    if not asset:
                        return self.send(404, '{"error":"Aset tidak ditemukan"}')

                    asset_url = urlparse(str(asset.get("url", ""))).path
                    filename = Path(asset_url).name
                    upload_root = UPLOADS.resolve()
                    candidate = UPLOADS / filename
                    resolved = candidate.resolve(strict=False)
                    if (not filename or filename in {".", ".."} or candidate.is_symlink()
                            or resolved.parent != upload_root or not filename.startswith(f"{ident}-")):
                        return self.send(400, '{"error":"Lokasi file aset tidak aman; aset tidak dihapus."}')
                    original_path = candidate
                    updated = copy.deepcopy(old_data)
                    updated["assets"] = [item for item in assets if not isinstance(item, dict) or item.get("id") != asset_id]
                    updated["checks"] = dict(updated.get("checks") or {})
                    for scene in _as_list(updated.get("scenes")):
                        if not isinstance(scene, dict):
                            continue
                        scene_id = str(scene.get("id", ""))
                        linked = asset_id in _as_list(scene.get("assetIds")) or asset_id in _as_list(scene.get("referenceAssetIds"))
                        for key in ("assetIds", "referenceAssetIds"):
                            scene[key] = [value for value in _as_list(scene.get(key)) if value != asset_id]
                        if linked:
                            checklist = dict(scene.get("productionChecklist") or {})
                            checklist["assets"] = bool(scene["referenceAssetIds"])
                            scene["productionChecklist"] = checklist
                            scene["productionStatus"] = ("collected" if checklist.get("collected") else
                                "in_progress" if checklist.get("generated") else
                                "prompt_ready" if checklist.get("prompt") else
                                "references_ready" if checklist.get("assets") else "Draft")
                            scene["production"] = scene["productionStatus"]
                            updated["checks"][f"scene-{scene_id}-assets"] = checklist["assets"]
                    updated_raw_data = json.dumps(updated, ensure_ascii=False)

                source_state = file_state(candidate)
                if source_state == "other":
                    return self.send(400, '{"error":"File aset bukan file biasa; metadata tidak diubah."}')
                if source_state == "missing":
                    # The missing file is confirmed; remove its stale metadata without touching other uploads.
                    write_raw_data(updated_raw_data, old_raw_data)
                    deletion_complete = True
                    response_body = prepare_response()
                else:
                    quarantine = UPLOADS / f".{ident}.deleting-{uuid.uuid4().hex}"
                    try:
                        os.replace(candidate, quarantine)
                    except OSError as move_error:
                        source_state = file_state(candidate)
                        quarantine_state = file_state(quarantine)
                        if source_state == "file" and quarantine_state == "missing":
                            return failure_response(f"File aset tidak dapat dipindahkan; metadata tidak diubah. ({move_error})")
                        if source_state == "missing" and quarantine_state == "missing":
                            write_raw_data(updated_raw_data, old_raw_data)
                            deletion_complete = True
                            response_body = prepare_response()
                        elif source_state == "missing" and quarantine_state == "file":
                            pass  # The move completed despite the reported filesystem error.
                        else:
                            raise RuntimeError(
                                f"Pemindahan file gagal ({move_error}); sumber/karantina tidak dapat dipastikan aman."
                            ) from move_error

                    if not deletion_complete:
                        source_state = file_state(candidate)
                        quarantine_state = file_state(quarantine)
                        if source_state == "missing" and quarantine_state == "missing":
                            write_raw_data(updated_raw_data, old_raw_data)
                            deletion_complete = True
                            response_body = prepare_response()
                        elif source_state != "missing" or quarantine_state != "file":
                            raise RuntimeError(
                                f"Verifikasi pemindahan gagal (sumber: {source_state}, karantina: {quarantine_state}); "
                                "metadata aset belum diubah."
                            )

                    if not deletion_complete:
                        with connect() as db:
                            result = db.execute(
                                "UPDATE projects SET data=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND data=?",
                                (updated_raw_data, ident, old_raw_data),
                            )
                            if result.rowcount != 1:
                                raise RuntimeError("Proyek berubah bersamaan; penghapusan dibatalkan tanpa menimpa perubahan terbaru.")
                            saved_row = db.execute("SELECT * FROM projects WHERE id=?", (ident,)).fetchone()
                        response_body = json.dumps({"assetId": asset_id, "project": project(saved_row)}, ensure_ascii=False)
                        try:
                            quarantine.unlink()
                        except FileNotFoundError:
                            source_state = file_state(candidate)
                            quarantine_state = file_state(quarantine)
                            if source_state != "missing" or quarantine_state != "missing":
                                raise RuntimeError(
                                    f"File karantina hilang, tetapi keadaan sumber tidak aman "
                                    f"(sumber: {source_state}, karantina: {quarantine_state})."
                                )
                        deletion_complete = True
            except Exception as error:
                if deletion_complete:
                    return failure_response(
                        f"Penghapusan aset sudah tercatat, tetapi respons proyek gagal disiapkan. ({error})"
                    )
                return rollback(error)

            if deletion_complete:
                # Response failures happen after deletion is committed and must not
                # restore metadata for an asset whose file is gone.
                return self.send(200, response_body)

        segments = path.split("/")
        if len(segments) != 4 or segments[1:3] != ["api", "projects"]:
            return self.send(404, '{"error":"Endpoint tidak ditemukan"}')
        ident = segments[3]
        if not valid_project_id(ident): return self.send(400, INVALID_PROJECT_ID)
        with connect() as db:
            deleted = db.execute("DELETE FROM projects WHERE id=?", (ident,)).rowcount
        if deleted != 1: return self.send(404, '{"error":"Proyek tidak ditemukan"}')
        # Files go only after the project row is gone. The id is a validated UUID, so these patterns match this project alone.
        for file in UPLOADS.glob(f"{ident}-*"): file.unlink(missing_ok=True)
        for file in UPLOADS.glob(f".{ident}.partial-*"): file.unlink(missing_ok=True)
        return self.send(204, "")

if __name__ == "__main__":
    init_db()
    print("AI Video Studio berjalan di http://127.0.0.1:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
