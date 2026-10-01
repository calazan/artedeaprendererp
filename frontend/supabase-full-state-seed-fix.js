// Migração única: depois que o Supabase estiver pronto, envia o estado financeiro local
// para o novo snapshot complementar. Só executa quando este aparelho realmente possui dados.
(() => {
  if (window.__saberSupabaseFullStateSeedLoaded) return;
  window.__saberSupabaseFullStateSeedLoaded = true;

  const SEED_KEY = "arteDeAprenderERP.supabase.fullStateSeed.v1";
  const MAX_ATTEMPTS = 30;
  let attempts = 0;

  function hasFinancialData() {
    const arrayKeys = [
      "payments", "otherIncomes", "expenses", "proposals", "expenseCategories",
      "agendaEvents", "bankAccounts", "bankMovements", "paymentExclusions",
    ];
    if (arrayKeys.some((key) => Array.isArray(state?.[key]) && state[key].length > 0)) return true;
    if (state?.rentalManagement && Object.keys(state.rentalManagement).length > 0) return true;
    if (state?.settings?.paymentAmountOverrides && Object.keys(state.settings.paymentAmountOverrides).length > 0) return true;
    return false;
  }

  async function trySeed() {
    if (localStorage.getItem(SEED_KEY)) return;
    attempts += 1;

    const bridge = window.__saberMaisSupabase;
    const status = bridge?.status?.();
    if (!bridge || !status?.ready || status?.busy) {
      if (attempts < MAX_ATTEMPTS) window.setTimeout(trySeed, 500);
      return;
    }

    if (!hasFinancialData()) {
      if (attempts < MAX_ATTEMPTS) window.setTimeout(trySeed, 500);
      return;
    }

    try {
      const ok = await bridge.syncNow();
      if (ok !== false) {
        localStorage.setItem(SEED_KEY, new Date().toISOString());
        console.info("Migração do estado financeiro completo para o Supabase concluída.");
      }
    } catch (error) {
      console.warn("Migração do financeiro para o Supabase será tentada novamente em outra abertura.", error);
    }
  }

  window.setTimeout(trySeed, 800);
})();
