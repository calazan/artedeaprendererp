from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from ..security import safe_equal, sync_authorized
from ..task_store import (
    claim_notification,
    delete_task,
    disable_push_subscription,
    disable_push_subscription_by_id,
    finish_notification,
    get_vapid_keys,
    list_active_tasks,
    list_push_subscriptions,
    list_tasks,
    release_notification_claim,
    save_push_subscription,
    send_web_push,
    task_cron_token,
    upsert_task,
)
from ..utils import as_dict, iso_now

logger = logging.getLogger("smg.routers.tasks")
INTERNAL_ERROR_MESSAGE = "Erro interno do servidor."
router = APIRouter()
LOOKBACK = timedelta(minutes=10)
LOOKAHEAD = timedelta(seconds=20)
DEFAULT_APP_HOST = "artedeaprendererp.vercel.app"


def response(payload: dict, status: int = 200):
    return JSONResponse(
        payload,
        status_code=status,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


async def read_body(request: Request) -> dict:
    raw = await request.body()
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


async def cron_authorized(request: Request) -> bool:
    # A Vercel envia CRON_SECRET no cabeçalho Authorization: Bearer <segredo>.
    # O token próprio continua aceito no cabeçalho interno, mas não na URL.
    authorization = str(request.headers.get("authorization") or "").strip()
    bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    cron_secret = str(os.getenv("CRON_SECRET") or "").strip()
    internal = str(request.headers.get("x-task-cron-token") or "").strip()
    if len(cron_secret) >= 32 and len(bearer) >= 32 and safe_equal(cron_secret, bearer):
        return True
    if len(internal) < 32:
        return False
    expected = await task_cron_token()
    return len(expected) >= 32 and safe_equal(expected, internal)


def recurs_on(task: dict, day: date) -> bool:
    if task.get("active") is False:
        return False
    try:
        start = date.fromisoformat(str(task.get("date") or ""))
    except Exception:
        return False
    if day < start:
        return False
    until_text = str(task.get("recurrenceUntil") or "")
    if until_text:
        try:
            if day > date.fromisoformat(until_text):
                return False
        except Exception:
            pass

    recurrence = str(task.get("recurrence") or "none")
    # JS getUTCDay(): domingo=0. Python weekday(): segunda=0.
    js_day = (day.weekday() + 1) % 7
    start_js_day = (start.weekday() + 1) % 7
    if recurrence == "none":
        return day == start
    if recurrence == "daily":
        return True
    if recurrence == "weekdays":
        return 1 <= js_day <= 5
    if recurrence == "weekly":
        return js_day == start_js_day
    if recurrence == "custom":
        return js_day in [int(v) for v in task.get("weekdays") or []]
    if recurrence == "monthly":
        return day.day == start.day
    return False


def occurrence_state(task: dict, day: date) -> dict:
    value = as_dict(task.get("occurrences")).get(day.isoformat())
    return value if isinstance(value, dict) else {}


def due_candidate(task: dict, day: date, now: datetime):
    if not recurs_on(task, day) or not task.get("time"):
        return None
    state = occurrence_state(task, day)
    if state.get("status") == "completed":
        return None

    try:
        zone = ZoneInfo(str(task.get("timezone") or "America/Sao_Paulo"))
    except Exception:
        zone = ZoneInfo("America/Sao_Paulo")
    try:
        hh, mm = [int(v) for v in str(task["time"]).split(":")[:2]]
    except Exception:
        return None

    occurrence_at = datetime(day.year, day.month, day.day, hh, mm, tzinfo=zone).astimezone(timezone.utc)
    reminder = occurrence_at - timedelta(minutes=max(0, int(task.get("reminderMinutes") or 0)))

    snoozed = None
    if state.get("snoozedUntil"):
        try:
            snoozed = datetime.fromisoformat(str(state["snoozedUntil"]).replace("Z", "+00:00")).astimezone(timezone.utc)
        except Exception:
            pass
    scheduled = snoozed if snoozed and snoozed > reminder else reminder

    delta = now - scheduled
    if delta < -LOOKAHEAD or delta > LOOKBACK:
        return None
    return {"occurrenceAt": occurrence_at, "scheduledFor": scheduled}


def notification_key(task_id: str, occurrence_date: str, scheduled_for: datetime, subscription_id: str) -> str:
    raw = f"{task_id}|{occurrence_date}|{scheduled_for.isoformat().replace('+00:00','Z')}|{subscription_id}"
    return hashlib.sha256(raw.encode()).hexdigest()


def notification_payload(task: dict, occurrence_date: str) -> str:
    kind = "Compromisso" if task.get("type") == "appointment" else "Tarefa"
    assignee = f" · {task.get('assignee')}" if task.get("assignee") else ""
    body = {
        "title": f"Arte de Aprender · {kind}",
        "body": f"{(str(task.get('time')) + ' — ') if task.get('time') else ''}{task.get('title')}{assignee}",
        "icon": "/app-icon-192.png?v=1",
        "badge": "/favicon-96.png?v=1",
        "tag": f"smg-task-{task.get('id')}-{occurrence_date}",
        "renotify": True,
        "requireInteraction": task.get("priority") == "high",
        "data": {
            "url": f"/?smgView=tasks&task={task.get('id')}&date={occurrence_date}",
            "taskId": task.get("id"),
            "occurrenceDate": occurrence_date,
        },
    }
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


async def handle_push_config(request: Request, body: dict):
    vapid = await get_vapid_keys()
    if request.method == "GET":
        return response({"ok": True, "publicKey": vapid.get("publicKey", ""), "supported": True})

    action = str(body.get("action") or "subscribe")
    subscription = as_dict(body.get("subscription"))
    if action == "unsubscribe":
        endpoint = str(body.get("endpoint") or subscription.get("endpoint") or "")
        await disable_push_subscription(endpoint)
        return response({"ok": True, "unsubscribed": True})

    sid = await save_push_subscription(
        subscription,
        {"deviceLabel": body.get("deviceLabel"), "userAgent": request.headers.get("user-agent", "")},
    )
    if action == "test":
        host = "".join(ch for ch in str(request.headers.get("host") or DEFAULT_APP_HOST) if ch.isalnum() or ch in ".:-")
        payload = json.dumps(
            {
                "title": "Arte de Aprender ERP",
                "body": "Notificações ativadas com sucesso neste aparelho.",
                "icon": "/app-icon-192.png?v=1",
                "badge": "/favicon-96.png?v=1",
                "tag": f"smg-push-test-{int(datetime.now().timestamp()*1000)}",
                "data": {"url": "/?smgView=tasks"},
            },
            ensure_ascii=False,
        )
        try:
            await run_in_threadpool(
                send_web_push,
                subscription,
                payload,
                vapid,
                f"https://{host or DEFAULT_APP_HOST}",
                60,
            )
        except Exception as exc:
            status = int(getattr(exc, "status_code", 0) or 0)
            if status in {404, 410}:
                await disable_push_subscription(subscription.get("endpoint", ""))
            raise
        return response({"ok": True, "subscriptionId": sid, "tested": True})
    return response({"ok": True, "subscriptionId": sid, "subscribed": True})


async def handle_dispatch(request: Request):
    if not await cron_authorized(request):
        return response({"ok": False, "error": "Disparador não autorizado."}, 401)

    now = datetime.now(timezone.utc)
    tasks, subscriptions, vapid = await list_active_tasks(), await list_push_subscriptions(), await get_vapid_keys()
    if not subscriptions or not tasks:
        return response({"ok": True, "checkedTasks": len(tasks), "subscriptions": len(subscriptions), "sent": 0})

    candidates = []
    for task in tasks:
        try:
            zone = ZoneInfo(str(task.get("timezone") or "America/Sao_Paulo"))
        except Exception:
            zone = ZoneInfo("America/Sao_Paulo")
        local_day = now.astimezone(zone).date()
        for day in (local_day - timedelta(days=1), local_day, local_day + timedelta(days=1)):
            due = due_candidate(task, day, now)
            if due:
                candidates.append({"task": task, "occurrenceDate": day.isoformat(), **due})

    sent = skipped = failed = 0
    host = "".join(ch for ch in str(request.headers.get("host") or DEFAULT_APP_HOST) if ch.isalnum() or ch in ".:-")
    subject = f"https://{host or DEFAULT_APP_HOST}"

    for candidate in candidates:
        task = candidate["task"]
        payload = notification_payload(task, candidate["occurrenceDate"])
        for subscription in subscriptions:
            key = notification_key(
                str(task.get("id")),
                candidate["occurrenceDate"],
                candidate["scheduledFor"],
                subscription["id"],
            )
            claimed = await claim_notification(
                {
                    "notificationKey": key,
                    "taskId": task.get("id"),
                    "occurrenceDate": candidate["occurrenceDate"],
                    "subscriptionId": subscription["id"],
                    "scheduledFor": candidate["scheduledFor"],
                }
            )
            if not claimed:
                skipped += 1
                continue
            try:
                await run_in_threadpool(
                    send_web_push,
                    {"endpoint": subscription["endpoint"], "keys": subscription["keys"]},
                    payload,
                    vapid,
                    subject,
                    600,
                )
                await finish_notification(key, "sent", "")
                sent += 1
            except Exception as exc:
                status = int(getattr(exc, "status_code", 0) or 0)
                if status in {404, 410}:
                    await disable_push_subscription_by_id(subscription["id"])
                    await finish_notification(key, "subscription-gone", str(exc))
                else:
                    await release_notification_claim(key)
                failed += 1

    return response(
        {
            "ok": True,
            "checkedTasks": len(tasks),
            "subscriptions": len(subscriptions),
            "dueOccurrences": len(candidates),
            "sent": sent,
            "skipped": skipped,
            "failed": failed,
            "checkedAt": iso_now(),
        }
    )


async def tasks_handler(request: Request, *, force_push: bool = False):
    try:
        mode = "push" if force_push else str(request.query_params.get("action") or "").strip()
        if mode == "dispatch":
            return await handle_dispatch(request)

        body = {} if request.method == "GET" else await read_body(request)
        if not await sync_authorized(request, body):
            return response({"ok": False, "error": "Autenticação obrigatória."}, 401)

        if mode == "push" or str(body.get("action") or "") in {"subscribe", "unsubscribe", "test"}:
            return await handle_push_config(request, body)

        if request.method == "GET":
            result = await list_tasks(include_deleted=True)
            return response({"ok": True, **result, "provider": "neon-postgres"})

        if request.method == "DELETE" or body.get("action") == "delete":
            task_id = str(body.get("id") or "").strip()
            if not task_id:
                return response({"ok": False, "error": "Tarefa inválida."}, 400)
            await delete_task(task_id)
            return response({"ok": True, "deletedId": task_id})

        task = body.get("task") if isinstance(body.get("task"), dict) else body
        saved = await upsert_task(task)
        return response({"ok": True, "task": saved})
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)


@router.api_route("/api/tasks", methods=["GET", "POST", "DELETE"])
async def tasks(request: Request):
    return await tasks_handler(request)


@router.api_route("/api/task-push", methods=["GET", "POST"])
async def task_push_alias(request: Request):
    return await tasks_handler(request, force_push=True)
