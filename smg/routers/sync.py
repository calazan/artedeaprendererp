from __future__ import annotations

import hashlib
import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import APP_VERSION
from ..audit import capture_backup, record_audit
from ..config import database_configured, database_provider
from ..security import sanitize_incoming_state, sync_authorized
from ..state import (
    database_counts,
    fetch_critical_state,
    fetch_sync_tombstones,
    get_sync_marker,
    get_sync_revision,
    sync_critical_state,
)
from ..sync_merge import (
    LIST_RESOURCES,
    apply_protocol_changes,
    core_deletions,
    legacy_tombstone_conflicts,
    sync_advisory_lock,
)
from ..utils import as_dict, as_list

logger = logging.getLogger("smg.routers.sync")
INTERNAL_ERROR_MESSAGE = "Erro interno do servidor."
router = APIRouter()

# Domínios mantidos dentro de smg_meta.supplemental_state. Clientes atuais enviam
# todos eles em cada snapshot. Ausência de um domínio que já possua dados no servidor
# é tratada como cliente antigo/incompleto, pois a gravação do snapshot é substitutiva.
SUPPLEMENTAL_DOMAINS = (
    "otherIncomes",
    "expenses",
    "proposals",
    "expenseCategories",
    "agendaEvents",
    "bankAccounts",
    "bankMovements",
    "paymentExclusions",
    "rentalManagement",
    "settings",
)

# Estes domínios concentram valores financeiros. Um esvaziamento simultâneo de dois
# ou mais deles é incompatível com uma edição normal e reproduz o padrão dos antigos
# snapshots defeituosos que zeravam contas/despesas.
HIGH_RISK_FINANCE_DOMAINS = (
    "bankAccounts",
    "bankMovements",
    "expenses",
    "otherIncomes",
)

DEFAULT_ATTENDANCE_WINDOW_DAYS = 90


def attendance_since_for_request(request: Request) -> str:
    raw = str(request.query_params.get("attendanceSince") or "").strip()
    if raw:
        try:
            return date.fromisoformat(raw).isoformat()
        except Exception:
            pass
    return (datetime.now(timezone.utc).date() - timedelta(days=DEFAULT_ATTENDANCE_WINDOW_DAYS)).isoformat()


def window_attendance_state(state: dict, attendance_since: str) -> dict:
    result = dict(as_dict(state))
    result["attendance"] = {
        str(day): records
        for day, records in as_dict(result.get("attendance")).items()
        if str(day) >= attendance_since
    }
    return result


