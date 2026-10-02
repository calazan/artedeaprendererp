from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any

from fastapi import Request

from .auth import ADMIN_ROLES, role_authorized
from .config import remote_sync_key


def safe_equal(first: str = "", second: str = "") -> bool:
    a = hashlib.sha256(str(first).encode("utf-8")).digest()
    b = hashlib.sha256(str(second).encode("utf-8")).digest()
    return hmac.compare_digest(a, b)


def safe_equal_exact_length(first: str = "", second: str = "") -> bool:
    a = str(first).encode("utf-8")
    b = str(second).encode("utf-8")
    return bool(a) and len(a) == len(b) and hmac.compare_digest(a, b)


def request_sync_key(request: Request, body: dict | None = None) -> str:
    # Segredos nunca são aceitos em URL ou corpo, pois esses campos podem parar
    # em históricos, telemetria e logs.
    return str(request.headers.get("x-sync-key") or "").strip()


def _legacy_sync_enabled() -> bool:
    return str(os.getenv("ALLOW_LEGACY_SYNC_KEY", "")).strip().lower() in {"1", "true", "yes"}


async def sync_authorized(request: Request, body: dict | None = None) -> bool:
    if await role_authorized(request, ADMIN_ROLES):
        return True
    if not _legacy_sync_enabled():
        return False
    expected = remote_sync_key()
    received = request_sync_key(request, body)
    return len(expected) >= 32 and len(received) >= 32 and safe_equal_exact_length(expected, received)


async def legacy_internal_authorized(request: Request) -> bool:
    # Nome mantido apenas para compatibilidade de import; a regra agora é a
    # mesma sessão autenticada dos demais módulos administrativos.
    return await sync_authorized(request)


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
