from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from time import monotonic
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from ..config import whatsapp_provider_config
from ..security import safe_equal, sync_authorized
from ..utils import as_dict, iso_now
from ..whatsapp import (
    claim_message,
    days_until,
    due_date_for_payment,
    finish_message,
    format_brl,
    format_date_br,
    get_config,
    iso_date_in_timezone,
    list_history,
    list_open_payment_rows,
    list_recipients,
    normalize_brazil_phone,
    opt_out_students_by_phone,
    outstanding_amount,
    provider_status,
    reminder_key,
    save_config,
    save_recipients,
    send_template_message,
    timing_label,
    update_delivery_status,
    webhook_signature_valid,
)

logger = logging.getLogger("smg.routers.whatsapp")
INTERNAL_ERROR_MESSAGE = "Erro interno do servidor."
router = APIRouter()
MAX_BODY_BYTES = 512 * 1024
MAX_MESSAGES_PER_RUN = 500
MAX_CONCURRENT_SENDS = 4
DISPATCH_BUDGET_SECONDS = 50.0
MIN_SEND_WINDOW_SECONDS = 22.0
STOP_WORDS = {"SAIR", "PARAR", "CANCELAR", "CANCELAR MENSAGENS", "STOP"}


def response(payload: dict, status: int = 200):
    return JSONResponse(
        payload,
        status_code=status,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


async def raw_body(request: Request) -> bytes:
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise ValueError("Corpo da requisição muito grande.")
    return raw


def parse_body(raw: bytes) -> dict:
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def cron_authorized(request: Request) -> bool:
    expected = str(os.getenv("CRON_SECRET", "")).strip()
    received = str(request.headers.get("authorization") or "")
    if received.lower().startswith("bearer "):
        received = received[7:]
    received = received.strip()
    return len(expected) >= 32 and len(received) >= 32 and safe_equal(expected, received)


async def dispatch_reminders():
    settings, rows = await get_config(), await list_open_payment_rows()
    if not settings["enabled"]:
        return {
            "ok": True,
            "disabled": True,
            "checked": len(rows),
            "sent": 0,
            "skipped": len(rows),
            "failed": 0,
            "deferred": 0,
        }
    if not provider_status()["readyToSend"]:
        raise RuntimeError("Integração do WhatsApp habilitada, mas as credenciais da Meta estão incompletas.")

    started = monotonic()
    deadline = started + DISPATCH_BUDGET_SECONDS
    today = iso_date_in_timezone(datetime.now(timezone.utc), settings["timezone"])
    skipped = 0
    candidates = []

    for row in rows[:MAX_MESSAGES_PER_RUN]:
        payment = as_dict(row.get("payment"))
        student = as_dict(row.get("student"))
        due_date = due_date_for_payment(payment)
        offset_days = days_until(due_date, today)
        amount = outstanding_amount(payment)
        phone = normalize_brazil_phone(student.get("phone"))

        if (
            not due_date
            or offset_days is None
            or offset_days not in settings["offsets"]
            or amount <= 0
            or not phone
        ):
            skipped += 1
            continue

        candidates.append(
            {
                "row": row,
                "student": student,
                "dueDate": due_date,
                "offsetDays": offset_days,
                "amount": amount,
                "phone": phone,
            }
        )

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_SENDS)

    async def send_candidate(candidate: dict) -> str:
        async with semaphore:
            # O POST para a Meta usa timeout de 20 s. Não inicia um novo envio
            # se não houver margem suficiente para concluir e registrar o log.
            if monotonic() > deadline - MIN_SEND_WINDOW_SECONDS:
                return "deferred"

            row = candidate["row"]
            student = candidate["student"]
            key = reminder_key(row["paymentId"], candidate["offsetDays"], candidate["phone"])
            claimed = await claim_message(
                {
                    "notificationKey": key,
                    "paymentId": row["paymentId"],
                    "studentId": row["studentId"],
                    "offsetDays": candidate["offsetDays"],
                    "phone": candidate["phone"],
                    "guardianName": student.get("guardian") or "Responsável",
                    "studentName": student.get("name") or "Criança",
                    "amount": candidate["amount"],
                    "dueDate": candidate["dueDate"],
                }
            )
            if not claimed:
                return "duplicate"

            try:
                result = await send_template_message(
                    to=candidate["phone"],
                    guardian_name=student.get("guardian") or "Responsável",
                    student_name=student.get("name") or "Criança",
                    amount=format_brl(candidate["amount"]),
                    due_date=format_date_br(candidate["dueDate"]),
                    timing=timing_label(candidate["offsetDays"]),
                )
                await finish_message(key, {"status": "accepted", "messageId": result["messageId"]})
                return "sent"
            except Exception as exc:
                await finish_message(key, {"status": "failed", "error": str(exc)})
                return "failed"

    results = await asyncio.gather(*(send_candidate(candidate) for candidate in candidates))
    sent = results.count("sent")
    duplicates = results.count("duplicate")
    failed = results.count("failed")
    deferred = results.count("deferred")

    return {
        "ok": True,
        "checked": len(rows),
        "eligible": len(candidates),
        "sent": sent,
        "skipped": skipped,
        "duplicates": duplicates,
        "failed": failed,
        "deferred": deferred,
        "today": today,
        "limited": len(rows) > MAX_MESSAGES_PER_RUN or deferred > 0,
        "elapsedMs": int((monotonic() - started) * 1000),
    }


