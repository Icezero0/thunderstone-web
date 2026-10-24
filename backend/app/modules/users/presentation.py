"""Public avatar URLs; independent of image decoding and storage."""

AVATAR_PREFIX = "/api/v1/users/avatars"


def avatar_url(key: str | None) -> str | None:
    return f"{AVATAR_PREFIX}/{key}" if key else None
