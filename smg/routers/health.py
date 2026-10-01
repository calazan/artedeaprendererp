from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import APP_VERSION
from ..auth import TEACHER_ROLES, role_authorized
from ..config import database_configured, database_provider, environment_status
from ..db import connection

logger = logging.getLogger("smg.routers.health")
INTERNAL_ERROR_MESSAGE = "Erro interno do servidor."
router = APIRouter()


def payload(extra: dict, status: int = 200):
    return JSONResponse(
        {"version": APP_VERSION, **extra},
        status_code=status,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-ArteERP-Version": APP_VERSION,
        },
    )


async def database_ping() -> bool:
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT 1")
            row = await cur.fetchone()
    return bool(row and int(row[0]) == 1)


async def detailed_database_status() -> dict:
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  to_regclass('public.smg_students') IS NOT NULL,
                  to_regclass('public.smg_meta') IS NOT NULL,
                  to_regclass('public.app_users') IS NOT NULL,
                  to_regclass('public.organization_members') IS NOT NULL,
                  to_regclass('public.smg_manual_backups') IS NOT NULL
                """
            )
            schema = await cur.fetchone()
            core_ready = bool(schema and schema[0] and schema[1])
            auth_ready = bool(schema and schema[2] and schema[3])
            backup_ready = bool(schema and schema[4])

            counts = {}
            if core_ready:
                await cur.execute(
                    """
                    SELECT
                      (SELECT count(*)::int FROM public.smg_students),
                      (SELECT count(*)::int FROM public.smg_payments WHERE deleted_at IS NULL),
                      (SELECT count(*)::int FROM public.smg_attendance)
                    """
                )
                row = await cur.fetchone()
                counts = {
                    "students": int(row[0] or 0),
                    "payments": int(row[1] or 0),
                    "attendance": int(row[2] or 0),
                }
    return {
        "schemaReady": core_ready,
        "authSchemaReady": auth_ready,
        "backupSchemaReady": backup_ready,
        "counts": counts,
    }


@router.get("/api/health")
async def health():
    if not database_configured():
        return payload({"ok": False}, 503)
    try:
        return payload({"ok": await database_ping()})
    except Exception:
        logger.warning("Health check do banco falhou.", exc_info=True)
        return payload({"ok": False}, 503)


@router.get("/api/database-health")
@router.get("/api/neon-health")
async def database_health(request: Request):
    if not await role_authorized(request, TEACHER_ROLES):
        return payload({"ok": False, "error": "Autenticação obrigatória."}, 401)
    if not database_configured():
        return payload({"ok": False, "configured": False}, 503)
    try:
        if not await database_ping():
            return payload({"ok": False, "configured": True}, 503)
        detailed = await detailed_database_status()
        return payload(
            {
                "ok": True,
                "configured": True,
                "provider": database_provider(),
                "environment": environment_status(),
                **detailed,
            }
        )
    except Exception:
        logger.exception("Erro no diagnóstico autenticado do banco.")
        return payload({"ok": False, "configured": True, "error": INTERNAL_ERROR_MESSAGE}, 500)
