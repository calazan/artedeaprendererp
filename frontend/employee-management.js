// Gestão de funcionários: cadastro, horários, salários, impostos e documentos.
(() => {
  if (window.__saberEmployeeManagementLoaded) return;
  window.__saberEmployeeManagementLoaded = true;

  const EMPLOYEE_ENDPOINT = "/api/employees";
  const DOCUMENT_ENDPOINT = "/api/employee-documents";
  const SNAPSHOT_KEY = "arteDeAprenderERP.employee.snapshot.v1";
  const PUSH_DELAY_MS = 1600;
  const WEEKDAYS = [
    [1, "Segunda-feira"], [2, "Terça-feira"], [3, "Quarta-feira"],
    [4, "Quinta-feira"], [5, "Sexta-feira"], [6, "Sábado"], [0, "Domingo"],
  ];
  const TAX_TYPES = ["INSS", "FGTS", "DAS", "IRRF", "ISS", "Outro"];
  const DOC_KIND_LABELS = {
    tax_receipt: "Comprovante de imposto",
    invoice: "Nota fiscal",
    salary_receipt: "Comprovante de salário",
    contract: "Contrato / documento",
    other: "Outro documento",
  };

  let currentPane = "registry";
  let documentCache = [];
  let employeePushTimer = null;
  let employeeSyncBusy = false;
  let suppressEmployeePush = false;

  function employeeSyncKey() {
    return String(state?.settings?.remoteSync?.syncKey || "").trim();
  }

  function clone(value) {
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
  }

  function normalizeSchedule(item = {}) {
    return {
      id: item.id || uid(),
      weekday: Number(item.weekday ?? 1),
      start: String(item.start || ""),
      end: String(item.end || ""),
      note: String(item.note || "").trim(),
    };
  }

  function normalizeSalaryPayment(item = {}) {
    return {
      id: item.id || uid(),
      period: String(item.period || ""),
      amount: Number(item.amount || 0),
      paidDate: String(item.paidDate || ""),
      accountId: String(item.accountId || ""),
      expenseId: String(item.expenseId || ""),
      createdAt: item.createdAt || new Date().toISOString(),
    };
  }

  function normalizeTax(item = {}) {
    return {
      id: item.id || uid(),
      period: String(item.period || selectedPeriodKey()),
      type: TAX_TYPES.includes(item.type) ? item.type : (item.type || "Outro"),
      description: String(item.description || "").trim(),
      amount: Number(item.amount || 0),
      dueDate: String(item.dueDate || ""),
      status: item.status === "paid" ? "paid" : "open",
      paidDate: String(item.paidDate || ""),
      accountId: String(item.accountId || ""),
      expenseId: String(item.expenseId || ""),
      createdAt: item.createdAt || new Date().toISOString(),
    };
  }

  function normalizeEmployee(employee = {}) {
    return {
      id: employee.id || uid(),
      name: String(employee.name || "").trim(),
      role: String(employee.role || "").trim(),
      contractType: String(employee.contractType || "mei").trim(),
      document: String(employee.document || "").trim(),
      phone: String(employee.phone || "").trim(),
      email: String(employee.email || "").trim(),
      startDate: String(employee.startDate || ""),
      salary: Number(employee.salary || 0),
      dueDay: Math.min(Math.max(Number(employee.dueDay || 5), 1), 31),
      status: employee.status === "inactive" ? "inactive" : "active",
      notes: String(employee.notes || "").trim(),
      schedules: Array.isArray(employee.schedules) ? employee.schedules.map(normalizeSchedule) : [],
      salaryPayments: Array.isArray(employee.salaryPayments) ? employee.salaryPayments.map(normalizeSalaryPayment) : [],
      taxes: Array.isArray(employee.taxes) ? employee.taxes.map(normalizeTax) : [],
      createdAt: employee.createdAt || todayISO(),
    };
  }

  function ensureEmployeeState() {
    state.employees = (Array.isArray(state.employees) ? state.employees : []).map(normalizeEmployee);
    return state.employees;
  }

  function employeesSorted({ activeOnly = false } = {}) {
    return ensureEmployeeState()
      .filter((employee) => !activeOnly || employee.status === "active")
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
  }

  function employeeById(id = "") {
    return ensureEmployeeState().find((employee) => String(employee.id) === String(id)) || null;
  }

  function accountOptions(selected = "") {
    const options = [`<option value="">Selecione a conta</option>`];
    (state.bankAccounts || []).forEach((account) => {
      options.push(`<option value="${escapeAttr(account.id)}" ${String(account.id) === String(selected) ? "selected" : ""}>${escapeHTML(account.name || "Conta")} · ${brl(account.balance)}</option>`);
    });
    return options.join("");
  }

  function employeeOptions(selected = "", { includeInactive = true } = {}) {
    const employees = employeesSorted().filter((employee) => includeInactive || employee.status === "active");
    return `<option value="">Selecione o funcionário</option>${employees.map((employee) => `
      <option value="${escapeAttr(employee.id)}" ${String(employee.id) === String(selected) ? "selected" : ""}>${escapeHTML(employee.name)}${employee.status === "inactive" ? " (inativo)" : ""}</option>
    `).join("")}`;
  }

  function contractLabel(type = "") {
    return ({ clt: "CLT", mei: "MEI / PJ", autonomo: "Autônomo", estagio: "Estágio", outro: "Outro" })[type] || type || "-";
  }

  function salaryPayment(employee, period = selectedPeriodKey()) {
    return (employee.salaryPayments || []).find((item) => item.period === period) || null;
  }

  function taxesForPeriod(employee, period = selectedPeriodKey()) {
    return (employee.taxes || []).filter((tax) => tax.period === period);
  }

  function scheduleHours(schedule = {}) {
    if (!schedule.start || !schedule.end) return 0;
    const [sh, sm] = schedule.start.split(":").map(Number);
    const [eh, em] = schedule.end.split(":").map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) return 0;
    return Math.max(((eh * 60 + em) - (sh * 60 + sm)) / 60, 0);
  }

  function employeeWeeklyHours(employee = {}) {
    return (employee.schedules || []).reduce((sum, item) => sum + scheduleHours(item), 0);
  }

  function currentSalaryTotal() {
    return employeesSorted({ activeOnly: true }).reduce((sum, employee) => sum + Number(employee.salary || 0), 0);
  }

  function currentTaxTotal() {
    return employeesSorted().reduce((sum, employee) => sum + taxesForPeriod(employee).reduce((taxSum, tax) => taxSum + Number(tax.amount || 0), 0), 0);
  }

  function currentPaidTotal() {
    const salaryPaid = employeesSorted().reduce((sum, employee) => sum + Number(salaryPayment(employee)?.amount || 0), 0);
    const taxesPaid = employeesSorted().reduce((sum, employee) => sum + taxesForPeriod(employee).filter((tax) => tax.status === "paid").reduce((taxSum, tax) => taxSum + Number(tax.amount || 0), 0), 0);
    return salaryPaid + taxesPaid;
  }

  function injectStyles() {
    if (document.querySelector("#employeeManagementStyle")) return;
    const style = document.createElement("style");
    style.id = "employeeManagementStyle";
    style.textContent = `
      .employee-subtabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
      .employee-subtab{border:1px solid rgba(116,72,125,.18);background:rgba(255,255,255,.58);color:var(--text,#312736);padding:10px 15px;border-radius:999px;font-weight:800;cursor:pointer}
      .employee-subtab.is-active{background:linear-gradient(135deg,#7d4a8c,#a867b2);color:#fff;border-color:transparent}
      .employee-pane{display:none}.employee-pane.is-active{display:block}
      .employee-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
      .employee-metric{padding:15px;border-radius:16px;background:rgba(255,255,255,.72);border:1px solid rgba(116,72,125,.12)}
      .employee-metric span{display:block;font-size:12px;opacity:.72}.employee-metric strong{display:block;font-size:22px;margin-top:5px}
      .employee-form-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
      .employee-form-grid label{display:grid;gap:6px;font-weight:700;font-size:13px}.employee-form-grid input,.employee-form-grid select,.employee-form-grid textarea{width:100%}
      .employee-span-2{grid-column:span 2}.employee-span-4{grid-column:1/-1}
      .employee-actions{display:flex;gap:8px;align-items:end;flex-wrap:wrap}
      .employee-status-pill{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;font-weight:800;font-size:11px;background:#dcfce7;color:#166534}
      .employee-status-pill.inactive{background:#e5e7eb;color:#4b5563}.employee-status-pill.pending{background:#fee2e2;color:#991b1b}.employee-status-pill.partial{background:#fef3c7;color:#92400e}
      .employee-table small{display:block;margin-top:3px;opacity:.72}.employee-table td{vertical-align:top}
      .employee-inline-controls{display:grid;grid-template-columns:minmax(120px,1fr) 140px 130px auto;gap:7px;min-width:520px}
      .employee-doc-upload{display:grid;grid-template-columns:1.1fr .8fr .8fr 1.4fr auto;gap:10px;align-items:end}
      .employee-file-chip{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid rgba(116,72,125,.12);border-radius:12px;background:rgba(255,255,255,.55);margin-bottom:8px}
      .employee-file-chip div{min-width:0}.employee-file-chip strong,.employee-file-chip small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .employee-danger-note{padding:9px 11px;border-radius:10px;background:#fff1f2;color:#9f1239;font-weight:700;font-size:12px}
      .employee-ok-note{padding:9px 11px;border-radius:10px;background:#ecfdf5;color:#166534;font-weight:700;font-size:12px}
      .employee-schedule-summary{display:flex;gap:8px;flex-wrap:wrap}.employee-schedule-chip{padding:6px 9px;border-radius:10px;background:rgba(125,74,140,.09);font-size:12px;font-weight:700}
      @media(max-width:1050px){.employee-metrics{grid-template-columns:repeat(2,1fr)}.employee-form-grid{grid-template-columns:repeat(2,1fr)}.employee-span-4{grid-column:1/-1}.employee-doc-upload{grid-template-columns:1fr 1fr}.employee-doc-upload .employee-upload-file{grid-column:1/-1}}
      @media(max-width:680px){.employee-metrics,.employee-form-grid,.employee-doc-upload{grid-template-columns:1fr}.employee-span-2,.employee-span-4{grid-column:auto}.employee-inline-controls{grid-template-columns:1fr;min-width:280px}}
    `;
    document.head.appendChild(style);
  }

  function mountView() {
    if (document.querySelector("#employeesView")) return;
    injectStyles();
    ensureEmployeeState();

    const financeTab = document.querySelector('.tabs .tab[data-view="finance"]');
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.dataset.view = "employees";
    tab.textContent = "Funcionários";
    financeTab?.insertAdjacentElement("afterend", tab);

    const view = document.createElement("section");
    view.className = "view";
    view.id = "employeesView";
    view.innerHTML = `
      <div class="employee-subtabs" aria-label="Gestão de funcionários">
        <button type="button" class="employee-subtab is-active" data-employee-pane="registry">Cadastro</button>
        <button type="button" class="employee-subtab" data-employee-pane="schedule">Horários</button>
        <button type="button" class="employee-subtab" data-employee-pane="salary">Salários</button>
        <button type="button" class="employee-subtab" data-employee-pane="taxes">Impostos</button>
        <button type="button" class="employee-subtab" data-employee-pane="documents">Documentos</button>
      </div>
      <div class="employee-metrics" id="employeeMetrics"></div>

      <div class="employee-pane is-active" data-employee-pane-content="registry">
        <section class="panel glass-card">
          <div class="panel-head"><div><h2>Cadastro de funcionário</h2><span>Dados profissionais e financeiros</span></div></div>
          <form id="employeeForm" class="employee-form-grid">
            <input type="hidden" id="employeeId" />
            <label>Nome completo<input id="employeeName" required /></label>
            <label>Função / cargo<input id="employeeRole" placeholder="Ex.: Professora, auxiliar..." /></label>
            <label>Tipo de contratação<select id="employeeContractType"><option value="mei">MEI / PJ</option><option value="clt">CLT</option><option value="autonomo">Autônomo</option><option value="estagio">Estágio</option><option value="outro">Outro</option></select></label>
            <label>CPF / CNPJ<input id="employeeDocument" /></label>
            <label>Telefone<input id="employeePhone" /></label>
            <label>E-mail<input id="employeeEmail" type="email" /></label>
            <label>Data de início<input id="employeeStartDate" type="date" /></label>
            <label>Status<select id="employeeStatus"><option value="active">Ativo</option><option value="inactive">Inativo</option></select></label>
            <label>Salário / valor mensal<input id="employeeSalary" type="number" min="0" step="0.01" /></label>
            <label>Dia do pagamento<input id="employeeDueDay" type="number" min="1" max="31" value="5" /></label>
            <label class="employee-span-2">Observações<input id="employeeNotes" placeholder="Informações administrativas, contrato, combinados..." /></label>
            <div class="employee-span-4 employee-actions"><button type="submit">Salvar funcionário</button><button type="button" class="secondary" id="clearEmployeeForm">Limpar</button></div>
          </form>
        </section>
        <section class="panel glass-card finance-section-gap">
          <div class="panel-head"><div><h2>Funcionários cadastrados</h2><span id="employeeRegistryInfo"></span></div></div>
          <div class="table-wrap"><table class="employee-table"><thead><tr><th>Funcionário</th><th>Função</th><th>Contrato</th><th>Contato</th><th>Valor mensal</th><th>Horário semanal</th><th>Status</th><th>Ações</th></tr></thead><tbody id="employeeRegistryTable"></tbody></table></div>
        </section>
      </div>

      <div class="employee-pane" data-employee-pane-content="schedule">
        <section class="panel glass-card">
          <div class="panel-head"><div><h2>Horários dos funcionários</h2><span>Cadastre um ou mais períodos por dia</span></div></div>
          <form id="employeeScheduleForm" class="employee-form-grid">
            <label>Funcionário<select id="scheduleEmployeeId" required></select></label>
            <label>Dia da semana<select id="scheduleWeekday">${WEEKDAYS.map(([value,label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
            <label>Entrada<input id="scheduleStart" type="time" required /></label>
            <label>Saída<input id="scheduleEnd" type="time" required /></label>
            <label class="employee-span-2">Observação<input id="scheduleNote" placeholder="Ex.: intervalo, ballet, atendimento externo..." /></label>
            <div class="employee-actions"><button type="submit">Adicionar horário</button></div>
          </form>
        </section>
        <section class="panel glass-card finance-section-gap"><div class="panel-head"><div><h2>Grade semanal</h2><span>Resumo de carga horária cadastrada</span></div></div><div id="employeeScheduleList"></div></section>
      </div>

      <div class="employee-pane" data-employee-pane-content="salary">
        <section class="panel glass-card">
          <div class="panel-head"><div><h2>Salários — <span id="employeeSalaryPeriod"></span></h2><span>Ao registrar o pagamento, o valor sai da conta escolhida e entra em Despesas</span></div></div>
          <div class="table-wrap"><table class="employee-table"><thead><tr><th>Funcionário</th><th>Salário</th><th>Vencimento</th><th>Status</th><th>Pagamento</th><th>Receber / pagar</th></tr></thead><tbody id="employeeSalaryTable"></tbody></table></div>
        </section>
      </div>

      <div class="employee-pane" data-employee-pane-content="taxes">
        <section class="panel glass-card">
          <div class="panel-head"><div><h2>Impostos e encargos</h2><span>Controle individual por funcionário e competência</span></div></div>
          <form id="employeeTaxForm" class="employee-form-grid">
            <label>Funcionário<select id="taxEmployeeId" required></select></label>
            <label>Competência<input id="taxPeriod" type="month" required /></label>
            <label>Imposto<select id="taxType">${TAX_TYPES.map((type) => `<option>${type}</option>`).join("")}</select></label>
            <label>Valor<input id="taxAmount" type="number" min="0" step="0.01" required /></label>
            <label>Vencimento<input id="taxDueDate" type="date" required /></label>
            <label class="employee-span-2">Descrição<input id="taxDescription" placeholder="Ex.: DAS MEI, INSS competência..." /></label>
            <div class="employee-actions"><button type="submit">Cadastrar imposto</button></div>
          </form>
        </section>
        <section class="panel glass-card finance-section-gap"><div class="panel-head"><div><h2>Impostos de <span id="employeeTaxPeriodLabel"></span></h2><span>Pago ou pendente, com comprovante anexável</span></div></div><div class="table-wrap"><table class="employee-table"><thead><tr><th>Funcionário</th><th>Imposto</th><th>Vencimento</th><th>Valor</th><th>Status</th><th>Pagamento</th><th>Comprovante</th><th>Ações</th></tr></thead><tbody id="employeeTaxTable"></tbody></table></div></section>
      </div>

      <div class="employee-pane" data-employee-pane-content="documents">
        <section class="panel glass-card">
          <div class="panel-head"><div><h2>Documentos dos funcionários</h2><span>Notas fiscais, comprovantes de impostos, salários e contratos</span></div></div>
          <form id="employeeDocumentForm" class="employee-doc-upload">
            <label>Funcionário<select id="documentEmployeeId" required></select></label>
            <label>Tipo<select id="documentKind">${Object.entries(DOC_KIND_LABELS).map(([value,label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
            <label>Competência<input id="documentPeriod" type="month" /></label>
            <label class="employee-upload-file">Arquivo PDF ou imagem<input id="employeeDocumentFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required /></label>
            <button type="submit">Enviar documento</button>
          </form>
          <p class="employee-danger-note" style="margin-top:12px">Arquivos de funcionários são privados e exigem a chave interna do Arte de Aprender para serem enviados ou abertos. Limite de 3 MB por arquivo.</p>
        </section>
        <section class="panel glass-card finance-section-gap"><div class="panel-head stackable"><div><h2>Arquivos armazenados</h2><span id="employeeDocumentInfo">Carregando...</span></div><label>Filtrar funcionário<select id="documentFilterEmployee"></select></label></div><div id="employeeDocumentList"></div></section>
      </div>
    `;

    const reportsView = document.querySelector("#reportsView");
    reportsView?.insertAdjacentElement("beforebegin", view);
    if (!view.parentElement) document.querySelector("main.main")?.appendChild(view);

    try { views.employees = view; } catch {}
    try { titles.employees = "Funcionários"; } catch {}

    tab.addEventListener("click", () => {
      switchView("employees");
      renderEmployeeManagement();
      loadDocumentMetadata().catch(() => {});
    });

    view.addEventListener("click", handleClick);
    view.addEventListener("submit", handleSubmit);
    view.addEventListener("change", handleChange);
  }

  function renderMetrics() {
    const box = document.querySelector("#employeeMetrics");
    if (!box) return;
    const active = employeesSorted({ activeOnly: true }).length;
    const salary = currentSalaryTotal();
    const taxes = currentTaxTotal();
    const paid = currentPaidTotal();
    box.innerHTML = `
      <div class="employee-metric"><span>Funcionários ativos</span><strong>${active}</strong></div>
      <div class="employee-metric"><span>Folha prevista no mês</span><strong>${brl(salary)}</strong></div>
      <div class="employee-metric"><span>Impostos do mês</span><strong>${brl(taxes)}</strong></div>
      <div class="employee-metric"><span>Salários + impostos pagos</span><strong>${brl(paid)}</strong></div>
    `;
  }

  function renderEmployeeSelects() {
    ["scheduleEmployeeId", "taxEmployeeId", "documentEmployeeId", "documentFilterEmployee"].forEach((id) => {
      const select = document.querySelector(`#${id}`);
      if (!select) return;
      const previous = select.value;
      select.innerHTML = employeeOptions(previous, { includeInactive: id === "documentFilterEmployee" });
      if (previous && employeeById(previous)) select.value = previous;
    });
    const taxPeriod = document.querySelector("#taxPeriod");
    if (taxPeriod && !taxPeriod.value) taxPeriod.value = selectedPeriodKey();
    const docPeriod = document.querySelector("#documentPeriod");
    if (docPeriod && !docPeriod.value) docPeriod.value = selectedPeriodKey();
  }

  function renderRegistry() {
    const tbody = document.querySelector("#employeeRegistryTable");
    const info = document.querySelector("#employeeRegistryInfo");
    if (!tbody) return;
    const employees = employeesSorted();
    if (info) info.textContent = `${employees.length} funcionário(s) cadastrado(s)`;
    tbody.innerHTML = employees.length ? employees.map((employee) => `
      <tr>
        <td><strong>${escapeHTML(employee.name)}</strong><small>${escapeHTML(employee.document || "Sem CPF/CNPJ")}</small></td>
        <td>${escapeHTML(employee.role || "-")}</td>
        <td>${escapeHTML(contractLabel(employee.contractType))}<small>Início: ${employee.startDate ? formatDateBR(employee.startDate) : "-"}</small></td>
        <td>${escapeHTML(employee.phone || "-")}<small>${escapeHTML(employee.email || "-")}</small></td>
        <td><strong>${brl(employee.salary)}</strong><small>Pagamento dia ${employee.dueDay}</small></td>
        <td>${formatHours(employeeWeeklyHours(employee))}/semana</td>
        <td><span class="employee-status-pill ${employee.status === "inactive" ? "inactive" : ""}">${employee.status === "active" ? "Ativo" : "Inativo"}</span></td>
        <td><div class="row-actions"><button type="button" class="small secondary" data-edit-employee="${escapeAttr(employee.id)}">Editar</button><button type="button" class="small ${employee.status === "active" ? "danger" : "secondary"}" data-toggle-employee="${escapeAttr(employee.id)}">${employee.status === "active" ? "Inativar" : "Reativar"}</button></div></td>
      </tr>
    `).join("") : `<tr><td colspan="8"><div class="empty"><strong>Nenhum funcionário cadastrado</strong><span>Cadastre o primeiro funcionário acima.</span></div></td></tr>`;
  }

  function renderSchedules() {
    const box = document.querySelector("#employeeScheduleList");
    if (!box) return;
    const employees = employeesSorted().filter((employee) => employee.schedules.length);
    box.innerHTML = employees.length ? employees.map((employee) => {
      const schedules = employee.schedules.slice().sort((a,b) => ((a.weekday || 7) - (b.weekday || 7)) || a.start.localeCompare(b.start));
      return `<div class="settings-card" style="margin-bottom:12px"><div class="panel-head"><div><h3>${escapeHTML(employee.name)}</h3><span>${formatHours(employeeWeeklyHours(employee))} por semana</span></div></div><div class="employee-schedule-summary">${schedules.map((item) => {
        const day = WEEKDAYS.find(([value]) => value === item.weekday)?.[1] || "Dia";
        return `<span class="employee-schedule-chip">${escapeHTML(day)} · ${escapeHTML(item.start)}–${escapeHTML(item.end)}${item.note ? ` · ${escapeHTML(item.note)}` : ""} <button type="button" class="small danger" data-delete-schedule="${escapeAttr(employee.id)}:${escapeAttr(item.id)}">×</button></span>`;
      }).join("")}</div></div>`;
    }).join("") : `<div class="empty"><strong>Nenhum horário cadastrado</strong><span>Adicione a grade semanal dos funcionários.</span></div>`;
  }

  function renderSalary() {
    const tbody = document.querySelector("#employeeSalaryTable");
    const label = document.querySelector("#employeeSalaryPeriod");
    if (!tbody) return;
    if (label) label.textContent = periodLabel();
    const employees = employeesSorted({ activeOnly: true });
    tbody.innerHTML = employees.length ? employees.map((employee) => {
      const payment = salaryPayment(employee);
      if (payment) {
        return `<tr><td><strong>${escapeHTML(employee.name)}</strong><small>${escapeHTML(employee.role || "-")}</small></td><td>${brl(payment.amount)}</td><td>Dia ${employee.dueDay}</td><td><span class="employee-status-pill">Pago</span></td><td>${formatDateBR(payment.paidDate)}<small>${escapeHTML(bankAccountLabel(payment.accountId) || "Conta removida")}</small></td><td><button type="button" class="small danger" data-reverse-salary="${escapeAttr(employee.id)}">Estornar pagamento</button></td></tr>`;
      }
      return `<tr><td><strong>${escapeHTML(employee.name)}</strong><small>${escapeHTML(employee.role || "-")}</small></td><td>${brl(employee.salary)}</td><td>Dia ${employee.dueDay}</td><td><span class="employee-status-pill pending">Pendente</span></td><td>-</td><td><div class="employee-inline-controls"><input type="number" min="0" step="0.01" value="${Number(employee.salary || 0)}" data-salary-amount="${escapeAttr(employee.id)}"/><input type="date" value="${todayISO()}" data-salary-date="${escapeAttr(employee.id)}"/><select data-salary-account="${escapeAttr(employee.id)}">${accountOptions()}</select><button type="button" data-pay-salary="${escapeAttr(employee.id)}">Pagar</button></div></td></tr>`;
    }).join("") : `<tr><td colspan="6"><div class="empty"><strong>Nenhum funcionário ativo</strong><span>Ative ou cadastre funcionários para gerar a folha.</span></div></td></tr>`;
  }

  function taxReceiptFor(taxId) {
    return documentCache.find((doc) => doc.kind === "tax_receipt" && doc.relatedId === taxId) || null;
  }

  function renderTaxes() {
    const tbody = document.querySelector("#employeeTaxTable");
    const label = document.querySelector("#employeeTaxPeriodLabel");
    if (!tbody) return;
    if (label) label.textContent = periodLabel();
    const rows = employeesSorted().flatMap((employee) => taxesForPeriod(employee).map((tax) => ({ employee, tax })));
    rows.sort((a,b) => (a.tax.dueDate || "").localeCompare(b.tax.dueDate || "") || a.employee.name.localeCompare(b.employee.name, "pt-BR"));
    tbody.innerHTML = rows.length ? rows.map(({ employee, tax }) => {
      const receipt = taxReceiptFor(tax.id);
      const overdue = tax.status !== "paid" && tax.dueDate && tax.dueDate < todayISO();
      return `<tr><td><strong>${escapeHTML(employee.name)}</strong></td><td>${escapeHTML(tax.type)}<small>${escapeHTML(tax.description || "-")}</small></td><td>${tax.dueDate ? formatDateBR(tax.dueDate) : "-"}${overdue ? `<small style="color:#b91c1c;font-weight:800">Vencido</small>` : ""}</td><td><strong>${brl(tax.amount)}</strong></td><td><span class="employee-status-pill ${tax.status === "paid" ? "" : "pending"}">${tax.status === "paid" ? "Pago" : "Pendente"}</span></td><td>${tax.status === "paid" ? `${formatDateBR(tax.paidDate)}<small>${escapeHTML(bankAccountLabel(tax.accountId) || "-")}</small>` : `<div class="employee-inline-controls"><input type="date" value="${todayISO()}" data-tax-pay-date="${escapeAttr(tax.id)}"/><select data-tax-account="${escapeAttr(tax.id)}">${accountOptions()}</select><span></span><button type="button" data-pay-tax="${escapeAttr(employee.id)}:${escapeAttr(tax.id)}">Pagar</button></div>`}</td><td>${receipt ? `<button type="button" class="small secondary" data-open-employee-document="${escapeAttr(receipt.id)}">Abrir comprovante</button>` : `<label class="small secondary" style="display:inline-block;cursor:pointer">Anexar<input type="file" hidden accept="application/pdf,image/jpeg,image/png,image/webp" data-tax-receipt-upload="${escapeAttr(employee.id)}:${escapeAttr(tax.id)}"/></label>`}</td><td><div class="row-actions">${tax.status === "paid" ? `<button type="button" class="small danger" data-reverse-tax="${escapeAttr(employee.id)}:${escapeAttr(tax.id)}">Estornar</button>` : `<button type="button" class="small danger" data-delete-tax="${escapeAttr(employee.id)}:${escapeAttr(tax.id)}">Excluir</button>`}</div></td></tr>`;
    }).join("") : `<tr><td colspan="8"><div class="empty"><strong>Nenhum imposto nesta competência</strong><span>Cadastre os impostos acima.</span></div></td></tr>`;
  }

  function formatFileSize(bytes = 0) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderDocuments() {
    const box = document.querySelector("#employeeDocumentList");
    const info = document.querySelector("#employeeDocumentInfo");
    if (!box) return;
    const filter = document.querySelector("#documentFilterEmployee")?.value || "";
    const docs = documentCache.filter((doc) => !filter || String(doc.employeeId) === String(filter));
    if (info) info.textContent = `${docs.length} arquivo(s) protegido(s)`;
    box.innerHTML = docs.length ? docs.map((doc) => {
      const employee = employeeById(doc.employeeId);
      return `<div class="employee-file-chip"><div><strong>${escapeHTML(doc.filename)}</strong><small>${escapeHTML(employee?.name || "Funcionário removido")} · ${escapeHTML(DOC_KIND_LABELS[doc.kind] || "Documento")} · ${doc.period ? escapeHTML(periodLabel(doc.period)) : "sem competência"} · ${formatFileSize(doc.sizeBytes)}</small></div><div class="row-actions"><button type="button" class="small secondary" data-open-employee-document="${escapeAttr(doc.id)}">Abrir</button><button type="button" class="small danger" data-delete-employee-document="${escapeAttr(doc.id)}">Excluir</button></div></div>`;
    }).join("") : `<div class="empty"><strong>Nenhum documento encontrado</strong><span>Envie notas fiscais ou comprovantes pelo formulário acima.</span></div>`;
  }

  function renderEmployeeManagement() {
    if (!document.querySelector("#employeesView")) mountView();
    renderMetrics();
    renderEmployeeSelects();
    renderRegistry();
    renderSchedules();
    renderSalary();
    renderTaxes();
    renderDocuments();
  }

  function switchEmployeePane(pane = "registry") {
    currentPane = pane;
    document.querySelectorAll(".employee-subtab").forEach((button) => button.classList.toggle("is-active", button.dataset.employeePane === pane));
    document.querySelectorAll(".employee-pane").forEach((element) => element.classList.toggle("is-active", element.dataset.employeePaneContent === pane));
    if (pane === "documents" || pane === "taxes") loadDocumentMetadata().catch(() => {});
  }

  function fillEmployeeForm(employee) {
    if (!employee) return;
    document.querySelector("#employeeId").value = employee.id;
    document.querySelector("#employeeName").value = employee.name;
    document.querySelector("#employeeRole").value = employee.role;
    document.querySelector("#employeeContractType").value = employee.contractType;
    document.querySelector("#employeeDocument").value = employee.document;
    document.querySelector("#employeePhone").value = employee.phone;
    document.querySelector("#employeeEmail").value = employee.email;
    document.querySelector("#employeeStartDate").value = employee.startDate;
    document.querySelector("#employeeSalary").value = Number(employee.salary || 0);
    document.querySelector("#employeeDueDay").value = Number(employee.dueDay || 5);
    document.querySelector("#employeeStatus").value = employee.status;
    document.querySelector("#employeeNotes").value = employee.notes;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function clearEmployeeForm() {
    document.querySelector("#employeeForm")?.reset();
    const id = document.querySelector("#employeeId");
    if (id) id.value = "";
    const due = document.querySelector("#employeeDueDay");
    if (due) due.value = 5;
  }

  function paymentExpenseId(prefix, employeeId, period, itemId = "") {
    return `${prefix}-${employeeId}-${period}${itemId ? `-${itemId}` : ""}`;
  }

  function createPaidExpense({ id, description, category, amount, date, accountId }) {
    state.expenses ||= [];
    const existing = state.expenses.find((expense) => expense.id === id);
    const payload = {
      id,
      description,
      category,
      amount: Number(amount || 0),
      date: date || todayISO(),
      dueDate: date || todayISO(),
      status: "paid",
      paidDate: date || todayISO(),
      paidFromAccountId: accountId || "",
    };
    if (existing) Object.assign(existing, payload);
    else state.expenses.push(payload);
  }

  function deductAccount(accountId, amount) {
    const account = getBankAccount(accountId);
    if (!account) throw new Error("Conta bancária não encontrada.");
    account.balance = Number(account.balance || 0) - Number(amount || 0);
    return account;
  }

  function creditAccount(accountId, amount) {
    const account = getBankAccount(accountId);
    if (account) account.balance = Number(account.balance || 0) + Number(amount || 0);
  }

  async function handleSubmit(event) {
    if (!event.target.closest("#employeesView")) return;
    event.preventDefault();

    if (event.target.id === "employeeForm") {
      const id = document.querySelector("#employeeId").value || uid();
      const existing = employeeById(id);
      const payload = normalizeEmployee({
        ...(existing || {}),
        id,
        name: document.querySelector("#employeeName").value.trim(),
        role: document.querySelector("#employeeRole").value.trim(),
        contractType: document.querySelector("#employeeContractType").value,
        document: document.querySelector("#employeeDocument").value.trim(),
        phone: document.querySelector("#employeePhone").value.trim(),
        email: document.querySelector("#employeeEmail").value.trim(),
        startDate: document.querySelector("#employeeStartDate").value,
        salary: Number(document.querySelector("#employeeSalary").value || 0),
        dueDay: Number(document.querySelector("#employeeDueDay").value || 5),
        status: document.querySelector("#employeeStatus").value,
        notes: document.querySelector("#employeeNotes").value.trim(),
        createdAt: existing?.createdAt || todayISO(),
      });
      if (!payload.name) return showToast("Informe o nome do funcionário.");
      if (existing) Object.assign(existing, payload); else state.employees.push(payload);
      clearEmployeeForm();
      saveState();
      renderAll();
      showToast("Funcionário salvo.");
      return;
    }

    if (event.target.id === "employeeScheduleForm") {
      const employee = employeeById(document.querySelector("#scheduleEmployeeId").value);
      if (!employee) return showToast("Selecione um funcionário.");
      const start = document.querySelector("#scheduleStart").value;
      const end = document.querySelector("#scheduleEnd").value;
      if (!start || !end || end <= start) return showToast("Informe um horário de entrada e saída válido.");
      employee.schedules.push(normalizeSchedule({
        weekday: Number(document.querySelector("#scheduleWeekday").value),
        start,
        end,
        note: document.querySelector("#scheduleNote").value.trim(),
      }));
      document.querySelector("#scheduleStart").value = "";
      document.querySelector("#scheduleEnd").value = "";
      document.querySelector("#scheduleNote").value = "";
      saveState(); renderAll(); showToast("Horário adicionado.");
      return;
    }

    if (event.target.id === "employeeTaxForm") {
      const employee = employeeById(document.querySelector("#taxEmployeeId").value);
      if (!employee) return showToast("Selecione um funcionário.");
      const tax = normalizeTax({
        id: uid(),
        period: document.querySelector("#taxPeriod").value || selectedPeriodKey(),
        type: document.querySelector("#taxType").value,
        amount: Number(document.querySelector("#taxAmount").value || 0),
        dueDate: document.querySelector("#taxDueDate").value,
        description: document.querySelector("#taxDescription").value.trim(),
        status: "open",
      });
      if (!(tax.amount > 0)) return showToast("Informe o valor do imposto.");
      employee.taxes.push(tax);
      document.querySelector("#taxAmount").value = "";
      document.querySelector("#taxDescription").value = "";
      saveState(); renderAll(); showToast("Imposto cadastrado.");
      return;
    }

    if (event.target.id === "employeeDocumentForm") {
      const employeeId = document.querySelector("#documentEmployeeId").value;
      const file = document.querySelector("#employeeDocumentFile").files?.[0];
      if (!employeeById(employeeId)) return showToast("Selecione um funcionário.");
      if (!file) return showToast("Selecione um arquivo.");
      await uploadDocument({
        employeeId,
        kind: document.querySelector("#documentKind").value,
        period: document.querySelector("#documentPeriod").value || selectedPeriodKey(),
        file,
      });
      event.target.reset();
      document.querySelector("#documentPeriod").value = selectedPeriodKey();
      return;
    }
  }

  async function handleClick(event) {
    const paneButton = event.target.closest("[data-employee-pane]");
    if (paneButton) return switchEmployeePane(paneButton.dataset.employeePane);
    if (event.target.id === "clearEmployeeForm") return clearEmployeeForm();

    const editId = event.target.closest("[data-edit-employee]")?.dataset.editEmployee;
    if (editId) return fillEmployeeForm(employeeById(editId));

    const toggleId = event.target.closest("[data-toggle-employee]")?.dataset.toggleEmployee;
    if (toggleId) {
      const employee = employeeById(toggleId);
      if (!employee) return;
      employee.status = employee.status === "active" ? "inactive" : "active";
      saveState(); renderAll(); showToast(employee.status === "active" ? "Funcionário reativado." : "Funcionário inativado.");
      return;
    }

    const scheduleKey = event.target.closest("[data-delete-schedule]")?.dataset.deleteSchedule;
    if (scheduleKey) {
      const separator = scheduleKey.lastIndexOf(":");
      const employee = employeeById(scheduleKey.slice(0, separator));
      const scheduleId = scheduleKey.slice(separator + 1);
      if (!employee) return;
      employee.schedules = employee.schedules.filter((item) => String(item.id) !== scheduleId);
      saveState(); renderAll(); showToast("Horário removido.");
      return;
    }

    const paySalaryId = event.target.closest("[data-pay-salary]")?.dataset.paySalary;
    if (paySalaryId) {
      const employee = employeeById(paySalaryId);
      if (!employee || salaryPayment(employee)) return;
      const amount = Number(document.querySelector(`[data-salary-amount="${CSS.escape(paySalaryId)}"]`)?.value || employee.salary || 0);
      const date = document.querySelector(`[data-salary-date="${CSS.escape(paySalaryId)}"]`)?.value || todayISO();
      const accountId = document.querySelector(`[data-salary-account="${CSS.escape(paySalaryId)}"]`)?.value || "";
      if (!(amount > 0)) return showToast("Informe o valor do salário.");
      if (!accountId) return showToast("Escolha a conta de saída.");
      deductAccount(accountId, amount);
      const expenseId = paymentExpenseId("employee-salary", employee.id, selectedPeriodKey());
      employee.salaryPayments.push(normalizeSalaryPayment({ period: selectedPeriodKey(), amount, paidDate: date, accountId, expenseId }));
      createPaidExpense({ id: expenseId, description: `Salário - ${employee.name} - ${periodLabel()}`, category: "Salários", amount, date, accountId });
      saveState(); renderAll(); showToast("Salário pago e debitado da conta.");
      return;
    }

    const reverseSalaryId = event.target.closest("[data-reverse-salary]")?.dataset.reverseSalary;
    if (reverseSalaryId) {
      const employee = employeeById(reverseSalaryId);
      const payment = employee && salaryPayment(employee);
      if (!employee || !payment || !confirm(`Estornar o pagamento de ${brl(payment.amount)} de ${employee.name}?`)) return;
      creditAccount(payment.accountId, payment.amount);
      state.expenses = (state.expenses || []).filter((expense) => expense.id !== payment.expenseId);
      employee.salaryPayments = employee.salaryPayments.filter((item) => item.id !== payment.id);
      saveState(); renderAll(); showToast("Pagamento de salário estornado.");
      return;
    }

    const payTaxKey = event.target.closest("[data-pay-tax]")?.dataset.payTax;
    if (payTaxKey) {
      const separator = payTaxKey.lastIndexOf(":");
      const employee = employeeById(payTaxKey.slice(0, separator));
      const tax = employee?.taxes.find((item) => String(item.id) === payTaxKey.slice(separator + 1));
      if (!employee || !tax || tax.status === "paid") return;
      const date = document.querySelector(`[data-tax-pay-date="${CSS.escape(tax.id)}"]`)?.value || todayISO();
      const accountId = document.querySelector(`[data-tax-account="${CSS.escape(tax.id)}"]`)?.value || "";
      if (!accountId) return showToast("Escolha a conta de saída.");
      deductAccount(accountId, tax.amount);
      tax.status = "paid"; tax.paidDate = date; tax.accountId = accountId;
      tax.expenseId = paymentExpenseId("employee-tax", employee.id, tax.period, tax.id);
      createPaidExpense({ id: tax.expenseId, description: `${tax.type} - ${employee.name} - ${periodLabel(tax.period)}`, category: "Impostos de funcionários", amount: tax.amount, date, accountId });
      saveState(); renderAll(); showToast("Imposto pago e debitado da conta.");
      return;
    }

    const reverseTaxKey = event.target.closest("[data-reverse-tax]")?.dataset.reverseTax;
    if (reverseTaxKey) {
      const separator = reverseTaxKey.lastIndexOf(":");
      const employee = employeeById(reverseTaxKey.slice(0, separator));
      const tax = employee?.taxes.find((item) => String(item.id) === reverseTaxKey.slice(separator + 1));
      if (!employee || !tax || tax.status !== "paid" || !confirm(`Estornar o pagamento de ${tax.type} de ${employee.name}?`)) return;
      creditAccount(tax.accountId, tax.amount);
      state.expenses = (state.expenses || []).filter((expense) => expense.id !== tax.expenseId);
      tax.status = "open"; tax.paidDate = ""; tax.accountId = ""; tax.expenseId = "";
      saveState(); renderAll(); showToast("Pagamento do imposto estornado.");
      return;
    }

    const deleteTaxKey = event.target.closest("[data-delete-tax]")?.dataset.deleteTax;
    if (deleteTaxKey) {
      const separator = deleteTaxKey.lastIndexOf(":");
      const employee = employeeById(deleteTaxKey.slice(0, separator));
      const taxId = deleteTaxKey.slice(separator + 1);
      if (!employee || !confirm("Excluir este imposto pendente?")) return;
      employee.taxes = employee.taxes.filter((tax) => String(tax.id) !== taxId);
      saveState(); renderAll(); showToast("Imposto excluído.");
      return;
    }

    const openDocumentId = event.target.closest("[data-open-employee-document]")?.dataset.openEmployeeDocument;
    if (openDocumentId) return openDocument(openDocumentId);

    const deleteDocumentId = event.target.closest("[data-delete-employee-document]")?.dataset.deleteEmployeeDocument;
    if (deleteDocumentId) return deleteDocument(deleteDocumentId);
  }

  async function handleChange(event) {
    if (event.target.id === "documentFilterEmployee") return renderDocuments();
    const key = event.target.dataset.taxReceiptUpload;
    if (!key || !event.target.files?.[0]) return;
    const separator = key.lastIndexOf(":");
    const employeeId = key.slice(0, separator);
    const taxId = key.slice(separator + 1);
    const employee = employeeById(employeeId);
    const tax = employee?.taxes.find((item) => String(item.id) === taxId);
    if (!employee || !tax) return;
    await uploadDocument({ employeeId, kind: "tax_receipt", period: tax.period, relatedId: tax.id, file: event.target.files[0] });
    event.target.value = "";
  }

  async function employeeRequest(url, options = {}) {
    const key = employeeSyncKey();
    if (key.length < 6) throw new Error("Informe a chave de sincronização nas Configurações.");
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        "x-sync-key": key,
        ...(options.headers || {}),
      },
    });
    return response;
  }

  async function pushEmployees({ force = false } = {}) {
    if (employeeSyncBusy || suppressEmployeePush) return false;
    const employees = clone(ensureEmployeeState());
    const fingerprint = JSON.stringify(employees);
    const previous = localStorage.getItem(SNAPSHOT_KEY) || "";
    if (!force && fingerprint === previous) return true;
    employeeSyncBusy = true;
    try {
      const response = await employeeRequest(EMPLOYEE_ENDPOINT, { method: "POST", body: JSON.stringify({ employees }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "Falha ao sincronizar funcionários.");
      localStorage.setItem(SNAPSHOT_KEY, fingerprint);
      return true;
    } catch (error) {
      console.error("Employee sync push", error);
      return false;
    } finally { employeeSyncBusy = false; }
  }

  async function pullEmployees() {
    if (employeeSyncBusy) return false;
    employeeSyncBusy = true;
    try {
      const response = await employeeRequest(EMPLOYEE_ENDPOINT, { method: "GET" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "Falha ao carregar funcionários.");
      const remote = Array.isArray(data.employees) ? data.employees.map(normalizeEmployee) : [];
      const local = ensureEmployeeState();
      if (!remote.length && local.length) {
        employeeSyncBusy = false;
        return pushEmployees({ force: true });
      }
      if (remote.length) {
        suppressEmployeePush = true;
        state.employees = remote;
        try { originalEmployeeFlush({ skipRemote: true, skipMarkLocal: true }); } catch { localStorage.setItem("arteDeAprenderERP.v4", JSON.stringify(state)); }
        suppressEmployeePush = false;
        localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(remote));
        renderEmployeeManagement();
      }
      return true;
    } catch (error) {
      console.error("Employee sync pull", error);
      return false;
    } finally { employeeSyncBusy = false; }
  }

  function scheduleEmployeePush() {
    if (suppressEmployeePush) return;
    clearTimeout(employeePushTimer);
    employeePushTimer = setTimeout(() => pushEmployees(), PUSH_DELAY_MS);
  }

  async function loadDocumentMetadata() {
    try {
      const response = await employeeRequest(DOCUMENT_ENDPOINT, { method: "GET" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "Falha ao carregar documentos.");
      documentCache = Array.isArray(data.documents) ? data.documents : [];
      renderTaxes(); renderDocuments();
    } catch (error) {
      const info = document.querySelector("#employeeDocumentInfo");
      if (info) info.textContent = error.message || "Não foi possível carregar os arquivos";
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.onerror = () => reject(reader.error || new Error("Falha ao ler arquivo."));
      reader.readAsDataURL(file);
    });
  }

  async function uploadDocument({ employeeId, kind, period, relatedId = "", file }) {
    if (!file) return;
    if (file.size > 3_000_000) return showToast("O arquivo deve ter no máximo 3 MB.");
    try {
      showToast("Enviando documento...");
      const dataBase64 = await fileToBase64(file);
      const response = await employeeRequest(DOCUMENT_ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ employeeId, kind, period, relatedId, filename: file.name, mimeType: file.type, dataBase64 }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "Falha ao enviar documento.");
      await loadDocumentMetadata();
      showToast("Documento enviado e protegido.");
    } catch (error) {
      console.error(error);
      showToast(error.message || "Não consegui enviar o documento.");
    }
  }

  async function openDocument(id) {
    try {
      const response = await employeeRequest(`${DOCUMENT_ENDPOINT}?id=${encodeURIComponent(id)}`, { method: "GET" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Documento não encontrado.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { showToast(error.message || "Não consegui abrir o documento."); }
  }

  async function deleteDocument(id) {
    if (!confirm("Excluir definitivamente este documento?")) return;
    try {
      const response = await employeeRequest(`${DOCUMENT_ENDPOINT}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "Falha ao excluir documento.");
      await loadDocumentMetadata();
      showToast("Documento excluído.");
    } catch (error) { showToast(error.message || "Não consegui excluir o documento."); }
  }

  mountView();

  const originalEmployeeRenderAll = renderAll;
  renderAll = function renderAllWithEmployees() {
    originalEmployeeRenderAll();
    renderEmployeeManagement();
  };
  try { window.renderAll = renderAll; } catch {}

  const originalEmployeeSave = saveState;
  const originalEmployeeFlush = flushSaveState;
  saveState = function saveStateWithEmployees(options = {}) {
    originalEmployeeSave(options);
    scheduleEmployeePush();
  };
  flushSaveState = function flushSaveStateWithEmployees(options = {}) {
    originalEmployeeFlush(options);
    scheduleEmployeePush();
  };
  try { window.saveState = saveState; window.flushSaveState = flushSaveState; } catch {}

  renderEmployeeManagement();
  window.setTimeout(() => {
    pullEmployees().then(() => loadDocumentMetadata()).catch(() => {});
  }, 600);
})();
