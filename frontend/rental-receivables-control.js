// Controle completo de contas a receber para sublocações e Clínica.
(() => {
  if (window.__saberRentalReceivablesControlLoaded) return;
  window.__saberRentalReceivablesControlLoaded = true;

  const CLINIC_SCOPE = "clinic";
  let renderQueued = false;

  const money = (value) => Number(Number(value || 0).toFixed(2));
  const same = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();
  const esc = (value) => {
    try { return escapeHTML(value); } catch {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }
  };
  const attr = (value) => esc(value).replaceAll("`", "&#096;");
  const brlLocal = (value) => {
    try { return brl(value); } catch {
      return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    }
  };
  const today = () => {
    try { return todayISO(); } catch { return new Date().toISOString().slice(0, 10); }
  };
  const calendarPeriod = () => today().slice(0, 7);
  const selectedPeriod = () => {
    try { return selectedPeriodKey(); } catch { return calendarPeriod(); }
  };
  const periodName = (value = selectedPeriod()) => {
    try { return periodLabel(value); } catch {
      const [year, month] = String(value || "").split("-");
      return `${month || "--"}/${year || "----"}`;
    }
  };
  const dateBR = (value = "") => {
    if (!value) return "-";
    try { return formatDateBR(value); } catch {
      const [year, month, day] = String(value).slice(0, 10).split("-");
      return year && month && day ? `${day}/${month}/${year}` : String(value);
    }
  };
  const makeId = () => {
    try { return uid(); } catch {
      return globalThis.crypto?.randomUUID?.() || `receivable-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  };

  function rental() {
    state.rentalManagement ||= {};
    const data = state.rentalManagement;
    data.rentalReceivables = Array.isArray(data.rentalReceivables) ? data.rentalReceivables : [];
    data.genericRentalReceipts = Array.isArray(data.genericRentalReceipts) ? data.genericRentalReceipts : [];
    data.clinicReceipts = Array.isArray(data.clinicReceipts) ? data.clinicReceipts : [];
    data.partnerConfigs = Array.isArray(data.partnerConfigs) ? data.partnerConfigs : [];
    return data;
  }

  function show(message) {
    try { showToast(message); } catch { console.info(message); }
  }

  function scopeIdForConfig(configId) {
    return `partner:${String(configId || "")}`;
  }

  function configIdFromScope(scopeId) {
    return String(scopeId || "").startsWith("partner:") ? String(scopeId).slice(8) : "";
  }

  function scopeConfig(scopeId) {
    const data = rental();
    if (scopeId === CLINIC_SCOPE) {
      const clinic = data.clinic || {};
      return {
        scopeId,
        kind: "clinic",
        name: clinic.tenantName || "Clínica",
        spaceName: clinic.roomName || "Sala da clínica",
        monthlyAmount: Number(clinic.monthlyRent || 0),
        dueDay: Number(clinic.dueDay || 10),
        startDate: clinic.startDate || "",
        defaultBankAccountId: clinic.defaultBankAccountId || "",
      };
    }
    const configId = configIdFromScope(scopeId);
    const config = data.partnerConfigs.find((item) => same(item.id, configId) && item.kind === "sublocation");
    if (!config) return null;
    return {
      scopeId,
      kind: "partner",
      configId: config.id,
      name: config.name || "Sublocação",
      spaceName: config.spaceName || "",
      monthlyAmount: Number(config.monthlyAmount || 0),
      dueDay: Number(config.dueDay || 10),
      startDate: config.startDate || "",
      defaultBankAccountId: config.defaultBankAccountId || "",
    };
  }

  function allScopes() {
    const data = rental();
    const result = [CLINIC_SCOPE];
    data.partnerConfigs
      .filter((item) => item && item.kind === "sublocation")
      .forEach((item) => result.push(scopeIdForConfig(item.id)));
    return result;
  }

  function nextPeriod(period, step = 1) {
    const [year, month] = String(period || calendarPeriod()).split("-").map(Number);
    const date = new Date(year, (month || 1) - 1 + step, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function periodCompare(a, b) {
    return String(a || "").localeCompare(String(b || ""));
  }

  function daysInPeriod(period) {
    const [year, month] = String(period || "").split("-").map(Number);
    if (!year || !month) return 28;
    return new Date(year, month, 0).getDate();
  }

  function dueDateForPeriod(period, dueDay = 10) {
    const day = Math.min(Math.max(Number(dueDay || 10), 1), daysInPeriod(period));
    return `${period}-${String(day).padStart(2, "0")}`;
  }

  function receipts(scopeId, period = "") {
    const data = rental();
    const source = scopeId === CLINIC_SCOPE
      ? data.clinicReceipts
      : data.genericRentalReceipts.filter((item) => same(item.partnerConfigId, configIdFromScope(scopeId)));
    return source.filter((item) => !period || item.period === period);
  }

  function receivedFor(scopeId, period) {
    return money(receipts(scopeId, period).reduce((sum, item) => sum + Number(item.amount || 0), 0));
  }

  function receivables(scopeId) {
    return rental().rentalReceivables
      .filter((item) => same(item.scopeId, scopeId))
      .slice()
      .sort((a, b) => periodCompare(a.period, b.period) || String(a.dueDate || "").localeCompare(String(b.dueDate || "")));
  }

  function receivableFor(scopeId, period) {
    return rental().rentalReceivables.find((item) => same(item.scopeId, scopeId) && item.period === period) || null;
  }

  function balanceFor(record) {
    return money(Math.max(Number(record.amount || 0) - receivedFor(record.scopeId, record.period), 0));
  }

  function statusFor(record) {
    const received = receivedFor(record.scopeId, record.period);
    const balance = money(Math.max(Number(record.amount || 0) - received, 0));
    if (balance <= 0.009) return { key: "received", label: "Recebido" };
    if (received > 0.009) return { key: "partial", label: "Parcial" };
    const due = record.dueDate || dueDateForPeriod(record.period, scopeConfig(record.scopeId)?.dueDay || 10);
    if (due && due < today()) return { key: "overdue", label: "Vencido" };
    if (due && due > today()) return { key: "future", label: "Futuro" };
    return { key: "pending", label: "Pendente" };
  }

  function createReceivable(scopeId, period, amount, dueDate, note = "", source = "manual") {
    const existing = receivableFor(scopeId, period);
    const payload = {
      id: existing?.id || makeId(),
      scopeId,
      period,
      amount: money(amount),
      dueDate: dueDate || dueDateForPeriod(period, scopeConfig(scopeId)?.dueDay || 10),
      note: note || existing?.note || "",
      source: existing?.source || source,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, payload);
    else rental().rentalReceivables.push(payload);
    return payload;
  }

  function seedScope(scopeId) {
    const config = scopeConfig(scopeId);
    if (!config) return false;
    let changed = false;
    const data = rental();
    const defaultAmount = Math.max(Number(config.monthlyAmount || 0), 0);
    const horizon = calendarPeriod();
    let start = config.startDate ? String(config.startDate).slice(0, 7) : horizon;
    if (!/^\d{4}-\d{2}$/.test(start)) start = horizon;

    if (defaultAmount > 0 && start <= horizon) {
      let cursor = start;
      let guard = 0;
      while (cursor <= horizon && guard < 120) {
        if (!receivableFor(scopeId, cursor)) {
          createReceivable(scopeId, cursor, defaultAmount, dueDateForPeriod(cursor, config.dueDay), "", "automatic-current");
          changed = true;
        }
        cursor = nextPeriod(cursor);
        guard += 1;
      }
    }

    const groupedReceipts = new Map();
    receipts(scopeId).forEach((item) => {
      if (!item.period) return;
      groupedReceipts.set(item.period, money((groupedReceipts.get(item.period) || 0) + Number(item.amount || 0)));
    });
    groupedReceipts.forEach((received, period) => {
      const existing = receivableFor(scopeId, period);
      if (!existing) {
        createReceivable(scopeId, period, Math.max(defaultAmount, received), dueDateForPeriod(period, config.dueDay), "Gerado a partir de recebimento já registrado.", "legacy-receipt");
        changed = true;
      } else if (Number(existing.amount || 0) + 0.009 < received) {
        existing.amount = received;
        existing.updatedAt = new Date().toISOString();
        changed = true;
      }
    });

    const seen = new Set();
    data.rentalReceivables = data.rentalReceivables.filter((item) => {
      const key = `${item.scopeId}|${item.period}`;
      if (!same(item.scopeId, scopeId)) return true;
      if (!seen.has(key)) {
        seen.add(key);
        return true;
      }
      changed = true;
      return false;
    });
    return changed;
  }

  function seedAll() {
    let changed = false;
    allScopes().forEach((scopeId) => { if (seedScope(scopeId)) changed = true; });
    return changed;
  }

  function summaryFor(scopeId) {
    const rows = receivables(scopeId);
    const selected = selectedPeriod();
    const selectedRows = rows.filter((item) => item.period === selected);
    const expectedMonth = money(selectedRows.reduce((sum, item) => sum + Number(item.amount || 0), 0));
    const receivedMonth = money(selectedRows.reduce((sum, item) => sum + Math.min(receivedFor(scopeId, item.period), Number(item.amount || 0)), 0));
    const pendingMonth = money(Math.max(expectedMonth - receivedMonth, 0));
    let overdue = 0;
    let future = 0;
    let open = 0;
    rows.forEach((item) => {
      const balance = balanceFor(item);
      if (balance <= 0.009) return;
      open += balance;
      const status = statusFor(item).key;
      if (status === "overdue") overdue += balance;
      if (status === "future") future += balance;
    });
    return {
      expectedMonth,
      receivedMonth,
      pendingMonth,
      overdue: money(overdue),
      future: money(future),
      open: money(open),
    };
  }

  function statusBadge(record) {
    const status = statusFor(record);
    return `<span class="rental-receivable-status ${status.key}">${esc(status.label)}</span>`;
  }

  function fingerprint(scopeId) {
    const config = scopeConfig(scopeId);
    const rows = receivables(scopeId).map((item) => ({
      id: item.id,
      period: item.period,
      amount: item.amount,
      dueDate: item.dueDate,
      note: item.note,
      received: receivedFor(scopeId, item.period),
    }));
    return JSON.stringify({
      scopeId,
      selected: selectedPeriod(),
      today: today(),
      config: config && {
        amount: config.monthlyAmount,
        dueDay: config.dueDay,
        startDate: config.startDate,
        name: config.name,
      },
      rows,
    });
  }

  function rowsHtml(scopeId) {
    const rows = receivables(scopeId);
    if (!rows.length) {
      return `<tr><td colspan="8"><div class="empty"><strong>Nenhuma conta a receber cadastrada</strong><span>Cadastre uma competência ou gere os próximos meses.</span></div></td></tr>`;
    }
    return rows.map((record) => {
      const received = receivedFor(scopeId, record.period);
      const balance = money(Math.max(Number(record.amount || 0) - received, 0));
      const canDelete = received <= 0.009;
      return `<tr class="rental-receivable-row status-${statusFor(record).key}">
        <td><strong>${esc(periodName(record.period))}</strong></td>
        <td>${dateBR(record.dueDate)}</td>
        <td>${brlLocal(record.amount)}</td>
        <td><strong>${brlLocal(received)}</strong></td>
        <td><strong>${brlLocal(balance)}</strong></td>
        <td>${statusBadge(record)}</td>
        <td>${esc(record.note || "-")}</td>
        <td><div class="row-actions">
          ${balance > 0.009 ? `<button type="button" class="small" data-receivable-receive="${attr(record.id)}">Receber</button>` : ""}
          <button type="button" class="small secondary" data-receivable-edit="${attr(record.id)}">Editar</button>
          <button type="button" class="small danger" data-receivable-delete="${attr(record.id)}" ${canDelete ? "" : "disabled title=\"Há recebimentos vinculados\""}>Excluir</button>
        </div></td>
      </tr>`;
    }).join("");
  }

  function controlHtml(scopeId) {
    const config = scopeConfig(scopeId);
    if (!config) return "";
    const summary = summaryFor(scopeId);
    const suggestedPeriod = selectedPeriod();
    const suggestedAmount = receivableFor(scopeId, suggestedPeriod)?.amount || config.monthlyAmount || 0;
    const suggestedDue = receivableFor(scopeId, suggestedPeriod)?.dueDate || dueDateForPeriod(suggestedPeriod, config.dueDay);
    return `<section class="rental-receivables-control" data-receivables-scope="${attr(scopeId)}" data-fingerprint="${attr(fingerprint(scopeId))}">
      <div class="panel-head stackable rental-receivables-head">
        <div><h3>Contas a receber</h3><span>Planeje valores pendentes e futuros. O saldo bancário só muda quando o recebimento for registrado.</span></div>
        <span class="rental-receivables-chip">${esc(config.name)}</span>
      </div>
      <div class="rental-receivables-summary">
        <div class="rental-receivable-stat"><span>Previsto em ${esc(periodName())}</span><strong>${brlLocal(summary.expectedMonth)}</strong></div>
        <div class="rental-receivable-stat good"><span>Recebido no mês</span><strong>${brlLocal(summary.receivedMonth)}</strong></div>
        <div class="rental-receivable-stat ${summary.pendingMonth > 0 ? "warn" : "good"}"><span>A receber no mês</span><strong>${brlLocal(summary.pendingMonth)}</strong></div>
        <div class="rental-receivable-stat ${summary.overdue > 0 ? "bad" : "good"}"><span>Vencido</span><strong>${brlLocal(summary.overdue)}</strong></div>
        <div class="rental-receivable-stat"><span>Futuro programado</span><strong>${brlLocal(summary.future)}</strong></div>
      </div>
      <form class="rental-receivable-form" data-receivable-form="${attr(scopeId)}">
        <input type="hidden" name="id" />
        <label>Competência<input name="period" type="month" value="${attr(suggestedPeriod)}" required /></label>
        <label>Valor previsto<input name="amount" type="number" min="0.01" step="0.01" value="${Number(suggestedAmount || 0) > 0 ? Number(suggestedAmount).toFixed(2) : ""}" required /></label>
        <label>Vencimento<input name="dueDate" type="date" value="${attr(suggestedDue)}" required /></label>
        <label class="span-2">Observação<input name="note" placeholder="Ex.: aluguel de setembro, reajuste, parcela..." /></label>
        <div class="form-actions"><button type="submit">Cadastrar / atualizar</button><button type="button" class="secondary" data-receivable-clear="${attr(scopeId)}">Limpar</button></div>
      </form>
      <div class="rental-receivable-future-tools">
        <div><strong>Programar meses futuros</strong><span>Usa o valor mensal e o vencimento definidos em Configurações.</span></div>
        <label>Quantidade de meses<input type="number" min="1" max="24" value="12" data-receivable-month-count="${attr(scopeId)}" /></label>
        <button type="button" class="secondary" data-receivable-generate="${attr(scopeId)}">Gerar próximos meses</button>
      </div>
      <div class="table-wrap rental-receivables-table"><table>
        <thead><tr><th>Competência</th><th>Vencimento</th><th>Previsto</th><th>Recebido</th><th>Saldo</th><th>Status</th><th>Observação</th><th>Ações</th></tr></thead>
        <tbody>${rowsHtml(scopeId)}</tbody>
      </table></div>
    </section>`;
  }

  function ensureStyles() {
    if (document.querySelector("#rentalReceivablesStyles")) return;
    const style = document.createElement("style");
    style.id = "rentalReceivablesStyles";
    style.textContent = `
      .rental-receivables-control{margin-top:18px;padding-top:18px;border-top:1px solid rgba(148,163,184,.20)}
      .rental-receivables-head{margin-bottom:12px}.rental-receivables-head h3{margin:0}.rental-receivables-head span{color:var(--muted,#64748b);font-size:12px}
      .rental-receivables-chip{display:inline-flex!important;align-items:center;padding:7px 11px;border-radius:999px;background:rgba(63,156,141,.11);color:#216e62!important;font-weight:850!important;white-space:nowrap}
      .rental-receivables-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin:12px 0 16px}
      .rental-receivable-stat{padding:11px 12px;border:1px solid rgba(148,163,184,.2);border-radius:13px;background:rgba(255,255,255,.58)}
      .rental-receivable-stat span{display:block;font-size:11px;color:var(--muted,#64748b)}.rental-receivable-stat strong{display:block;margin-top:4px;font-size:17px}
      .rental-receivable-stat.good{background:rgba(220,252,231,.55)}.rental-receivable-stat.warn{background:rgba(254,243,199,.62)}.rental-receivable-stat.bad{background:rgba(254,226,226,.62)}
      .rental-receivable-form{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;align-items:end;margin:12px 0}
      .rental-receivable-form label{display:grid;gap:6px;font-size:12px;font-weight:700}.rental-receivable-form .span-2{grid-column:span 2}.rental-receivable-form .form-actions{display:flex;gap:7px;flex-wrap:wrap}
      .rental-receivable-future-tools{display:flex;align-items:end;gap:10px;flex-wrap:wrap;padding:12px 13px;border-radius:13px;background:rgba(113,57,120,.06);border:1px solid rgba(113,57,120,.12);margin:12px 0}
      .rental-receivable-future-tools>div{margin-right:auto}.rental-receivable-future-tools span{display:block;color:var(--muted,#64748b);font-size:11px;margin-top:3px}.rental-receivable-future-tools label{display:grid;gap:5px;font-size:11px;font-weight:700}.rental-receivable-future-tools input{width:110px}
      .rental-receivable-status{display:inline-flex;padding:5px 8px;border-radius:999px;font-size:10px;font-weight:850;white-space:nowrap}
      .rental-receivable-status.received{background:#dcfce7;color:#166534}.rental-receivable-status.partial{background:#dbeafe;color:#1d4ed8}.rental-receivable-status.pending{background:#fef3c7;color:#92400e}.rental-receivable-status.overdue{background:#fee2e2;color:#991b1b}.rental-receivable-status.future{background:#ede9fe;color:#6d28d9}
      .rental-receivable-row.status-overdue td{background:rgba(254,226,226,.35)}.rental-receivable-row.status-future td{background:rgba(237,233,254,.22)}
      .rental-receivables-table{margin-top:12px}.rental-receivables-table button[disabled]{opacity:.45;cursor:not-allowed}
      .receivables-legacy-pending-hidden{display:none!important}
      @media(max-width:1100px){.rental-receivables-summary{grid-template-columns:repeat(3,1fr)}.rental-receivable-form{grid-template-columns:repeat(2,minmax(0,1fr))}.rental-receivable-form .span-2{grid-column:span 2}}
      @media(max-width:650px){.rental-receivables-summary,.rental-receivable-form{grid-template-columns:1fr}.rental-receivable-form .span-2{grid-column:auto}.rental-receivable-future-tools{align-items:stretch}.rental-receivable-future-tools>div{width:100%}.rental-receivable-future-tools input{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function patchLegacySummary(scopeId, root) {
    const summary = summaryFor(scopeId);
    if (scopeId === CLINIC_SCOPE) {
      const box = document.querySelector("#clinicRentalSummary");
      if (box) {
        const summaryKey = JSON.stringify(summary);
        if (box.dataset.receivableSummary !== summaryKey || !box.querySelector("[data-receivable-summary-cell]")) {
          box.innerHTML = [
            ["Previsto no mês", summary.expectedMonth, ""],
            ["Recebido no mês", summary.receivedMonth, "good"],
            ["A receber no mês", summary.pendingMonth, summary.pendingMonth > 0 ? "warn" : "good"],
            ["Vencido", summary.overdue, summary.overdue > 0 ? "bad" : "good"],
            ["Futuro programado", summary.future, ""],
            ["Total em aberto", summary.open, summary.open > 0 ? "warn" : "good"],
          ].map(([label, value, cls]) => `<div class="rental-stat ${cls}" data-receivable-summary-cell><span>${label}</span><strong>${brlLocal(value)}</strong></div>`).join("");
          box.dataset.receivableSummary = summaryKey;
        }
      }
      document.querySelector(".clinic-pending-box")?.classList.add("receivables-legacy-pending-hidden");
      return;
    }
    const oldSummary = root?.querySelector(":scope > .partner-summary");
    if (oldSummary) {
      const summaryKey = JSON.stringify(summary);
      if (oldSummary.dataset.receivableSummary !== summaryKey || !oldSummary.querySelector("[data-receivable-summary-cell]")) {
        oldSummary.innerHTML = `
          <div class="partner-stat" data-receivable-summary-cell><span>Previsto no mês</span><strong>${brlLocal(summary.expectedMonth)}</strong></div>
          <div class="partner-stat good" data-receivable-summary-cell><span>Recebido</span><strong>${brlLocal(summary.receivedMonth)}</strong></div>
          <div class="partner-stat ${summary.pendingMonth > 0 ? "warn" : "good"}" data-receivable-summary-cell><span>A receber no mês</span><strong>${brlLocal(summary.pendingMonth)}</strong></div>
          <div class="partner-stat ${summary.overdue > 0 ? "warn" : "good"}" data-receivable-summary-cell><span>Vencido</span><strong>${brlLocal(summary.overdue)}</strong></div>`;
        oldSummary.dataset.receivableSummary = summaryKey;
      }
    }
    const oldPending = [...(root?.querySelectorAll(":scope > .rental-subsection") || [])]
      .find((section) => section.querySelector("h3")?.textContent?.trim() === "Pendências");
    oldPending?.classList.add("receivables-legacy-pending-hidden");
  }

  function injectControl(scopeId, receiptForm, root) {
    if (!receiptForm || !root) return;
    patchLegacySummary(scopeId, root);
    const currentFingerprint = fingerprint(scopeId);
    let control = root.querySelector(`.rental-receivables-control[data-receivables-scope="${CSS.escape(scopeId)}"]`);
    if (control?.dataset.fingerprint === currentFingerprint) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = controlHtml(scopeId).trim();
    const next = wrapper.firstElementChild;
    if (!next) return;
    if (control) {
      control.replaceWith(next);
      return;
    }
    const receiptSection = receiptForm.closest(".rental-subsection") || receiptForm.parentElement;
    if (receiptSection) receiptSection.insertAdjacentElement("beforebegin", next);
    else root.appendChild(next);
  }

  function receiptFormFields(scopeId, form) {
    if (scopeId === CLINIC_SCOPE) {
      return {
        period: form.querySelector("#clinicRentPeriod"),
        amount: form.querySelector("#clinicRentAmount"),
        date: form.querySelector("#clinicRentDate"),
      };
    }
    return {
      period: form.elements.period,
      amount: form.elements.amount,
      date: form.elements.date,
    };
  }

  function bindReceiptPeriodSuggestion(scopeId, form) {
    if (form.dataset.receivableSuggestionBound === "1") return;
    form.dataset.receivableSuggestionBound = "1";
    const fields = receiptFormFields(scopeId, form);
    fields.period?.addEventListener("change", () => {
      const record = receivableFor(scopeId, fields.period.value);
      if (!record || !fields.amount) return;
      fields.amount.value = Math.max(balanceFor(record), 0).toFixed(2);
    });
  }

  function enhanceGeneric() {
    document.querySelectorAll("form[data-generic-rental-form]").forEach((form) => {
      const configId = form.dataset.genericRentalForm;
      const scopeId = scopeIdForConfig(configId);
      const root = form.closest(".generic-partner-card");
      if (!root || !scopeConfig(scopeId)) return;
      injectControl(scopeId, form, root);
      bindReceiptPeriodSuggestion(scopeId, form);
    });
  }

  function enhanceClinic() {
    const form = document.querySelector("#clinicRentReceiptForm");
    const root = document.querySelector(".rental-clinic-card");
    if (!form || !root) return;
    injectControl(CLINIC_SCOPE, form, root);
    bindReceiptPeriodSuggestion(CLINIC_SCOPE, form);
  }

  function enhanceAll() {
    ensureStyles();
    const changed = seedAll();
    enhanceGeneric();
    enhanceClinic();
    if (changed) {
      try { saveState(); } catch {}
    }
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      try { enhanceAll(); } catch (error) { console.warn("Falha ao atualizar contas a receber das locações.", error); }
    });
  }

  function formForScope(scopeId) {
    return document.querySelector(`form[data-receivable-form="${CSS.escape(scopeId)}"]`);
  }

  function clearReceivableForm(scopeId) {
    const form = formForScope(scopeId);
    const config = scopeConfig(scopeId);
    if (!form || !config) return;
    form.reset();
    form.elements.id.value = "";
    form.elements.period.value = selectedPeriod();
    const existing = receivableFor(scopeId, selectedPeriod());
    form.elements.amount.value = Number(existing?.amount || config.monthlyAmount || 0) > 0 ? Number(existing?.amount || config.monthlyAmount).toFixed(2) : "";
    form.elements.dueDate.value = existing?.dueDate || dueDateForPeriod(selectedPeriod(), config.dueDay);
    form.elements.note.value = "";
  }

  function fillReceivableForm(record) {
    const form = formForScope(record.scopeId);
    if (!form) return;
    form.elements.id.value = record.id;
    form.elements.period.value = record.period;
    form.elements.amount.value = Number(record.amount || 0).toFixed(2);
    form.elements.dueDate.value = record.dueDate || "";
    form.elements.note.value = record.note || "";
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function handleSubmit(event) {
    const form = event.target.closest("[data-receivable-form]");
    if (!form) return;
    event.preventDefault();
    event.stopPropagation();
    const scopeId = form.dataset.receivableForm;
    const config = scopeConfig(scopeId);
    if (!config) return;
    const id = form.elements.id?.value || "";
    const period = form.elements.period?.value || "";
    const amount = money(Number(form.elements.amount?.value || 0));
    const dueDate = form.elements.dueDate?.value || dueDateForPeriod(period, config.dueDay);
    const note = form.elements.note?.value.trim() || "";
    if (!/^\d{4}-\d{2}$/.test(period)) return show("Informe a competência.");
    if (!(amount > 0)) return show("Informe um valor previsto maior que zero.");
    const received = receivedFor(scopeId, period);
    if (amount + 0.009 < received) return show(`O valor previsto não pode ser menor que o já recebido (${brlLocal(received)}).`);
    const periodExisting = receivableFor(scopeId, period);
    if (periodExisting && id && !same(periodExisting.id, id)) return show("Já existe uma conta a receber para esta competência.");
    const editing = id ? rental().rentalReceivables.find((item) => same(item.id, id)) : null;
    if (editing && editing.period !== period && periodExisting) return show("Já existe uma conta a receber para a competência escolhida.");
    if (editing) {
      editing.period = period;
      editing.amount = amount;
      editing.dueDate = dueDate;
      editing.note = note;
      editing.updatedAt = new Date().toISOString();
    } else {
      createReceivable(scopeId, period, amount, dueDate, note, "manual");
    }
    try { saveState(); } catch {}
    queueRender();
    show(editing ? "Conta a receber atualizada." : "Conta a receber cadastrada.");
  }

  function generateFuture(scopeId) {
    const config = scopeConfig(scopeId);
    if (!config) return;
    const monthly = money(config.monthlyAmount || 0);
    if (!(monthly > 0)) return show("Defina primeiro o valor mensal desta sublocação em Configurações > Locações e repasses.");
    const input = document.querySelector(`[data-receivable-month-count="${CSS.escape(scopeId)}"]`);
    const count = Math.min(Math.max(Number(input?.value || 12), 1), 24);
    const existingPeriods = receivables(scopeId).map((item) => item.period).filter(Boolean).sort();
    let cursor = existingPeriods.length ? existingPeriods.at(-1) : calendarPeriod();
    if (periodCompare(cursor, calendarPeriod()) < 0) cursor = calendarPeriod();
    let created = 0;
    let attempts = 0;
    while (created < count && attempts < 48) {
      cursor = nextPeriod(cursor);
      attempts += 1;
      if (receivableFor(scopeId, cursor)) continue;
      createReceivable(scopeId, cursor, monthly, dueDateForPeriod(cursor, config.dueDay), "", "future-schedule");
      created += 1;
    }
    try { saveState(); } catch {}
    queueRender();
    show(`${created} competência(s) futura(s) programada(s).`);
  }

  function prefillReceipt(record) {
    const balance = balanceFor(record);
    if (balance <= 0.009) return show("Esta competência já está recebida integralmente.");
    if (record.scopeId === CLINIC_SCOPE) {
      const form = document.querySelector("#clinicRentReceiptForm");
      if (!form) return show("Formulário de recebimento da Clínica não encontrado.");
      const fields = receiptFormFields(record.scopeId, form);
      if (fields.period) fields.period.value = record.period;
      if (fields.amount) fields.amount.value = balance.toFixed(2);
      if (fields.date) fields.date.value = today();
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const configId = configIdFromScope(record.scopeId);
    const form = document.querySelector(`form[data-generic-rental-form="${CSS.escape(configId)}"]`);
    if (!form) return show("Formulário de recebimento desta sublocação não encontrado.");
    const fields = receiptFormFields(record.scopeId, form);
    if (fields.period) fields.period.value = record.period;
    if (fields.amount) fields.amount.value = balance.toFixed(2);
    if (fields.date) fields.date.value = today();
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function deleteReceivable(record) {
    const received = receivedFor(record.scopeId, record.period);
    if (received > 0.009) return show("Não é possível excluir uma conta que já possui recebimentos. Edite o valor previsto se necessário.");
    let ok = true;
    try { ok = await smgConfirm(`Excluir a conta a receber de ${periodName(record.period)}?`); }
    catch { ok = confirm(`Excluir a conta a receber de ${periodName(record.period)}?`); }
    if (!ok) return;
    rental().rentalReceivables = rental().rentalReceivables.filter((item) => !same(item.id, record.id));
    try { saveState(); } catch {}
    queueRender();
    show("Conta a receber excluída.");
  }

  async function handleClick(event) {
    const clearScope = event.target.closest("[data-receivable-clear]")?.dataset.receivableClear;
    if (clearScope) return clearReceivableForm(clearScope);

    const generateScope = event.target.closest("[data-receivable-generate]")?.dataset.receivableGenerate;
    if (generateScope) return generateFuture(generateScope);

    const editId = event.target.closest("[data-receivable-edit]")?.dataset.receivableEdit;
    if (editId) {
      const record = rental().rentalReceivables.find((item) => same(item.id, editId));
      if (record) fillReceivableForm(record);
      return;
    }

    const receiveId = event.target.closest("[data-receivable-receive]")?.dataset.receivableReceive;
    if (receiveId) {
      const record = rental().rentalReceivables.find((item) => same(item.id, receiveId));
      if (record) prefillReceipt(record);
      return;
    }

    const deleteId = event.target.closest("[data-receivable-delete]")?.dataset.receivableDelete;
    if (!deleteId) return;
    const record = rental().rentalReceivables.find((item) => same(item.id, deleteId));
    if (record) await deleteReceivable(record);
  }

  function handleChange(event) {
    const form = event.target.closest("[data-receivable-form]");
    if (!form || event.target.name !== "period") return;
    const scopeId = form.dataset.receivableForm;
    const config = scopeConfig(scopeId);
    if (!config) return;
    const existing = receivableFor(scopeId, event.target.value);
    if (existing) {
      form.elements.id.value = existing.id;
      form.elements.amount.value = Number(existing.amount || 0).toFixed(2);
      form.elements.dueDate.value = existing.dueDate || dueDateForPeriod(existing.period, config.dueDay);
      form.elements.note.value = existing.note || "";
    } else {
      form.elements.id.value = "";
      form.elements.amount.value = Number(config.monthlyAmount || 0) > 0 ? Number(config.monthlyAmount).toFixed(2) : "";
      form.elements.dueDate.value = dueDateForPeriod(event.target.value, config.dueDay);
      form.elements.note.value = "";
    }
  }

  function boot() {
    ensureStyles();
    document.addEventListener("submit", handleSubmit, true);
    document.addEventListener("click", handleClick);
    document.addEventListener("change", handleChange);
    document.querySelector("#globalMonth")?.addEventListener("change", queueRender);
    document.querySelector("#globalYear")?.addEventListener("change", queueRender);

    const observer = new MutationObserver(() => queueRender());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    queueRender();
  }

  boot();
})();