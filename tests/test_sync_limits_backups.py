from __future__ import annotations

import asyncio
import json

from starlette.requests import Request

import smg.routers.domains as domains_router
import smg.routers.sync as sync_router
from smg.routers.employees import MAX_FILE_BYTES
from smg.state import StateValidationError, SyncConflictError


def request_with_body(body: bytes, path: str = "/api/database-sync", method: str = "POST") -> Request:
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
            "headers": [(b"content-type", b"application/json")],
            "server": ("erp.example", 443),
            "client": ("127.0.0.1", 1234),
        },
        receive,
    )


def test_sync_body_over_safe_function_limit_returns_413(monkeypatch):
    monkeypatch.setattr(sync_router, "database_configured", lambda: True)
    request = request_with_body(b"x" * (sync_router.MAX_FUNCTION_BODY_BYTES + 1))
    response = asyncio.run(sync_router.direct_database_sync(request))
    assert response.status_code == 413
    assert b"PAYLOAD_TOO_LARGE" in response.body


def test_sync_response_over_safe_function_limit_returns_413():
    response = sync_router.response({"ok": True, "data": "x" * (sync_router.MAX_FUNCTION_BODY_BYTES + 10)})
    assert response.status_code == 413


def test_atomic_conflict_is_exposed_as_409(monkeypatch):
    async def allowed(*args, **kwargs):
        return True

    async def revision():
        return 7

    async def current():
        return {}

    async def conflict(payload):
        raise SyncConflictError("REMOTE_CONFLICT")

    monkeypatch.setattr(sync_router, "database_configured", lambda: True)
    monkeypatch.setattr(sync_router, "sync_authorized", allowed)
    monkeypatch.setattr(sync_router, "get_sync_revision", revision)
    monkeypatch.setattr(sync_router, "fetch_critical_state", current)
    monkeypatch.setattr(sync_router, "sync_critical_state", conflict)

    body = json.dumps({"state": {"students": []}, "baseRevision": 7}).encode()
    response = asyncio.run(sync_router.direct_database_sync(request_with_body(body)))
    assert response.status_code == 409
    assert b"REMOTE_CONFLICT" in response.body


def test_invalid_state_value_returns_400(monkeypatch):
    async def allowed(*args, **kwargs):
        return True

    async def revision():
        return 2

    async def current():
        return {}

    async def invalid(payload):
        raise StateValidationError("Valor numérico inválido em payments.amount.")

    monkeypatch.setattr(sync_router, "database_configured", lambda: True)
    monkeypatch.setattr(sync_router, "sync_authorized", allowed)
    monkeypatch.setattr(sync_router, "get_sync_revision", revision)
    monkeypatch.setattr(sync_router, "fetch_critical_state", current)
    monkeypatch.setattr(sync_router, "sync_critical_state", invalid)

    body = json.dumps({"state": {"payments": [{"id": "p1", "amount": "abc"}]}, "baseRevision": 2}).encode()
    response = asyncio.run(sync_router.direct_database_sync(request_with_body(body)))
    assert response.status_code == 400
    assert b"payments.amount" in response.body


def test_employee_base64_limit_leaves_margin_below_vercel_limit():
    assert MAX_FILE_BYTES <= 2_750_000
    encoded_upper_bound = ((MAX_FILE_BYTES + 2) // 3) * 4
    assert encoded_upper_bound < 4 * 1024 * 1024


def test_backup_restore_requires_confirmation_and_uses_replace_all(monkeypatch):
    captured = {}

    async def admin(request):
        return {"sub": "user-1", "role": "owner"}

    async def backup(_id):
        return {"id": _id, "snapshot": {"students": [{"id": "s1"}]}}

    async def current():
        return {"students": [{"id": "s2"}]}

    async def revision():
        return 11

    async def sync(payload):
        captured.update(payload)
        return {"revision": 12, "updatedAt": "2026-10-01T12:00:00Z"}

    async def audit(*args, **kwargs):
        captured["audited"] = True

    monkeypatch.setattr(domains_router, "authorize_backup_admin", admin)
    monkeypatch.setattr(domains_router, "get_backup", backup)
    monkeypatch.setattr(domains_router, "fetch_critical_state", current)
    monkeypatch.setattr(domains_router, "get_sync_revision", revision)
    monkeypatch.setattr(domains_router, "sync_critical_state", sync)
    monkeypatch.setattr(domains_router, "record_audit", audit)

    request = request_with_body(json.dumps({"confirm": "RESTAURAR"}).encode(), "/api/backups/abc/restore")
    response = asyncio.run(domains_router.backup_restore(request, "abc"))
    assert response["ok"] is True
    assert captured["replaceAll"] is True
    assert captured["destructive"] is True
    assert captured["backupReason"] == "pre-restore"
    assert captured["audited"] is True


def test_manual_backup_uses_server_snapshot_and_ignores_client_snapshot(monkeypatch):
    captured = {}

    async def admin(request):
        return {"sub": "owner-1", "role": "owner"}

    async def current():
        return {"students": [{"id": "server-student"}]}

    async def create(snapshot, reason, created_by):
        captured.update({"snapshot": snapshot, "reason": reason, "createdBy": created_by})
        return {"id": "backup-1", "checksum": "abc", "createdAt": "2026-10-02T10:00:00Z"}

    monkeypatch.setattr(domains_router, "authorize_backup_admin", admin)
    monkeypatch.setattr(domains_router, "fetch_critical_state", current)
    monkeypatch.setattr(domains_router, "create_backup", create)

    request = request_with_body(
        json.dumps({"reason": "manual", "snapshot": {"students": [{"id": "client-data"}]}}).encode(),
        "/api/backups",
    )
    response = asyncio.run(domains_router.backup_create(request))
    assert response["ok"] is True
    assert captured["snapshot"] == {"students": [{"id": "server-student"}]}
    assert captured["createdBy"] == "owner-1"


def test_backup_detail_never_exposes_snapshot(monkeypatch):
    async def admin(request):
        return {"sub": "owner-1", "role": "owner"}

    async def get(_id):
        return {
            "id": _id,
            "snapshot": {"students": [{"id": "sensitive"}]},
            "checksum": "abc",
            "reason": "manual",
            "createdBy": "owner-1",
            "createdAt": "2026-10-02T10:00:00Z",
        }

    monkeypatch.setattr(domains_router, "authorize_backup_admin", admin)
    monkeypatch.setattr(domains_router, "get_backup", get)
    request = request_with_body(b"", "/api/backups/backup-1", method="GET")
    response = asyncio.run(domains_router.backup(request, "backup-1"))
    assert response["ok"] is True
    assert "snapshot" not in response
    assert response["id"] == "backup-1"
