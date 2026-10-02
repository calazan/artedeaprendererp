from __future__ import annotations

import copy
import json
import re
from datetime import date
from decimal import Decimal
from typing import Any

from psycopg import sql
from psycopg.types.json import Jsonb

from .db import connection
from .utils import as_dict, as_list, iso_now, iso_value, jsonable

SCHEMA_VERSION = 2
_schema_ready = False


class StateValidationError(ValueError):
    def __init__(self, public_message: str):
        self.public_message = str(public_message or "Dados inválidos.")[:300]
        super().__init__(self.public_message)


class SyncConflictError(RuntimeError):
    pass

CORE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS public.smg_students (
  id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.smg_activities (
  id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.smg_payments (
  id text PRIMARY KEY,
  student_id text NOT NULL DEFAULT '',
  period text NOT NULL DEFAULT '',
  amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_payments_student_period_idx
  ON public.smg_payments(student_id, period) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS public.smg_extra_events (
  id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.smg_extra_participants (
  id text PRIMARY KEY,
  event_id text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_extra_participants_event_idx
  ON public.smg_extra_participants(event_id);
CREATE TABLE IF NOT EXISTS public.smg_attendance (
  attendance_date date NOT NULL,
  student_id text NOT NULL,
  record jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attendance_date, student_id)
);
CREATE INDEX IF NOT EXISTS smg_attendance_date_idx
  ON public.smg_attendance(attendance_date);
CREATE TABLE IF NOT EXISTS public.smg_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.smg_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_extra_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_extra_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_meta ENABLE ROW LEVEL SECURITY;
"""


async def ensure_core_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(CORE_SCHEMA_SQL)
            await cur.execute(
                """
                INSERT INTO public.smg_meta(key, value, updated_at)
                VALUES ('schema', %s, now())
                ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = now()
                """,
                (Jsonb({"version": SCHEMA_VERSION}),),
            )
            await cur.execute(
                """
                INSERT INTO public.smg_meta(key, value, updated_at)
                VALUES ('sync_revision', %s, now())
                ON CONFLICT (key) DO NOTHING
                """,
                (Jsonb({"revision": 0}),),
            )
    _schema_ready = True


def safe_decimal(value: Any, field: str) -> Decimal:
    try:
        result = Decimal(str(value if value not in (None, "") else 0))
    except Exception as exc:
        raise StateValidationError(f"Valor numérico inválido em {field}.") from exc
    if not result.is_finite():
        raise StateValidationError(f"Valor numérico inválido em {field}.")
    return result


def safe_float(value: Any, field: str) -> float:
    result = safe_decimal(value, field)
    return float(result)


def normalize_attendance_record(record: Any) -> dict:
    item = as_dict(record)
    status = str(item.get("status") or "")
    if status not in {"present", "absent", "excused", "unset"}:
        status = "unset"
    return {
        "status": status,
        "note": str(item.get("note") or ""),
        "checkIn": str(item.get("checkIn") or ""),
        "checkOut": str(item.get("checkOut") or ""),
        "hours": safe_float(item.get("hours") or 0, "attendance.hours"),
        "updatedAt": str(item.get("updatedAt") or iso_now()),
        "source": str(item.get("source") or "neon-postgres"),
    }


def payment_business_key(payment: dict) -> str:
    student_id = str(payment.get("student_id") or payment.get("studentId") or "").strip()
    period = str(payment.get("period") or "").strip()
    return f"{student_id}::{period}" if student_id and period else ""


def dedupe_incoming_payments(rows: list[dict]) -> list[dict]:
    by_key: dict[str, dict] = {}
    without_key: dict[str, dict] = {}
    for row in rows:
        key = payment_business_key(row)
        if not key:
            without_key[str(row.get("id") or "")] = row
            continue
        current = by_key.get(key)
        if current is None or (current.get("status") != "paid" and row.get("status") == "paid"):
            by_key[key] = row
    return [row for row in [*by_key.values(), *without_key.values()] if row.get("id")]


def supplemental_state(state: dict) -> dict:
    result = copy.deepcopy(as_dict(state))
    for key in ("students", "activityCatalog", "extraEvents", "extraParticipants", "attendance", "payments"):
        result.pop(key, None)
    return result


ENTITY_TABLES = frozenset({
    "smg_students",
    "smg_activities",
    "smg_extra_events",
    "smg_extra_participants",
})


def _entity_table_identifier(table: str):
    if table not in ENTITY_TABLES:
        raise StateValidationError("Tabela interna inválida.")
    return sql.Identifier(table)


async def _upsert_entity_rows(cur, table: str, rows: list[dict], has_status: bool = False, event_id: bool = False) -> None:
    if not rows:
        return
    table_id = _entity_table_identifier(table)
    if has_status:
        query = sql.SQL(
            """
            INSERT INTO public.{}(id, data, status, updated_at)
            VALUES (%s, %s, %s, now())
            ON CONFLICT (id) DO UPDATE
            SET data = EXCLUDED.data, status = EXCLUDED.status, updated_at = now()
            """
        ).format(table_id)
        await cur.executemany(
            query,
            [(r["id"], Jsonb(r["data"]), r["status"]) for r in rows],
        )
    elif event_id:
        query = sql.SQL(
            """
            INSERT INTO public.{}(id, event_id, data, updated_at)
            VALUES (%s, %s, %s, now())
            ON CONFLICT (id) DO UPDATE
            SET event_id = EXCLUDED.event_id, data = EXCLUDED.data, updated_at = now()
            """
        ).format(table_id)
        await cur.executemany(
            query,
            [(r["id"], r["event_id"], Jsonb(r["data"])) for r in rows],
        )
    else:
        query = sql.SQL(
            """
            INSERT INTO public.{}(id, data, updated_at)
            VALUES (%s, %s, now())
            ON CONFLICT (id) DO UPDATE
            SET data = EXCLUDED.data, updated_at = now()
            """
        ).format(table_id)
        await cur.executemany(
            query,
            [(r["id"], Jsonb(r["data"])) for r in rows],
        )


async def _delete_ids(cur, table: str, ids: list[str]) -> None:
    clean = sorted({str(v or "").strip() for v in ids if str(v or "").strip()})
    if clean:
        query = sql.SQL("DELETE FROM public.{} WHERE id = ANY(%s::text[])").format(
            _entity_table_identifier(table)
        )
        await cur.execute(query, (clean,))


async def _sync_payments(cur, rows: list[dict], deleted_ids: list[str]) -> None:
    incoming = dedupe_incoming_payments(rows)

    await cur.execute("SELECT id, student_id, period FROM public.smg_payments WHERE deleted_at IS NULL")
    active_rows = await cur.fetchall()
    active_by_key = {}
    active_by_id = {}
    for row in active_rows:
        item = {"id": row[0], "student_id": row[1], "period": row[2]}
        active_by_id[str(row[0])] = item
        key = payment_business_key(item)
        if key:
            active_by_key[key] = item

    existing_by_id = {}
    ids = [str(r["id"]) for r in incoming if r.get("id")]
    if ids:
        await cur.execute(
            "SELECT id, deleted_at FROM public.smg_payments WHERE id = ANY(%s::text[])",
            (ids,),
        )
        existing_by_id = {str(row[0]): {"deleted_at": row[1]} for row in await cur.fetchall()}

    accepted = []
    for row in incoming:
        row_id = str(row.get("id") or "")
        key = payment_business_key(row)
        occupying = active_by_key.get(key) if key else None
        if occupying and str(occupying["id"]) != row_id:
            continue
        existing = existing_by_id.get(row_id)
        if existing and existing.get("deleted_at") and row_id not in active_by_id:
            continue
        accepted.append(row)

    if accepted:
        await cur.executemany(
            """
            INSERT INTO public.smg_payments
              (id, student_id, period, amount, status, data, deleted_at, updated_at)
            VALUES (%s,%s,%s,%s,%s,%s,NULL,now())
            ON CONFLICT (id) DO UPDATE SET
              student_id = EXCLUDED.student_id,
              period = EXCLUDED.period,
              amount = EXCLUDED.amount,
              status = EXCLUDED.status,
              data = EXCLUDED.data,
              deleted_at = NULL,
              updated_at = now()
            """,
            [
                (
                    str(r.get("id") or ""),
                    str(r.get("student_id") or ""),
                    str(r.get("period") or ""),
                    safe_decimal(r.get("amount") or 0, "payments.amount"),
                    str(r.get("status") or "open"),
                    Jsonb(r.get("data") or {}),
                )
                for r in accepted
            ],
        )

    deleted = sorted({str(v or "").strip() for v in deleted_ids if str(v or "").strip()})
    if deleted:
        await cur.execute(
            """
            UPDATE public.smg_payments
            SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
            WHERE deleted_at IS NULL AND id = ANY(%s::text[])
            """,
            (deleted,),
        )


async def get_sync_revision() -> int:
    await ensure_core_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT COALESCE((value->>'revision')::bigint,0) FROM public.smg_meta WHERE key='sync_revision' LIMIT 1"
            )
            row = await cur.fetchone()
    return int(row[0] or 0) if row else 0


async def sync_critical_state(payload: dict) -> dict:
    await ensure_core_schema()
    from .audit import ensure_audit_schema
    from .backups import create_backup, ensure_backup_schema
    from .domains import ensure_domain_schema, migrate_supplemental_state_with_cursor

    await ensure_audit_schema()
    await ensure_backup_schema()
    await ensure_domain_schema()
    state = as_dict(payload.get("state"))
    deleted = as_dict(payload.get("deleted"))
    now = iso_now()
    expected_revision_raw = payload.get("expectedRevision")
    expected_revision = None if expected_revision_raw is None else int(expected_revision_raw)
    destructive = payload.get("destructive") is True
    replace_all = payload.get("replaceAll") is True
    backup_snapshot = as_dict(payload.get("backupSnapshot"))
    backup_reason = str(payload.get("backupReason") or "pre-destructive-sync")
    backup_actor = str(payload.get("backupActor") or "")

    students = [
        {"id": str(item["id"]), "data": item, "status": str(item.get("status") or "active")}
        for item in as_list(state.get("students"))
        if isinstance(item, dict) and item.get("id")
    ]
    activities = [
        {"id": str(item["id"]), "data": item}
        for item in as_list(state.get("activityCatalog"))
        if isinstance(item, dict) and item.get("id")
    ]
    events = [
        {"id": str(item["id"]), "data": item}
        for item in as_list(state.get("extraEvents"))
        if isinstance(item, dict) and item.get("id")
    ]
    participants = [
        {"id": str(item["id"]), "event_id": str(item.get("eventId") or ""), "data": item}
        for item in as_list(state.get("extraParticipants"))
        if isinstance(item, dict) and item.get("id")
    ]
    payments = [
        {
            "id": str(item["id"]),
            "student_id": str(item.get("studentId") or ""),
            "period": str(item.get("period") or ""),
            "amount": item.get("amount") or 0,
            "status": str(item.get("status") or "open"),
            "data": item,
        }
        for item in as_list(state.get("payments"))
        if isinstance(item, dict) and item.get("id")
    ]

    attendance_rows = []
    for day, records in as_dict(state.get("attendance")).items():
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(day)):
            continue
        for student_id, record in as_dict(records).items():
            if student_id:
                attendance_rows.append(
                    (str(day), str(student_id), normalize_attendance_record(record))
                )

    async with connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                if expected_revision is None:
                    await cur.execute(
                        "SELECT COALESCE((value->>'revision')::bigint,0) FROM public.smg_meta WHERE key='sync_revision' FOR UPDATE"
                    )
                    row = await cur.fetchone()
                    current_revision = int(row[0] or 0) if row else 0
                    next_revision = current_revision + 1
                    await cur.execute(
                        """
                        UPDATE public.smg_meta
                        SET value=%s,updated_at=now()
                        WHERE key='sync_revision'
                        """,
                        (Jsonb({"revision": next_revision}),),
                    )
                else:
                    next_revision = expected_revision + 1
                    await cur.execute(
                        """
                        UPDATE public.smg_meta
                        SET value=%s,updated_at=now()
                        WHERE key='sync_revision'
                          AND COALESCE((value->>'revision')::bigint,0)=%s
                        RETURNING key
                        """,
                        (Jsonb({"revision": next_revision}), expected_revision),
                    )
                    if not await cur.fetchone():
                        raise SyncConflictError("REMOTE_CONFLICT")

                if destructive and backup_snapshot:
                    await create_backup(
                        backup_snapshot,
                        backup_reason,
                        backup_actor,
                        cur=cur,
                    )

                if replace_all:
                    await cur.execute("DELETE FROM public.smg_attendance")
                    await cur.execute("DELETE FROM public.smg_payments")
                    await cur.execute("DELETE FROM public.smg_extra_participants")
                    await cur.execute("DELETE FROM public.smg_extra_events")
                    await cur.execute("DELETE FROM public.smg_activities")
                    await cur.execute("DELETE FROM public.smg_students")
                    await cur.execute(
                        """
                        DELETE FROM public.smg_domain_records
                        WHERE resource_type = ANY(%s::text[])
                        """,
                        ([
                            "other-income", "expenses", "financial-categories",
                            "bank-accounts", "bank-movements", "calendar-events",
                            "rental-partners", "rental-contracts", "rental-receivables",
                            "rental-repasses", "rental-assets", "proposals",
                            "company-settings", "security-settings", "print-settings",
                            "integration-settings",
                        ],),
                    )

                await _upsert_entity_rows(cur, "smg_students", students, has_status=True)
                await _upsert_entity_rows(cur, "smg_activities", activities)
                await _upsert_entity_rows(cur, "smg_extra_events", events)
                await _upsert_entity_rows(cur, "smg_extra_participants", participants, event_id=True)
                await _sync_payments(cur, payments, as_list(deleted.get("payments")))

                if attendance_rows:
                    await cur.executemany(
                        """
                        INSERT INTO public.smg_attendance(attendance_date, student_id, record, updated_at)
                        VALUES (%s::date,%s,%s,now())
                        ON CONFLICT (attendance_date, student_id) DO UPDATE
                        SET record = EXCLUDED.record, updated_at = now()
                        WHERE COALESCE(public.smg_attendance.record->>'updatedAt','')
                              <= COALESCE(EXCLUDED.record->>'updatedAt','')
                        """,
                        [(d, s, Jsonb(r)) for d, s, r in attendance_rows],
                    )

                await _delete_ids(cur, "smg_students", as_list(deleted.get("students")))
                await _delete_ids(cur, "smg_activities", as_list(deleted.get("activityCatalog")))
                await _delete_ids(cur, "smg_extra_events", as_list(deleted.get("extraEvents")))
                await _delete_ids(cur, "smg_extra_participants", as_list(deleted.get("extraParticipants")))

                await cur.execute(
                    """
                    INSERT INTO public.smg_meta(key, value, updated_at)
                    VALUES ('supplemental_state', %s, now())
                    ON CONFLICT (key) DO UPDATE
                    SET value = EXCLUDED.value, updated_at = now()
                    """,
                    (Jsonb(supplemental_state(state)),),
                )
                await cur.execute(
                    """
                    INSERT INTO public.smg_meta(key, value, updated_at)
                    VALUES ('critical_state', %s, now())
                    ON CONFLICT (key) DO UPDATE
                    SET value = EXCLUDED.value, updated_at = now()
                    """,
                    (
                        Jsonb(
                            {
                                "updatedAt": now,
                                "clientId": str(payload.get("clientId") or ""),
                                "source": str(payload.get("source") or "admin-app"),
                                "revision": next_revision,
                            }
                        ),
                    ),
                )

                # O espelho por domínio participa da mesma transação do snapshot,
                # evitando estado parcialmente migrado em caso de conflito/falha.
                domain_result = await migrate_supplemental_state_with_cursor(cur, state)

    return {
        "updatedAt": now,
        "domainRecords": domain_result["migrated"],
        "revision": next_revision,
    }


async def fetch_critical_state() -> dict:
    await ensure_core_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT data FROM public.smg_students ORDER BY lower(COALESCE(data->>'name',''))")
            students = [row[0] or {} for row in await cur.fetchall()]

            await cur.execute("SELECT data FROM public.smg_activities ORDER BY lower(COALESCE(data->>'name',''))")
            activities = [row[0] or {} for row in await cur.fetchall()]

            await cur.execute(
                "SELECT data FROM public.smg_extra_events ORDER BY COALESCE(data->>'startDate',''), lower(COALESCE(data->>'name',''))"
            )
            events = [row[0] or {} for row in await cur.fetchall()]

            await cur.execute("SELECT data FROM public.smg_extra_participants ORDER BY lower(COALESCE(data->>'name',''))")
            participants = [row[0] or {} for row in await cur.fetchall()]

            await cur.execute(
                "SELECT data FROM public.smg_payments WHERE deleted_at IS NULL ORDER BY period, student_id, id"
            )
            payments = [row[0] or {} for row in await cur.fetchall()]

            await cur.execute(
                "SELECT attendance_date::text, student_id, record FROM public.smg_attendance ORDER BY attendance_date, student_id"
            )
            attendance_rows = await cur.fetchall()

            await cur.execute("SELECT value, updated_at FROM public.smg_meta WHERE key='critical_state' LIMIT 1")
            meta = await cur.fetchone()

            await cur.execute("SELECT value, updated_at FROM public.smg_meta WHERE key='supplemental_state' LIMIT 1")
            supplemental = await cur.fetchone()

    attendance = {}
    for day, student_id, record in attendance_rows:
        attendance.setdefault(str(day), {})[str(student_id)] = normalize_attendance_record(record or {})

    result = dict((supplemental[0] if supplemental else {}) or {})
    result.update(
        {
            "students": students,
            "activityCatalog": activities,
            "extraEvents": events,
            "extraParticipants": participants,
            "payments": payments,
            "attendance": attendance,
        }
    )
    updated = ""
    if meta:
        updated = str((meta[0] or {}).get("updatedAt") or iso_value(meta[1]))
    elif supplemental:
        updated = iso_value(supplemental[1])
    result["updatedAt"] = updated
    return jsonable(result)


async def database_counts() -> dict:
    await ensure_core_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  (SELECT count(*)::int FROM public.smg_students),
                  (SELECT count(*)::int FROM public.smg_activities),
                  (SELECT count(*)::int FROM public.smg_extra_events),
                  (SELECT count(*)::int FROM public.smg_extra_participants),
                  (SELECT count(*)::int FROM public.smg_attendance),
                  (SELECT count(*)::int FROM public.smg_payments WHERE deleted_at IS NULL)
                """
            )
            row = await cur.fetchone()
    return {
        "students": int(row[0] or 0),
        "activities": int(row[1] or 0),
        "events": int(row[2] or 0),
        "participants": int(row[3] or 0),
        "attendance": int(row[4] or 0),
        "payments": int(row[5] or 0),
    }


async def save_attendance_records(day: str, records: dict) -> dict:
    await ensure_core_schema()
    now = iso_now()
    rows = []
    for student_id, record in as_dict(records).items():
        if not student_id:
            continue
        normalized = normalize_attendance_record(
            {
                **as_dict(record),
                "updatedAt": now,
                "source": "teacher-page-neon",
            }
        )
        rows.append((day, str(student_id), normalized))
    if not rows:
        return {"updatedAt": now}

    async with connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                await cur.executemany(
                    """
                    INSERT INTO public.smg_attendance(attendance_date, student_id, record, updated_at)
                    VALUES (%s::date,%s,%s,now())
                    ON CONFLICT (attendance_date, student_id) DO UPDATE
                    SET record=EXCLUDED.record, updated_at=now()
                    """,
                    [(d, s, Jsonb(r)) for d, s, r in rows],
                )
                await cur.execute(
                    """
                    INSERT INTO public.smg_meta(key,value,updated_at)
                    VALUES ('critical_state',%s,now())
                    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
                    """,
                    (Jsonb({"updatedAt": now, "source": "teacher-page-neon"}),),
                )
    return {"updatedAt": now}


def teacher_public_state(critical: dict) -> dict:
    regular = []
    for student in as_list(critical.get("students")):
        if not isinstance(student, dict) or not student.get("id") or student.get("status") != "active":
            continue
        activity_items = []
        for item in as_list(student.get("activityItems")):
            if isinstance(item, dict):
                activity_items.append(
                    {
                        "id": str(item.get("id") or ""),
                        "activityId": str(item.get("activityId") or ""),
                        "name": str(item.get("name") or ""),
                        "startDate": str(item.get("startDate") or ""),
                        "hours": float(item.get("hours") or 0),
                    }
                )
        regular.append(
            {
                "id": str(student["id"]),
                "name": str(student.get("name") or ""),
                "activities": str(student.get("activities") or ""),
                "activityItems": activity_items,
                "status": "active",
                "isExtraParticipant": False,
                "eventMemberships": [],
            }
        )

    by_id = {item["id"]: item for item in regular}
    events = as_list(critical.get("extraEvents"))
    participants = as_list(critical.get("extraParticipants"))

    for event in events:
        if not isinstance(event, dict) or not event.get("id"):
            continue
        event_participants = [
            p for p in participants
            if isinstance(p, dict) and p.get("eventId") == event.get("id")
        ]
        if not event_participants:
            continue
        membership = {
            "eventId": str(event["id"]),
            "eventName": str(event.get("name") or "Evento extra"),
            "startDate": str(event.get("startDate") or ""),
            "endDate": str(event.get("endDate") or event.get("startDate") or ""),
        }
        for participant in event_participants:
            linked = str(participant.get("linkedStudentId") or participant.get("studentId") or "")
            if linked and linked in by_id:
                if not any(x.get("eventId") == membership["eventId"] for x in by_id[linked]["eventMemberships"]):
                    by_id[linked]["eventMemberships"].append(dict(membership))
                continue
            if not participant.get("id"):
                continue
            extra_id = f"extra-participant:{participant['id']}"
            if extra_id not in by_id:
                by_id[extra_id] = {
                    "id": extra_id,
                    "name": str(participant.get("name") or "Participante sem nome"),
                    "activities": f"Evento extra: {event.get('name') or 'Evento'}",
                    "activityItems": [],
                    "status": "active",
                    "isExtraParticipant": True,
                    "eventMemberships": [dict(membership)],
                }

    students = sorted(by_id.values(), key=lambda x: (x["name"].casefold(), x["id"]))
    catalog = [
        {"id": str(item.get("id") or ""), "name": str(item.get("name") or "")}
        for item in as_list(critical.get("activityCatalog"))
        if isinstance(item, dict)
    ]
    return {
        "updatedAt": str(critical.get("updatedAt") or ""),
        "students": students,
        "activityCatalog": catalog,
        "attendance": as_dict(critical.get("attendance")),
    }
