from __future__ import annotations

import logging
from time import monotonic

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import APP_VERSION
from ..auth import (
    TEACHER_ROLES,
    role_authorized,
    session_configuration_error,
)
from ..auth_store import ensure_auth_schema
from ..config import (
    database_configured,
    database_provider,
    environment_status,
    production_environment,
    remote_sync_key,
)
from ..state import database_counts, ensure_core_schema

logger = logging.getLogger("smg.routers.health")
INTERNAL_ERROR_MESSAGE = "Erro interno do servidor."
router = APIRouter()
PUBLIC_HEALTH_CACHE_SECONDS = 15.0
_public_health_cache: dict | None = None


def payload(extra: dict, status: int = 200):
    data = {"version": APP_VERSION, **extra}
    return JSONResponse(
        data,
        status_code=status,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-ArteERP-Version": APP_VERSION,
        },
    )


def compatibility_payload() -> dict:
    return {
        "remoteSyncKeyConfigured": bool(remote_sync_key()),
        "storage": {
            "connected": database_configured(),
            "provider": database_provider(),
            "access": {"tested": False, "ok": database_configured()},
        },
    }


async def _health(*, detailed: bool = False):
    global _public_health_cache

    if not detailed and _public_health_cache:
        if monotonic() < float(_public_health_cache.get("expiresAt") or 0):
            return payload(
                dict(_public_health_cache.get("data") or {}),
                int(_public_health_cache.get("status") or 200),
            )
        _public_health_cache = None

    session_error = session_configuration_error() if production_environment() else ""
    if session_error:
        data = {
            "ok": False,
            "configured": database_configured(),
            "schemaReady": False,
            "authSchemaReady": False,
            **({"environment": environment_status(), **compatibility_payload()} if detailed else {}),
            "error": session_error,
        }
        if not detailed:
            _public_health_cache = {
                "expiresAt": monotonic() + PUBLIC_HEALTH_CACHE_SECONDS,
                "data": data,
                "status": 503,
            }
        return payload(data, 503)

    if not database_configured():
        data = {
            "ok": False,
            "configured": False,
            **({"environment": environment_status(), **compatibility_payload()} if detailed else {}),
            "error": "DATABASE_URL do Neon/PostgreSQL ainda não está disponível no ambiente Production.",
        }
        if not detailed:
            _public_health_cache = {
                "expiresAt": monotonic() + PUBLIC_HEALTH_CACHE_SECONDS,
                "data": data,
                "status": 503,
            }
        return payload(data, 503)

    try:
        await ensure_core_schema()
        await ensure_auth_schema()
        counts = await database_counts() if detailed else None
        data = {
            "ok": True,
            "configured": True,
            "schemaReady": True,
            "authSchemaReady": True,
            "provider": database_provider(),
            **(
                {
                    "counts": counts,
                    "environment": environment_status(),
                    **compatibility_payload(),
                }
                if detailed
                else {}
            ),
        }
        if not detailed:
            _public_health_cache = {
                "expiresAt": monotonic() + PUBLIC_HEALTH_CACHE_SECONDS,
                "data": data,
                "status": 200,
            }
        return payload(data)
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        data = {
            "ok": False,
            "configured": database_configured(),
            "schemaReady": False,
            **({"environment": environment_status(), **compatibility_payload()} if detailed else {}),
            "error": INTERNAL_ERROR_MESSAGE,
        }
        if not detailed:
            _public_health_cache = {
                "expiresAt": monotonic() + PUBLIC_HEALTH_CACHE_SECONDS,
                "data": data,
                "status": 500,
            }
        return payload(data, 500)


@router.get("/api/health")
async def health():
    return await _health(detailed=False)


@router.get("/api/database-health")
@router.get("/api/neon-health")
@router.get("/api/supabase-health")
async def database_health(request: Request):
    if not await role_authorized(request, TEACHER_ROLES):
        return payload({"ok": False, "error": "Autenticação obrigatória."}, 401)
    return await _health(detailed=True)
