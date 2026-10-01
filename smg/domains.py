from __future__ import annotations

import re
import uuid
from typing import Any

from psycopg.types.json import Jsonb

from .db import connection
from .utils import as_dict, as_list, iso_now, iso_value


RESOURCE_TYPES = {
    "activities", "students", "plans", "payments", "receipts", "payment-methods",
    "other-income", "expenses", "financial-categories", "bank-accounts", "bank-movements",
    "attendance", "events", "event-participants", "event-receipts", "calendar-events",
    "tasks", "shopping-lists", "rental-partners", "rental-contracts", "rental-receivables",
    "rental-repasses", "rental-assets", "proposals", "pre-registrations", "employees",
    "employee-schedules", "employee-payroll", "employee-taxes", "employee-documents",
    "whatsapp-reminders", "company-settings", "security-settings", "print-settings",
    "integration-settings", "audit-events", "backups",
}

STATE_RESOURCE_ALIASES = {
    "activityCatalog": "activities", "students": "students", "plans": "plans",
    "payments": "payments", "otherIncome": "other-income", "incomes": "other-income",
    "expenses": "expenses", "expenseCategories": "financial-categories",
    "financialCategories": "financial-categories", "bankAccounts": "bank-accounts",
    "bankMovements": "bank-movements", "attendance": "attendance",
    "extraEvents": "events", "extraParticipants": "event-participants",
    "calendarEvents": "calendar-events", "agenda": "calendar-events", "tasks": "tasks",
    "shoppingLists": "shopping-lists", "rentalPartners": "rental-partners",
    "rentals": "rental-contracts", "rentalContracts": "rental-contracts",
    "rentalReceivables": "rental-receivables", "rentalRepasses": "rental-repasses",
    "rentalAssets": "rental-assets", "proposals": "proposals", "employees": "employees",
    "employeeSchedules": "employee-schedules", "employeePayroll": "employee-payroll",
    "employeeTaxes": "employee-taxes", "company": "company-settings",
    "settings": "company-settings", "security": "security-settings",
    "printSettings": "print-settings", "integrations": "integration-settings",
}

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS public.smg_domain_records (
  resource_type text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(resource_type,id)
);
CREATE INDEX IF NOT EXISTS smg_domain_records_active_idx
  ON public.smg_domain_records(resource_type,updated_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE public.smg_domain_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.smg_domain_records FROM anon, authenticated;
"""

_schema_ready = False


async def ensure_domain_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(SCHEMA_SQL)
    _schema_ready = True


def normalize_resource(value: str) -> str:
    resource = re.sub(r"[^a-z0-9-]", "", str(value or "").lower().replace("_", "-"))
    if resource not in RESOURCE_TYPES:
        raise ValueError("Módulo inválido.")
    return resource


def normalize_id(value: Any = "") -> str:
    clean = re.sub(r"[^A-Za-z0-9_.:@-]", "", str(value or "").strip())[:160]
    return clean or str(uuid.uuid4())


async def list_records(resource: str, *, include_deleted: bool = False, limit: int = 1000) -> list[dict]:
    resource = normalize_resource(resource)
    await ensure_domain_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            query = (
                """
                SELECT id,data,version,created_at,updated_at,deleted_at
                FROM public.smg_domain_records
                WHERE resource_type=%s
                ORDER BY updated_at DESC
                LIMIT %s
                """
                if include_deleted
                else """
                SELECT id,data,version,created_at,updated_at,deleted_at
                FROM public.smg_domain_records
                WHERE resource_type=%s AND deleted_at IS NULL
                ORDER BY updated_at DESC
                LIMIT %s
                """
            )
            await cur.execute(
                query,
                (resource, max(1, min(int(limit), 5000))),
            )
            rows = await cur.fetchall()
    return [
        {
            **as_dict(row[1]),
            "id": row[0],
            "_version": int(row[2]),
            "_createdAt": iso_value(row[3]),
            "_updatedAt": iso_value(row[4]),
            "_deletedAt": iso_value(row[5]),
        }
        for row in rows
    ]


async def get_record(resource: str, record_id: str) -> dict | None:
    resource, record_id = normalize_resource(resource), normalize_id(record_id)
    await ensure_domain_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT data,version,created_at,updated_at,deleted_at FROM public.smg_domain_records WHERE resource_type=%s AND id=%s",
                (resource, record_id),
            )
            row = await cur.fetchone()
    if not row:
        return None
    return {
        **as_dict(row[0]),
        "id": record_id,
        "_version": int(row[1]),
        "_createdAt": iso_value(row[2]),
        "_updatedAt": iso_value(row[3]),
        "_deletedAt": iso_value(row[4]),
    }


async def save_record(resource: str, data: dict, *, expected_version: int | None = None) -> dict:
    resource = normalize_resource(resource)
    item = as_dict(data)
    record_id = normalize_id(item.get("id"))
    item = {key: value for key, value in item.items() if not str(key).startswith("_")}
    item["id"] = record_id
    await ensure_domain_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            if expected_version is None:
                await cur.execute(
                    """
                    INSERT INTO public.smg_domain_records(resource_type,id,data,version,deleted_at,updated_at)
                    VALUES (%s,%s,%s,1,NULL,now())
                    ON CONFLICT(resource_type,id) DO UPDATE SET
                      data=EXCLUDED.data,
                      version=public.smg_domain_records.version+1,
                      deleted_at=NULL,
                      updated_at=now()
                    RETURNING version,created_at,updated_at
                    """,
                    (resource, record_id, Jsonb(item)),
                )
            else:
                await cur.execute(
                    """
                    UPDATE public.smg_domain_records
                    SET data=%s,version=version+1,deleted_at=NULL,updated_at=now()
                    WHERE resource_type=%s AND id=%s AND version=%s
                    RETURNING version,created_at,updated_at
                    """,
                    (Jsonb(item), resource, record_id, int(expected_version)),
                )
            row = await cur.fetchone()
    if not row:
        raise RuntimeError("Conflito de edição: existe uma versão mais recente deste registro.")
    return {
        **item,
        "_version": int(row[0]),
        "_createdAt": iso_value(row[1]),
        "_updatedAt": iso_value(row[2]),
    }


async def delete_record(resource: str, record_id: str, *, expected_version: int | None = None) -> bool:
    resource, record_id = normalize_resource(resource), normalize_id(record_id)
    await ensure_domain_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            if expected_version is None:
                await cur.execute(
                    """
                    UPDATE public.smg_domain_records
                    SET deleted_at=now(),version=version+1,updated_at=now()
                    WHERE resource_type=%s AND id=%s AND deleted_at IS NULL
                    RETURNING id
                    """,
                    (resource, record_id),
                )
            else:
                await cur.execute(
                    """
                    UPDATE public.smg_domain_records
                    SET deleted_at=now(),version=version+1,updated_at=now()
                    WHERE resource_type=%s AND id=%s AND deleted_at IS NULL AND version=%s
                    RETURNING id
                    """,
                    (resource, record_id, int(expected_version)),
                )
            return (await cur.fetchone()) is not None


async def migrate_supplemental_state_with_cursor(cur, state: dict) -> dict:
    """Mirror compatibility collections using the caller transaction."""
    migrated = 0
    for state_key, value in as_dict(state).items():
        resource = STATE_RESOURCE_ALIASES.get(state_key)
        if not resource or resource in {
            "students", "activities", "payments", "attendance", "events",
            "event-participants", "tasks", "employees",
        }:
            continue
        rows = value if isinstance(value, list) else [value] if isinstance(value, dict) else []
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            item = {key: val for key, val in raw.items() if not str(key).startswith("_")}
            record_id = normalize_id(item.get("id") or ("default" if isinstance(value, dict) else ""))
            item["id"] = record_id
            await cur.execute(
                """
                INSERT INTO public.smg_domain_records(resource_type,id,data,version,deleted_at,updated_at)
                VALUES (%s,%s,%s,1,NULL,now())
                ON CONFLICT(resource_type,id) DO UPDATE SET
                  data=EXCLUDED.data,
                  version=public.smg_domain_records.version+1,
                  deleted_at=NULL,
                  updated_at=now()
                """,
                (resource, record_id, Jsonb(item)),
            )
            migrated += 1
    return {"migrated": migrated, "updatedAt": iso_now()}


async def migrate_supplemental_state(state: dict) -> dict:
    """Mirror compatibility collections as independent versioned rows without deleting source data."""
    await ensure_domain_schema()
    async with connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                return await migrate_supplemental_state_with_cursor(cur, state)
