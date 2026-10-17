import io
import json
import base64
import tempfile
import unittest
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
    def test_image_upload_is_saved_and_served(self):
        req = Request("POST", "/api/projects", json.dumps({"title":"Asset test"}).encode())
        req.do_POST()
        ident = json.loads(req.response)["id"]
        data = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        req = Request("POST", f"/api/projects/{ident}/assets", data, {"Content-Type":"image/jpeg", "X-Filename":"ref.jpg"})
        req.do_POST()
        self.assertEqual(req.status, 201)
        asset = json.loads(req.response)
        req = Request("GET", asset["url"])
        req.do_GET()
        self.assertEqual(req.status, 200)
        self.assertEqual(req.response, data)
    def test_non_image_upload_is_rejected(self):
        req = Request("POST", "/api/projects/unknown/assets", b"x", {"Content-Type":"video/mp4"})
        req.do_POST()
        self.assertEqual(req.status, 415)
    def test_asset_category_is_saved(self):
        req = Request("POST", "/api/projects", json.dumps({"title":"Asset category"}).encode())
        req.do_POST()
        ident = json.loads(req.response)["id"]
        req = Request("POST", f"/api/projects/{ident}/assets", b"image", {"Content-Type":"image/png", "X-Filename":"person.png", "X-Asset-Type":"Karakter"})
        req.do_POST()
        self.assertEqual(req.status, 201)
        with app.connect() as db:
            data = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
        self.assertEqual(data["assets"][0]["type"], "Karakter")
    def test_ai_story_endpoint_returns_local_adapter_result(self):
        draft = {"alternatives":[{"title":"Kisah kecil","scenes":[{"id":"scene-1","title":"Pembuka"}]}]}
        req = Request("POST", "/api/ai/story", json.dumps({"idea":"Kisah hujan", "model":"gemma:latest"}).encode())
        with patch.object(app, "make_local_story", return_value=draft) as adapter:
            req.do_POST()
        self.assertEqual(req.status, 200)
        self.assertEqual(json.loads(req.response)["draft"]["alternatives"][0]["title"], "Kisah kecil")
        adapter.assert_called_once()
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

        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
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
