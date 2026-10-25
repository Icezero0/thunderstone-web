"""Personal settings, image storage and live public player profiles."""

from io import BytesIO
from pathlib import Path
import unittest
from unittest.mock import patch

from PIL import Image

from backend.app.modules.users.avatars import MAX_AVATAR_BYTES
from backend.tests.support.matches import MatchApiFixture
from backend.tests.support.setup import config


def image_file(color="blue", fmt="PNG"):
    output = BytesIO()
    Image.new("RGB", (96, 64), color).save(output, format=fmt)
    return output.getvalue()


class ProfileApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = MatchApiFixture()
        cls.f = cls.fixture.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.__exit__(None, None, None)

    def upload(self, account, content=None, content_type="image/png"):
        return self.f.client.patch("/api/v1/users/me/avatar", headers=account["headers"],
            files={"file": ("avatar.png", image_file() if content is None else content, content_type)})

    def test_hand_sort_preference_is_private_persistent_and_strictly_boolean(self):
        account, other = self.f.account(), self.f.account()
        url = "/api/v1/users/me"
        self.assertFalse(self.f.client.get(url, headers=account["headers"]).json()["auto_sort_hand"])
        self.assertEqual(self.f.client.patch(url, json={"auto_sort_hand": True}).status_code, 401)
        for invalid in (None, 1, "true", [], {}):
            self.assertEqual(self.f.client.patch(url, headers=account["headers"], json={"auto_sort_hand": invalid}).status_code, 422)
        saved = self.f.successful(self.f.client.patch(url, headers=account["headers"], json={"auto_sort_hand": True}))
        self.assertTrue(saved["auto_sort_hand"])
        self.assertTrue(self.f.client.get(url, headers=account["headers"]).json()["auto_sort_hand"])
        self.assertFalse(self.f.client.get(url, headers=other["headers"]).json()["auto_sort_hand"])
        self.f.client.patch(url, headers=account["headers"], json={"username": "New name"})
        self.assertTrue(self.f.client.get(url, headers=account["headers"]).json()["auto_sort_hand"])
        self.f.client.patch(url, headers=account["headers"], json={"auto_sort_hand": False})
        self.assertFalse(self.f.client.get(url, headers=account["headers"]).json()["auto_sort_hand"])

    def test_name_changes_keep_email_readonly_and_tokens_valid(self):
        account = self.f.account("原名称")
        denied = self.f.client.patch("/api/v1/users/me", headers=account["headers"],
                                     json={"email": "changed@example.com", "username": "不应保存"})
        self.assertEqual(denied.status_code, 422)
        current = self.f.client.get("/api/v1/users/me", headers=account["headers"]).json()
        self.assertEqual(current["email"], account["email"])
        self.assertEqual(current["username"], "原名称")
        self.assertIsNone(current["avatar_url"])
        changed = self.f.successful(self.f.client.patch("/api/v1/users/me", headers=account["headers"],
                                                         json={"username": " 新名称 "}))
        self.assertEqual(changed["username"], "新名称")
        self.assertNotIn("hashed_password", changed)
        self.assertNotIn("avatar_key", changed)
        self.assertEqual(self.f.client.get("/api/v1/users/me", headers=account["headers"]).status_code, 200)

    def test_upload_is_authenticated_normalized_persisted_and_replaces_old_file(self):
        account, other = self.f.account(), self.f.account()
        self.assertEqual(self.f.client.patch("/api/v1/users/me/avatar", files={
            "file": ("avatar.png", image_file(), "image/png")}).status_code, 401)
        saved = self.f.successful(self.upload(account, image_file(fmt="JPEG"), "image/jpeg"))
        url = saved["avatar_url"]
        self.assertTrue(url.startswith("/api/v1/users/avatars/"))
        self.assertEqual(self.f.client.get("/api/v1/users/me", headers=account["headers"]).json()["avatar_url"], url)
        picture = self.f.client.get(url)
        self.assertEqual(picture.status_code, 200)
        self.assertEqual(picture.headers["content-type"], "image/png")
        self.assertEqual(Image.open(BytesIO(picture.content)).size, (512, 512))
        self.assertIsNone(self.f.client.get("/api/v1/users/me", headers=other["headers"]).json()["avatar_url"])
        new = self.f.successful(self.upload(account, image_file("red")))["avatar_url"]
        self.assertNotEqual(new, url)
        self.assertEqual(self.f.client.get(url).status_code, 404)
        self.assertEqual(self.f.client.get(new).status_code, 200)
        self.assertEqual(self.f.client.get("/api/v1/users/avatars/jwt_secret").status_code, 404)

    def test_invalid_uploads_leave_the_existing_avatar_unchanged(self):
        account = self.f.account()
        before = self.f.successful(self.upload(account))["avatar_url"]
        for content, mime, status in [(b"", "image/png", 422), (b"not an image", "image/png", 422),
                                      (b"<svg/>", "image/svg+xml", 422),
                                      (b"0" * (MAX_AVATAR_BYTES + 1), "image/png", 413)]:
            with self.subTest(mime=mime, size=len(content)):
                self.assertEqual(self.upload(account, content, mime).status_code, status)
        self.assertEqual(self.f.client.patch("/api/v1/users/me/avatar", headers=account["headers"]).status_code, 422)
        self.assertEqual(self.f.client.get("/api/v1/users/me", headers=account["headers"]).json()["avatar_url"], before)

    def test_failed_database_write_cleans_up_new_file_and_retains_current_avatar(self):
        account = self.f.account()
        previous = self.f.successful(self.upload(account))["avatar_url"]
        directory = Path(self.f.temp.name) / "avatars"
        files = set(directory.iterdir())
        with patch("backend.app.modules.users.repository.UserRepository.save", side_effect=RuntimeError("write failed")):
            with self.assertRaisesRegex(RuntimeError, "write failed"):
                self.upload(account, image_file("red"))
        self.assertEqual(set(directory.iterdir()), files)
        self.assertEqual(self.f.client.get(previous).status_code, 200)
        self.assertEqual(self.f.client.get("/api/v1/users/me", headers=account["headers"]).json()["avatar_url"], previous)

    def test_profile_notification_and_room_and_match_views_use_current_appearance(self):
        account, other = self.f.account("旧名称"), self.f.account("另一玩家")
        room = self.f.command(other, self.f.create(account), "join")
        settings = config(); settings["selection"]["dungeon_features"]["mode"] = "manual"
        room = self.f.save_config(account, room, settings)
        room = self.f.ready_all(room, account, other)
        match = self.f.successful(self.f.start(account, room))
        frozen = self.f.stored_match(match["id"])["frozen_players"]
        with self.f.client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "auth", "payload": {"token": other["token"]}})
            self.assertEqual(ws.receive_json()["type"], "ack")
            self.f.successful(self.f.client.patch("/api/v1/users/me", headers=account["headers"], json={"username": "新名称"}))
            event = ws.receive_json()
            self.assertEqual(event["type"], "profile_changed")
            self.assertEqual(event["payload"], {"user_id": account["id"]})
            avatar = self.f.successful(self.upload(account))["avatar_url"]
            self.assertEqual(ws.receive_json()["type"], "profile_changed")
        current = self.f.client.get(f"/api/v1/rooms/{room['id']}", headers=other["headers"]).json()
        player = next(p for p in current["players"] if p["user_id"] == account["id"])
        self.assertEqual((player["display_name"], player["avatar_url"]), ("新名称", avatar))
        self.assertEqual((current["version"], current["all_ready"]), (room["version"] + 1, True))
        viewed = self.f.successful(self.f.client.get(f"/api/v1/matches/{match['id']}", headers=other["headers"]))
        player = next(p for p in viewed["players"] if p["user_id"] == account["id"])
        self.assertEqual((player["display_name"], player["avatar_url"]), ("新名称", avatar))
        self.assertEqual(viewed["version"], match["version"])
        self.assertEqual(self.f.stored_match(match["id"])["frozen_players"], frozen)
