from __future__ import annotations

import asyncio
import os

from starlette.requests import Request

import smg.routers.health as health_router
from smg.security import bearer_secret_authorized


class FakeCursor:
    def __init__(self, rows):
        self.rows = list(rows)
        self.executed = []

    async def execute(self, sql, params=None):
        self.executed.append((sql.strip(), params))

    async def fetchone(self):
        return self.rows.pop(0) if self.rows else None


class CursorContext:
    def __init__(self, cursor):
        self.cursor = cursor

    async def __aenter__(self):
        return self.cursor

    async def __aexit__(self, exc_type, exc, tb):
        return False


class FakeConnection:
    def __init__(self, cursor):
        self.cursor_obj = cursor

    def cursor(self):
        return CursorContext(self.cursor_obj)


class ConnectionContext:
    def __init__(self, connection):
        self.connection_obj = connection

    async def __aenter__(self):
        return self.connection_obj

    async def __aexit__(self, exc_type, exc, tb):
        return False


def request(headers=None) -> Request:
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": "/api/health",
            "raw_path": b"/api/health",
            "query_string": b"",
            "headers": headers or [],
            "server": ("erp.example", 443),
            "client": ("127.0.0.1", 1234),
        }
    )


def test_public_health_only_executes_select_one(monkeypatch):
    cursor = FakeCursor([(1,)])
    monkeypatch.setattr(health_router, "database_configured", lambda: True)
    monkeypatch.setattr(
        health_router,
        "connection",
        lambda: ConnectionContext(FakeConnection(cursor)),
    )
    response = asyncio.run(health_router.health())
    assert response.status_code == 200
    assert cursor.executed == [("SELECT 1", None)]


def test_cron_secret_requires_bearer_header(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "c" * 64)
    good = request([(b"authorization", b"Bearer " + b"c" * 64)])
    bad = request([(b"x-whatsapp-cron-token", b"c" * 64)])
    assert bearer_secret_authorized(good)
    assert not bearer_secret_authorized(bad)


def test_legacy_sync_key_and_supabase_routes_are_removed():
    root = os.path.dirname(os.path.dirname(__file__))
    security = open(os.path.join(root, "smg", "security.py"), encoding="utf-8").read()
    env = open(os.path.join(root, ".env.example"), encoding="utf-8").read()
    health = open(os.path.join(root, "smg", "routers", "health.py"), encoding="utf-8").read()
    sync = open(os.path.join(root, "smg", "routers", "sync.py"), encoding="utf-8").read()
    attendance = open(os.path.join(root, "smg", "routers", "attendance.py"), encoding="utf-8").read()
    teacher = open(os.path.join(root, "frontend", "teacher-bundle.min.js"), encoding="utf-8").read()
    assert "ALLOW_LEGACY_SYNC_KEY" not in env
    assert "REMOTE_SYNC_KEY" not in env
    assert "x-sync-key" not in security
    assert "/api/supabase-health" not in health
    assert "/api/supabase-sync" not in sync
    assert "/api/teacher-attendance-supabase" not in attendance
    assert "/api/supabase-" not in teacher


def test_runtime_frontend_no_longer_depends_on_legacy_sync_key():
    root = os.path.dirname(os.path.dirname(__file__))
    files = (
        "frontend/pre-registration-admin.js",
        "frontend/pre-registration-recovery-fix.js",
        "frontend/supabase-admin-sync.js",
        "frontend/tasks-routine.js",
        "frontend/tasks-shopping-adjustments.js",
        "frontend/whatsapp-reminders.js",
        "frontend/app.min.js",
    )
    for relative in files:
        source = open(os.path.join(root, relative), encoding="utf-8").read()
        assert "x-sync-key" not in source, relative
        assert "REMOTE_SYNC_KEY" not in source, relative
        assert "chave de sincronização" not in source.lower(), relative

    prereg = open(os.path.join(root, "frontend", "pre-registration-admin.js"), encoding="utf-8").read()
    tasks = open(os.path.join(root, "frontend", "tasks-routine.js"), encoding="utf-8").read()
    whatsapp = open(os.path.join(root, "frontend", "whatsapp-reminders.js"), encoding="utf-8").read()
    assert 'credentials: "same-origin"' in prereg
    assert 'credentials: "same-origin"' in tasks
    assert 'credentials: "same-origin"' in whatsapp


def test_unused_supabase_seed_is_not_precached():
    root = os.path.dirname(os.path.dirname(__file__))
    worker = open(os.path.join(root, "frontend", "sw.js"), encoding="utf-8").read()
    assert "supabase-full-state-seed-fix.js" not in worker


def test_whatsapp_cron_has_single_internal_entrypoint():
    root = os.path.dirname(os.path.dirname(__file__))
    whatsapp = open(os.path.join(root, "smg", "routers", "whatsapp.py"), encoding="utf-8").read()
    internal = open(os.path.join(root, "smg", "routers", "internal_cron.py"), encoding="utf-8").read()
    assert "cron_authorized" not in whatsapp
    assert 'action == "dispatch" and request.method == "GET"' not in whatsapp
    assert '@router.post("/whatsapp-dispatch")' in internal
    assert "bearer_secret_authorized(request)" in internal
