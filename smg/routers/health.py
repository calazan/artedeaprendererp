from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import APP_VERSION
from ..auth import TEACHER_ROLES, role_authorized
from ..config import environment_status, remote_sync_key, supabase_configured
from ..state import database_counts, ensure_core_schema

logger = logging.getLogger("smg.routers.health")
INTERNAL_ERROR_MESSAGE = "Erro interno do servidor."
router = APIRouter()


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
        "blob": {
            "connected": True,
            "provider": "supabase-postgres",
            "access": {"tested": False, "ok": True},
        },
    }


async def _health(*, detailed: bool = False):
    if not supabase_configured():
        return payload(
            {
                "ok": False,
                "configured": False,
                **({"environment": environment_status(), **compatibility_payload()} if detailed else {}),
                "error": "A integração Supabase ainda não disponibilizou uma URL PostgreSQL no ambiente Production.",
            },
            503,
        )
    try:
        await ensure_core_schema()
        counts = await database_counts()
        return payload(
            {
                "ok": True,
                "configured": True,
                "schemaReady": True,
                "provider": "supabase-postgres",
                **({"counts": counts, "environment": environment_status(), **compatibility_payload()} if detailed else {}),
            }
        )
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return payload(
            {
                "ok": False,
                "configured": supabase_configured(),
                "schemaReady": False,
                **({"environment": environment_status(), **compatibility_payload()} if detailed else {}),
                "error": INTERNAL_ERROR_MESSAGE,
            },
            500,
        )


@router.get("/api/health")
async def health():
    return await _health(detailed=False)


@router.get("/api/supabase-health")
async def supabase_health(request: Request):
    if not role_authorized(request, TEACHER_ROLES):
        return payload({"ok": False, "error": "Autenticação obrigatória."}, 401)
    return await _health(detailed=True)
