from __future__ import annotations

import copy
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from .db import connection
from .utils import as_dict, as_list, iso_now


LIST_RESOURCES = (
    "students",
    "activityCatalog",
    "extraEvents",
    "extraParticipants",
    "payments",
    "otherIncomes",
    "expenses",
    "proposals",
    "expenseCategories",
    "agendaEvents",
    "bankAccounts",
    "bankMovements",
    "paymentExclusions",
)

OBJECT_RESOURCES = ("rentalManagement", "settings")
CORE_DELETE_RESOURCES = (
    "students",
    "activityCatalog",
    "extraEvents",
    "extraParticipants",
    "payments",
)

IGNORED_COMPARE_FIELDS = {"updatedAt"}
SYNC_LOCK_KEY = 417283901


def _clean_dict(value: Any) -> dict:
    return copy.deepcopy(as_dict(value))


def _business_keys(*values: dict) -> set[str]:
    keys: set[str] = set()
    for value in values:
        for key in value:
            if key in IGNORED_COMPARE_FIELDS or str(key).startswith("_"):
                continue
            keys.add(str(key))
    return keys


def _value_at(value: dict, key: str):
    return value[key] if key in value else _MISSING


class _Missing:
    pass


_MISSING = _Missing()


def changed_fields(base: dict, other: dict) -> set[str]:
    base = as_dict(base)
    other = as_dict(other)
    return {
        key
        for key in _business_keys(base, other)
        if _value_at(base, key) != _value_at(other, key)
    }


def business_equal(first: dict, second: dict) -> bool:
    return not changed_fields(as_dict(first), as_dict(second))


def merge_item(base: dict, local: dict, remote: dict, *, now: str | None = None) -> tuple[dict, list[str]]:
    base = _clean_dict(base)
    local = _clean_dict(local)
    remote = _clean_dict(remote)

    local_changed = changed_fields(base, local)
    remote_changed = changed_fields(base, remote)
    conflicts = sorted(
        key
        for key in local_changed & remote_changed
        if _value_at(local, key) != _value_at(remote, key)
    )
    if conflicts:
        return remote, conflicts

    merged = copy.deepcopy(remote)
    for key in local_changed:
        if key in local:
            merged[key] = copy.deepcopy(local[key])
        else:
            merged.pop(key, None)

    if local.get("id"):
        merged["id"] = str(local["id"])
    elif remote.get("id"):
        merged["id"] = str(remote["id"])

    if not business_equal(remote, merged):
        merged["updatedAt"] = str(now or iso_now())
    elif remote.get("updatedAt"):
        merged["updatedAt"] = str(remote.get("updatedAt"))
    elif local.get("updatedAt"):
        merged["updatedAt"] = str(local.get("updatedAt"))
    return merged, []


def merge_attendance(remote: dict, incoming: dict) -> dict:
    result = copy.deepcopy(as_dict(remote))
    for day, records in as_dict(incoming).items():
        target = result.setdefault(str(day), {})
        for student_id, raw in as_dict(records).items():
            record = as_dict(raw)
            current = as_dict(target.get(str(student_id)))
            if not current:
                target[str(student_id)] = copy.deepcopy(record)
                continue
            current_ts = parse_timestamp(current.get("updatedAt"))
            incoming_ts = parse_timestamp(record.get("updatedAt"))
            if incoming_ts >= current_ts:
                target[str(student_id)] = copy.deepcopy(record)
    return result


def parse_timestamp(value: Any) -> datetime:
    raw = str(value or "1970-01-01T00:00:00Z").strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return datetime(1970, 1, 1, tzinfo=timezone.utc)


def _index(items: Any) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for item in as_list(items):
        if isinstance(item, dict) and str(item.get("id") or "").strip():
            result[str(item["id"])] = copy.deepcopy(item)
    return result


def _list_from_index(index: dict[str, dict]) -> list[dict]:
    return list(index.values())


def _conflict(resource: str, record_id: str, fields: list[str], reason: str) -> dict:
    return {
        "resource": resource,
        "id": record_id,
        "fields": fields,
        "reason": reason,
    }


