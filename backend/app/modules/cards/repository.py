"""Load a CSV-compatible catalog snapshot from SQLite."""

import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.integrations.game_engine.api import CatalogSnapshot

from backend.app.core.exceptions import AppError, NotFoundError
from backend.app.modules.cards.mapping import BOOLEAN_FIELDS, CSV_TO_DB
from backend.app.modules.cards.models import CardDefinition, CatalogMeta


class CatalogUnavailableError(AppError):
    def __init__(self, message: str = "Card catalog has not been imported"):
        super().__init__(message, code="catalog_unavailable", status_code=503)


def card_to_csv_row(card: CardDefinition) -> dict[str, str]:
    result = {}
    for csv_name, attribute in CSV_TO_DB.items():
        value = getattr(card, attribute)
        if value is None:
            result[csv_name] = ""
        elif csv_name in BOOLEAN_FIELDS:
            result[csv_name] = "True" if value else "False"
        else:
            result[csv_name] = str(value)
    return result


async def load_catalog_snapshot(db: AsyncSession) -> CatalogSnapshot:
    meta = await db.get(CatalogMeta, 1)
    if meta is None:
        raise CatalogUnavailableError()
    setup_index = json.loads(meta.setup_index_json)
    if setup_index.get("cards_csv_sha256") != meta.cards_csv_sha256:
        raise CatalogUnavailableError("Catalog index does not match imported cards")
    cards = (await db.scalars(select(CardDefinition).order_by(CardDefinition.catalog_order))).all()
    if len(cards) != meta.card_count:
        raise CatalogUnavailableError("Imported catalog has an incorrect card count")
    return CatalogSnapshot({card.card_id: card_to_csv_row(card) for card in cards},
                           setup_index)


async def load_card(db: AsyncSession, card_id: str) -> dict[str, str]:
    if await db.get(CatalogMeta, 1) is None:
        raise CatalogUnavailableError()
    card = await db.get(CardDefinition, card_id)
    if card is None:
        raise NotFoundError("卡牌不存在")
    return card_to_csv_row(card)
