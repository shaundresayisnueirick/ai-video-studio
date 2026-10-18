import contextlib
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import production_package as pp
from test_production import LIMITS, PACKAGES, PHOTO, PLACE, PRODUCT, Request

MISSING_PROJECT = "00000000-0000-4000-8000-000000000000"


def valid_package(name, assets, links=None, target=None):
    """A normalized package, the same shape the client receives from /api/ai/production and sends back to save."""
    return pp.validate_package(copy.deepcopy(PACKAGES[name]), assets, LIMITS, target_seconds=target, links=links)


class StorageBase(unittest.TestCase):
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

    def create_project(self, assets=None, scenes=None):
        req = Request("POST", "/api/projects", json.dumps({"title": "Demo", "goal": "Iklan produk", "idea": "Kopi pagi"}).encode())
        req.do_POST()
        made = json.loads(req.response)
        req = Request("PUT", f"/api/projects/{made['id']}", json.dumps({**made, "data": {"assets": assets or [], "scenes": scenes or []}}).encode())
        req.do_PUT()
        self.assertEqual(req.status, 200)
        return json.loads(req.response)

    def save(self, ident, package, target=None):
        req = Request("PUT", f"/api/projects/{ident}/production-package", json.dumps({"package": package, "targetSeconds": target}).encode())
        req.do_PUT()
        return req

    def get(self, ident):
        req = Request("GET", f"/api/projects/{ident}")
        req.do_GET()
        self.assertEqual(req.status, 200)
        return json.loads(req.response)

    def raw_data(self, ident):
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            return db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0]

    def raw_envelope(self, ident):
        return json.loads(self.raw_data(ident)).get("productionPackage")


class StorageRoundTripTests(StorageBase):
    def test_full_package_survives_save_and_reload(self):
        project = self.create_project(assets=[PRODUCT, PLACE])
        package = valid_package("iklan produk", [PRODUCT, PLACE], target=15)
        req = self.save(project["id"], package, target=15)
        self.assertEqual(req.status, 200)
        view = self.get(project["id"])["data"]["productionPackage"]
        self.assertIsNone(view["error"])
        self.assertEqual(view["package"], valid_package("iklan produk", [PRODUCT, PLACE], target=15))
        self.assertEqual(view["targetSeconds"], 15)

    def test_camera_lighting_action_and_continuity_survive_reload(self):
        raw = copy.deepcopy(PACKAGES["edukasi"])
        raw["clips"][0]["camera"] = "medium shot"
        raw["clips"][0]["lighting"] = "cahaya pagi hangat"
        raw["clips"][0]["audio"]["plan"] = "narasi"
        package = pp.validate_package(raw, [], LIMITS, target_seconds=20)
        project = self.create_project()
        self.assertEqual(self.save(project["id"], package, target=20).status, 200)
        clips = self.get(project["id"])["data"]["productionPackage"]["package"]["clips"]
        self.assertEqual(clips[0]["camera"], "medium shot")
        self.assertEqual(clips[0]["lighting"], "cahaya pagi hangat")
        self.assertEqual(clips[0]["action"], "aksi")
        self.assertEqual(clips[1]["continues_from"], 1)
        self.assertEqual(clips[0]["audio"]["plan"], "narasi")
        self.assertEqual(clips[0]["prompt_final"], package["clips"][0]["prompt_final"])

    def test_references_and_image_links_survive_reload(self):
        project = self.create_project(assets=[PHOTO])
        package = valid_package("drama keluarga", [PHOTO], links={"img-ibu": "a-foto"}, target=18)
        self.assertEqual(self.save(project["id"], package, target=18).status, 200)
        stored = self.get(project["id"])["data"]["productionPackage"]["package"]
        requirement = stored["image_requirements"][0]
        self.assertEqual(requirement["asset_id"], "a-foto")
        self.assertEqual(requirement["status"], "uploaded")
        self.assertEqual(stored["clips"][0]["references"], [{"kind": "requirement", "id": "img-ibu", "role": "karakter"}])
        self.assertEqual(stored["upload_checklist"][0]["status"], "uploaded")

    def test_requirements_without_links_stay_needed_and_never_claim_generated_images(self):
        project = self.create_project()
        package = valid_package("edukasi", [])
        self.assertEqual(self.save(project["id"], package).status, 200)
        requirement = self.get(project["id"])["data"]["productionPackage"]["package"]["image_requirements"][0]
        self.assertEqual(requirement["status"], "needed")
        self.assertEqual(requirement["generation"], "manual")
        self.assertIsNone(requirement["asset_id"])
        self.assertEqual(set(requirement), {"id", "purpose", "subject", "description", "generation", "asset_id", "status"})

    def test_envelope_stores_schema_version_target_and_timestamp(self):
        project = self.create_project()
        self.save(project["id"], valid_package("cerita lucu", []), target=12)
        envelope = self.raw_envelope(project["id"])
        self.assertEqual(envelope["schemaVersion"], 1)
        self.assertEqual(envelope["targetSeconds"], 12)
        self.assertTrue(envelope["savedAt"])
        self.assertEqual(envelope["package"]["model"], "flow-default")


