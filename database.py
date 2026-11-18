from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, create_engine, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Engine, URL, make_url
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker
from sqlalchemy.types import JSON


ROOT = Path(__file__).resolve().parent
DEFAULT_DATABASE_URL = f"sqlite:///{ROOT / 'etax_local.sqlite3'}"


def sqlite_url_for_path(path: str) -> str:
    """Build a local SQLite URL from an absolute path or one relative to the project."""
    database_path = Path(path)
    if not database_path.is_absolute():
        database_path = ROOT / database_path
    return URL.create("sqlite", database=str(database_path)).render_as_string(
        hide_password=False
    )


class Base(DeclarativeBase):
    pass


JsonType = JSON().with_variant(JSONB(), "postgresql")


class UserAccount(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    phone: Mapped[str] = mapped_column(String(32), nullable=False)
    password_salt: Mapped[str] = mapped_column(String(64), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    otp_hash: Mapped[str | None] = mapped_column(String(64))
    otp_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    is_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.now)

    tax_records: Mapped[list[TaxRecord]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class TaxRecord(Base):
    __tablename__ = "tax_records"
    __table_args__ = (
        Index("tax_records_user_year", "user_id", "tax_year", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    tax_year: Mapped[str] = mapped_column(String(4), nullable=False)
    state: Mapped[str] = mapped_column(String(32), nullable=False, default="DRAFT")
    is_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    data_json: Mapped[dict] = mapped_column(JsonType, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=datetime.now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.now, onupdate=datetime.now
    )

    user: Mapped[UserAccount] = relationship(back_populates="tax_records")


def _create_engine(database_url: str) -> Engine:
    if database_url.startswith("postgres://"):
        database_url = "postgresql+psycopg2://" + database_url.removeprefix("postgres://")
    elif database_url.startswith("postgresql://"):
        database_url = "postgresql+psycopg2://" + database_url.removeprefix("postgresql://")

    url = make_url(database_url)
    if url.drivername == "postgresql+psycopg2" and "schema" in url.query:
        query = dict(url.query)
        query.pop("schema")
        url = url.set(query=query)

    options: dict = {"pool_pre_ping": True}
    if database_url.startswith("sqlite:"):
        options["connect_args"] = {"check_same_thread": False}
    configured_engine = create_engine(url, **options)

    if database_url.startswith("sqlite:"):
        @event.listens_for(configured_engine, "connect")
        def _enable_sqlite_foreign_keys(dbapi_connection, _connection_record) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return configured_engine


engine = _create_engine(os.getenv("DATABASE_URL") or DEFAULT_DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def configure_database(database_url: str) -> None:
    """Replace the process-wide engine and session factory, for configuration or tests."""
    global engine, SessionLocal
    if not database_url.strip():
        raise ValueError("DATABASE_URL must not be empty.")
    engine.dispose()
    engine = _create_engine(database_url.strip())
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@contextmanager
def session_scope() -> Iterator[Session]:
    """Commit a unit of work on success and roll it back if any operation fails."""
    with SessionLocal() as session:
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
