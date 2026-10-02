from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from datetime import date, datetime, timezone
from pathlib import Path

import pytest
from psycopg import AsyncConnection
from psycopg.types.json import Jsonb
from starlette.requests import Request

import smg.domains as domains
import smg.state as state
from smg import db
from smg.routers import health as health_router
from smg.routers import sync as sync_router


ROOT = Path(__file__).resolve().parents[1]
SYNC_SOURCE = ROOT / "frontend" / "supabase-admin-sync.js"


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
            return await cur.fetchall() if fetch else None
    finally:
        await conn.close()


async def _prepare(monkeypatch) -> str:
    url = _database_url()
    monkeypatch.setenv("DATABASE_URL", url)
    await db.close_pool()
    state._schema_ready = False
    domains._schema_ready = False
    await state.ensure_core_schema()
    await domains.ensure_domain_schema()
    return url


def test_domain_mirror_only_versions_real_changes_and_tombstones_removals(monkeypatch):
    async def scenario():
        url = await _prepare(monkeypatch)
        record_id = "phase4-shopping-list"
        resource = "shopping-lists"
        try:
            await _sql(
                url,
                "DELETE FROM public.smg_domain_records WHERE resource_type=%s AND id=%s",
                (resource, record_id),
            )

            first = {"shoppingLists": [{"id": record_id, "name": "Lista A", "items": ["x"]}]}
            await domains.migrate_supplemental_state(first)
            row1 = (
                await _sql(
                    url,
                    """
                    SELECT data,version,deleted_at,updated_at
                    FROM public.smg_domain_records
                    WHERE resource_type=%s AND id=%s
                    """,
                    (resource, record_id),
                    fetch=True,
                )
            )[0]
            assert row1[0]["name"] == "Lista A"
            assert row1[1] == 1
            assert row1[2] is None
            first_updated_at = row1[3]

            await domains.migrate_supplemental_state(first)
            row2 = (
                await _sql(
                    url,
                    """
                    SELECT version,deleted_at,updated_at
                    FROM public.smg_domain_records
                    WHERE resource_type=%s AND id=%s
                    """,
                    (resource, record_id),
                    fetch=True,
                )
            )[0]
            assert row2[0] == 1
            assert row2[1] is None
            assert row2[2] == first_updated_at

            changed = {"shoppingLists": [{"id": record_id, "name": "Lista B", "items": ["x"]}]}
            await domains.migrate_supplemental_state(changed)
            row3 = (
                await _sql(
                    url,
                    """
                    SELECT data,version,deleted_at
                    FROM public.smg_domain_records
                    WHERE resource_type=%s AND id=%s
                    """,
                    (resource, record_id),
                    fetch=True,
                )
            )[0]
            assert row3[0]["name"] == "Lista B"
            assert row3[1] == 2
            assert row3[2] is None

            await domains.migrate_supplemental_state({"shoppingLists": []})
            row4 = (
                await _sql(
                    url,
                    """
                    SELECT version,deleted_at
                    FROM public.smg_domain_records
                    WHERE resource_type=%s AND id=%s
                    """,
                    (resource, record_id),
                    fetch=True,
                )
            )[0]
            assert row4[0] == 3
            assert row4[1] is not None

            await domains.migrate_supplemental_state(changed)
            row5 = (
                await _sql(
                    url,
                    """
                    SELECT version,deleted_at
                    FROM public.smg_domain_records
                    WHERE resource_type=%s AND id=%s
                    """,
                    (resource, record_id),
                    fetch=True,
                )
            )[0]
            assert row5[0] == 4
            assert row5[1] is None
        finally:
            await _sql(
                url,
                "DELETE FROM public.smg_domain_records WHERE resource_type=%s AND id=%s",
                (resource, record_id),
            )
            await db.close_pool()
            state._schema_ready = False
            domains._schema_ready = False

    asyncio.run(scenario())


