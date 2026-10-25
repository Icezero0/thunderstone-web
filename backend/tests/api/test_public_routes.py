"""Deployment must not expose former sandbox pages or transports."""

import unittest

from fastapi.testclient import TestClient

from backend.app.main import create_app
from backend.app.api.frontend import FRONTEND_DIST
from backend.tests.support.frontend import assert_frontend_page


class PublicRoutesTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app())
        self.addCleanup(self.client.close)

    def test_only_formal_pages_are_built_and_served(self):
        for route in ["/", "/play", "/login", "/register", "/config", "/match", "/profile"]:
            with self.subTest(route=route):
                assert_frontend_page(self.client, route)
        self.assertEqual({path.name for path in FRONTEND_DIST.glob("*.html")},
                         {"index.html", "auth.html", "config.html", "match.html", "profile.html"})

    def test_retired_pages_and_interfaces_return_not_found(self):
        for path in ["/game-probe", "/game-probe.html", "/effect-lab", "/effect-lab.html",
                     "/monster-audit", "/tests/fixtures/game-probe/page.html", "/.test-dist/game-probe.js",
                     "/effect-lab/cases", "/effect-lab/coverage", "/effect-lab/cases/draw/run",
                     "/docs", "/redoc", "/openapi.json", "/api/options"]:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        for path in ["/api/setup", "/api/v1/setup", "/api/v1/battle/context", "/api/v1/battle/submit"]:
            with self.subTest(path=path):
                self.assertEqual(self.client.post(path, json={}).status_code, 404)

    def test_login_page_does_not_embed_lobby_or_welcome_content(self):
        text = self.client.get("/login").text
        self.assertIn('id="auth-form"', text)
        for marker in ["冒险者工会", "尚未登录", "村庄之外", 'id="lobby-view"', 'class="masthead"']:
            self.assertNotIn(marker, text)
        self.assertNotIn('id="auth-form"', self.client.get("/play").text)
