// Persistência transitória durante a sessão ativa.
// Não cria cópias de backup locais; backups permanentes pertencem ao servidor.
(() => {
  if (window.__smgLocalPersistenceReliabilityLoaded) return;
  window.__smgLocalPersistenceReliabilityLoaded = true;

  const STORAGE_KEY = "arteDeAprenderERP.v4";
  const nativeSetItem = Storage.prototype.setItem;
  let warningShown = false;

  function isForbiddenBackupKey(key = "") {
    const value = String(key || "");
    return value.startsWith("arteDeAprenderERP.autoBackup.")
      || value.startsWith("arteDeAprenderERP.childrenBackup.")
      || value.includes("_backup_erro_");
  }

  function notifyStorageProblem() {
    if (warningShown) return;
    warningShown = true;
    const message = "Não foi possível manter o estado temporário neste navegador. Verifique o espaço disponível e a conexão.";
    try {
      if (typeof window.showToast === "function") window.showToast(message);
    } catch {}
    console.error("Arte de Aprender ERP: falha ao gravar estado transitório no navegador.");
  }

  function isQuotaError(error) {
    return error?.name === "QuotaExceededError"
      || error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
      || error?.code === 22
      || error?.code === 1014;
  }

  Storage.prototype.setItem = function onlineOnlySetItem(key, value) {
    if (this === localStorage && isForbiddenBackupKey(key)) return;
    try {
      nativeSetItem.call(this, key, value);
    } catch (error) {
      if (isQuotaError(error)) notifyStorageProblem();
      throw error;
    }
  };

  function removeLegacyLocalBackups() {
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (isForbiddenBackupKey(key)) keys.push(key);
      }
      keys.forEach((key) => localStorage.removeItem(key));
    } catch {}
  }

  function flushPendingSave() {
    try {
      if (typeof window.flushSaveState === "function") {
        window.flushSaveState({ skipMarkLocal: false, skipRemote: false });
        return;
      }
      if (window.state) nativeSetItem.call(localStorage, STORAGE_KEY, JSON.stringify(window.state));
    } catch (error) {
      if (isQuotaError(error)) notifyStorageProblem();
      else console.warn("Arte de Aprender ERP: não foi possível concluir o salvamento transitório.", error);
    }
  }

  removeLegacyLocalBackups();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSave();
  });
  window.addEventListener("pagehide", flushPendingSave);
})();