def response(payload: dict, status: int = 200, *, version_header: bool = False) -> JSONResponse:
    headers = {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if version_header:
        headers["X-ArteERP-Version"] = APP_VERSION
    return JSONResponse(payload, status_code=status, headers=headers)


async def read_json_limited(request: Request, limit: int = 8 * 1024 * 1024) -> dict:
    raw = await request.body()
    if len(raw) > limit:
        return {}
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def state_etag(state: dict) -> str:
    encoded = json.dumps(
        state,
        ensure_ascii=False,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def revision_from_state(state: dict) -> int:
    value = str(state.get("updatedAt") or "")
    if not value:
        return 0
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return 0


def ids(items: Any) -> set[str]:
    return {
        str(item.get("id") or "").strip()
        for item in as_list(items)
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }


def missing_ids(current_items: Any, incoming_items: Any) -> list[str]:
    return sorted(ids(current_items) - ids(incoming_items))


def deletions_for_full_snapshot(current: dict, incoming: dict) -> dict:
    return {
        "students": missing_ids(current.get("students"), incoming.get("students")),
        "activityCatalog": missing_ids(current.get("activityCatalog"), incoming.get("activityCatalog")),
        "extraEvents": missing_ids(current.get("extraEvents"), incoming.get("extraEvents")),
        "extraParticipants": missing_ids(current.get("extraParticipants"), incoming.get("extraParticipants")),
    }


def has_content(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (list, tuple, set, dict, str, bytes)):
        return len(value) > 0
    return True


def supplemental_snapshot_issue(current: dict, incoming: dict) -> dict | None:
    """Detect destructive/incomplete supplemental snapshots before any DB write.

    Missing populated domains are always unsafe because supplemental_state is stored as
    one JSON document. Empty values remain allowed for ordinary single-domain deletes;
    only simultaneous mass-emptying of financial collections is blocked.
    """
    missing_populated = [
        key
        for key in SUPPLEMENTAL_DOMAINS
        if has_content(current.get(key)) and key not in incoming
    ]
    if missing_populated:
        return {
            "reason": "missing-domains",
            "domains": missing_populated,
        }

    emptied_finance = [
        key
        for key in HIGH_RISK_FINANCE_DOMAINS
        if has_content(current.get(key))
        and key in incoming
        and not has_content(incoming.get(key))
    ]
    if len(emptied_finance) >= 2:
        return {
            "reason": "mass-finance-empty",
            "domains": emptied_finance,
        }

    return None


def sanitize_protocol_changes(value: Any) -> dict:
    changes = json.loads(json.dumps(as_dict(value), ensure_ascii=False, default=str))
    settings = as_dict(changes.get("settings"))
    upserts = as_list(settings.get("upserts"))
    for change in upserts:
        if not isinstance(change, dict):
            continue
        for key in ("base", "value"):
            if isinstance(change.get(key), dict):
                change[key] = sanitize_incoming_state({"settings": change[key]}).get("settings", {})
    return changes


def legacy_tombstone_entries(current: dict, deleted: dict, client_id: str) -> list[dict]:
    by_resource = {
        resource: {
            str(item.get("id") or ""): item
            for item in as_list(current.get(resource))
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        }
        for resource in LIST_RESOURCES
    }
    entries = []
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for resource, ids_value in as_dict(deleted).items():
        if resource not in by_resource:
            continue
        for record_id in as_list(ids_value):
            clean_id = str(record_id or "").strip()
            if not clean_id:
                continue
            base = as_dict(by_resource[resource].get(clean_id))
            entries.append(
                {
                    "resource": resource,
                    "id": clean_id,
                    "deletedAt": now,
                    "baseUpdatedAt": str(base.get("updatedAt") or ""),
                    "clientId": client_id,
                }
            )
    return entries


def suspicious_snapshot_response(issue: dict, *, version_header: bool = False) -> JSONResponse:
    return response(
        {
            "ok": False,
            "code": "SUSPICIOUS_EMPTY_SNAPSHOT",
            "version": APP_VERSION,
            "error": (
                "O envio foi bloqueado porque o snapshot parece incompleto ou zeraria "
                "dados financeiros existentes. Baixe a versão mais recente do Neon "
                "antes de tentar sincronizar novamente."
            ),
            "blockedDomains": list(issue.get("domains") or []),
        },
        409,
        version_header=version_header,
    )


@router.api_route("/api/sync", methods=["GET", "POST"])
async def compatibility_sync(request: Request):
    if not database_configured():
        return response(
            {"ok": False, "error": "Neon ainda não configurado no ambiente Production."},
            503,
            version_header=True,
        )

    body = await read_json_limited(request) if request.method == "POST" else {}
    if not sync_authorized(request, body):
        return response(
            {"ok": False, "error": "Autenticação obrigatória."},
            401,
            version_header=True,
        )

    try:
        attendance_since = attendance_since_for_request(request)
        current = await fetch_critical_state(
            attendance_since=attendance_since if request.method == "GET" else None
        )
        etag_state = (
            current
            if request.method == "GET"
            else window_attendance_state(current, attendance_since)
        )
        current_etag = state_etag(etag_state)

        if request.method == "GET":
            client_etag = str(
                request.query_params.get("etag")
                or request.headers.get("x-sync-etag")
                or ""
            ).strip()
            if client_etag and client_etag == current_etag:
                return response(
                    {
                        "ok": True,
                        "exists": True,
                        "notModified": True,
                        "etag": current_etag,
                        "version": APP_VERSION,
                        "storageAuth": database_provider(),
                    },
                    version_header=True,
                )
            rev = revision_from_state(current)
            return response(
                {
                    "ok": True,
                    "exists": True,
                    "updatedAt": current.get("updatedAt") or "",
                    "revision": rev,
                    "teacherAttendanceRevision": rev,
                    "eventRosterRevision": rev,
                    "etag": current_etag,
                    "version": APP_VERSION,
                    "storageAuth": database_provider(),
                    "provider": database_provider(),
                    "attendanceSince": attendance_since,
                    "backup": current,
                },
                version_header=True,
            )

        raw_incoming = body.get("data") or body.get("state")
        if not isinstance(raw_incoming, dict):
            return response(
                {"ok": False, "error": "Payload de sincronização inválido."},
                400,
                version_header=True,
            )
        incoming = sanitize_incoming_state(raw_incoming)
        expected_etag = str(body.get("baseEtag") or "").strip()
        force = body.get("force") is True

        if not force and expected_etag and expected_etag != current_etag:
            return response(
                {
                    "ok": False,
                    "code": "REMOTE_CONFLICT",
                    "version": APP_VERSION,
                    "error": "Os dados do Neon foram alterados em outro computador. Baixe a versão mais recente antes de enviar novamente.",
                },
                409,
                version_header=True,
            )

        issue = supplemental_snapshot_issue(current, incoming)
        if issue:
            return suspicious_snapshot_response(issue, version_header=True)

        deleted = deletions_for_full_snapshot(current, incoming) if (force or expected_etag) else {}
        client_id = str(body.get("clientId") or "legacy-sync-compat")
        await capture_backup(current, source="pre-sync", client_id=client_id)
        await sync_critical_state(
            {
                "state": incoming,
                "deleted": deleted,
                "clientId": client_id,
                "source": "legacy-sync-force-postgres" if force else "legacy-sync-compat-postgres",
            }
        )
        updated = await fetch_critical_state(attendance_since=attendance_since)
        await record_audit(
            request,
            "critical_state",
            "force_sync" if force else "sync",
            details={"clientId": client_id, "deleted": deleted},
        )
        rev = revision_from_state(updated)
        return response(
            {
                "ok": True,
                "forced": force,
                "updatedAt": updated.get("updatedAt") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "revision": rev,
                "teacherAttendanceRevision": rev,
                "eventRosterRevision": rev,
                "etag": state_etag(updated),
                "storageAuth": database_provider(),
                "provider": database_provider(),
                "version": APP_VERSION,
                "attendanceSince": attendance_since,
                "attendance": as_dict(updated.get("attendance")),
            },
            version_header=True,
        )
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response(
            {
                "ok": False,
                "version": APP_VERSION,
                "code": "INTERNAL_ERROR",
                "error": INTERNAL_ERROR_MESSAGE,
            },
            500,
            version_header=True,
        )


@router.get("/api/sync-revision")
async def sync_revision(request: Request):
    if not database_configured():
        return response({"ok": False, "error": "Neon ainda não configurado no ambiente Production."}, 503)
    if not sync_authorized(request, {}):
        return response({"ok": False, "error": "Autenticação obrigatória."}, 401)
    try:
        marker = await get_sync_marker()
        return response({"ok": True, **marker})
    except Exception:
        logger.exception("Erro interno inesperado no endpoint de revisão.")
        return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)


@router.api_route("/api/supabase-sync", methods=["GET", "POST"])
async def direct_supabase_sync(request: Request):
    if not database_configured():
        return response({"ok": False, "error": "Neon ainda não configurado no ambiente Production."}, 503)

    body = await read_json_limited(request) if request.method == "POST" else {}
    if not sync_authorized(request, body):
        return response({"ok": False, "error": "Autenticação obrigatória."}, 401)

    if request.method == "GET" and request.query_params.get("mode") == "status":
        try:
            return response(
                {
                    "ok": True,
                    "counts": await database_counts(),
                    "revision": await get_sync_revision(),
                }
            )
        except Exception:
            logger.exception("Erro interno inesperado no endpoint.")
            return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)

    try:
        attendance_since = attendance_since_for_request(request)
        if request.method == "GET":
            return response(
                {
                    "ok": True,
                    "data": await fetch_critical_state(attendance_since=attendance_since),
                    "revision": await get_sync_revision(),
                    "tombstones": await fetch_sync_tombstones(),
                    "attendanceSince": attendance_since,
                }
            )

        protocol_version = int(body.get("protocolVersion") or 1)
        client_id = str(body.get("clientId") or "")

        async with sync_advisory_lock():
            current = await fetch_critical_state()
            revision = await get_sync_revision()
            tombstones = await fetch_sync_tombstones()

            if protocol_version >= 2:
                base_revision = int(body.get("baseRevision") or 0)
                if base_revision > revision:
                    return response(
                        {
                            "ok": False,
                            "code": "MERGE_CONFLICT",
                            "error": "A revisão local é posterior à revisão disponível no servidor.",
                            "revision": revision,
                            "data": window_attendance_state(current, attendance_since),
                            "tombstones": tombstones,
                            "conflicts": [
                                {
                                    "resource": "sync",
                                    "id": "revision",
                                    "fields": ["baseRevision"],
                                    "reason": "client-ahead",
                                }
                            ],
                        },
                        409,
                    )

                changes = sanitize_protocol_changes(body.get("changes"))
                plan = apply_protocol_changes(
                    current,
                    changes,
                    tombstones,
                    base_revision=base_revision,
                    attendance=as_dict(body.get("attendance")),
                    client_id=client_id,
                )
                if plan["conflicts"]:
                    return response(
                        {
                            "ok": False,
                            "code": "MERGE_CONFLICT",
                            "error": "Há alterações concorrentes que precisam ser reaplicadas sobre a versão mais recente.",
                            "revision": revision,
                            "data": window_attendance_state(current, attendance_since),
                            "tombstones": tombstones,
                            "conflicts": plan["conflicts"],
                        },
                        409,
                    )

                merged_state = sanitize_incoming_state(as_dict(plan["state"]))
                issue = supplemental_snapshot_issue(current, merged_state)
                if issue:
                    return suspicious_snapshot_response(issue)

                if not plan["changed"]:
                    return response(
                        {
                            "ok": True,
                            "merged": base_revision != revision,
                            "updatedAt": current.get("updatedAt") or "",
                            "revision": revision,
                            "data": window_attendance_state(current, attendance_since),
                            "tombstones": tombstones,
                            "attendanceSince": attendance_since,
                            "counts": await database_counts(),
                        }
                    )

                deleted = core_deletions(current, merged_state)
                next_revision = revision + 1
                for entry in plan["tombstones"]:
                    entry["revision"] = next_revision

                await capture_backup(current, source=str(body.get("source") or "admin-app-v2"), client_id=client_id)
                await sync_critical_state(
                    {
                        "state": merged_state,
                        "deleted": deleted,
                        "clientId": client_id,
                        "source": body.get("source") or "admin-app-v2",
                        "syncRevision": next_revision,
                        "tombstones": plan["tombstones"],
                        "clearTombstones": plan["clearTombstones"],
                    }
                )
                updated = await fetch_critical_state(attendance_since=attendance_since)
                updated_tombstones = await fetch_sync_tombstones()
                await record_audit(
                    request,
                    "critical_state",
                    "merge_sync",
                    details={
                        "clientId": client_id,
                        "baseRevision": base_revision,
                        "revision": next_revision,
                        "deleted": deleted,
                    },
                )
                return response(
                    {
                        "ok": True,
                        "merged": base_revision != revision,
                        "updatedAt": updated.get("updatedAt") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "revision": next_revision,
                        "data": updated,
                        "tombstones": updated_tombstones,
                        "attendanceSince": attendance_since,
                        "counts": await database_counts(),
                    }
                )

            incoming = sanitize_incoming_state(as_dict(body.get("state")))
            conflicts = legacy_tombstone_conflicts(incoming, current, tombstones)
            if conflicts:
                return response(
                    {
                        "ok": False,
                        "code": "REMOTE_CONFLICT",
                        "error": "O snapshot legado tenta restaurar registros excluídos em uma revisão mais recente.",
                        "revision": revision,
                        "data": window_attendance_state(current, attendance_since),
                        "tombstones": tombstones,
                        "attendanceSince": attendance_since,
                        "conflicts": conflicts,
                    },
                    409,
                )

            issue = supplemental_snapshot_issue(current, incoming)
            if issue:
                return suspicious_snapshot_response(issue)

            deleted = as_dict(body.get("deleted"))
            next_revision = revision + 1
            legacy_tombstones = legacy_tombstone_entries(current, deleted, client_id)
            await capture_backup(current, source=str(body.get("source") or "admin-app"), client_id=client_id)
            result = await sync_critical_state(
                {
                    "state": incoming,
                    "deleted": deleted,
                    "clientId": client_id,
                    "source": body.get("source") or "admin-app",
                    "syncRevision": next_revision,
                    "tombstones": legacy_tombstones,
                }
            )
            await record_audit(
                request,
                "critical_state",
                "direct_sync",
                details={
                    "clientId": client_id,
                    "deleted": deleted,
                    "revision": next_revision,
                },
            )
            updated = await fetch_critical_state(attendance_since=attendance_since)
            return response(
                {
                    "ok": True,
                    "updatedAt": result["updatedAt"],
                    "revision": next_revision,
                    "data": updated,
                    "tombstones": await fetch_sync_tombstones(),
                    "attendanceSince": attendance_since,
                    "counts": await database_counts(),
                }
            )
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)

