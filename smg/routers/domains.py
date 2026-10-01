from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ..audit import record_audit
from ..auth import OWNER_ADMIN_ROLES, require_role
from ..backups import create_backup, get_backup, list_backups
from ..domains import RESOURCE_TYPES, delete_record, get_record, list_records, save_record
from ..security import sync_authorized
from ..state import SyncConflictError, fetch_critical_state, get_sync_revision, sync_critical_state

router = APIRouter(prefix="/api")


class RecordPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str | None = None
    expected_version: int | None = Field(default=None, alias="expectedVersion", ge=1)


async def authorize(request: Request) -> None:
    if not await sync_authorized(request, {}):
        raise HTTPException(status_code=401, detail="Autenticação obrigatória.")


async def authorize_backup_admin(request: Request) -> dict:
    session = await require_role(request, OWNER_ADMIN_ROLES)
    if not session:
        raise HTTPException(status_code=403, detail="Permissão insuficiente.")
    return session


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
    await authorize_backup_admin(request)
    return {"ok": True, "items": await list_backups(limit)}


@router.get("/backups/{backup_id}")
async def backup(request: Request, backup_id: str):
    await authorize_backup_admin(request)
    item = await get_backup(backup_id)
    if not item:
        raise HTTPException(status_code=404, detail="Backup não encontrado.")
    return {"ok": True, **item}


@router.post("/backups")
async def backup_create(request: Request):
    session = await authorize_backup_admin(request)
    body = await request.json()
    snapshot = body.get("snapshot") if isinstance(body, dict) else None
    if not isinstance(snapshot, dict):
        raise HTTPException(status_code=400, detail="Conteúdo do backup inválido.")
    return {
        "ok": True,
        **await create_backup(
            snapshot,
            str(body.get("reason") or "manual"),
            str(session.get("sub") or body.get("createdBy") or ""),
        ),
    }


@router.post("/backups/{backup_id}/restore")
async def backup_restore(request: Request, backup_id: str):
    session = await authorize_backup_admin(request)
    body = await request.json()
    if not isinstance(body, dict) or str(body.get("confirm") or "") != "RESTAURAR":
        raise HTTPException(status_code=400, detail='Confirmação obrigatória: envie confirm="RESTAURAR".')
    item = await get_backup(backup_id)
    if not item:
        raise HTTPException(status_code=404, detail="Backup não encontrado.")

    current = await fetch_critical_state()
    revision = await get_sync_revision()
    try:
        result = await sync_critical_state(
            {
                "state": item["snapshot"],
                "deleted": {},
                "clientId": "backup-restore",
                "source": "backup-restore",
                "expectedRevision": revision,
                "destructive": True,
                "replaceAll": True,
                "backupSnapshot": current,
                "backupReason": "pre-restore",
                "backupActor": str(session.get("sub") or ""),
            }
        )
    except SyncConflictError as exc:
        raise HTTPException(status_code=409, detail="O estado mudou durante a restauração. Atualize e tente novamente.") from exc

    await record_audit(
        request,
        "backup",
        "restore",
        entity_id=backup_id,
        details={"restoredRevision": result["revision"]},
    )
    return {"ok": True, "backupId": backup_id, "revision": result["revision"], "updatedAt": result["updatedAt"]}
