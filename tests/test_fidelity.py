import copy
import json
import unittest
from unittest.mock import patch

import app
import production_package as pp
from test_production import CONFIRMED_UNDERSTANDING, LIMITS, PACKAGES, PHOTO, PLACE, PRODUCT, Request, gemini_raw
from test_production_storage import StorageBase, valid_package

KEY_ENV = {"GEMINI_API_KEY": "fake-test-key"}
CHARACTER_NOTE = "Rani, remaja berambut ikal, jaket kuning, selalu membawa payung merah"
WORLD_NOTE = "kota kecil setelah hujan, cahaya sore keemasan"
MESSAGE_NOTE = "keberanian kecil bisa mengubah hari orang lain"


def understanding_reply(**overrides):
    value = {
        "core": "Rani menolong kucing tersesat.", "message": MESSAGE_NOTE,
        "characters": ["Rani — remaja: penolong"], "locations": ["Kota kecil — sore hujan"],
        "sequence": ["1. Rani menemukan kucing"], "unclear": ["akhir cerita belum disebut"], "suggestions": ["musik latar lembut"],
    }
    value.update(overrides)
    return json.dumps(value, ensure_ascii=False)


def sent_prompt(mock):
    return json.loads(mock.call_args.args[0].data)["contents"][0]["parts"][0]["text"]


class PromptFidelityTests(unittest.TestCase):
    def test_story_prompt_carries_user_details_and_fidelity_rules(self):
        details = pp.project_details({"message": MESSAGE_NOTE, "character": CHARACTER_NOTE, "world": WORLD_NOTE})
        prompt = app.story_prompt("Rani menolong kucing", "Edukasi", "1 menit", "Dokumenter", details)
        for text in (MESSAGE_NOTE, CHARACTER_NOTE, WORLD_NOTE, "Aturan kesetiaan (wajib dipatuhi)", "Pertahankan inti cerita dan pesan utama"):
            self.assertIn(text, prompt)

    def test_empty_fields_are_not_invented(self):
        details = pp.project_details({"message": "", "character": "   "})
        block = pp.details_block(details)
        self.assertIn("belum ada yang diisi", block)
        self.assertNotIn("Pesan utama", block)
        self.assertNotIn("Tokoh dan tampilannya", block)

    def test_package_prompt_requires_both_languages_and_uses_the_confirmed_summary(self):
        details = pp.project_details({"character": CHARACTER_NOTE})
        prompt = pp.package_prompt("Rani menolong kucing", "Iklan", "1 menit", "Iklan bersih", [PRODUCT], LIMITS, details,
                                   dict(CONFIRMED_UNDERSTANDING))
        for text in ("prompt_en", "Bahasa Inggris", "Pemahaman ide yang sudah dikonfirmasi", "Kopi pagi yang hangat.", CHARACTER_NOTE):
            self.assertIn(text, prompt)

    def test_understanding_prompt_asks_only_for_a_summary(self):
        prompt = pp.understanding_prompt("Rani menolong kucing", "Cerita", "1 menit", "Sinematik natural", {})
        self.assertIn("Jangan membuat paket produksi", prompt)
        self.assertIn("Tambahan kreatif Anda hanya boleh masuk ke 'suggestions'", prompt)


