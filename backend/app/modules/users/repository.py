"""User queries and writes."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.modules.users.models import User


class UserRepository:
    async def profiles(self, db: AsyncSession, user_ids: list[int]) -> dict[int, User]:
        return {user.id: user for user in (await db.scalars(select(User).where(User.id.in_(user_ids)))).all()}

    async def save(self, db: AsyncSession, user: User) -> User:
        db.add(user)
        await db.flush()
        await db.refresh(user)
        return user

    async def get_by_id(self, db: AsyncSession, user_id: int) -> User | None:
        return await db.scalar(select(User).where(User.id == user_id))

    async def get_by_email(self, db: AsyncSession, email: str) -> User | None:
        return await db.scalar(select(User).where(User.email == email))

    async def create(self, db: AsyncSession, *, email: str, username: str | None,
                     hashed_password: str) -> User:
        user = User(email=email, username=username, hashed_password=hashed_password)
        db.add(user)
        await db.flush()
        await db.refresh(user)
        return user
