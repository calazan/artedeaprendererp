// Usa diretamente a conta selecionada no formulário ao pagar um repasse pendente.
(() => {
  if (window.__saberRentalRepassPayUiFixLoaded) return;
  window.__saberRentalRepassPayUiFixLoaded = true;

  const CATEGORY = "Repasses e parcerias";
  const money = (value) => Number(Number(value || 0).toFixed(2));

  function today() {
    try { return todayISO(); } catch { return new Date().toISOString().slice(0, 10); }
  }

  function accountById(id) {
    try { return getBankAccount(id); } catch {
      return (state.bankAccounts || []).find((account) => String(account.id) === String(id)) || null;
    }
  }

  function ensureCategory() {
    state.expenseCategories ||= [];
    if (state.expenseCategories.some((item) => String(item?.name || "").trim().toLowerCase() === CATEGORY.toLowerCase())) return;
    try { state.expenseCategories.push(normalizeExpenseCategory({ name: CATEGORY })); }
    catch { state.expenseCategories.push({ id: `cat-${Date.now()}`, name: CATEGORY }); }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-manual-repass-pay]");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const recordId = button.dataset.manualRepassPay || "";
    const records = state.rentalManagement?.manualRepasses || [];
    const record = records.find((item) => String(item.id) === String(recordId));
    if (!record || record.status === "paid") return;

    const accountId = document.querySelector("#manualRepassAccount")?.value || "";
    const account = accountById(accountId);
    if (!account) {
      try { showToast("Escolha a conta de saída no campo do cadastro de repasses e clique em Pagar novamente."); }
      catch { alert("Escolha a conta de saída no cadastro de repasses."); }
      document.querySelector("#manualRepassAccount")?.focus();
      return;
    }

    ensureCategory();
    const expenseId = `manual-repass-${record.id}`;
    if (!(state.expenses || []).some((item) => String(item.id) === expenseId)) {
      const payload = {
        id: expenseId,
        description: `Repasse - ${record.beneficiary}${record.description ? ` - ${record.description}` : ""}`,
        category: CATEGORY,
        amount: Number(record.amount || 0),
        date: today(),
        dueDate: record.dueDate || today(),
        status: "paid",
        paidDate: today(),
        paidFromAccountId: accountId,
      };
      let expense;
      try { expense = normalizeExpense(payload); } catch { expense = payload; }
      state.expenses ||= [];
      state.expenses.push(expense);
      account.balance = money(Number(account.balance || 0) - Number(record.amount || 0));
    }

    record.status = "paid";
    record.paidDate = today();
    record.bankAccountId = accountId;
    record.expenseId = expenseId;
    saveState();
    try { renderAll(); } catch {}
    try { showToast(`Repasse pago pela conta ${account.name || "selecionada"}.`); } catch {}

    // O painel complementar possui seu próprio render e é refeito ao reabrir a subaba.
    setTimeout(() => document.querySelector('.finance-subtab[data-finance-pane="rentals"]')?.click(), 0);
  }, true);
})();
