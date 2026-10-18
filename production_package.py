"""Planning and validation for production packages made by Gemini.

This module is pure logic: it builds the prompts, checks the structure returned by the model,
and derives the upload checklist. It does not make network calls or read files.

Image links are stored as a mapping {requirement_id: asset_id}. An empty mapping means
every requirement still needs an image. Nothing in this module generates images.
"""
import json
import re
from math import isfinite

MAX_CLIPS = 30
MAX_CONCEPT_CHARS = 1500
MAX_PROMPT_CHARS = 3000
MAX_TEXT_CHARS = 800
MAX_NAME_CHARS = 120
MAX_ID_CHARS = 64
MAX_DETAIL_CHARS = 2000
MAX_UNDERSTANDING_ITEMS = 40
MAX_UNDERSTANDING_ITEM_CHARS = 300
MAX_QUESTIONS = 3
# Styles the AI may recommend. Matches the style choices offered in the app, minus the 'let me decide later' option.
RECOMMENDABLE_STYLES = ("Sinematik natural", "Animasi 3D", "Ilustrasi hangat", "Dokumenter", "Iklan bersih")
REFERENCE_ROLES = ("karakter", "produk", "lokasi", "gaya", "bingkai_awal")
AUDIO_PLANS = ("tanpa_audio", "dialog", "narasi", "musik", "efek")
ASSET_TYPES = ("Karakter", "Lokasi", "Produk", "Adegan", "Referensi umum")
# Asset types whose photos may show people. Products and locations are not treated as personal photos.
CONSENT_FREE_ASSET_TYPES = ("Produk", "Lokasi")
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
FENCE_PATTERN = re.compile(r"^\s*```(?:json|JSON)?[ \t]*\r?\n?(.*?)\r?\n?\s*```\s*$", re.DOTALL)
DEFAULT_MODEL_KEY = "flow-default"
VIDEO_MODELS = {
    # Starting configuration for Google Flow. The limits are not verified against the live product,
    # so the package always carries a warning until they are checked.
    "flow-default": {"label": "Google Flow (konfigurasi awal)", "max_clip_seconds": 10, "max_references": 3, "verified": False},
}
# English counterparts of the clip fields that are copied into the prompt text.
EN_DETAIL_KEYS = ("action", "camera", "lighting", "audio_text")
# Fields the user types on the Ide form. They are sent to Gemini as they are.
DETAIL_FIELDS = (("message", "Pesan utama"), ("character", "Tokoh dan tampilannya"), ("world", "Lokasi dan suasana"))
UNDERSTANDING_LISTS = ("characters", "locations", "sequence", "unclear", "suggestions")
# Plan lists the user reviews before confirming. Stored under camelCase keys.
PLAN_LISTS = (("camera", "camera"), ("assets_needed", "assetsNeeded"))

FIDELITY_RULES = (
    "Aturan kesetiaan (wajib dipatuhi):\n"
    "- Pertahankan inti cerita dan pesan utama dari ide pengguna. Jangan menggantinya dengan pesan lain.\n"
    "- Pertahankan hubungan antartokoh seperti yang ditulis pengguna.\n"
    "- Pertahankan urutan kejadian penting seperti yang ditulis pengguna.\n"
    "- Gunakan tokoh dan lokasi yang ditentukan pengguna apa adanya: nama, peran, dan ciri visualnya.\n"
    "- Jangan mengubah konflik atau akhir cerita dari ide pengguna. Jika ide tidak menyebut akhir cerita, jangan mengarangnya.\n"
    "- Jangan membuang adegan penting hanya untuk mempersingkat hasil. Pecah menjadi klip yang berkesinambungan bila perlu.\n"
    "- Jangan mengarang nilai untuk detail yang tidak diisi pengguna.\n"
)


class ProductionPackageError(ValueError):
    """Raised when a package or request does not meet the production rules. The message is shown to the user."""


def model_limits(model_key=DEFAULT_MODEL_KEY):
    key = str(model_key or DEFAULT_MODEL_KEY).strip()[:64]
    if key not in VIDEO_MODELS:
        raise ProductionPackageError(f"Model video belum dikenal: {key}.")
    return {"key": key, **VIDEO_MODELS[key]}


def parse_target_seconds(text):
    """Turn a target such as '60 detik' or '1 menit' into seconds. Returns None when unknown."""
    match = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*(detik|det|s|sec|seconds?|menit|mnt|min|minutes?)?\s*$", str(text or "").lower())
    if not match:
        return None
    amount = float(match.group(1).replace(",", "."))
    unit = match.group(2) or "detik"
    seconds = amount * 60 if unit in ("menit", "mnt", "min", "minute", "minutes") else amount
    return round(seconds) if seconds > 0 else None


