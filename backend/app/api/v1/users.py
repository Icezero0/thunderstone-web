"""Current account endpoints."""

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.modules.auth.deps import get_current_user
from backend.app.modules.users.models import User
from backend.app.modules.users.schemas import UserPatch, UserResponse
from backend.app.modules.users.service import UserService
from backend.app.modules.users.avatars import avatar_path

router = APIRouter(prefix="/users", tags=["users"])
service = UserService()


async def publish_profile(request: Request, user: User) -> UserResponse:
    await request.app.state.realtime_manager.broadcast({"v": 1, "type": "profile_changed",
                                                       "payload": {"user_id": user.id}})
    return UserResponse.model_validate(user)


@router.get("/avatars/{key}", include_in_schema=False)
async def get_avatar(key: str) -> FileResponse:
    path = avatar_path(key)
    if path is None or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png", headers={
        "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)) -> UserResponse:
    return UserResponse.model_validate(current_user)


@router.patch("/me", response_model=UserResponse)
async def patch_me(payload: UserPatch, request: Request, db: AsyncSession = Depends(get_db),
                   current_user: User = Depends(get_current_user)) -> UserResponse:
    user = await service.patch_me(db, current_user, payload)
    if "username" in payload.model_fields_set:
        return await publish_profile(request, user)
    return UserResponse.model_validate(user)


@router.patch("/me/avatar", response_model=UserResponse)
async def patch_avatar(request: Request, file: UploadFile = File(...), db: AsyncSession = Depends(get_db),
                       current_user: User = Depends(get_current_user)) -> UserResponse:
    try:
        return await publish_profile(request, await service.update_avatar(db, current_user, file))
    finally:
        await file.close()
