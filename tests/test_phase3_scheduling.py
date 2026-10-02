from __future__ import annotations

import asyncio
import json
import os
from datetime import date, datetime, timezone
from pathlib import Path

import pytest
from psycopg import AsyncConnection
from starlette.requests import Request

import smg.state as state
import smg.whatsapp as whatsapp_store
from smg import db
from smg.routers import tasks as tasks_router
from smg.routers import whatsapp as whatsapp_router


ROOT = Path(__file__).resolve().parents[1]


def make_request(path: str, authorization: str = "") -> Request:
    headers = []
    if authorization:
        headers.append((b"authorization", authorization.encode("utf-8")))
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": headers,
            "server": ("erp.example", 443),
            "client": ("127.0.0.1", 1234),
        }
    )


def test_vercel_config_has_hobby_compatible_daily_crons():
    config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
    crons = {item["path"]: item["schedule"] for item in config.get("crons", [])}
    assert crons == {
        "/api/whatsapp-reminders?action=dispatch": "0 10 * * *",
        "/api/tasks?action=dispatch": "0 9 * * *",
    }
    for schedule in crons.values():
        minute, hour, day, month, weekday = schedule.split()
        assert minute.isdigit()
        assert hour.isdigit()
        assert (day, month, weekday) == ("*", "*", "*")


def test_active_supabase_migrations_no_longer_use_pg_net():
    active = list((ROOT / "supabase" / "migrations").glob("*.sql"))
    assert active
    assert all("net.http_post" not in path.read_text(encoding="utf-8") for path in active)

    legacy = ROOT / "supabase" / "legacy" / "20260825195000_python_worker_cutover.sql"
    assert legacy.exists()
    assert "LEGACY" in legacy.read_text(encoding="utf-8")


def test_cron_routes_accept_vercel_cron_secret(monkeypatch):
    secret = "cron-secret-" + ("x" * 40)
    monkeypatch.setenv("CRON_SECRET", secret)
    request = make_request("/api/tasks", f"Bearer {secret}")
    assert asyncio.run(tasks_router.cron_authorized(request)) is True

    whatsapp_request = make_request("/api/whatsapp-reminders", f"Bearer {secret}")
    assert whatsapp_router.cron_authorized(whatsapp_request) is True


def test_task_dispatch_window_catches_daily_cron_delay():
    now = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
    recent = {
        "id": "task-recent",
        "date": "2026-10-01",
        "time": "11:30",
        "timezone": "UTC",
        "recurrence": "none",
        "reminderMinutes": 0,
        "active": True,
    }
    too_old = {
        **recent,
        "id": "task-old",
        "time": "09:00",
    }
    assert tasks_router.due_candidate(recent, date(2026, 10, 1), now) is not None
    assert tasks_router.due_candidate(too_old, date(2026, 10, 1), now) is None


def _database_url() -> str:
    value = str(os.getenv("TEST_DATABASE_URL") or "").strip()
    if not value:
        pytest.skip("TEST_DATABASE_URL não configurada.")
    return value


async def _sql(url: str, statement: str, params=None, *, fetch: bool = False):
    conn = await AsyncConnection.connect(url, autocommit=True)
    try:
        async with conn.cursor() as cur:
            await cur.execute(statement, params)
            if fetch:
                return await cur.fetchall()
            return None
    finally:
        await conn.close()


