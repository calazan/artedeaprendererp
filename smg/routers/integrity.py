from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..auth import ADMIN_ROLES, role_authorized
from ..config import EXPECTED_SUPABASE_REF, database_project_ref
from ..db import connection
from ..state import database_counts

router = APIRouter(prefix="/api")


def response(payload: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(
        payload,
        status_code=status,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/integrity")
async def integrity(request: Request):
    if not role_authorized(request, ADMIN_ROLES):
        return response({"ok": False, "error": "Autenticação obrigatória."}, 401)

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
                SELECT
                  count(*) FILTER (WHERE NOT c.relrowsecurity)::int AS without_rls,
                  count(*) FILTER (
                    WHERE has_table_privilege('anon',format('public.%I',c.relname),'INSERT,UPDATE,DELETE')
                       OR has_table_privilege('authenticated',format('public.%I',c.relname),'INSERT,UPDATE,DELETE')
                  )::int AS client_write_grants
                FROM pg_class c
                JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'smg_%'
                """
            )
            security_row = await cur.fetchone()

            await cur.execute(
                """
                SELECT
                  EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='smg_manual_backups'),
                  COALESCE((SELECT position('supabase.co/functions/v1' in pg_get_functiondef('public.dart20_dispatch_task_push()'::regprocedure))>0),false),
                  COALESCE((SELECT position('supabase.co/functions/v1' in pg_get_functiondef('public.dart_dispatch_whatsapp()'::regprocedure))>0),false)
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
    project_ref = database_project_ref()
    project_matched = not project_ref or project_ref == EXPECTED_SUPABASE_REF
    critical_ok = all(value == 0 for value in critical_issues.values()) and project_matched

    return response(
        {
            "ok": critical_ok,
            "database": {
                "expectedProject": EXPECTED_SUPABASE_REF,
                "projectMatched": project_matched,
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
                "smgTablesWithClientWriteGrants": int(security_row[1] or 0),
            },
            "runtime": {
                "manualBackupTableReady": bool(runtime_row[0]),
                "taskCronStillTargetsEdgeFunction": bool(runtime_row[1]),
                "whatsappCronStillTargetsEdgeFunction": bool(runtime_row[2]),
            },
        }
    )
