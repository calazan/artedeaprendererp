from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..db import connection
from ..security import safe_equal_exact_length
from .whatsapp import dispatch_reminders

logger = logging.getLogger("smg.routers.internal_cron")
INTERNAL_ERROR_MESSAGE = "Erro interno do servidor."
router = APIRouter(prefix="/api/internal")


def response(payload: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(
        payload,
        status_code=status,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


async def stored_token(meta_key: str) -> str:
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT value->>'token' FROM public.smg_meta WHERE key=%s LIMIT 1",
                (meta_key,),
            )
            row = await cur.fetchone()
    return str(row[0] if row else "").strip()


async def header_authorized(request: Request, header: str, meta_key: str) -> bool:
    received = str(request.headers.get(header) or "").strip()
    if len(received) < 32:
        return False
    expected = await stored_token(meta_key)
    return len(expected) >= 32 and safe_equal_exact_length(expected, received)


@router.post("/whatsapp-dispatch")
async def whatsapp_dispatch(request: Request):
    if not await header_authorized(request, "x-whatsapp-cron-token", "dart_whatsapp_cron"):
        return response({"ok": False, "error": "Disparador não autorizado."}, 401)
    try:
        return response(await dispatch_reminders())
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response(
            {"ok": False, "error": INTERNAL_ERROR_MESSAGE},
            500,
        )
