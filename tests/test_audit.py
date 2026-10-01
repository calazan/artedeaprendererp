from __future__ import annotations

import asyncio

from starlette.requests import Request

import smg.audit as audit


class FakeCursor:
    def __init__(self):
        self.calls = []

    async def execute(self, sql, params=None):
        self.calls.append((sql, params))


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


def request() -> Request:
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "https",
            "path": "/api/test",
            "raw_path": b"/api/test",
            "query_string": b"",
            "headers": [
                (b"user-agent", b"Audit Browser/1.0"),
                (b"x-real-ip", b"203.0.113.44"),
            ],
            "server": ("erp.example", 443),
            "client": ("127.0.0.1", 1234),
        }
    )


def test_record_audit_adds_ip_user_agent_and_filters_secrets(monkeypatch):
    cursor = FakeCursor()

    async def fake_session(_request):
        return {"sub": "user-1"}

    monkeypatch.setattr(audit, "_schema_ready", True)
    monkeypatch.setattr(audit, "session_from_request", fake_session)
    monkeypatch.setattr(
        audit,
        "connection",
        lambda: ConnectionContext(FakeConnection(cursor)),
    )

    asyncio.run(
        audit.record_audit(
            request(),
            "test",
            "write",
            details={
                "status": "ok",
                "password": "never-log",
                "authorization": "never-log",
            },
        )
    )

    _, params = cursor.calls[-1]
    details = params[4].obj
    assert details["status"] == "ok"
    assert details["ip"] == "203.0.113.44"
    assert details["userAgent"] == "Audit Browser/1.0"
    assert "password" not in details
    assert "authorization" not in details
