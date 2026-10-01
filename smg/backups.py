from __future__ import annotations

import hashlib
import json
import uuid

from psycopg.types.json import Jsonb

from .db import connection
from .utils import iso_value, jsonable

BACKUP_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS public.smg_manual_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checksum text NOT NULL,
  reason text NOT NULL DEFAULT 'manual',
  snapshot jsonb NOT NULL,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_manual_backups_created_idx
  ON public.smg_manual_backups(created_at DESC);
ALTER TABLE public.smg_manual_backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.smg_manual_backups FROM anon, authenticated;
"""

_schema_ready = False


async def ensure_backup_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(BACKUP_SCHEMA_SQL)
    _schema_ready = True


async def create_backup(snapshot: dict, reason: str = "manual", created_by: str = "") -> dict:
    await ensure_backup_schema()
    payload = jsonable(snapshot)
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    checksum = hashlib.sha256(encoded).hexdigest()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO public.smg_manual_backups(checksum,reason,snapshot,created_by)
                VALUES (%s,%s,%s,%s)
                RETURNING id,created_at
                """,
                (checksum, str(reason or "manual")[:80], Jsonb(payload), str(created_by or "")[:160]),
            )
            row = await cur.fetchone()
    return {"id": str(row[0]), "checksum": checksum, "createdAt": iso_value(row[1])}


async def list_backups(limit: int = 50) -> list[dict]:
    await ensure_backup_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id::text,checksum,reason,created_by,created_at
                FROM public.smg_manual_backups
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (max(1, min(int(limit), 200)),),
            )
            rows = await cur.fetchall()
    return [
        {
            "id": row[0],
            "checksum": row[1],
            "reason": row[2],
            "createdBy": row[3],
            "createdAt": iso_value(row[4]),
        }
        for row in rows
    ]


async def get_backup(backup_id: str) -> dict | None:
    await ensure_backup_schema()
    try:
        parsed = str(uuid.UUID(str(backup_id)))
    except ValueError:
        return None
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT snapshot,checksum,reason,created_by,created_at
                FROM public.smg_manual_backups
                WHERE id=%s::uuid
                """,
                (parsed,),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "id": parsed,
        "snapshot": row[0],
        "checksum": row[1],
        "reason": row[2],
        "createdBy": row[3],
        "createdAt": iso_value(row[4]),
    }
