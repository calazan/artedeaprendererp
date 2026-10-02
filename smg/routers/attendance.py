from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import APP_VERSION
from ..auth import TEACHER_ROLES, role_authorized
from ..audit import record_audit
from ..config import database_configured, database_provider
from ..state import fetch_critical_state, save_attendance_records, teacher_public_state
from ..utils import iso_now

logger = logging.getLogger("smg.routers.attendance")
INTERNAL_ERROR_MESSAGE = "Erro interno do servidor."
router = APIRouter()
DEFAULT_ATTENDANCE_WINDOW_DAYS = 90


def attendance_since_for_request(request: Request) -> str:
    raw = str(request.query_params.get("attendanceSince") or "").strip()
    if raw:
        try:
            return datetime.strptime(raw, "%Y-%m-%d").date().isoformat()
        except Exception:
            pass
    return (datetime.now(timezone.utc).date() - timedelta(days=DEFAULT_ATTENDANCE_WINDOW_DAYS)).isoformat()


def response(data: dict, status: int = 200):
    return JSONResponse(
        {"version": APP_VERSION, **data},
        status_code=status,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-ArteERP-Version": APP_VERSION,
        },
    )


async def handler(request: Request):
    if not role_authorized(request, TEACHER_ROLES):
        return response({"ok": False, "error": "Autenticação obrigatória."}, 401)
    if not database_configured():
        return response({"ok": False, "error": "Neon ainda não configurado no ambiente Production."}, 503)
    try:
        attendance_since = attendance_since_for_request(request)
        if request.method == "POST":
            raw = await request.body()
            if len(raw) > 2 * 1024 * 1024:
                return response({"ok": False, "error": "Payload de chamada muito grande."}, 413)
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                body = {}
            day = str(body.get("date") or "").strip()
            records = body.get("records") if isinstance(body.get("records"), dict) else {}
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
                return response({"ok": False, "error": "Data da chamada inválida."}, 400)
            if not records:
                return response({"ok": False, "error": "Nenhuma alteração de chamada foi enviada."}, 400)
            critical = await fetch_critical_state(attendance_since=attendance_since)
            allowed_ids = {str(item.get("id") or "") for item in teacher_public_state(critical)["students"]}
            unknown_ids = sorted(str(value) for value in records if str(value) not in allowed_ids)
            if unknown_ids:
                return response({"ok": False, "error": "A chamada contém participantes não autorizados."}, 400)
            await save_attendance_records(day, records)
            await record_audit(
                request,
                "attendance",
                "upsert",
                entity_id=day,
                details={"records": len(records)},
            )
            critical = await fetch_critical_state(attendance_since=attendance_since)
        else:
            critical = await fetch_critical_state(attendance_since=attendance_since)

        data = teacher_public_state(critical)
        return response(
            {
                "ok": True,
                "exists": len(data["students"]) > 0,
                "provider": database_provider(),
                "updatedAt": data.get("updatedAt") or iso_now(),
                "attendanceSince": attendance_since,
                "data": data,
            }
        )
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)


@router.api_route("/api/teacher-attendance", methods=["GET", "POST"])
async def teacher_attendance(request: Request):
    return await handler(request)


@router.api_route("/api/teacher-attendance-supabase", methods=["GET", "POST"])
async def teacher_attendance_supabase(request: Request):
    return await handler(request)
