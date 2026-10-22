"""Verify real multi-page build references through the backend's static mount."""

from html.parser import HTMLParser


class _Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.styles = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("src"):
            assert attrs.get("type") == "module"
            self.scripts.append(attrs["src"])
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.styles.append(attrs["href"])


def assert_frontend_page(client, route: str):
    response = client.get(route)
    assert response.status_code == 200, (route, response.text)
    assert response.headers["cache-control"] == "no-cache"
    assets = _Assets()
    assets.feed(response.text)
    assert assets.scripts and assets.styles, (route, response.text)
    for asset in [*assets.scripts, *assets.styles]:
        assert asset.startswith("/assets/"), asset
        result = client.get(asset)
        assert result.status_code == 200, asset
    return response
