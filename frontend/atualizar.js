(() => {
  async function updateApp() {
    const status = document.querySelector("#status");
    const retry = document.querySelector("#retry");
    if (retry) retry.hidden = true;
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("arte-de-aprender-")).map((key) => caches.delete(key)));
      }
      if (status) status.textContent = "Atualização concluída. Abrindo a versão mais recente...";
      setTimeout(() => location.replace("/?updated=" + Date.now()), 700);
    } catch (error) {
      console.error(error);
      if (status) status.textContent = "Não consegui limpar os arquivos temporários automaticamente.";
      if (retry) retry.hidden = false;
    }
  }
  document.querySelector("#retry")?.addEventListener("click", updateApp);
  updateApp();
})();
