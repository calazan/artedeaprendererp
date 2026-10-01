(() => {
  const SESSION_KEY = "arteDeAprenderERP.session";
  // Non-secret compatibility sentinel. The Python backend authorizes API calls by
  // the signed HttpOnly session cookie; this value is never treated as a secret.
  const SESSION_SYNC_SENTINEL = "python-session-authenticated-bridge-v1";

  sessionStorage.setItem(SESSION_KEY, "true");

  async function serverLogout(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      sessionStorage.removeItem(SESSION_KEY);
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
      if (text) text.textContent = "O acesso ao ERP é feito pelo login autorizado no Supabase e por uma sessão segura do backend Python.";
      if (toggle) toggle.hidden = true;
      if (legacyNote) legacyNote.hidden = true;
    }
    if (passwordForm) passwordForm.hidden = true;
  }

  function updateRuntimeBranding() {
    document.body?.setAttribute("data-app-version", "4.8.0");
    if (/V4\.6\.9/i.test(document.title)) document.title = document.title.replace(/V4\.6\.9/i, "V4.8.0");
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
    // Some V4-compatible modules mount after DOMContentLoaded. Re-apply only the
    // session/UI bridge; no secret or remote repository is loaded here.
    window.setTimeout(() => { installSessionCompatibility(); simplifySecurityUi(); }, 500);
    window.setTimeout(() => { installSessionCompatibility(); simplifySecurityUi(); }, 2000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
