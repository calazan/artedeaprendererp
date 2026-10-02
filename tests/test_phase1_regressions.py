from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import pytest
from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from starlette.requests import Request

import smg.backups as backups
import smg.domains as domains
import smg.state as state
import smg.whatsapp as whatsapp
from smg import db
from smg.routers import sync as sync_router


TARGET_TABLES = (
    "public.smg_domain_records",
    "public.smg_manual_backups",
    "public.smg_whatsapp_message_log",
    "public.smg_whatsapp_recipients",
)
TEST_DAY = "2026-10-02"
TEST_STUDENT = "phase1-attendance-student"
PAYMENT_IDS = ("phase1-payment-p1", "phase1-payment-p2")


def _test_database_url() -> str:
    value = str(os.getenv("TEST_DATABASE_URL") or "").strip()
    if not value:
        pytest.skip("TEST_DATABASE_URL não configurada; teste PostgreSQL real ignorado.")
    return value


def reset_schema_flags() -> None:
    state._schema_ready = False
    domains._schema_ready = False
    backups._schema_ready = False
    whatsapp._schema_ready = False


async def admin_execute(url: str, statement: str, params=None, *, fetch: bool = False):
    conn = await AsyncConnection.connect(url, autocommit=True)
    try:
        async with conn.cursor() as cur:
            await cur.execute(statement, params)
            if fetch:
                return await cur.fetchall()
            return None
    finally:
        await conn.close()


async def drop_compat_roles(url: str) -> None:
    await admin_execute(
        url,
        """
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
            EXECUTE 'DROP OWNED BY anon';
            EXECUTE 'DROP ROLE anon';
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
            EXECUTE 'DROP OWNED BY authenticated';
            EXECUTE 'DROP ROLE authenticated';
          END IF;
        END
        $$;
        """,
    )


async def prepare_database(monkeypatch) -> str:
    url = _test_database_url()
    monkeypatch.setenv("DATABASE_URL", url)
    await db.close_pool()
    reset_schema_flags()
    return url


def test_schema_ensure_functions_work_without_and_with_supabase_roles(monkeypatch):
    async def scenario():
        url = await prepare_database(monkeypatch)
        try:
            try:
                await drop_compat_roles(url)
            except Exception as exc:
                pytest.skip(f"O TEST_DATABASE_URL precisa permitir CREATE/DROP ROLE para este teste: {exc}")

            # Cenário que quebrava no Neon/PostgreSQL sem os papéis do Supabase.
            reset_schema_flags()
            await domains.ensure_domain_schema()
            await backups.ensure_backup_schema()
            await whatsapp.ensure_schema()

            tables = await admin_execute(
                url,
                "SELECT to_regclass(name)::text FROM unnest(%s::text[]) AS names(name)",
                (list(TARGET_TABLES),),
                fetch=True,
            )
            assert len(tables) == len(TARGET_TABLES)
            assert all(row[0] for row in tables)

            # Agora cria os papéis, concede SELECT e confirma que os ensure_* realmente revogam.
            await admin_execute(url, "CREATE ROLE anon NOLOGIN")
            await admin_execute(url, "CREATE ROLE authenticated NOLOGIN")
            for table in TARGET_TABLES:
                await admin_execute(url, f"GRANT SELECT ON TABLE {table} TO anon, authenticated")

            reset_schema_flags()
            await domains.ensure_domain_schema()
            await backups.ensure_backup_schema()
            await whatsapp.ensure_schema()

            for role in ("anon", "authenticated"):
                for table in TARGET_TABLES:
                    rows = await admin_execute(
                        url,
                        "SELECT has_table_privilege(%s, %s, 'SELECT')",
                        (role, table),
                        fetch=True,
                    )
                    assert rows[0][0] is False
        finally:
            try:
                await drop_compat_roles(url)
            finally:
                await db.close_pool()
                reset_schema_flags()

    asyncio.run(scenario())