def strip_json_fence(text):
    """Remove a single Markdown code fence around JSON. Text without a fence is returned trimmed."""
    text = text or ""
    match = FENCE_PATTERN.match(text)
    return (match.group(1) if match else text).strip()


def example_package(max_clip_seconds=10):
    return {
        "concept": "Ringkasan singkat konsep video dalam satu paragraf.",
        "characters": [{
            "id": "char-1", "name": "Nama karakter", "role": "peran dalam cerita",
            "appearance": "ciri wajah, rambut, dan pakaian yang tetap", "appearance_en": "English version of the appearance above",
        }],
        "products": [],
        "locations": [{
            "id": "loc-1", "name": "Nama lokasi", "description": "suasana dan elemen visual yang tetap",
            "description_en": "English version of the description above",
        }],
        "image_requirements": [{"id": "img-1", "purpose": "karakter", "subject": "char-1", "description": "gambar acuan wajah dan pakaian karakter"}],
        "clips": [{
            "index": 1,
            "duration_seconds": max_clip_seconds,
            "characters": ["char-1"],
            "locations": ["loc-1"],
            "references": [{"requirement_id": "img-1", "role": "karakter"}],
            "action": "Aksi utama klip ini",
            "camera": "Framing dan gerakan kamera",
            "lighting": "Pencahayaan dan suasana",
            "audio": {"plan": "dialog", "text": "Dialog atau narasi singkat", "note": "Catatan audio untuk klip ini"},
            "continues_from": None,
            "prompt_final": "Prompt lengkap untuk satu klip ini dalam Bahasa Indonesia.",
            "prompt_en": "Complete prompt for this clip in English, with the same meaning as prompt_final.",
            "en": {
                "action": "English version of the action",
                "camera": "English version of the camera",
                "lighting": "English version of the lighting",
                "audio_text": "English version of the audio text",
            },
        }],
    }


def _one_line(value, limit=200):
    """Collapse whitespace so a value cannot start a new line in the prompt."""
    return " ".join(str(value or "").split())[:limit]


def _flat(value):
    """Collapse whitespace without cutting anything. Used for text that must reach the prompt in full."""
    return " ".join(str(value or "").split())


def _asset_type(asset):
    value = asset.get("type")
    return value if value in ASSET_TYPES else "Referensi umum"


def _safe_asset_id(value):
    text = str(value or "")
    return text if ID_PATTERN.match(text) else None


def _text(value, field, limit, required=True):
    if value is None:
        if required:
            raise ProductionPackageError(f"{field} wajib diisi.")
        return ""
    if not isinstance(value, str):
        raise ProductionPackageError(f"{field} harus berupa teks.")
    text = value.strip()
    if required and not text:
        raise ProductionPackageError(f"{field} wajib diisi.")
    if len(text) > limit:
        raise ProductionPackageError(f"{field} terlalu panjang (maks. {limit} karakter). Ringkas teksnya.")
    return text


def _entity_detail(item, field):
    """Keep only the filled, named fields of a character or location. Returns None for an entry without a name."""
    if not isinstance(item, dict):
        raise ProductionPackageError(f"Data {field} harus berupa objek.")
    cleaned = {}
    for key in ("name", "role", "appearance", "description", "appearance_en", "description_en"):
        value = _text(item.get(key), f"{key.replace('_', ' ').capitalize()} {field}", MAX_TEXT_CHARS, required=False)
        if value:
            cleaned[key] = value
    return cleaned if cleaned.get("name") else None


def project_details(source):
    """What the user typed and already saved: the Ide form fields and the project's characters and locations.

    Empty fields are left out. Nothing is filled in on the user's behalf.
    """
    if not isinstance(source, dict):
        raise ProductionPackageError("Data detail harus berupa objek.")
    details = {}
    for key, _label in DETAIL_FIELDS:
        value = _text(source.get(key), f"Isian {key}", MAX_DETAIL_CHARS, required=False)
        if value:
            details[key] = value
    entities = source.get("entities")
    entities = entities if isinstance(entities, dict) else {}
    for kind in ("characters", "locations"):
        items = []
        for item in _list(entities.get(kind), f"Daftar {kind}"):
            cleaned = _entity_detail(item, kind)
            if cleaned:
                items.append(cleaned)
        if len(items) > MAX_UNDERSTANDING_ITEMS:
            raise ProductionPackageError(f"Daftar {kind} memuat {len(items)} butir; maksimal {MAX_UNDERSTANDING_ITEMS}.")
        if items:
            details[kind] = items
    return details


def _entity_line(item):
    head = item["name"] + (f" ({_flat(item['role'])})" if item.get("role") else "")
    notes = [_flat(item[key]) for key in ("appearance", "description") if item.get(key)]
    return head + (": " + "; ".join(notes) if notes else "")


