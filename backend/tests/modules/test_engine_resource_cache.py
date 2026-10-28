"""Versioned definition caching must survive eviction, changed inputs and worker restart."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest

from backend.app.integrations.game_engine.effects import compiler
from backend.app.integrations.game_engine.shared.client import EngineClient


class EngineResourceCacheTests(unittest.TestCase):
    def test_compiled_cache_invalidates_on_catalog_source_and_build_changes(self):
        with TemporaryDirectory() as directory, patch.object(compiler, '_load_ruleset') as compile:
            root = Path(directory); source = root / 'cards/effects/classic-v1.json'
            source.parent.mkdir(parents=True); source.write_text('one')
            cards = {'card': {'name': 'one'}}
            compiler.load_ruleset(cards, root); compiler.load_ruleset(cards, root)
            self.assertEqual(compile.call_count, 1)
            cards['card']['name'] = 'two'; compiler.load_ruleset(cards, root)
            source.write_text('longer-source'); compiler.load_ruleset(cards, root)
            build = root / 'engine/dist/index.js'; build.parent.mkdir(parents=True); build.write_text('changed-build')
            compiler.load_ruleset(cards, root)
            self.assertEqual(compile.call_count, 4)

    def test_worker_resource_eviction_and_restart_re_register_without_state_cache(self):
        worker = EngineClient()
        try:
            for n in [0, 1, 2, 3, 4, 0]:
                response = worker.call('runtime_info', {'catalog': {'revision': n}, 'ruleset': {'version': str(n)}})
                self.assertIn('engine_version', response)
            worker.close()
            self.assertEqual(worker.call('runtime_info', {'catalog': {'revision': 0}, 'ruleset': {'version': '0'}}), response)
        finally:
            worker.close()
