from __future__ import annotations

import asyncio

import pytest
from starlette.requests import Request

from smg.auth import (
    MembershipLookupError,
    SessionConfigurationError,
    _active_membership,
    create_session,
    get_client_ip,
    role_authorized,
    session_from_request,
)
from smg.config import (
    DEFAULT_PUBLISHABLE_KEY,
    DEFAULT_SUPABASE_URL,
    database_project_ref,
    publishable_key,
    supabase_url,
)
from smg.preregistration import consume_rate_limit
from smg.routers.sync import supplemental_snapshot_issue


DB_ENV_NAMES = (
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL",
    "POSTGRES_URL_NON_POOLING",
    "SUPABASE_DB_URL",
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
    assert role_authorized(request)
    assert session_from_request(request_with_cookie(token + "tampered")) is None


def test_weak_dedicated_session_secret_is_rejected(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "too-short")
    monkeypatch.setenv("REMOTE_SYNC_KEY", "x" * 64)
    monkeypatch.setenv("POSTGRES_URL", "postgresql://user:strong-db-secret@db.example/postgres")
    with pytest.raises(SessionConfigurationError):
        create_session("00000000-0000-0000-0000-000000000001", "owner")


def test_predictable_session_fallback_is_not_allowed(monkeypatch):
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    monkeypatch.delenv("REMOTE_SYNC_KEY", raising=False)
    clear_database_env(monkeypatch)
    with pytest.raises(SessionConfigurationError):
        create_session("00000000-0000-0000-0000-000000000001", "owner")


def test_server_side_compat_session_key_is_accepted_during_migration(monkeypatch):
    monkeypatch.delenv("SESSION_SECRET", raising=False)
    monkeypatch.setenv("REMOTE_SYNC_KEY", "x" * 64)
    monkeypatch.setenv("POSTGRES_URL", "postgresql://user:strong-db-secret@db.example/postgres")
    token = create_session("00000000-0000-0000-0000-000000000001", "owner")
    assert session_from_request(request_with_cookie(token))["role"] == "owner"


def test_cross_origin_mutation_is_rejected(monkeypatch):
    monkeypatch.setenv("SESSION_SECRET", "s" * 64)
    token = create_session("00000000-0000-0000-0000-000000000001", "owner")
    request = request_with_cookie(token, method="POST", origin="https://evil.example")
    assert not role_authorized(request)


def test_arbitrary_x_forwarded_for_does_not_override_socket_ip():
    request = request_with_cookie(
        "",
        extra_headers=[(b"x-forwarded-for", b"203.0.113.99")],
    )
    assert get_client_ip(request) == "127.0.0.1"


def test_membership_lookup_fails_closed_without_database(monkeypatch):
    clear_database_env(monkeypatch)
    with pytest.raises(MembershipLookupError):
        asyncio.run(_active_membership("00000000-0000-0000-0000-000000000001"))


def test_rate_limit_can_fail_closed_for_security_sensitive_flows(monkeypatch):
    clear_database_env(monkeypatch)
    assert asyncio.run(consume_rate_limit("login", fail_open=False)) is False
    assert asyncio.run(consume_rate_limit("public-default")) is True


def test_invalid_or_foreign_supabase_auth_target_falls_back_to_audited_host(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://evil.example")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "attacker-controlled-key")
    assert supabase_url() == DEFAULT_SUPABASE_URL
    assert publishable_key() == DEFAULT_PUBLISHABLE_KEY

    monkeypatch.setenv("SUPABASE_URL", "javascript:alert(1)")
    assert supabase_url() == DEFAULT_SUPABASE_URL
    assert publishable_key() == DEFAULT_PUBLISHABLE_KEY


def test_audited_supabase_auth_target_accepts_configured_publishable_key(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", DEFAULT_SUPABASE_URL)
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "configured-publishable-key")
    assert supabase_url() == DEFAULT_SUPABASE_URL
    assert publishable_key() == "configured-publishable-key"


def test_supabase_project_ref_is_extracted_from_pooler_username():
    url = "postgresql://postgres.your-project-ref:secret@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"
    assert database_project_ref(url) == "your-project-ref"


def test_incomplete_financial_snapshot_is_blocked():
    current = {"bankAccounts": [{"id": "1"}], "bankMovements": [{"id": "2"}], "expenses": [{"id": "3"}]}
    issue = supplemental_snapshot_issue(current, {"bankAccounts": [], "bankMovements": [], "expenses": []})
    assert issue and issue["reason"] == "mass-finance-empty"


def test_missing_populated_domain_is_blocked():
    issue = supplemental_snapshot_issue({"settings": {"currency": "BRL"}}, {})
    assert issue and issue["reason"] == "missing-domains"
