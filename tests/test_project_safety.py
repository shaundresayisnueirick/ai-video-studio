import json
import sqlite3
import tempfile
import unittest
from contextlib import closing, contextmanager
from pathlib import Path
from unittest.mock import patch

import app
from tests import test_api
from tests.test_api import MISSING_PROJECT, Request

MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
RESULT_ID = "11111111-1111-4111-8111-111111111111"


class ProjectSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        root = Path(self.tmp.name)
        self.db = root / "test.sqlite3"
        self.uploads = root / "uploads"
        self.uploads.mkdir()
        self.patches = [patch.object(app, "DB", self.db), patch.object(app, "UPLOADS", self.uploads)]
        for item in self.patches: item.start()
        app.init_db()
        self.ident = self.create_project()
        self.other = self.create_project()
        self.put_project(self.ident, {"scenes": [{"id": "s1", "title": "Pertemuan"}], "assets": []})

    def tearDown(self):
        for item in self.patches: item.stop()
        self.tmp.cleanup()

    def create_project(self):
        req = Request("POST", "/api/projects", json.dumps({"title": "Pengaman"}).encode())
        req.do_POST()
        self.assertEqual(req.status, 201, req.response)
        return json.loads(req.response)["id"]

    def put_project(self, ident, data, extra=None):
        body = {"title": "Pengaman", "goal": "Video cerita atau film pendek", "idea": "", "platform": "flow", "data": data, **(extra or {})}
        req = Request("PUT", f"/api/projects/{ident}", json.dumps(body).encode())
        req.do_PUT()
        return req

    def write_files(self, ident):
        names = [f"{ident}-hasil.mp4", f".{ident}.partial-tertinggal", f"{ident}-aset.png"]
        for name in names: (self.uploads / name).write_bytes(name.encode())
        return names

    def snapshot(self):
        return {path.name: path.read_bytes() for path in self.uploads.iterdir()}

    def stored(self, ident):
        with closing(sqlite3.connect(self.db)) as db:
            row = db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()
        return json.loads(row[0]) if row else None

    # --- Penghapusan proyek -------------------------------------------------

    def test_deleting_a_project_removes_only_its_own_files(self):
        mine = self.write_files(self.ident)
        theirs = self.write_files(self.other)
        before = self.snapshot()
        req = Request("DELETE", f"/api/projects/{self.ident}")
        req.do_DELETE()
        self.assertEqual(req.status, 204)
        self.assertIsNone(self.stored(self.ident))
        self.assertIsNotNone(self.stored(self.other))
        for name in mine: self.assertFalse((self.uploads / name).exists(), name)
        for name in theirs: self.assertEqual((self.uploads / name).read_bytes(), before[name], name)

    def test_wildcard_and_malformed_ids_remove_no_file(self):
        self.write_files(self.ident)
        self.write_files(self.other)
        before = self.snapshot()
        cases = [("/api/projects/*", 400), (f"/api/projects/{self.ident.upper()}", 400),
                 (f"/api/projects/{self.ident.replace('-', '')}", 400), (f"/api/projects/{self.ident[:8]}*", 400),
                 ("/api/projects/..", 400), ("/api/projects/", 400), (f"/api/projects/{self.ident}/x", 404)]
        for path, expected in cases:
            with self.subTest(path=path):
                req = Request("DELETE", path)
                req.do_DELETE()
                self.assertEqual(req.status, expected, req.response)
                self.assertEqual(self.snapshot(), before)
        self.assertIsNotNone(self.stored(self.ident))
        self.assertIsNotNone(self.stored(self.other))

    def test_unknown_valid_id_returns_404_and_keeps_other_projects_files(self):
        self.write_files(self.other)
        before = self.snapshot()
        req = Request("DELETE", f"/api/projects/{MISSING_PROJECT}")
        req.do_DELETE()
        self.assertEqual(req.status, 404)
        self.assertEqual(self.snapshot(), before)
        self.assertIsNotNone(self.stored(self.other))

    def test_deleting_an_already_deleted_project_returns_404_and_keeps_other_files(self):
        self.write_files(self.other)
        before = self.snapshot()
        first = Request("DELETE", f"/api/projects/{self.ident}")
        first.do_DELETE()
        self.assertEqual(first.status, 204)
        again = Request("DELETE", f"/api/projects/{self.ident}")
        again.do_DELETE()
        self.assertEqual(again.status, 404)
        self.assertEqual({name: data for name, data in self.snapshot().items() if name in before}, before)

    def test_valid_delete_keeps_previous_behaviour(self):
        names = self.write_files(self.ident)
        req = Request("DELETE", f"/api/projects/{self.ident}")
        req.do_DELETE()
        self.assertEqual((req.status, req.response), (204, b""))
        get = Request("GET", f"/api/projects/{self.ident}")
        get.do_GET()
        self.assertEqual(get.status, 404)
        self.assertFalse(any(name in self.snapshot() for name in names))
        other = Request("GET", f"/api/projects/{self.other}")
        other.do_GET()
        self.assertEqual(other.status, 200)

    # --- Id proyek tidak valid di endpoint lain -----------------------------

    def test_malformed_ids_are_rejected_on_every_project_route_without_writing_files(self):
        png = test_api.ApiSmokeTests.png()
        before = self.snapshot()
        for bad in ["*", self.ident.upper()]:
            routes = [
                ("POST", f"/api/projects/{bad}/video-results", MP4, {"Content-Type": "video/mp4", "X-Scene-Id": "s1"}),
                ("POST", f"/api/projects/{bad}/assets", png, {"Content-Type": "image/png"}),
                ("PUT", f"/api/projects/{bad}/video-results/{RESULT_ID}", b'{"status":"revisi"}', {}),
                ("PUT", f"/api/projects/{bad}/production-package", b'{"package":null}', {}),
                ("PUT", f"/api/projects/{bad}", b'{"data":{}}', {}),
                ("DELETE", f"/api/projects/{bad}/assets/{RESULT_ID}", b"", {}),
            ]
            for method, path, body, headers in routes:
                with self.subTest(method=method, path=path):
                    req = Request(method, path, body, headers)
                    {"POST": req.do_POST, "PUT": req.do_PUT, "DELETE": req.do_DELETE}[method]()
                    self.assertEqual(req.status, 400, req.response)
                    self.assertEqual(self.snapshot(), before)

    # --- Balapan autosave dan unggahan ------------------------------------

    @contextmanager
    def competing_change_during_handler_read(self, mutate):
        """Makes a change from a second SQLite connection between the handler's read and its write.

        The handler reads the project row first. Right after that read, a second connection tries to commit
        `mutate`. If the handler holds the write lock, that attempt fails fast and is retried once the handler
        has finished. If the handler does not hold it, the change lands in the middle and the handler's
        later write overwrites it."""
        real_connect = app.connect
        state = {"armed": True, "blocked": False}

        def commit_change(timeout):
            with closing(sqlite3.connect(self.db, timeout=timeout)) as db:
                db.execute("BEGIN IMMEDIATE")
                data = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (self.ident,)).fetchone()[0])
                mutate(data)
                db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), self.ident))
                db.commit()

        class Rows:
            def __init__(self, rows): self.rows = rows
            def fetchone(self): return self.rows[0] if self.rows else None

        class Spy:
            def __init__(self, db): self.db = db
            def execute(self, sql, params=()):
                cursor = self.db.execute(sql, params)
                if not (state["armed"] and sql.startswith("SELECT data FROM projects")): return cursor
                rows = cursor.fetchall()
                state["armed"] = False
                try:
                    commit_change(timeout=0.2)
                except sqlite3.OperationalError:
                    state["blocked"] = True
                return Rows(rows)
            def __getattr__(self, name): return getattr(self.db, name)

        @contextmanager
        def spy_connect():
            with real_connect() as db: yield Spy(db)

        with patch.object(app, "connect", spy_connect):
            yield
        if state["blocked"]: commit_change(timeout=5)

    def video_result(self, status="kandidat", url=None):
        return {"id": RESULT_ID, "sceneId": "s1", "name": "klip.mp4", "url": url or "/uploads/missing.mp4", "type": "video/mp4",
                "size": len(MP4), "addedAt": "2026-10-18T00:00:00+00:00", "note": "", "status": status}

    def test_autosave_does_not_overwrite_a_video_result_committed_during_its_read(self):
        name = f"{self.ident}-hasil.mp4"
        (self.uploads / name).write_bytes(MP4)
        result = self.video_result("utama", f"/uploads/{name}")

        def add_result(data):
            data["videoResults"] = [result]

        with self.competing_change_during_handler_read(add_result):
            req = self.put_project(self.ident, {"scenes": [{"id": "s1", "title": "Pertemuan"}], "assets": []})
        self.assertEqual(req.status, 200, req.response)
        stored = self.stored(self.ident)
        self.assertEqual([(item["id"], item["status"]) for item in stored["videoResults"]], [(RESULT_ID, "utama")])
        self.assertTrue((self.uploads / name).exists())

    def test_asset_upload_does_not_overwrite_a_video_result_committed_during_its_read(self):
        def add_result(data):
            data["videoResults"] = [self.video_result()]

        req = Request("POST", f"/api/projects/{self.ident}/assets", test_api.ApiSmokeTests.png(), {"Content-Type": "image/png", "X-Filename": "ref.png"})
        with self.competing_change_during_handler_read(add_result):
            req.do_POST()
        self.assertEqual(req.status, 201, req.response)
        stored = self.stored(self.ident)
        self.assertEqual([item["id"] for item in stored["videoResults"]], [RESULT_ID])
        self.assertEqual(len(stored["assets"]), 1)

    def test_production_package_save_does_not_overwrite_a_video_result_committed_during_its_read(self):
        def add_result(data):
            data["videoResults"] = [self.video_result()]

        req = Request("PUT", f"/api/projects/{self.ident}/production-package", b'{"package":null}', {})
        with self.competing_change_during_handler_read(add_result):
            req.do_PUT()
        self.assertEqual(req.status, 200, req.response)
        self.assertEqual([item["id"] for item in self.stored(self.ident)["videoResults"]], [RESULT_ID])

    def test_normal_autosave_saves_fields_and_keeps_stored_video_results(self):
        with closing(sqlite3.connect(self.db)) as db:
            row = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (self.ident,)).fetchone()[0])
            row["videoResults"] = [self.video_result()]
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(row), self.ident))
            db.commit()
        req = self.put_project(self.ident, {"scenes": [{"id": "s1", "title": "Judul baru"}], "assets": [], "videoResults": []}, {"title": "Judul baru"})
        self.assertEqual(req.status, 200, req.response)
        body = json.loads(req.response)
        self.assertEqual(body["title"], "Judul baru")
        self.assertEqual(body["data"]["scenes"][0]["title"], "Judul baru")
        self.assertEqual([item["id"] for item in body["data"]["videoResults"]], [RESULT_ID])

    def test_failed_autosave_releases_the_write_lock(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("UPDATE projects SET data=? WHERE id=?", ("not json", self.ident))
            db.commit()
        req = Request("PUT", f"/api/projects/{self.ident}", json.dumps({"data": {}}).encode())
        with self.assertRaises(json.JSONDecodeError):
            req.do_PUT()
        with closing(sqlite3.connect(self.db, timeout=1)) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE projects SET title=? WHERE id=?", ("tetap bisa ditulis", self.other))
            db.commit()

    def test_autosave_to_missing_project_releases_the_write_lock(self):
        req = self.put_project(MISSING_PROJECT, {"scenes": [], "assets": []})
        self.assertEqual(req.status, 404)
        with closing(sqlite3.connect(self.db, timeout=1)) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE projects SET title=? WHERE id=?", ("tetap bisa ditulis", self.other))
            db.commit()


if __name__ == "__main__":
    unittest.main()