class DetailsAndUnderstandingTests(unittest.TestCase):
    def test_project_details_keeps_only_filled_named_fields(self):
        details = pp.project_details({
            "message": "  ", "character": CHARACTER_NOTE, "world": "",
            "entities": {"characters": [{"id": "c1", "name": "Rani", "role": "", "appearance": "jaket kuning"}, {"id": "c2", "name": ""}], "locations": []},
        })
        self.assertEqual(details, {"character": CHARACTER_NOTE, "characters": [{"name": "Rani", "appearance": "jaket kuning"}]})

    def test_user_text_over_the_limit_is_refused_not_cut(self):
        with self.assertRaises(pp.ProductionPackageError) as context:
            pp.project_details({"character": "x" * (pp.MAX_DETAIL_CHARS + 1)})
        self.assertIn("terlalu panjang", str(context.exception))

    def test_understanding_over_the_limits_is_rejected(self):
        with self.assertRaises(pp.ProductionPackageError):
            pp.validate_understanding({"core": "inti", "sequence": ["x"] * (pp.MAX_UNDERSTANDING_ITEMS + 1)})
        with self.assertRaises(pp.ProductionPackageError):
            pp.validate_understanding({"core": "inti", "unclear": ["x" * (pp.MAX_UNDERSTANDING_ITEM_CHARS + 1)]})
        with self.assertRaises(pp.ProductionPackageError) as context:
            pp.validate_understanding({"message": "tanpa inti"})
        self.assertIn("Inti cerita wajib diisi", str(context.exception))

    def test_valid_understanding_is_returned_unchanged(self):
        value = json.loads(understanding_reply())
        self.assertEqual(pp.validate_understanding(value), {
            **value, "acceptedSuggestions": [], "goal": "", "recommendedStyle": "", "camera": [], "assetsNeeded": [], "questions": [],
        })

    def test_plan_fields_are_normalized_and_an_unknown_style_is_dropped(self):
        value = json.loads(understanding_reply())
        value.update({
            "goal": "Iklan kopi pagi", "recommended_style": "Animasi 3D", "camera": ["close-up tangan"],
            "assets_needed": ["foto produk"], "questions": ["Siapa tokoh utamanya?"],
        })
        normalized = pp.validate_understanding(value)
        self.assertEqual(normalized["goal"], "Iklan kopi pagi")
        self.assertEqual(normalized["recommendedStyle"], "Animasi 3D")
        self.assertEqual(normalized["camera"], ["close-up tangan"])
        self.assertEqual(normalized["assetsNeeded"], ["foto produk"])
        self.assertEqual(normalized["questions"], ["Siapa tokoh utamanya?"])
        value["recommended_style"] = "Gaya bebas buatan AI"
        self.assertEqual(pp.validate_understanding(value)["recommendedStyle"], "")

    def test_more_than_three_questions_are_refused_not_cut(self):
        value = json.loads(understanding_reply())
        value["questions"] = ["a?", "b?", "c?", "d?"]
        with self.assertRaises(pp.ProductionPackageError) as context:
            pp.validate_understanding(value)
        self.assertIn("maksimal 3", str(context.exception))

    def test_understanding_prompt_carries_answers_and_limits_questions(self):
        prompt = pp.understanding_prompt("Rani menolong kucing", "Cerita", "1 menit", "Sinematik natural", {}, "Tokohnya ibu tua")
        self.assertIn("Tokohnya ibu tua", prompt)
        self.assertIn("paling banyak 3 pertanyaan", prompt)
        self.assertNotIn("Jawaban pengguna", pp.understanding_prompt("Rani menolong kucing", "Cerita", "1 menit", "Sinematik natural", {}))

    def test_confirmed_plan_fields_reach_the_package_prompt_only_after_confirmation(self):
        confirmed = {**CONFIRMED_UNDERSTANDING, "goal": "Iklan kopi", "camera": ["close-up"], "assetsNeeded": ["foto produk"]}
        block = pp.understanding_block(confirmed)
        self.assertIn('"goal": "Iklan kopi"', block)
        self.assertIn('"camera"', block)
        self.assertIn('"assets_needed"', block)

    def test_confirmation_is_required_and_tied_to_the_saved_idea(self):
        with self.assertRaises(pp.ProductionPackageError) as context:
            pp.confirmed_understanding(None, "Rani menolong kucing")
        self.assertIn("Konfirmasi pemahaman", str(context.exception))
        draft = {**CONFIRMED_UNDERSTANDING, "status": "draft", "ideaAtConfirm": "Rani menolong kucing"}
        with self.assertRaises(pp.ProductionPackageError):
            pp.confirmed_understanding(draft, "Rani menolong kucing")
        changed = {**CONFIRMED_UNDERSTANDING, "ideaAtConfirm": "ide lama"}
        with self.assertRaises(pp.ProductionPackageError) as context:
            pp.confirmed_understanding(changed, "ide baru")
        self.assertIn("Ide sudah berubah", str(context.exception))
        self.assertEqual(pp.confirmed_understanding(CONFIRMED_UNDERSTANDING, "Iklan kopi pagi")["core"], "Kopi pagi yang hangat.")