def test_payment_deleted_and_recreated_with_same_business_key_survives(monkeypatch):
    async def scenario():
        url = await prepare_database(monkeypatch)
        try:
            await state.ensure_core_schema()
            await admin_execute(
                url,
                "DELETE FROM public.smg_payments WHERE id = ANY(%s::text[])",
                (list(PAYMENT_IDS),),
            )
            p1 = {
                "id": PAYMENT_IDS[0],
                "studentId": "phase1-student",
                "period": "2026-10",
                "amount": 100,
                "status": "open",
            }
            p2 = {
                "id": PAYMENT_IDS[1],
                "studentId": "phase1-student",
                "period": "2026-10",
                "amount": 120,
                "status": "open",
            }
            await state.sync_critical_state({"state": {"payments": [p1]}, "deleted": {}})
            await state.sync_critical_state(
                {
                    "state": {"payments": [p2]},
                    "deleted": {"payments": [PAYMENT_IDS[0]]},
                }
            )
            payments = [
                item
                for item in (await state.fetch_critical_state())["payments"]
                if item.get("id") in PAYMENT_IDS
            ]
            assert [
                {key: value for key, value in item.items() if key != "updatedAt"}
                for item in payments
            ] == [p2]
            assert payments[0]["updatedAt"]
        finally:
            await admin_execute(
                url,
                "DELETE FROM public.smg_payments WHERE id = ANY(%s::text[])",
                (list(PAYMENT_IDS),),
            )
            await db.close_pool()
            reset_schema_flags()

    asyncio.run(scenario())


def test_attendance_uses_real_timestamps_and_teacher_merge(monkeypatch):
    async def scenario():
        url = await prepare_database(monkeypatch)
        try:
            await state.ensure_core_schema()
            await admin_execute(
                url,
                "DELETE FROM public.smg_attendance WHERE attendance_date=%s::date AND student_id LIKE %s",
                (TEST_DAY, "phase1-attendance-%"),
            )

            teacher_time = datetime.now(timezone.utc)
            await state.save_attendance_records(
                TEST_DAY,
                {
                    TEST_STUDENT: {
                        "status": "present",
                        "note": "Observação preservada",
                        "checkIn": "08:00",
                        "checkOut": "12:00",
                        "hours": 4,
                        "updatedAt": teacher_time.isoformat().replace("+00:00", "Z"),
                    }
                },
            )

            # Admin antigo, sem updatedAt, não pode vencer o professor.
            await state.sync_critical_state(
                {
                    "state": {
                        "attendance": {
                            TEST_DAY: {
                                TEST_STUDENT: {"status": "absent"}
                            }
                        }
                    },
                    "deleted": {},
                }
            )
            record = (await state.fetch_critical_state())["attendance"][TEST_DAY][TEST_STUDENT]
            assert record["status"] == "present"
            assert record["note"] == "Observação preservada"

            admin_time = teacher_time + timedelta(minutes=5)
            await state.sync_critical_state(
                {
                    "state": {
                        "attendance": {
                            TEST_DAY: {
                                TEST_STUDENT: {
                                    "status": "absent",
                                    "note": "Admin mais novo",
                                    "checkIn": "08:00",
                                    "checkOut": "12:00",
                                    "hours": 4,
                                    "updatedAt": admin_time.isoformat().replace("+00:00", "Z"),
                                }
                            }
                        }
                    },
                    "deleted": {},
                }
            )
            record = (await state.fetch_critical_state())["attendance"][TEST_DAY][TEST_STUDENT]
            assert record["status"] == "absent"

            # Professor com carimbo mais antigo não sobrescreve o admin mais novo.
            await state.save_attendance_records(
                TEST_DAY,
                {
                    TEST_STUDENT: {
                        "status": "present",
                        "updatedAt": (admin_time - timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
                    }
                },
            )
            record = (await state.fetch_critical_state())["attendance"][TEST_DAY][TEST_STUDENT]
            assert record["status"] == "absent"
            assert record["note"] == "Admin mais novo"

            # Professor mais novo altera só o que enviou; campos omitidos são preservados.
            await state.save_attendance_records(
                TEST_DAY,
                {
                    TEST_STUDENT: {
                        "status": "present",
                        "updatedAt": (admin_time + timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
                    }
                },
            )
            record = (await state.fetch_critical_state())["attendance"][TEST_DAY][TEST_STUDENT]
            assert record["status"] == "present"
            assert record["note"] == "Admin mais novo"
            assert record["checkIn"] == "08:00"
            assert record["checkOut"] == "12:00"
            assert record["hours"] == 4

            # Registro legado sem updatedAt deve ser estável entre leituras, não receber "agora".
            legacy_student = "phase1-attendance-legacy"
            await admin_execute(
                url,
                """
                INSERT INTO public.smg_attendance(attendance_date,student_id,record,updated_at)
                VALUES (%s::date,%s,%s,now())
                ON CONFLICT(attendance_date,student_id) DO UPDATE
                SET record=EXCLUDED.record,updated_at=now()
                """,
                (TEST_DAY, legacy_student, Jsonb({"status": "present"})),
            )
            first = (await state.fetch_critical_state())["attendance"][TEST_DAY][legacy_student]
            second = (await state.fetch_critical_state())["attendance"][TEST_DAY][legacy_student]
            assert first["updatedAt"] == state.ATTENDANCE_EPOCH
            assert second["updatedAt"] == state.ATTENDANCE_EPOCH
        finally:
            await admin_execute(
                url,
                "DELETE FROM public.smg_attendance WHERE attendance_date=%s::date AND student_id LIKE %s",
                (TEST_DAY, "phase1-attendance-%"),
            )
            await db.close_pool()
            reset_schema_flags()

    asyncio.run(scenario())


def make_json_request(payload: dict) -> Request:
    encoded = json.dumps(payload).encode("utf-8")
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": encoded, "more_body": False}

    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "https",
            "path": "/api/supabase-sync",
            "raw_path": b"/api/supabase-sync",
            "query_string": b"",
            "headers": [],
            "server": ("erp.example", 443),
            "client": ("127.0.0.1", 1234),
        },
        receive,
    )


