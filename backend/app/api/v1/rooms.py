"""Authenticated waiting rooms; identity always comes from the access token."""

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.modules.auth.deps import get_current_user
from backend.app.modules.rooms.schemas import (ConfigCommand, CurrentRoom, ReadyCommand,
    RoomCommand, RoomCreate, RoomList, RoomView)
from backend.app.modules.rooms.service import RoomService
from backend.app.modules.users.models import User

router = APIRouter(prefix="/rooms", tags=["rooms"])
service = RoomService()


async def publish(request: Request, room: RoomView) -> RoomView:
    await request.app.state.realtime_manager.broadcast({"v": 1, "type": "room_changed",
        "payload": {"room_id": room.id, "version": room.version}})
    return room


@router.get("", response_model=RoomList)
async def rooms(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return RoomList(rooms=await service.repo.list_waiting(db))


@router.get("/current", response_model=CurrentRoom)
async def current(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return CurrentRoom(room=await service.current(db, user.id))


@router.post("", response_model=RoomView, status_code=201)
async def create(payload: RoomCreate, request: Request,
                 user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.create(db, user.id, payload.name))


@router.get("/{room_id}", response_model=RoomView)
async def room(room_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await service.repo.view(db, await service.waiting(db, room_id))


@router.post("/{room_id}/join", response_model=RoomView)
async def join(room_id: str, payload: RoomCommand, request: Request,
               user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.join(db, room_id, user.id, payload.expected_version))


@router.post("/{room_id}/ready", response_model=RoomView)
async def ready(room_id: str, payload: ReadyCommand, request: Request,
                user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.ready(db, room_id, user.id, payload.expected_version, payload.ready))


@router.patch("/{room_id}/config", response_model=RoomView)
async def config(room_id: str, payload: ConfigCommand, request: Request,
                 user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.save_config(db, room_id, user.id, payload.expected_version, payload.config))


@router.post("/{room_id}/leave", response_model=RoomView)
async def leave(room_id: str, payload: RoomCommand, request: Request,
                user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.leave(db, room_id, user.id, payload.expected_version))


@router.post("/{room_id}/close", response_model=RoomView)
async def close(room_id: str, payload: RoomCommand, request: Request,
                user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await publish(request, await service.close(db, room_id, user.id, payload.expected_version))
