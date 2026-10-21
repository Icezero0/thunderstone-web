"""Current account endpoints."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.modules.auth.deps import get_current_user
from backend.app.modules.users.models import User
from backend.app.modules.users.schemas import UserPatch, UserResponse
from backend.app.modules.users.service import UserService

router = APIRouter(prefix="/users", tags=["users"])
service = UserService()


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)) -> UserResponse:
    return UserResponse.model_validate(current_user)


@router.patch("/me", response_model=UserResponse)
async def patch_me(payload: UserPatch, db: AsyncSession = Depends(get_db),
                   current_user: User = Depends(get_current_user)) -> UserResponse:
    return UserResponse.model_validate(await service.patch_me(db, current_user, payload))
