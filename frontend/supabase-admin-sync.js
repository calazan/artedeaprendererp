// Integração principal do Arte de Aprender ERP com Supabase.
// Protege alterações locais contra sobrescrita por pulls concorrentes.
(() => {
  function loadStabilityAndBoot() {
    if (window.__saberStabilityCoreLoaded) {
      boot();
      return;
    }
    const existing = document.querySelector('script[data-stability-core-fix]');
    if (existing) {
      existing.addEventListener("load", boot, { once: true });
      existing.addEventListener("error", boot, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "stability-core-fix.js?v=1";
    script.async = false;
    script.dataset.stabilityCoreFix = "true";
    script.addEventListener("load", boot, { once: true });
    script.addEventListener("error", () => {
      console.error("Não foi possível carregar o núcleo de estabilidade.");
      boot();
    }, { once: true });
    document.body.appendChild(script);
  }

  function boot() {
    if (window.__saberSupabaseAdminLoaded) return;
    window.__saberSupabaseAdminLoaded = true;

    const HEALTH_ENDPOINT = "/api/supabase-health";
    const SYNC_ENDPOINT = "/api/supabase-sync";
    const REVISION_ENDPOINT = "/api/sync-revision";
    const SNAPSHOT_KEY = "arteDeAprenderERP.supabase.snapshot.v2";
    const LAST_SYNC_KEY = "arteDeAprenderERP.supabase.lastSyncAt";
    const CLIENT_KEY = "arteDeAprenderERP.supabase.clientId";
    const PENDING_KEY = "arteDeAprenderERP.supabase.pendingPush.v1";
    const BASE_STATE_KEY = "arteDeAprenderERP.supabase.baseState.v3";
    const BASE_REVISION_KEY = "arteDeAprenderERP.supabase.baseRevision.v3";
    const PROTOCOL_VERSION = 2;
    const ATTENDANCE_WINDOW_DAYS = 90;
    const KEEPALIVE_MAX_BYTES = 60 * 1024;
    const LIST_RESOURCES = [
      "students", "activityCatalog", "extraEvents", "extraParticipants", "payments",
      "otherIncomes", "expenses", "proposals", "expenseCategories", "agendaEvents",
      "bankAccounts", "bankMovements", "paymentExclusions",
    ];
    const OBJECT_RESOURCES = ["rentalManagement", "settings"];
    const PUSH_DELAY_MS = 1400;
    const PUSH_RETRY_MS = 6000;
    const PULL_INTERVAL_MS = 15_000;

    const originalSaveState = saveState;
    const originalFlushSaveState = flushSaveState;
    let pushTimer = null;
    let pullTimer = null;
    let busy = false;
    let ready = false;
    let lastFingerprint = "";
    let localRevision = Number(readJSON(PENDING_KEY, {})?.revision || 0);
    let pendingPush = readJSON(PENDING_KEY, {})?.pending === true;
    let retryPush = false;
    let baseState = readJSON(BASE_STATE_KEY, null);
    let baseRevision = Number(localStorage.getItem(BASE_REVISION_KEY) || 0);
    let lastRemoteMarker = "";

    function clone(value) {
      try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
    }

    function readJSON(key, fallback = null) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    }

    function writeJSON(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }

    function persistPendingPush() {
      pendingPush = true;
      writeJSON(PENDING_KEY, {
        pending: true,
        revision: localRevision,
        updatedAt: new Date().toISOString(),
      });
    }

    function clearPendingPush() {
      try { localStorage.removeItem(PENDING_KEY); } catch {}
    }

    function clientId() {
      let value = localStorage.getItem(CLIENT_KEY);
      if (!value) {
        value = globalThis.crypto?.randomUUID?.() || `supabase-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem(CLIENT_KEY, value);
      }
      return value;
    }

    function syncKey() {
      return String(state?.settings?.remoteSync?.syncKey || "").trim();
    }

    function safeSettingsForSync() {
      const source = clone(state?.settings || {});
      delete source.password;
      delete source.passwordHash;
      delete source.passwordEnabled;
      delete source.passwordSecurityVersion;
      delete source.remoteSync;
      return source;
    }

    function criticalState() {
      return {
        students: clone(Array.isArray(state.students) ? state.students : []),
        activityCatalog: clone(Array.isArray(state.activityCatalog) ? state.activityCatalog : []),
        extraEvents: clone(Array.isArray(state.extraEvents) ? state.extraEvents : []),
        extraParticipants: clone(Array.isArray(state.extraParticipants) ? state.extraParticipants : []),
        attendance: clone(state.attendance && typeof state.attendance === "object" ? state.attendance : {}),
        payments: clone(Array.isArray(state.payments) ? state.payments : []),
        otherIncomes: clone(Array.isArray(state.otherIncomes) ? state.otherIncomes : []),
        expenses: clone(Array.isArray(state.expenses) ? state.expenses : []),
        proposals: clone(Array.isArray(state.proposals) ? state.proposals : []),
        expenseCategories: clone(Array.isArray(state.expenseCategories) ? state.expenseCategories : []),
        agendaEvents: clone(Array.isArray(state.agendaEvents) ? state.agendaEvents : []),
        bankAccounts: clone(Array.isArray(state.bankAccounts) ? state.bankAccounts : []),
        bankMovements: clone(Array.isArray(state.bankMovements) ? state.bankMovements : []),
        paymentExclusions: clone(Array.isArray(state.paymentExclusions) ? state.paymentExclusions : []),
        rentalManagement: clone(state.rentalManagement && typeof state.rentalManagement === "object" ? state.rentalManagement : {}),
        settings: safeSettingsForSync(),
      };
    }

    function idsSnapshot(payload = criticalState()) {
      return {
        students: payload.students.map((item) => String(item.id || "")).filter(Boolean),
        activityCatalog: payload.activityCatalog.map((item) => String(item.id || "")).filter(Boolean),
        extraEvents: payload.extraEvents.map((item) => String(item.id || "")).filter(Boolean),
        extraParticipants: payload.extraParticipants.map((item) => String(item.id || "")).filter(Boolean),
        payments: payload.payments.map((item) => String(item.id || "")).filter(Boolean),
      };
    }

    function deletedSinceLast(payload) {
      const previous = readJSON(SNAPSHOT_KEY, null);
      if (!previous) return {};
      const current = idsSnapshot(payload);
      const result = {};
      Object.keys(current).forEach((key) => {
        const active = new Set(current[key]);
        result[key] = (Array.isArray(previous[key]) ? previous[key] : []).filter((id) => !active.has(id));
      });
      return result;
    }

    function fingerprint(payload = criticalState()) {
      return JSON.stringify(payload);
    }

    function businessClone(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      const result = {};
      Object.entries(value).forEach(([key, item]) => {
        if (key === "updatedAt" || key.startsWith("_")) return;
        result[key] = clone(item);
      });
      return result;
    }

    function stableValue(value) {
      if (Array.isArray(value)) return value.map(stableValue);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
      );
    }

    function sameBusinessValue(first, second) {
      return JSON.stringify(stableValue(businessClone(first)))
        === JSON.stringify(stableValue(businessClone(second)));
    }

    function changedFields(base = {}, value = {}) {
      const a = businessClone(base);
      const b = businessClone(value);
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      return [...keys].filter(
        (key) => JSON.stringify(stableValue(a[key])) !== JSON.stringify(stableValue(b[key])),
      );
    }

    function mapById(items = []) {
      const result = new Map();
      (Array.isArray(items) ? items : []).forEach((item) => {
        const id = String(item?.id || "");
        if (id) result.set(id, clone(item));
      });
      return result;
    }

    function attendanceWindowStart() {
      const value = new Date();
      value.setUTCDate(value.getUTCDate() - ATTENDANCE_WINDOW_DAYS);
      return value.toISOString().slice(0, 10);
    }

    function mergeAttendanceWindow(local = {}, remote = {}) {
      const cutoff = attendanceWindowStart();
      const result = {};
      Object.entries(local && typeof local === "object" ? local : {}).forEach(([day, records]) => {
        if (String(day) < cutoff) result[day] = clone(records);
      });
      Object.entries(remote && typeof remote === "object" ? remote : {}).forEach(([day, records]) => {
        result[day] = clone(records);
      });
      return result;
    }

    function buildAttendanceChanges(base = {}, local = {}) {
      const result = {};
      const cutoff = attendanceWindowStart();
      const lastSyncMs = Date.parse(localStorage.getItem(LAST_SYNC_KEY) || "") || 0;

      Object.entries(local && typeof local === "object" ? local : {}).forEach(([day, records]) => {
        Object.entries(records && typeof records === "object" ? records : {}).forEach(([studentId, record]) => {
          const previous = base?.[day]?.[studentId];
          const currentJson = JSON.stringify(stableValue(record || {}));
          const previousJson = JSON.stringify(stableValue(previous || {}));
          if (previous && currentJson === previousJson) return;

          const updatedMs = Date.parse(record?.updatedAt || "") || 0;
          if (!previous && String(day) < cutoff && updatedMs <= lastSyncMs) return;

          result[day] ||= {};
          result[day][studentId] = clone(record);
        });
      });
      return result;
    }

    function hasAttendanceChanges(value = {}) {
      return Object.values(value).some(
        (records) => records && typeof records === "object" && Object.keys(records).length > 0,
      );
    }

    function syncEndpointForAttendance(attendance = {}) {
      const days = Object.keys(attendance || {}).sort();
      const since = days.length && days[0] < attendanceWindowStart()
        ? days[0]
        : attendanceWindowStart();
      return `${SYNC_ENDPOINT}?attendanceSince=${encodeURIComponent(since)}`;
    }

    function markerValue(revision, updatedAt) {
      return `${Number(revision || 0)}:${String(updatedAt || "")}`;
    }

    function persistBase(remote, revision) {
      const next = clone(remote && typeof remote === "object" ? remote : {});
      next.attendance = mergeAttendanceWindow(baseState?.attendance || {}, next.attendance || {});
      baseState = next;
      baseRevision = Number(revision || 0);
      lastRemoteMarker = markerValue(baseRevision, next.updatedAt || "");
      writeJSON(BASE_STATE_KEY, baseState);
      try { localStorage.setItem(BASE_REVISION_KEY, String(baseRevision)); } catch {}
    }

    function buildChanges(base = {}, local = {}) {
      const changes = {};
      const changedAt = new Date().toISOString();

      LIST_RESOURCES.forEach((resource) => {
        const baseItems = mapById(base?.[resource]);
        const localItems = mapById(local?.[resource]);
        const upserts = [];
        const tombstones = [];

        localItems.forEach((item, id) => {
          const previous = baseItems.get(id);
          if (!previous || !sameBusinessValue(previous, item)) {
            upserts.push({
              id,
              base: previous || {},
              baseUpdatedAt: String(previous?.updatedAt || ""),
              value: { ...clone(item), updatedAt: changedAt },
            });
          }
        });

        baseItems.forEach((item, id) => {
          if (!localItems.has(id)) {
            tombstones.push({
              id,
              base: clone(item),
              baseUpdatedAt: String(item?.updatedAt || ""),
              deletedAt: changedAt,
            });
          }
        });

        if (upserts.length || tombstones.length) {
          changes[resource] = { upserts, tombstones };
        }
      });

      OBJECT_RESOURCES.forEach((resource) => {
        const previous = base?.[resource] && typeof base[resource] === "object" ? base[resource] : {};
        const current = local?.[resource] && typeof local[resource] === "object" ? local[resource] : {};
        if (!sameBusinessValue(previous, current)) {
          changes[resource] = {
            upserts: [{
              id: "default",
              base: clone(previous),
              value: clone(current),
            }],
            tombstones: [],
          };
        }
      });

      return changes;
    }

    function hasChanges(changes = {}) {
      return Object.values(changes).some((entry) => (
        (Array.isArray(entry?.upserts) && entry.upserts.length)
        || (Array.isArray(entry?.tombstones) && entry.tombstones.length)
      ));
    }

    function applyFieldIntent(remoteItem, change) {
      const base = change?.base && typeof change.base === "object" ? change.base : {};
      const local = change?.value && typeof change.value === "object" ? change.value : {};
      const remote = remoteItem && typeof remoteItem === "object" ? clone(remoteItem) : null;
      if (!remote) return clone(local);

      const result = clone(remote);
      changedFields(base, local).forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(local, field)) result[field] = clone(local[field]);
        else delete result[field];
      });
      if (local.id) result.id = local.id;
      result.updatedAt = local.updatedAt || new Date().toISOString();
      return result;
    }

    function reapplyLocalChanges(remote = {}, changes = {}, localAttendance = {}) {
      const result = clone(remote && typeof remote === "object" ? remote : {});

      LIST_RESOURCES.forEach((resource) => {
        const index = mapById(result[resource]);
        const entry = changes?.[resource] || {};
        (Array.isArray(entry.upserts) ? entry.upserts : []).forEach((change) => {
          const id = String(change?.id || change?.value?.id || "");
          if (!id) return;
          index.set(id, applyFieldIntent(index.get(id), change));
        });
        (Array.isArray(entry.tombstones) ? entry.tombstones : []).forEach((change) => {
          const id = String(change?.id || "");
          if (id) index.delete(id);
        });
        result[resource] = [...index.values()];
      });

      OBJECT_RESOURCES.forEach((resource) => {
        const change = changes?.[resource]?.upserts?.slice?.(-1)?.[0];
        if (!change) return;
        result[resource] = applyFieldIntent(result[resource] || {}, change);
        delete result[resource].id;
        delete result[resource].updatedAt;
      });

      result.attendance = mergeAttendance(result.attendance || {}, localAttendance || {});
      return result;
    }

    function localSecuritySettings() {
      return {
        password: state.settings?.password || "",
        passwordHash: state.settings?.passwordHash || "",
        passwordEnabled: state.settings?.passwordEnabled !== false,
        passwordSecurityVersion: state.settings?.passwordSecurityVersion || "4.6.3",
        remoteSync: clone(state.settings?.remoteSync || {}),
      };
    }

    function applyRemoteState(remote, revision, extraChanges = null, attendance = null) {
      let canonical = clone(remote && typeof remote === "object" ? remote : {});
      canonical.attendance = mergeAttendanceWindow(state.attendance || {}, canonical.attendance || {});
      if ((extraChanges && hasChanges(extraChanges)) || hasAttendanceChanges(attendance || {})) {
        canonical = reapplyLocalChanges(canonical, extraChanges || {}, attendance || {});
      }
      const security = localSecuritySettings();
      state = normalizeState({
        ...state,
        ...canonical,
        settings: {
          ...(state.settings || {}),
          ...(canonical.settings || {}),
          ...security,
        },
      });
      originalFlushSaveState({ skipRemote: true, skipMarkLocal: true });
      renderAll();
      persistBase(remote || {}, revision);
      return criticalState();
    }

    function setSupabaseStatus(message, tone = "") {
      const box = document.querySelector("#supabaseSyncStatus");
      if (box) {
        box.textContent = message;
        box.dataset.tone = tone;
      }
    }

    function injectSupabaseCard() {
      if (document.querySelector("#supabaseSyncCard")) return;
      const pane = document.querySelector('[data-settings-pane-content="remote"]');
      if (!pane) return;
      const card = document.createElement("div");
      card.id = "supabaseSyncCard";
      card.className = "settings-card remote-sync-card";
      card.innerHTML = `
        <h3>Banco Supabase</h3>
        <p>Cadastros, chamada, mensalidades, despesas, contas bancárias e demais dados operacionais são sincronizados entre os computadores.</p>
        <div class="remote-sync-status-box">
          <span>Status</span>
          <strong id="supabaseSyncStatus">Verificando conexão...</strong>
          <small>Senhas e a chave de sincronização permanecem somente neste dispositivo.</small>
        </div>
        <div class="form-actions">
          <button type="button" id="supabasePushNow">Enviar dados atuais</button>
          <button type="button" class="secondary" id="supabasePullNow">Baixar dados do Supabase</button>
        </div>`;
      pane.appendChild(card);

      card.querySelector("#supabasePushNow")?.addEventListener("click", () => syncNow({ force: true, manual: true }));
      card.querySelector("#supabasePullNow")?.addEventListener("click", () => pullNow({ manual: true, force: true }));
    }

    function stopBlobLoops() {
      try { clearTimeout(remoteSyncTimer); } catch {}
      try { clearInterval(remoteLivePollTimer); } catch {}
      try { clearInterval(teacherAttendancePollTimer); } catch {}
      try { remoteSyncPendingReason = ""; } catch {}
      const sync = state?.settings?.remoteSync;
      if (sync) {
        sync.autoSync = false;
        sync.enabled = false;
        sync.lastStatus = "Supabase ativo para os dados operacionais e financeiros. Vercel Blob mantido apenas como legado/backup manual.";
      }
      try { renderRemoteSyncSettings(); } catch {}
    }

    async function request(url, options = {}) {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        },
      });
      let data = {};
      try { data = await response.json(); } catch { data = {}; }
      if (!response.ok || data.ok === false) {
        const error = new Error(data.error || `Erro HTTP ${response.status}`);
        error.status = response.status;
        error.code = String(data.code || "");
        error.data = data;
        throw error;
      }
      return data;
    }

    function queuePush(delay = PUSH_DELAY_MS) {
      clearTimeout(pushTimer);
      if (!ready || busy || !pendingPush) return;
      pushTimer = setTimeout(() => syncNow(), delay);
    }

    function markLocalChange() {
      localRevision += 1;
      persistPendingPush();
      retryPush = false;
      queuePush();
    }

    function syncEnvelope(payload = criticalState()) {
      const changes = buildChanges(baseState || {}, payload);
      return {
        protocolVersion: PROTOCOL_VERSION,
        baseRevision,
        changes,
        attendance: buildAttendanceChanges(baseState?.attendance || {}, payload.attendance || {}),
        clientId: clientId(),
        source: "saber-mais-admin-v2",
      };
    }

    function flushPendingKeepalive() {
      if (!pendingPush) return false;
      persistPendingPush();
      const key = syncKey();
      if (key.length < 6) return false;

      if (!baseState) return false;
      const envelope = syncEnvelope();
      const body = JSON.stringify(envelope);
      const size = new TextEncoder().encode(body).byteLength;
      if (size > KEEPALIVE_MAX_BYTES) return false;

      try {
        const pending = fetch(syncEndpointForAttendance(envelope.attendance), {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          keepalive: true,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-sync-key": key,
          },
          body,
        });
        pending?.catch?.(() => {});
        return true;
      } catch {
        return false;
      }
    }

    function mergeLegacyPendingState(remote = {}, local = {}) {
      const result = { ...clone(remote), ...clone(local) };
      LIST_RESOURCES.forEach((resource) => {
        result[resource] = mergeById(remote?.[resource], local?.[resource], []);
      });
      result.attendance = mergeAttendance(remote.attendance || {}, local.attendance || {});
      OBJECT_RESOURCES.forEach((resource) => {
        result[resource] = {
          ...(remote?.[resource] || {}),
          ...(local?.[resource] || {}),
        };
      });
      return result;
    }

    async function seedBaseFromServer(key) {
      const local = criticalState();
      const result = await request(SYNC_ENDPOINT, {
        method: "GET",
        headers: { "x-sync-key": key },
      });
      const remote = result.data || {};
      persistBase(remote, result.revision || 0);

      // Migração segura da versão anterior: mantém a intenção local, mas nunca
      // transforma um registro existente apenas no servidor em exclusão.
      const rebased = mergeLegacyPendingState(remote, local);
      const security = localSecuritySettings();
      state = normalizeState({
        ...state,
        ...rebased,
        settings: {
          ...(state.settings || {}),
          ...(rebased.settings || {}),
          ...security,
        },
      });
      originalFlushSaveState({ skipRemote: true, skipMarkLocal: true });
      renderAll();
      return result;
    }

    async function rebaseConflict(error, submittedChanges, submittedAttendance) {
      const remote = error?.data?.data || {};
      const revision = Number(error?.data?.revision || 0);
      persistBase(remote, revision);
      const remoteWithHistory = {
        ...clone(remote),
        attendance: mergeAttendanceWindow(state.attendance || {}, remote.attendance || {}),
      };
      const rebased = reapplyLocalChanges(remoteWithHistory, submittedChanges, submittedAttendance);
      const security = localSecuritySettings();
      state = normalizeState({
        ...state,
        ...rebased,
        settings: {
          ...(state.settings || {}),
          ...(rebased.settings || {}),
          ...security,
        },
      });
      originalFlushSaveState({ skipRemote: true, skipMarkLocal: true });
      renderAll();
      persistPendingPush();
      return true;
    }

    async function syncNow(options = {}) {
      if (busy) {
        persistPendingPush();
        return false;
      }
      const key = syncKey();
      if (key.length < 6) {
        persistPendingPush();
        setSupabaseStatus("Informe novamente a chave de sincronização nas configurações.", "warn");
        if (options.manual) showToast("A chave de sincronização local está vazia.");
        return false;
      }

      if (!baseState) {
        try {
          await seedBaseFromServer(key);
        } catch (error) {
          persistPendingPush();
          retryPush = true;
          setSupabaseStatus(`Não consegui preparar a base de sincronização: ${error.message || "erro desconhecido"}`, "error");
          return false;
        }
      }

      const payload = criticalState();
      const submittedChanges = buildChanges(baseState || {}, payload);
      const submittedAttendance = buildAttendanceChanges(
        baseState?.attendance || {},
        payload.attendance || {},
      );
      const nextFingerprint = fingerprint(payload);
      if (!options.force && !pendingPush && !hasChanges(submittedChanges) && nextFingerprint === lastFingerprint) return true;

      const revisionAtStart = localRevision;
      busy = true;
      setSupabaseStatus("Enviando alterações para o banco...", "working");
      try {
        const result = await request(syncEndpointForAttendance(submittedAttendance), {
          method: "POST",
          headers: { "x-sync-key": key },
          body: JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            baseRevision,
            changes: submittedChanges,
            attendance: submittedAttendance,
            clientId: clientId(),
            source: "saber-mais-admin-v2",
          }),
        });

        const latest = criticalState();
        const laterChanges = localRevision !== revisionAtStart
          ? buildChanges(payload, latest)
          : {};
        const laterAttendance = localRevision !== revisionAtStart
          ? buildAttendanceChanges(payload.attendance || {}, latest.attendance || {})
          : {};

        const applied = applyRemoteState(
          result.data || {},
          result.revision || baseRevision,
          laterChanges,
          laterAttendance,
        );
        writeJSON(SNAPSHOT_KEY, idsSnapshot(applied));
        localStorage.setItem(LAST_SYNC_KEY, result.updatedAt || new Date().toISOString());
        lastFingerprint = fingerprint(applied);
        ready = true;
        retryPush = false;
        pendingPush = localRevision !== revisionAtStart && (
          hasChanges(laterChanges)
          || hasAttendanceChanges(laterAttendance)
        );
        if (pendingPush) persistPendingPush();
        else clearPendingPush();
        stopBlobLoops();
        setSupabaseStatus(
          pendingPush
            ? "Alteração confirmada; há uma edição mais recente aguardando envio."
            : `Sincronizado na revisão ${Number(result.revision || baseRevision)}.`,
          pendingPush ? "working" : "ok",
        );
        if (options.manual) showToast(pendingPush ? "Há uma alteração mais recente aguardando envio." : "Dados sincronizados.");
        return true;
      } catch (error) {
        if (
          error.status === 409
          && ["MERGE_CONFLICT", "REMOTE_CONFLICT"].includes(error.code)
          && !options.conflictRetry
          && error.data?.data
        ) {
          try {
            await rebaseConflict(error, submittedChanges, submittedAttendance);
            busy = false;
            return await syncNow({ ...options, force: true, conflictRetry: true });
          } catch (conflictError) {
            console.error("Falha ao reaplicar alterações após conflito", conflictError);
          }
        }
        persistPendingPush();
        retryPush = true;
        console.error("Falha ao sincronizar banco", error);
        setSupabaseStatus(`Falha: ${error.message || "erro desconhecido"}. Alteração local preservada.`, "error");
        if (options.manual) showToast("Não consegui sincronizar. A alteração local foi preservada.");
        return false;
      } finally {
        busy = false;
        if (pendingPush && ready) queuePush(retryPush ? PUSH_RETRY_MS : PUSH_DELAY_MS);
      }
    }

    function mergeAttendance(remote = {}, local = {}) {
      const result = clone(remote && typeof remote === "object" ? remote : {});
      Object.entries(local && typeof local === "object" ? local : {}).forEach(([date, day]) => {
        result[date] ||= {};
        Object.entries(day && typeof day === "object" ? day : {}).forEach(([studentId, record]) => {
          const current = result[date][studentId];
          const remoteTime = Date.parse(current?.updatedAt || "") || 0;
          const localTime = Date.parse(record?.updatedAt || "") || 0;
          if (!current || localTime >= remoteTime) result[date][studentId] = record;
        });
      });
      return result;
    }

    function mergeById(remoteItems = [], localItems = [], deletedIds = []) {
      const deleted = new Set((Array.isArray(deletedIds) ? deletedIds : []).map((id) => String(id || "")));
      const byId = new Map();
      (Array.isArray(remoteItems) ? remoteItems : []).forEach((item) => {
        const id = String(item?.id || "");
        if (id && !deleted.has(id)) byId.set(id, clone(item));
      });
      (Array.isArray(localItems) ? localItems : []).forEach((item) => {
        const id = String(item?.id || "");
        if (!id || deleted.has(id)) return;
        byId.set(id, { ...(byId.get(id) || {}), ...clone(item) });
      });
      return [...byId.values()];
    }

    function mergeConflictState(remote = {}, local = {}) {
      const deleted = deletedSinceLast(local);
      const result = { ...clone(remote), ...clone(local) };
      [
        "students", "activityCatalog", "extraEvents", "extraParticipants", "payments",
        "otherIncomes", "expenses", "proposals", "expenseCategories", "agendaEvents",
        "bankAccounts", "bankMovements", "paymentExclusions",
      ].forEach((key) => {
        result[key] = mergeById(remote[key], local[key], deleted[key]);
      });
      result.attendance = mergeAttendance(remote.attendance || {}, local.attendance || {});
      result.rentalManagement = {
        ...(remote.rentalManagement || {}),
        ...(local.rentalManagement || {}),
      };
      result.settings = {
        ...(remote.settings || {}),
        ...(local.settings || {}),
      };
      return result;
    }

    async function mergeRemoteConflict(key) {
      const local = criticalState();
      const result = await request(SYNC_ENDPOINT, {
        method: "GET",
        headers: { "x-sync-key": key },
      });
      const remote = result.data || {};
      const localSecurity = {
        password: state.settings?.password || "",
        passwordHash: state.settings?.passwordHash || "",
        passwordEnabled: state.settings?.passwordEnabled !== false,
        passwordSecurityVersion: state.settings?.passwordSecurityVersion || "4.6.3",
        remoteSync: clone(state.settings?.remoteSync || {}),
      };
      const merged = mergeConflictState(remote, local);
      state = normalizeState({
        ...state,
        ...merged,
        settings: {
          ...(state.settings || {}),
          ...(merged.settings || {}),
          ...localSecurity,
        },
      });
      originalFlushSaveState({ skipRemote: true, skipMarkLocal: true });
      renderAll();
      persistPendingPush();
      return true;
    }

    function hasRemoteData(remote = {}) {
      const arrayKeys = [
        "students", "activityCatalog", "extraEvents", "extraParticipants", "payments",
        "otherIncomes", "expenses", "proposals", "expenseCategories", "agendaEvents",
        "bankAccounts", "bankMovements", "paymentExclusions",
      ];
      if (arrayKeys.some((key) => Array.isArray(remote[key]) && remote[key].length)) return true;
      if (remote.rentalManagement && Object.keys(remote.rentalManagement).length) return true;
      if (remote.settings && Object.keys(remote.settings).length) return true;
      return false;
    }

    async function pollRevision() {
      if (busy || pendingPush || document.hidden) return false;
      const key = syncKey();
      if (key.length < 6) return false;
      try {
        const result = await request(REVISION_ENDPOINT, {
          method: "GET",
          headers: { "x-sync-key": key },
        });
        const marker = markerValue(result.revision, result.updatedAt);
        if (!lastRemoteMarker) {
          lastRemoteMarker = marker;
          return false;
        }
        if (marker === lastRemoteMarker) return false;
        await pullNow({ force: true, revisionPoll: true });
        return true;
      } catch (error) {
        console.error("Falha ao consultar revisão do banco", error);
        return false;
      }
    }

    async function pullNow(options = {}) {
      if (busy) return false;
      const key = syncKey();
      if (key.length < 6) return false;
      if (pendingPush) {
        setSupabaseStatus("Há uma alteração local aguardando envio; atualização remota adiada.", "working");
        if (options.manual) showToast("Sincronize as alterações locais antes de baixar do banco.");
        queuePush();
        return false;
      }

      const revisionAtStart = localRevision;
      busy = true;
      setSupabaseStatus("Baixando dados do banco...", "working");
      try {
        const result = await request(SYNC_ENDPOINT, {
          method: "GET",
          headers: { "x-sync-key": key },
        });

        if (pendingPush || localRevision !== revisionAtStart) {
          persistPendingPush();
          setSupabaseStatus("Alteração local detectada durante a atualização; dados remotos não foram aplicados.", "working");
          if (options.manual) showToast("A atualização remota foi adiada para preservar sua alteração.");
          return false;
        }

        const remote = result.data || {};
        if (!hasRemoteData(remote) && !options.force) return false;

        const applied = applyRemoteState(remote, result.revision || 0);
        lastFingerprint = fingerprint(applied);
        writeJSON(SNAPSHOT_KEY, idsSnapshot(applied));
        localStorage.setItem(LAST_SYNC_KEY, remote.updatedAt || result.updatedAt || new Date().toISOString());
        ready = true;
        retryPush = false;
        clearPendingPush();
        stopBlobLoops();
        setSupabaseStatus(`Dados atualizados na revisão ${Number(result.revision || 0)}.`, "ok");
        if (options.manual) showToast("Dados do banco aplicados.");
        return true;
      } catch (error) {
        console.error("Falha ao baixar dados", error);
        setSupabaseStatus(`Falha: ${error.message || "erro desconhecido"}`, "error");
        if (options.manual) showToast("Não consegui baixar os dados.");
        return false;
      } finally {
        busy = false;
        if (pendingPush && ready) queuePush();
      }
    }

    async function initialize() {
      injectSupabaseCard();
      setSupabaseStatus("Preparando banco Supabase...", "working");
      try {
        const health = await request(HEALTH_ENDPOINT, { method: "GET" });
        ready = health.schemaReady === true;
        if (!ready) throw new Error("As tabelas ainda não foram preparadas.");
        stopBlobLoops();

        const local = criticalState();
        const localHasData = hasRemoteData(local);

        if (pendingPush) {
          if (!baseState) await seedBaseFromServer(syncKey());
          await syncNow({ force: true, recovery: true });
        } else {
          const remoteResult = await request(SYNC_ENDPOINT, {
            method: "GET",
            headers: { "x-sync-key": syncKey() },
          });
          const remote = remoteResult.data || {};
          const remoteHasData = hasRemoteData(remote)
            || Object.keys(remote.attendance || {}).length > 0;
          persistBase(remote, remoteResult.revision || 0);

          if (remoteHasData) {
            const applied = applyRemoteState(remote, remoteResult.revision || 0);
            lastFingerprint = fingerprint(applied);
            writeJSON(SNAPSHOT_KEY, idsSnapshot(applied));
            clearPendingPush();
            setSupabaseStatus(`Dados atualizados na revisão ${Number(remoteResult.revision || 0)}.`, "ok");
          } else if (localHasData) {
            persistPendingPush();
            await syncNow({ force: true });
          } else {
            setSupabaseStatus("Conectado. O banco está vazio e aguardando os primeiros cadastros.", "ok");
          }
        }

        clearInterval(pullTimer);
        pullTimer = setInterval(() => {
          pollRevision().catch(() => {});
        }, PULL_INTERVAL_MS);
      } catch (error) {
        ready = false;
        console.error("Inicialização Supabase", error);
        setSupabaseStatus(`Não conectado: ${error.message || "erro desconhecido"}`, "error");
      }
    }

    saveState = function saveStateWithSupabase(options = {}) {
      originalSaveState({ ...options, skipRemote: true });
      markLocalChange();
    };

    flushSaveState = function flushSaveStateWithSupabase(options = {}) {
      originalFlushSaveState({ ...options, skipRemote: true });
      markLocalChange();
    };

    try {
      window.saveState = saveState;
      window.flushSaveState = flushSaveState;
    } catch {}

    window.__saberMaisSupabase = {
      syncNow: () => syncNow({ force: true, manual: true }),
      pullNow: () => pullNow({ force: true, manual: true }),
      pullSilent: () => pullNow({ force: true }),
      flushBeforeUnload: flushPendingKeepalive,
      status: () => ({
        ready,
        busy,
        pendingPush,
        localRevision,
        lastSyncAt: localStorage.getItem(LAST_SYNC_KEY) || "",
        pendingSince: readJSON(PENDING_KEY, {})?.updatedAt || "",
        baseRevision,
        remoteMarker: lastRemoteMarker,
        protocolVersion: PROTOCOL_VERSION,
      }),
    };

    window.setTimeout(initialize, 250);

    // Carrega a próxima camada somente depois de instalar todos os wrappers acima.
    if (!document.querySelector('script[data-extra-event-attendance-id-fix]')) {
      const script = document.createElement("script");
      script.src = "extra-event-attendance-id-fix.js?v=2";
      script.async = false;
      script.dataset.extraEventAttendanceIdFix = "true";
      document.body.appendChild(script);
    }
  }

  loadStabilityAndBoot();
})();
