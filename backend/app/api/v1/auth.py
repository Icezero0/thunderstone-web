"""Registration, login and refresh endpoints."""

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.modules.auth.schemas import (LoginRequest, RefreshTokenRequest,
                                              TokenResponse)
from backend.app.modules.auth.service import AuthService
from backend.app.modules.users.schemas import UserCreate, UserResponse
from backend.app.modules.users.service import UserService

router = APIRouter(prefix="/auth", tags=["auth"])
auth_service = AuthService()
user_service = UserService()


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: UserCreate, db: AsyncSession = Depends(get_db)) -> UserResponse:
    return UserResponse.model_validate(await user_service.create_user(db, payload))


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    return TokenResponse(**await auth_service.login(db, email=payload.email,
                                                    password=payload.password))


@router.post("/refresh", response_model=TokenResponse)
async def refresh(payload: RefreshTokenRequest,
                  db: AsyncSession = Depends(get_db)) -> TokenResponse:
    return TokenResponse(**await auth_service.refresh_tokens(
        db, refresh_token=payload.refresh_token))