class PackageFidelityTests(unittest.TestCase):
    def test_prompts_up_to_the_new_limit_are_accepted_and_longer_ones_are_refused(self):
        raw = copy.deepcopy(PACKAGES["cerita lucu"])
        raw["clips"][0]["prompt_final"] = "a" * 2500
        raw["clips"][0]["prompt_en"] = "b" * 2500
        self.assertEqual(len(pp.validate_package(raw, [], LIMITS, require_english=True)["clips"]), 2)
        raw["clips"][0]["prompt_en"] = "b" * (pp.MAX_PROMPT_CHARS + 1)
        with self.assertRaises(pp.ProductionPackageError) as context:
            pp.validate_package(raw, [], LIMITS, require_english=True)
        self.assertIn("Prompt Inggris klip 1", str(context.exception))

    def test_english_prompt_is_required_for_new_packages_only(self):
        raw = copy.deepcopy(PACKAGES["edukasi"])
        raw["clips"][0].pop("prompt_en")
        with self.assertRaises(pp.ProductionPackageError) as context:
            pp.validate_package(raw, [], LIMITS, require_english=True)
        self.assertIn("Prompt Inggris klip 1 wajib diisi", str(context.exception))
        self.assertEqual(len(pp.validate_package(raw, [], LIMITS)["clips"]), 2)

    def test_camera_lighting_audio_and_english_details_survive_storage(self):
        raw = copy.deepcopy(PACKAGES["edukasi"])
        raw["clips"][0].update({"camera": "close-up", "lighting": "cahaya pagi", "en": {"camera": "close-up", "lighting": "morning light", "audio_text": "narration", "action": "leaves", }})
        envelope = pp.prepare_for_storage(pp.validate_package(raw, [], LIMITS, require_english=True), [], None, "2026-10-17T00:00:00+00:00")
        clip = pp.view_for_project(envelope, [])["package"]["clips"][0]
        self.assertEqual((clip["camera"], clip["lighting"]), ("close-up", "cahaya pagi"))
        self.assertEqual(clip["en"]["lighting"], "morning light")
        self.assertEqual(clip["prompt_en"], raw["clips"][0]["prompt_en"])
        self.assertFalse(any("Prompt Inggris" in warning for warning in pp.view_for_project(envelope, [])["package"]["warnings"]))

    def test_saved_package_without_english_still_loads_with_a_warning(self):
        envelope = pp.prepare_for_storage(valid_package("edukasi", []), [], None, "2026-10-01T00:00:00+00:00")
        legacy = copy.deepcopy(envelope)
        legacy["package"]["clips"][0]["prompt_en"] = ""
        legacy["package"]["clips"][0]["en"] = {key: "" for key in pp.EN_DETAIL_KEYS}
        view = pp.view_for_project(legacy, [])
        self.assertIsNone(view["error"])
        self.assertEqual(view["package"]["clips"][0]["prompt_final"], legacy["package"]["clips"][0]["prompt_final"])
        self.assertTrue(any("sebelum prompt Inggris tersedia" in warning for warning in view["package"]["warnings"]))


class StoryDraftNoCutTests(unittest.TestCase):
    def scene(self, **fields):
        return {"title": "Adegan", "visual": "Hujan turun.", **fields}

    def test_text_at_the_limit_is_kept_in_full(self):
        draft = {"alternatives": [{"title": "A", "scenes": [self.scene(visual="v" * app.STORY_LIMITS["visual"])]}]}
        self.assertEqual(len(app.normalize_story_draft(draft)["alternatives"][0]["scenes"][0]["visual"]), app.STORY_LIMITS["visual"])

    def test_text_over_the_limit_is_refused_with_the_field_name(self):
        draft = {"alternatives": [{"title": "A", "scenes": [self.scene(visual="v" * (app.STORY_LIMITS["visual"] + 1))]}]}
        with self.assertRaises(ValueError) as context:
            app.normalize_story_draft(draft)
        self.assertIn("kolom visual terlalu panjang", str(context.exception))

    def test_nine_scenes_are_all_kept_and_too_many_are_refused(self):
        nine = {"alternatives": [{"title": "A", "scenes": [self.scene(title=f"Adegan {n}") for n in range(9)]}]}
        self.assertEqual(len(app.normalize_story_draft(nine)["alternatives"][0]["scenes"]), 9)
        many = {"alternatives": [{"title": "A", "scenes": [self.scene() for _ in range(app.MAX_STORY_SCENES + 1)]}]}
        with self.assertRaises(ValueError) as context:
            app.normalize_story_draft(many)
        self.assertIn(f"maksimal {app.MAX_STORY_SCENES}", str(context.exception))

    def test_more_than_three_alternatives_is_refused(self):
        draft = {"alternatives": [{"title": str(n), "scenes": [self.scene()]} for n in range(4)]}
        with self.assertRaises(ValueError) as context:
            app.normalize_story_draft(draft)
        self.assertIn("maksimal 3", str(context.exception))


