from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any

from fastapi import Request

from .auth import ADMIN_ROLES, role_authorized


def safe_equal(first: str = "", second: str = "") -> bool:
    a = hashlib.sha256(str(first).encode("utf-8")).digest()
    b = hashlib.sha256(str(second).encode("utf-8")).digest()
    return hmac.compare_digest(a, b)


def safe_equal_exact_length(first: str = "", second: str = "") -> bool:
    a = str(first).encode("utf-8")
    b = str(second).encode("utf-8")
    return bool(a) and len(a) == len(b) and hmac.compare_digest(a, b)


def bearer_secret_authorized(request: Request, env_name: str = "CRON_SECRET") -> bool:
    expected = str(os.getenv(env_name, "")).strip()
    authorization = str(request.headers.get("authorization") or "").strip()
    received = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    return (
        len(expected) >= 32
        and len(received) >= 32
        and safe_equal_exact_length(expected, received)
    )


async def sync_authorized(request: Request, body: dict | None = None) -> bool:
    # O ERP não aceita mais chaves de sincronização no cliente. A autorização
    # vem exclusivamente da sessão HttpOnly e do papel confirmado no Neon.
    return await role_authorized(request, ADMIN_ROLES)


def sanitize_incoming_state(value: Any) -> dict:
    incoming = dict(value) if isinstance(value, dict) else {}
    settings = dict(incoming.get("settings") or {}) if isinstance(incoming.get("settings"), dict) else {}
    for key in (
        "password",
        "passwordHash",
        "passwordEnabled",
        "passwordSecurityVersion",
        "remoteSync",
    ):
        settings.pop(key, None)
    incoming["settings"] = settings
    incoming.pop("syncKey", None)
    return incoming
