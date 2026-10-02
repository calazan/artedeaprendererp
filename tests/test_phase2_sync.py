from __future__ import annotations

import asyncio
import copy
import os

import pytest
from psycopg import AsyncConnection

import smg.state as state
from smg import db
from smg.sync_merge import apply_protocol_changes, core_deletions


def _database_url() -> str:
    value = str(os.getenv("TEST_DATABASE_URL") or "").strip()
    if not value:
        pytest.skip("TEST_DATABASE_URL não configurada.")
    return value


async def _prepare(monkeypatch) -> str:
    url = _database_url()
    monkeypatch.setenv("DATABASE_URL", url)
    await db.close_pool()
    state._schema_ready = False
    await state.ensure_core_schema()
    return url


async def _sql(url: str, statement: str, params=None):
    conn = await AsyncConnection.connect(url, autocommit=True)
    try:
        async with conn.cursor() as cur:
            await cur.execute(statement, params)
    finally:
        await conn.close()


async def _persist_plan(plan: dict, client_id: str) -> tuple[int, dict]:
    current = await state.fetch_critical_state()
    revision = await state.get_sync_revision()
    next_revision = revision + 1
    for entry in plan["tombstones"]:
        entry["revision"] = next_revision
    await state.sync_critical_state(
        {
            "state": plan["state"],
            "deleted": core_deletions(current, plan["state"]),
            "clientId": client_id,
            "source": "phase2-test",
            "syncRevision": next_revision,
            "tombstones": plan["tombstones"],
            "clearTombstones": plan["clearTombstones"],
        }
    )
    return next_revision, await state.fetch_critical_state()


async def _seed_student(student: dict) -> tuple[int, dict]:
    current = await state.fetch_critical_state()
    next_state = copy.deepcopy(current)
    next_state["students"] = [
        item for item in next_state.get("students", [])
        if item.get("id") != student["id"]
    ] + [student]
    revision = await state.get_sync_revision() + 1
    await state.sync_critical_state(
        {
            "state": next_state,
            "deleted": {},
            "clientId": "phase2-seed",
            "source": "phase2-test",
            "syncRevision": revision,
            "clearTombstones": [{"resource": "students", "id": student["id"]}],
        }
    )
    return revision, await state.fetch_critical_state()


def _find(items: list[dict], record_id: str) -> dict | None:
    return next((item for item in items if item.get("id") == record_id), None)