def details_block(details):
    """Lines describing what the user typed. Only filled fields appear, so nothing empty is shown to be filled in."""
    lines = []
    for key, label in DETAIL_FIELDS:
        if details.get(key):
            lines.append(f"- {label}: {_flat(details[key])}")
    for kind, label in (("characters", "Tokoh yang sudah ditentukan"), ("locations", "Lokasi yang sudah ditentukan")):
        items = details.get(kind) or []
        if items:
            lines.append(f"- {label}:")
            lines.extend(f"  - {_entity_line(item)}" for item in items)
    if not lines:
        return "Detail dari pengguna: belum ada yang diisi. Jangan mengarang tokoh atau lokasi khusus.\n"
    return "Detail yang sudah diisi pengguna (wajib dipakai apa adanya):\n" + "\n".join(lines) + "\n"


def understanding_block(understanding):
    """Only the user's own summary and the AI suggestions the user accepted. Suggestions that were not accepted are never sent."""
    decisions = {
        "core": understanding.get("core", ""),
        "message": understanding.get("message", ""),
        "characters": understanding.get("characters", []),
        "locations": understanding.get("locations", []),
        "sequence": understanding.get("sequence", []),
        "unclear": understanding.get("unclear", []),
        "goal": understanding.get("goal", ""),
        "camera": understanding.get("camera", []),
        "assets_needed": understanding.get("assetsNeeded", []),
        "accepted_suggestions": understanding.get("acceptedSuggestions", []),
    }
    return (
        "Pemahaman ide yang sudah dikonfirmasi pengguna (sumber utama, wajib diikuti). "
        "Hanya 'accepted_suggestions' yang boleh dipakai sebagai tambahan kreatif; jangan menambah tambahan lain. "
        "Untuk butir di 'unclear', pilih asumsi paling netral dan tulis asumsi itu di 'concept':\n"
        + json.dumps(decisions, ensure_ascii=False, indent=2)
        + "\n"
    )


def _asset_lines(assets):
    lines = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        asset_id = _safe_asset_id(asset.get("id"))
        if asset_id:
            lines.append(f"- id: {asset_id} | jenis: {_asset_type(asset)}")
    return lines or ["- (belum ada gambar yang diunggah)"]


UNDERSTANDING_EXAMPLE = {
    "core": "inti cerita dalam dua kalimat",
    "message": "pesan utama yang ingin disampaikan",
    "characters": ["Nama — peran: hubungan dengan tokoh lain"],
    "locations": ["Nama lokasi — suasana"],
    "sequence": ["1. kejadian pertama", "2. kejadian berikutnya"],
    "unclear": ["hal yang belum jelas dan perlu keputusan pengguna"],
    "suggestions": ["tambahan kreatif yang tidak ada di ide atau detail pengguna"],
    "goal": "tujuan video dalam satu kalimat",
    "recommended_style": "satu gaya dari daftar: " + ", ".join(RECOMMENDABLE_STYLES),
    "camera": ["saran sudut dan gerak kamera yang cocok"],
    "assets_needed": ["gambar yang sebaiknya diunggah, misalnya wajah tokoh atau produk"],
    "questions": [],
}


def understanding_prompt(idea, goal, duration, style, details, answers=""):
    """Ask only for a summary of what the user meant. No package, clip, or prompt is requested here."""
    return (
        "Tugas Anda hanya memahami ide pengguna. Jangan membuat paket produksi, klip, atau prompt.\n"
        + FIDELITY_RULES
        + "Isi 'core', 'message', 'characters', 'locations', dan 'sequence' hanya dari ide atau detail pengguna. "
        "Tambahan kreatif Anda hanya boleh masuk ke 'suggestions'. Hal yang tidak disebut pengguna, misalnya akhir cerita, masuk ke 'unclear'.\n"
        "Tulis semua isi dalam bahasa Indonesia. Jawab HANYA dengan JSON valid mengikuti struktur contoh ini:\n"
        + json.dumps(UNDERSTANDING_EXAMPLE, ensure_ascii=False, indent=2)
        + f"\n\nJenis video: {_flat(goal) or 'belum ditentukan'}\n"
        + f"Durasi target: {_flat(duration) or 'belum ditentukan'}\n"
        + f"Gaya visual: {_flat(style) or 'belum ditentukan'}\n"
        + f"Ide pengguna: {idea}\n"
        + details_block(details)
        + "Rencana: isi 'goal', 'recommended_style', 'camera', dan 'assets_needed' sebagai saran yang masih bisa diubah pengguna. "
        "Jika informasi penting untuk membuat rencana benar-benar kurang (misalnya tokoh utama atau produk), isi 'questions' dengan paling banyak "
        f"{MAX_QUESTIONS} pertanyaan singkat dalam bahasa Indonesia. Jika cukup, biarkan 'questions' kosong dan jangan bertanya.\n"
        + (f"Jawaban pengguna atas pertanyaan sebelumnya (sumber utama, wajib dipakai):\n{answers.strip()}\n" if answers.strip() else "")
    )


