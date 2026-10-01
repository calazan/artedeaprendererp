from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import APP_VERSION
from ..audit import capture_backup, record_audit
from ..config import database_configured, database_provider
from ..security import sanitize_incoming_state, sync_authorized
from ..state import database_counts, fetch_critical_state, sync_critical_state
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
        current = await fetch_critical_state()
        current_etag = state_etag(current)

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
        updated = await fetch_critical_state()
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
                "updatedAt": updated.get("updatedAt") or datetime.utcnow().isoformat() + "Z",
                "revision": rev,
                "teacherAttendanceRevision": rev,
                "eventRosterRevision": rev,
                "etag": state_etag(updated),
                "storageAuth": database_provider(),
                "provider": database_provider(),
                "version": APP_VERSION,
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


@router.api_route("/api/supabase-sync", methods=["GET", "POST"])
async def direct_supabase_sync(request: Request):
    if not database_configured():
        return response({"ok": False, "error": "Neon ainda não configurado no ambiente Production."}, 503)

    body = await read_json_limited(request) if request.method == "POST" else {}
    if not sync_authorized(request, body):
        return response({"ok": False, "error": "Autenticação obrigatória."}, 401)

    if request.method == "GET" and request.query_params.get("mode") == "status":
        try:
            return response({"ok": True, "counts": await database_counts()})
        except Exception:
            logger.exception("Erro interno inesperado no endpoint.")
            return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)

    try:
        if request.method == "GET":
            return response({"ok": True, "data": await fetch_critical_state()})

        incoming = as_dict(body.get("state"))
        current = await fetch_critical_state()
        issue = supplemental_snapshot_issue(current, incoming)
        if issue:
            return suspicious_snapshot_response(issue)

        client_id = str(body.get("clientId") or "")
        await capture_backup(current, source=str(body.get("source") or "admin-app"), client_id=client_id)
        result = await sync_critical_state(
            {
                "state": incoming,
                "deleted": as_dict(body.get("deleted")),
                "clientId": client_id,
                "source": body.get("source") or "admin-app",
            }
        )
        await record_audit(
            request,
            "critical_state",
            "direct_sync",
            details={"clientId": client_id, "deleted": as_dict(body.get("deleted"))},
        )
        return response(
            {
                "ok": True,
                "updatedAt": result["updatedAt"],
                "counts": await database_counts(),
            }
        )
    except Exception:
        logger.exception("Erro interno inesperado no endpoint.")
        return response({"ok": False, "error": INTERNAL_ERROR_MESSAGE}, 500)
