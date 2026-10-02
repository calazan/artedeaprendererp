from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager

import pytest
from fastapi import HTTPException
from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from starlette.requests import Request

import smg.audit as audit
import smg.auth as auth
import smg.domains as domains
import smg.state as state
from smg import db
from smg.auth import ADMIN_ROLES, TEACHER_ROLES, SessionConfigurationError
from smg.routers import domains as domains_router
from smg.routers import employees as employees_router
from smg.routers import health as health_router


def request_with_cookie(token: str, *, method: str = "GET") -> Request:
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": [(b"cookie", f"smg_session={token}".encode())],
            "server": ("erp.example", 443),
            "client": ("127.0.0.1", 1234),
        }
    )


def plain_request(path: str = "/", *, method: str = "POST", body: bytes = b"") -> Request:
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [],
            "server": ("erp.example", 443),
            "client": ("127.0.0.1", 1234),
        },
        receive,
    )


def test_membership_is_revalidated_after_short_cache(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "s" * 64)
    monkeypatch.setenv("VERCEL_ENV", "preview")
    auth.clear_membership_cache()

    backing = {
        "value": {
            "role": "owner",
            "displayName": "Admin",
            "organizationId": "00000000-0000-0000-0000-000000000010",
        }
    }
    calls = {"count": 0}
    clock = {"value": 1000.0}

    async def fake_active(user_id: str):
        calls["count"] += 1
        return backing["value"]

    monkeypatch.setattr(auth, "_active_membership", fake_active)
    monkeypatch.setattr(auth.time, "monotonic", lambda: clock["value"])

    token = auth.create_session(
        "00000000-0000-0000-0000-000000000001",
        "owner",
        "Admin",
    )
    request = request_with_cookie(token)

    assert asyncio.run(auth.role_authorized(request, ADMIN_ROLES)) is True
    assert asyncio.run(auth.role_authorized(request, ADMIN_ROLES)) is True
    assert calls["count"] == 1

    backing["value"] = {
        "role": "teacher",
        "displayName": "Professor",
        "organizationId": "00000000-0000-0000-0000-000000000010",
    }
    assert asyncio.run(auth.role_authorized(request, ADMIN_ROLES)) is True
    assert calls["count"] == 1

    clock["value"] += auth.MEMBERSHIP_CACHE_TTL_SECONDS + 1
    assert asyncio.run(auth.role_authorized(request, ADMIN_ROLES)) is False
    assert asyncio.run(auth.role_authorized(request, TEACHER_ROLES)) is True
    assert calls["count"] == 2

    backing["value"] = None
    clock["value"] += auth.MEMBERSHIP_CACHE_TTL_SECONDS + 1
    assert asyncio.run(auth.role_authorized(request, TEACHER_ROLES)) is False
    assert calls["count"] == 3
    auth.clear_membership_cache()


def test_production_requires_dedicated_session_secret(monkeypatch):
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://user:db-secret@ep-example.neon.tech/neondb?sslmode=require",
    )

    with pytest.raises(SessionConfigurationError, match="SESSION_SECRET é obrigatório"):
        auth.create_session(
            "00000000-0000-0000-0000-000000000001",
            "owner",
        )

    health_router._public_health_cache = None
    response = asyncio.run(health_router._health(detailed=True))
    payload = json.loads(response.body)
    assert response.status_code == 503
    assert "SESSION_SECRET" in payload["error"]
    assert payload["environment"]["productionEnvironment"] is True


def _database_url() -> str:
    value = str(os.getenv("TEST_DATABASE_URL") or "").strip()
    if not value:
        pytest.skip("TEST_DATABASE_URL não configurada.")
    return value


async def _sql(url: str, statement: str, params=None, *, fetch: bool = False):
    conn = await AsyncConnection.connect(url, autocommit=True)
    try:
        async with conn.cursor() as cur:
            await cur.execute(statement, params)
            return await cur.fetchall() if fetch else None
    finally:
        await conn.close()


async def _prepare_database(monkeypatch) -> str:
    url = _database_url()
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("VERCEL_ENV", "preview")
    await db.close_pool()
    audit._schema_ready = False
    state._schema_ready = False
    domains._schema_ready = False
    await audit.ensure_audit_schema()
    await state.ensure_core_schema()
    await domains.ensure_domain_schema()
    return url