def test_direct_supabase_sync_sanitizes_sensitive_state(monkeypatch):
    captured = {}

    async def fake_fetch():
        return {"settings": {}, "updatedAt": "2026-10-02T12:00:00Z"}

    async def fake_backup(*args, **kwargs):
        return None

    async def fake_sync(payload):
        captured["payload"] = payload
        return {"updatedAt": "2026-10-02T12:01:00Z"}

    async def fake_audit(*args, **kwargs):
        return None

    async def fake_counts():
        return {"students": 1}

    async def fake_revision():
        return 0

    async def fake_tombstones():
        return {}

    @asynccontextmanager
    async def fake_lock():
        yield

    monkeypatch.setattr(sync_router, "database_configured", lambda: True)
    monkeypatch.setattr(sync_router, "sync_authorized", lambda request, body: True)
    monkeypatch.setattr(sync_router, "fetch_critical_state", fake_fetch)
    monkeypatch.setattr(sync_router, "capture_backup", fake_backup)
    monkeypatch.setattr(sync_router, "sync_critical_state", fake_sync)
    monkeypatch.setattr(sync_router, "record_audit", fake_audit)
    monkeypatch.setattr(sync_router, "database_counts", fake_counts)
    monkeypatch.setattr(sync_router, "get_sync_revision", fake_revision)
    monkeypatch.setattr(sync_router, "fetch_sync_tombstones", fake_tombstones)
    monkeypatch.setattr(sync_router, "sync_advisory_lock", fake_lock)

    request = make_json_request(
        {
            "state": {
                "students": [{"id": "s1", "name": "Aluno"}],
                "syncKey": "segredo-indevido",
                "settings": {
                    "theme": "dark",
                    "password": "1234",
                    "passwordHash": "hash",
                    "passwordEnabled": True,
                    "passwordSecurityVersion": "x",
                    "remoteSync": {"syncKey": "outro-segredo"},
                },
            }
        }
    )
    response = asyncio.run(sync_router.direct_supabase_sync(request))
    assert response.status_code == 200
    sent = captured["payload"]["state"]
    assert sent["settings"] == {"theme": "dark"}
    assert "syncKey" not in sent
