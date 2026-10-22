"""Published card content and local runtime storage use separate roots."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.app.core.config import Settings
from backend.app.core.paths import CARDS_ROOT, DATA_ROOT, PROJECT_ROOT
from backend.app.core.security import _jwt_secret


class RuntimePathTests(unittest.TestCase):
    def test_default_database_is_under_runtime_data(self):
        with patch.dict(os.environ, {}, clear=True):
            settings = Settings(_env_file=None)
        self.assertEqual(settings.sqlite_path, DATA_ROOT / "thunderstone.db")
        self.assertEqual(CARDS_ROOT, PROJECT_ROOT / "cards")
        self.assertTrue((CARDS_ROOT / "cards.csv").is_file())
        self.assertTrue((CARDS_ROOT / "assets/TS-0001.png").is_file())

    def test_existing_local_signing_key_is_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            (data / "jwt_secret").write_text("existing-local-key", encoding="ascii")
            settings = Settings(_env_file=None, jwt_secret_key=None, app_env="development")
            with patch("backend.app.core.security.DATA_ROOT", data), \
                    patch("backend.app.core.security.get_settings", return_value=settings):
                self.assertEqual(_jwt_secret(), "existing-local-key")
            self.assertEqual((data / "jwt_secret").read_text(encoding="ascii"), "existing-local-key")
