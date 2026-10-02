from __future__ import annotations

import hashlib
import hmac
import json
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from psycopg.types.json import Jsonb

from .config import whatsapp_provider_config
from .db import connection
from .state import ensure_core_schema
from .utils import as_dict, as_list, iso_now, iso_value

_schema_ready = False

WHATSAPP_RETRY_AFTER = timedelta(minutes=10)
WHATSAPP_MAX_ATTEMPTS = 3

WHATSAPP_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS public.smg_whatsapp_recipients (
  student_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  consent_at timestamptz,
  opt_out_at timestamptz,
  consent_source text NOT NULL DEFAULT 'admin-confirmed',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.smg_whatsapp_message_log (
  notification_key text PRIMARY KEY,
  payment_id text NOT NULL DEFAULT '',
  student_id text NOT NULL DEFAULT '',
  offset_days integer NOT NULL DEFAULT 0,
  recipient_last4 text NOT NULL DEFAULT '',
  guardian_name text NOT NULL DEFAULT '',
  student_name text NOT NULL DEFAULT '',
  amount numeric NOT NULL DEFAULT 0,
  due_date date,
  meta_message_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'claimed',
  error text NOT NULL DEFAULT '',
  attempt_count integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS smg_whatsapp_message_meta_id_idx
  ON public.smg_whatsapp_message_log(meta_message_id)
  WHERE meta_message_id <> '';
CREATE INDEX IF NOT EXISTS smg_whatsapp_message_log_created_idx
  ON public.smg_whatsapp_message_log(created_at DESC);
ALTER TABLE public.smg_whatsapp_message_log
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
UPDATE public.smg_whatsapp_message_log
SET attempt_count=1
WHERE attempt_count=0;

ALTER TABLE public.smg_whatsapp_message_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.smg_whatsapp_recipients ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.smg_whatsapp_message_log FROM anon';
    EXECUTE 'REVOKE ALL ON TABLE public.smg_whatsapp_recipients FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.smg_whatsapp_message_log FROM authenticated';
    EXECUTE 'REVOKE ALL ON TABLE public.smg_whatsapp_recipients FROM authenticated';
  END IF;
END
$$;

INSERT INTO public.smg_meta(key, value, updated_at)
VALUES (
  'whatsapp_reminders',
  '{"enabled":false,"offsets":[3,0,-1],"timezone":"America/Sao_Paulo"}'::jsonb,
  now()
)
ON CONFLICT (key) DO NOTHING;
"""


async def ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    await ensure_core_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(WHATSAPP_SCHEMA_SQL)
    _schema_ready = True


def normalize_offsets(value: Any) -> list[int]:
    source = value if isinstance(value, list) else [3, 0, -1]
    unique = []
    for item in source:
        try:
            number = int(item)
        except Exception:
            continue
        if -30 <= number <= 30 and number not in unique:
            unique.append(number)
    return sorted(unique, reverse=True)[:8]


def normalize_brazil_phone(value: Any = "") -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if digits.startswith("00"):
        digits = digits[2:]
    if len(digits) in (10, 11):
        digits = "55" + digits
    if not digits.startswith("55"):
        return ""
    if len(digits) not in (12, 13):
        return ""
    return digits


def iso_date_in_timezone(moment: datetime | None = None, time_zone: str = "America/Sao_Paulo") -> str:
    moment = moment or datetime.now(timezone.utc)
    try:
        zone = ZoneInfo(time_zone)
    except Exception:
        zone = ZoneInfo("America/Sao_Paulo")
    return moment.astimezone(zone).date().isoformat()


def due_date_for_payment(payment: dict) -> str:
    period = str(payment.get("period") or "")
    import re
    if not re.fullmatch(r"\d{4}-\d{2}", period):
        return ""
    year, month = [int(v) for v in period.split("-")]
    try:
        requested = max(1, min(31, int(payment.get("dueDay") or 10)))
        last = monthrange(year, month)[1]
        return f"{period}-{min(requested, last):02d}"
    except Exception:
        return ""


def days_until(due_date: str, today: str) -> int | None:
    try:
        return (date.fromisoformat(due_date) - date.fromisoformat(today)).days
    except Exception:
        return None


def outstanding_amount(payment: dict) -> float:
    total = max(0.0, float(payment.get("amount") or 0))
    received = 0.0
    for receipt in as_list(payment.get("receipts")):
        if isinstance(receipt, dict):
            received += max(0.0, float(receipt.get("amount") or 0))
    return max(0.0, round(total - received, 2))


def format_brl(value: float = 0) -> str:
    # Locale independente, compatível com apresentação pt-BR.
    number = f"{float(value or 0):,.2f}"
    number = number.replace(",", "_").replace(".", ",").replace("_", ".")
    return f"R$ {number}"


def format_date_br(value: str = "") -> str:
    try:
        parsed = date.fromisoformat(value)
        return parsed.strftime("%d/%m/%Y")
    except Exception:
        return ""


def timing_label(offset_days: int = 0) -> str:
    value = int(offset_days or 0)
    if value == 0:
        return "vence hoje"
    if value == 1:
        return "vence amanhã"
    if value > 1:
        return f"vence em {value} dias"
    if value == -1:
        return "está vencida há 1 dia"
    return f"está vencida há {abs(value)} dias"


async def get_config() -> dict:
    await ensure_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT value,updated_at FROM public.smg_meta WHERE key='whatsapp_reminders' LIMIT 1"
            )
            row = await cur.fetchone()
    value = as_dict(row[0] if row else {})
    return {
        "enabled": value.get("enabled") is True,
        "offsets": normalize_offsets(value.get("offsets")),
        "timezone": "America/Sao_Paulo",
        "updatedAt": iso_value(row[1]) if row else "",
    }


async def save_config(input_data: dict) -> dict:
    await ensure_schema()
    config = {
        "enabled": input_data.get("enabled") is True,
        "offsets": normalize_offsets(input_data.get("offsets")),
        "timezone": "America/Sao_Paulo",
    }
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO public.smg_meta(key,value,updated_at)
                VALUES ('whatsapp_reminders',%s,now())
                ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
                """,
                (Jsonb(config),),
            )
    return await get_config()


async def list_open_payment_rows() -> list[dict]:
    await ensure_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  p.id,p.student_id,p.period,p.amount,p.status,p.data,s.data
                FROM public.smg_payments p
                JOIN public.smg_students s ON s.id=p.student_id
                JOIN public.smg_whatsapp_recipients r
                  ON r.student_id=p.student_id AND r.enabled=true
                WHERE p.deleted_at IS NULL
                  AND COALESCE(p.status,'open') <> 'paid'
                  AND COALESCE(s.status,'active') = 'active'
                ORDER BY p.period,p.student_id,p.id
                """
            )
            rows = await cur.fetchall()

    return [
        {
            "paymentId": str(row[0] or ""),
            "studentId": str(row[1] or ""),
            "payment": {
                **as_dict(row[5]),
                "id": str(row[0] or ""),
                "period": str(row[2] or ""),
                "amount": float(row[3] or 0),
            },
            "student": as_dict(row[6]),
        }
        for row in rows
    ]


async def list_recipients() -> list[dict]:
    await ensure_schema()
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT student_id,enabled,consent_at,opt_out_at,consent_source,updated_at
                FROM public.smg_whatsapp_recipients
                ORDER BY student_id
                """
            )
            rows = await cur.fetchall()
    return [
        {
            "studentId": str(r[0]),
            "enabled": r[1] is True,
            "consentAt": iso_value(r[2]),
            "optOutAt": iso_value(r[3]),
            "consentSource": str(r[4] or ""),
            "updatedAt": iso_value(r[5]),
        }
        for r in rows
    ]


