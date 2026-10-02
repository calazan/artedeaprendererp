from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..auth import ADMIN_ROLES, role_authorized
from ..auth_store import ensure_auth_schema
from ..config import database_configured, database_provider
from ..db import connection
from ..domains import ensure_domain_schema
from ..state import database_counts, ensure_core_schema

router = APIRouter(prefix="/api")


def response(payload: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(
        payload,
        status_code=status,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/integrity")
async def integrity(request: Request):
    if not await role_authorized(request, ADMIN_ROLES):
        return response({"ok": False, "error": "Autenticação obrigatória."}, 401)
    if not database_configured():
        return response({"ok": False, "error": "Banco PostgreSQL não configurado."}, 503)

    await ensure_core_schema()
    await ensure_domain_schema()
    await ensure_auth_schema()

    async with connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  (SELECT count(*)::int FROM public.smg_payments p
                    LEFT JOIN public.smg_students s ON s.id=p.student_id
                    WHERE p.deleted_at IS NULL AND p.student_id<>'' AND s.id IS NULL),
                  (SELECT count(*)::int FROM (
                    SELECT student_id,period FROM public.smg_payments
                    WHERE deleted_at IS NULL AND student_id<>'' AND period<>''
                    GROUP BY student_id,period HAVING count(*)>1
                  ) d),
                  (SELECT count(*)::int FROM public.smg_payments
                    WHERE deleted_at IS NULL AND amount<0),
                  (SELECT count(*)::int FROM public.smg_extra_participants p
                    LEFT JOIN public.smg_extra_events e ON e.id=p.event_id
                    WHERE p.event_id<>'' AND e.id IS NULL),
                  (SELECT count(*)::int FROM public.smg_attendance a
                    LEFT JOIN public.smg_students s ON s.id=a.student_id
                    WHERE s.id IS NULL AND a.student_id LIKE 'extra-participant:%'),
                  (SELECT count(*)::int FROM public.smg_attendance a
                    LEFT JOIN public.smg_students s ON s.id=a.student_id
                    WHERE s.id IS NULL AND a.student_id NOT LIKE 'extra-participant:%'),
                  (SELECT count(*)::int FROM public.smg_attendance a
                    LEFT JOIN public.smg_students s ON s.id=a.student_id
                    WHERE s.id IS NULL AND a.student_id NOT LIKE 'extra-participant:%'
                      AND a.attendance_date >= current_date-30),
                  (SELECT count(*)::int FROM public.smg_domain_records WHERE deleted_at IS NULL)
                """
            )
            row = await cur.fetchone()

            await cur.execute(
                """
                SELECT count(*) FILTER (WHERE NOT c.relrowsecurity)::int
                FROM pg_class c
                JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'smg_%'
                """
            )
            security_row = await cur.fetchone()

            await cur.execute(
                """
                SELECT
                  to_regclass('public.app_users') IS NOT NULL,
                  to_regclass('public.organizations') IS NOT NULL,
                  to_regclass('public.organization_members') IS NOT NULL,
                  to_regclass('public.smg_manual_backups') IS NOT NULL
                """
            )
            runtime_row = await cur.fetchone()

    critical_issues = {
        "paymentsWithoutStudent": int(row[0] or 0),
        "duplicateStudentPeriods": int(row[1] or 0),
        "negativePayments": int(row[2] or 0),
        "participantsWithoutEvent": int(row[3] or 0),
        "recentHistoricalAttendanceWithoutStudent": int(row[6] or 0),
        "smgTablesWithoutRls": int(security_row[0] or 0),
    }
    auth_ready = bool(runtime_row[0] and runtime_row[1] and runtime_row[2])
    critical_ok = all(value == 0 for value in critical_issues.values()) and auth_ready

    return response(
        {
            "ok": critical_ok,
            "database": {
                "configured": True,
                "provider": database_provider(),
                "counts": await database_counts(),
                "activeDomainRecords": int(row[7] or 0),
            },
            "integrity": critical_issues,
            "attendanceInfo": {
                "syntheticExtraParticipantRows": int(row[4] or 0),
                "historicalRowsWithoutCurrentStudent": int(row[5] or 0),
                "recentHistoricalRowsWithoutCurrentStudent": int(row[6] or 0),
            },
            "security": {
                "smgTablesWithoutRls": int(security_row[0] or 0),
                "backendOnlyDatabaseAccess": True,
            },
            "runtime": {
                "authTablesReady": auth_ready,
                "manualBackupTableReady": bool(runtime_row[3]),
            },
        }
    )
