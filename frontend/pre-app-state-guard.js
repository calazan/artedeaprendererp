// Captura o estado financeiro antes de app.js executar.
// Isso permite desfazer qualquer sincronização retroativa feita pela inicialização legada.
(() => {
  const SNAPSHOT_KEY = "arteDeAprenderERP.preAppPayments.v1";
  const STORAGE_KEYS = ["arteDeAprenderERP.v4", "arteDeAprenderERP.v3", "arteDeAprenderERP.v2"];
  try {
    const raw = STORAGE_KEYS.map((key) => localStorage.getItem(key)).find(Boolean);
    if (!raw) {
      sessionStorage.removeItem(SNAPSHOT_KEY);
      return;
    }
    const data = JSON.parse(raw);
    const payments = Array.isArray(data?.payments) ? data.payments : [];
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
      capturedAt: new Date().toISOString(),
      payments,
    }));
  } catch (error) {
    console.warn("Não foi possível criar a proteção pré-inicialização das mensalidades.", error);
  }
})();
