(() => {
  const SESSION_KEY = "arteDeAprenderERP.session";
  const STORAGE_PREFIX = "arteDeAprenderERP.";
  const SAFE_PERSISTENT_KEYS = new Set([
    "arteDeAprenderERP.navigationColors.v2",
  ]);
  const LEGACY_INDEXED_DB_NAMES = [
    "arteDeAprenderERPBackupFolder",
  ];
  const nativeFetch = window.fetch.bind(window);
  const nativeStorage = {
    getItem: Storage.prototype.getItem,
    setItem: Storage.prototype.setItem,
    removeItem: Storage.prototype.removeItem,
    clear: Storage.prototype.clear,
  };
  const volatileLocal = new Map();
  const volatileSession = new Map();
  let clearingSession = false;

  function volatileMap(storage) {
    return storage === localStorage ? volatileLocal : volatileSession;
  }

  function shouldVirtualize(storage, key) {
    const value = String(key || "");
    if (!value.startsWith(STORAGE_PREFIX)) return false;
    return storage === sessionStorage || !SAFE_PERSISTENT_KEYS.has(value);
  }

  function prefixedKeys(storage) {
    const keys = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
      }
    } catch {}
    return keys;
  }

  function purgePersistedSensitiveState() {
    for (const storage of [localStorage, sessionStorage]) {
      prefixedKeys(storage).forEach((key) => {
        if (storage === localStorage && SAFE_PERSISTENT_KEYS.has(key)) return;
        try { nativeStorage.removeItem.call(storage, key); } catch {}
      });
    }
  }

  async function deleteLegacyIndexedDb() {
    if (!("indexedDB" in window)) return;
    await Promise.all(LEGACY_INDEXED_DB_NAMES.map((name) => new Promise((resolve) => {
      try {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      } catch {
        resolve();
      }
    })));
  }

  // Execute antes de app.min.js: nenhum snapshot pessoal do namespace ERP
  // permanece no armazenamento persistente. O código legado continua enxergando
  // essas chaves, mas elas vivem somente em memória durante a sessão atual.
  purgePersistedSensitiveState();
  deleteLegacyIndexedDb().catch(() => {});

  Storage.prototype.getItem = function onlineOnlyGetItem(key) {
    if (shouldVirtualize(this, key)) {
      const map = volatileMap(this);
      return map.has(String(key)) ? map.get(String(key)) : null;
    }
    return nativeStorage.getItem.call(this, key);
  };

  Storage.prototype.setItem = function onlineOnlySetItem(key, value) {
    if (shouldVirtualize(this, key)) {
      volatileMap(this).set(String(key), String(value));
      return;
    }
    return nativeStorage.setItem.call(this, key, value);
  };

  Storage.prototype.removeItem = function onlineOnlyRemoveItem(key) {
    if (shouldVirtualize(this, key)) {
      volatileMap(this).delete(String(key));
      return;
    }
    return nativeStorage.removeItem.call(this, key);
  };

  Storage.prototype.clear = function onlineOnlyClear() {
    volatileMap(this).clear();
    return nativeStorage.clear.call(this);
  };

  async function clearClientData() {
    volatileLocal.clear();
    volatileSession.clear();
    for (const storage of [localStorage, sessionStorage]) {
      prefixedKeys(storage).forEach((key) => {
        try { nativeStorage.removeItem.call(storage, key); } catch {}
      });
    }
    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {}
    }
    await deleteLegacyIndexedDb();
  }

  async function expireClientSession() {
    if (clearingSession) return;
    clearingSession = true;
    try { await clearClientData(); } finally { location.replace("/login"); }
  }

  window.__arteDeAprenderClearClientData = clearClientData;
  window.__arteDeAprenderVolatileStorage = {
    local: volatileLocal,
    session: volatileSession,
  };

  window.fetch = async function authenticatedFetch(input, init) {
    const response = await nativeFetch(input, init);
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      if (
        response.status === 401
        && url.origin === location.origin
        && url.pathname.startsWith("/api/")
        && url.pathname !== "/api/auth/login"
      ) {
        await expireClientSession();
      }
    } catch {}
    return response;
  };

  sessionStorage.setItem(SESSION_KEY, "true");

  async function serverLogout(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      await nativeFetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      await clearClientData();
      location.replace("/login");
    }
  }

  function installSessionCompatibility() {
    try {
      if (typeof state !== "object" || !state) return false;
      state.settings = state.settings && typeof state.settings === "object" ? state.settings : {};
      state.settings.passwordEnabled = false;
      state.settings.password = "";
      state.settings.passwordHash = "";
      state.settings.remoteSync = state.settings.remoteSync && typeof state.settings.remoteSync === "object"
        ? state.settings.remoteSync
        : {};
      Object.assign(state.settings.remoteSync, {
        syncKey: "",
        enabled: false,
        autoSync: false,
        pullOnOpen: false,
      });
      return true;
    } catch {
      return false;
    }
  }

  function simplifySecurityUi() {
    document.querySelector(".remote-sync-key-field")?.setAttribute("hidden", "");
    const syncInput = document.querySelector("#remoteSyncKey");
    if (syncInput) {
      syncInput.value = "";
      syncInput.disabled = true;
      syncInput.removeAttribute("required");
    }

    const securityCard = document.querySelector(".security-access-card");
    const passwordForm = document.querySelector("#passwordForm");
    if (securityCard) {
      const title = securityCard.querySelector("h3");
      const text = securityCard.querySelector("p");
      const toggle = securityCard.querySelector('label[for="passwordEnabled"]');
      const legacyNote = [...securityCard.querySelectorAll("small")].find((item) => /2704|senha padrão/i.test(item.textContent || ""));
      if (title) title.textContent = "Acesso protegido pela conta";
      if (text) text.textContent = "O acesso ao ERP é feito por uma conta autorizada e uma sessão segura do backend Python.";
      if (toggle) toggle.hidden = true;
      if (legacyNote) legacyNote.hidden = true;
    }
    if (passwordForm) passwordForm.hidden = true;
  }

  function bind() {
    sessionStorage.setItem(SESSION_KEY, "true");
    const login = document.querySelector("#loginScreen");
    const shell = document.querySelector("#appShell");
    if (login) login.classList.add("is-hidden");
    if (shell) shell.classList.remove("is-hidden");
    document.querySelector("#logoutButton")?.addEventListener("click", serverLogout, true);

    installSessionCompatibility();
    simplifySecurityUi();
    window.setTimeout(() => { installSessionCompatibility(); simplifySecurityUi(); }, 500);
    window.setTimeout(() => { installSessionCompatibility(); simplifySecurityUi(); }, 2000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