def apply_protocol_changes(
    current: dict,
    changes: dict,
    tombstones: dict,
    *,
    base_revision: int,
    attendance: dict | None = None,
    now: str | None = None,
    client_id: str = "",
) -> dict:
    now = str(now or iso_now())
    merged = copy.deepcopy(as_dict(current))
    conflicts: list[dict] = []
    tombstone_writes: list[dict] = []
    clear_tombstones: list[dict] = []
    changed = False

    for resource in LIST_RESOURCES:
        remote_index = _index(merged.get(resource))
        resource_changes = as_dict(as_dict(changes).get(resource))
        resource_tombstones = as_dict(as_dict(tombstones).get(resource))

        upserts = [
            item for item in as_list(resource_changes.get("upserts"))
            if isinstance(item, dict)
        ]
        deletes = [
            item for item in as_list(resource_changes.get("tombstones"))
            if isinstance(item, dict)
        ]

        seen_delete_ids = {str(item.get("id") or "") for item in deletes}
        seen_upsert_ids = {str(item.get("id") or "") for item in upserts}
        for record_id in sorted((seen_delete_ids & seen_upsert_ids) - {""}):
            conflicts.append(_conflict(resource, record_id, ["id"], "upsert-and-delete"))
        if conflicts:
            continue

        for change in upserts:
            record_id = str(change.get("id") or as_dict(change.get("value")).get("id") or "").strip()
            if not record_id:
                continue
            base = _clean_dict(change.get("base"))
            local = _clean_dict(change.get("value"))
            local["id"] = record_id
            remote = _clean_dict(remote_index.get(record_id))
            deleted_meta = as_dict(resource_tombstones.get(record_id))

            if deleted_meta and not remote:
                tombstone_revision = int(deleted_meta.get("revision") or 0)
                if base and tombstone_revision > int(base_revision or 0):
                    conflicts.append(_conflict(resource, record_id, ["__deleted__"], "delete-vs-edit"))
                    continue
                clear_tombstones.append({"resource": resource, "id": record_id})

            if base and not remote and not deleted_meta:
                conflicts.append(_conflict(resource, record_id, ["__deleted__"], "missing-remote"))
                continue

            candidate, fields = merge_item(base, local, remote, now=now)
            if fields:
                conflicts.append(_conflict(resource, record_id, fields, "field-conflict"))
                continue
            if not business_equal(remote, candidate):
                changed = True
            remote_index[record_id] = candidate

        for deletion in deletes:
            record_id = str(deletion.get("id") or "").strip()
            if not record_id:
                continue
            base = _clean_dict(deletion.get("base"))
            remote = _clean_dict(remote_index.get(record_id))
            existing_tombstone = as_dict(resource_tombstones.get(record_id))

            if remote:
                remote_changed = changed_fields(base, remote)
                if remote_changed:
                    conflicts.append(
                        _conflict(resource, record_id, sorted(remote_changed), "edit-vs-delete")
                    )
                    continue
                remote_index.pop(record_id, None)
                changed = True
            elif existing_tombstone:
                # Reenvio idempotente: a exclusão já foi confirmada numa revisão
                # anterior e não precisa gerar outro tombstone nem nova revisão.
                continue

            tombstone_writes.append(
                {
                    "resource": resource,
                    "id": record_id,
                    "deletedAt": now,
                    "baseUpdatedAt": str(
                        deletion.get("baseUpdatedAt")
                        or base.get("updatedAt")
                        or remote.get("updatedAt")
                        or ""
                    ),
                    "clientId": client_id,
                    "existingRevision": int(existing_tombstone.get("revision") or 0),
                }
            )

        merged[resource] = _list_from_index(remote_index)

    for resource in OBJECT_RESOURCES:
        resource_changes = as_dict(as_dict(changes).get(resource))
        upserts = [
            item for item in as_list(resource_changes.get("upserts"))
            if isinstance(item, dict)
        ]
        if not upserts:
            continue
        change = upserts[-1]
        base = _clean_dict(change.get("base"))
        local = _clean_dict(change.get("value"))
        remote = _clean_dict(merged.get(resource))
        candidate, fields = merge_item(base, local, remote, now=now)
        candidate.pop("id", None)
        if fields:
            conflicts.append(_conflict(resource, "default", fields, "field-conflict"))
            continue
        if not business_equal(remote, candidate):
            changed = True
        merged[resource] = candidate

    if attendance is not None:
        next_attendance = merge_attendance(as_dict(merged.get("attendance")), as_dict(attendance))
        if next_attendance != as_dict(merged.get("attendance")):
            changed = True
        merged["attendance"] = next_attendance

    return {
        "state": merged,
        "conflicts": conflicts,
        "tombstones": tombstone_writes,
        "clearTombstones": clear_tombstones,
        "changed": changed or bool(tombstone_writes) or bool(clear_tombstones),
    }


def core_deletions(current: dict, merged: dict) -> dict:
    result: dict[str, list[str]] = {}
    for resource in CORE_DELETE_RESOURCES:
        current_ids = set(_index(current.get(resource)))
        next_ids = set(_index(merged.get(resource)))
        result[resource] = sorted(current_ids - next_ids)
    return result


def legacy_tombstone_conflicts(incoming: dict, current: dict, tombstones: dict) -> list[dict]:
    conflicts: list[dict] = []
    for resource in LIST_RESOURCES:
        current_ids = set(_index(current.get(resource)))
        incoming_ids = set(_index(incoming.get(resource)))
        for record_id in sorted(incoming_ids - current_ids):
            if as_dict(as_dict(tombstones).get(resource)).get(record_id):
                conflicts.append(
                    _conflict(resource, record_id, ["__deleted__"], "tombstone-resurrection")
                )
    return conflicts


@asynccontextmanager
async def sync_advisory_lock():
    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT pg_advisory_lock(%s)", (SYNC_LOCK_KEY,))
        try:
            yield
        finally:
            async with conn.cursor() as cur:
                await cur.execute("SELECT pg_advisory_unlock(%s)", (SYNC_LOCK_KEY,))
