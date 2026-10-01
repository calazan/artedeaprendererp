from __future__ import annotations

import asyncio

import pytest
from starlette.requests import Request

import smg.auth as auth
from smg.auth import (
    MembershipLookupError,
    SessionConfigurationError,
    _active_membership,
    create_session,
    get_client_ip,
    require_role,
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


def install_membership(monkeypatch, *, role="owner", session_version=1):
    async def fake_membership(user_id: str):
        return {
            "role": role,
            "displayName": "Usuário",
            "organizationId": "00000000-0000-0000-0000-000000000099",
            "sessionVersion": session_version,
        }

    monkeypatch.setattr(auth, "database_configured", lambda: True)
    monkeypatch.setattr(auth, "get_active_membership", fake_membership)
    auth.clear_membership_cache()


def test_signed_session_accepts_valid_and_rejects_tampering(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "s" * 64)
    install_membership(monkeypatch)
    token = create_session("00000000-0000-0000-0000-000000000001", "owner", "Admin", 1)
    request = request_with_cookie(token)
    assert asyncio.run(session_from_request(request))["role"] == "owner"
    assert asyncio.run(role_authorized(request))
    assert asyncio.run(session_from_request(request_with_cookie(token + "tampered"))) is None


def test_session_role_comes_from_database_not_token(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "s" * 64)
    install_membership(monkeypatch, role="manager")
    token = create_session("00000000-0000-0000-0000-000000000001", "owner", "Admin", 1)
    request = request_with_cookie(token)
    session = asyncio.run(session_from_request(request))
    assert session["role"] == "manager"
    assert asyncio.run(require_role(request, frozenset({"owner", "admin"}))) is None


def test_session_version_revokes_old_cookie(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "s" * 64)
    install_membership(monkeypatch, session_version=2)
    token = create_session("00000000-0000-0000-0000-000000000001", "owner", "Admin", 1)
    assert asyncio.run(session_from_request(request_with_cookie(token))) is None


def test_weak_dedicated_session_secret_is_rejected(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "too-short")
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require")
    with pytest.raises(SessionConfigurationError):
        create_session("00000000-0000-0000-0000-000000000001", "owner")


def test_session_secret_is_mandatory_even_when_database_exists(monkeypatch):
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    monkeypatch.setenv("REMOTE_SYNC_KEY", "x" * 64)
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:secret@ep-example.neon.tech/neondb?sslmode=require")
    with pytest.raises(SessionConfigurationError):
        create_session("00000000-0000-0000-0000-000000000001", "owner")


def test_cross_origin_mutation_is_rejected(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "s" * 64)
    install_membership(monkeypatch)
    token = create_session("00000000-0000-0000-0000-000000000001", "owner", session_version=1)
    request = request_with_cookie(token, method="POST", origin="https://evil.example")
    assert not asyncio.run(role_authorized(request))


def test_vercel_forwarded_ip_headers_are_supported_without_cloudflare_header():
    request = request_with_cookie(
        "",
        extra_headers=[
            (b"x-real-ip", b"203.0.113.8"),
            (b"x-forwarded-for", b"203.0.113.9, 10.0.0.1"),
            (b"cf-connecting-ip", b"198.51.100.50"),
        ],
    )
    assert get_client_ip(request) == "203.0.113.8"
    forwarded_only = request_with_cookie("", extra_headers=[(b"x-forwarded-for", b"203.0.113.9, 10.0.0.1")])
    assert get_client_ip(forwarded_only) == "203.0.113.9"


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
