import io
import json
import base64
import sqlite3
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import app


class Request(app.Handler):
    def __init__(self, method, path, body=b"", headers=None):
        self.command = method
        self.path = path
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.headers = {"Content-Length": str(len(body)), **(headers or {})}
        self.status = None
        self.response_headers = {}
        self.read_called = False
    def read_body(self, length):
        self.read_called = True
        return self.rfile.read(length)
    def send_response(self, status): self.status = status
    def send_header(self, key, value): self.response_headers[key] = value
    def end_headers(self): pass
    @property
    def response(self): return self.wfile.getvalue()


class ApiSmokeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        root = Path(self.tmp.name)
        self.db = root / "test.sqlite3"
        self.uploads = root / "uploads"
        self.uploads.mkdir()
        self.patches = [patch.object(app, "DB", self.db), patch.object(app, "UPLOADS", self.uploads)]
        for item in self.patches: item.start()
        app.init_db()
    def tearDown(self):
        for item in self.patches: item.stop()
        self.tmp.cleanup()
    def test_create_update_list_and_delete_project(self):
        req = Request("POST", "/api/projects", json.dumps({"title":"Demo", "goal":"Edukasi", "idea":"Ide"}).encode())
        req.do_POST()
        self.assertEqual(req.status, 201)
        made = json.loads(req.response)
        self.assertEqual(made["title"], "Demo")
        self.assertEqual(made["data"]["scenes"], [])
        changed = {**made, "status":"Storyboard siap", "data":{"scenes":[{"title":"Pembuka"}]}}
        req = Request("PUT", f"/api/projects/{made['id']}", json.dumps(changed).encode())
        req.do_PUT()
        self.assertEqual(req.status, 200)
        self.assertEqual(json.loads(req.response)["data"]["scenes"][0]["title"], "Pembuka")
        req = Request("GET", "/api/projects")
        req.do_GET()
        self.assertEqual(json.loads(req.response)[0]["status"], "Storyboard siap")
        req = Request("DELETE", f"/api/projects/{made['id']}")
        req.do_DELETE()
        self.assertEqual(req.status, 204)

    def test_legacy_audio_fields_migrate_to_distinct_audio_plan_without_losing_content(self):
        normalized = app.normalize_production_data({"scenes": [{"id":"old", "dialogue":"Halo", "audio":{"voiceover":"Narasi lama", "music":"Piano", "effects":["Pintu"]}}]})
        scene = normalized["scenes"][0]
        self.assertEqual(scene["audioPlan"]["dialogue"][0]["text"], "Halo")
        self.assertEqual(scene["audioPlan"]["voiceover"]["text"], "Narasi lama")
        self.assertEqual(scene["audioPlan"]["music"]["description"], "Piano")
        self.assertEqual(scene["audioPlan"]["soundEffects"], ["Pintu"])
        self.assertTrue(scene["audioPlan"]["required"])
        self.assertEqual(scene["audio"]["voiceover"], "Narasi lama")

    def test_audio_plan_validation_rejects_invalid_types_and_preserves_categories(self):
        data = app.normalize_production_data({"audioDirector":{"continuityNotes":"Profil suara tetap"}, "scenes":[{"id":"s1", "audioPlan":{"required":True,"dialogue":[{"speakerName":"Ayu","speakerId":"char-1","voiceProfileId":"ayu-v1","text":"Hai","emotion":"gembira","delivery":"pelan"}],"voiceover":{"narratorName":"Narator","voiceProfileId":"narrator-v1","text":"Pembuka"},"music":{"description":"Piano","mood":"hangat"},"ambience":["hujan"],"soundEffects":["langkah"]}}]})
        self.assertEqual(data["audioDirector"]["continuityNotes"], "Profil suara tetap")
        self.assertEqual(data["scenes"][0]["audioPlan"]["dialogue"][0]["speakerId"], "char-1")
        self.assertEqual(data["scenes"][0]["audioPlan"]["voiceover"]["voiceProfileId"], "narrator-v1")
        self.assertEqual(data["scenes"][0]["audioPlan"]["ambience"], ["hujan"])
        with self.assertRaisesRegex(ValueError, "dialogue harus berupa daftar"):
            app.normalize_production_data({"scenes":[{"audioPlan":{"dialogue":"bukan daftar"}}]})
    def test_new_project_starts_with_versioned_production_structure(self):
        req = Request("POST", "/api/projects", json.dumps({"title":"Brief baru", "goal":"Promosi", "idea":"Ide awal"}).encode())
        req.do_POST()
        self.assertEqual(req.status, 201)
        made = json.loads(req.response)
        data = made["data"]
        self.assertEqual(data["schemaVersion"], 1)
        self.assertEqual(data["projectBrief"]["idea"], "Ide awal")
        self.assertEqual(data["projectBrief"]["videoType"], "Promosi")
        self.assertEqual(set(data["entities"]), {"characters", "products", "locations"})
        self.assertEqual(data["scenes"], [])
        self.assertEqual(data["assemblyPlan"]["status"], "not_started")
    def test_legacy_duration_and_project_brief_are_normalized_to_current_project_target(self):
        normalized = app.normalize_production_data({
            "duration":"1 menit", "projectBrief":{"targetDuration":"30 detik"},
            "scenes":[{"id":f"s{i}", "duration":"10 detik"} for i in range(6)],
        })
        self.assertEqual(normalized["projectBrief"]["targetDuration"], "1 menit")
        self.assertEqual([scene["duration"] for scene in normalized["scenes"]], ["10 detik"] * 6)
    def test_legacy_checklist_keys_are_normalized_without_losing_completion_status(self):
        normalized = app.normalize_production_data({
            "checks":{"scene-old-assets":True,"scene-old-prompt":True},
            "scenes":[{"id":"old", "purpose":"Adegan lama", "assetIds":[]}],
        })
        scene = normalized["scenes"][0]
        self.assertTrue(scene["productionChecklist"]["assets"])
        self.assertTrue(scene["productionChecklist"]["prompt"])
        self.assertEqual(scene["productionStatus"], "prompt_ready")
        self.assertTrue(normalized["checks"]["scene-old-assets"])
    def test_legacy_project_is_normalized_on_read_without_rewriting_stored_json(self):
        old_data = {"style":"Sinematik", "character":"Ayah berkemeja biru", "world":"Ruang keluarga", "duration":"8 detik", "story":{"title":"Pulang"}, "assets":[{"id":"a1","name":"ayah.png","url":"/uploads/ayah.png"}], "scenes":[{"id":"s1","purpose":"Bertemu", "visual":"Ayah membuka pintu", "assetIds":["a1"]}], "checks":{"scene-s1-prompt":True}}
        ident = "legacy-project"
        with app.connect() as db:
            db.execute("INSERT INTO projects(id,title,goal,idea,platform,status,data) VALUES(?,?,?,?,?,?,?)", (ident,"Lama","Cerita","Ide lama","flow","Draft",json.dumps(old_data)))
            before = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0]
        req = Request("GET", f"/api/projects/{ident}")
        req.do_GET()
        self.assertEqual(req.status, 200)
        opened = json.loads(req.response)
        data = opened["data"]
        self.assertEqual(data["schemaVersion"], 1)
        self.assertEqual(data["projectBrief"]["characterNotes"], "Ayah berkemeja biru")
        self.assertEqual(data["projectBrief"]["locationNotes"], "Ruang keluarga")
        self.assertEqual(data["scenes"][0]["narrativePurpose"], "Bertemu")
        self.assertEqual(data["scenes"][0]["visualDescription"], "Ayah membuka pintu")
        self.assertEqual(data["scenes"][0]["referenceAssetIds"], ["a1"])
        self.assertEqual(data["assets"][0]["id"], "a1")
        with app.connect() as db:
            after = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0]
        self.assertEqual(after, before)
    def test_production_data_round_trips_story_entities_assets_scene_and_settings(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Satu paket"}).encode())
        create.do_POST()
        saved = json.loads(create.response)
        data = saved["data"]
        data.update({
            "projectBrief":{"idea":"Kopi pagi", "videoType":"Promosi", "audience":"Pekerja", "keyMessage":"Mulai dengan tenang", "visualStyle":"Hangat", "targetDuration":"30 detik"},
            "storyPlan":{"title":"Pagi baru", "opening":"Cahaya masuk", "approvalStatus":"approved"},
            "entities":{"characters":[{"id":"c1","name":"Barista","appearance":"Apron hijau"}],"products":[{"id":"p1","name":"Kopi"}],"locations":[{"id":"l1","name":"Kedai"}]},
            "assets":[{"id":"a1","name":"kedai.png","url":"/uploads/kedai.png","type":"Lokasi"}],
            "scenes":[{"id":"s1","purpose":"Mengenalkan pagi", "visual":"Barista menyeduh kopi", "characterIds":["c1"], "productIds":["p1"], "locationId":"l1", "assetIds":["a1"], "continuityIn":{"wardrobe":"apron hijau"}, "continuityOut":{"cup":"di meja"}, "audio":{"voiceover":"Selamat pagi", "music":"piano", "effects":["suara tuang"]}}],
            "productionSettings":{"platform":"flow", "aspectRatio":"16:9", "model":"pilihan manual"},
            "assemblyPlan":{"status":"in_progress", "clips":[{"sceneId":"s1", "filename":"01-kedai.mp4"}]}
        })
        saved["data"] = data
        req = Request("PUT", f"/api/projects/{saved['id']}", json.dumps(saved, ensure_ascii=False).encode())
        req.do_PUT()
        self.assertEqual(req.status, 200)
        reopened = Request("GET", f"/api/projects/{saved['id']}")
        reopened.do_GET()
        again = json.loads(reopened.response)["data"]
        self.assertEqual(again["projectBrief"]["audience"], "Pekerja")
        self.assertEqual(again["storyPlan"]["approvalStatus"], "approved")
        self.assertEqual(again["entities"]["characters"][0]["name"], "Barista")
        self.assertEqual(again["assets"][0]["id"], "a1")
        self.assertEqual(again["scenes"][0]["referenceAssetIds"], ["a1"])
        self.assertEqual(again["scenes"][0]["continuityOut"]["cup"], "di meja")
        self.assertEqual(again["productionSettings"]["aspectRatio"], "16:9")
        self.assertEqual(again["assemblyPlan"]["clips"][0]["filename"], "01-kedai.mp4")
    def test_json_body_limit_rejects_before_reading_and_malformed_json_safely(self):
        too_large = b" " * (app.MAX_JSON_BODY_BYTES + 1)
        req = Request("POST", "/api/projects", too_large)
        req.do_POST()
        self.assertFalse(req.read_called)
        self.assertEqual(req.status, 413)
        self.assertEqual(json.loads(req.response)["error"], "Data permintaan melebihi batas 1 MB.")
        req = Request("POST", "/api/projects", b"{invalid")
        req.do_POST()
        self.assertEqual(req.status, 400)
        self.assertEqual(json.loads(req.response)["error"], "Format JSON tidak valid.")
    def test_invalid_production_shape_is_rejected_without_overwriting_saved_project(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Jangan tertimpa"}).encode())
        create.do_POST()
        saved = json.loads(create.response)
        original = json.loads(json.dumps(saved["data"]))
        saved["data"]["scenes"] = [{"id":"bad", "assetIds":"not-an-array"}]
        req = Request("PUT", f"/api/projects/{saved['id']}", json.dumps(saved).encode())
        req.do_PUT()
        self.assertEqual(req.status, 400)
        self.assertIn("assetIds", json.loads(req.response)["error"])
        with app.connect() as db:
            raw = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (saved["id"],)).fetchone()[0])
        self.assertEqual(raw, original)
    def test_image_upload_is_saved_and_served(self):
        req = Request("POST", "/api/projects", json.dumps({"title":"Asset test"}).encode())
        req.do_POST()
        ident = json.loads(req.response)["id"]
        data = self.png()
        req = Request("POST", f"/api/projects/{ident}/assets", data, {"Content-Type":"image/png", "X-Filename":"ref.jpg"})
        req.do_POST()
        self.assertEqual(req.status, 201)
        asset = json.loads(req.response)
        self.assertEqual(asset["asset"]["name"], "ref.jpg")
        self.assertEqual(asset["asset"]["type"], "Referensi umum")
        self.assertEqual(asset["asset"]["url"], asset["url"])
        req = Request("GET", asset["url"])
        req.do_GET()
        self.assertEqual(req.status, 200)
        self.assertEqual(req.response, data)
        self.assertEqual(Path(app.UPLOADS / Path(asset["url"]).name).suffix, ".png")
    @staticmethod
    def png():
        def chunk(kind, payload):
            return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b"")
    @staticmethod
    def valid_images():
        # Tiny valid fixtures generated locally with FFmpeg; no runtime tool dependency.
        return {
            "image/png": ApiSmokeTests.png(),
            "image/jpeg": base64.b64decode("/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAGAQEBAAAAAAAAAAAAAAAAAAAGBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIsATX9//9k="),
            "image/gif": b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;",
            "image/webp": base64.b64decode("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+82mX/mwK5rn3+//pcH6XB+lwf+lIAAA="),
        }
    def test_non_image_upload_is_rejected(self):
        req = Request("POST", "/api/projects/unknown/assets", b"x", {"Content-Type":"video/mp4"})
        req.do_POST()
        self.assertEqual(req.status, 415)
    def test_invalid_image_bytes_and_mime_mismatch_are_rejected(self):
        req = Request("POST", "/api/projects/unknown/assets", b"not a png", {"Content-Type":"image/png"})
        req.do_POST()
        self.assertEqual(req.status, 415)
        req = Request("POST", "/api/projects/unknown/assets", self.png(), {"Content-Type":"image/jpeg"})
        req.do_POST()
        self.assertEqual(req.status, 415)
    def test_upload_limit_is_checked_before_body_read_and_boundary_is_inclusive(self):
        image = self.png()
        req = Request("POST", "/api/projects/unknown/assets", image, {"Content-Type":"image/png"})
        with patch.object(app, "MAX_ASSET_BYTES", len(image)):
            req.do_POST()
        self.assertTrue(req.read_called)
        self.assertEqual(req.status, 404)
        req = Request("POST", "/api/projects/unknown/assets", image, {"Content-Type":"image/png"})
        req.headers["Content-Length"] = str(len(image) + 1)
        with patch.object(app, "MAX_ASSET_BYTES", len(image)):
            req.do_POST()
        self.assertFalse(req.read_called)
        self.assertEqual(req.status, 413)
    def test_all_supported_image_formats_are_accepted_and_named_from_content(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Format test"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        suffixes = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
        for content_type, data in self.valid_images().items():
            with self.subTest(content_type=content_type):
                req = Request("POST", f"/api/projects/{ident}/assets", data, {"Content-Type":content_type})
                req.do_POST()
                self.assertEqual(req.status, 201)
                self.assertEqual(Path(json.loads(req.response)["url"]).suffix, suffixes[content_type])
    def test_empty_truncated_and_corrupt_image_payloads_are_rejected(self):
        cases = [
            (b"", "image/png", 400),
            (self.png()[:-8], "image/png", 415),
            (self.png()[:8] + self.png()[8:29] + b"not-zlib" + self.png()[37:], "image/png", 415),
            (b"GIF89a\x01\x00\x01\x00\x80\x00\x00", "image/gif", 415),
        ]
        for body, content_type, expected in cases:
            with self.subTest(content_type=content_type, expected=expected):
                req = Request("POST", "/api/projects/unknown/assets", body, {"Content-Type":content_type})
                req.do_POST()
                self.assertEqual(req.status, expected)
    def test_actual_12mb_boundary_and_oversize_content_length(self):
        limit = 12_000_000
        base = self.png()
        payload = b"Comment\0" + b"x" * (limit - len(base) - 20)
        chunk = struct.pack(">I", len(payload)) + b"tEXt" + payload + struct.pack(">I", zlib.crc32(b"tEXt" + payload) & 0xffffffff)
        exact = base[:-12] + chunk + base[-12:]
        self.assertEqual(len(exact), limit)
        create = Request("POST", "/api/projects", json.dumps({"title":"Exact limit"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        req = Request("POST", f"/api/projects/{ident}/assets", exact, {"Content-Type":"image/png"})
        req.do_POST()
        self.assertTrue(req.read_called)
        self.assertEqual(req.status, 201)
        saved = app.UPLOADS / Path(json.loads(req.response)["url"]).name
        self.assertEqual(saved.stat().st_size, limit)

        oversized = b"x" * (limit + 1)
        req = Request("POST", "/api/projects/unknown/assets", oversized, {"Content-Type":"image/png"})
        req.do_POST()
        self.assertFalse(req.read_called)
        self.assertEqual(req.status, 413)
    def test_database_failure_removes_only_the_newly_created_upload(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Cleanup test"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        other = app.UPLOADS / "another-project-existing.png"
        other.write_bytes(b"leave this file alone")
        req = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        with patch.object(app, "connect", side_effect=RuntimeError("metadata failure")):
            req.do_POST()
        self.assertEqual(req.status, 500)
        self.assertEqual([path.name for path in app.UPLOADS.iterdir()], [other.name])
        self.assertEqual(other.read_bytes(), b"leave this file alone")
    def test_truncated_body_and_invalid_content_length_are_rejected(self):
        req = Request("POST", "/api/projects/unknown/assets", b"abc", {"Content-Type":"image/png"})
        req.headers["Content-Length"] = "4"
        req.do_POST()
        self.assertEqual(req.status, 400)
        req = Request("POST", "/api/projects/unknown/assets", b"", {"Content-Type":"image/png"})
        req.headers["Content-Length"] = "oops"
        req.do_POST()
        self.assertEqual(req.status, 400)
    def test_asset_category_is_saved(self):
        req = Request("POST", "/api/projects", json.dumps({"title":"Asset category"}).encode())
        req.do_POST()
        ident = json.loads(req.response)["id"]
        req = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png", "X-Filename":"person.png", "X-Asset-Type":"Karakter"})
        req.do_POST()
        self.assertEqual(req.status, 201)
        with app.connect() as db:
            data = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(data["assets"][0]["type"], "Karakter")
    def test_delete_asset_removes_only_its_file_metadata_and_scene_links(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Delete asset"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png", "X-Filename":"ayah.png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        uploaded_path = app.UPLOADS / Path(asset["url"]).name
        unrelated = app.UPLOADS / "unrelated-project-keep.png"
        unrelated.write_bytes(b"keep")
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["scenes"] = [
                {"id":"uses-asset", "assetIds":[asset["id"]], "referenceAssetIds":[asset["id"]], "productionChecklist":{"assets":True,"prompt":True,"generated":False,"collected":False}},
                {"id":"other-scene", "assetIds":[], "referenceAssetIds":[], "productionChecklist":{"assets":True}},
            ]
            data["checks"] = {"scene-uses-asset-assets":True,"scene-uses-asset-prompt":True}
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        req.do_DELETE()
        self.assertEqual(req.status, 200)
        result = json.loads(req.response)
        saved = result["project"]["data"]
        self.assertEqual(saved["assets"], [])
        first, second = saved["scenes"]
        self.assertEqual(first["assetIds"], [])
        self.assertEqual(first["referenceAssetIds"], [])
        self.assertFalse(first["productionChecklist"]["assets"])
        self.assertTrue(first["productionChecklist"]["prompt"])
        self.assertEqual(second["assetIds"], [])
        self.assertTrue(second["productionChecklist"]["assets"])
        self.assertFalse(uploaded_path.exists())
        self.assertEqual(unrelated.read_bytes(), b"keep")

    def test_delete_asset_database_failure_restores_file_and_metadata(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Delete rollback"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["scenes"] = [{"id":"scene-db-failure", "assetIds":[asset["id"]], "referenceAssetIds":[asset["id"]]}]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))
            db.execute("CREATE TRIGGER reject_asset_delete BEFORE UPDATE OF data ON projects BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        req.do_DELETE()
        self.assertEqual(req.status, 500)
        self.assertTrue(path.exists())
        with app.connect() as db:
            saved = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(saved["assets"][0]["id"], asset["id"])
        self.assertEqual(saved["scenes"][0]["assetIds"], [asset["id"]])
        self.assertEqual(saved["scenes"][0]["referenceAssetIds"], [asset["id"]])
        self.assertFalse(any(".deleting-" in item.name for item in app.UPLOADS.iterdir()))

    def test_delete_asset_database_read_failure_before_path_reports_without_rollback_claim(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Read failure"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        with app.connect() as db:
            before = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0]

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        with patch.object(app, "connect", side_effect=sqlite3.OperationalError("simulated database read failure")):
            req.do_DELETE()
        self.assertEqual(req.status, 500)
        self.assertIn("sebelum operasi filesystem dimulai", json.loads(req.response)["error"])
        self.assertTrue(path.is_file())
        with app.connect() as db:
            after = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0]
        self.assertEqual(after, before)

    def test_delete_asset_parse_failure_before_path_leaves_file_and_raw_metadata_untouched(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Parse failure"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        malformed = "{invalid-json"
        with app.connect() as db:
            db.execute("UPDATE projects SET data=? WHERE id=?", (malformed, ident))

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        req.do_DELETE()
        self.assertEqual(req.status, 500)
        self.assertIn("sebelum operasi filesystem dimulai", json.loads(req.response)["error"])
        self.assertTrue(path.is_file())
        with app.connect() as db:
            after = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0]
        self.assertEqual(after, malformed)

    def test_delete_asset_does_not_overwrite_a_concurrent_project_save(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Concurrent save"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["projectBrief"] = {"idea":"versi awal"}
            data["scenes"] = [{"id":"scene-concurrent", "assetIds":[asset["id"]], "referenceAssetIds":[asset["id"]]}]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))

        replace = app.os.replace
        concurrent_save_done = False
        def move_then_save_concurrently(source, quarantine):
            nonlocal concurrent_save_done
            replace(source, quarantine)
            if not concurrent_save_done:
                concurrent_save_done = True
                with app.connect() as db:
                    row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
                    latest = json.loads(row["data"])
                    latest["projectBrief"]["idea"] = "perubahan terbaru"
                    db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(latest), ident))

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        with patch.object(app.os, "replace", side_effect=move_then_save_concurrently):
            req.do_DELETE()
        self.assertEqual(req.status, 500)
        self.assertTrue(path.is_file())
        self.assertFalse(any(".deleting-" in item.name for item in app.UPLOADS.iterdir()))
        with app.connect() as db:
            saved = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(saved["projectBrief"]["idea"], "perubahan terbaru")
        self.assertEqual(saved["assets"][0]["id"], asset["id"])
        self.assertEqual(saved["scenes"][0]["assetIds"], [asset["id"]])
        self.assertEqual(saved["scenes"][0]["referenceAssetIds"], [asset["id"]])

    def test_delete_asset_cleanup_failure_restores_file_and_metadata(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Cleanup rollback"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["scenes"] = [{"id":"scene-1", "assetIds":[asset["id"]], "referenceAssetIds":[asset["id"]]}]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        with patch.object(Path, "unlink", side_effect=OSError("simulated quarantine cleanup failure")):
            req.do_DELETE()
        self.assertEqual(req.status, 500)
        self.assertTrue(path.is_file())
        with app.connect() as db:
            saved = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(saved["assets"][0]["id"], asset["id"])
        self.assertEqual(saved["scenes"][0]["referenceAssetIds"], [asset["id"]])
        self.assertFalse(any(".deleting-" in item.name for item in app.UPLOADS.iterdir()))

    def test_delete_asset_source_disappears_between_check_and_move_clears_stale_metadata(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Source race"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["scenes"] = [{"id":"scene-race", "assetIds":[asset["id"]], "referenceAssetIds":[asset["id"]]}]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))

        def disappear_then_fail(source, quarantine):
            Path(source).unlink()
            raise FileNotFoundError("simulated source disappearance")

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        with patch.object(app.os, "replace", side_effect=disappear_then_fail):
            req.do_DELETE()
        self.assertEqual(req.status, 200)
        self.assertFalse(path.exists())
        self.assertFalse(any(".deleting-" in item.name for item in app.UPLOADS.iterdir()))
        with app.connect() as db:
            saved = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(saved["assets"], [])
        self.assertEqual(saved["scenes"][0]["assetIds"], [])
        self.assertEqual(saved["scenes"][0]["referenceAssetIds"], [])

    def test_delete_asset_quarantine_missing_before_verification_clears_metadata(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Quarantine race"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["scenes"] = [{"id":"scene-race", "assetIds":[asset["id"]], "referenceAssetIds":[asset["id"]]}]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))

        replace = app.os.replace
        def move_then_remove_quarantine(source, quarantine):
            replace(source, quarantine)
            Path(quarantine).unlink()

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        with patch.object(app.os, "replace", side_effect=move_then_remove_quarantine):
            req.do_DELETE()
        self.assertEqual(req.status, 200)
        self.assertFalse(path.exists())
        self.assertFalse(any(".deleting-" in item.name for item in app.UPLOADS.iterdir()))
        with app.connect() as db:
            saved = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(saved["assets"], [])
        self.assertEqual(saved["scenes"][0]["assetIds"], [])
        self.assertEqual(saved["scenes"][0]["referenceAssetIds"], [])

    def test_delete_asset_metadata_restore_failure_reports_inconsistent_final_state(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Metadata recovery failure"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["scenes"] = [{"id":"scene-recovery", "assetIds":[asset["id"]], "referenceAssetIds":[asset["id"]]}]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))
            db.execute(
                f"CREATE TRIGGER reject_metadata_restore BEFORE UPDATE OF data ON projects "
                f"WHEN instr(NEW.data, '{asset['id']}') > 0 "
                "BEGIN SELECT RAISE(ABORT, 'simulated metadata restore failure'); END"
            )

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        with patch.object(Path, "unlink", side_effect=OSError("simulated quarantine cleanup failure")):
            req.do_DELETE()
        self.assertEqual(req.status, 500)
        self.assertIn("periksa manual", json.loads(req.response)["error"])
        self.assertTrue(path.is_file(), "physical file should be restored even if metadata rollback fails")
        self.assertFalse(any(".deleting-" in item.name for item in app.UPLOADS.iterdir()))
        with app.connect() as db:
            saved = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(saved["assets"], [])
        self.assertEqual(saved["scenes"][0]["assetIds"], [])
        self.assertEqual(saved["scenes"][0]["referenceAssetIds"], [])

    def test_delete_asset_response_failure_does_not_restore_stale_metadata(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Response failure"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["scenes"] = [{"id":"scene-1", "assetIds":[asset["id"]], "referenceAssetIds":[asset["id"]]}]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        with patch.object(req, "send", side_effect=BrokenPipeError("simulated client disconnect")):
            with self.assertRaises(BrokenPipeError):
                req.do_DELETE()
        self.assertFalse(path.exists())
        self.assertFalse(any(".deleting-" in item.name for item in app.UPLOADS.iterdir()))
        with app.connect() as db:
            saved = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(saved["assets"], [])
        self.assertEqual(saved["scenes"][0]["assetIds"], [])
        self.assertEqual(saved["scenes"][0]["referenceAssetIds"], [])

    def test_delete_asset_with_missing_source_file_clears_stale_metadata_and_scene_links(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Missing source"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        upload = Request("POST", f"/api/projects/{ident}/assets", self.png(), {"Content-Type":"image/png"})
        upload.do_POST()
        asset = json.loads(upload.response)["asset"]
        path = app.UPLOADS / Path(asset["url"]).name
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["scenes"] = [{"id":"scene-missing", "assetIds":[asset["id"]], "referenceAssetIds":[asset["id"]]}]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))
        path.unlink()

        req = Request("DELETE", f"/api/projects/{ident}/assets/{asset['id']}")
        req.do_DELETE()
        self.assertEqual(req.status, 200)
        self.assertFalse(path.exists())
        with app.connect() as db:
            saved = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(saved["assets"], [])
        self.assertEqual(saved["scenes"][0]["assetIds"], [])
        self.assertEqual(saved["scenes"][0]["referenceAssetIds"], [])
        self.assertFalse(any(".deleting-" in item.name for item in app.UPLOADS.iterdir()))

    def test_delete_asset_rejects_foreign_path_without_touching_file_or_metadata(self):
        create = Request("POST", "/api/projects", json.dumps({"title":"Foreign path"}).encode())
        create.do_POST()
        ident = json.loads(create.response)["id"]
        foreign = app.UPLOADS / "another-project-asset.png"
        foreign.write_bytes(b"keep")
        with app.connect() as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
            data = json.loads(row["data"])
            data["assets"] = [{"id":"foreign-asset", "name":"foreign.png", "url":"/uploads/another-project-asset.png"}]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data), ident))
        req = Request("DELETE", f"/api/projects/{ident}/assets/foreign-asset")
        req.do_DELETE()
        self.assertEqual(req.status, 400)
        self.assertEqual(foreign.read_bytes(), b"keep")
        with app.connect() as db:
            saved = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(saved["assets"][0]["id"], "foreign-asset")
    def test_ai_story_endpoint_returns_local_adapter_result(self):
        draft = {"alternatives":[{"title":"Kisah kecil","scenes":[{"id":"scene-1","title":"Pembuka"}]}]}
        req = Request("POST", "/api/ai/story", json.dumps({"idea":"Kisah hujan", "model":"gemma:latest"}).encode())
        with patch.object(app, "make_local_story", return_value=draft) as adapter:
            req.do_POST()
        self.assertEqual(req.status, 200)
        self.assertEqual(json.loads(req.response)["draft"]["alternatives"][0]["title"], "Kisah kecil")
        adapter.assert_called_once()

    def test_gemini_status_exposes_only_key_configuration(self):
        req = Request("GET", "/api/ai/gemini/status")
        with patch.dict(app.os.environ, {"GEMINI_API_KEY": ""}):
            req.do_GET()
        self.assertEqual(req.status, 200)
        self.assertEqual(json.loads(req.response), {"configured": False})

    def test_gemini_story_requires_environment_key_without_calling_api(self):
        req = Request("POST", "/api/ai/story", json.dumps({"provider":"gemini", "idea":"Kisah hujan"}).encode())
        with patch.dict(app.os.environ, {"GEMINI_API_KEY": ""}), patch.object(app.urllib.request, "urlopen") as urlopen:
            req.do_POST()
        self.assertEqual(req.status, 503)
        error = json.loads(req.response)["error"]
        self.assertIn("GEMINI_API_KEY", error)
        self.assertNotIn("fake-test-key", error)
        urlopen.assert_not_called()

    def test_gemini_story_valid_json_uses_fixed_model_and_secret_header(self):
        story = {"alternatives":[{"title":"Kisah senja", "scenes":[{"title":"Pembuka", "visual":"Langit jingga"}]}]}
        response_body = {"candidates":[{"content":{"parts":[{"text":json.dumps(story, ensure_ascii=False)}]}}]}
        req = Request("POST", "/api/ai/story", json.dumps({
            "provider":"gemini", "idea":"Senja di desa", "goal":"Cerita", "duration":"30 detik", "style":"Hangat",
        }).encode())
        with patch.dict(app.os.environ, {"GEMINI_API_KEY":"fake-test-key"}), patch.object(
            app.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(response_body).encode()),
        ) as urlopen:
            req.do_POST()
        self.assertEqual(req.status, 200)
        draft = json.loads(req.response)["draft"]["alternatives"][0]
        self.assertEqual(draft["title"], "Kisah senja")
        self.assertEqual(draft["scenes"][0]["visual"], "Langit jingga")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, app.GEMINI_API_URL)
        self.assertEqual(request.get_header("X-goog-api-key"), "fake-test-key")
        request_text = json.loads(request.data)["contents"][0]["parts"][0]["text"]
        self.assertIn("Jenis video: Cerita", request_text)
        self.assertIn("Ide pengguna: Senja di desa", request_text)

    def test_gemini_story_rejects_invalid_model_json(self):
        response_body = {"candidates":[{"content":{"parts":[{"text":"bukan json"}]}}]}
        req = Request("POST", "/api/ai/story", json.dumps({"provider":"gemini", "idea":"Ide"}).encode())
        with patch.dict(app.os.environ, {"GEMINI_API_KEY":"fake-test-key"}), patch.object(
            app.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(response_body).encode()),
        ):
            req.do_POST()
        self.assertEqual(req.status, 502)
        self.assertIn("bukan JSON", json.loads(req.response)["error"])

    def test_gemini_story_timeout_is_reported_without_fallback(self):
        req = Request("POST", "/api/ai/story", json.dumps({"provider":"gemini", "idea":"Ide"}).encode())
        with patch.dict(app.os.environ, {"GEMINI_API_KEY":"fake-test-key"}), patch.object(
            app.urllib.request, "urlopen", side_effect=TimeoutError("simulated timeout"),
        ) as urlopen:
            req.do_POST()
        self.assertEqual(req.status, 504)
        self.assertIn("batas waktu", json.loads(req.response)["error"])
        urlopen.assert_called_once()

    def test_gemini_story_api_error_is_reported_without_fallback(self):
        req = Request("POST", "/api/ai/story", json.dumps({"provider":"gemini", "idea":"Ide"}).encode())
        api_error = app.urllib.error.HTTPError(app.GEMINI_API_URL, 403, "forbidden", {}, io.BytesIO(b"private provider body"))
        with patch.dict(app.os.environ, {"GEMINI_API_KEY":"fake-test-key"}), patch.object(
            app.urllib.request, "urlopen", side_effect=api_error,
        ):
            req.do_POST()
        self.assertEqual(req.status, 502)
        error = json.loads(req.response)["error"]
        self.assertIn("menolak autentikasi", error)
        self.assertNotIn("private provider body", error)
        self.assertNotIn("fake-test-key", error)

    def test_gemini_story_quota_error_is_reported_without_fallback(self):
        req = Request("POST", "/api/ai/story", json.dumps({"provider":"gemini", "idea":"Ide"}).encode())
        api_error = app.urllib.error.HTTPError(app.GEMINI_API_URL, 429, "quota", {}, io.BytesIO(b"quota details"))
        with patch.dict(app.os.environ, {"GEMINI_API_KEY":"fake-test-key"}), patch.object(
            app.urllib.request, "urlopen", side_effect=api_error,
        ) as urlopen:
            req.do_POST()
        self.assertEqual(req.status, 429)
        self.assertIn("kuota Gemini tercapai", json.loads(req.response)["error"])
        urlopen.assert_called_once()
    def test_ai_story_endpoint_rejects_empty_idea(self):
        req = Request("POST", "/api/ai/story", json.dumps({"idea":" "}).encode())
        req.do_POST()
        self.assertEqual(req.status, 400)
    def test_ai_status_is_honest_when_local_service_is_missing(self):
        req = Request("GET", "/api/ai/status")
        with patch.object(app, "local_ollama_models", side_effect=OSError("not installed")):
            req.do_GET()
        self.assertEqual(req.status, 200)
        self.assertEqual(json.loads(req.response), {"available":False,"models":[]})
    def test_production_flow_data_round_trips_without_touching_user_database(self):
        # API-level workflow simulation against this test's isolated temporary DB.
        create = Request("POST", "/api/projects", json.dumps({"title":"Cerita Hujan", "goal":"Film pendek", "idea":"Kucing tersesat saat hujan"}).encode())
        create.do_POST()
        self.assertEqual(create.status, 201)
        project = json.loads(create.response)
        ident = project["id"]
        scene_id = "test-scene-1"
        project.update({"idea":"Kucing tersesat saat hujan lalu ditolong penjaga toko", "status":"Storyboard siap", "data":{
            "duration":"1 menit", "style":"Ilustrasi hangat", "character":"Kucing oranye", "world":"Gang setelah hujan",
            "message":"Kebaikan kecil berarti", "story":{"title":"Rumah Saat Hujan","logline":"Seekor kucing menemukan tempat aman."},
            "scenes":[{"id":scene_id,"title":"Penjaga toko membuka pintu","purpose":"Perkenalkan pertolongan","visual":"Toko hangat saat hujan","action":"Penjaga membuka pintu","location":"Toko kecil","time":"Malam","camera":"Medium shot","lighting":"Hangat","dialogue":"Masuklah","duration":"5 detik","assetIds":[]}],
            "assets":[], "checks":{}, "notes":""}})
        update = Request("PUT", f"/api/projects/{ident}", json.dumps(project,ensure_ascii=False).encode())
        update.do_PUT()
        self.assertEqual(update.status, 200)

        png = self.png()
        upload = Request("POST", f"/api/projects/{ident}/assets", png, {"Content-Type":"image/png","X-Filename":"kucing.png","X-Asset-Type":"Karakter"})
        upload.do_POST()
        self.assertEqual(upload.status, 201)
        with app.connect() as db:
            row = db.execute("SELECT * FROM projects WHERE id=?",(ident,)).fetchone()
        project = app.project(row)
        asset_id = project["data"]["assets"][0]["id"]
        project["data"]["scenes"][0]["title"] = "Kucing diterima di toko"
        project["data"]["scenes"][0]["assetIds"] = [asset_id]
        project["data"]["promptOverrides"] = {scene_id:"Klip hangat, gerakan lembut, kucing oranye memasuki toko."}
        project["data"]["checks"] = {f"scene-{scene_id}-assets":True,f"scene-{scene_id}-prompt":True,f"scene-{scene_id}-generated":True,f"scene-{scene_id}-collected":True}
        project["data"]["scenes"][0]["clipNote"] = "klip-adegan-01.mp4"
        project["status"] = "Klip sudah dikumpulkan"
        update = Request("PUT",f"/api/projects/{ident}",json.dumps(project,ensure_ascii=False).encode())
        update.do_PUT()
        reopened = Request("GET",f"/api/projects/{ident}")
        reopened.do_GET()
        saved = json.loads(reopened.response)
        self.assertEqual(reopened.status,200)
        self.assertEqual(saved["idea"],"Kucing tersesat saat hujan lalu ditolong penjaga toko")
        self.assertEqual(saved["data"]["scenes"][0]["title"],"Kucing diterima di toko")
        self.assertEqual(saved["data"]["scenes"][0]["assetIds"],[asset_id])
        self.assertIn("Klip hangat",saved["data"]["promptOverrides"][scene_id])
        self.assertTrue(saved["data"]["checks"][f"scene-{scene_id}-collected"])
        self.assertEqual(saved["status"],"Klip sudah dikumpulkan")


if __name__ == "__main__": unittest.main()
