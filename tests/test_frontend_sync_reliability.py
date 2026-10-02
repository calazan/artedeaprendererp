from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SYNC_SOURCE = ROOT / "frontend" / "supabase-admin-sync.js"
LOCAL_SOURCE = ROOT / "frontend" / "local-persistence-reliability.js"


def test_pending_sync_survives_reload_rebases_409_and_uses_protocol_v2_keepalive():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js não disponível para o teste comportamental do frontend.")

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

const documentListeners = {};
const windowListeners = {};
global.document = {
  hidden: false,
  visibilityState: "visible",
  body: { appendChild() {} },
  querySelector() { return null; },
  createElement() {
    return {
      dataset: {},
      addEventListener() {},
      set src(value) { this._src = value; },
      get src() { return this._src; },
    };
  },
  addEventListener(type, callback) {
    (documentListeners[type] ||= []).push(callback);
  },
};
window.addEventListener = (type, callback) => {
  (windowListeners[type] ||= []).push(callback);
};

const delayed = [];
function fakeSetTimeout(callback, delay) {
  if (delay === 250) Promise.resolve().then(callback);
  else delayed.push({ callback, delay });
  return delayed.length;
}
global.setTimeout = fakeSetTimeout;
window.setTimeout = fakeSetTimeout;
global.clearTimeout = () => {};
global.setInterval = () => 1;
global.clearInterval = () => {};

global.state = {
  students: [{ id: "s1", name: "Ana", phone: "222", guardian: "Maria" }],
  activityCatalog: [],
  extraEvents: [],
  extraParticipants: [],
  attendance: {},
  payments: [],
  otherIncomes: [],
  expenses: [],
  proposals: [],
  expenseCategories: [],
  agendaEvents: [],
  bankAccounts: [],
  bankMovements: [],
  paymentExclusions: [],
  rentalManagement: {},
  settings: {
    remoteSync: { syncKey: "12345678901234567890123456789012" },
  },
};
global.saveState = () => {};
global.flushSaveState = () => {};
global.normalizeState = (value) => value;
global.renderAll = () => {};
global.showToast = () => {};

const PENDING_KEY = "arteDeAprenderERP.supabase.pendingPush.v1";
const BASE_STATE_KEY = "arteDeAprenderERP.supabase.baseState.v3";
const BASE_REVISION_KEY = "arteDeAprenderERP.supabase.baseRevision.v3";

localStorage.setItem(PENDING_KEY, JSON.stringify({
  pending: true,
  revision: 7,
  updatedAt: "2026-10-02T10:00:00Z",
}));
localStorage.setItem(BASE_STATE_KEY, JSON.stringify({
  students: [{
    id: "s1",
    name: "Ana",
    phone: "111",
    guardian: "Maria",
    updatedAt: "2026-10-02T09:00:00Z",
  }],
  activityCatalog: [],
  extraEvents: [],
  extraParticipants: [],
  attendance: {},
  payments: [],
  otherIncomes: [],
  expenses: [],
  proposals: [],
  expenseCategories: [],
  agendaEvents: [],
  bankAccounts: [],
  bankMovements: [],
  paymentExclusions: [],
  rentalManagement: {},
  settings: {},
}));
localStorage.setItem(BASE_REVISION_KEY, "1");

const canonicalAfterConflict = {
  students: [
    {
      id: "s1",
      name: "Ana",
      phone: "111",
      guardian: "João",
      updatedAt: "2026-10-02T10:30:00Z",
    },
    {
      id: "s2",
      name: "Novo remoto",
      updatedAt: "2026-10-02T10:20:00Z",
    },
  ],
  activityCatalog: [],
  extraEvents: [],
  extraParticipants: [],
  attendance: {},
  payments: [],
  otherIncomes: [],
  expenses: [],
  proposals: [],
  expenseCategories: [],
  agendaEvents: [],
  bankAccounts: [],
  bankMovements: [],
  paymentExclusions: [],
  rentalManagement: {},
  settings: {},
};

const canonicalAfterRetry = JSON.parse(JSON.stringify(canonicalAfterConflict));
canonicalAfterRetry.students[0].phone = "222";
canonicalAfterRetry.students[0].updatedAt = "2026-10-02T10:31:00Z";