def test_domain_mirror_failure_rolls_back_core_sync(monkeypatch):
    async def scenario():
        url = await _prepare(monkeypatch)
        student_id = "phase4-atomic-student"
        try:
            await _sql(url, "DELETE FROM public.smg_students WHERE id=%s", (student_id,))

            async def fail_mirror(_state, *, cursor=None):
                raise RuntimeError("falha simulada no espelho")

            monkeypatch.setattr(state, "migrate_supplemental_state", fail_mirror)
            with pytest.raises(RuntimeError, match="falha simulada"):
                await state.sync_critical_state(
                    {
                        "state": {
                            "students": [{"id": student_id, "name": "Atomicidade", "status": "active"}],
                            "shoppingLists": [],
                        },
                        "deleted": {},
                        "clientId": "phase4-test",
                        "source": "phase4-test",
                    }
                )

            rows = await _sql(
                url,
                "SELECT id FROM public.smg_students WHERE id=%s",
                (student_id,),
                fetch=True,
            )
            assert rows == []
        finally:
            await _sql(url, "DELETE FROM public.smg_students WHERE id=%s", (student_id,))
            await db.close_pool()
            state._schema_ready = False
            domains._schema_ready = False

    asyncio.run(scenario())


def test_fetch_critical_state_windows_attendance(monkeypatch):
    async def scenario():
        url = await _prepare(monkeypatch)
        student_id = "phase4-attendance-student"
        old_day = "2026-01-05"
        recent_day = "2026-10-01"
        try:
            await _sql(
                url,
                "DELETE FROM public.smg_attendance WHERE student_id=%s",
                (student_id,),
            )
            await _sql(
                url,
                """
                INSERT INTO public.smg_attendance(attendance_date,student_id,record,updated_at)
                VALUES
                  (%s::date,%s,%s,now()),
                  (%s::date,%s,%s,now())
                """,
                (
                    old_day,
                    student_id,
                    Jsonb({"status": "present", "updatedAt": "2026-01-05T12:00:00Z"}),
                    recent_day,
                    student_id,
                    Jsonb({"status": "absent", "updatedAt": "2026-10-01T12:00:00Z"}),
                ),
            )

            full = await state.fetch_critical_state()
            windowed = await state.fetch_critical_state(attendance_since="2026-09-01")
            assert old_day in full["attendance"]
            assert recent_day in full["attendance"]
            assert old_day not in windowed["attendance"]
            assert recent_day in windowed["attendance"]
        finally:
            await _sql(
                url,
                "DELETE FROM public.smg_attendance WHERE student_id=%s",
                (student_id,),
            )
            await db.close_pool()
            state._schema_ready = False
            domains._schema_ready = False

    asyncio.run(scenario())


def _request(path: str = "/", query: bytes = b"") -> Request:
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": query,
            "headers": [],
            "server": ("example.test", 443),
            "client": ("127.0.0.1", 1234),
        }
    )


def test_default_attendance_window_is_90_days():
    request = _request("/api/supabase-sync")
    value = sync_router.attendance_since_for_request(request)
    delta = datetime.now(timezone.utc).date() - date.fromisoformat(value)
    assert delta.days == 90

    explicit = _request(
        "/api/supabase-sync",
        b"attendanceSince=2026-01-01",
    )
    assert sync_router.attendance_since_for_request(explicit) == "2026-01-01"


def test_sync_revision_endpoint_reads_only_marker(monkeypatch):
    calls = {"marker": 0}

    async def fake_marker():
        calls["marker"] += 1
        return {"revision": 17, "updatedAt": "2026-10-02T12:00:00Z"}

    monkeypatch.setattr(sync_router, "database_configured", lambda: True)
    monkeypatch.setattr(sync_router, "sync_authorized", lambda request, body: True)
    monkeypatch.setattr(sync_router, "get_sync_marker", fake_marker)

    response = asyncio.run(sync_router.sync_revision(_request("/api/sync-revision")))
    body = json.loads(response.body)
    assert response.status_code == 200
    assert body == {
        "ok": True,
        "revision": 17,
        "updatedAt": "2026-10-02T12:00:00Z",
    }
    assert calls["marker"] == 1


