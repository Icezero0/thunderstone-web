"""Registration and self-service account changes."""

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.exceptions import ConflictError, NotFoundError
from backend.app.core.security import hash_password
from backend.app.modules.users.models import User
from backend.app.modules.users.repository import UserRepository
from backend.app.modules.users.schemas import UserCreate, UserPatch
from backend.app.modules.users.avatars import save_avatar, remove_avatar


class UserService:
    def __init__(self) -> None:
        self.repo = UserRepository()

    async def create_user(self, db: AsyncSession, payload: UserCreate) -> User:
        if await self.repo.get_by_email(db, payload.email):
            raise ConflictError("Email already exists")
        try:
            user = await self.repo.create(db, email=payload.email,
                                          username=payload.username,
                                          hashed_password=hash_password(payload.password))
            await db.commit()
        except IntegrityError as error:
            await db.rollback()
            raise ConflictError("Email already exists") from error
        return user

    async def get_user_by_id(self, db: AsyncSession, user_id: int) -> User:
        user = await self.repo.get_by_id(db, user_id)
        if user is None:
            raise NotFoundError("User not found")
        return user

    async def patch_me(self, db: AsyncSession, user: User, payload: UserPatch) -> User:
        changes = payload.model_dump(exclude_unset=True)
        if "username" in changes:
            user.username = changes["username"]
        if changes.get("password") is not None:
            user.hashed_password = hash_password(changes["password"])
            user.token_version += 1
        await self.repo.save(db, user)
        await db.commit()
        await db.refresh(user)
        return user

    async def update_avatar(self, db: AsyncSession, user: User, file) -> User:
        previous = user.avatar_key
        key = await save_avatar(file)
        try:
            user.avatar_key = key
            await self.repo.save(db, user)
            await db.commit()
        except Exception:
            await db.rollback()
            await remove_avatar(key)
            raise
        await remove_avatar(previous)
        return user