def validate_understanding(raw):
    """Check a summary from Gemini or the user's correction. Nothing is cut: an over-long item is rejected."""
    if not isinstance(raw, dict):
        raise ProductionPackageError("Pemahaman ide harus berupa objek JSON.")
    normalized = {
        "core": _text(raw.get("core"), "Inti cerita", MAX_CONCEPT_CHARS),
        "message": _text(raw.get("message"), "Pesan utama", MAX_TEXT_CHARS, required=False),
    }
    normalized["goal"] = _text(raw.get("goal"), "Tujuan video", MAX_TEXT_CHARS, required=False)
    style = _text(raw.get("recommended_style"), "Gaya rekomendasi", 100, required=False)
    # An unknown style is dropped, not guessed. The user can still pick any style in the form.
    normalized["recommendedStyle"] = style if style in RECOMMENDABLE_STYLES else ""
    for raw_key, key in PLAN_LISTS:
        items = _list(raw.get(raw_key), f"Bagian {raw_key}")
        if len(items) > MAX_UNDERSTANDING_ITEMS:
            raise ProductionPackageError(f"Bagian {raw_key} memuat {len(items)} butir; maksimal {MAX_UNDERSTANDING_ITEMS}. Ringkas dahulu.")
        normalized[key] = [_text(item, f"Butir {raw_key} nomor {position}", MAX_UNDERSTANDING_ITEM_CHARS) for position, item in enumerate(items, 1)]
    questions = _list(raw.get("questions"), "Pertanyaan")
    if len(questions) > MAX_QUESTIONS:
        raise ProductionPackageError(f"Pertanyaan memuat {len(questions)} butir; maksimal {MAX_QUESTIONS}. Ringkas dahulu.")
    normalized["questions"] = [_text(item, f"Pertanyaan nomor {position}", MAX_UNDERSTANDING_ITEM_CHARS) for position, item in enumerate(questions, 1)]
    for key in UNDERSTANDING_LISTS:
        items = _list(raw.get(key), f"Bagian {key}")
        if len(items) > MAX_UNDERSTANDING_ITEMS:
            raise ProductionPackageError(f"Bagian {key} memuat {len(items)} butir; maksimal {MAX_UNDERSTANDING_ITEMS}. Ringkas dahulu.")
        normalized[key] = [_text(item, f"Butir {key} nomor {position}", MAX_UNDERSTANDING_ITEM_CHARS) for position, item in enumerate(items, 1)]
    # An accepted suggestion must be one of the AI's suggestions. The user decides which ones become binding.
    accepted = _list(raw.get("acceptedSuggestions"), "Usulan yang disetujui")
    normalized["acceptedSuggestions"] = []
    for position, item in enumerate(accepted, 1):
        text = _text(item, f"Usulan disetujui nomor {position}", MAX_UNDERSTANDING_ITEM_CHARS)
        if text not in normalized["suggestions"]:
            raise ProductionPackageError("Usulan yang disetujui harus berasal dari daftar usulan AI.")
        normalized["acceptedSuggestions"].append(text)
    return normalized


def confirmed_understanding(stored, stored_idea):
    """The summary the user confirmed. A package is only made from a confirmed summary of the current idea."""
    if not isinstance(stored, dict) or stored.get("status") != "confirmed":
        raise ProductionPackageError("Konfirmasi pemahaman ide terlebih dahulu sebelum membuat paket produksi.")
    if stored.get("ideaAtConfirm") != stored_idea:
        raise ProductionPackageError("Ide sudah berubah sejak pemahaman dikonfirmasi. Periksa dan konfirmasi ulang pemahaman.")
    return validate_understanding(stored)