class StorageValidationTests(StorageBase):
    def test_invalid_package_is_rejected_and_previous_save_is_kept(self):
        project = self.create_project()
        first = valid_package("cerita lucu", [])
        self.assertEqual(self.save(project["id"], first).status, 200)
        before = self.raw_data(project["id"])
        broken = valid_package("sejarah", [])
        broken["image_requirements"].append(copy.deepcopy(broken["image_requirements"][0]))
        req = self.save(project["id"], broken)
        self.assertEqual(req.status, 400)
        self.assertIn("dipakai lebih dari sekali", json.loads(req.response)["error"])
        self.assertEqual(self.raw_data(project["id"]), before)

    def test_link_to_asset_missing_from_project_is_rejected(self):
        project = self.create_project(assets=[])
        package = valid_package("drama keluarga", [PHOTO], links={"img-ibu": "a-foto"})
        req = self.save(project["id"], package)
        self.assertEqual(req.status, 400)
        self.assertIn("tidak ada di daftar unggahan", json.loads(req.response)["error"])
        self.assertIsNone(self.raw_envelope(project["id"]))

    def test_clip_longer_than_limit_is_rejected(self):
        project = self.create_project()
        package = valid_package("edukasi", [])
        package["clips"][0]["duration_seconds"] = 15
        req = self.save(project["id"], package)
        self.assertEqual(req.status, 400)
        self.assertIn("melebihi batas", json.loads(req.response)["error"])

    def test_unknown_model_is_rejected(self):
        project = self.create_project()
        package = valid_package("edukasi", [])
        package["model"] = "tidak-ada"
        self.assertEqual(self.save(project["id"], package).status, 400)

    def test_invalid_target_seconds_is_rejected(self):
        project = self.create_project()
        package = valid_package("edukasi", [])
        for bad in ("15", True, 0, 601, 1.5):
            req = Request("PUT", f"/api/projects/{project['id']}/production-package", json.dumps({"package": package, "targetSeconds": bad}).encode())
            req.do_PUT()
            self.assertEqual(req.status, 400, bad)
        self.assertIsNone(self.raw_envelope(project["id"]))

    def test_saving_to_missing_project_returns_404(self):
        req = self.save(MISSING_PROJECT, valid_package("edukasi", []))
        self.assertEqual(req.status, 404)

    def test_package_without_clips_is_rejected(self):
        project = self.create_project()
        package = valid_package("edukasi", [])
        package["clips"] = []
        self.assertEqual(self.save(project["id"], package).status, 400)


