from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timezone
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from psycopg.types.json import Jsonb
from pywebpush import webpush, WebPushException

from .db import connection
from .state import ensure_core_schema
from .utils import as_dict, as_list, iso_now, iso_value

_task_schema_ready = False

TASK_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS public.smg_tasks (
  id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_tasks_active_idx
  ON public.smg_tasks(updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.smg_push_subscriptions (
  id text PRIMARY KEY,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  device_label text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_push_subscriptions_enabled_idx
  ON public.smg_push_subscriptions(enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.smg_task_notification_log (
  notification_key text PRIMARY KEY,
  task_id text NOT NULL,
  occurrence_date text NOT NULL DEFAULT '',
  subscription_id text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  status text NOT NULL DEFAULT 'claimed',
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smg_task_notification_log_task_idx
  ON public.smg_task_notification_log(task_id, occurrence_date, created_at DESC);

ALTER TABLE public.smg_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_task_notification_log ENABLE ROW LEVEL SECURITY;
"""


async def ensure_task_schema() -> None:
    global _task_schema_ready
    if _task_schema_ready:
        return
    await ensure_core_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(TASK_SCHEMA_SQL)
    _task_schema_ready = True


def clean_task(task: Any) -> dict:
    copy = dict(as_dict(task))
    copy["id"] = str(copy.get("id") or "").strip()
    copy["title"] = str(copy.get("title") or "").strip()[:200]
    copy["type"] = "appointment" if copy.get("type") == "appointment" else "task"

    import re
    copy["date"] = str(copy.get("date") or "") if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(copy.get("date") or "")) else ""
    copy["time"] = str(copy.get("time") or "") if re.fullmatch(r"\d{2}:\d{2}", str(copy.get("time") or "")) else ""
    copy["assignee"] = str(copy.get("assignee") or "").strip()[:120]
    copy["priority"] = copy.get("priority") if copy.get("priority") in {"low", "normal", "high"} else "normal"
    copy["recurrence"] = copy.get("recurrence") if copy.get("recurrence") in {"none", "daily", "weekdays", "weekly", "custom", "monthly"} else "none"

    weekdays = []
    for value in as_list(copy.get("weekdays")):
        try:
            number = int(value)
        except Exception:
            continue
        if 0 <= number <= 6 and number not in weekdays:
            weekdays.append(number)
    copy["weekdays"] = weekdays

    until = str(copy.get("recurrenceUntil") or "")
    copy["recurrenceUntil"] = until if re.fullmatch(r"\d{4}-\d{2}-\d{2}", until) else ""

    allowed_minutes = {0, 5, 10, 15, 30, 60, 120, 1440}
    try:
        reminder = int(copy.get("reminderMinutes"))
    except Exception:
        reminder = 10
    copy["reminderMinutes"] = reminder if reminder in allowed_minutes else 10

    copy["timezone"] = str(copy.get("timezone") or "America/Sao_Paulo")[:80]
    copy["notes"] = str(copy.get("notes") or "")[:3000]
    checklist = []
    for item in as_list(copy.get("checklist"))[:50]:
        if not isinstance(item, dict):
            continue
        row = {
            "id": str(item.get("id") or "")[:120],
            "text": str(item.get("text") or "").strip()[:300],
        }
        if row["id"] and row["text"]:
            checklist.append(row)
    copy["checklist"] = checklist
    copy["occurrences"] = as_dict(copy.get("occurrences"))
    copy["active"] = copy.get("active") is not False
    copy["createdAt"] = str(copy.get("createdAt") or iso_now())
    copy["updatedAt"] = str(copy.get("updatedAt") or iso_now())
    return copy


async def list_tasks(*, include_deleted: bool = True) -> dict:
    await ensure_task_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            query = (
                """
                SELECT id, data, deleted_at, updated_at
                FROM public.smg_tasks
                ORDER BY updated_at DESC, id
                """
                if include_deleted
                else """
                SELECT id, data, deleted_at, updated_at
                FROM public.smg_tasks
                WHERE deleted_at IS NULL
                ORDER BY updated_at DESC, id
                """
            )
            await cur.execute(query)
            rows = await cur.fetchall()
    tasks, deleted_ids = [], []
    for row_id, data, deleted_at, _updated in rows:
        if deleted_at:
            deleted_ids.append(str(row_id))
        else:
            tasks.append({**clean_task(data or {}), "id": str(row_id)})
    return {"tasks": tasks, "deletedIds": deleted_ids}


async def list_active_tasks() -> list[dict]:
    return [
        task for task in (await list_tasks(include_deleted=False))["tasks"]
        if task.get("active") is not False
    ]


async def upsert_task(task: dict) -> dict:
    await ensure_task_schema()
    normalized = clean_task(task)
    if not normalized["id"] or not normalized["title"] or not normalized["date"] or not normalized["time"]:
        raise ValueError("Tarefa inválida: informe título, data e horário.")

    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO public.smg_tasks(id, data, deleted_at, updated_at)
                VALUES (%s, %s, NULL, now())
                ON CONFLICT (id) DO UPDATE
                  SET data = EXCLUDED.data,
                      deleted_at = NULL,
                      updated_at = now()
                WHERE COALESCE(public.smg_tasks.data->>'updatedAt','')
                   <= COALESCE(EXCLUDED.data->>'updatedAt','')
                RETURNING id, data, updated_at
                """,
                (normalized["id"], Jsonb(normalized)),
            )
            row = await cur.fetchone()
            if row:
                return row[1] or normalized

            await cur.execute("SELECT data FROM public.smg_tasks WHERE id=%s LIMIT 1", (normalized["id"],))
            current = await cur.fetchone()
            return (current[0] if current else None) or normalized


async def delete_task(task_id: str) -> bool:
    await ensure_task_schema()
    clean = str(task_id or "").strip()
    if not clean:
        return False
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE public.smg_tasks
                SET deleted_at=COALESCE(deleted_at,now()), updated_at=now()
                WHERE id=%s RETURNING id
                """,
                (clean,),
            )
            return (await cur.fetchone()) is not None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _generate_vapid_keys() -> dict:
    private = ec.generate_private_key(ec.SECP256R1())
    private_pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")
    public_bytes = private.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    return {
        "publicKey": _b64url(public_bytes),
        "privateKeyPem": private_pem,
        "createdAt": iso_now(),
    }


async def get_vapid_keys() -> dict:
    await ensure_task_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT value FROM public.smg_meta WHERE key='task_push_vapid' LIMIT 1")
            row = await cur.fetchone()
            value = as_dict(row[0] if row else {})
            if value.get("publicKey") and (value.get("privateKeyPem") or value.get("privateKey")):
                return value

            generated = _generate_vapid_keys()
            await cur.execute(
                """
                INSERT INTO public.smg_meta(key,value,updated_at)
                VALUES ('task_push_vapid',%s,now())
                ON CONFLICT (key) DO UPDATE
                SET value = CASE
                  WHEN COALESCE(public.smg_meta.value->>'publicKey','') <> ''
                   AND (
                     COALESCE(public.smg_meta.value->>'privateKeyPem','') <> ''
                     OR COALESCE(public.smg_meta.value->>'privateKey','') <> ''
                   )
                  THEN public.smg_meta.value
                  ELSE EXCLUDED.value
                END,
                updated_at=now()
                """,
                (Jsonb(generated),),
            )
            await cur.execute("SELECT value FROM public.smg_meta WHERE key='task_push_vapid' LIMIT 1")
            saved = await cur.fetchone()
            return as_dict(saved[0] if saved else generated)


def subscription_id(endpoint: str = "") -> str:
    return hashlib.sha256(str(endpoint).encode()).hexdigest()[:40]


async def save_push_subscription(subscription: dict, meta: dict) -> str:
    await ensure_task_schema()
    endpoint = str(subscription.get("endpoint") or "").strip()
    keys = as_dict(subscription.get("keys"))
    p256dh = str(keys.get("p256dh") or "").strip()
    auth = str(keys.get("auth") or "").strip()
    if not endpoint or not p256dh or not auth:
        raise ValueError("Inscrição de notificação inválida.")
    sid = subscription_id(endpoint)
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO public.smg_push_subscriptions
                  (id,endpoint,p256dh,auth,device_label,user_agent,enabled,last_seen_at,created_at,updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,true,now(),now(),now())
                ON CONFLICT (endpoint) DO UPDATE SET
                  p256dh=EXCLUDED.p256dh,
                  auth=EXCLUDED.auth,
                  device_label=EXCLUDED.device_label,
                  user_agent=EXCLUDED.user_agent,
                  enabled=true,
                  last_seen_at=now(),
                  updated_at=now()
                """,
                (
                    sid,
                    endpoint,
                    p256dh,
                    auth,
                    str(meta.get("deviceLabel") or "")[:160],
                    str(meta.get("userAgent") or "")[:500],
                ),
            )
    return sid


async def disable_push_subscription(endpoint: str) -> bool:
    await ensure_task_schema()
    clean = str(endpoint or "").strip()
    if not clean:
        return False
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE public.smg_push_subscriptions SET enabled=false,updated_at=now() WHERE endpoint=%s RETURNING id",
                (clean,),
            )
            return (await cur.fetchone()) is not None


async def disable_push_subscription_by_id(sid: str) -> bool:
    await ensure_task_schema()
    clean = str(sid or "").strip()
    if not clean:
        return False
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE public.smg_push_subscriptions SET enabled=false,updated_at=now() WHERE id=%s RETURNING id",
                (clean,),
            )
            return (await cur.fetchone()) is not None


async def list_push_subscriptions() -> list[dict]:
    await ensure_task_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id,endpoint,p256dh,auth,device_label,user_agent
                FROM public.smg_push_subscriptions
                WHERE enabled=true
                ORDER BY updated_at DESC
                """
            )
            rows = await cur.fetchall()
    return [
        {
            "id": str(row[0]),
            "endpoint": str(row[1]),
            "keys": {"p256dh": str(row[2]), "auth": str(row[3])},
            "deviceLabel": str(row[4] or ""),
            "userAgent": str(row[5] or ""),
        }
        for row in rows
    ]


async def claim_notification(entry: dict) -> bool:
    await ensure_task_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO public.smg_task_notification_log
                  (notification_key,task_id,occurrence_date,subscription_id,scheduled_for,status,created_at,updated_at)
                VALUES (%s,%s,%s,%s,%s,'claimed',now(),now())
                ON CONFLICT (notification_key) DO NOTHING
                RETURNING notification_key
                """,
                (
                    str(entry.get("notificationKey") or ""),
                    str(entry.get("taskId") or ""),
                    str(entry.get("occurrenceDate") or ""),
                    str(entry.get("subscriptionId") or ""),
                    entry.get("scheduledFor"),
                ),
            )
            return (await cur.fetchone()) is not None


