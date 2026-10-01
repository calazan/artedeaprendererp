(() => {
  const SESSION_KEY = "arteDeAprenderERP.session";
  const STORAGE_PREFIX = "arteDeAprenderERP.";
  const SESSION_SYNC_SENTINEL = "python-session-authenticated-bridge-v1";
  const nativeFetch = window.fetch.bind(window);
  let clearingSession = false;

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

  async function clearClientData() {
    for (const storage of [localStorage, sessionStorage]) {
      prefixedKeys(storage).forEach((key) => {
        try { storage.removeItem(key); } catch {}
      });
    }
    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {}
    }
  }

  async function expireClientSession() {
    if (clearingSession) return;
    clearingSession = true;
    try { await clearClientData(); } finally { location.replace("/login"); }
  }

  window.__arteDeAprenderClearClientData = clearClientData;

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
      state.settings.remoteSync = state.settings.remoteSync && typeof state.settings.remoteSync === "object"
        ? state.settings.remoteSync
        : {};
      Object.assign(state.settings.remoteSync, {
        syncKey: SESSION_SYNC_SENTINEL,
        enabled: true,
        autoSync: true,
        pullOnOpen: true,
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

  function updateRuntimeBranding() {
    if (document.body) document.body.dataset.appVersion = document.body.dataset.appVersion || "";
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
    updateRuntimeBranding();
    window.setTimeout(() => { installSessionCompatibility(); simplifySecurityUi(); }, 500);
    window.setTimeout(() => { installSessionCompatibility(); simplifySecurityUi(); }, 2000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
