// Integração principal do Arte de Aprender ERP com Neon.
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
    if (window.__saberNeonAdminLoaded) return;
    window.__saberNeonAdminLoaded = true;

    const HEALTH_ENDPOINT = "/api/database-health";
    const SYNC_ENDPOINT = "/api/database-sync";
    const SNAPSHOT_KEY = "arteDeAprenderERP.neon.snapshot.v2";
    const LAST_SYNC_KEY = "arteDeAprenderERP.neon.lastSyncAt";
    const CLIENT_KEY = "arteDeAprenderERP.neon.clientId";
    const PUSH_DELAY_MS = 1400;
    const PUSH_RETRY_MS = 6000;
    const PULL_INTERVAL_MS = 60_000;

    const originalSaveState = saveState;
    const originalFlushSaveState = flushSaveState;
    let pushTimer = null;
    let pullTimer = null;
    let busy = false;
    let ready = false;
    let lastFingerprint = "";
    let localRevision = 0;
    let remoteRevision = 0;
    let pendingPush = false;
    let retryPush = false;

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

    function clientId() {
      let value = localStorage.getItem(CLIENT_KEY);
      if (!value) {
        value = globalThis.crypto?.randomUUID?.() || `neon-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

    function setNeonStatus(message, tone = "") {
      const box = document.querySelector("#neonSyncStatus");
      if (box) {
        box.textContent = message;
        box.dataset.tone = tone;
      }
    }

    function injectNeonCard() {
      if (document.querySelector("#neonSyncCard")) return;
      const pane = document.querySelector('[data-settings-pane-content="remote"]');
      if (!pane) return;
      const card = document.createElement("div");
      card.id = "neonSyncCard";
      card.className = "settings-card remote-sync-card";
      card.innerHTML = `
        <h3>Banco Neon</h3>
        <p>Cadastros, chamada, mensalidades, despesas, contas bancárias e demais dados operacionais são sincronizados entre os computadores.</p>
        <div class="remote-sync-status-box">
          <span>Status</span>
          <strong id="neonSyncStatus">Verificando conexão...</strong>
          <small>Senhas e a chave de sincronização permanecem somente neste dispositivo.</small>
        </div>
        <div class="form-actions">
          <button type="button" id="neonPushNow">Enviar dados atuais</button>
          <button type="button" class="secondary" id="neonPullNow">Baixar dados do Neon</button>
        </div>`;
      pane.appendChild(card);

      card.querySelector("#neonPushNow")?.addEventListener("click", () => syncNow({ force: true, manual: true }));
      card.querySelector("#neonPullNow")?.addEventListener("click", () => pullNow({ manual: true, force: true }));
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
        sync.lastStatus = "Neon ativo para os dados operacionais e financeiros.";
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
      pendingPush = true;
      retryPush = false;
      queuePush();
    }

    async function syncNow(options = {}) {
      if (busy) {
        pendingPush = true;
        return false;
      }
      const key = syncKey();
      const payload = criticalState();
      const nextFingerprint = fingerprint(payload);
      if (!options.force && !pendingPush && nextFingerprint === lastFingerprint) return true;

      const revisionAtStart = localRevision;
      busy = true;
      setNeonStatus("Sincronizando alterações...", "working");
      try {
        const deleted = deletedSinceLast(payload);
        const result = await request(SYNC_ENDPOINT, {
          method: "POST",
          headers: key.length >= 32 ? { "x-sync-key": key } : {},
          body: JSON.stringify({
            state: payload,
            deleted,
            clientId: clientId(),
            source: "arte-de-aprender-admin",
            baseRevision: remoteRevision,
            force: options.force === true,
          }),
        });
        writeJSON(SNAPSHOT_KEY, idsSnapshot(payload));
        remoteRevision = Number(result.revision || remoteRevision || 0);
        localStorage.setItem(LAST_SYNC_KEY, result.updatedAt || new Date().toISOString());
        lastFingerprint = nextFingerprint;
        ready = true;
        retryPush = false;
        pendingPush = localRevision !== revisionAtStart;
        stopBlobLoops();
        setNeonStatus(
          pendingPush
            ? "Primeira alteração enviada; há uma edição mais recente aguardando sincronização."
            : `Sincronizado em ${new Date(result.updatedAt || Date.now()).toLocaleString("pt-BR")}.`,
          pendingPush ? "working" : "ok",
        );
        if (options.manual) showToast(pendingPush ? "Há uma alteração mais recente aguardando envio." : "Dados enviados ao Neon.");
        return true;
      } catch (error) {
        pendingPush = true;
        retryPush = true;
        console.error("Falha ao sincronizar Neon", error);
        setNeonStatus(`Falha: ${error.message || "erro desconhecido"}. Alteração local preservada.`, "error");
        if (options.manual) showToast("Não consegui sincronizar com o Neon. A alteração local foi preservada.");
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

    async function pullNow(options = {}) {
      if (busy) return false;
      const key = syncKey();
      if (pendingPush) {
        setNeonStatus("Há uma alteração local aguardando envio; atualização remota adiada.", "working");
        if (options.manual) showToast("Aguarde o envio das alterações locais antes de atualizar.");
        queuePush();
        return false;
      }

      const revisionAtStart = localRevision;
      busy = true;
      setNeonStatus("Atualizando dados do Neon...", "working");
      try {
        const result = await request(SYNC_ENDPOINT, {
          method: "GET",
          headers: key.length >= 32 ? { "x-sync-key": key } : {},
        });

        // Se o usuário salvou enquanto o GET estava em andamento, não aplique o snapshot antigo.
        if (pendingPush || localRevision !== revisionAtStart) {
          pendingPush = true;
          setNeonStatus("Alteração local detectada durante a atualização; dados remotos não foram aplicados.", "working");
          if (options.manual) showToast("A atualização remota foi adiada para preservar sua alteração.");
          return false;
        }

        const remote = result.data || {};
        remoteRevision = Number(result.revision || remoteRevision || 0);
        if (!hasRemoteData(remote) && !options.force) return false;

        const localSecurity = {
          password: state.settings?.password || "",
          passwordHash: state.settings?.passwordHash || "",
          passwordEnabled: state.settings?.passwordEnabled !== false,
          passwordSecurityVersion: state.settings?.passwordSecurityVersion || "4.6.3",
          remoteSync: clone(state.settings?.remoteSync || {}),
        };
        const mergedAttendance = mergeAttendance(remote.attendance || {}, state.attendance || {});
        const mergedInput = {
          ...state,
          ...remote,
          attendance: mergedAttendance,
          settings: {
            ...(state.settings || {}),
            ...(remote.settings || {}),
            ...localSecurity,
          },
        };

        state = normalizeState(mergedInput);
        originalFlushSaveState({ skipRemote: true, skipMarkLocal: true });
        renderAll();

        const payload = criticalState();
        lastFingerprint = fingerprint(payload);
        writeJSON(SNAPSHOT_KEY, idsSnapshot(payload));
        localStorage.setItem(LAST_SYNC_KEY, remote.updatedAt || result.updatedAt || new Date().toISOString());
        ready = true;
        retryPush = false;
        stopBlobLoops();
        setNeonStatus(`Dados atualizados em ${new Date(remote.updatedAt || result.updatedAt || Date.now()).toLocaleString("pt-BR")}.`, "ok");
        if (options.manual) showToast("Dados do Neon atualizados.");
        return true;
      } catch (error) {
        console.error("Falha ao atualizar pelo Neon", error);
        setNeonStatus(`Falha: ${error.message || "erro desconhecido"}`, "error");
        if (options.manual) showToast("Não consegui atualizar pelo Neon.");
        return false;
      } finally {
        busy = false;
        if (pendingPush && ready) queuePush();
      }
    }

    async function initialize() {
      injectNeonCard();
      setNeonStatus("Verificando banco Neon...", "working");
      try {
        const health = await request(HEALTH_ENDPOINT, { method: "GET" });
        ready = health.schemaReady === true;
        if (!ready) throw new Error("As tabelas ainda não foram preparadas.");
        stopBlobLoops();

        const counts = health.counts || {};
        const total = Number(counts.students || 0)
          + Number(counts.activities || 0)
          + Number(counts.events || 0)
          + Number(counts.participants || 0)
          + Number(counts.payments || 0);
        const local = criticalState();
        const localHasData = hasRemoteData(local);

        if (pendingPush) {
          queuePush(0);
        } else if (total === 0 && localHasData) {
          pendingPush = true;
          await syncNow({ force: true });
        } else if (total > 0) {
          await pullNow({ force: true });
        } else {
          setNeonStatus("Conectado. O banco está vazio e aguardando os primeiros cadastros.", "ok");
        }

        clearInterval(pullTimer);
        pullTimer = setInterval(() => {
          if (!document.hidden && !busy && !pendingPush) pullNow().catch(() => {});
        }, PULL_INTERVAL_MS);
      } catch (error) {
        ready = false;
        console.error("Inicialização Neon", error);
        setNeonStatus(`Não conectado: ${error.message || "erro desconhecido"}`, "error");
      }
    }

    saveState = function saveStateWithNeon(options = {}) {
      originalSaveState({ ...options, skipRemote: true });
      markLocalChange();
    };

    flushSaveState = function flushSaveStateWithNeon(options = {}) {
      originalFlushSaveState({ ...options, skipRemote: true });
      markLocalChange();
    };

    try {
      window.saveState = saveState;
      window.flushSaveState = flushSaveState;
    } catch {}

    const publicSyncApi = {
      syncNow: () => syncNow({ force: true, manual: true }),
      pullNow: () => pullNow({ force: true, manual: true }),
      status: () => ({
        ready,
        busy,
        pendingPush,
        localRevision,
        remoteRevision,
        lastSyncAt: localStorage.getItem(LAST_SYNC_KEY) || "",
      }),
    };
    window.__saberMaisNeon = publicSyncApi;
    window.__arteDeAprenderSync = publicSyncApi;

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