async def finish_notification(notification_key: str, status: str = "sent", error: str = "") -> None:
    await ensure_task_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE public.smg_task_notification_log
                SET status=%s,
                    error=%s,
                    sent_at=CASE WHEN %s='sent' THEN now() ELSE sent_at END,
                    updated_at=now()
                WHERE notification_key=%s
                """,
                (status, str(error or "")[:1000], status, str(notification_key or "")),
            )


async def release_notification_claim(notification_key: str) -> None:
    await ensure_task_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM public.smg_task_notification_log WHERE notification_key=%s AND status='claimed'",
                (str(notification_key or ""),),
            )


async def task_cron_token() -> str:
    await ensure_task_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT value->>'token' FROM public.smg_meta WHERE key='task_push_cron' LIMIT 1")
            row = await cur.fetchone()
            return str(row[0] if row else "").strip()


def send_web_push(subscription: dict, payload: str, vapid: dict, subject: str, ttl: int = 600) -> None:
    private_pem = str(vapid.get("privateKeyPem") or "")
    if not private_pem:
        raise RuntimeError(
            "Chave VAPID antiga sem PEM detectada. Gere novamente em task_push_vapid para uso no backend Python."
        )

    try:
        private_key = serialization.load_pem_private_key(
            private_pem.encode("ascii"),
            password=None,
        )
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Chave VAPID privada inválida.") from exc
    if not isinstance(private_key, ec.EllipticCurvePrivateKey):
        raise RuntimeError("Chave VAPID privada inválida.")

    private_der = private_key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    private_der_b64 = _b64url(private_der)
    webpush(
        subscription_info=subscription,
        data=payload,
        vapid_private_key=private_der_b64,
        vapid_claims={"sub": subject},
        ttl=ttl,
    )
