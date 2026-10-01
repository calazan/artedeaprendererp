from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from psycopg_pool import AsyncConnectionPool

from .config import database_url

_pool: AsyncConnectionPool | None = None


def connection_kwargs() -> dict:
    # Supabase's serverless/transaction pooler can hand successive transactions to
    # different PostgreSQL backends. Client-side prepared statements are therefore
    # unsafe and may fail with "prepared statement ... already exists". Disabling
    # automatic prepare keeps each FastAPI request compatible with PgBouncer while
    # preserving parameterized SQL and server-side escaping.
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
        raise RuntimeError("Supabase não configurado. Informe uma URL PostgreSQL.")
    return value


@asynccontextmanager
async def connection() -> AsyncIterator:
    p = await pool()
    async with p.connection() as conn:
        yield conn
