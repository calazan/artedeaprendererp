from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from psycopg_pool import AsyncConnectionPool

from .config import database_url

_pool: AsyncConnectionPool | None = None


def connection_kwargs() -> dict:
    # Neon can use pooled/serverless connections. Disabling automatic prepared
    # statements avoids cross-backend prepared-statement collisions while keeping
    # every query parameterized.
    return {"autocommit": True, "prepare_threshold": None}


async def open_pool() -> AsyncConnectionPool | None:
    global _pool
    url = database_url()
    if not url:
        return None
    if _pool is None:
        _pool = AsyncConnectionPool(
            conninfo=url,
            min_size=0,
            max_size=3,
            timeout=15,
            kwargs=connection_kwargs(),
            open=False,
        )
        await _pool.open(wait=True)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def pool() -> AsyncConnectionPool:
    value = await open_pool()
    if value is None:
        raise RuntimeError("Banco PostgreSQL não configurado. Informe DATABASE_URL.")
    return value


@asynccontextmanager
async def connection() -> AsyncIterator:
    p = await pool()
    async with p.connection() as conn:
        yield conn
