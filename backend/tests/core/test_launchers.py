"""Check launcher arguments without starting a listening service."""

from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from backend.app.core.paths import PROJECT_ROOT
import unittest
from unittest.mock import patch

from backend.run_backend import main


class BackendLauncherTests(unittest.TestCase):
    def test_missing_websocket_dependency_stops_before_startup(self):
        stderr = StringIO()
        with patch("backend.run_backend.find_spec", return_value=None), \
                patch("uvicorn.run") as run, redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as error:
                main([])
        self.assertEqual(error.exception.code, 2)
        self.assertIn("WebSocket support is missing", stderr.getvalue())
        self.assertIn("backend/requirements.txt", stderr.getvalue())
        run.assert_not_called()

    def test_installed_uvicorn_can_load_a_websocket_protocol(self):
        from uvicorn.protocols.websockets.auto import AutoWebSocketsProtocol

        self.assertIsNotNone(AutoWebSocketsProtocol,
                             "Install backend/requirements.txt to enable actual WebSocket upgrades")

    def test_explicit_host_port_and_reload_switch(self):
        with patch("uvicorn.run") as run:
            main(["--host", "127.0.0.1", "--port", "9001", "--no-reload"])
        args, kwargs = run.call_args
        self.assertEqual(args, ("backend.app.main:app",))
        self.assertEqual(kwargs["host"], "127.0.0.1")
        self.assertEqual(kwargs["port"], 9001)
        self.assertFalse(kwargs["reload"])
        self.assertEqual(Path(kwargs["app_dir"]), PROJECT_ROOT)

    def test_default_reload_watches_backend_only(self):
        with patch("uvicorn.run") as run:
            main([])
        self.assertTrue(run.call_args.kwargs["reload"])
        self.assertEqual(run.call_args.kwargs["port"], 8765)
        self.assertEqual({Path(p).name for p in run.call_args.kwargs["reload_dirs"]}, {"app", "devtools"})