def test_public_health_is_cached_and_skips_counts(monkeypatch):
    calls = {"core": 0, "auth": 0, "counts": 0}

    async def fake_core():
        calls["core"] += 1

    async def fake_auth():
        calls["auth"] += 1

    async def fake_counts():
        calls["counts"] += 1
        return {"students": 1}

    monkeypatch.setattr(health_router, "database_configured", lambda: True)
    monkeypatch.setattr(health_router, "database_provider", lambda: "neon-postgres")
    monkeypatch.setattr(health_router, "ensure_core_schema", fake_core)
    monkeypatch.setattr(health_router, "ensure_auth_schema", fake_auth)
    monkeypatch.setattr(health_router, "database_counts", fake_counts)
    health_router._public_health_cache = None

    first = asyncio.run(health_router._health(detailed=False))
    second = asyncio.run(health_router._health(detailed=False))
    assert first.status_code == 200
    assert second.status_code == 200
    assert calls == {"core": 1, "auth": 1, "counts": 0}

    detailed = asyncio.run(health_router._health(detailed=True))
    assert detailed.status_code == 200
    assert calls == {"core": 2, "auth": 2, "counts": 1}


def test_frontend_sends_only_changed_attendance_and_keeps_old_history():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js não disponível.")

    script = r"""
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(String(key)) ? this.data.get(String(key)) : null; }
  setItem(key, value) { this.data.set(String(key), String(value)); }
  removeItem(key) { this.data.delete(String(key)); }
}
const localStorage = new MemoryStorage();
global.localStorage = localStorage;
global.window = global;
global.globalThis = global;
window.__saberStabilityCoreLoaded = true;
global.document = {
  hidden: false,
  visibilityState: "visible",
  body: { appendChild() {} },
  querySelector() { return null; },
  createElement() { return { dataset: {}, addEventListener() {}, set src(v) { this._src = v; } }; },
  addEventListener() {},
};
window.addEventListener = () => {};
global.setTimeout = (cb, delay) => { if (delay === 250) Promise.resolve().then(cb); return 1; };
window.setTimeout = global.setTimeout;
global.clearTimeout = () => {};
global.setInterval = () => 1;
global.clearInterval = () => {};
global.saveState = () => {};
global.flushSaveState = () => {};
global.normalizeState = (value) => value;
global.renderAll = () => {};
global.showToast = () => {};

const oldDay = "2025-01-05";
const recentDay = "2026-10-01";
global.state = {
  students: [{id:"s1",name:"Ana"}],
  activityCatalog: [], extraEvents: [], extraParticipants: [], payments: [],
  otherIncomes: [], expenses: [], proposals: [], expenseCategories: [],
  agendaEvents: [], bankAccounts: [], bankMovements: [], paymentExclusions: [],
  rentalManagement: {},
  attendance: {
    [oldDay]: {s1:{status:"present",updatedAt:"2025-01-05T12:00:00Z"}},
    [recentDay]: {s1:{status:"absent",updatedAt:"2026-10-02T12:00:00Z"}},
  },
  settings:{remoteSync:{syncKey:"12345678901234567890123456789012"}},
};

const base = JSON.parse(JSON.stringify(state));
base.attendance[recentDay].s1 = {status:"present",updatedAt:"2026-10-01T12:00:00Z"};
delete base.settings.remoteSync;
localStorage.setItem("arteDeAprenderERP.supabase.baseState.v3", JSON.stringify(base));
localStorage.setItem("arteDeAprenderERP.supabase.baseRevision.v3", "7");
localStorage.setItem("arteDeAprenderERP.supabase.pendingPush.v1", JSON.stringify({
  pending:true, revision:2, updatedAt:"2026-10-02T12:00:00Z"
}));
localStorage.setItem("arteDeAprenderERP.supabase.lastSyncAt", "2026-10-01T13:00:00Z");

let posted = null;
global.fetch = async (url, options={}) => {
  if (url === "/api/supabase-health") {
    return {ok:true,status:200,async json(){return {ok:true,schemaReady:true};}};
  }
  if (url.startsWith("/api/supabase-sync") && options.method === "POST") {
    posted = JSON.parse(options.body);
    return {
      ok:true,status:200,
      async json(){return {
        ok:true,revision:8,updatedAt:"2026-10-02T12:01:00Z",
        data:{
          students:[{id:"s1",name:"Ana"}],
          activityCatalog:[],extraEvents:[],extraParticipants:[],payments:[],
          otherIncomes:[],expenses:[],proposals:[],expenseCategories:[],
          agendaEvents:[],bankAccounts:[],bankMovements:[],paymentExclusions:[],
          rentalManagement:{},settings:{},
          attendance:{[recentDay]:{s1:{status:"absent",updatedAt:"2026-10-02T12:00:00Z"}}},
          updatedAt:"2026-10-02T12:01:00Z",
        },
        tombstones:{},
      };},
    };
  }
  throw new Error("request inesperada "+url);
};

vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"), {filename:process.argv[1]});

(async()=>{
  for(let i=0;i<40;i++){
    await new Promise(r=>setImmediate(r));
    if(posted && !window.__saberMaisSupabase.status().busy) break;
  }
  assert.ok(posted);
  assert.deepStrictEqual(Object.keys(posted.attendance), [recentDay]);
  assert.strictEqual(posted.attendance[recentDay].s1.status, "absent");
  assert.ok(state.attendance[oldDay], "histórico anterior à janela deve permanecer no cache local");
})().catch(e=>{console.error(e);process.exitCode=1;});
"""
    result = subprocess.run(
        [node, "-e", script, str(SYNC_SOURCE)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_frontend_revision_poll_avoids_full_pull_until_marker_changes():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js não disponível.")

    script = r"""
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(k) { return this.data.has(String(k)) ? this.data.get(String(k)) : null; }
  setItem(k,v) { this.data.set(String(k),String(v)); }
  removeItem(k) { this.data.delete(String(k)); }
}
global.localStorage = new MemoryStorage();
global.window = global;
global.globalThis = global;
window.__saberStabilityCoreLoaded = true;
let intervalCallback = null;
global.document = {
  hidden:false, visibilityState:"visible", body:{appendChild(){}},
  querySelector(){return null;},
  createElement(){return {dataset:{},addEventListener(){},set src(v){this._src=v;}};},
  addEventListener(){},
};
window.addEventListener=()=>{};
global.setTimeout=(cb,delay)=>{if(delay===250)Promise.resolve().then(cb);return 1;};
window.setTimeout=global.setTimeout;
global.clearTimeout=()=>{};
global.setInterval=(cb,delay)=>{if(delay===15000)intervalCallback=cb;return 1;};
global.clearInterval=()=>{};
global.saveState=()=>{};
global.flushSaveState=()=>{};
global.normalizeState=v=>v;
global.renderAll=()=>{};
global.showToast=()=>{};
global.state={
  students:[{id:"s1",name:"Ana"}],activityCatalog:[],extraEvents:[],extraParticipants:[],
  attendance:{},payments:[],otherIncomes:[],expenses:[],proposals:[],expenseCategories:[],
  agendaEvents:[],bankAccounts:[],bankMovements:[],paymentExclusions:[],rentalManagement:{},
  settings:{remoteSync:{syncKey:"12345678901234567890123456789012"}},
};

const remote=JSON.parse(JSON.stringify(state));
delete remote.settings.remoteSync;
remote.updatedAt="2026-10-02T12:00:00Z";
let fullGets=0;
let revisionGets=0;
let marker={revision:5,updatedAt:"2026-10-02T12:00:00Z"};

global.fetch=async(url,options={})=>{
  if(url==="/api/supabase-health"){
    return {ok:true,status:200,async json(){return {ok:true,schemaReady:true};}};
  }
  if(url==="/api/supabase-sync" && (options.method||"GET")==="GET"){
    fullGets++;
    return {ok:true,status:200,async json(){return {ok:true,revision:marker.revision,data:{...remote,updatedAt:marker.updatedAt},tombstones:{}};}};
  }
  if(url==="/api/sync-revision"){
    revisionGets++;
    return {ok:true,status:200,async json(){return {ok:true,...marker};}};
  }
  throw new Error("request inesperada "+url);
};

vm.runInThisContext(fs.readFileSync(process.argv[1],"utf8"),{filename:process.argv[1]});

(async()=>{
  for(let i=0;i<30;i++){
    await new Promise(r=>setImmediate(r));
    if(intervalCallback && !window.__saberMaisSupabase.status().busy) break;
  }
  assert.strictEqual(fullGets,1);
  assert.ok(intervalCallback);

  await intervalCallback();
  await new Promise(r=>setImmediate(r));
  assert.strictEqual(revisionGets,1);
  assert.strictEqual(fullGets,1,"marcador igual não deve baixar snapshot completo");

  marker={revision:5,updatedAt:"2026-10-02T12:05:00Z"};
  await intervalCallback();
  for(let i=0;i<10;i++) await new Promise(r=>setImmediate(r));
  assert.strictEqual(revisionGets,2);
  assert.strictEqual(fullGets,2,"mudança no marcador deve disparar pull completo");
})().catch(e=>{console.error(e);process.exitCode=1;});
"""
    result = subprocess.run(
        [node, "-e", script, str(SYNC_SOURCE)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_protocol_v2_attendance_delta_does_not_rewrite_untouched_history(monkeypatch):
    async def scenario():
        url = await _prepare(monkeypatch)
        day = "2026-10-01"
        changed_id = "phase4-attendance-changed"
        untouched_id = "phase4-attendance-untouched"
        try:
            await _sql(
                url,
                "DELETE FROM public.smg_attendance WHERE attendance_date=%s::date AND student_id = ANY(%s::text[])",
                (day, [changed_id, untouched_id]),
            )
            await _sql(
                url,
                """
                INSERT INTO public.smg_attendance(attendance_date,student_id,record,updated_at)
                VALUES
                  (%s::date,%s,%s,now()-interval '1 hour'),
                  (%s::date,%s,%s,now()-interval '1 hour')
                """,
                (
                    day,
                    changed_id,
                    Jsonb({"status": "present", "updatedAt": "2026-10-01T10:00:00Z"}),
                    day,
                    untouched_id,
                    Jsonb({"status": "present", "updatedAt": "2026-10-01T10:00:00Z"}),
                ),
            )
            before = (
                await _sql(
                    url,
                    """
                    SELECT updated_at
                    FROM public.smg_attendance
                    WHERE attendance_date=%s::date AND student_id=%s
                    """,
                    (day, untouched_id),
                    fetch=True,
                )
            )[0][0]

            await state.sync_critical_state(
                {
                    "state": {
                        "attendance": {
                            day: {
                                changed_id: {
                                    "status": "absent",
                                    "updatedAt": "2026-10-01T11:00:00Z",
                                },
                                untouched_id: {
                                    "status": "present",
                                    "updatedAt": "2026-10-01T10:00:00Z",
                                },
                            }
                        }
                    },
                    "attendanceDelta": {
                        day: {
                            changed_id: {
                                "status": "absent",
                                "updatedAt": "2026-10-01T11:00:00Z",
                            }
                        }
                    },
                    "deleted": {},
                    "clientId": "phase4-attendance-delta",
                    "source": "phase4-test",
                }
            )

            rows = await _sql(
                url,
                """
                SELECT student_id,record,updated_at
                FROM public.smg_attendance
                WHERE attendance_date=%s::date AND student_id = ANY(%s::text[])
                ORDER BY student_id
                """,
                (day, [changed_id, untouched_id]),
                fetch=True,
            )
            by_id = {str(row[0]): row for row in rows}
            assert by_id[changed_id][1]["status"] == "absent"
            assert by_id[untouched_id][1]["status"] == "present"
            assert by_id[untouched_id][2] == before
        finally:
            await _sql(
                url,
                "DELETE FROM public.smg_attendance WHERE attendance_date=%s::date AND student_id = ANY(%s::text[])",
                (day, [changed_id, untouched_id]),
            )
            await db.close_pool()
            state._schema_ready = False
            domains._schema_ready = False

    asyncio.run(scenario())