def package_prompt(idea, goal, duration, style, assets, limits, details=None, understanding=None):
    """Build the prompt. Uploaded assets contribute only their id and type, never their file name."""
    example = json.dumps(example_package(limits["max_clip_seconds"]), ensure_ascii=False, indent=2)
    return (
        "Anda adalah sutradara dan perencana produksi video AI. Susun paket produksi dari pemahaman ide yang sudah dikonfirmasi pengguna. "
        "Anda boleh menyusun urutan klip, tetapi tidak boleh mengubah inti, pesan utama, tokoh, hubungan antartokoh, atau urutan kejadian yang sudah dikonfirmasi.\n"
        + FIDELITY_RULES
        + f"Batas durasi setiap klip adalah {limits['max_clip_seconds']} detik. Jumlah durasi semua klip harus mendekati durasi target. "
        "Pecah adegan yang lebih panjang menjadi beberapa klip yang berkesinambungan.\n"
        f"Setiap klip memakai paling banyak {limits['max_references']} referensi. Untuk referensi, pilih asset_id dari daftar gambar "
        "yang diunggah pengguna, atau buat image_requirements baru bila gambar perlu dibuat atau diunggah. Jangan menyebut gambar "
        "yang tidak ada di daftar atau di image_requirements.\n"
        "Untuk setiap klip tulis dua prompt: prompt_final dalam Bahasa Indonesia dan prompt_en dalam Bahasa Inggris. "
        "Keduanya harus memuat isi dan maksud yang sama: karakter dan tampilannya, aksi dan ekspresi, lokasi dan suasana, "
        "kamera, pencahayaan, audio atau dialog, dan kesinambungan dengan klip sebelumnya. Setiap prompt hanya menggambarkan satu klip.\n"
        "Isi field en dengan versi Inggris dari action, camera, lighting, dan audio.text. Field lain ditulis dalam Bahasa Indonesia.\n"
        "Jawab HANYA dengan JSON valid mengikuti struktur contoh ini.\n"
        f"{example}\n\n"
        f"Jenis video dari pengguna: {_flat(goal) or 'biarkan Gemini memutuskan'}\n"
        f"Durasi target: {_flat(duration) or 'biarkan Gemini memutuskan'}\n"
        f"Gaya visual: {_flat(style) or 'biarkan Gemini memutuskan'}\n"
        f"Ide pengguna: {idea}\n"
        + (understanding_block(understanding) if understanding else "")
        + details_block(details or {})
        + "Gambar yang diunggah pengguna (hanya id dan jenis):\n" + "\n".join(_asset_lines(assets))
    )


def photo_consent_required(assets):
    """Any upload that is not a product or location photo may show a person, so it needs explicit consent first."""
    return any(_asset_type(asset) not in CONSENT_FREE_ASSET_TYPES for asset in assets if isinstance(asset, dict))


def _safe_id(value, field):
    text = _text(value, field, MAX_ID_CHARS)
    if not ID_PATTERN.match(text):
        raise ProductionPackageError(f"{field} hanya boleh berisi huruf, angka, tanda hubung, atau garis bawah.")
    return text


def _list(value, field):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ProductionPackageError(f"{field} harus berupa daftar.")
    return value


def _dict(value, field):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ProductionPackageError(f"{field} harus berupa objek.")
    return value


def _seconds(value, field):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or value <= 0:
        raise ProductionPackageError(f"{field}: durasi harus angka positif.")
    return value


def _entities(raw_items, field, prefix):
    items = []
    seen = set()
    for position, item in enumerate(_list(raw_items, field), 1):
        if not isinstance(item, dict):
            raise ProductionPackageError(f"{field} nomor {position} harus berupa objek.")
        entity_id = _safe_id(item.get("id") or f"{prefix}-{position}", f"ID {field} nomor {position}")
        if entity_id in seen:
            raise ProductionPackageError(f"ID {field} '{entity_id}' dipakai lebih dari sekali.")
        seen.add(entity_id)
        name = _text(item.get("name"), f"Nama {field} nomor {position}", MAX_NAME_CHARS)
        entity = {"id": entity_id, "name": name}
        for key, limit in (("role", MAX_NAME_CHARS), ("appearance", MAX_TEXT_CHARS), ("description", MAX_TEXT_CHARS),
                           ("appearance_en", MAX_TEXT_CHARS), ("description_en", MAX_TEXT_CHARS)):
            if key in item:
                entity[key] = _text(item[key], f"{key.replace('_', ' ').capitalize()} {name}", limit, required=False)
        items.append(entity)
    return items


def _requirement_status(requirement_id, links):
    return "uploaded" if links.get(requirement_id) else "needed"


def build_upload_checklist(clips, asset_by_id, requirements, links):
    """Upload order follows the first clip that uses each reference. Gemini never decides the order itself."""
    seen = set()
    checklist = []
    for clip in clips:
        for ref in clip["references"]:
            key = (ref["kind"], ref["id"])
            if key in seen:
                continue
            seen.add(key)
            if ref["kind"] == "asset":
                name = asset_by_id[ref["id"]].get("name") or "Gambar"
                status = "uploaded"
            else:
                requirement = requirements[ref["id"]]
                name = requirement["purpose"]
                status = _requirement_status(requirement["id"], links)
            checklist.append({
                "order": len(checklist) + 1,
                "kind": ref["kind"],
                "id": ref["id"],
                "name": name,
                "role": ref["role"],
                "first_clip": clip["index"],
                "status": status,
            })
    return checklist