async def handle_admin(request: Request, raw: bytes):
    body = parse_body(raw)
    if not await sync_authorized(request, body):
        return response({"ok": False, "error": "Chave de sincronização inválida."}, 401)

    action = str(request.query_params.get("action") or body.get("action") or "status")
    if request.method == "GET" or action == "status":
        settings, history, recipients = await get_config(), await list_history(60), await list_recipients()
        return response(
            {
                "ok": True,
                "settings": settings,
                "provider": provider_status(),
                "history": history,
                "recipients": recipients,
            }
        )

    if action == "save-config":
        settings = await save_config(as_dict(body.get("settings")) or body)
        return response({"ok": True, "settings": settings, "provider": provider_status()})

    if action == "save-recipients":
        recipients = await save_recipients(body.get("studentIds"))
        return response({"ok": True, "recipients": recipients})

    if action == "test":
        phone = normalize_brazil_phone(body.get("phone"))
        if not phone:
            return response({"ok": False, "error": "Informe um telefone brasileiro válido com DDD."}, 400)

        today = iso_date_in_timezone()
        key = hashlib.sha256(f"test|{phone}|{datetime.now().timestamp()}|{uuid.uuid4()}".encode()).hexdigest()
        await claim_message(
            {
                "notificationKey": key,
                "paymentId": "test",
                "studentId": "test",
                "offsetDays": 0,
                "phone": phone,
                "guardianName": "Responsável",
                "studentName": "Criança de teste",
                "amount": 0,
                "dueDate": today,
            }
        )
        try:
            result = await send_template_message(
                to=phone,
                guardian_name="Responsável",
                student_name="Criança de teste",
                amount=format_brl(0),
                due_date=format_date_br(today),
                timing="mensagem de teste da integração",
            )
            await finish_message(key, {"status": "accepted", "messageId": result["messageId"]})
            return response({"ok": True, "tested": True, "messageId": result["messageId"]})
        except Exception as exc:
            await finish_message(key, {"status": "failed", "error": str(exc)})
            raise

    if action == "dispatch":
        return response(await dispatch_reminders())

    return response({"ok": False, "error": "Ação inválida."}, 400)


async def handle_webhook(request: Request, raw: bytes):
    provider = whatsapp_provider_config()
    if request.method == "GET":
        expected = provider["webhookVerifyToken"]
        received = str(request.query_params.get("hub.verify_token") or "")
        if (
            request.query_params.get("hub.mode") == "subscribe"
            and expected
            and safe_equal(expected, received)
        ):
            return PlainTextResponse(str(request.query_params.get("hub.challenge") or ""), status_code=200)
        return PlainTextResponse("Forbidden", status_code=403)

    if not webhook_signature_valid(raw, request.headers.get("x-hub-signature-256") or ""):
        return response({"ok": False, "error": "Assinatura do webhook inválida."}, 401)

    body = parse_body(raw)
    status_updates = opt_outs = 0
    for entry in body.get("entry") if isinstance(body.get("entry"), list) else []:
        for change in entry.get("changes") if isinstance(entry, dict) and isinstance(entry.get("changes"), list) else []:
            value = as_dict(change.get("value"))
            for status in value.get("statuses") if isinstance(value.get("statuses"), list) else []:
                errors = status.get("errors") if isinstance(status, dict) and isinstance(status.get("errors"), list) else []
                error = " · ".join(
                    str(
                        as_dict(item.get("error_data")).get("details")
                        or item.get("message")
                        or item.get("title")
                        or ""
                    )
                    for item in errors
                    if isinstance(item, dict)
                )
                await update_delivery_status(
                    str(status.get("id") or ""),
                    str(status.get("status") or ""),
                    {"timestamp": status.get("timestamp"), "error": error},
                )
                status_updates += 1

            for message in value.get("messages") if isinstance(value.get("messages"), list) else []:
                text = str(as_dict(message.get("text")).get("body") or "").strip().upper()
                if text in STOP_WORDS:
                    opt_outs += await opt_out_students_by_phone(
                        str(message.get("from") or ""),
                        iso_now(),
                    )
    return response({"ok": True, "statusUpdates": status_updates, "optOuts": opt_outs})


@router.api_route("/api/whatsapp-reminders", methods=["GET", "POST"])
async def whatsapp_reminders(request: Request):
    try:
        action = str(request.query_params.get("action") or "")
        if action == "webhook":
            return await handle_webhook(request, await raw_body(request) if request.method == "POST" else b"")

        if action == "dispatch" and request.method == "GET":
            if not cron_authorized(request):
                return response({"ok": False, "error": "Cron não autorizado."}, 401)
            return response(await dispatch_reminders())

        return await handle_admin(
            request,
            await raw_body(request) if request.method == "POST" else b"",
        )
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)