class AiEndpointTests(StorageBase):
    def make_project(self, idea, data=None):
        req = Request("POST", "/api/projects", json.dumps({"title": "Uji", "goal": "Iklan produk", "idea": idea}).encode())
        req.do_POST()
        made = json.loads(req.response)
        req = Request("PUT", f"/api/projects/{made['id']}", json.dumps(
            {"title": "Uji", "goal": "Iklan produk", "idea": idea, "status": "Draft", "data": data or {"scenes": [], "assets": []}}).encode())
        req.do_PUT()
        self.assertEqual(req.status, 200)
        return json.loads(req.response)

    def call(self, path, body, reply=None, env=None):
        req = Request("POST", path, json.dumps(body).encode("utf-8"))
        with patch.dict(app.os.environ, env if env is not None else KEY_ENV), \
                patch.object(app.urllib.request, "urlopen", return_value=gemini_raw(reply or "{}")) as mock:
            req.do_POST()
        return req, mock

    def confirmed(self, idea, **extra):
        return {"scenes": [], "assets": [PRODUCT, PLACE, PHOTO], "message": MESSAGE_NOTE, "character": CHARACTER_NOTE, "world": WORLD_NOTE,
                "entities": {"characters": [{"id": "char-rani", "name": "Rani", "role": "remaja", "appearance": "jaket kuning"}], "locations": []},
                "understanding": {**json.loads(understanding_reply()), "status": "confirmed", "ideaAtConfirm": idea}, **extra}

    def test_understanding_request_carries_user_details_and_returns_a_validated_summary(self):
        req, mock = self.call("/api/ai/understanding", {"idea": "Rani menolong kucing", "goal": "Cerita", "duration": "1 menit",
                                                       "style": "Sinematik natural", "message": MESSAGE_NOTE, "character": CHARACTER_NOTE,
                                                       "world": WORLD_NOTE}, reply=understanding_reply())
        self.assertEqual(req.status, 200)
        understanding = json.loads(req.response)["understanding"]
        self.assertEqual(understanding["core"], "Rani menolong kucing tersesat.")
        prompt = sent_prompt(mock)
        for text in (CHARACTER_NOTE, WORLD_NOTE, MESSAGE_NOTE, "Aturan kesetiaan"):
            self.assertIn(text, prompt)

    def test_understanding_reply_that_breaks_the_rules_is_refused(self):
        req, _ = self.call("/api/ai/understanding", {"idea": "Rani"}, reply=understanding_reply(core=""))
        self.assertEqual(req.status, 502)
        self.assertIn("Pemahaman dari Gemini tidak valid", json.loads(req.response)["error"])

    def test_understanding_without_key_is_refused_without_calling_gemini(self):
        req, mock = self.call("/api/ai/understanding", {"idea": "Rani"}, env={"GEMINI_API_KEY": ""})
        self.assertEqual(req.status, 503)
        mock.assert_not_called()

    def test_package_needs_a_saved_project(self):
        req, mock = self.call("/api/ai/production", {"idea": "Rani", "goal": "Cerita", "duration": "1 menit"}, reply="{}")
        self.assertEqual(req.status, 400)
        self.assertIn("Simpan proyek", json.loads(req.response)["error"])
        mock.assert_not_called()

    def test_package_is_refused_until_the_understanding_is_confirmed(self):
        data = self.confirmed("Rani menolong kucing")
        data["understanding"]["status"] = "draft"
        project = self.make_project("Rani menolong kucing", data)
        req, mock = self.call("/api/ai/production", {"idea": "Rani menolong kucing", "project_id": project["id"], "duration": "1 menit"}, reply="{}")
        self.assertEqual(req.status, 400)
        self.assertIn("Konfirmasi pemahaman", json.loads(req.response)["error"])
        mock.assert_not_called()

    def test_package_is_refused_when_the_idea_changed_after_confirmation(self):
        project = self.make_project("Rani menolong kucing", self.confirmed("Rani menolong kucing"))
        req, mock = self.call("/api/ai/production", {"idea": "ide lain di layar", "project_id": project["id"], "duration": "1 menit"}, reply="{}")
        self.assertEqual(req.status, 409)
        mock.assert_not_called()
        project = self.make_project("Ide yang sudah diganti", self.confirmed("Rani menolong kucing"))
        req, mock = self.call("/api/ai/production", {"idea": "Ide yang sudah diganti", "project_id": project["id"], "duration": "1 menit"}, reply="{}")
        self.assertEqual(req.status, 400)
        self.assertIn("Ide sudah berubah", json.loads(req.response)["error"])
        mock.assert_not_called()

    def test_confirmed_summary_and_saved_details_reach_the_package_prompt(self):
        project = self.make_project("Rani menolong kucing", self.confirmed("Rani menolong kucing"))
        reply = json.dumps(PACKAGES["iklan produk"], ensure_ascii=False)
        req, mock = self.call("/api/ai/production", {"idea": "Rani menolong kucing", "project_id": project["id"], "goal": "Cerita", "duration": "1 menit"}, reply=reply)
        self.assertEqual(req.status, 200)
        prompt = sent_prompt(mock)
        for text in (CHARACTER_NOTE, WORLD_NOTE, MESSAGE_NOTE, "Rani — remaja: penolong", "Rani (remaja): jaket kuning", "Kota kecil", "prompt_en"):
            self.assertIn(text, prompt)
        self.assertNotIn("belum ada yang diisi", prompt)

    def test_package_without_an_english_prompt_is_reported(self):
        project = self.make_project("Rani menolong kucing", self.confirmed("Rani menolong kucing"))
        raw = copy.deepcopy(PACKAGES["iklan produk"])
        raw["clips"][0].pop("prompt_en")
        req, _ = self.call("/api/ai/production", {"idea": "Rani menolong kucing", "project_id": project["id"], "duration": "1 menit"}, reply=json.dumps(raw))
        self.assertEqual(req.status, 502)
        self.assertIn("Prompt Inggris klip 1", json.loads(req.response)["error"])

    def test_package_request_text_over_the_limit_is_refused_not_cut(self):
        project = self.make_project("Rani menolong kucing", self.confirmed("Rani menolong kucing"))
        req, mock = self.call("/api/ai/production", {"idea": "Rani menolong kucing", "project_id": project["id"], "goal": "g" * 101}, reply="{}")
        self.assertEqual(req.status, 400)
        self.assertIn("terlalu panjang", json.loads(req.response)["error"])
        mock.assert_not_called()

    def test_story_request_carries_user_details(self):
        reply = json.dumps({"alternatives": [{"title": "A", "logline": "l", "scenes": [{"title": "Adegan 1", "visual": "Hujan"}]}]}, ensure_ascii=False)
        req, mock = self.call("/api/ai/story", {"provider": "gemini", "idea": "Rani menolong kucing", "goal": "Cerita", "duration": "1 menit",
                                               "style": "Sinematik natural", "character": CHARACTER_NOTE, "world": WORLD_NOTE, "message": MESSAGE_NOTE}, reply=reply)
        self.assertEqual(req.status, 200)
        self.assertIn(CHARACTER_NOTE, sent_prompt(mock))

    def test_story_goal_over_the_limit_is_refused_not_cut(self):
        req, mock = self.call("/api/ai/story", {"provider": "gemini", "idea": "Rani", "goal": "g" * 101}, reply="{}")
        self.assertEqual(req.status, 400)
        mock.assert_not_called()

    def test_project_saved_before_this_change_still_loads(self):
        project = self.make_project("Ide lama", {"scenes": [{"title": "Lama"}], "assets": []})
        req = Request("GET", f"/api/projects/{project['id']}")
        req.do_GET()
        self.assertEqual(req.status, 200)
        loaded = json.loads(req.response)
        self.assertEqual(loaded["data"]["scenes"][0]["title"], "Lama")
        self.assertNotIn("understanding", loaded["data"])
        self.assertNotIn("productionPackage", loaded["data"])

    def test_autosave_keeps_the_saved_package_and_stores_the_understanding_it_sends(self):
        project = self.make_project("Rani menolong kucing", self.confirmed("Rani menolong kucing"))
        self.save(project["id"], valid_package("edukasi", []), target=20)
        saved = self.raw_envelope(project["id"])
        req = Request("PUT", f"/api/projects/{project['id']}", json.dumps({**project, "data": {"scenes": [], "assets": [],
                      "productionPackage": None, "understanding": {"status": "draft", "core": "Ringkasan baru"}}}).encode())
        req.do_PUT()
        self.assertEqual(self.raw_envelope(project["id"]), saved)
        self.assertEqual(json.loads(self.raw_data(project["id"]))["understanding"]["core"], "Ringkasan baru")

    def test_package_request_sends_only_accepted_suggestions_as_binding(self):
        project = self.make_project("Rani menolong kucing", self.confirmed("Rani menolong kucing", understanding={
            **json.loads(understanding_reply()), "status": "confirmed", "ideaAtConfirm": "Rani menolong kucing",
            "suggestions": ["Usulan A unik", "Usulan B unik"], "acceptedSuggestions": ["Usulan A unik"]}))
        reply = json.dumps(PACKAGES["iklan produk"], ensure_ascii=False)
        req, mock = self.call("/api/ai/production", {"idea": "Rani menolong kucing", "project_id": project["id"], "duration": "1 menit"}, reply=reply)
        self.assertEqual(req.status, 200)
        prompt = sent_prompt(mock)
        self.assertIn("Usulan A unik", prompt)
        self.assertNotIn("Usulan B unik", prompt)