def validate_package(raw, assets, limits, target_seconds=None, links=None, require_english=False):
    """Check a package returned by Gemini and return a normalized copy. Raises ProductionPackageError on any rule violation.

    `assets` is the project's upload list. `links` maps requirement ids to asset ids and is optional.
    `require_english` is set for packages made now: every clip must then carry a prompt_en.
    Packages saved before English prompts existed are still read with require_english left False.
    """
    if not isinstance(raw, dict):
        raise ProductionPackageError("Paket produksi harus berupa objek JSON.")
    concept = _text(raw.get("concept"), "Konsep", MAX_CONCEPT_CHARS)
    asset_by_id = {}
    for asset in assets:
        if isinstance(asset, dict) and asset.get("id"):
            asset_by_id[str(asset["id"])] = asset

    characters = _entities(raw.get("characters"), "karakter", "char")
    products = _entities(raw.get("products"), "produk", "prod")
    locations = _entities(raw.get("locations"), "lokasi", "loc")
    entity_ids = {
        "characters": {item["id"] for item in characters},
        "products": {item["id"] for item in products},
        "locations": {item["id"] for item in locations},
    }

    requirements = {}
    requirement_list = []
    for position, item in enumerate(_list(raw.get("image_requirements"), "image_requirements"), 1):
        if not isinstance(item, dict):
            raise ProductionPackageError(f"Kebutuhan gambar nomor {position} harus berupa objek.")
        requirement_id = _safe_id(item.get("id"), f"ID kebutuhan gambar nomor {position}")
        if requirement_id in requirements:
            raise ProductionPackageError(f"ID kebutuhan gambar '{requirement_id}' dipakai lebih dari sekali.")
        requirement = {
            "id": requirement_id,
            "purpose": _text(item.get("purpose"), f"Tujuan kebutuhan gambar {requirement_id}", MAX_NAME_CHARS),
            "subject": _text(item.get("subject"), f"Subjek kebutuhan gambar {requirement_id}", MAX_NAME_CHARS, required=False),
            "description": _text(item.get("description"), f"Deskripsi kebutuhan gambar {requirement_id}", MAX_TEXT_CHARS, required=False),
            "generation": "manual",
        }
        requirements[requirement_id] = requirement
        requirement_list.append(requirement)

    links = _dict(links, "Tautan gambar")
    checked_links = {}
    for requirement_id, asset_id in links.items():
        if requirement_id not in requirements:
            raise ProductionPackageError("Tautan gambar memakai kebutuhan yang tidak terdaftar.")
        if not isinstance(asset_id, str) or asset_id not in asset_by_id:
            raise ProductionPackageError("Tautan gambar memakai gambar yang tidak ada di daftar unggahan.")
        checked_links[requirement_id] = asset_id
    for requirement in requirement_list:
        requirement["asset_id"] = checked_links.get(requirement["id"])
        requirement["status"] = _requirement_status(requirement["id"], checked_links)

    clips_raw = _list(raw.get("clips"), "clips")
    if not 1 <= len(clips_raw) <= MAX_CLIPS:
        raise ProductionPackageError(f"Paket harus memiliki 1 sampai {MAX_CLIPS} klip.")

    input_indexes = []
    for position, item in enumerate(clips_raw, 1):
        if not isinstance(item, dict):
            raise ProductionPackageError(f"Klip {position} harus berupa objek.")
        index = item.get("index", position)
        if isinstance(index, bool) or not isinstance(index, int) or index < 1:
            raise ProductionPackageError(f"Indeks klip {position} harus bilangan bulat positif.")
        input_indexes.append(index)
    if len(set(input_indexes)) != len(input_indexes):
        raise ProductionPackageError("Indeks klip tidak boleh dipakai lebih dari sekali.")
    position_by_input_index = {index: position for position, index in enumerate(input_indexes, 1)}

    warnings = []
    if not limits["verified"]:
        warnings.append(f"Batas {limits['max_clip_seconds']} detik untuk {limits['label']} belum diverifikasi. Periksa batas durasi di platform sebelum produksi.")

    clips = []
    total = 0
    for position, raw_clip in enumerate(clips_raw, 1):
        seconds = _seconds(raw_clip.get("duration_seconds"), f"Klip {position}")
        if seconds > limits["max_clip_seconds"]:
            raise ProductionPackageError(f"Klip {position} berdurasi {seconds} detik, melebihi batas {limits['max_clip_seconds']} detik. Pecah menjadi beberapa klip.")
        prompt = _text(raw_clip.get("prompt_final"), f"Prompt klip {position}", MAX_PROMPT_CHARS)
        prompt_en = _text(raw_clip.get("prompt_en"), f"Prompt Inggris klip {position}", MAX_PROMPT_CHARS, required=require_english)
        english_raw = _dict(raw_clip.get("en"), f"Detail Inggris klip {position}")
        english = {key: _text(english_raw.get(key), f"{key} Inggris klip {position}", MAX_TEXT_CHARS, required=False) for key in EN_DETAIL_KEYS}

        continues = raw_clip.get("continues_from")
        continues_position = None
        if continues is not None:
            if isinstance(continues, bool) or not isinstance(continues, int):
                raise ProductionPackageError(f"Klip {position}: continues_from harus bilangan bulat atau kosong.")
            if continues not in position_by_input_index:
                raise ProductionPackageError(f"Klip {position} melanjutkan klip {continues} yang tidak ada.")
            continues_position = position_by_input_index[continues]
            if continues_position >= position:
                raise ProductionPackageError(f"Klip {position} hanya boleh melanjutkan klip sebelumnya.")

        refs_raw = _list(raw_clip.get("references"), f"Referensi klip {position}")
        if len(refs_raw) > limits["max_references"]:
            raise ProductionPackageError(f"Klip {position} memakai lebih dari {limits['max_references']} referensi.")
        references = []
        for ref in refs_raw:
            if not isinstance(ref, dict):
                raise ProductionPackageError(f"Referensi klip {position} tidak valid.")
            role = ref.get("role")
            if role not in REFERENCE_ROLES:
                raise ProductionPackageError(f"Peran referensi klip {position} tidak dikenal: {_one_line(role, 30)}.")
            asset_id = _text(ref.get("asset_id"), f"asset_id klip {position}", MAX_ID_CHARS, required=False)
            requirement_id = _text(ref.get("requirement_id"), f"requirement_id klip {position}", MAX_ID_CHARS, required=False)
            if asset_id and requirement_id:
                raise ProductionPackageError(f"Referensi klip {position} hanya boleh memakai asset_id atau requirement_id, bukan keduanya.")
            if asset_id:
                if asset_id not in asset_by_id:
                    raise ProductionPackageError(f"Klip {position} memakai gambar yang tidak ada di daftar unggahan.")
                references.append({"kind": "asset", "id": asset_id, "role": role})
            elif requirement_id:
                if requirement_id not in requirements:
                    raise ProductionPackageError(f"Klip {position} memakai kebutuhan gambar yang tidak terdaftar.")
                references.append({"kind": "requirement", "id": requirement_id, "role": role})
            else:
                raise ProductionPackageError(f"Referensi klip {position} harus memiliki asset_id atau requirement_id.")

        clip_entities = {}
        for key, field, kind in (("characters", "karakter", "characters"), ("locations", "lokasi", "locations")):
            ids = []
            for item in _list(raw_clip.get(key), f"{field.capitalize()} klip {position}"):
                entity_id = _safe_id(item, f"ID {field} klip {position}")
                if entity_id not in entity_ids[kind]:
                    raise ProductionPackageError(f"Klip {position} memakai {field} yang tidak terdaftar: {entity_id}.")
                ids.append(entity_id)
            clip_entities[key] = ids

        audio_raw = _dict(raw_clip.get("audio"), f"Audio klip {position}")
        plan = audio_raw.get("plan", "tanpa_audio")
        if plan not in AUDIO_PLANS:
            raise ProductionPackageError(f"Jenis audio klip {position} tidak dikenal: {_one_line(plan, 30)}.")

        clips.append({
            "index": position,
            "duration_seconds": seconds,
            "prompt_final": prompt,
            "prompt_en": prompt_en,
            "action": _text(raw_clip.get("action"), f"Aksi klip {position}", MAX_TEXT_CHARS, required=False),
            "camera": _text(raw_clip.get("camera"), f"Kamera klip {position}", MAX_TEXT_CHARS, required=False),
            "lighting": _text(raw_clip.get("lighting"), f"Pencahayaan klip {position}", MAX_TEXT_CHARS, required=False),
            "en": english,
            "references": references,
            "characters": clip_entities["characters"],
            "locations": clip_entities["locations"],
            "audio": {
                "plan": plan,
                "text": _text(audio_raw.get("text"), f"Teks audio klip {position}", MAX_TEXT_CHARS, required=False),
                "note": _text(audio_raw.get("note"), f"Catatan audio klip {position}", MAX_TEXT_CHARS, required=False),
            },
            "continues_from": continues_position,
        })
        total += seconds

    if target_seconds and abs(total - target_seconds) > target_seconds * 0.1:
        warnings.append(f"Total durasi klip {round(total)} detik berbeda dari target {target_seconds} detik.")

    return {
        "model": limits["key"],
        "concept": concept,
        "characters": characters,
        "products": products,
        "locations": locations,
        "image_requirements": requirement_list,
        "clips": clips,
        "upload_checklist": build_upload_checklist(clips, asset_by_id, requirements, checked_links),
        "total_seconds": round(total),
        "warnings": warnings,
    }


