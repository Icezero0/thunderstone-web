"""Versioned application routes, composed separately from local tools."""

from fastapi import APIRouter

from backend.app.api.v1 import auth, cards, configuration, matches, rooms, users

router = APIRouter()
for module in (auth, users, rooms, configuration, matches, cards):
    router.include_router(module.router)
