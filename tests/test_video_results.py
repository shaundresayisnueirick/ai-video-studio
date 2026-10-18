import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from tests.test_api import MISSING_PROJECT, Request

MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
WEBM = b"\x1aE\xdf\xa3" + b"\x00" * 64

class VideoResultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        root = Path(self.tmp.name)
        self.db = root / "test.sqlite3"
        self.uploads = root / "uploads"
        self.uploads.mkdir()
        self.patches = [patch.object(app, "DB", self.db), patch.object(app, "UPLOADS", self.uploads)]
        for item in self.patches: item.start()
        app.init_db()
        req = Request("POST", "/api/projects", json.dumps({"title": "Hasil video"}).encode())
        req.do_POST()
        self.ident = json.loads(req.response)["id"]
        data = {"scenes": [{"id": "s1", "title": "Pertemuan"}, {"id": "s2", "title": "Dapur"}], "assets": []}
        self.put_project(data)

    def tearDown(self):
        for item in self.patches: item.stop()
        self.tmp.cleanup()

    def put_project(self, data, extra=None):
        body = {"title": "Hasil video", "goal": "Video cerita atau film pendek", "idea": "", "platform": "flow", "data": data, **(extra or {})}
        req = Request("PUT", f"/api/projects/{self.ident}", json.dumps(body).encode())
        req.do_PUT()
        self.assertEqual(req.status, 200, req.response)
        return json.loads(req.response)

    def upload(self, body, content_type="video/mp4", scene="s1", note="", ident=None, length=None):
        headers = {"Content-Type": content_type, "X-Filename": "klip.mp4", "X-Scene-Id": scene, "X-Result-Note": note}
        req = Request("POST", f"/api/projects/{ident or self.ident}/video-results", body, headers)
        if length is not None: req.headers["Content-Length"] = str(length)
        req.do_POST()
        return req

    def files(self):
        return sorted(p.name for p in self.uploads.iterdir())

    def stored(self):
        with sqlite3.connect(self.db) as db:
            return json.loads(db.execute("SELECT data FROM projects WHERE id=?", (self.ident,)).fetchone()[0])

    def test_mp4_result_is_saved_for_its_scene_and_served_back(self):
        req = self.upload(MP4, note="versi pertama")
        self.assertEqual(req.status, 201, req.response)
        result = json.loads(req.response)["result"]
        self.assertEqual((result["sceneId"], result["status"], result["note"], result["type"]), ("s1", "kandidat", "versi pertama", "video/mp4"))
        self.assertEqual(result["size"], len(MP4))
        self.assertEqual(self.stored()["videoResults"][0]["id"], result["id"])
        get = Request("GET", result["url"]); get.do_GET()
        self.assertEqual(get.status, 200)
        self.assertEqual(get.response, MP4)

    def test_a_second_result_for_the_same_scene_keeps_the_first(self):
        first = json.loads(self.upload(MP4).response)["result"]
        second = json.loads(self.upload(MP4).response)["result"]
        self.assertNotEqual(first["url"], second["url"])
        ids = [item["id"] for item in self.stored()["videoResults"]]
        self.assertEqual(ids, [first["id"], second["id"]])
        self.assertEqual(len(self.files()), 2)

    def test_results_are_linked_to_the_scene_they_were_uploaded_for(self):
        json.loads(self.upload(MP4, scene="s1").response)
        json.loads(self.upload(WEBM, content_type="video/webm", scene="s2").response)
        results = self.stored()["videoResults"]
        self.assertEqual([(item["sceneId"], item["type"]) for item in results], [("s1", "video/mp4"), ("s2", "video/webm")])

    def test_wrong_bytes_for_the_declared_format_are_rejected_and_leave_no_file(self):
        req = self.upload(WEBM, content_type="video/mp4")
        self.assertEqual(req.status, 415)
        self.assertEqual(self.files(), [])
        self.assertEqual(self.stored().get("videoResults", []), [])

    def test_unsupported_content_types_are_rejected_and_leave_no_file(self):
        for content_type in ("image/png", "video/quicktime", "text/plain"):
            req = self.upload(MP4, content_type=content_type)
            self.assertEqual(req.status, 415, content_type)
        self.assertEqual(self.files(), [])

    def test_size_limit_is_checked_before_the_body_is_read(self):
        req = Request("POST", f"/api/projects/{self.ident}/video-results", MP4, {"Content-Type": "video/mp4", "X-Filename": "klip.mp4", "X-Scene-Id": "s1"})
        req.headers["Content-Length"] = str(app.MAX_VIDEO_BYTES + 1)
        with patch.object(app, "MAX_VIDEO_BYTES", len(MP4)):
            req.do_POST()
        self.assertEqual(req.status, 413)
        self.assertEqual(req.rfile.tell(), 0, "no body bytes were consumed")
        self.assertEqual(self.files(), [])

    def test_a_video_at_the_size_limit_is_accepted(self):
        with patch.object(app, "MAX_VIDEO_BYTES", len(MP4)):
            req = self.upload(MP4)
        self.assertEqual(req.status, 201)

    def test_truncated_body_leaves_no_file_and_no_result(self):
        req = self.upload(MP4, length=len(MP4) + 10)
        self.assertEqual(req.status, 400)
        self.assertEqual(self.files(), [])
        self.assertEqual(self.stored().get("videoResults", []), [])

    def test_empty_body_is_rejected(self):
        req = self.upload(b"", length=0)
        self.assertEqual(req.status, 400)
        self.assertEqual(self.files(), [])

    def test_unknown_project_and_unknown_scene_leave_no_file(self):
        req = self.upload(MP4, ident=MISSING_PROJECT)
        self.assertEqual(req.status, 404)
        self.assertEqual(self.files(), [])
        req = self.upload(MP4, scene="s-tidak-ada")
        self.assertEqual(req.status, 400)
        self.assertEqual(self.files(), [])

    def test_a_database_failure_removes_the_newly_written_video(self):
        with sqlite3.connect(self.db) as db:
            db.execute("CREATE TRIGGER fail_video BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'gagal'); END")
        req = self.upload(MP4)
        self.assertEqual(req.status, 500)
        self.assertEqual(self.files(), [])

    def test_a_long_note_is_rejected_on_upload(self):
        req = self.upload(MP4, note="x" * (app.MAX_RESULT_NOTE + 1))
        self.assertEqual(req.status, 400)
        self.assertEqual(self.files(), [])

    def test_choosing_a_main_result_demotes_the_previous_main_result_of_that_scene_only(self):
        a = json.loads(self.upload(MP4, scene="s1").response)["result"]
        b = json.loads(self.upload(MP4, scene="s1").response)["result"]
        c = json.loads(self.upload(MP4, scene="s2").response)["result"]
        for result in (a, c):
            req = Request("PUT", f"/api/projects/{self.ident}/video-results/{result['id']}", json.dumps({"status": "utama"}).encode())
            req.do_PUT(); self.assertEqual(req.status, 200)
        req = Request("PUT", f"/api/projects/{self.ident}/video-results/{b['id']}", json.dumps({"status": "utama"}).encode())
        req.do_PUT(); self.assertEqual(req.status, 200)
        statuses = {item["id"]: item["status"] for item in self.stored()["videoResults"]}
        self.assertEqual(statuses, {a["id"]: "kandidat", b["id"]: "utama", c["id"]: "utama"})

    def test_status_note_and_unknown_result_are_validated(self):
        result = json.loads(self.upload(MP4).response)["result"]
        bad = Request("PUT", f"/api/projects/{self.ident}/video-results/{result['id']}", json.dumps({"status": "selesai"}).encode())
        bad.do_PUT(); self.assertEqual(bad.status, 400)
        long = Request("PUT", f"/api/projects/{self.ident}/video-results/{result['id']}", json.dumps({"note": "x" * (app.MAX_RESULT_NOTE + 1)}).encode())
        long.do_PUT(); self.assertEqual(long.status, 400)
        missing = Request("PUT", f"/api/projects/{self.ident}/video-results/tidak-ada", json.dumps({"status": "revisi"}).encode())
        missing.do_PUT(); self.assertEqual(missing.status, 404)
        ok = Request("PUT", f"/api/projects/{self.ident}/video-results/{result['id']}", json.dumps({"status": "revisi", "note": "wajah terlalu gelap"}).encode())
        ok.do_PUT(); self.assertEqual(ok.status, 200)
        saved = self.stored()["videoResults"][0]
        self.assertEqual((saved["status"], saved["note"]), ("revisi", "wajah terlalu gelap"))

    def test_autosave_cannot_add_remove_or_overwrite_server_results(self):
        result = json.loads(self.upload(MP4).response)["result"]
        forged = {"id": "palsu", "sceneId": "s1", "url": "/uploads/palsu.mp4", "status": "utama", "name": "palsu.mp4"}
        self.put_project({"scenes": [{"id": "s1", "title": "Pertemuan"}, {"id": "s2", "title": "Dapur"}], "assets": [], "videoResults": [forged]})
        results = self.stored()["videoResults"]
        self.assertEqual([item["id"] for item in results], [result["id"]], "the client snapshot cannot add a result")
        self.put_project({"scenes": [], "assets": []})
        self.assertEqual([item["id"] for item in self.stored()["videoResults"]], [result["id"]], "a snapshot without results cannot remove them")

    def test_project_snapshot_response_includes_the_saved_results(self):
        result = json.loads(self.upload(MP4).response)["result"]
        response = self.put_project({"scenes": [{"id": "s1"}], "assets": []})
        self.assertEqual([item["id"] for item in response["data"]["videoResults"]], [result["id"]])

    def test_a_legacy_project_without_results_reads_and_saves_without_error(self):
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps({"scenes": [{"id": "s1"}], "assets": []}), self.ident))
        get = Request("GET", f"/api/projects/{self.ident}"); get.do_GET()
        self.assertEqual(get.status, 200)
        self.assertEqual(json.loads(get.response)["data"]["videoResults"], [])
        result_req = self.upload(MP4)
        self.assertEqual(result_req.status, 201)

    def test_head_reports_whether_an_uploaded_video_exists_without_sending_its_bytes(self):
        result = json.loads(self.upload(MP4).response)["result"]
        head = Request("HEAD", result["url"]); head.do_HEAD()
        self.assertEqual(head.status, 200)
        self.assertEqual(head.response, b"")
        self.assertEqual(head.response_headers["Content-Length"], str(len(MP4)))
        self.assertEqual(head.response_headers["Content-Type"], "video/mp4")
        Path(self.uploads, Path(result["url"]).name).unlink()
        gone = Request("HEAD", result["url"]); gone.do_HEAD()
        self.assertEqual(gone.status, 404)

    def test_a_result_whose_file_is_gone_cannot_become_the_main_result(self):
        result = json.loads(self.upload(MP4).response)["result"]
        Path(self.uploads, Path(result["url"]).name).unlink()
        req = Request("PUT", f"/api/projects/{self.ident}/video-results/{result['id']}", json.dumps({"status": "utama"}).encode())
        req.do_PUT()
        self.assertEqual(req.status, 400)
        self.assertEqual(self.stored()["videoResults"][0]["status"], "kandidat", "the saved state is unchanged")
        req = Request("PUT", f"/api/projects/{self.ident}/video-results/{result['id']}", json.dumps({"status": "revisi"}).encode())
        req.do_PUT()
        self.assertEqual(req.status, 200, "a missing result can still be marked for revision")

    def test_the_scene_of_a_result_cannot_be_changed_by_an_update(self):
        result = json.loads(self.upload(MP4, scene="s1").response)["result"]
        req = Request("PUT", f"/api/projects/{self.ident}/video-results/{result['id']}", json.dumps({"sceneId": "s2", "url": "/uploads/palsu.mp4", "name": "palsu", "status": "revisi"}).encode())
        req.do_PUT()
        self.assertEqual(req.status, 200)
        saved = self.stored()["videoResults"][0]
        self.assertEqual((saved["sceneId"], saved["url"], saved["name"], saved["status"]), ("s1", result["url"], result["name"], "revisi"))

    def test_the_size_limit_matches_the_frontend_limit(self):
        frontend = (Path(__file__).resolve().parents[1] / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("const MAX_VIDEO_UPLOAD_BYTES=50_000_000;", frontend)
        self.assertEqual(app.MAX_VIDEO_BYTES, 50_000_000)

    def test_an_interrupted_upload_leaves_no_result_and_project_delete_clears_its_partial_file(self):
        partial = Path(self.uploads, f".{self.ident}.partial-abc123")
        partial.write_bytes(MP4[:20])
        self.assertEqual(self.stored().get("videoResults", []), [], "a partial file is never a saved result")
        req = Request("DELETE", f"/api/projects/{self.ident}"); req.do_DELETE()
        self.assertEqual(req.status, 204)
        self.assertFalse(partial.exists())

    def test_deleting_the_project_removes_its_result_files(self):
        json.loads(self.upload(MP4).response)
        self.assertEqual(len(self.files()), 1)
        req = Request("DELETE", f"/api/projects/{self.ident}"); req.do_DELETE()
        self.assertEqual(req.status, 204, req.response)
        self.assertEqual(self.files(), [])

if __name__ == "__main__":
    unittest.main()