STORAGE_SCHEMA_VERSION = 1
MAX_STORED_TARGET_SECONDS = 600


def parse_stored_target(value):
    """Target duration saved with a package. None means the user did not set one."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_STORED_TARGET_SECONDS:
        raise ProductionPackageError(f"Target durasi harus bilangan bulat 1 sampai {MAX_STORED_TARGET_SECONDS} detik.")
    return value


def _raw_from_package(package):
    """Rebuild the input shape of validate_package from a normalized package.

    Saved packages and packages sent back by the client go through the same rules as packages from Gemini.
    """
    if not isinstance(package, dict):
        raise ProductionPackageError("Paket produksi harus berupa objek JSON.")
    raw_clips = []
    for position, clip_item in enumerate(_list(package.get("clips"), "clips"), 1):
        if not isinstance(clip_item, dict):
            raise ProductionPackageError(f"Klip {position} harus berupa objek.")
        refs = []
        for ref in _list(clip_item.get("references"), f"Referensi klip {position}"):
            if not isinstance(ref, dict) or ref.get("kind") not in ("asset", "requirement"):
                raise ProductionPackageError(f"Referensi klip {position} tidak valid.")
            field = "asset_id" if ref["kind"] == "asset" else "requirement_id"
            refs.append({"role": ref.get("role"), field: ref.get("id")})
        raw_clips.append({
            "index": position,
            "duration_seconds": clip_item.get("duration_seconds"),
            "prompt_final": clip_item.get("prompt_final"),
            "prompt_en": clip_item.get("prompt_en", ""),
            "action": clip_item.get("action", ""),
            "camera": clip_item.get("camera", ""),
            "lighting": clip_item.get("lighting", ""),
            "en": clip_item.get("en", {}),
            "references": refs,
            "characters": clip_item.get("characters", []),
            "locations": clip_item.get("locations", []),
            "audio": clip_item.get("audio", {}),
            "continues_from": clip_item.get("continues_from"),
        })
    requirements = []
    links = {}
    for item in _list(package.get("image_requirements"), "image_requirements"):
        if not isinstance(item, dict):
            raise ProductionPackageError("Kebutuhan gambar harus berupa objek.")
        requirements.append({
            "id": item.get("id"),
            "purpose": item.get("purpose"),
            "subject": item.get("subject", ""),
            "description": item.get("description", ""),
        })
        if isinstance(item.get("id"), str) and item.get("asset_id"):
            links[item["id"]] = item["asset_id"]
    raw = {
        "concept": package.get("concept"),
        "characters": package.get("characters", []),
        "products": package.get("products", []),
        "locations": package.get("locations", []),
        "image_requirements": requirements,
        "clips": raw_clips,
    }
    return raw, links


def normalize_stored_package(package, assets, target_seconds=None):
    raw, links = _raw_from_package(package)
    return validate_package(raw, assets, model_limits(package.get("model")), target_seconds, links)


def prepare_for_storage(package, assets, target_seconds, saved_at):
    """Validate a package and return the envelope saved under the project's data. Raises ProductionPackageError."""
    return {
        "schemaVersion": STORAGE_SCHEMA_VERSION,
        "savedAt": saved_at,
        "targetSeconds": target_seconds,
        "package": normalize_stored_package(package, assets, target_seconds),
    }