def test_whatsapp_failed_and_stale_claims_retry_with_attempt_limit(monkeypatch):
    async def scenario():
        url = _database_url()
        monkeypatch.setenv("DATABASE_URL", url)
        await db.close_pool()
        state._schema_ready = False
        whatsapp_store._schema_ready = False
        key = "phase3-whatsapp-retry"
        entry = {
            "notificationKey": key,
            "paymentId": "phase3-payment",
            "studentId": "phase3-student",
            "offsetDays": 0,
            "phone": "5544999999999",
            "guardianName": "Responsável",
            "studentName": "Aluno",
            "amount": 100,
            "dueDate": "2026-10-02",
        }
        try:
            await whatsapp_store.ensure_schema()
            await _sql(
                url,
                "DELETE FROM public.smg_whatsapp_message_log WHERE notification_key=%s",
                (key,),
            )

            assert await whatsapp_store.claim_message(entry) is True
            assert await whatsapp_store.claim_message(entry) is False

            await _sql(
                url,
                """
                UPDATE public.smg_whatsapp_message_log
                SET status='failed',attempt_count=1,updated_at=now()-interval '11 minutes'
                WHERE notification_key=%s
                """,
                (key,),
            )
            assert await whatsapp_store.claim_message(entry) is True

            rows = await _sql(
                url,
                "SELECT status,attempt_count FROM public.smg_whatsapp_message_log WHERE notification_key=%s",
                (key,),
                fetch=True,
            )
            assert rows[0] == ("claimed", 2)

            await _sql(
                url,
                """
                UPDATE public.smg_whatsapp_message_log
                SET status='claimed',attempt_count=2,updated_at=now()-interval '11 minutes'
                WHERE notification_key=%s
                """,
                (key,),
            )
            assert await whatsapp_store.claim_message(entry) is True

            await _sql(
                url,
                """
                UPDATE public.smg_whatsapp_message_log
                SET status='failed',attempt_count=3,updated_at=now()-interval '11 minutes'
                WHERE notification_key=%s
                """,
                (key,),
            )
            assert await whatsapp_store.claim_message(entry) is False
        finally:
            await _sql(
                url,
                "DELETE FROM public.smg_whatsapp_message_log WHERE notification_key=%s",
                (key,),
            )
            await db.close_pool()
            state._schema_ready = False
            whatsapp_store._schema_ready = False

    asyncio.run(scenario())


def _fake_rows(count: int) -> list[dict]:
    return [
        {
            "paymentId": f"phase3-payment-{index}",
            "studentId": f"phase3-student-{index}",
            "payment": {},
            "student": {
                "phone": "44999999999",
                "guardian": "Responsável",
                "name": f"Aluno {index}",
            },
        }
        for index in range(count)
    ]


def _patch_dispatch_dependencies(monkeypatch, rows: list[dict], send):
    async def fake_config():
        return {"enabled": True, "offsets": [0], "timezone": "UTC"}

    async def fake_rows():
        return rows

    async def fake_claim(entry):
        return True

    async def fake_finish(key, result):
        return None

    monkeypatch.setattr(whatsapp_router, "get_config", fake_config)
    monkeypatch.setattr(whatsapp_router, "list_open_payment_rows", fake_rows)
    monkeypatch.setattr(whatsapp_router, "provider_status", lambda: {"readyToSend": True})
    monkeypatch.setattr(whatsapp_router, "iso_date_in_timezone", lambda *args, **kwargs: "2026-10-02")
    monkeypatch.setattr(whatsapp_router, "due_date_for_payment", lambda payment: "2026-10-02")
    monkeypatch.setattr(whatsapp_router, "days_until", lambda due, today: 0)
    monkeypatch.setattr(whatsapp_router, "outstanding_amount", lambda payment: 10.0)
    monkeypatch.setattr(whatsapp_router, "normalize_brazil_phone", lambda phone: "5544999999999")
    monkeypatch.setattr(whatsapp_router, "claim_message", fake_claim)
    monkeypatch.setattr(whatsapp_router, "finish_message", fake_finish)
    monkeypatch.setattr(whatsapp_router, "send_template_message", send)


def test_whatsapp_dispatch_uses_limited_concurrency(monkeypatch):
    active = 0
    peak = 0

    async def fake_send(**kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        return {"messageId": "wamid.phase3"}

    _patch_dispatch_dependencies(monkeypatch, _fake_rows(8), fake_send)
    result = asyncio.run(whatsapp_router.dispatch_reminders())

    assert result["sent"] == 8
    assert result["deferred"] == 0
    assert 2 <= peak <= whatsapp_router.MAX_CONCURRENT_SENDS


def test_whatsapp_dispatch_stops_cleanly_before_time_budget(monkeypatch):
    clock_calls = 0

    def fake_monotonic():
        nonlocal clock_calls
        clock_calls += 1
        # chamada 1: início; chamadas 2-5: primeiro lote; demais: sem margem.
        return 0.0 if clock_calls <= 5 else 40.0

    async def fake_send(**kwargs):
        await asyncio.sleep(0)
        return {"messageId": "wamid.phase3-budget"}

    _patch_dispatch_dependencies(monkeypatch, _fake_rows(8), fake_send)
    monkeypatch.setattr(whatsapp_router, "monotonic", fake_monotonic)

    result = asyncio.run(whatsapp_router.dispatch_reminders())

    assert result["sent"] == 4
    assert result["deferred"] == 4
    assert result["limited"] is True
