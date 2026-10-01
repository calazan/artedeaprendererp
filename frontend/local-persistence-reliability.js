// Confiabilidade local do SMG: protege gravações, limita backups e faz flush ao sair.
(() => {
  if (window.__smgLocalPersistenceReliabilityLoaded) return;
  window.__smgLocalPersistenceReliabilityLoaded = true;

  const STORAGE_KEY = "arteDeAprenderERP.v4";
  const AUTO_PREFIX = "arteDeAprenderERP.autoBackup.";
  const CHILDREN_PREFIX = "arteDeAprenderERP.childrenBackup.";
  const ERROR_PREFIX = `${STORAGE_KEY}_backup_erro_`;
  const RETENTION = { [AUTO_PREFIX]: 3, [CHILDREN_PREFIX]: 3, [ERROR_PREFIX]: 2 };
  const nativeSetItem = Storage.prototype.setItem;
  let warningShown = false;

  function backupKeys(prefix) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys.sort().reverse();
  }

  function prunePrefix(prefix, keep) {
    backupKeys(prefix).slice(keep).forEach((key) => {
      try { localStorage.removeItem(key); } catch {}
    });
  }

  function pruneBackups() {
    Object.entries(RETENTION).forEach(([prefix, keep]) => prunePrefix(prefix, keep));
  }

  function notifyStorageProblem() {
    if (warningShown) return;
    warningShown = true;
    const message = "Armazenamento local cheio. Backups antigos foram limpos; exporte um backup manual se o aviso voltar.";
    try {
      if (typeof window.showToast === "function") window.showToast(message);
      else {
        const toast = document.querySelector("#toast");
        if (toast) {
          toast.textContent = message;
          toast.classList.add("is-visible");
        }
      }
    } catch {}
    console.error("SMG: falha ao gravar no armazenamento local por falta de espaço.");
  }

  function isQuotaError(error) {
    return error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED" || error?.code === 22 || error?.code === 1014;
  }

  Storage.prototype.setItem = function smgReliableSetItem(key, value) {
    if (this !== localStorage) return nativeSetItem.call(this, key, value);
    try {
      nativeSetItem.call(this, key, value);
      if (String(key).startsWith(AUTO_PREFIX) || String(key).startsWith(CHILDREN_PREFIX) || String(key).startsWith(ERROR_PREFIX)) {
        pruneBackups();
      }
      return;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      pruneBackups();
      // Segunda tentativa após liberar as cópias redundantes.
      try {
        nativeSetItem.call(this, key, value);
        notifyStorageProblem();
        return;
      } catch (retryError) {
        notifyStorageProblem();
        throw retryError;
      }
    }
  };

  function flushPendingSave() {
    try {
      if (typeof window.flushSaveState === "function") {
        window.flushSaveState({ skipMarkLocal: false, skipRemote: false });
        return;
      }
      if (window.state) nativeSetItem.call(localStorage, STORAGE_KEY, JSON.stringify(window.state));
    } catch (error) {
      if (isQuotaError(error)) notifyStorageProblem();
      else console.warn("SMG: não foi possível concluir o salvamento antes de sair.", error);
    }
  }

  pruneBackups();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSave();
  });
  window.addEventListener("pagehide", flushPendingSave);
})();
