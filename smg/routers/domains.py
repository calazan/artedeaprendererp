from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ..audit import record_audit
from ..auth import ADMIN_ROLES, authorized_identity
from ..backups import backup_exclusions_report, create_backup, get_backup, list_backups
from ..domains import RESOURCE_TYPES, delete_record, get_record, list_records, save_record
from ..security import sanitize_incoming_state, sync_authorized
from ..state import fetch_critical_state, fetch_sync_tombstones, get_sync_revision, sync_critical_state
from ..sync_merge import LIST_RESOURCES, core_deletions
from ..utils import as_dict, as_list

router = APIRouter(prefix="/api")
MAX_BACKUP_BODY_BYTES = 3 * 1024 * 1024
RESTORE_CONFIRMATION = "RESTORE"


class RecordPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str | None = None
    expected_version: int | None = Field(default=None, alias="expectedVersion", ge=1)


class RestorePayload(BaseModel):
    confirm: str


async def authorize(request: Request) -> None:
    if not await sync_authorized(request, {}):
        raise HTTPException(status_code=401, detail="Sessão ou chave de sincronização inválida.")


async def authorize_admin(request: Request) -> dict:
    identity = await authorized_identity(request, ADMIN_ROLES)
    if not identity:
        raise HTTPException(status_code=401, detail="Sessão administrativa ativa obrigatória.")
    return identity


async def read_json_limited(request: Request, *, max_bytes: int = MAX_BACKUP_BODY_BYTES) -> dict:
    raw = await request.body()
    if len(raw) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail="O backup enviado é grande demais para esta rota. Limite: 3 MB.",
        )
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
    except Exception as exc:
        raise HTTPException(status_code=400, detail="JSON de backup inválido.") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="Conteúdo do backup inválido.")
    return value


def _index_by_id(value) -> dict[str, dict]:
    return {
        str(item.get("id") or ""): item
        for item in as_list(value)
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }


def restore_tombstone_plan(current: dict, restored: dict, client_id: str) -> tuple[list[dict], list[dict]]:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    tombstones: list[dict] = []
    clear_tombstones: list[dict] = []
    for resource in LIST_RESOURCES:
        current_index = _index_by_id(current.get(resource))
        restored_index = _index_by_id(restored.get(resource))
        for record_id in sorted(current_index.keys() - restored_index.keys()):
            tombstones.append(
                {
                    "resource": resource,
                    "id": record_id,
                    "deletedAt": now,
                    "baseUpdatedAt": str(as_dict(current_index[record_id]).get("updatedAt") or ""),
                    "clientId": client_id,
                }
            )
        for record_id in sorted(restored_index):
            clear_tombstones.append({"resource": resource, "id": record_id})
    return tombstones, clear_tombstones


@router.get("/modules")
async def modules(request: Request):
    await authorize(request)
    return {"ok": True, "modules": sorted(RESOURCE_TYPES)}


@router.get("/erp/{resource}")
async def records(
    request: Request,
    resource: str,
    include_deleted: bool = False,
    limit: int = Query(1000, ge=1, le=5000),
):
    await authorize(request)
    return {
        "ok": True,
        "resource": resource,
        "items": await list_records(resource, include_deleted=include_deleted, limit=limit),
    }


@router.get("/erp/{resource}/{record_id}")
async def record(request: Request, resource: str, record_id: str):
    await authorize(request)
    item = await get_record(resource, record_id)
    if not item:
        raise HTTPException(status_code=404, detail="Registro não encontrado.")
    return {"ok": True, "item": item}


@router.post("/erp/{resource}")
async def upsert(request: Request, resource: str, payload: RecordPayload):
    await authorize(request)
    values = payload.model_dump(by_alias=False, exclude_none=True)
    expected = values.pop("expected_version", None)
    values.update(payload.model_extra or {})
    return {
        "ok": True,
        "item": await save_record(resource, values, expected_version=expected),
    }


@router.delete("/erp/{resource}/{record_id}")
async def remove(
    request: Request,
    resource: str,
    record_id: str,
    expected_version: int | None = Query(None, ge=1),
):
    await authorize(request)
    removed = await delete_record(resource, record_id, expected_version=expected_version)
    if not removed:
        raise HTTPException(status_code=409, detail="Registro ausente ou alterado em outro dispositivo.")
    return {"ok": True, "deletedId": record_id}


@router.get("/backups")
async def backups(request: Request, limit: int = Query(50, ge=1, le=200)):
    await authorize(request)
    return {
        "ok": True,
        "items": await list_backups(limit),
        "exclusions": await backup_exclusions_report(),
    }


@router.get("/backups/{backup_id}")
async def backup(request: Request, backup_id: str):
    await authorize(request)
    item = await get_backup(backup_id)
    if not item:
        raise HTTPException(status_code=404, detail="Backup não encontrado.")
    return {
        "ok": True,
        **item,
        "exclusions": await backup_exclusions_report(),
    }


@router.post("/backups")
async def backup_create(request: Request):
    await authorize(request)
    body = await read_json_limited(request)
    snapshot = body.get("snapshot")
    if not isinstance(snapshot, dict):
        raise HTTPException(status_code=400, detail="Conteúdo do backup inválido.")
    created = await create_backup(
        sanitize_incoming_state(snapshot),
        str(body.get("reason") or "manual"),
        str(body.get("createdBy") or ""),
    )
    return {
        "ok": True,
        **created,
        "exclusions": await backup_exclusions_report(),
    }


@router.post("/backups/{backup_id}/restore")
async def backup_restore(request: Request, backup_id: str, payload: RestorePayload):
    identity = await authorize_admin(request)
    if payload.confirm != RESTORE_CONFIRMATION:
        raise HTTPException(
            status_code=400,
            detail='Confirmação obrigatória: envie {"confirm":"RESTORE"}.',
        )

    item = await get_backup(backup_id)
    if not item or not isinstance(item.get("snapshot"), dict):
        raise HTTPException(status_code=404, detail="Backup não encontrado.")

    current = await fetch_critical_state()
    restored = sanitize_incoming_state(as_dict(item["snapshot"]))
    required = {
        "students",
        "activityCatalog",
        "extraEvents",
        "extraParticipants",
        "payments",
        "attendance",
    }
    missing = sorted(key for key in required if key not in restored)
    if missing:
        raise HTTPException(
            status_code=409,
            detail="Backup incompleto para restauração integral: " + ", ".join(missing),
        )

    safety = await create_backup(
        current,
        reason=f"pre-restore:{backup_id}"[:80],
        created_by=identity["userId"],
    )

    revision = await get_sync_revision()
    next_revision = revision + 1
    deleted = core_deletions(current, restored)
    tombstones, clear_tombstones = restore_tombstone_plan(
        current,
        restored,
        identity["userId"],
    )
    for entry in tombstones:
        entry["revision"] = next_revision

    await sync_critical_state(
        {
            "state": restored,
            "deleted": deleted,
            "clientId": identity["userId"],
            "source": f"backup-restore:{backup_id}",
            "syncRevision": next_revision,
            "tombstones": tombstones,
            "clearTombstones": clear_tombstones,
            "forceRestore": True,
        }
    )
    await record_audit(
        request,
        "backup",
        "restore",
        entity_id=backup_id,
        details={
            "safetyBackupId": safety["id"],
            "revision": next_revision,
            "employeeDocumentsRestored": False,
        },
    )

    return {
        "ok": True,
        "restoredBackupId": backup_id,
        "safetyBackupId": safety["id"],
        "revision": next_revision,
        "exclusions": await backup_exclusions_report(),
    }
