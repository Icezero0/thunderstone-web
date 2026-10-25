"""Public media validators, byte requests and production worker routing; no server."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.resources import router


class ResourceCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.card = self.root / 'cards/assets/TS-0001.png'
        self.card.parent.mkdir(parents=True)
        self.card.write_bytes(b'card-one')
        pdf = self.root / 'frontend/dist/rulebooks/TS4_rules_CN.pdf'
        pdf.parent.mkdir(parents=True)
        pdf.write_bytes(b'%PDF-1.7\n0123456789')
        (self.root / 'frontend/dist/asset-cache-sw.js').write_text('self.addEventListener("fetch", () => {});')
        self.paths = patch.multiple('backend.app.api.resources', PROJECT_ROOT=self.root, CARDS_ROOT=self.root / 'cards')
        self.paths.start()
        app = FastAPI(); app.include_router(router)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close(); self.paths.stop(); self.temp.cleanup()

    def test_public_files_validate_without_resending_bodies(self):
        for url, media in [('/cards/TS-0001.png', 'image/png'),
                           ('/rulebooks/TS4_rules_CN.pdf', 'application/pdf'),
                           ('/asset-cache-sw.js', 'text/javascript')]:
            with self.subTest(url=url):
                first = self.client.get(url)
                self.assertEqual(first.status_code, 200)
                self.assertTrue(first.headers['content-type'].startswith(media))
                self.assertEqual(first.headers['cache-control'], 'public, no-cache')
                for condition in [{'If-None-Match': first.headers['etag']},
                                  {'If-None-Match': '"other", W/' + first.headers['etag']},
                                  {'If-Modified-Since': first.headers['last-modified']}]:
                    cached = self.client.get(url, headers=condition)
                    self.assertEqual(cached.status_code, 304)
                    self.assertEqual(cached.content, b'')
                    self.assertEqual(cached.headers['etag'], first.headers['etag'])

    def test_changed_file_replaces_old_version_and_etag_takes_precedence(self):
        old = self.client.get('/cards/TS-0001.png')
        previous = self.card.stat().st_mtime
        self.card.write_bytes(b'new-picture')
        os.utime(self.card, (previous + 2, previous + 2))
        updated = self.client.get('/cards/TS-0001.png', headers={'If-None-Match': old.headers['etag']})
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.content, b'new-picture')
        self.assertNotEqual(updated.headers['etag'], old.headers['etag'])
        precedence = self.client.get('/cards/TS-0001.png', headers={
            'If-None-Match': '"wrong"', 'If-Modified-Since': updated.headers['last-modified']})
        self.assertEqual(precedence.status_code, 200)
        self.assertEqual(self.client.get('/cards/TS-0001.png', headers={'If-Modified-Since': 'bad date'}).status_code, 200)

    def test_pdf_range_and_head_remain_supported(self):
        url = '/rulebooks/TS4_rules_CN.pdf'
        full = self.client.get(url)
        part = self.client.get(url, headers={'Range': 'bytes=0-7'})
        self.assertEqual(part.status_code, 206)
        self.assertEqual(part.content, full.content[:8])
        head = self.client.head(url)
        self.assertEqual(head.status_code, 200); self.assertEqual(head.content, b'')
        self.assertEqual(int(head.headers['content-length']), len(full.content))

    def test_unchanged_bytes_keep_their_etag_after_a_build_or_file_copy(self):
        before = self.client.get('/cards/TS-0001.png')
        previous = self.card.stat().st_mtime
        os.utime(self.card, (previous + 10, previous + 10))
        after = self.client.get('/cards/TS-0001.png', headers={'If-None-Match': before.headers['etag']})
        self.assertEqual(after.status_code, 304)
        self.assertEqual(after.headers['etag'], before.headers['etag'])

    def test_missing_or_unlisted_files_are_not_cacheable(self):
        for url in ['/cards/TS-9999.png', '/cards/cards.csv', '/cards/invalid.png',
                    '/rulebooks/other.pdf', '/rulebooks/../secret.pdf']:
            response = self.client.get(url)
            self.assertEqual(response.status_code, 404)
            self.assertNotIn('public', response.headers.get('cache-control', ''))
