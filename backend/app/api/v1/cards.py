"""Public card definitions; no match state or maintenance metadata."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.modules.cards.service import get_card

router = APIRouter(tags=["Cards"])


@router.get("/cards/{card_id}")
async def card(card_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    return await get_card(db, card_id)
