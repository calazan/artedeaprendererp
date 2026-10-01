from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..security import bearer_secret_authorized
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


@router.post("/whatsapp-dispatch")
async def whatsapp_dispatch(request: Request):
    if not bearer_secret_authorized(request):
        return response({"ok": False, "error": "Disparador não autorizado."}, 401)
    try:
        return response(await dispatch_reminders())
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)
