from __future__ import annotations

import hashlib
import os
from typing import Any

from psycopg.types.json import Jsonb

from .config import database_url, remote_sync_key
from .crypto import (
    decrypt_preregistration_data,
    encrypt_preregistration_data,
    preregistration_needs_migration,
)
from .db import connection
from .utils import iso_value

_schema_ready = False

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS public.smg_preregistrations (
  id text PRIMARY KEY,
  protocol text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  enrolled_student_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS smg_preregistrations_status_created_idx
  ON public.smg_preregistrations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS smg_preregistrations_child_name_idx
  ON public.smg_preregistrations(lower(COALESCE(data->>'childName','')));
ALTER TABLE public.smg_preregistrations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.smg_rate_limits (
  bucket_key text PRIMARY KEY,
  hit_count integer NOT NULL DEFAULT 0,
  reset_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.smg_rate_limits ENABLE ROW LEVEL SECURITY;
"""


def configured() -> bool:
    return bool(database_url())


async def ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(SCHEMA_SQL)
    _schema_ready = True


async def find_recent_duplicate(child_name: str, birth_date: str, guardian_phone: str) -> dict | None:
    await ensure_schema()
    digits = "".join(ch for ch in str(guardian_phone) if ch.isdigit())
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                r"""
                SELECT id,protocol,status,created_at
                FROM public.smg_preregistrations
                WHERE status IN ('pending','reviewing')
                  AND lower(COALESCE(data->>'childName','')) = lower(%s)
                  AND COALESCE(data->>'birthDate','') = %s
                  AND regexp_replace(COALESCE(data->>'guardianPhone',''), '\D', '', 'g') = %s
                  AND created_at >= now() - interval '30 days'
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (str(child_name).strip(), str(birth_date).strip(), digits),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "protocol": row[1], "status": row[2], "created_at": row[3]}


async def create_record(record_id: str, protocol: str, data: dict) -> dict:
    await ensure_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO public.smg_preregistrations(id,protocol,status,data,created_at,updated_at)
                VALUES (%s,%s,'pending',%s,now(),now())
                RETURNING id,protocol,status,created_at
                """,
                (record_id, protocol, Jsonb(encrypt_preregistration_data(data or {}))),
            )
            row = await cur.fetchone()
    return {"id": row[0], "protocol": row[1], "status": row[2], "created_at": iso_value(row[3])}


async def list_records(status: str = "", limit: Any = 200) -> list[dict]:
    await ensure_schema()
    try:
        safe_limit = min(max(int(limit or 200), 1), 500)
    except Exception:
        safe_limit = 200
    allowed = {"pending", "reviewing", "enrolled", "rejected"}
    selected = status if status in allowed else ""
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id,protocol,status,data,enrolled_student_id,created_at,updated_at,reviewed_at
                FROM public.smg_preregistrations
                WHERE (%s='' OR status=%s)
                ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
                         created_at DESC
                LIMIT %s
                """,
                (selected, selected, safe_limit),
            )
            rows = await cur.fetchall()
    return [
        {
            "id": r[0],
            "protocol": r[1],
            "status": r[2],
            "data": decrypt_preregistration_data(r[3] or {}),
            "enrolled_student_id": r[4],
            "created_at": iso_value(r[5]),
            "updated_at": iso_value(r[6]),
            "reviewed_at": iso_value(r[7]),
        }
        for r in rows
    ]