class ExistingDataTests(StorageBase):
    def test_legacy_project_without_package_loads_unchanged(self):
        legacy_scenes = [{"id": "s1", "title": "Pembuka", "visual": "Pasar pagi", "dialogue": "Halo"}]
        project = self.create_project(scenes=legacy_scenes)
        loaded = self.get(project["id"])
        self.assertIsNone(loaded["data"].get("productionPackage"))
        self.assertEqual(loaded["data"]["scenes"][0]["title"], "Pembuka")
        self.assertEqual(loaded["data"]["scenes"][0]["visualDescription"], "Pasar pagi")

    def test_autosave_put_cannot_overwrite_saved_package(self):
        project = self.create_project()
        self.save(project["id"], valid_package("cerita lucu", []), target=12)
        saved = self.raw_envelope(project["id"])
        # Autosave sends a snapshot without the package, or with an old null value.
        req = Request("PUT", f"/api/projects/{project['id']}", json.dumps({**project, "data": {"scenes": [], "productionPackage": None}}).encode())
        req.do_PUT()
        self.assertEqual(req.status, 200)
        self.assertEqual(json.loads(req.response)["data"]["productionPackage"]["package"]["concept"], saved["package"]["concept"])
        self.assertEqual(self.raw_envelope(project["id"]), saved)

    def test_client_supplied_package_in_autosave_is_ignored_when_none_saved(self):
        project = self.create_project()
        fake = {"schemaVersion": 1, "package": {"clips": []}}
        req = Request("PUT", f"/api/projects/{project['id']}", json.dumps({**project, "data": {"scenes": [], "productionPackage": fake}}).encode())
        req.do_PUT()
        self.assertIsNone(json.loads(req.response)["data"].get("productionPackage"))
        self.assertIsNone(self.raw_envelope(project["id"]))

    def test_saving_null_clears_the_package(self):
        project = self.create_project()
        self.save(project["id"], valid_package("cerita lucu", []))
        req = self.save(project["id"], None)
        self.assertEqual(req.status, 200)
        self.assertIsNone(json.loads(req.response)["data"].get("productionPackage"))
        self.assertNotIn("productionPackage", json.loads(self.raw_data(project["id"])))

    def test_corrupt_stored_package_is_reported_and_kept(self):
        project = self.create_project()
        corrupt = {"schemaVersion": 1, "savedAt": "2026-10-01T00:00:00+00:00", "targetSeconds": None, "package": {"concept": "x", "clips": "bukan daftar"}}
        self.write_raw_package(project["id"], corrupt)
        view = self.get(project["id"])["data"]["productionPackage"]
        self.assertIsNone(view["package"])
        self.assertIn("tidak lolos validasi", view["error"])
        self.assertEqual(self.raw_envelope(project["id"]), corrupt)

    def test_unknown_schema_version_is_reported_and_kept(self):
        project = self.create_project()
        future = {"schemaVersion": 99, "package": {}}
        self.write_raw_package(project["id"], future)
        view = self.get(project["id"])["data"]["productionPackage"]
        self.assertIsNone(view["package"])
        self.assertIn("tidak dikenali", view["error"])
        self.assertEqual(self.raw_envelope(project["id"]), future)

    def test_removed_upload_makes_stored_package_report_an_error_and_keeps_data(self):
        project = self.create_project(assets=[PRODUCT, PLACE])
        self.save(project["id"], valid_package("iklan produk", [PRODUCT, PLACE]))
        saved = self.raw_envelope(project["id"])
        # Autosave without the package, with the assets list emptied.
        req = Request("PUT", f"/api/projects/{project['id']}", json.dumps({**project, "data": {"assets": [], "scenes": []}}).encode())
        req.do_PUT()
        view = json.loads(req.response)["data"]["productionPackage"]
        self.assertIsNone(view["package"])
        self.assertIn("tidak lolos validasi", view["error"])
        self.assertEqual(self.raw_envelope(project["id"]), saved)

    def test_project_list_survives_an_invalid_stored_package(self):
        healthy = self.create_project()
        broken = self.create_project()
        self.save(healthy["id"], valid_package("edukasi", []))
        self.write_raw_package(broken["id"], {"schemaVersion": 1, "package": None})
        req = Request("GET", "/api/projects")
        req.do_GET()
        self.assertEqual(req.status, 200)
        items = {item["id"]: item["data"]["productionPackage"] for item in json.loads(req.response)}
        self.assertIsNotNone(items[healthy["id"]]["package"])
        self.assertIsNone(items[broken["id"]]["package"])
        self.assertIsNotNone(items[broken["id"]]["error"])

    def write_raw_package(self, ident, envelope):
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            data = json.loads(db.execute("SELECT data FROM projects WHERE id=?", (ident,)).fetchone()[0])
            data["productionPackage"] = envelope
            db.execute("UPDATE projects SET data=? WHERE id=?", (json.dumps(data, ensure_ascii=False), ident))
            db.commit()


class SaveFailureTests(StorageBase):
    def test_database_failure_during_save_keeps_project_unchanged(self):
        project = self.create_project(scenes=[{"id": "s1", "title": "Pembuka"}])
        before = self.raw_data(project["id"])
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            db.execute("CREATE TRIGGER fail_package_save BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'simulasi gagal'); END")
            db.commit()
        try:
            req = self.save(project["id"], valid_package("edukasi", []))
        finally:
            with contextlib.closing(sqlite3.connect(self.db)) as db:
                db.execute("DROP TRIGGER fail_package_save")
                db.commit()
        self.assertEqual(req.status, 500)
        self.assertIn("Data proyek tidak berubah", json.loads(req.response)["error"])
        self.assertEqual(self.raw_data(project["id"]), before)
        self.assertIsNone(self.get(project["id"])["data"].get("productionPackage"))


if __name__ == "__main__":
    unittest.main()