def test_two_clients_edit_different_fields_without_data_loss(monkeypatch):
    async def scenario():
        url = await _prepare(monkeypatch)
        student_id = "phase2-student-different-fields"
        try:
            base_revision, base_state = await _seed_student(
                {
                    "id": student_id,
                    "name": "Ana",
                    "phone": "1111",
                    "guardian": "Maria",
                }
            )
            base_item = _find(base_state["students"], student_id)
            assert base_item

            current = await state.fetch_critical_state()
            plan_a = apply_protocol_changes(
                current,
                {
                    "students": {
                        "upserts": [
                            {
                                "id": student_id,
                                "base": base_item,
                                "value": {**base_item, "phone": "2222"},
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=base_revision,
                client_id="client-a",
            )
            assert not plan_a["conflicts"]
            _, after_a = await _persist_plan(plan_a, "client-a")

            plan_b = apply_protocol_changes(
                after_a,
                {
                    "students": {
                        "upserts": [
                            {
                                "id": student_id,
                                "base": base_item,
                                "value": {**base_item, "guardian": "João"},
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=base_revision,
                client_id="client-b",
            )
            assert not plan_b["conflicts"]
            _, final_state = await _persist_plan(plan_b, "client-b")
            item = _find(final_state["students"], student_id)
            assert item["phone"] == "2222"
            assert item["guardian"] == "João"
            assert item["name"] == "Ana"
        finally:
            await _sql(url, "DELETE FROM public.smg_students WHERE id=%s", (student_id,))
            await _sql(
                url,
                "DELETE FROM public.smg_sync_tombstones WHERE resource_type='students' AND record_id=%s",
                (student_id,),
            )
            await db.close_pool()
            state._schema_ready = False

    asyncio.run(scenario())


def test_two_clients_add_different_expenses_and_both_survive(monkeypatch):
    async def scenario():
        url = await _prepare(monkeypatch)
        e1 = "phase2-expense-a"
        e2 = "phase2-expense-b"
        initial = await state.fetch_critical_state()
        base_revision = await state.get_sync_revision()
        initial_expenses = [
            item for item in initial.get("expenses", [])
            if item.get("id") not in {e1, e2}
        ]
        initial["expenses"] = initial_expenses
        await state.sync_critical_state(
            {
                "state": initial,
                "deleted": {},
                "clientId": "phase2-expense-reset",
                "source": "phase2-test",
                "syncRevision": base_revision + 1,
            }
        )
        base_revision = await state.get_sync_revision()
        base = await state.fetch_critical_state()
        try:
            plan_a = apply_protocol_changes(
                base,
                {
                    "expenses": {
                        "upserts": [
                            {
                                "id": e1,
                                "base": {},
                                "value": {"id": e1, "description": "Material A", "amount": 10},
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=base_revision,
                client_id="client-a",
            )
            _, after_a = await _persist_plan(plan_a, "client-a")

            plan_b = apply_protocol_changes(
                after_a,
                {
                    "expenses": {
                        "upserts": [
                            {
                                "id": e2,
                                "base": {},
                                "value": {"id": e2, "description": "Material B", "amount": 20},
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=base_revision,
                client_id="client-b",
            )
            assert not plan_b["conflicts"]
            _, final_state = await _persist_plan(plan_b, "client-b")
            ids = {item.get("id") for item in final_state.get("expenses", [])}
            assert e1 in ids
            assert e2 in ids
        finally:
            restored = await state.fetch_critical_state()
            restored["expenses"] = [
                item for item in restored.get("expenses", [])
                if item.get("id") not in {e1, e2}
            ]
            await state.sync_critical_state(
                {
                    "state": restored,
                    "deleted": {},
                    "clientId": "phase2-expense-cleanup",
                    "source": "phase2-test",
                    "syncRevision": await state.get_sync_revision() + 1,
                }
            )
            await _sql(
                url,
                "DELETE FROM public.smg_sync_tombstones WHERE resource_type='expenses' AND record_id = ANY(%s::text[])",
                ([e1, e2],),
            )
            await db.close_pool()
            state._schema_ready = False

    asyncio.run(scenario())


def test_delete_then_stale_edit_conflicts_and_rebased_edit_survives(monkeypatch):
    async def scenario():
        url = await _prepare(monkeypatch)
        student_id = "phase2-student-delete-edit"
        try:
            base_revision, base_state = await _seed_student(
                {"id": student_id, "name": "Carlos", "phone": "1111"}
            )
            base_item = _find(base_state["students"], student_id)
            assert base_item

            delete_plan = apply_protocol_changes(
                base_state,
                {
                    "students": {
                        "tombstones": [
                            {
                                "id": student_id,
                                "base": base_item,
                                "baseUpdatedAt": base_item.get("updatedAt", ""),
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=base_revision,
                client_id="client-a",
            )
            delete_revision, deleted_state = await _persist_plan(delete_plan, "client-a")
            assert _find(deleted_state["students"], student_id) is None

            stale_edit = apply_protocol_changes(
                deleted_state,
                {
                    "students": {
                        "upserts": [
                            {
                                "id": student_id,
                                "base": base_item,
                                "value": {**base_item, "phone": "9999"},
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=base_revision,
                client_id="client-b",
            )
            assert stale_edit["conflicts"]
            assert stale_edit["conflicts"][0]["reason"] == "delete-vs-edit"

            rebased_edit = apply_protocol_changes(
                deleted_state,
                {
                    "students": {
                        "upserts": [
                            {
                                "id": student_id,
                                "base": {},
                                "value": {**base_item, "phone": "9999"},
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=delete_revision,
                client_id="client-b",
            )
            assert not rebased_edit["conflicts"]
            _, final_state = await _persist_plan(rebased_edit, "client-b")
            item = _find(final_state["students"], student_id)
            assert item
            assert item["phone"] == "9999"
            tombstones = await state.fetch_sync_tombstones()
            assert student_id not in tombstones.get("students", {})
        finally:
            await _sql(url, "DELETE FROM public.smg_students WHERE id=%s", (student_id,))
            await _sql(
                url,
                "DELETE FROM public.smg_sync_tombstones WHERE resource_type='students' AND record_id=%s",
                (student_id,),
            )
            await db.close_pool()
            state._schema_ready = False

    asyncio.run(scenario())


def test_same_field_edit_returns_conflict(monkeypatch):
    async def scenario():
        url = await _prepare(monkeypatch)
        student_id = "phase2-student-same-field"
        try:
            base_revision, base_state = await _seed_student(
                {"id": student_id, "name": "Bia", "phone": "1111"}
            )
            base_item = _find(base_state["students"], student_id)

            plan_a = apply_protocol_changes(
                base_state,
                {
                    "students": {
                        "upserts": [
                            {
                                "id": student_id,
                                "base": base_item,
                                "value": {**base_item, "phone": "2222"},
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=base_revision,
                client_id="client-a",
            )
            _, after_a = await _persist_plan(plan_a, "client-a")

            plan_b = apply_protocol_changes(
                after_a,
                {
                    "students": {
                        "upserts": [
                            {
                                "id": student_id,
                                "base": base_item,
                                "value": {**base_item, "phone": "3333"},
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=base_revision,
                client_id="client-b",
            )
            assert plan_b["conflicts"]
            assert plan_b["conflicts"][0]["fields"] == ["phone"]
            assert plan_b["conflicts"][0]["reason"] == "field-conflict"
        finally:
            await _sql(url, "DELETE FROM public.smg_students WHERE id=%s", (student_id,))
            await _sql(
                url,
                "DELETE FROM public.smg_sync_tombstones WHERE resource_type='students' AND record_id=%s",
                (student_id,),
            )
            await db.close_pool()
            state._schema_ready = False

    asyncio.run(scenario())


def test_sync_revision_and_tombstone_are_persisted(monkeypatch):
    async def scenario():
        url = await _prepare(monkeypatch)
        student_id = "phase2-student-revision"
        try:
            base_revision, base_state = await _seed_student(
                {"id": student_id, "name": "Davi"}
            )
            base_item = _find(base_state["students"], student_id)
            plan = apply_protocol_changes(
                base_state,
                {
                    "students": {
                        "tombstones": [
                            {
                                "id": student_id,
                                "base": base_item,
                                "baseUpdatedAt": base_item.get("updatedAt", ""),
                            }
                        ]
                    }
                },
                await state.fetch_sync_tombstones(),
                base_revision=base_revision,
                client_id="client-revision",
            )
            next_revision, _ = await _persist_plan(plan, "client-revision")
            assert await state.get_sync_revision() == next_revision
            tombstone = (await state.fetch_sync_tombstones())["students"][student_id]
            assert tombstone["revision"] == next_revision
            assert tombstone["clientId"] == "client-revision"
        finally:
            await _sql(url, "DELETE FROM public.smg_students WHERE id=%s", (student_id,))
            await _sql(
                url,
                "DELETE FROM public.smg_sync_tombstones WHERE resource_type='students' AND record_id=%s",
                (student_id,),
            )
            await db.close_pool()
            state._schema_ready = False

    asyncio.run(scenario())