async def save_recipients(student_ids: Any) -> list[dict]:
    await ensure_schema()
    enabled_ids = {
        str(item or "").strip()
        for item in (student_ids if isinstance(student_ids, list) else [])
        if str(item or "").strip()
    }

    async with connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT id FROM public.smg_students WHERE COALESCE(status,'active')='active'"
                )
                active_ids = [str(r[0]) for r in await cur.fetchall()]
                selected = {item for item in enabled_ids if item in set(active_ids)}

                for student_id in active_ids:
                    enabled = student_id in selected
                    await cur.execute(
                        """
                        INSERT INTO public.smg_whatsapp_recipients
                          (student_id,enabled,consent_at,opt_out_at,consent_source,updated_at)
                        VALUES (
                          %s,%s,
                          CASE WHEN %s THEN now() ELSE NULL END,
                          CASE WHEN %s THEN NULL ELSE now() END,
                          'admin-confirmed',now()
                        )
                        ON CONFLICT (student_id) DO UPDATE SET
                          enabled=EXCLUDED.enabled,
                          consent_at=CASE
                            WHEN EXCLUDED.enabled AND public.smg_whatsapp_recipients.enabled=false THEN now()
                            ELSE public.smg_whatsapp_recipients.consent_at
                          END,
                          opt_out_at=CASE
                            WHEN EXCLUDED.enabled THEN NULL
                            WHEN public.smg_whatsapp_recipients.enabled=true THEN now()
                            ELSE public.smg_whatsapp_recipients.opt_out_at
                          END,
                          consent_source='admin-confirmed',
                          updated_at=now()
                        """,
                        (student_id, enabled, enabled, enabled),
                    )
    return await list_recipients()


