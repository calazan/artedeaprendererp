from __future__ import annotations

import asyncio

import pytest
from starlette.requests import Request

import smg.auth as auth_module
from smg.auth import (
    MembershipLookupError,
    SessionConfigurationError,
    _active_membership,
    create_session,
    get_client_ip,
    role_authorized,
    session_from_request,
)
from smg.config import database_configured, database_provider, database_url
from smg.preregistration import consume_rate_limit
from smg.routers.sync import supplemental_snapshot_issue


DB_ENV_NAMES = (
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
)


def request_with_cookie(
    token: str,
    *,
    method: str = "GET",
    origin: str = "",
    extra_headers: list[tuple[bytes, bytes]] | None = None,
) -> Request:
    headers = [(b"cookie", f"smg_session={token}".encode())]
    if origin:
        headers.append((b"origin", origin.encode()))
    headers.extend(extra_headers or [])
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": "https",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "headers": headers,
            "server": ("erp.example", 443),
            "client": ("127.0.0.1", 1234),
        }
    )


def clear_database_env(monkeypatch):
    for name in DB_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


def test_signed_session_accepts_valid_and_rejects_tampering(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "s" * 64)
    token = create_session("00000000-0000-0000-0000-000000000001", "owner", "Admin")
    request = request_with_cookie(token)
    assert session_from_request(request)["role"] == "owner"

    async def membership(user_id):
        return {
            "role": "owner",
            "displayName": "Admin",
            "organizationId": "00000000-0000-0000-0000-000000000010",
        }

    monkeypatch.setattr(auth_module, "_cached_active_membership", membership)
    assert asyncio.run(role_authorized(request))
    assert session_from_request(request_with_cookie(token + "tampered")) is None


def test_weak_dedicated_session_secret_is_rejected(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "too-short")
    monkeypatch.setenv("REMOTE_SYNC_KEY", "x" * 64)
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:strong-db-secret@ep-example.neon.tech/neondb?sslmode=require")
    with pytest.raises(SessionConfigurationError):
        create_session("00000000-0000-0000-0000-000000000001", "owner")


def test_predictable_session_fallback_is_not_allowed(monkeypatch):
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    monkeypatch.delenv("REMOTE_SYNC_KEY", raising=False)
    clear_database_env(monkeypatch)
    with pytest.raises(SessionConfigurationError):
        create_session("00000000-0000-0000-0000-000000000001", "owner")


def test_neon_database_secret_can_sign_session_when_dedicated_secret_is_absent(monkeypatch):
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    monkeypatch.delenv("REMOTE_SYNC_KEY", raising=False)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://user:strong-db-secret@ep-example.neon.tech/neondb?sslmode=require",
    )
    token = create_session("00000000-0000-0000-0000-000000000001", "owner")
    assert session_from_request(request_with_cookie(token))["role"] == "owner"


def test_legacy_internal_secret_can_strengthen_neon_session_derivation(monkeypatch):
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    monkeypatch.setenv("REMOTE_SYNC_KEY", "x" * 64)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://user:strong-db-secret@ep-example.neon.tech/neondb?sslmode=require",
    )
    token = create_session("00000000-0000-0000-0000-000000000001", "owner")
    assert session_from_request(request_with_cookie(token))["role"] == "owner"


def test_cross_origin_mutation_is_rejected(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "s" * 64)
    token = create_session("00000000-0000-0000-0000-000000000001", "owner")
    request = request_with_cookie(token, method="POST", origin="https://evil.example")
    assert not asyncio.run(role_authorized(request))


def test_arbitrary_x_forwarded_for_does_not_override_socket_ip():
    request = request_with_cookie("", extra_headers=[(b"x-forwarded-for", b"203.0.113.99")])
    assert get_client_ip(request) == "127.0.0.1"


def test_membership_lookup_fails_closed_without_database(monkeypatch):
    clear_database_env(monkeypatch)
    with pytest.raises(MembershipLookupError):
        asyncio.run(_active_membership("00000000-0000-0000-0000-000000000001"))


def test_rate_limit_can_fail_closed_for_security_sensitive_flows(monkeypatch):
    clear_database_env(monkeypatch)
    assert asyncio.run(consume_rate_limit("login", fail_open=False)) is False
    assert asyncio.run(consume_rate_limit("public-default")) is True


def test_neon_database_url_is_primary_and_keeps_tls(monkeypatch):
    clear_database_env(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgres://owner:secret@ep-example-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    )
    value = database_url()
    assert value.startswith("postgresql://")
    assert "sslmode=require" in value
    assert "channel_binding=require" in value
    assert database_configured()
    assert database_provider() == "neon-postgres"


def test_incomplete_financial_snapshot_is_blocked():
    current = {"bankAccounts": [{"id": "1"}], "bankMovements": [{"id": "2"}], "expenses": [{"id": "3"}]}
    issue = supplemental_snapshot_issue(current, {"bankAccounts": [], "bankMovements": [], "expenses": []})
    assert issue and issue["reason"] == "mass-finance-empty"


def test_missing_populated_domain_is_blocked():
    issue = supplemental_snapshot_issue({"settings": {"currency": "BRL"}}, {})
    assert issue and issue["reason"] == "missing-domains"
