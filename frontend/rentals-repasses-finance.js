// Gestão de locações, repasses da psicopedagogia e patrimônio compartilhado da clínica.
(() => {
  const VERSION = 1;
  const PSYCH_NAME = "Psicopedagogia";
  const REPASS_CATEGORY = "Repasse Psicopedagogia";
  const CLINIC_INCOME_CATEGORY = "Sublocação - Clínica";

  function sameId(a, b) {
    return String(a ?? "").trim() === String(b ?? "").trim();
  }

  function money(value) {
    return Number(Number(value || 0).toFixed(2));
  }

  function ensureExpenseCategory(name) {
    state.expenseCategories ||= [];
    if (state.expenseCategories.some((item) => normalizeText(item.name) === normalizeText(name))) return;
    state.expenseCategories.push(normalizeExpenseCategory({ name }));
  }

  function ensurePsychActivity() {
    state.activityCatalog ||= [];
    let activity = state.activityCatalog.find((item) => normalizeText(item.name).includes("psicopedagog"));
    if (!activity) {
      activity = normalizeActivityCatalogItem({ name: PSYCH_NAME, defaultValue: 0 });
      state.activityCatalog.push(activity);
    }
    return activity;
  }

  function ensureRentalState() {
    const psychActivity = ensurePsychActivity();
    const existing = state.rentalManagement && typeof state.rentalManagement === "object" ? state.rentalManagement : {};
    const psych = existing.psychopedagogy && typeof existing.psychopedagogy === "object" ? existing.psychopedagogy : {};
    const clinic = existing.clinic && typeof existing.clinic === "object" ? existing.clinic : {};

    state.rentalManagement = {
      ...existing,
      version: VERSION,
      psychopedagogy: {
        professionalName: psych.professionalName || "Psicopedagoga",
        activityId: psych.activityId || psychActivity.id,
        repassPercent: Number.isFinite(Number(psych.repassPercent)) ? Number(psych.repassPercent) : 60,
        defaultBankAccountId: psych.defaultBankAccountId || "",
      },
      clinic: {
        tenantName: clinic.tenantName || "Clínica",
        roomName: clinic.roomName || "Sala da clínica",
        monthlyRent: Number(clinic.monthlyRent || 0),
        dueDay: Number(clinic.dueDay || 10),
        startDate: clinic.startDate || "",
        defaultBankAccountId: clinic.defaultBankAccountId || "",
        notes: clinic.notes || "",
      },
      repasses: Array.isArray(existing.repasses) ? existing.repasses : [],
      clinicReceipts: Array.isArray(existing.clinicReceipts) ? existing.clinicReceipts : [],
      equipment: Array.isArray(existing.equipment) ? existing.equipment : [],
    };

    ensureExpenseCategory(REPASS_CATEGORY);
  }

  ensureRentalState();

  function rentalData() {
    return state.rentalManagement;
  }

  function selectedPsychActivity() {
    const config = rentalData().psychopedagogy;
    return state.activityCatalog.find((item) => sameId(item.id, config.activityId))
      || state.activityCatalog.find((item) => normalizeText(item.name).includes("psicopedagog"))
      || null;
  }

  function psychItemForStudent(student = {}) {
    const activity = selectedPsychActivity();
    if (!activity) return null;
    return studentActivityItems(student).find((item) => sameId(item.activityId, activity.id)
      || normalizeText(item.name) === normalizeText(activity.name)) || null;
  }

  function psychStudents() {
    return state.students
      .filter((student) => student.status !== "archived" && psychItemForStudent(student))
      .slice()
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR", { sensitivity: "base" }));
  }

  function paymentForStudentPeriod(studentId, period = selectedPeriodKey()) {
    return state.payments.find((payment) => sameId(payment.studentId, studentId) && payment.period === period) || null;
  }

  function expectedPsychValue(student, payment = null) {
    const item = psychItemForStudent(student);
    if (!item) return 0;
    const itemValue = Number(item.value || 0);
    if (itemValue > 0) return itemValue;
    const items = studentActivityItems(student);
    if (items.length === 1) return Number(payment?.amount || studentMonthlyAmount(student) || 0);
    return 0;
  }

  function attributablePsychReceived(student, payment) {
    if (!payment) return 0;
    const expected = expectedPsychValue(student, payment);
    if (expected <= 0) return 0;
    const received = paymentReceivedAmount(payment);
    if (received <= 0) return 0;
    const denominator = Number(payment.amount || studentMonthlyAmount(student) || 0);
    if (denominator <= 0) return 0;
    const ratio = Math.min(Math.max(expected / denominator, 0), 1);
    return money(Math.min(received * ratio, expected));
  }

  function psychMetrics(period = selectedPeriodKey()) {
    const repassPercent = Math.min(Math.max(Number(rentalData().psychopedagogy.repassPercent || 60), 0), 100);
    const rows = psychStudents().map((student) => {
      const payment = paymentForStudentPeriod(student.id, period);
      const expected = expectedPsychValue(student, payment);
      const received = attributablePsychReceived(student, payment);
      const repassDue = money(received * repassPercent / 100);
      const saberShare = money(received - repassDue);
      const attendance = attendanceEntriesForStudent(student.id, period);
      return {
        student,
        payment,
        expected,
        received,
        repassDue,
        saberShare,
        presentDays: attendance.filter((entry) => entry.status === "present").length,
      };
    });

    const expected = money(rows.reduce((sum, row) => sum + row.expected, 0));
    const received = money(rows.reduce((sum, row) => sum + row.received, 0));
    const repassDue = money(rows.reduce((sum, row) => sum + row.repassDue, 0));
    const saberShare = money(rows.reduce((sum, row) => sum + row.saberShare, 0));
    const repassed = money(rentalData().repasses
      .filter((item) => item.period === period)
      .reduce((sum, item) => sum + Number(item.amount || 0), 0));

    return {
      rows,
      expected,
      received,
      repassDue,
      saberShare,
      repassed,
      pendingRepass: money(Math.max(repassDue - repassed, 0)),
      repassPercent,
      saberPercent: money(100 - repassPercent),
    };
  }

  function syncCurrentPaymentAfterStudentPlanChange(student, startDate = "") {
    const period = selectedPeriodKey();
    if (startDate && startDate.slice(0, 7) > period) return;
    let payment = paymentForStudentPeriod(student.id, period);
    const amount = studentMonthlyAmount(student);

    if (payment && paymentReceivedAmount(payment) <= 0.009) {
      if (amount <= 0) {
        state.payments = state.payments.filter((item) => item.id !== payment.id);
        return;
      }
      payment.amount = amount;
      payment.hours = Number(student.contractedHours || 0);
      payment.dueDay = Number(student.dueDay || 10);
      syncPaymentFee(payment);
      return;
    }

    if (!payment && amount > 0) {
      payment = normalizePayment({
        studentId: student.id,
        period,
        amount,
        hours: Number(student.contractedHours || 0),
        dueDay: Number(student.dueDay || 10),
        status: "open",
      }, period, Number(period.slice(0, 4)));
      state.payments.push(payment);
    }
  }

  function addPsychActivityToStudent(studentId, value, startDate) {
    const student = state.students.find((item) => sameId(item.id, studentId));
    const activity = selectedPsychActivity();
    if (!student || !activity) return false;

    const items = studentActivityItems(student);
    const existing = items.find((item) => sameId(item.activityId, activity.id)
      || normalizeText(item.name) === normalizeText(activity.name));

    if (existing) {
      existing.activityId = activity.id;
      existing.name = activity.name;
      existing.value = Number(value || existing.value || 0);
      existing.startDate = startDate || existing.startDate || "";
    } else {
      items.push({
        id: uid(),
        activityId: activity.id,
        name: activity.name,
        value: Number(value || activity.defaultValue || 0),
        startDate: startDate || todayISO(),
      });
    }

    student.activityItems = items;
    student.activities = items.map((item) => item.name).join("; ");
    student.monthlyValue = studentActivityTotal(items);
    syncCurrentPaymentAfterStudentPlanChange(student, startDate);
    return true;
  }

  function removePsychActivityFromStudent(studentId) {
    const student = state.students.find((item) => sameId(item.id, studentId));
    const activity = selectedPsychActivity();
    if (!student || !activity) return false;
    const items = studentActivityItems(student).filter((item) => !sameId(item.activityId, activity.id)
      && normalizeText(item.name) !== normalizeText(activity.name));
    student.activityItems = items;
    student.activities = items.map((item) => item.name).join("; ");
    student.monthlyValue = studentActivityTotal(items);
    syncCurrentPaymentAfterStudentPlanChange(student);
    return true;
  }

  function addPaidExpenseForRepass(record) {
    const expense = normalizeExpense({
      id: `rental-repass-${record.id}`,
      description: `Repasse Psicopedagogia - ${rentalData().psychopedagogy.professionalName} - ${periodLabel(record.period)}`,
      category: REPASS_CATEGORY,
      amount: record.amount,
      date: record.date,
      dueDate: record.date,
      status: "paid",
      paidDate: record.date,
      paidFromAccountId: record.bankAccountId || "",
    });
    if (record.bankAccountId) {
      const account = getBankAccount(record.bankAccountId);
      if (account) account.balance = money(Number(account.balance || 0) - Number(record.amount || 0));
    }
    state.expenses.push(expense);
    record.expenseId = expense.id;
  }

  function removePaidExpenseForRepass(record) {
    const expense = state.expenses.find((item) => sameId(item.id, record.expenseId));
    if (expense?.status === "paid" && expense.paidFromAccountId) {
      const account = getBankAccount(expense.paidFromAccountId);
      if (account) account.balance = money(Number(account.balance || 0) + Number(expense.amount || 0));
    }
    if (record.expenseId) state.expenses = state.expenses.filter((item) => !sameId(item.id, record.expenseId));
  }

  function addClinicIncome(record) {
    const income = normalizeOtherIncome({
      id: `clinic-rent-${record.id}`,
      description: `Locação ${rentalData().clinic.roomName} - ${rentalData().clinic.tenantName} - ${periodLabel(record.period)}`,
      category: CLINIC_INCOME_CATEGORY,
      amount: record.amount,
      date: record.date,
      bankAccountId: record.bankAccountId || "",
    });

    if (record.bankAccountId) {
      const account = getBankAccount(record.bankAccountId);
      if (account) {
        account.balance = money(Number(account.balance || 0) + Number(record.amount || 0));
        income.creditedAccountId = account.id;
        income.creditedAmount = Number(record.amount || 0);
      }
    }

    state.otherIncomes.push(income);
    record.incomeId = income.id;
  }

  function removeClinicIncome(record) {
    const income = state.otherIncomes.find((item) => sameId(item.id, record.incomeId));
    if (income?.creditedAccountId && Number(income.creditedAmount || 0)) {
      const account = getBankAccount(income.creditedAccountId);
      if (account) account.balance = money(Number(account.balance || 0) - Number(income.creditedAmount || 0));
    }
    if (record.incomeId) state.otherIncomes = state.otherIncomes.filter((item) => !sameId(item.id, record.incomeId));
  }

  function nextPeriod(period) {
    const [year, month] = String(period).split("-").map(Number);
    const date = new Date(year, month, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function clinicExpectedForPeriod(period) {
    const config = rentalData().clinic;
    if (!Number(config.monthlyRent || 0)) return 0;
    if (config.startDate && period < config.startDate.slice(0, 7)) return 0;
    return Number(config.monthlyRent || 0);
  }

  function clinicReceivedForPeriod(period) {
    return money(rentalData().clinicReceipts
      .filter((item) => item.period === period)
      .reduce((sum, item) => sum + Number(item.amount || 0), 0));
  }

  function clinicPeriodSummary(period = selectedPeriodKey()) {
    const expected = money(clinicExpectedForPeriod(period));
    const received = clinicReceivedForPeriod(period);
    return { expected, received, pending: money(Math.max(expected - received, 0)) };
  }

  function clinicOutstandingPeriods(endPeriod = selectedPeriodKey()) {
    const config = rentalData().clinic;
    if (!Number(config.monthlyRent || 0)) return [];
    let cursor = config.startDate ? config.startDate.slice(0, 7) : endPeriod;
    if (!/^\d{4}-\d{2}$/.test(cursor) || cursor > endPeriod) return [];
    const rows = [];
    let guard = 0;
    while (cursor <= endPeriod && guard < 120) {
      const summary = clinicPeriodSummary(cursor);
      if (summary.pending > 0.009) rows.push({ period: cursor, ...summary });
      cursor = nextPeriod(cursor);
      guard += 1;
    }
    return rows;
  }

  function equipmentTotals() {
    return rentalData().equipment.reduce((acc, item) => {
      const amount = Number(item.amount || 0);
      if (item.purchasedBy === "clinic") acc.clinic += amount;
      else acc.saber += amount;
      acc.total += amount;
      return acc;
    }, { saber: 0, clinic: 0, total: 0 });
  }

  function mountFinancePane() {
    const financeView = document.querySelector("#financeView");
    const tabs = financeView?.querySelector(".finance-subtabs");
    if (!financeView || !tabs) return;

    if (!tabs.querySelector('[data-finance-pane="rentals"]')) {
      tabs.insertAdjacentHTML("beforeend", `<button class="finance-subtab" type="button" data-finance-pane="rentals">Locações e repasses</button>`);
    }

    if (financeView.querySelector('[data-finance-pane-content="rentals"]')) return;

    financeView.insertAdjacentHTML("beforeend", `
      <div class="finance-pane rentals-finance-pane" id="financeRentalsPane" data-finance-pane-content="rentals">
        <section class="rental-hero glass-card">
          <div>
            <span class="rental-kicker">Gestão de parcerias e espaços</span>
            <h2>Locações e repasses</h2>
            <p>Controle o repasse da Psicopedagogia, a locação da clínica e os equipamentos comprados por cada parte.</p>
          </div>
          <div class="rental-period-chip" id="rentalPeriodChip"></div>
        </section>

        <div class="rental-section-grid">
          <section class="panel glass-card rental-card rental-psych-card">
            <div class="panel-head stackable">
              <div>
                <h2>Psicopedagogia</h2>
                <span>Recebimentos das crianças vinculadas e repasse automático por percentual</span>
              </div>
              <span class="rental-badge" id="psychSplitBadge">60% profissional · 40% Arte de Aprender</span>
            </div>

            <form id="psychRentalConfigForm" class="rental-form rental-config-form">
              <label>Profissional<input id="psychProfessionalName" placeholder="Nome da psicopedagoga" /></label>
              <label>Atividade vinculada<select id="psychActivitySelect"></select></label>
              <label>Repasse profissional (%)<input id="psychRepassPercent" type="number" min="0" max="100" step="0.01" /></label>
              <label>Conta padrão do repasse<select id="psychDefaultAccount"></select></label>
              <button type="submit">Salvar configuração</button>
            </form>

            <div class="rental-summary-grid" id="psychRentalSummary"></div>

            <div class="rental-subsection">
              <div class="panel-head stackable compact-head">
                <div><h3>Vincular criança</h3><span>Ao vincular, Psicopedagogia passa a aparecer na chamada e na mensalidade da criança.</span></div>
              </div>
              <form id="psychLinkStudentForm" class="rental-form rental-link-form">
                <label>Criança<select id="psychStudentSelect"></select></label>
                <label>Valor mensal da Psicopedagogia<input id="psychStudentValue" type="number" min="0" step="0.01" placeholder="0,00" /></label>
                <label>Data de início<input id="psychStudentStart" type="date" /></label>
                <button type="submit">Vincular / atualizar</button>
              </form>
            </div>

            <div class="table-wrap rental-table-wrap">
              <table>
                <thead><tr><th>Criança</th><th>Valor da atividade</th><th>Recebido</th><th>Repasse</th><th>Arte de Aprender</th><th>Presenças</th><th>Status</th><th>Ações</th></tr></thead>
                <tbody id="psychStudentsTable"></tbody>
              </table>
            </div>

            <div class="rental-subsection repass-box">
              <div class="panel-head stackable compact-head">
                <div><h3>Registrar repasse</h3><span>O valor pago entra automaticamente em Despesas como “Repasse Psicopedagogia”.</span></div>
              </div>
              <form id="psychRepassForm" class="rental-form rental-repass-form">
                <label>Competência<input id="psychRepassPeriod" type="month" /></label>
                <label>Valor do repasse<input id="psychRepassAmount" type="number" min="0.01" step="0.01" /></label>
                <label>Data do pagamento<input id="psychRepassDate" type="date" /></label>
                <label>Conta de saída<select id="psychRepassAccount"></select></label>
                <label class="rental-wide">Observação<input id="psychRepassNote" placeholder="Ex.: repasse mensal, complemento..." /></label>
                <button type="submit">Registrar repasse pago</button>
              </form>
              <div class="table-wrap compact-rental-history"><table><thead><tr><th>Data</th><th>Competência</th><th>Valor</th><th>Conta</th><th>Observação</th><th>Ações</th></tr></thead><tbody id="psychRepassHistory"></tbody></table></div>
            </div>
          </section>

          <section class="panel glass-card rental-card rental-clinic-card">
            <div class="panel-head stackable">
              <div><h2>Clínica · sublocação da sala</h2><span>Controle mensal do aluguel recebido e pendências anteriores.</span></div>
              <span class="rental-badge clinic-badge">Locação</span>
            </div>

            <form id="clinicRentalConfigForm" class="rental-form rental-config-form clinic-config-form">
              <label>Nome da clínica<input id="clinicTenantName" placeholder="Nome da clínica" /></label>
              <label>Sala / espaço<input id="clinicRoomName" placeholder="Ex.: Sala 2" /></label>
              <label>Valor mensal<input id="clinicMonthlyRent" type="number" min="0" step="0.01" /></label>
              <label>Dia do vencimento<input id="clinicDueDay" type="number" min="1" max="31" /></label>
              <label>Início da locação<input id="clinicStartDate" type="date" /></label>
              <label>Conta padrão de entrada<select id="clinicDefaultAccount"></select></label>
              <label class="rental-wide">Observações<input id="clinicNotes" placeholder="Contrato, condições, reajuste..." /></label>
              <button type="submit">Salvar locação</button>
            </form>

            <div class="rental-summary-grid" id="clinicRentalSummary"></div>

            <div class="rental-subsection clinic-pending-box">
              <div class="panel-head compact-head"><div><h3>Pendências da clínica</h3><span>Meses com saldo de locação ainda em aberto.</span></div></div>
              <div id="clinicOutstandingList" class="clinic-outstanding-list"></div>
            </div>

            <div class="rental-subsection">
              <div class="panel-head stackable compact-head"><div><h3>Registrar recebimento da locação</h3><span>O recebimento entra automaticamente em Outras entradas e na conta bancária selecionada.</span></div></div>
              <form id="clinicRentReceiptForm" class="rental-form rental-repass-form">
                <label>Competência<input id="clinicRentPeriod" type="month" /></label>
                <label>Valor recebido<input id="clinicRentAmount" type="number" min="0.01" step="0.01" /></label>
                <label>Data do recebimento<input id="clinicRentDate" type="date" /></label>
                <label>Conta de entrada<select id="clinicRentAccount"></select></label>
                <label class="rental-wide">Observação<input id="clinicRentNote" placeholder="Ex.: aluguel integral, parcela..." /></label>
                <button type="submit">Registrar aluguel recebido</button>
              </form>
              <div class="table-wrap compact-rental-history"><table><thead><tr><th>Data</th><th>Competência</th><th>Valor</th><th>Conta</th><th>Observação</th><th>Ações</th></tr></thead><tbody id="clinicRentHistory"></tbody></table></div>
            </div>

            <div class="rental-subsection equipment-box">
              <div class="panel-head stackable compact-head"><div><h3>Equipamentos da parceria</h3><span>Registre o que foi comprado pelo Arte de Aprender e o que foi comprado pela clínica.</span></div></div>
              <div class="equipment-summary" id="clinicEquipmentSummary"></div>
              <form id="clinicEquipmentForm" class="rental-form equipment-form">
                <label>Equipamento / item<input id="clinicEquipmentDescription" required placeholder="Ex.: maca, ar-condicionado, armário..." /></label>
                <label>Comprado por<select id="clinicEquipmentBuyer"><option value="saber">Arte de Aprender</option><option value="clinic">Clínica</option></select></label>
                <label>Valor total<input id="clinicEquipmentAmount" type="number" min="0" step="0.01" required /></label>
                <label>Data da compra<input id="clinicEquipmentDate" type="date" /></label>
                <label class="rental-wide">Observação<input id="clinicEquipmentNote" placeholder="Modelo, patrimônio, condição, quem ficará com o item..." /></label>
                <button type="submit">Adicionar equipamento</button>
              </form>
              <div class="table-wrap"><table><thead><tr><th>Data</th><th>Item</th><th>Comprado por</th><th>Valor</th><th>Observação</th><th>Ações</th></tr></thead><tbody id="clinicEquipmentTable"></tbody></table></div>
            </div>
          </section>
        </div>
      </div>
    `);

    ensureRentalStyles();
    bindRentalEvents();
  }

  function ensureRentalStyles() {
    if (document.querySelector("#rentalsFinanceStyles")) return;
    const style = document.createElement("style");
    style.id = "rentalsFinanceStyles";
    style.textContent = `
      .rentals-finance-pane { display: none; gap: 18px; }
      .rentals-finance-pane.is-active { display: grid; }
      .rental-hero { display:flex; justify-content:space-between; align-items:center; gap:18px; padding:22px; margin-bottom:18px; border:1px solid rgba(139,92,246,.15); }
      .rental-hero h2 { margin:3px 0 5px; }
      .rental-hero p { margin:0; color:var(--muted, #64748b); }
      .rental-kicker { font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; color:#7c3aed; }
      .rental-period-chip, .rental-badge { display:inline-flex; align-items:center; justify-content:center; padding:8px 12px; border-radius:999px; background:rgba(124,58,237,.11); color:#6d28d9; font-weight:800; font-size:12px; white-space:nowrap; }
      .clinic-badge { background:rgba(14,165,233,.12); color:#0369a1; }
      .rental-section-grid { display:grid; gap:18px; }
      .rental-card { overflow:hidden; }
      .rental-form { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; align-items:end; margin:14px 0 18px; }
      .rental-form label { display:grid; gap:6px; font-size:12px; font-weight:700; }
      .rental-form input, .rental-form select { width:100%; }
      .rental-form button { min-height:42px; }
      .rental-wide { grid-column:span 3; }
      .rental-summary-grid { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:10px; margin:8px 0 18px; }
      .rental-stat { padding:13px; border-radius:14px; border:1px solid rgba(148,163,184,.2); background:rgba(255,255,255,.5); }
      .rental-stat span { display:block; color:var(--muted,#64748b); font-size:11px; margin-bottom:4px; }
      .rental-stat strong { display:block; font-size:16px; }
      .rental-stat.good { border-color:rgba(22,163,74,.25); background:rgba(220,252,231,.55); }
      .rental-stat.warn { border-color:rgba(245,158,11,.3); background:rgba(254,243,199,.55); }
      .rental-stat.bad { border-color:rgba(220,38,38,.25); background:rgba(254,226,226,.55); }
      .rental-subsection { margin-top:18px; padding-top:18px; border-top:1px solid rgba(148,163,184,.18); }
      .compact-head h3 { margin:0; }
      .compact-head span { color:var(--muted,#64748b); font-size:12px; }
      .rental-table-wrap { margin-top:8px; }
      .rental-student-name small { display:block; color:var(--muted,#64748b); }
      .rental-payment-status { display:inline-flex; padding:4px 8px; border-radius:999px; font-size:11px; font-weight:800; }
      .rental-payment-status.ok { background:#dcfce7; color:#166534; }
      .rental-payment-status.warn { background:#fef3c7; color:#92400e; }
      .rental-payment-status.bad { background:#fee2e2; color:#991b1b; }
      .clinic-outstanding-list { display:grid; gap:8px; }
      .clinic-outstanding-item { display:flex; justify-content:space-between; gap:12px; align-items:center; padding:10px 12px; border-radius:12px; background:rgba(254,226,226,.65); border:1px solid rgba(220,38,38,.18); }
      .clinic-outstanding-item strong { color:#991b1b; }
      .clinic-outstanding-item small { display:block; color:#7f1d1d; }
      .equipment-summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:10px 0; }
      .equipment-owner { display:inline-flex; padding:4px 8px; border-radius:999px; font-weight:800; font-size:11px; }
      .equipment-owner.saber { background:rgba(124,58,237,.12); color:#6d28d9; }
      .equipment-owner.clinic { background:rgba(14,165,233,.12); color:#0369a1; }
      .compact-rental-history { margin-top:10px; }
      [data-theme="dark"] .rental-stat, body[data-theme="dark"] .rental-stat { background:rgba(15,23,42,.45); }
      [data-theme="dark"] .rental-stat.good, body[data-theme="dark"] .rental-stat.good { background:rgba(22,101,52,.22); }
      [data-theme="dark"] .rental-stat.warn, body[data-theme="dark"] .rental-stat.warn { background:rgba(146,64,14,.22); }
      [data-theme="dark"] .rental-stat.bad, body[data-theme="dark"] .rental-stat.bad { background:rgba(153,27,27,.22); }
      [data-theme="dark"] .clinic-outstanding-item, body[data-theme="dark"] .clinic-outstanding-item { background:rgba(127,29,29,.25); }
      @media (max-width:1100px) { .rental-summary-grid { grid-template-columns:repeat(3,minmax(0,1fr)); } .rental-form { grid-template-columns:repeat(2,minmax(0,1fr)); } .rental-wide { grid-column:span 2; } }
      @media (max-width:700px) { .rental-hero { align-items:flex-start; flex-direction:column; } .rental-summary-grid, .equipment-summary, .rental-form { grid-template-columns:1fr; } .rental-wide { grid-column:auto; } .rental-period-chip { align-self:flex-start; } }
    `;
    document.head.appendChild(style);
  }

  function stat(label, value, tone = "") {
    return `<div class="rental-stat ${tone}"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`;
  }

  function renderPsychConfig() {
    const config = rentalData().psychopedagogy;
    const activity = selectedPsychActivity();
    const activitySelect = document.querySelector("#psychActivitySelect");
    if (activitySelect) {
      activitySelect.innerHTML = state.activityCatalog
        .slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-BR"))
        .map((item) => `<option value="${escapeAttr(item.id)}">${escapeHTML(item.name)}</option>`).join("");
      activitySelect.value = activity?.id || config.activityId || "";
    }
    const professional = document.querySelector("#psychProfessionalName");
    const percent = document.querySelector("#psychRepassPercent");
    const defaultAccount = document.querySelector("#psychDefaultAccount");
    if (professional) professional.value = config.professionalName || "";
    if (percent) percent.value = Number(config.repassPercent || 60);
    if (defaultAccount) {
      defaultAccount.innerHTML = bankAccountOptions(config.defaultBankAccountId || "");
      defaultAccount.value = config.defaultBankAccountId || "";
    }
    const split = document.querySelector("#psychSplitBadge");
    const pct = Math.min(Math.max(Number(config.repassPercent || 60), 0), 100);
    if (split) split.textContent = `${String(pct).replace(".", ",")}% profissional · ${String(money(100 - pct)).replace(".", ",")}% Arte de Aprender`;
  }

  function renderPsychStudentLinkForm() {
    const select = document.querySelector("#psychStudentSelect");
    if (select) {
      const previous = select.value;
      const students = state.students.filter((item) => item.status !== "archived").slice().sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
      select.innerHTML = students.length
        ? students.map((student) => `<option value="${escapeAttr(student.id)}">${escapeHTML(student.name)}${psychItemForStudent(student) ? " · já vinculada" : ""}</option>`).join("")
        : `<option value="">Nenhuma criança cadastrada</option>`;
      if (students.some((student) => sameId(student.id, previous))) select.value = previous;
    }
    const start = document.querySelector("#psychStudentStart");
    if (start && !start.value) start.value = todayISO();
  }

  function renderPsychSummaryAndTable() {
    const metrics = psychMetrics();
    const summary = document.querySelector("#psychRentalSummary");
    if (summary) {
      summary.innerHTML = [
        stat("Crianças vinculadas", String(metrics.rows.length)),
        stat("Previsto da atividade", brl(metrics.expected)),
        stat("Recebido", brl(metrics.received), "good"),
        stat(`Repasse ${String(metrics.repassPercent).replace(".", ",")}%`, brl(metrics.repassDue), metrics.pendingRepass > 0 ? "warn" : "good"),
        stat("Já repassado", brl(metrics.repassed), "good"),
        stat("Falta repassar", brl(metrics.pendingRepass), metrics.pendingRepass > 0 ? "bad" : "good"),
        stat(`Parte Arte de Aprender ${String(metrics.saberPercent).replace(".", ",")}%`, brl(metrics.saberShare)),
      ].join("");
    }

    const tbody = document.querySelector("#psychStudentsTable");
    if (tbody) {
      tbody.innerHTML = metrics.rows.length
        ? metrics.rows.map((row) => {
            const status = row.payment ? paymentFinancialStatus(row.payment) : "none";
            const statusLabel = row.payment ? financialStatusLabel(status) : "Não gerada";
            const statusClass = status === "paid" ? "ok" : status === "partial" ? "warn" : "bad";
            return `<tr>
              <td class="rental-student-name"><strong>${escapeHTML(row.student.name)}</strong><small>${escapeHTML(row.student.guardian || "-")}${row.student.status === "paused" ? " · Pausada" : ""}</small></td>
              <td>${brl(row.expected)}</td>
              <td><strong>${brl(row.received)}</strong></td>
              <td>${brl(row.repassDue)}</td>
              <td>${brl(row.saberShare)}</td>
              <td>${row.presentDays}</td>
              <td><span class="rental-payment-status ${statusClass}">${escapeHTML(statusLabel)}</span></td>
              <td><div class="row-actions"><button type="button" class="small secondary" data-rental-edit-student="${escapeAttr(row.student.id)}">Editar</button><button type="button" class="small danger" data-rental-unlink-psych="${escapeAttr(row.student.id)}">Remover atividade</button></div></td>
            </tr>`;
          }).join("")
        : `<tr><td colspan="8"><div class="empty"><strong>Nenhuma criança vinculada</strong><span>Use “Vincular criança” para associar a Psicopedagogia ao cadastro.</span></div></td></tr>`;
    }

    const repassPeriod = document.querySelector("#psychRepassPeriod");
    const repassAmount = document.querySelector("#psychRepassAmount");
    const repassDate = document.querySelector("#psychRepassDate");
    const repassAccount = document.querySelector("#psychRepassAccount");
    if (repassPeriod && document.activeElement !== repassPeriod) repassPeriod.value = selectedPeriodKey();
    if (repassAmount && document.activeElement !== repassAmount) repassAmount.value = metrics.pendingRepass > 0 ? metrics.pendingRepass.toFixed(2) : "";
    if (repassDate && !repassDate.value) repassDate.value = todayISO();
    if (repassAccount) {
      const selected = repassAccount.value || rentalData().psychopedagogy.defaultBankAccountId || "";
      repassAccount.innerHTML = bankAccountOptions(selected);
      repassAccount.value = selected;
    }

    renderPsychRepassHistory();
  }

  function renderPsychRepassHistory() {
    const tbody = document.querySelector("#psychRepassHistory");
    if (!tbody) return;
    const records = rentalData().repasses
      .filter((item) => item.period === selectedPeriodKey())
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    tbody.innerHTML = records.length
      ? records.map((item) => `<tr><td>${formatDateBR(item.date)}</td><td>${escapeHTML(periodLabel(item.period))}</td><td><strong>${brl(item.amount)}</strong></td><td>${escapeHTML(bankAccountLabel(item.bankAccountId || ""))}</td><td>${escapeHTML(item.note || "-")}</td><td><button type="button" class="small danger" data-delete-psych-repass="${escapeAttr(item.id)}">Excluir</button></td></tr>`).join("")
      : `<tr><td colspan="6">Nenhum repasse registrado neste mês.</td></tr>`;
  }

  function renderClinicConfig() {
    const config = rentalData().clinic;
    const fields = {
      clinicTenantName: config.tenantName,
      clinicRoomName: config.roomName,
      clinicMonthlyRent: Number(config.monthlyRent || 0),
      clinicDueDay: Number(config.dueDay || 10),
      clinicStartDate: config.startDate || "",
      clinicNotes: config.notes || "",
    };
    Object.entries(fields).forEach(([id, value]) => {
      const el = document.querySelector(`#${id}`);
      if (el && document.activeElement !== el) el.value = value;
    });
    const account = document.querySelector("#clinicDefaultAccount");
    if (account) {
      account.innerHTML = bankAccountOptions(config.defaultBankAccountId || "");
      account.value = config.defaultBankAccountId || "";
    }
  }

  function renderClinicSummary() {
    const current = clinicPeriodSummary();
    const overdue = clinicOutstandingPeriods();
    const overdueTotal = money(overdue.reduce((sum, row) => sum + row.pending, 0));
    const equipment = equipmentTotals();
    const summary = document.querySelector("#clinicRentalSummary");
    if (summary) {
      summary.innerHTML = [
        stat("Locação do mês", brl(current.expected)),
        stat("Recebido no mês", brl(current.received), "good"),
        stat("Saldo do mês", brl(current.pending), current.pending > 0 ? "warn" : "good"),
        stat("Total pendente até o mês", brl(overdueTotal), overdueTotal > 0 ? "bad" : "good"),
        stat("Equipamentos Arte de Aprender", brl(equipment.saber)),
        stat("Equipamentos Clínica", brl(equipment.clinic)),
      ].join("");
    }

    const list = document.querySelector("#clinicOutstandingList");
    if (list) {
      list.innerHTML = overdue.length
        ? overdue.map((row) => `<div class="clinic-outstanding-item"><div><strong>${escapeHTML(periodLabel(row.period))}</strong><small>Previsto ${brl(row.expected)} · recebido ${brl(row.received)}</small></div><div><strong>${brl(row.pending)}</strong><button type="button" class="small secondary" data-use-clinic-period="${escapeAttr(row.period)}">Receber</button></div></div>`).join("")
        : `<div class="empty compact-empty"><strong>Nenhuma locação pendente</strong><span>Todos os meses até ${escapeHTML(periodLabel())} estão quitados.</span></div>`;
    }

    const period = document.querySelector("#clinicRentPeriod");
    const amount = document.querySelector("#clinicRentAmount");
    const date = document.querySelector("#clinicRentDate");
    const account = document.querySelector("#clinicRentAccount");
    if (period && document.activeElement !== period) period.value = selectedPeriodKey();
    if (amount && document.activeElement !== amount) amount.value = current.pending > 0 ? current.pending.toFixed(2) : "";
    if (date && !date.value) date.value = todayISO();
    if (account) {
      const selected = account.value || rentalData().clinic.defaultBankAccountId || "";
      account.innerHTML = bankAccountOptions(selected);
      account.value = selected;
    }

    renderClinicReceiptHistory();
    renderEquipment();
  }

  function renderClinicReceiptHistory() {
    const tbody = document.querySelector("#clinicRentHistory");
    if (!tbody) return;
    const records = rentalData().clinicReceipts
      .filter((item) => item.period === selectedPeriodKey())
      .slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    tbody.innerHTML = records.length
      ? records.map((item) => `<tr><td>${formatDateBR(item.date)}</td><td>${escapeHTML(periodLabel(item.period))}</td><td><strong>${brl(item.amount)}</strong></td><td>${escapeHTML(bankAccountLabel(item.bankAccountId || ""))}</td><td>${escapeHTML(item.note || "-")}</td><td><button type="button" class="small danger" data-delete-clinic-receipt="${escapeAttr(item.id)}">Excluir</button></td></tr>`).join("")
      : `<tr><td colspan="6">Nenhum aluguel recebido neste mês.</td></tr>`;
  }

  function renderEquipment() {
    const total = equipmentTotals();
    const summary = document.querySelector("#clinicEquipmentSummary");
    if (summary) summary.innerHTML = [stat("Total patrimônio registrado", brl(total.total)), stat("Comprado pelo Arte de Aprender", brl(total.saber)), stat("Comprado pela clínica", brl(total.clinic))].join("");

    const date = document.querySelector("#clinicEquipmentDate");
    if (date && !date.value) date.value = todayISO();

    const tbody = document.querySelector("#clinicEquipmentTable");
    if (!tbody) return;
    const rows = rentalData().equipment.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    tbody.innerHTML = rows.length
      ? rows.map((item) => `<tr><td>${formatDateBR(item.date)}</td><td><strong>${escapeHTML(item.description)}</strong></td><td><span class="equipment-owner ${item.purchasedBy === "clinic" ? "clinic" : "saber"}">${item.purchasedBy === "clinic" ? "Clínica" : "Arte de Aprender"}</span></td><td>${brl(item.amount)}</td><td>${escapeHTML(item.note || "-")}</td><td><button type="button" class="small danger" data-delete-clinic-equipment="${escapeAttr(item.id)}">Excluir</button></td></tr>`).join("")
      : `<tr><td colspan="6">Nenhum equipamento registrado.</td></tr>`;
  }

  function renderRentalsFinance() {
    mountFinancePane();
    if (!document.querySelector("#financeRentalsPane")) return;
    const periodChip = document.querySelector("#rentalPeriodChip");
    if (periodChip) periodChip.textContent = periodLabel();
    renderPsychConfig();
    renderPsychStudentLinkForm();
    renderPsychSummaryAndTable();
    renderClinicConfig();
    renderClinicSummary();
  }

  let eventsBound = false;
  function bindRentalEvents() {
    if (eventsBound) return;
    eventsBound = true;

    document.querySelector("#psychRentalConfigForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const config = rentalData().psychopedagogy;
      config.professionalName = document.querySelector("#psychProfessionalName")?.value.trim() || "Psicopedagoga";
      config.activityId = document.querySelector("#psychActivitySelect")?.value || config.activityId;
      config.repassPercent = Math.min(Math.max(Number(document.querySelector("#psychRepassPercent")?.value || 60), 0), 100);
      config.defaultBankAccountId = document.querySelector("#psychDefaultAccount")?.value || "";
      saveState();
      renderAll();
      showToast("Configuração da Psicopedagogia salva.");
    });

    document.querySelector("#psychLinkStudentForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const studentId = document.querySelector("#psychStudentSelect")?.value || "";
      const value = Number(document.querySelector("#psychStudentValue")?.value || 0);
      const startDate = document.querySelector("#psychStudentStart")?.value || todayISO();
      if (!studentId) return showToast("Selecione uma criança.");
      if (value < 0) return showToast("Informe um valor válido.");
      if (!addPsychActivityToStudent(studentId, value, startDate)) return showToast("Não consegui vincular a atividade.");
      saveState();
      renderAll();
      showToast("Criança vinculada à Psicopedagogia e disponível na chamada.");
    });

    document.querySelector("#psychRepassForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const period = document.querySelector("#psychRepassPeriod")?.value || selectedPeriodKey();
      const amount = Number(document.querySelector("#psychRepassAmount")?.value || 0);
      const date = document.querySelector("#psychRepassDate")?.value || todayISO();
      const bankAccountId = document.querySelector("#psychRepassAccount")?.value || "";
      const note = document.querySelector("#psychRepassNote")?.value.trim() || "";
      if (!(amount > 0)) return showToast("Informe o valor do repasse.");
      const record = { id: uid(), period, amount: money(amount), date, bankAccountId, note, expenseId: "", createdAt: new Date().toISOString() };
      addPaidExpenseForRepass(record);
      rentalData().repasses.push(record);
      saveState();
      renderAll();
      const noteField = document.querySelector("#psychRepassNote");
      if (noteField) noteField.value = "";
      showToast("Repasse registrado e lançado nas despesas.");
    });

    document.querySelector("#clinicRentalConfigForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const config = rentalData().clinic;
      config.tenantName = document.querySelector("#clinicTenantName")?.value.trim() || "Clínica";
      config.roomName = document.querySelector("#clinicRoomName")?.value.trim() || "Sala da clínica";
      config.monthlyRent = Math.max(Number(document.querySelector("#clinicMonthlyRent")?.value || 0), 0);
      config.dueDay = Math.min(Math.max(Number(document.querySelector("#clinicDueDay")?.value || 10), 1), 31);
      config.startDate = document.querySelector("#clinicStartDate")?.value || "";
      config.defaultBankAccountId = document.querySelector("#clinicDefaultAccount")?.value || "";
      config.notes = document.querySelector("#clinicNotes")?.value.trim() || "";
      saveState();
      renderAll();
      showToast("Dados da locação da clínica salvos.");
    });

    document.querySelector("#clinicRentReceiptForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const period = document.querySelector("#clinicRentPeriod")?.value || selectedPeriodKey();
      const amount = Number(document.querySelector("#clinicRentAmount")?.value || 0);
      const date = document.querySelector("#clinicRentDate")?.value || todayISO();
      const bankAccountId = document.querySelector("#clinicRentAccount")?.value || "";
      const note = document.querySelector("#clinicRentNote")?.value.trim() || "";
      if (!(amount > 0)) return showToast("Informe o valor recebido da locação.");
      const record = { id: uid(), period, amount: money(amount), date, bankAccountId, note, incomeId: "", createdAt: new Date().toISOString() };
      addClinicIncome(record);
      rentalData().clinicReceipts.push(record);
      saveState();
      renderAll();
      const noteField = document.querySelector("#clinicRentNote");
      if (noteField) noteField.value = "";
      showToast("Aluguel recebido e lançado nas entradas do financeiro.");
    });

    document.querySelector("#clinicEquipmentForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const description = document.querySelector("#clinicEquipmentDescription")?.value.trim() || "";
      const purchasedBy = document.querySelector("#clinicEquipmentBuyer")?.value === "clinic" ? "clinic" : "saber";
      const amount = Number(document.querySelector("#clinicEquipmentAmount")?.value || 0);
      const date = document.querySelector("#clinicEquipmentDate")?.value || todayISO();
      const note = document.querySelector("#clinicEquipmentNote")?.value.trim() || "";
      if (!description) return showToast("Informe o equipamento.");
      if (amount < 0) return showToast("Informe um valor válido.");
      rentalData().equipment.push({ id: uid(), description, purchasedBy, amount: money(amount), date, note, createdAt: new Date().toISOString() });
      event.target.reset();
      saveState();
      renderAll();
      showToast("Equipamento adicionado ao controle da parceria.");
    });

    document.addEventListener("click", (event) => {
      const studentId = event.target.closest("[data-rental-edit-student]")?.dataset.rentalEditStudent;
      if (studentId) {
        const student = state.students.find((item) => sameId(item.id, studentId));
        if (student) {
          fillStudentForm(student);
          switchView("students");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
        return;
      }

      const unlinkId = event.target.closest("[data-rental-unlink-psych]")?.dataset.rentalUnlinkPsych;
      if (unlinkId) {
        const student = state.students.find((item) => sameId(item.id, unlinkId));
        if (!student || !confirm(`Remover Psicopedagogia do cadastro de ${student.name}?`)) return;
        removePsychActivityFromStudent(unlinkId);
        saveState();
        renderAll();
        showToast("Psicopedagogia removida do cadastro da criança.");
        return;
      }

      const repassId = event.target.closest("[data-delete-psych-repass]")?.dataset.deletePsychRepass;
      if (repassId) {
        const record = rentalData().repasses.find((item) => sameId(item.id, repassId));
        if (!record || !confirm(`Excluir o repasse de ${brl(record.amount)}?`)) return;
        removePaidExpenseForRepass(record);
        rentalData().repasses = rentalData().repasses.filter((item) => !sameId(item.id, repassId));
        saveState();
        renderAll();
        showToast("Repasse excluído e lançamento financeiro estornado.");
        return;
      }

      const receiptId = event.target.closest("[data-delete-clinic-receipt]")?.dataset.deleteClinicReceipt;
      if (receiptId) {
        const record = rentalData().clinicReceipts.find((item) => sameId(item.id, receiptId));
        if (!record || !confirm(`Excluir o recebimento de ${brl(record.amount)}?`)) return;
        removeClinicIncome(record);
        rentalData().clinicReceipts = rentalData().clinicReceipts.filter((item) => !sameId(item.id, receiptId));
        saveState();
        renderAll();
        showToast("Recebimento da clínica excluído e saldo estornado.");
        return;
      }

      const equipmentId = event.target.closest("[data-delete-clinic-equipment]")?.dataset.deleteClinicEquipment;
      if (equipmentId) {
        const item = rentalData().equipment.find((row) => sameId(row.id, equipmentId));
        if (!item || !confirm(`Excluir o equipamento ${item.description}?`)) return;
        rentalData().equipment = rentalData().equipment.filter((row) => !sameId(row.id, equipmentId));
        saveState();
        renderAll();
        showToast("Equipamento removido do controle.");
        return;
      }

      const clinicPeriod = event.target.closest("[data-use-clinic-period]")?.dataset.useClinicPeriod;
      if (clinicPeriod) {
        const input = document.querySelector("#clinicRentPeriod");
        const amount = document.querySelector("#clinicRentAmount");
        if (input) input.value = clinicPeriod;
        if (amount) amount.value = clinicPeriodSummary(clinicPeriod).pending.toFixed(2);
        document.querySelector("#clinicRentReceiptForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }

  mountFinancePane();

  const originalRenderFinance = renderFinance;
  renderFinance = function renderFinanceWithRentals() {
    originalRenderFinance();
    renderRentalsFinance();
  };

  try {
    window.renderFinance = renderFinance;
    window.renderRentalsFinance = renderRentalsFinance;
  } catch (error) {
    console.warn("Não foi possível publicar a gestão de locações e repasses.", error);
  }

  renderRentalsFinance();
  saveState();
})();