def test_backup_revision_retention_is_bounded(monkeypatch):
    async def scenario():
        url = await _prepare_database(monkeypatch)
        try:
            await _sql(
                url,
                "DELETE FROM public.smg_backup_revisions WHERE source=%s OR period_key LIKE 'phase5-%%'",
                ("phase5-retention",),
            )
            conn = await AsyncConnection.connect(url, autocommit=True)
            try:
                async with conn.cursor() as cur:
                    for index in range(40):
                        await cur.execute(
                            """
                            INSERT INTO public.smg_backup_revisions
                              (kind,period_key,source,client_id,snapshot,created_at)
                            VALUES ('daily',%s,'phase5-retention','',%s,now()-(%s * interval '1 day'))
                            ON CONFLICT (kind,period_key) DO NOTHING
                            """,
                            (
                                f"phase5-d-{index:02d}",
                                Jsonb({"index": index}),
                                40 - index,
                            ),
                        )
                    for index in range(15):
                        await cur.execute(
                            """
                            INSERT INTO public.smg_backup_revisions
                              (kind,period_key,source,client_id,snapshot,created_at)
                            VALUES ('monthly',%s,'phase5-retention','',%s,now()-(%s * interval '30 days'))
                            ON CONFLICT (kind,period_key) DO NOTHING
                            """,
                            (
                                f"phase5-m-{index:02d}",
                                Jsonb({"index": index}),
                                15 - index,
                            ),
                        )
            finally:
                await conn.close()

            await audit.capture_backup(
                {"students": []},
                source="phase5-retention",
                client_id="phase5-test",
            )
            rows = await _sql(
                url,
                """
                SELECT kind,count(*)::int
                FROM public.smg_backup_revisions
                GROUP BY kind
                ORDER BY kind
                """,
                fetch=True,
            )
            counts = {str(kind): int(count) for kind, count in rows}
            assert counts["daily"] <= audit.DAILY_BACKUP_RETENTION
            assert counts["monthly"] <= audit.MONTHLY_BACKUP_RETENTION
        finally:
            await _sql(
                url,
                "DELETE FROM public.smg_backup_revisions WHERE source=%s OR period_key LIKE 'phase5-%%'",
                ("phase5-retention",),
            )
            await db.close_pool()
            audit._schema_ready = False
            state._schema_ready = False
            domains._schema_ready = False

    asyncio.run(scenario())


def test_restore_creates_safety_backup_before_sync(monkeypatch):
    calls: list[tuple[str, object]] = []

    current = {
        "students": [{"id": "old", "name": "Atual"}],
        "activityCatalog": [],
        "extraEvents": [],
        "extraParticipants": [],
        "payments": [],
        "attendance": {},
        "otherIncomes": [],
        "expenses": [],
        "proposals": [],
        "expenseCategories": [],
        "agendaEvents": [],
        "bankAccounts": [],
        "bankMovements": [],
        "paymentExclusions": [],
        "rentalManagement": {},
        "settings": {},
    }
    restored = {
        **current,
        "students": [{"id": "restored", "name": "Backup"}],
    }

    async def fake_admin(request):
        return {
            "userId": "00000000-0000-0000-0000-000000000001",
            "role": "owner",
            "displayName": "Admin",
            "organizationId": "org",
        }

    async def fake_get_backup(backup_id):
        return {"id": backup_id, "snapshot": restored}

    async def fake_fetch():
        return current

    async def fake_create(snapshot, reason="manual", created_by=""):
        calls.append(("backup", reason))
        return {"id": "safety-id", "checksum": "x", "createdAt": "2026-10-02T12:00:00Z"}

    async def fake_revision():
        return 9

    async def fake_sync(payload):
        calls.append(("sync", payload))
        return {"updatedAt": "2026-10-02T12:01:00Z"}

    async def fake_audit(*args, **kwargs):
        calls.append(("audit", kwargs))

    async def fake_exclusions():
        return {
            "employeeDocuments": {
                "included": False,
                "count": 2,
                "sizeBytes": 100,
                "warning": "fora do snapshot",
            }
        }

    monkeypatch.setattr(domains_router, "authorize_admin", fake_admin)
    monkeypatch.setattr(domains_router, "get_backup", fake_get_backup)
    monkeypatch.setattr(domains_router, "fetch_critical_state", fake_fetch)
    monkeypatch.setattr(domains_router, "create_backup", fake_create)
    monkeypatch.setattr(domains_router, "get_sync_revision", fake_revision)
    monkeypatch.setattr(domains_router, "sync_critical_state", fake_sync)
    monkeypatch.setattr(domains_router, "record_audit", fake_audit)
    monkeypatch.setattr(domains_router, "backup_exclusions_report", fake_exclusions)

    result = asyncio.run(
        domains_router.backup_restore(
            plain_request("/api/backups/backup-id/restore"),
            "backup-id",
            domains_router.RestorePayload(confirm="RESTORE"),
        )
    )

    assert calls[0][0] == "backup"
    assert calls[1][0] == "sync"
    sync_payload = calls[1][1]
    assert sync_payload["forceRestore"] is True
    assert sync_payload["syncRevision"] == 10
    assert sync_payload["deleted"]["students"] == ["old"]
    assert result["safetyBackupId"] == "safety-id"
    assert result["exclusions"]["employeeDocuments"]["included"] is False


def test_restore_requires_explicit_confirmation(monkeypatch):
    async def fake_admin(request):
        return {"userId": "u", "role": "owner", "displayName": "A", "organizationId": "o"}

    monkeypatch.setattr(domains_router, "authorize_admin", fake_admin)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            domains_router.backup_restore(
                plain_request("/api/backups/x/restore"),
                "x",
                domains_router.RestorePayload(confirm="yes"),
            )
        )
    assert exc.value.status_code == 400


