from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SYNC_SOURCE = ROOT / "frontend" / "supabase-admin-sync.js"
LOCAL_SOURCE = ROOT / "frontend" / "local-persistence-reliability.js"


def test_pending_sync_survives_reload_conflict_and_pagehide_keepalive():
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
  students: [{ id: "s1", name: "Local", phone: "111" }],
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
localStorage.setItem(PENDING_KEY, JSON.stringify({
  pending: true,
  revision: 7,
  updatedAt: "2026-10-02T10:00:00Z",
}));

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
        return {
          ok: true,
          data: {
            students: [
              { id: "s1", name: "Remoto", guardian: "Responsável remoto" },
              { id: "s2", name: "Outro aluno" },
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
          },
        };
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
            code: "REMOTE_CONFLICT",
            error: "Conflito remoto",
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, updatedAt: "2026-10-02T13:00:00Z" };
      },
    };
  }
  throw new Error("Requisição inesperada: " + url);
};

const source = fs.readFileSync(process.argv[1], "utf8");
vm.runInThisContext(source, { filename: process.argv[1] });

(async () => {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (syncPosts >= 2 && !window.__saberMaisSupabase.status().busy) break;
  }

  assert.strictEqual(syncPosts, 2, "a pendência persistida deve ser reenviada e repetida após 409");
  const posts = calls.filter((call) => call.url === "/api/supabase-sync" && call.options.method === "POST");
  const retryPayload = JSON.parse(posts[1].options.body);
  const s1 = retryPayload.state.students.find((item) => item.id === "s1");
  const s2 = retryPayload.state.students.find((item) => item.id === "s2");
  assert.strictEqual(s1.name, "Local", "a edição local deve prevalecer no mesmo id");
  assert.strictEqual(s1.guardian, "Responsável remoto", "campos remotos não conflitantes devem ser preservados");
  assert.ok(s2, "itens remotos com outro id devem sobreviver ao merge");
  assert.strictEqual(localStorage.getItem(PENDING_KEY), null, "pendência deve ser limpa após confirmação do servidor");

  saveState();
  assert.ok(localStorage.getItem(PENDING_KEY), "nova edição deve persistir a pendência imediatamente");

  const before = calls.length;
  assert.strictEqual(window.__saberMaisSupabase.flushBeforeUnload(), true);
  const keepalive = calls.slice(before).find((call) => call.options.keepalive === true);
  assert.ok(keepalive, "pagehide deve poder disparar POST keepalive");
  assert.ok(localStorage.getItem(PENDING_KEY), "keepalive não deve apagar a pendência antes da confirmação");
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
