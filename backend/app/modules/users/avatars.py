"""Local avatar storage, adapted from iCinema's avatar upload flow."""

import asyncio
from io import BytesIO
import logging
import re
from uuid import uuid4

from fastapi import UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from backend.app.core.config import get_settings
from backend.app.core.exceptions import AppError

MAX_AVATAR_BYTES = 5 * 1024 * 1024
MAX_AVATAR_PIXELS = 16_000_000


def avatar_path(key: str):
    if not re.fullmatch(r"[a-f0-9]{32}\.png", key):
        return None
    return get_settings().avatar_dir / key


def _normalize(content: bytes) -> bytes:
    try:
        with Image.open(BytesIO(content), formats=["PNG", "JPEG", "WEBP"]) as image:
            if image.width * image.height > MAX_AVATAR_PIXELS:
                raise ValueError("Image is too large")
            image.load()
            square = ImageOps.fit(ImageOps.exif_transpose(image).convert("RGBA"), (512, 512),
                                  method=Image.Resampling.LANCZOS)
            output = BytesIO()
            square.save(output, format="PNG")
            return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        raise AppError("无法读取头像，请选择不超过 1600 万像素的 PNG、JPEG 或 WebP 图片",
                       code="invalid_avatar", status_code=422) from error


async def save_avatar(file: UploadFile) -> str:
    if file.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise AppError("头像仅支持 PNG、JPEG 或 WebP", code="invalid_avatar", status_code=422)
    content = await file.read(MAX_AVATAR_BYTES + 1)
    if len(content) > MAX_AVATAR_BYTES:
        raise AppError("头像不能超过 5 MB", code="avatar_too_large", status_code=413)
    if not content:
        raise AppError("头像文件不能为空", code="invalid_avatar", status_code=422)
    normalized = await asyncio.to_thread(_normalize, content)
    key = f"{uuid4().hex}.png"
    path = avatar_path(key)
    def write():
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.write_bytes(normalized)
        except OSError:
            path.unlink(missing_ok=True)
            raise
    await asyncio.to_thread(write)
    return key


async def remove_avatar(key: str | None) -> None:
    path = avatar_path(key) if key else None
    if path:
        try:
            await asyncio.to_thread(path.unlink, missing_ok=True)
        except OSError:
            logging.getLogger(__name__).exception("Could not remove replaced avatar")
