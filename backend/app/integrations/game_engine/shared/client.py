"""One lazily started Node worker per Python process; no HTTP server or match cache."""
from __future__ import annotations

import atexit
import json
import hashlib
import os
from pathlib import Path
from queue import Empty, Queue
import shutil
import subprocess
from threading import RLock, Thread

from backend.app.core.paths import PROJECT_ROOT


class SharedEngineUnavailable(RuntimeError):
    pass


class SharedRuleError(ValueError):
    def __init__(self, message, *, name="RuleError", issues=None, choice=None):
        super().__init__(message)
        self.name, self.issues, self.choice = name, issues or [], choice


class EngineClient:
    def __init__(self, root: Path = PROJECT_ROOT, *, timeout: float = 15):
        self.root, self.timeout = root, timeout
        self._process = None
        self._lock = RLock()
        self._sequence = 0
        self._responses: Queue = Queue()
        self._reader = None
        self._build_stamp = None
        self._resources = set()

    def _start(self):
        if not (self.root / "engine/dist/index.js").is_file():
            raise SharedEngineUnavailable("TypeScript engine is not built; run npm ci then npm run build")
        node = shutil.which("node")
        if node is None:
            raise SharedEngineUnavailable("Node.js 22+ is required for the shared rules engine")
        self._responses = Queue()
        self._resources.clear()
        self._process = subprocess.Popen(
            [node, str(self.root / "backend/engine-worker/worker.mjs")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            encoding="utf-8", cwd=self.root,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        process, responses = self._process, self._responses
        self._build_stamp = (self.root / "engine/dist/index.js").stat().st_mtime_ns

        def receive():
            try:
                while line := process.stdout.readline(8_000_001):
                    if len(line) > 8_000_000:
                        break
                    responses.put(line)
            finally:
                responses.put(None)
        self._reader = Thread(target=receive, name="typescript-engine-output", daemon=True)
        self._reader.start()

    def call(self, operation: str, payload: dict):
        with self._lock:
            output = self.root / "engine/dist/index.js"
            stamp = output.stat().st_mtime_ns if output.is_file() else None
            if self._process is None or self._process.poll() is not None or stamp != self._build_stamp:
                self.close()
                self._start()
            self._sequence += 1
            request_id = self._sequence
            resource = None
            if "catalog" in payload and "ruleset" in payload:
                definitions = {key: payload[key] for key in ("catalog", "ruleset")}
                resource = hashlib.sha256(json.dumps(definitions, sort_keys=True, ensure_ascii=False,
                    separators=(",", ":")).encode()).hexdigest()
                payload = {key: value for key, value in payload.items() if key not in definitions}
                payload["resource_key"] = resource
                if resource not in self._resources:
                    payload["resource_definitions"] = definitions
            try:
                self._process.stdin.write(json.dumps({"protocol": 1, "id": request_id,
                    "op": operation, "payload": payload}, ensure_ascii=False) + "\n")
                self._process.stdin.flush()
                line = self._responses.get(timeout=self.timeout)
                if line is None:
                    raise SharedEngineUnavailable("TypeScript rules worker exited before replying")
                response = json.loads(line)
                if not isinstance(response, dict) or response.get("id") != request_id or not isinstance(response.get("ok"), bool):
                    raise SharedEngineUnavailable("TypeScript rules worker response ID mismatch")
            except (OSError, Empty, ValueError, SharedEngineUnavailable) as error:
                self.close()
                raise SharedEngineUnavailable("TypeScript rules worker communication failed") from error
            if not response["ok"]:
                if response["error"].get("name") == "MissingResource" and resource is not None and "resource_definitions" not in payload:
                    self._resources.discard(resource)
                    return self.call(operation, {**payload, **definitions})
                error = response["error"]
                raise SharedRuleError(error["message"], name=error.get("name", "RuleError"),
                                      issues=error.get("issues"), choice=error.get("choice"))
            if resource is not None:
                if len(self._resources) >= 16:
                    self._resources.clear()
                self._resources.add(resource)
            return response["result"]

    def close(self):
        with self._lock:
            process, self._process = self._process, None
            self._build_stamp = None
            if process is None:
                return
            try:
                process.stdin.close()
            except OSError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
            if self._reader is not None:
                self._reader.join(timeout=1)
                self._reader = None
            process.stdout.close()


client = EngineClient()
atexit.register(client.close)