def reminder_key(payment_id: str = "", offset_days: int = 0, phone: str = "") -> str:
    raw = f"{payment_id}|{int(offset_days)}|{phone}"
    return hashlib.sha256(raw.encode()).hexdigest()


async def claim_message(entry: dict) -> bool:
    await ensure_schema()
    retry_seconds = int(WHATSAPP_RETRY_AFTER.total_seconds())
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO public.smg_whatsapp_message_log
                  (notification_key,payment_id,student_id,offset_days,recipient_last4,
                   guardian_name,student_name,amount,due_date,status,error,attempt_count,
                   created_at,updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::date,'claimed','',1,now(),now())
                ON CONFLICT (notification_key) DO UPDATE SET
                  status='claimed',
                  error='',
                  attempt_count=public.smg_whatsapp_message_log.attempt_count+1,
                  updated_at=now()
                WHERE public.smg_whatsapp_message_log.status IN ('failed','claimed')
                  AND public.smg_whatsapp_message_log.attempt_count < %s
                  AND public.smg_whatsapp_message_log.updated_at
                      <= now() - (%s * interval '1 second')
                RETURNING notification_key
                """,
                (
                    str(entry.get("notificationKey") or ""),
                    str(entry.get("paymentId") or ""),
                    str(entry.get("studentId") or ""),
                    int(entry.get("offsetDays") or 0),
                    str(entry.get("phone") or "")[-4:],
                    str(entry.get("guardianName") or "")[:160],
                    str(entry.get("studentName") or "")[:160],
                    Decimal(str(entry.get("amount") or 0)),
                    entry.get("dueDate") or None,
                    WHATSAPP_MAX_ATTEMPTS,
                    retry_seconds,
                ),
            )
            return (await cur.fetchone()) is not None


async def finish_message(notification_key: str, result: dict) -> None:
    await ensure_schema()
    status = result.get("status") if result.get("status") in {"accepted", "failed"} else "failed"
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE public.smg_whatsapp_message_log
                SET meta_message_id=%s,
                    status=%s,
                    error=%s,
                    sent_at=CASE WHEN %s='accepted' THEN now() ELSE sent_at END,
                    updated_at=now()
                WHERE notification_key=%s
                """,
                (
                    str(result.get("messageId") or "")[:300],
                    status,
                    str(result.get("error") or "")[:1200],
                    status,
                    str(notification_key or ""),
                ),
            )