async def counts() -> dict:
    await ensure_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  count(*) FILTER (WHERE status='pending')::int,
                  count(*) FILTER (WHERE status='reviewing')::int,
                  count(*) FILTER (WHERE status='enrolled')::int,
                  count(*) FILTER (WHERE status='rejected')::int,
                  count(*)::int
                FROM public.smg_preregistrations
                """
            )
            row = await cur.fetchone()
    return {
        "pending": int(row[0] or 0),
        "reviewing": int(row[1] or 0),
        "enrolled": int(row[2] or 0),
        "rejected": int(row[3] or 0),
        "total": int(row[4] or 0),
    }


async def update_record(record_id: str, status: str, data: dict | None, enrolled_student_id: str = "") -> dict:
    await ensure_schema()
    if status not in {"pending", "reviewing", "enrolled", "rejected"}:
        raise ValueError("Status de pré-cadastro inválido.")
    has_data = isinstance(data, dict)
    protected_data = encrypt_preregistration_data(data) if has_data else {}
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE public.smg_preregistrations
                SET status=%s,
                    data=CASE WHEN %s::boolean THEN %s ELSE data END,
                    enrolled_student_id=CASE WHEN %s='enrolled' THEN %s ELSE enrolled_student_id END,
                    reviewed_at=CASE WHEN %s IN ('enrolled','rejected') THEN now() ELSE reviewed_at END,
                    updated_at=now()
                WHERE id=%s
                RETURNING id,protocol,status,data,enrolled_student_id,created_at,updated_at,reviewed_at
                """,
                (
                    status,
                    has_data,
                    Jsonb(protected_data),
                    status,
                    str(enrolled_student_id or ""),
                    status,
                    record_id,
                ),
            )
            row = await cur.fetchone()
    if not row:
        raise ValueError("Pré-cadastro não encontrado.")
    return {
        "id": row[0],
        "protocol": row[1],
        "status": row[2],
        "data": decrypt_preregistration_data(row[3] or {}),
        "enrolled_student_id": row[4],
        "created_at": iso_value(row[5]),
        "updated_at": iso_value(row[6]),
        "reviewed_at": iso_value(row[7]),
    }


async def consume_rate_limit(
    identifier: str,
    *,
    namespace: str = "pre-registration",
    limit: int = 5,
    window_seconds: int = 600,
    fail_open: bool = True,
) -> bool:
    """Consume one attempt in a PostgreSQL-backed, serverless-safe rate bucket."""
    try:
        if not database_url():
            return fail_open
        await ensure_schema()
        digest = hashlib.sha256(
            (remote_sync_key() + ":" + namespace + ":" + str(identifier or "unknown")).encode("utf-8")
        ).hexdigest()
        async with connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    INSERT INTO public.smg_rate_limits(bucket_key,hit_count,reset_at,updated_at)
                    VALUES (%s,1,now() + (%s * interval '1 second'),now())
                    ON CONFLICT (bucket_key) DO UPDATE SET
                      hit_count=CASE
                        WHEN public.smg_rate_limits.reset_at <= now() THEN 1
                        ELSE public.smg_rate_limits.hit_count + 1
                      END,
                      reset_at=CASE
                        WHEN public.smg_rate_limits.reset_at <= now()
                          THEN now() + (%s * interval '1 second')
                        ELSE public.smg_rate_limits.reset_at
                      END,
                      updated_at=now()
                    RETURNING hit_count
                    """,
                    (digest, window_seconds, window_seconds),
                )
                row = await cur.fetchone()
        return bool(row and int(row[0]) <= int(limit))
    except Exception:
        return fail_open


def rejected_retention_days() -> int:
    try:
        return max(1, min(int(os.getenv("PREREG_REJECTED_RETENTION_DAYS", "30")), 3650))
    except Exception:
        return 30


async def cleanup_retention() -> dict:
    await ensure_schema()
    days = rejected_retention_days()
    async with connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    DELETE FROM public.smg_preregistrations
                    WHERE status='rejected'
                      AND COALESCE(reviewed_at,updated_at,created_at) < now() - (%s * interval '1 day')
                    RETURNING id
                    """,
                    (days,),
                )
                removed = len(await cur.fetchall())
                await cur.execute(
                    "DELETE FROM public.smg_rate_limits WHERE reset_at < now() - interval '1 day' RETURNING bucket_key"
                )
                rate_removed = len(await cur.fetchall())
    return {"rejectedRemoved": removed, "rateLimitsRemoved": rate_removed, "retentionDays": days}


async def migrate_sensitive_records() -> dict:
    """Encrypt legacy plaintext sensitive fields in-place without deleting records."""
    await ensure_schema()
    migrated = 0
    async with connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                await cur.execute("SELECT id,data FROM public.smg_preregistrations FOR UPDATE")
                rows = await cur.fetchall()
                for record_id, raw in rows:
                    data = raw or {}
                    if not preregistration_needs_migration(data):
                        continue
                    protected = encrypt_preregistration_data(data)
                    await cur.execute(
                        "UPDATE public.smg_preregistrations SET data=%s,updated_at=now() WHERE id=%s",
                        (Jsonb(protected), record_id),
                    )
                    migrated += 1
    return {"migrated": migrated}