def view_for_project(stored, assets):
    """What the API shows for a stored package. Stored data that fails validation is reported, never deleted."""
    if stored is None:
        return None
    if not isinstance(stored, dict) or stored.get("schemaVersion") != STORAGE_SCHEMA_VERSION:
        return {"schemaVersion": None, "savedAt": None, "targetSeconds": None, "package": None,
                "error": "Format paket produksi tidak dikenali. Data tersimpan tidak diubah."}
    base = {"schemaVersion": STORAGE_SCHEMA_VERSION, "savedAt": stored.get("savedAt"), "targetSeconds": stored.get("targetSeconds")}
    try:
        package = normalize_stored_package(stored.get("package"), assets, stored.get("targetSeconds"))
    except ProductionPackageError as exc:
        return {**base, "package": None, "error": f"Paket tersimpan tidak lolos validasi: {exc} Data tersimpan tidak diubah."}
    except Exception:
        return {**base, "package": None, "error": "Paket tersimpan tidak bisa dibaca. Data tersimpan tidak diubah."}
    if any(not clip["prompt_en"] for clip in package["clips"]):
        package["warnings"].append("Paket ini dibuat sebelum prompt Inggris tersedia. Buat ulang paket untuk mendapat prompt Inggris.")
    return {**base, "package": package, "error": None}
