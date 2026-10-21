"""Base class shared by future room, user and match records."""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
