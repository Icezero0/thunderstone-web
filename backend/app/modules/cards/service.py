"""Read-only access to imported, public card definitions."""

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.modules.cards.presentation import public_card
from backend.app.modules.cards.repository import load_card


async def get_card(db: AsyncSession, card_id: str) -> dict:
    return public_card(card_id, await load_card(db, card_id))