def test_force_restore_resurrects_payment_and_replaces_attendance(monkeypatch):
    async def scenario():
        url = await _prepare_database(monkeypatch)
        restored_payment = "phase5-restored-payment"
        removed_payment = "phase5-removed-payment"
        day = "2026-10-02"
        try:
            await _sql(
                url,
                "DELETE FROM public.smg_payments WHERE id = ANY(%s::text[])",
                ([restored_payment, removed_payment],),
            )
            await _sql(
                url,
                "DELETE FROM public.smg_attendance WHERE student_id LIKE 'phase5-restore-%%'",
            )
            await _sql(
                url,
                """
                INSERT INTO public.smg_payments
                  (id,student_id,period,amount,status,data,deleted_at,updated_at)
                VALUES
                  (%s,'s1','2026-09',100,'open',%s,now(),now()),
                  (%s,'s2','2026-10',200,'open',%s,NULL,now())
                """,
                (
                    restored_payment,
                    Jsonb(
                        {
                            "id": restored_payment,
                            "studentId": "s1",
                            "period": "2026-09",
                            "amount": 100,
                            "status": "open",
                        }
                    ),
                    removed_payment,
                    Jsonb(
                        {
                            "id": removed_payment,
                            "studentId": "s2",
                            "period": "2026-10",
                            "amount": 200,
                            "status": "open",
                        }
                    ),
                ),
            )
            await _sql(
                url,
                """
                INSERT INTO public.smg_attendance(attendance_date,student_id,record,updated_at)
                VALUES (%s::date,'phase5-restore-obsolete',%s,now())
                """,
                (
                    day,
                    Jsonb({"status": "present", "updatedAt": "2026-10-02T08:00:00Z"}),
                ),
            )

            await state.sync_critical_state(
                {
                    "state": {
                        "students": [],
                        "activityCatalog": [],
                        "extraEvents": [],
                        "extraParticipants": [],
                        "payments": [
                            {
                                "id": restored_payment,
                                "studentId": "s1",
                                "period": "2026-09",
                                "amount": 100,
                                "status": "open",
                            }
                        ],
                        "attendance": {
                            day: {
                                "phase5-restore-kept": {
                                    "status": "absent",
                                    "updatedAt": "2026-10-02T09:00:00Z",
                                }
                            }
                        },
                    },
                    "deleted": {"payments": [removed_payment]},
                    "forceRestore": True,
                    "clientId": "phase5-test",
                    "source": "phase5-test",
                }
            )

            payment_rows = await _sql(
                url,
                """
                SELECT id,deleted_at
                FROM public.smg_payments
                WHERE id = ANY(%s::text[])
                ORDER BY id
                """,
                ([restored_payment, removed_payment],),
                fetch=True,
            )
            by_id = {str(row[0]): row[1] for row in payment_rows}
            assert by_id[restored_payment] is None
            assert by_id[removed_payment] is not None

            attendance_rows = await _sql(
                url,
                """
                SELECT student_id,record
                FROM public.smg_attendance
                WHERE student_id LIKE 'phase5-restore-%%'
                ORDER BY student_id
                """,
                fetch=True,
            )
            assert [row[0] for row in attendance_rows] == ["phase5-restore-kept"]
            assert attendance_rows[0][1]["status"] == "absent"
        finally:
            await _sql(
                url,
                "DELETE FROM public.smg_payments WHERE id = ANY(%s::text[])",
                ([restored_payment, removed_payment],),
            )
            await _sql(
                url,
                "DELETE FROM public.smg_attendance WHERE student_id LIKE 'phase5-restore-%%'",
            )
            await db.close_pool()
            audit._schema_ready = False
            state._schema_ready = False
            domains._schema_ready = False

    asyncio.run(scenario())


def test_backup_post_and_employee_upload_limits_are_below_platform_ceiling():
    assert domains_router.MAX_BACKUP_BODY_BYTES == 3 * 1024 * 1024
    assert employees_router.MAX_FILE_BYTES == 3_000_000
    assert employees_router.MAX_DOCUMENT_BODY_BYTES == 4_250_000

    oversized = b"x" * (domains_router.MAX_BACKUP_BODY_BYTES + 1)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            domains_router.read_json_limited(
                plain_request("/api/backups", body=oversized)
            )
        )
    assert exc.value.status_code == 413


def test_employee_document_route_rejects_oversized_body(monkeypatch):
    async def authorized(request):
        return True

    monkeypatch.setattr(employees_router, "legacy_internal_authorized", authorized)
    oversized = b"x" * (employees_router.MAX_DOCUMENT_BODY_BYTES + 1)
    response = asyncio.run(
        employees_router.employee_documents_api(
            plain_request(
                "/api/employee-documents",
                method="POST",
                body=oversized,
            )
        )
    )
    payload = json.loads(response.body)
    assert response.status_code == 413
    assert "3 MB" in payload["error"]


def test_preregistration_encryption_proposal_uses_authenticated_hashes():
    path = os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        "docs",
        "preregistration-field-encryption.md",
    )
    source = open(path, encoding="utf-8").read()
    assert "AES-256-GCM" in source
    assert "HMAC-SHA-256" in source
    assert "guardianCpfHash" in source
    assert "não altera os dados existentes nesta fase" in source
