// Permite alterar o valor da mensalidade apenas no mês selecionado, sem modificar o cadastro geral.
(() => {
  if (window.__monthlyPaymentAmountFixLoaded) return;
  window.__monthlyPaymentAmountFixLoaded = true;

  const originalRenderPayments = renderPayments;
  const originalEnsurePaymentsForPeriod = ensurePaymentsForPeriod;

  function overridesStore() {
    state.settings ||= {};
    if (!state.settings.paymentAmountOverrides || typeof state.settings.paymentAmountOverrides !== "object") {
      state.settings.paymentAmountOverrides = {};
    }
    return state.settings.paymentAmountOverrides;
  }

  function overrideKey(payment) {
    if (!payment) return "";
    return `${payment.period || selectedPeriodKey()}:${payment.studentId || ""}`;
  }

  function overrideForPayment(payment) {
    return overridesStore()[overrideKey(payment)] || null;
  }

  function applyOverrideToPayment(payment) {
    const override = overrideForPayment(payment);
    if (!payment || !override) return false;
    const amount = Number(override.amount);
    if (!Number.isFinite(amount) || amount < 0) return false;
    let changed = false;
    if (Number(payment.amount || 0) !== amount) {
      payment.amount = amount;
      changed = true;
    }
    if (payment.monthlyAmountOverride !== true) {
      payment.monthlyAmountOverride = true;
      changed = true;
    }
    const originalAmount = Number(override.originalAmount ?? payment.monthlyOriginalAmount ?? 0);
    if (payment.monthlyOriginalAmount !== originalAmount) {
      payment.monthlyOriginalAmount = originalAmount;
      changed = true;
    }
    if (changed) syncPaymentFee(payment);
    return changed;
  }

  // Mantém overrides ao gerar mensalidades que ainda não existiam, sem tocar nas mensalidades antigas.
  ensurePaymentsForPeriod = function ensurePaymentsForPeriodWithMonthlyOverrides(period = selectedPeriodKey(), options = {}) {
    const result = originalEnsurePaymentsForPeriod(period, options);
    let overrideApplied = false;
    paymentsForPeriod(period).forEach((payment) => {
      if (applyOverrideToPayment(payment)) overrideApplied = true;
    });
    if (overrideApplied) {
      try { flushSaveState(); } catch {}
    }
    return result;
  };
  try { window.ensurePaymentsForPeriod = ensurePaymentsForPeriod; } catch {}

  function injectStyles() {
    if (document.querySelector("#monthlyPaymentAmountStyle")) return;
    const style = document.createElement("style");
    style.id = "monthlyPaymentAmountStyle";
    style.textContent = `
      .monthly-value-note { display:block; margin-top:4px; font-size:10px; font-weight:800; color:#713978; }
      .monthly-payment-modal-backdrop {
        position:fixed; inset:0; z-index:9999; background:rgba(17,24,39,.56); display:flex; align-items:center; justify-content:center; padding:18px;
      }
      .monthly-payment-modal {
        width:min(460px, 100%); background:#fff; color:#111827; border-radius:18px; padding:22px; box-shadow:0 24px 80px rgba(0,0,0,.28);
      }
      .monthly-payment-modal h3 { margin:0 0 6px; font-size:20px; }
      .monthly-payment-modal p { margin:0 0 16px; color:#4b5563; line-height:1.45; }
      .monthly-payment-summary { background:#f6f2f7; border-radius:12px; padding:12px; margin-bottom:14px; display:grid; gap:4px; }
      .monthly-payment-modal label { display:grid; gap:6px; font-weight:800; }
      .monthly-payment-modal input { width:100%; padding:11px 12px; border:1px solid #cbd5e1; border-radius:10px; font-size:16px; }
      .monthly-payment-modal .modal-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; margin-top:18px; }
      .monthly-payment-modal button { border:0; border-radius:10px; padding:10px 13px; font-weight:800; cursor:pointer; }
      .monthly-payment-modal .primary { background:#713978; color:#fff; }
      .monthly-payment-modal .secondary { background:#e5e7eb; color:#111827; }
      .monthly-payment-modal .restore { background:#f3e8ff; color:#6b21a8; margin-right:auto; }
      [data-theme="dark"] .monthly-payment-modal { background:#1f2937; color:#f9fafb; }
      [data-theme="dark"] .monthly-payment-modal p { color:#d1d5db; }
      [data-theme="dark"] .monthly-payment-summary { background:#111827; }
      [data-theme="dark"] .monthly-payment-modal input { background:#111827; color:#fff; border-color:#4b5563; }
    `;
    document.head.appendChild(style);
  }

  function enhancePaymentRows() {
    const table = document.querySelector("#paymentsTable");
    if (!table) return;

    table.querySelectorAll("tr").forEach((row) => {
      const paymentControl = row.querySelector("[data-payment-method]");
      const paymentId = paymentControl?.dataset.paymentMethod || "";
      if (!paymentId) return;
      const payment = state.payments.find((item) => item.id === paymentId);
      if (!payment) return;

      const actions = row.querySelector(".row-actions");
      if (actions && !actions.querySelector(`[data-edit-monthly-payment-amount="${paymentId}"]`)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "small secondary";
        button.dataset.editMonthlyPaymentAmount = paymentId;
        button.textContent = "Alterar valor do mês";
        actions.prepend(button);
      }

      if (overrideForPayment(payment) || payment.monthlyAmountOverride === true) {
        const amountCell = row.children?.[1];
        if (amountCell && !amountCell.querySelector(".monthly-value-note")) {
          const note = document.createElement("small");
          note.className = "monthly-value-note";
          note.textContent = "Valor ajustado somente neste mês";
          amountCell.appendChild(note);
        }
      }
    });
  }

  renderPayments = function renderPaymentsWithMonthlyAmountEditor() {
    originalRenderPayments();
    enhancePaymentRows();
  };
  try { window.renderPayments = renderPayments; } catch {}

  function closeModal() {
    document.querySelector("#monthlyPaymentAmountModal")?.remove();
  }

  function openModal(paymentId) {
    const payment = state.payments.find((item) => item.id === paymentId);
    if (!payment) return;
    const student = getStudent(payment.studentId);
    const received = paymentReceivedAmount(payment);
    const generalAmount = Number(student ? studentMonthlyAmount(student) : payment.amount || 0);
    const currentOverride = overrideForPayment(payment) || (payment.monthlyAmountOverride ? { amount: payment.amount } : null);

    closeModal();
    const backdrop = document.createElement("div");
    backdrop.id = "monthlyPaymentAmountModal";
    backdrop.className = "monthly-payment-modal-backdrop";
    backdrop.innerHTML = `
      <div class="monthly-payment-modal" role="dialog" aria-modal="true" aria-labelledby="monthlyPaymentAmountTitle">
        <h3 id="monthlyPaymentAmountTitle">Alterar valor somente deste mês</h3>
        <p>Esta alteração será aplicada apenas a <strong>${escapeHTML(periodLabel(payment.period || selectedPeriodKey()))}</strong>. O cadastro geral e os demais meses permanecerão inalterados.</p>
        <div class="monthly-payment-summary">
          <strong>${escapeHTML(student?.name || "Criança removida")}</strong>
          <span>Valor atual do cadastro geral: ${brl(generalAmount)}</span>
          <span>Já recebido neste mês: ${brl(received)}</span>
          ${currentOverride ? `<span><strong>Este mês possui valor personalizado.</strong></span>` : ""}
        </div>
        <label>
          Novo valor da mensalidade deste mês
          <input id="monthlyPaymentAmountInput" type="number" min="${Math.max(0, received)}" step="0.01" value="${Number(payment.amount || 0).toFixed(2)}" />
        </label>
        <div class="modal-actions">
          ${currentOverride ? `<button type="button" class="restore" data-restore-monthly-payment="${payment.id}">Usar valor atual do cadastro</button>` : ""}
          <button type="button" class="secondary" data-close-monthly-payment>Cancelar</button>
          <button type="button" class="primary" data-save-monthly-payment="${payment.id}">Salvar para este mês</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    window.setTimeout(() => document.querySelector("#monthlyPaymentAmountInput")?.focus(), 0);
  }

  function saveMonthlyAmount(paymentId) {
    const payment = state.payments.find((item) => item.id === paymentId);
    if (!payment) return;
    const input = document.querySelector("#monthlyPaymentAmountInput");
    const amount = Number(input?.value);
    const received = paymentReceivedAmount(payment);

    if (!Number.isFinite(amount) || amount < 0) {
      showToast("Informe um valor válido para a mensalidade.");
      return;
    }
    if (amount + 0.009 < received) {
      showToast(`O valor não pode ser menor que o total já recebido (${brl(received)}).`);
      return;
    }

    const student = getStudent(payment.studentId);
    const originalAmount = Number(student ? studentMonthlyAmount(student) : payment.monthlyOriginalAmount ?? payment.amount ?? 0);
    overridesStore()[overrideKey(payment)] = {
      amount: Number(amount.toFixed(2)),
      originalAmount,
      updatedAt: new Date().toISOString(),
    };

    payment.amount = Number(amount.toFixed(2));
    payment.monthlyAmountOverride = true;
    payment.monthlyOriginalAmount = originalAmount;
    syncPaymentFee(payment);
    flushSaveState();
    closeModal();
    renderAll();
    showToast(`Valor de ${periodLabel(payment.period || selectedPeriodKey())} alterado para ${brl(amount)}. Os demais meses não foram modificados.`);
  }

  function restoreGeneralAmount(paymentId) {
    const payment = state.payments.find((item) => item.id === paymentId);
    if (!payment) return;
    const student = getStudent(payment.studentId);
    if (!student) return;
    const generalAmount = Number(studentMonthlyAmount(student));
    const received = paymentReceivedAmount(payment);

    if (generalAmount + 0.009 < received) {
      showToast(`O valor do cadastro (${brl(generalAmount)}) é menor que o total já recebido (${brl(received)}).`);
      return;
    }

    delete overridesStore()[overrideKey(payment)];
    payment.amount = generalAmount;
    payment.monthlyAmountOverride = false;
    payment.monthlyOriginalAmount = null;
    syncPaymentFee(payment);
    flushSaveState();
    closeModal();
    renderAll();
    showToast(`Valor de ${periodLabel(payment.period || selectedPeriodKey())} restaurado para o valor atual do cadastro: ${brl(generalAmount)}.`);
  }

  document.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-monthly-payment-amount]");
    if (editButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openModal(editButton.dataset.editMonthlyPaymentAmount);
      return;
    }

    const saveButton = event.target.closest("[data-save-monthly-payment]");
    if (saveButton) {
      event.preventDefault();
      saveMonthlyAmount(saveButton.dataset.saveMonthlyPayment);
      return;
    }

    const restoreButton = event.target.closest("[data-restore-monthly-payment]");
    if (restoreButton) {
      event.preventDefault();
      restoreGeneralAmount(restoreButton.dataset.restoreMonthlyPayment);
      return;
    }

    if (event.target.closest("[data-close-monthly-payment]")) {
      event.preventDefault();
      closeModal();
      return;
    }

    if (event.target.id === "monthlyPaymentAmountModal") closeModal();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.querySelector("#monthlyPaymentAmountModal")) closeModal();
    if (event.key === "Enter" && document.activeElement?.id === "monthlyPaymentAmountInput") {
      const saveButton = document.querySelector("[data-save-monthly-payment]");
      if (saveButton) saveMonthlyAmount(saveButton.dataset.saveMonthlyPayment);
    }
  });

  injectStyles();
  let migrated = false;
  currentPayments().forEach((payment) => {
    if (applyOverrideToPayment(payment)) migrated = true;
  });
  if (migrated) {
    try { flushSaveState(); } catch {}
  }
  enhancePaymentRows();

  window.__monthlyPaymentAmount = {
    open: openModal,
    overrides: () => structuredClone(overridesStore()),
  };
})();
