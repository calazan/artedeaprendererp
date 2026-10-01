// Amplia Financeiro > Locações e repasses com repasses manuais, percentual por lançamento,
// relatórios e correção definitiva das cores dos botões dinâmicos.
(() => {
  if (window.__saberRentalRepassesEnhancementLoaded) return;
  window.__saberRentalRepassesEnhancementLoaded = true;

  const CATEGORY = "Repasses e parcerias";
  let mounted = false;

  function money(value) {
    return Number(Number(value || 0).toFixed(2));
  }

  function brlLocal(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function html(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function id() {
    try { return uid(); } catch { return crypto.randomUUID?.() || `rr-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  }

  function today() {
    try { return todayISO(); } catch { return new Date().toISOString().slice(0, 10); }
  }

  function period() {
    try { return selectedPeriodKey(); } catch {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }
  }

  function periodName(value = period()) {
    try { return periodLabel(value); } catch {
      const [year, month] = String(value).split("-");
      return `${month}/${year}`;
    }
  }

  function rental() {
    state.rentalManagement ||= {};
    state.rentalManagement.manualRepasses ||= [];
    state.rentalManagement.repasses ||= [];
    state.rentalManagement.clinicReceipts ||= [];
    state.rentalManagement.equipment ||= [];
    state.rentalManagement.psychopedagogy ||= { professionalName: "Psicopedagoga", repassPercent: 60 };
    state.rentalManagement.clinic ||= { tenantName: "Clínica", roomName: "Sala da clínica" };
    return state.rentalManagement;
  }

  function accountById(accountId) {
    try { return getBankAccount(accountId); } catch {
      return (state.bankAccounts || []).find((account) => String(account.id) === String(accountId)) || null;
    }
  }

  function accountName(accountId) {
    return accountById(accountId)?.name || "-";
  }

  function accountOptions(selected = "") {
    return `<option value="">Selecione a conta</option>${(state.bankAccounts || []).map((account) => `
      <option value="${html(account.id)}" ${String(account.id) === String(selected) ? "selected" : ""}>${html(account.name || "Conta")} · ${brlLocal(account.balance)}</option>
    `).join("")}`;
  }

  function ensureCategory() {
    state.expenseCategories ||= [];
    const exists = state.expenseCategories.some((item) => String(item?.name || "").trim().toLowerCase() === CATEGORY.toLowerCase());
    if (exists) return;
    try { state.expenseCategories.push(normalizeExpenseCategory({ name: CATEGORY })); }
    catch { state.expenseCategories.push({ id: id(), name: CATEGORY }); }
  }

  function applyDynamicButtonColors() {
    const paint = (element, normal, active, foreground = "#fff") => {
      if (!element) return;
      const background = element.classList.contains("is-active") ? active : normal;
      element.style.setProperty("background", background, "important");
      element.style.setProperty("color", foreground, "important");
      element.style.setProperty("border-color", "rgba(255,255,255,.3)", "important");
      element.style.setProperty("box-shadow", "0 8px 20px rgba(49,31,54,.16), inset 0 1px 0 rgba(255,255,255,.28)", "important");
    };

    paint(
      document.querySelector('.tabs .tab[data-view="preRegistrations"]'),
      "linear-gradient(135deg,#e96aa7,#c94f8b)",
      "linear-gradient(135deg,#d85b98,#ad3e77)"
    );
    paint(
      document.querySelector('.tabs .tab[data-view="employees"]'),
      "linear-gradient(135deg,#6f7fca,#555aa8)",
      "linear-gradient(135deg,#5b68b7,#41488f)"
    );
    paint(
      document.querySelector('.finance-subtab[data-finance-pane="rentals"]'),
      "linear-gradient(135deg,#3f9c8d,#26786c)",
      "linear-gradient(135deg,#318b7d,#1f655c)"
    );
  }

  function injectStyles() {
    if (document.querySelector("#rentalRepassesEnhancementStyle")) return;
    const style = document.createElement("style");
    style.id = "rentalRepassesEnhancementStyle";
    style.textContent = `
      .manual-repass-panel{margin-top:18px}
      .manual-repass-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:end}
      .manual-repass-grid label{display:grid;gap:6px}
      .manual-repass-wide{grid-column:span 2}
      .manual-repass-calculation{padding:12px 14px;border-radius:14px;background:rgba(63,156,141,.10);border:1px solid rgba(63,156,141,.18)}
      .manual-repass-calculation span{display:block;font-size:12px;color:var(--muted)}
      .manual-repass-calculation strong{display:block;font-size:22px;margin-top:4px;color:#216e62}
      .manual-repass-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .manual-repass-toolbar button{min-height:40px}
      .manual-repass-status{display:inline-flex;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:850}
      .manual-repass-status.open{background:#fff1d6;color:#8a5a00}.manual-repass-status.paid{background:#dcfce7;color:#166534}
      .manual-repass-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0}
      .manual-repass-stat{padding:13px;border-radius:14px;background:rgba(255,255,255,.62);border:1px solid rgba(63,156,141,.13)}
      .manual-repass-stat span{display:block;font-size:12px;color:var(--muted)}.manual-repass-stat strong{display:block;margin-top:4px;font-size:20px}
      .manual-report-actions{display:flex;gap:8px;flex-wrap:wrap}
      .manual-report-actions .export-xls{background:linear-gradient(135deg,#2f8d66,#1f684b)!important;color:#fff!important}
      .manual-report-actions .export-pdf{background:linear-gradient(135deg,#c95a72,#a53e55)!important;color:#fff!important}
      @media(max-width:1000px){.manual-repass-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.manual-repass-summary{grid-template-columns:repeat(2,1fr)}}
      @media(max-width:650px){.manual-repass-grid,.manual-repass-summary{grid-template-columns:1fr}.manual-repass-wide{grid-column:auto}}
    `;
    document.head.appendChild(style);
  }

  function calculateFormAmount() {
    const base = Number(document.querySelector("#manualRepassBase")?.value || 0);
    const pct = Math.min(Math.max(Number(document.querySelector("#manualRepassPercent")?.value || 0), 0), 100);
    const amount = money(base * pct / 100);
    const output = document.querySelector("#manualRepassCalculated");
    if (output) output.textContent = brlLocal(amount);
    const hidden = document.querySelector("#manualRepassAmount");
    if (hidden) hidden.value = amount;
    return amount;
  }

  function addExpense(record) {
    ensureCategory();
    state.expenses ||= [];
    const expenseId = `manual-repass-${record.id}`;
    if (state.expenses.some((item) => String(item.id) === expenseId)) return expenseId;
    let expense;
    const payload = {
      id: expenseId,
      description: `Repasse - ${record.beneficiary}${record.description ? ` - ${record.description}` : ""}`,
      category: CATEGORY,
      amount: Number(record.amount || 0),
      date: record.paidDate || record.dueDate || today(),
      dueDate: record.dueDate || record.paidDate || today(),
      status: "paid",
      paidDate: record.paidDate || today(),
      paidFromAccountId: record.bankAccountId || "",
    };
    try { expense = normalizeExpense(payload); } catch { expense = payload; }
    state.expenses.push(expense);
    if (record.bankAccountId) {
      const account = accountById(record.bankAccountId);
      if (account) account.balance = money(Number(account.balance || 0) - Number(record.amount || 0));
    }
    return expenseId;
  }

  function reverseExpense(record) {
    if (!record.expenseId) return;
    const expense = (state.expenses || []).find((item) => String(item.id) === String(record.expenseId));
    if (expense?.status === "paid" && expense.paidFromAccountId) {
      const account = accountById(expense.paidFromAccountId);
      if (account) account.balance = money(Number(account.balance || 0) + Number(expense.amount || 0));
    }
    state.expenses = (state.expenses || []).filter((item) => String(item.id) !== String(record.expenseId));
    record.expenseId = "";
  }

  function manualRows(currentPeriod = period()) {
    return rental().manualRepasses
      .filter((item) => item.period === currentPeriod)
      .slice()
      .sort((a, b) => String(a.dueDate || a.createdAt || "").localeCompare(String(b.dueDate || b.createdAt || "")));
  }

  function renderManualRepasses() {
    const panel = document.querySelector("#manualRepassesPanel");
    if (!panel) return;
    applyDynamicButtonColors();

    const currentPeriod = period();
    const periodField = document.querySelector("#manualRepassPeriod");
    if (periodField && !periodField.dataset.touched) periodField.value = currentPeriod;
    const accountField = document.querySelector("#manualRepassAccount");
    if (accountField) {
      const previous = accountField.value;
      accountField.innerHTML = accountOptions(previous);
      if (previous) accountField.value = previous;
    }

    const rows = manualRows(currentPeriod);
    const total = money(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const paid = money(rows.filter((row) => row.status === "paid").reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const pending = money(total - paid);
    const summary = document.querySelector("#manualRepassSummary");
    if (summary) summary.innerHTML = `
      <div class="manual-repass-stat"><span>Repasses cadastrados</span><strong>${rows.length}</strong></div>
      <div class="manual-repass-stat"><span>Total do período</span><strong>${brlLocal(total)}</strong></div>
      <div class="manual-repass-stat"><span>Já pagos</span><strong>${brlLocal(paid)}</strong></div>
      <div class="manual-repass-stat"><span>Pendente</span><strong>${brlLocal(pending)}</strong></div>`;

    const tbody = document.querySelector("#manualRepassTable");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">Nenhum repasse cadastrado em ${html(periodName(currentPeriod))}.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((row) => `
      <tr>
        <td><strong>${html(row.beneficiary)}</strong><small>${html(row.description || "")}</small></td>
        <td>${brlLocal(row.baseAmount)}</td>
        <td>${Number(row.percent || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%</td>
        <td><strong>${brlLocal(row.amount)}</strong></td>
        <td>${html(row.dueDate || "-")}</td>
        <td><span class="manual-repass-status ${row.status === "paid" ? "paid" : "open"}">${row.status === "paid" ? "Pago" : "Pendente"}</span></td>
        <td>${row.status === "paid" ? html(row.paidDate || "-") : "-"}</td>
        <td>${html(accountName(row.bankAccountId))}</td>
        <td><div class="manual-repass-toolbar">
          ${row.status !== "paid" ? `<button type="button" class="small" data-manual-repass-pay="${html(row.id)}">Pagar</button>` : `<button type="button" class="small secondary" data-manual-repass-reverse="${html(row.id)}">Estornar</button>`}
          <button type="button" class="small danger" data-manual-repass-delete="${html(row.id)}">Excluir</button>
        </div></td>
      </tr>`).join("");
  }

  function collectReportRows(currentPeriod = period()) {
    const data = rental();
    const rows = [];

    (data.manualRepasses || []).filter((item) => item.period === currentPeriod).forEach((item) => rows.push({
      type: "Repasse cadastrado",
      period: item.period,
      description: `${item.beneficiary}${item.description ? ` - ${item.description}` : ""}`,
      base: item.baseAmount,
      percent: item.percent,
      amount: item.amount,
      status: item.status === "paid" ? "Pago" : "Pendente",
      date: item.status === "paid" ? item.paidDate : item.dueDate,
      account: accountName(item.bankAccountId),
      note: item.note || "",
    }));

    (data.repasses || []).filter((item) => item.period === currentPeriod).forEach((item) => rows.push({
      type: "Repasse Psicopedagogia",
      period: item.period,
      description: data.psychopedagogy?.professionalName || "Psicopedagoga",
      base: "",
      percent: data.psychopedagogy?.repassPercent ?? "",
      amount: item.amount,
      status: "Pago",
      date: item.date || "",
      account: accountName(item.bankAccountId),
      note: item.note || "",
    }));

    (data.clinicReceipts || []).filter((item) => item.period === currentPeriod).forEach((item) => rows.push({
      type: "Locação da clínica",
      period: item.period,
      description: `${data.clinic?.tenantName || "Clínica"} - ${data.clinic?.roomName || "Sala"}`,
      base: "",
      percent: "",
      amount: item.amount,
      status: "Recebido",
      date: item.date || "",
      account: accountName(item.bankAccountId),
      note: item.note || "",
    }));

    (data.equipment || []).forEach((item) => {
      if (item.date && item.date.slice(0, 7) !== currentPeriod) return;
      rows.push({
        type: "Equipamento",
        period: item.date?.slice(0, 7) || currentPeriod,
        description: `${item.description || "Equipamento"} - comprado por ${item.purchasedBy === "clinic" ? "Clínica" : "Arte de Aprender"}`,
        base: "",
        percent: "",
        amount: item.amount,
        status: "Patrimônio",
        date: item.date || "",
        account: "-",
        note: item.note || "",
      });
    });
    return rows;
  }

  function reportTableHtml(rows) {
    return `<table><thead><tr><th>Tipo</th><th>Descrição</th><th>Base</th><th>%</th><th>Valor</th><th>Status</th><th>Data</th><th>Conta</th><th>Observação</th></tr></thead><tbody>${rows.map((row) => `
      <tr><td>${html(row.type)}</td><td>${html(row.description)}</td><td>${row.base === "" ? "-" : brlLocal(row.base)}</td><td>${row.percent === "" ? "-" : `${html(row.percent)}%`}</td><td>${brlLocal(row.amount)}</td><td>${html(row.status)}</td><td>${html(row.date || "-")}</td><td>${html(row.account)}</td><td>${html(row.note || "")}</td></tr>`).join("")}</tbody></table>`;
  }

  function exportPdf() {
    const currentPeriod = period();
    const rows = collectReportRows(currentPeriod);
    if (!rows.length) return showToast("Não há dados para exportar neste período.");
    const totalRepasses = money(rows.filter((row) => row.type.includes("Repasse")).reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const totalClinic = money(rows.filter((row) => row.type === "Locação da clínica").reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const win = window.open("", "_blank", "width=1100,height=760");
    if (!win) return showToast("O navegador bloqueou a janela do relatório.");
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Relatório de locações e repasses</title><style>
      body{font-family:Arial,sans-serif;color:#2b2430;padding:28px}h1{margin:0 0 6px;color:#713978}p{color:#666;margin:0 0 20px}.summary{display:flex;gap:12px;margin:18px 0}.box{padding:12px 16px;border:1px solid #ddd;border-radius:10px}.box span{display:block;font-size:11px;color:#777}.box strong{font-size:18px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #ddd;padding:7px;text-align:left}th{background:#f2e9f4}@media print{body{padding:0}}
    </style></head><body><h1>Relatório de Locações e Repasses</h1><p>Arte de Aprender · ${html(periodName(currentPeriod))}</p><div class="summary"><div class="box"><span>Total de repasses</span><strong>${brlLocal(totalRepasses)}</strong></div><div class="box"><span>Locações recebidas</span><strong>${brlLocal(totalClinic)}</strong></div><div class="box"><span>Lançamentos</span><strong>${rows.length}</strong></div></div>${reportTableHtml(rows)}<script>window.onload=()=>window.print();<\/script></body></html>`);
    win.document.close();
  }

  function exportExcel() {
    const currentPeriod = period();
    const rows = collectReportRows(currentPeriod);
    if (!rows.length) return showToast("Não há dados para exportar neste período.");
    const table = reportTableHtml(rows);
    const content = `<!doctype html><html><head><meta charset="utf-8"></head><body><h2>Relatório de Locações e Repasses - ${html(periodName(currentPeriod))}</h2>${table}</body></html>`;
    const blob = new Blob(["\ufeff", content], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `locacoes-repasses-${currentPeriod}.xls`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Relatório para Excel exportado.");
  }

  function mount() {
    if (mounted) return true;
    const pane = document.querySelector('[data-finance-pane-content="rentals"]');
    if (!pane) return false;
    mounted = true;
    injectStyles();
    rental();
    ensureCategory();
    applyDynamicButtonColors();

    const panel = document.createElement("section");
    panel.className = "panel glass-card manual-repass-panel";
    panel.id = "manualRepassesPanel";
    panel.innerHTML = `
      <div class="panel-head stackable">
        <div><h2>Cadastro de repasses</h2><span>Cadastre qualquer repasse, defina a porcentagem e acompanhe o pagamento.</span></div>
        <div class="manual-report-actions"><button type="button" class="export-pdf" id="exportRentalRepassPdf">Exportar PDF</button><button type="button" class="export-xls" id="exportRentalRepassExcel">Exportar Excel</button></div>
      </div>
      <form id="manualRepassForm" class="manual-repass-grid">
        <label>Favorecido / parceiro<input id="manualRepassBeneficiary" required placeholder="Ex.: Psicopedagoga, professora, parceiro..." /></label>
        <label>Competência<input id="manualRepassPeriod" type="month" required /></label>
        <label>Valor-base<input id="manualRepassBase" type="number" min="0.01" step="0.01" required /></label>
        <label>Percentual do repasse (%)<input id="manualRepassPercent" type="number" min="0" max="100" step="0.01" value="60" required /></label>
        <label class="manual-repass-wide">Descrição / referência<input id="manualRepassDescription" placeholder="Ex.: atendimentos do mês, parceria, comissão..." /></label>
        <label>Vencimento<input id="manualRepassDueDate" type="date" /></label>
        <label>Status<select id="manualRepassStatus"><option value="open">Pendente</option><option value="paid">Já pago</option></select></label>
        <label>Conta de saída<select id="manualRepassAccount"></select></label>
        <label>Data do pagamento<input id="manualRepassPaidDate" type="date" /></label>
        <div class="manual-repass-calculation"><span>Valor calculado do repasse</span><strong id="manualRepassCalculated">R$ 0,00</strong><input id="manualRepassAmount" type="hidden" /></div>
        <label class="manual-repass-wide">Observação<input id="manualRepassNote" placeholder="Informações adicionais" /></label>
        <div><button type="submit">Cadastrar repasse</button></div>
      </form>
      <div class="manual-repass-summary" id="manualRepassSummary"></div>
      <div class="table-wrap"><table><thead><tr><th>Favorecido</th><th>Valor-base</th><th>%</th><th>Repasse</th><th>Vencimento</th><th>Status</th><th>Pagamento</th><th>Conta</th><th>Ações</th></tr></thead><tbody id="manualRepassTable"></tbody></table></div>`;
    pane.appendChild(panel);

    document.querySelector("#manualRepassPeriod").value = period();
    document.querySelector("#manualRepassDueDate").value = today();
    document.querySelector("#manualRepassPaidDate").value = today();
    document.querySelector("#manualRepassAccount").innerHTML = accountOptions("");

    ["#manualRepassBase", "#manualRepassPercent"].forEach((selector) => document.querySelector(selector)?.addEventListener("input", calculateFormAmount));
    document.querySelector("#manualRepassPeriod")?.addEventListener("change", (event) => { event.target.dataset.touched = "1"; });

    document.querySelector("#manualRepassForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const beneficiary = document.querySelector("#manualRepassBeneficiary")?.value.trim() || "";
      const currentPeriod = document.querySelector("#manualRepassPeriod")?.value || period();
      const baseAmount = Number(document.querySelector("#manualRepassBase")?.value || 0);
      const percent = Math.min(Math.max(Number(document.querySelector("#manualRepassPercent")?.value || 0), 0), 100);
      const amount = money(baseAmount * percent / 100);
      const status = document.querySelector("#manualRepassStatus")?.value === "paid" ? "paid" : "open";
      const bankAccountId = document.querySelector("#manualRepassAccount")?.value || "";
      if (!beneficiary) return showToast("Informe quem receberá o repasse.");
      if (!(baseAmount > 0)) return showToast("Informe o valor-base do repasse.");
      if (!(percent > 0)) return showToast("Informe a porcentagem do repasse.");
      if (status === "paid" && !bankAccountId) return showToast("Escolha a conta usada no pagamento.");
      const record = {
        id: id(), period: currentPeriod, beneficiary,
        description: document.querySelector("#manualRepassDescription")?.value.trim() || "",
        baseAmount: money(baseAmount), percent: money(percent), amount,
        dueDate: document.querySelector("#manualRepassDueDate")?.value || "",
        status, paidDate: status === "paid" ? (document.querySelector("#manualRepassPaidDate")?.value || today()) : "",
        bankAccountId: status === "paid" ? bankAccountId : "",
        note: document.querySelector("#manualRepassNote")?.value.trim() || "",
        expenseId: "", createdAt: new Date().toISOString(),
      };
      if (record.status === "paid") record.expenseId = addExpense(record);
      rental().manualRepasses.push(record);
      saveState();
      event.target.reset();
      document.querySelector("#manualRepassPercent").value = rental().psychopedagogy?.repassPercent ?? 60;
      document.querySelector("#manualRepassPeriod").value = period();
      document.querySelector("#manualRepassDueDate").value = today();
      document.querySelector("#manualRepassPaidDate").value = today();
      calculateFormAmount();
      renderManualRepasses();
      showToast(record.status === "paid" ? "Repasse cadastrado, pago e lançado nas despesas." : "Repasse cadastrado como pendente.");
    });

    panel.addEventListener("click", (event) => {
      const payButton = event.target.closest("[data-manual-repass-pay]");
      const reverseButton = event.target.closest("[data-manual-repass-reverse]");
      const deleteButton = event.target.closest("[data-manual-repass-delete]");
      const recordId = payButton?.dataset.manualRepassPay || reverseButton?.dataset.manualRepassReverse || deleteButton?.dataset.manualRepassDelete;
      if (!recordId) return;
      const record = rental().manualRepasses.find((item) => String(item.id) === String(recordId));
      if (!record) return;

      if (payButton) {
        const defaultAccount = document.querySelector("#manualRepassAccount")?.value || "";
        const accountId = prompt("Informe o ID da conta de saída ou deixe o campo da conta selecionado no formulário antes de clicar em Pagar:", defaultAccount) || defaultAccount;
        if (!accountId || !accountById(accountId)) return showToast("Selecione uma conta válida no formulário e tente novamente.");
        record.status = "paid";
        record.paidDate = today();
        record.bankAccountId = accountId;
        record.expenseId = addExpense(record);
        saveState();
        renderManualRepasses();
        try { renderAll(); } catch {}
        return showToast("Repasse pago e debitado da conta escolhida.");
      }

      if (reverseButton) {
        reverseExpense(record);
        record.status = "open";
        record.paidDate = "";
        record.bankAccountId = "";
        saveState();
        renderManualRepasses();
        try { renderAll(); } catch {}
        return showToast("Pagamento do repasse estornado.");
      }

      if (deleteButton) {
        if (!confirm(`Excluir o repasse de ${record.beneficiary}?`)) return;
        if (record.status === "paid") reverseExpense(record);
        rental().manualRepasses = rental().manualRepasses.filter((item) => String(item.id) !== String(record.id));
        saveState();
        renderManualRepasses();
        try { renderAll(); } catch {}
        showToast("Repasse excluído.");
      }
    });

    document.querySelector("#exportRentalRepassPdf")?.addEventListener("click", exportPdf);
    document.querySelector("#exportRentalRepassExcel")?.addEventListener("click", exportExcel);
    document.querySelector("#globalMonth")?.addEventListener("change", () => setTimeout(renderManualRepasses, 0));
    document.querySelector("#globalYear")?.addEventListener("change", () => setTimeout(renderManualRepasses, 0));
    document.addEventListener("click", (event) => {
      if (event.target.closest('[data-finance-pane="rentals"]')) setTimeout(renderManualRepasses, 0);
    });

    renderManualRepasses();
    return true;
  }

  const observer = new MutationObserver(() => {
    applyDynamicButtonColors();
    if (!mounted) mount();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });

  applyDynamicButtonColors();
  if (!mount()) {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      applyDynamicButtonColors();
      if (mount() || attempts > 40) clearInterval(timer);
    }, 250);
  }
})();