async def update_delivery_status(message_id: str, status: str, details: dict) -> None:
    await ensure_schema()
    normalized = status if status in {"sent", "delivered", "read", "failed"} else "accepted"
    try:
        stamp = datetime.fromtimestamp(int(details.get("timestamp")) if details.get("timestamp") else datetime.now().timestamp(), tz=timezone.utc)
    except Exception:
        stamp = datetime.now(timezone.utc)

    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE public.smg_whatsapp_message_log
                SET status=%s,
                    error=CASE WHEN %s='failed' THEN %s ELSE error END,
                    sent_at=CASE WHEN %s='sent' THEN COALESCE(sent_at,%s) ELSE sent_at END,
                    delivered_at=CASE WHEN %s='delivered' THEN COALESCE(delivered_at,%s) ELSE delivered_at END,
                    read_at=CASE WHEN %s='read' THEN COALESCE(read_at,%s) ELSE read_at END,
                    updated_at=now()
                WHERE meta_message_id=%s
                """,
                (
                    normalized,
                    normalized,
                    str(details.get("error") or "")[:1200],
                    normalized,
                    stamp,
                    normalized,
                    stamp,
                    normalized,
                    stamp,
                    str(message_id or ""),
                ),
            )


async def list_history(limit: int = 50) -> list[dict]:
    await ensure_schema()
    safe_limit = max(1, min(200, int(limit or 50)))
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT notification_key,payment_id,student_id,offset_days,recipient_last4,
                       guardian_name,student_name,amount,due_date::text,meta_message_id,
                       status,error,attempt_count,sent_at,delivered_at,read_at,created_at,updated_at
                FROM public.smg_whatsapp_message_log
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (safe_limit,),
            )
            rows = await cur.fetchall()

    return [
        {
            "notificationKey": str(r[0]),
            "paymentId": str(r[1] or ""),
            "studentId": str(r[2] or ""),
            "offsetDays": int(r[3] or 0),
            "recipient": f"final {r[4]}" if r[4] else "",
            "guardianName": str(r[5] or ""),
            "studentName": str(r[6] or ""),
            "amount": float(r[7] or 0),
            "dueDate": str(r[8] or ""),
            "messageId": str(r[9] or ""),
            "status": str(r[10] or ""),
            "error": str(r[11] or ""),
            "attemptCount": int(r[12] or 0),
            "sentAt": iso_value(r[13]),
            "deliveredAt": iso_value(r[14]),
            "readAt": iso_value(r[15]),
            "createdAt": iso_value(r[16]),
            "updatedAt": iso_value(r[17]),
        }
        for r in rows
    ]


async def opt_out_students_by_phone(phone: str, received_at: str | None = None) -> int:
    await ensure_schema()
    normalized = normalize_brazil_phone(phone)
    if not normalized:
        return 0

    async with connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT s.id,s.data
                    FROM public.smg_students s
                    JOIN public.smg_whatsapp_recipients r
                      ON r.student_id=s.id AND r.enabled=true
                    WHERE COALESCE(s.status,'active')='active'
                    """
                )
                rows = await cur.fetchall()
                ids = [
                    str(row[0])
                    for row in rows
                    if normalize_brazil_phone(as_dict(row[1]).get("phone")) == normalized
                ]
                if not ids:
                    return 0
                await cur.execute(
                    """
                    UPDATE public.smg_whatsapp_recipients
                    SET enabled=false,opt_out_at=%s,consent_source='whatsapp-stop',updated_at=now()
                    WHERE student_id = ANY(%s::text[])
                    RETURNING student_id
                    """,
                    (received_at or iso_now(), ids),
                )
                return len(await cur.fetchall())


def provider_status() -> dict:
    value = whatsapp_provider_config()
    return {
        "readyToSend": bool(value["accessToken"] and value["phoneNumberId"] and value["templateName"]),
        "accessTokenConfigured": bool(value["accessToken"]),
        "phoneNumberConfigured": bool(value["phoneNumberId"]),
        "templateName": value["templateName"],
        "templateLanguage": value["templateLanguage"],
        "graphVersion": value["graphVersion"],
        "webhookReady": bool(value["appSecret"] and value["webhookVerifyToken"]),
    }


def webhook_signature_valid(raw: bytes, signature: str = "") -> bool:
    secret = whatsapp_provider_config()["appSecret"]
    if not secret or not str(signature).startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, str(signature))


async def send_template_message(
    *,
    to: str,
    guardian_name: str,
    student_name: str,
    amount: str,
    due_date: str,
    timing: str,
) -> dict:
    provider = whatsapp_provider_config()
    if not provider["accessToken"] or not provider["phoneNumberId"]:
        raise RuntimeError("Credenciais do WhatsApp ainda não configuradas.")

    url = (
        f"https://graph.facebook.com/{provider['graphVersion']}/"
        f"{provider['phoneNumberId']}/messages"
    )
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "template",
        "template": {
            "name": provider["templateName"],
            "language": {"code": provider["templateLanguage"]},
            "components": [
                {
                    "type": "body",
                    "parameters": [
                        {"type": "text", "text": str(v or "-")}
                        for v in (guardian_name, student_name, amount, due_date, timing)
                    ],
                }
            ],
        },
    }

    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {provider['accessToken']}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
    try:
        data = response.json()
    except Exception:
        data = {}

    if not response.is_success or data.get("error"):
        error = as_dict(data.get("error"))
        parts = [
            error.get("message"),
            error.get("error_user_msg"),
            f"código {error.get('code')}" if error.get("code") else "",
            f"HTTP {response.status_code}" if response.status_code else "",
        ]
        raise RuntimeError(" · ".join(str(p) for p in parts if p)[:1200] or "A Meta não aceitou a mensagem.")

    message_id = str((data.get("messages") or [{}])[0].get("id") or "")
    if not message_id:
        raise RuntimeError("A Meta aceitou a solicitação, mas não retornou o identificador da mensagem.")
    return {"messageId": message_id}