const calls = [];
let syncPosts = 0;
global.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  if (url === "/api/supabase-health") {
    return {
      ok: true,
      status: 200,
      async json() {
        return { schemaReady: true, counts: { students: 1 } };
      },
    };
  }
  if (url === "/api/supabase-sync" && (options.method || "GET") === "GET") {
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, revision: 2, data: canonicalAfterConflict, tombstones: {} };
      },
    };
  }
  if (url === "/api/supabase-sync" && options.method === "POST") {
    syncPosts += 1;
    if (syncPosts === 1) {
      return {
        ok: false,
        status: 409,
        async json() {
          return {
            ok: false,
            code: "MERGE_CONFLICT",
            error: "Conflito de campo",
            revision: 2,
            data: canonicalAfterConflict,
            tombstones: {},
            conflicts: [{ resource: "students", id: "s1", fields: ["phone"] }],
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          revision: 3,
          updatedAt: "2026-10-02T10:31:00Z",
          data: canonicalAfterRetry,
          tombstones: {},
        };
      },
    };
  }
  throw new Error("Requisição inesperada: " + url);
};

const source = fs.readFileSync(process.argv[1], "utf8");
vm.runInThisContext(source, { filename: process.argv[1] });

(async () => {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (syncPosts >= 2 && !window.__saberMaisSupabase.status().busy) break;
  }

  assert.strictEqual(syncPosts, 2, "a pendência deve ser reenviada uma vez após o 409");

  const posts = calls.filter(
    (call) => call.url === "/api/supabase-sync" && call.options.method === "POST",
  );
  const first = JSON.parse(posts[0].options.body);
  const retry = JSON.parse(posts[1].options.body);

  assert.strictEqual(first.protocolVersion, 2);
  assert.strictEqual(first.baseRevision, 1);
  assert.strictEqual(first.changes.students.upserts[0].base.phone, "111");
  assert.strictEqual(first.changes.students.upserts[0].value.phone, "222");

  assert.strictEqual(retry.protocolVersion, 2);
  assert.strictEqual(retry.baseRevision, 2);
  assert.strictEqual(retry.changes.students.upserts[0].base.guardian, "João");
  assert.strictEqual(retry.changes.students.upserts[0].value.guardian, "João");
  assert.strictEqual(retry.changes.students.upserts[0].value.phone, "222");
  assert.ok(
    !retry.changes.students.tombstones?.some((item) => item.id === "s2"),
    "o registro remoto novo não pode virar exclusão durante o rebase",
  );

  const student = state.students.find((item) => item.id === "s1");
  assert.strictEqual(student.phone, "222");
  assert.strictEqual(student.guardian, "João");
  assert.ok(state.students.some((item) => item.id === "s2"));
  assert.strictEqual(localStorage.getItem(PENDING_KEY), null);
  assert.strictEqual(localStorage.getItem(BASE_REVISION_KEY), "3");

  state.students[0].phone = "333";
  saveState();
  assert.ok(localStorage.getItem(PENDING_KEY), "nova edição deve persistir a pendência imediatamente");

  const before = calls.length;
  assert.strictEqual(window.__saberMaisSupabase.flushBeforeUnload(), true);
  const keepalive = calls.slice(before).find((call) => call.options.keepalive === true);
  assert.ok(keepalive, "pagehide deve disparar POST keepalive quando o payload cabe no limite");
  const keepalivePayload = JSON.parse(keepalive.options.body);
  assert.strictEqual(keepalivePayload.protocolVersion, 2);
  assert.strictEqual(keepalivePayload.baseRevision, 3);
  assert.strictEqual(keepalivePayload.changes.students.upserts[0].value.phone, "333");
  assert.ok(localStorage.getItem(PENDING_KEY), "keepalive não apaga pendência sem confirmação aplicada");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""
    result = subprocess.run(
        [node, "-e", script, str(SYNC_SOURCE)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_local_persistence_calls_remote_flush_after_local_flush():
    source = LOCAL_SOURCE.read_text(encoding="utf-8")
    assert "window.__saberMaisSupabase?.flushBeforeUnload?.()" in source
    assert 'document.visibilityState === "hidden"' in source
    assert 'window.addEventListener("pagehide", flushPendingSave)' in source


def test_migration_without_base_state_preserves_cloud_only_records():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js não disponível para o teste de migração do frontend.")

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
  createElement() {
    return {
      dataset: {},
      addEventListener() {},
      set src(value) { this._src = value; },
    };
  },
  addEventListener() {},
};
window.addEventListener = () => {};

global.setTimeout = (callback, delay) => {
  if (delay === 250) Promise.resolve().then(callback);
  return 1;
};
window.setTimeout = global.setTimeout;
global.clearTimeout = () => {};
global.setInterval = () => 1;
global.clearInterval = () => {};

global.state = {
  students: [{ id: "s1", name: "Ana", phone: "222", guardian: "Maria" }],
  activityCatalog: [],
  extraEvents: [],
  extraParticipants: [],
  attendance: {},
  payments: [],
  otherIncomes: [],
  expenses: [],
  proposals: [],
  expenseCategories: [],
  agendaEvents: [],
  bankAccounts: [],
  bankMovements: [],
  paymentExclusions: [],
  rentalManagement: {},
  settings: {
    remoteSync: { syncKey: "12345678901234567890123456789012" },
  },
};
global.saveState = () => {};
global.flushSaveState = () => {};
global.normalizeState = (value) => value;
global.renderAll = () => {};
global.showToast = () => {};

localStorage.setItem("arteDeAprenderERP.supabase.pendingPush.v1", JSON.stringify({
  pending: true,
  revision: 3,
  updatedAt: "2026-10-02T11:00:00Z",
}));

const remote = {
  students: [
    { id: "s1", name: "Ana", phone: "111", guardian: "João", updatedAt: "2026-10-02T10:00:00Z" },
    { id: "s2", name: "Somente nuvem", updatedAt: "2026-10-02T10:05:00Z" },
  ],
  activityCatalog: [],
  extraEvents: [],
  extraParticipants: [],
  attendance: {},
  payments: [],
  otherIncomes: [],
  expenses: [],
  proposals: [],
  expenseCategories: [],
  agendaEvents: [],
  bankAccounts: [],
  bankMovements: [],
  paymentExclusions: [],
  rentalManagement: {},
  settings: {},
};

const canonical = JSON.parse(JSON.stringify(remote));
canonical.students[0].phone = "222";
canonical.students[0].guardian = "Maria";
canonical.students[0].updatedAt = "2026-10-02T11:01:00Z";

const calls = [];
global.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  if (url === "/api/supabase-health") {
    return {
      ok: true,
      status: 200,
      async json() { return { schemaReady: true, counts: { students: 2 } }; },
    };
  }
  if (url === "/api/supabase-sync" && (options.method || "GET") === "GET") {
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, revision: 5, data: remote, tombstones: {} }; },
    };
  }
  if (url === "/api/supabase-sync" && options.method === "POST") {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          revision: 6,
          updatedAt: "2026-10-02T11:01:00Z",
          data: canonical,
          tombstones: {},
        };
      },
    };
  }
  throw new Error("Requisição inesperada: " + url);
};

const source = fs.readFileSync(process.argv[1], "utf8");
vm.runInThisContext(source, { filename: process.argv[1] });

(async () => {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!window.__saberMaisSupabase.status().busy) {
      const posts = calls.filter((call) => call.options.method === "POST");
      if (posts.length) break;
    }
  }

  const post = calls.find(
    (call) => call.url === "/api/supabase-sync" && call.options.method === "POST",
  );
  assert.ok(post, "a pendência migrada precisa ser enviada");
  const payload = JSON.parse(post.options.body);
  assert.strictEqual(payload.protocolVersion, 2);
  assert.strictEqual(payload.baseRevision, 5);
  const tombstones = payload.changes.students?.tombstones || [];
  assert.ok(
    !tombstones.some((item) => item.id === "s2"),
    "registro existente apenas na nuvem não pode ser interpretado como exclusão local",
  );
  assert.ok(state.students.some((item) => item.id === "s2"));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
"""
    result = subprocess.run(
        [node, "-e", script, str(SYNC_SOURCE)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
