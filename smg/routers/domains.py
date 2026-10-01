from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from ..backups import create_backup, get_backup, list_backups
from ..domains import RESOURCE_TYPES, delete_record, get_record, list_records, save_record
from ..security import sync_authorized

router = APIRouter(prefix="/api")


class RecordPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str | None = None
    expected_version: int | None = Field(default=None, alias="expectedVersion", ge=1)


def authorize(request: Request) -> None:
    if not sync_authorized(request, {}):
        raise HTTPException(status_code=401, detail="Sessão ou chave de sincronização inválida.")


@router.get("/modules")
async def modules(request: Request):
    authorize(request)
    return {"ok": True, "modules": sorted(RESOURCE_TYPES)}


@router.get("/erp/{resource}")
async def records(
    request: Request,
    resource: str,
    include_deleted: bool = False,
    limit: int = Query(1000, ge=1, le=5000),
):
    authorize(request)
    return {
        "ok": True,
        "resource": resource,
        "items": await list_records(resource, include_deleted=include_deleted, limit=limit),
    }


@router.get("/erp/{resource}/{record_id}")
async def record(request: Request, resource: str, record_id: str):
    authorize(request)
    item = await get_record(resource, record_id)
    if not item:
        raise HTTPException(status_code=404, detail="Registro não encontrado.")
    return {"ok": True, "item": item}


@router.post("/erp/{resource}")
async def upsert(request: Request, resource: str, payload: RecordPayload):
    authorize(request)
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
    authorize(request)
    removed = await delete_record(resource, record_id, expected_version=expected_version)
    if not removed:
        raise HTTPException(status_code=409, detail="Registro ausente ou alterado em outro dispositivo.")
    return {"ok": True, "deletedId": record_id}


@router.get("/backups")
async def backups(request: Request, limit: int = Query(50, ge=1, le=200)):
    authorize(request)
    return {"ok": True, "items": await list_backups(limit)}


@router.get("/backups/{backup_id}")
async def backup(request: Request, backup_id: str):
    authorize(request)
    item = await get_backup(backup_id)
    if not item:
        raise HTTPException(status_code=404, detail="Backup não encontrado.")
    return {"ok": True, **item}


@router.post("/backups")
async def backup_create(request: Request):
    authorize(request)
    body = await request.json()
    snapshot = body.get("snapshot") if isinstance(body, dict) else None
    if not isinstance(snapshot, dict):
        raise HTTPException(status_code=400, detail="Conteúdo do backup inválido.")
    return {
        "ok": True,
        **await create_backup(
            snapshot,
            str(body.get("reason") or "manual"),
            str(body.get("createdBy") or ""),
        ),
    }