class SuggestionDecisionTests(unittest.TestCase):
    def summary(self, **overrides):
        return {**json.loads(understanding_reply()), **overrides}

    def test_unaccepted_suggestions_are_not_part_of_the_binding_block(self):
        validated = pp.validate_understanding(self.summary(suggestions=["Usulan A unik", "Usulan B unik"], acceptedSuggestions=["Usulan A unik"]))
        prompt = pp.package_prompt("Rani", "Cerita", "1 menit", "Sinematik natural", [], LIMITS, {}, validated)
        self.assertIn("Usulan A unik", prompt)
        self.assertNotIn("Usulan B unik", prompt)

    def test_with_no_accepted_suggestion_none_is_binding(self):
        validated = pp.validate_understanding(self.summary(suggestions=["Usulan B unik"], acceptedSuggestions=[]))
        prompt = pp.package_prompt("Rani", "Cerita", "1 menit", "Sinematik natural", [], LIMITS, {}, validated)
        self.assertIn('"accepted_suggestions": []', prompt)
        self.assertNotIn("Usulan B unik", prompt)

    def test_accepted_suggestion_must_come_from_the_suggestion_list(self):
        with self.assertRaises(pp.ProductionPackageError) as context:
            pp.validate_understanding(self.summary(suggestions=["A"], acceptedSuggestions=["X"]))
        self.assertIn("daftar usulan AI", str(context.exception))

    def test_older_summaries_without_decisions_still_validate(self):
        validated = pp.validate_understanding({"core": "Inti", "suggestions": ["A"]})
        self.assertEqual(validated["acceptedSuggestions"], [])


if __name__ == "__main__":
    unittest.main()


class AssetDisclosureTests(unittest.TestCase):
    def test_package_prompt_sends_asset_id_and_type_but_never_the_file_name(self):
        assets = [{"id": "a1", "name": "rahasia-wajah.png", "type": "Karakter"}]
        prompt = pp.package_prompt("Rani menolong kucing", "Cerita", "1 menit", "Sinematik natural", assets,
                                   pp.model_limits("flow-default"), {}, CONFIRMED_UNDERSTANDING)
        self.assertIn("id: a1 | jenis: Karakter", prompt)
        self.assertNotIn("rahasia-wajah", prompt)
