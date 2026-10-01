from __future__ import annotations

from typing import Any

from psycopg.types.json import Jsonb

from .db import connection
from .state import ensure_core_schema
from .utils import as_list, iso_value

_employee_schema_ready = False

EMPLOYEE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS public.smg_employees (
  id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_employees_status_name_idx
  ON public.smg_employees(status, lower(COALESCE(data->>'name','')));

CREATE TABLE IF NOT EXISTS public.smg_employee_documents (
  id text PRIMARY KEY,
  employee_id text NOT NULL,
  kind text NOT NULL DEFAULT 'other',
  period text NOT NULL DEFAULT '',
  related_id text NOT NULL DEFAULT '',
  filename text NOT NULL DEFAULT 'arquivo',
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_employee_documents_employee_idx
  ON public.smg_employee_documents(employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS smg_employee_documents_period_kind_idx
  ON public.smg_employee_documents(period, kind, created_at DESC);

ALTER TABLE public.smg_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_employee_documents ENABLE ROW LEVEL SECURITY;
"""


def clean_text(value: Any = "", max_len: int = 300) -> str:
    return str(value if value is not None else "").strip()[:max_len]


async def ensure_employee_schema() -> None:
    global _employee_schema_ready
    if _employee_schema_ready:
        return
    await ensure_core_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(EMPLOYEE_SCHEMA_SQL)
    _employee_schema_ready = True


async def list_employees() -> list[dict]:
    await ensure_employee_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT data FROM public.smg_employees ORDER BY lower(COALESCE(data->>'name',''))"
            )
            return [row[0] or {} for row in await cur.fetchall()]


async def sync_employees(employees: list, deleted_ids: list) -> dict:
    await ensure_employee_schema()
    rows = []
    for employee in as_list(employees):
        if not isinstance(employee, dict) or not employee.get("id"):
            continue
        rows.append(
            {
                "id": clean_text(employee.get("id"), 120),
                "status": clean_text(employee.get("status") or "active", 30),
                "data": employee,
            }
        )
    deleted = sorted({clean_text(v, 120) for v in as_list(deleted_ids) if clean_text(v, 120)})

    async with connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                if rows:
                    await cur.executemany(
                        """
                        INSERT INTO public.smg_employees(id,data,status,updated_at)
                        VALUES (%s,%s,%s,now())
                        ON CONFLICT (id) DO UPDATE
                        SET data=EXCLUDED.data,status=EXCLUDED.status,updated_at=now()
                        """,
                        [(r["id"], Jsonb(r["data"]), r["status"]) for r in rows],
                    )
                if deleted:
                    await cur.execute(
                        "DELETE FROM public.smg_employee_documents WHERE employee_id = ANY(%s::text[])",
                        (deleted,),
                    )
                    await cur.execute(
                        "DELETE FROM public.smg_employees WHERE id = ANY(%s::text[])",
                        (deleted,),
                    )
    from .utils import iso_now
    return {"updatedAt": iso_now(), "count": len(rows)}


async def list_employee_documents(employee_id: str = "", period: str = "", kind: str = "") -> list[dict]:
    await ensure_employee_schema()
    conditions, values = [], []
    if employee_id:
        conditions.append("employee_id=%s")
        values.append(clean_text(employee_id, 120))
    if period:
        conditions.append("period=%s")
        values.append(clean_text(period, 20))
    if kind:
        conditions.append("kind=%s")
        values.append(clean_text(kind, 40))
    where = "WHERE " + " AND ".join(conditions) if conditions else ""

    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT id,employee_id,kind,period,related_id,filename,mime_type,size_bytes,created_at
                FROM public.smg_employee_documents
                {where}
                ORDER BY created_at DESC
                """,
                tuple(values),
            )
            rows = await cur.fetchall()
    return [
        {
            "id": row[0],
            "employeeId": row[1],
            "kind": row[2],
            "period": row[3],
            "relatedId": row[4],
            "filename": row[5],
            "mimeType": row[6],
            "sizeBytes": int(row[7] or 0),
            "createdAt": iso_value(row[8]),
        }
        for row in rows
    ]


async def save_employee_document(document: dict) -> dict | None:
    await ensure_employee_schema()
    content = document.get("content") or b""
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO public.smg_employee_documents
                  (id,employee_id,kind,period,related_id,filename,mime_type,size_bytes,content,created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
                ON CONFLICT (id) DO UPDATE SET
                  employee_id=EXCLUDED.employee_id,
                  kind=EXCLUDED.kind,
                  period=EXCLUDED.period,
                  related_id=EXCLUDED.related_id,
                  filename=EXCLUDED.filename,
                  mime_type=EXCLUDED.mime_type,
                  size_bytes=EXCLUDED.size_bytes,
                  content=EXCLUDED.content
                """,
                (
                    clean_text(document.get("id"), 120),
                    clean_text(document.get("employeeId"), 120),
                    clean_text(document.get("kind") or "other", 40),
                    clean_text(document.get("period") or "", 20),
                    clean_text(document.get("relatedId") or "", 120),
                    clean_text(document.get("filename") or "arquivo", 240),
                    clean_text(document.get("mimeType") or "application/octet-stream", 120),
                    len(content),
                    content,
                ),
            )
            await cur.execute(
                """
                SELECT id,employee_id,kind,period,related_id,filename,mime_type,size_bytes,created_at
                FROM public.smg_employee_documents WHERE id=%s LIMIT 1
                """,
                (clean_text(document.get("id"), 120),),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "employeeId": row[1],
        "kind": row[2],
        "period": row[3],
        "relatedId": row[4],
        "filename": row[5],
        "mimeType": row[6],
        "sizeBytes": int(row[7] or 0),
        "createdAt": iso_value(row[8]),
    }


async def get_employee_document(document_id: str) -> dict | None:
    await ensure_employee_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id,employee_id,kind,period,related_id,filename,mime_type,size_bytes,content,created_at
                FROM public.smg_employee_documents WHERE id=%s LIMIT 1
                """,
                (clean_text(document_id, 120),),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "employeeId": row[1],
        "kind": row[2],
        "period": row[3],
        "relatedId": row[4],
        "filename": row[5],
        "mimeType": row[6],
        "sizeBytes": int(row[7] or 0),
        "content": bytes(row[8] or b""),
        "createdAt": iso_value(row[9]),
    }


async def delete_employee_document(document_id: str) -> dict | None:
    await ensure_employee_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                DELETE FROM public.smg_employee_documents WHERE id=%s
                RETURNING id,employee_id,filename
                """,
                (clean_text(document_id, 120),),
            )
            row = await cur.fetchone()
    return {"id": row[0], "employee_id": row[1], "filename": row[2]} if row else None
