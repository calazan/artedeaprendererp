// Bootstrap da interface empacotada no repositório Python.
// Nenhum módulo abaixo é carregado de outro repositório ou projeto HTML externo.
(() => {
  if (window.__saberPythonOwnedBootstrapLoaded) return;
  window.__saberPythonOwnedBootstrapLoaded = true;

  function hideLegacyRemoteCard() {
    const form = document.querySelector("#remoteSyncForm");
    const card = form?.closest?.(".remote-sync-card");
    if (card && card.id !== "supabaseSyncCard") card.hidden = true;
  }

  function appendScript({ selector, src, datasetKey, errorMessage, onLoad }) {
    if (document.querySelector(selector)) return;
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.dataset[datasetKey] = "true";
    if (onLoad) script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", () => console.error(errorMessage), { once: true });
    document.body.appendChild(script);
  }

  function loadSupabaseSync() {
    if (window.__saberSupabaseAdminLoaded) return;
    appendScript({
      selector: 'script[data-supabase-admin-sync]',
      src: "supabase-admin-sync.js?v=5",
      datasetKey: "supabaseAdminSync",
      errorMessage: "Não foi possível carregar a sincronização Python/Supabase.",
      onLoad: hideLegacyRemoteCard,
    });
  }

  function loadRentalIndividualReports() {
    if (window.__saberRentalIndividualReportsLoaded) return;
    appendScript({
      selector: 'script[data-rental-individual-reports]',
      src: "rental-individual-reports.js?v=1",
      datasetKey: "rentalIndividualReports",
      errorMessage: "Não foi possível carregar os relatórios individuais de locações e repasses.",
    });
  }

  function loadRentalsMainHub() {
    if (window.__saberRentalsMainHubLoaded) return;
    appendScript({
      selector: 'script[data-rentals-main-hub]',
      src: "rentals-main-hub.js?v=1",
      datasetKey: "rentalsMainHub",
      errorMessage: "Não foi possível carregar a central de locações e repasses.",
    });
  }

  function loadRentalReceivablesControl() {
    if (window.__saberRentalReceivablesControlLoaded) return;
    appendScript({
      selector: 'script[data-rental-receivables-control]',
      src: "rental-receivables-control.js?v=1",
      datasetKey: "rentalReceivablesControl",
      errorMessage: "Não foi possível carregar o controle de contas a receber das locações.",
    });
  }

  function loadCashFlowStatusFilter() {
    if (window.__saberCashFlowStatusFilterLoaded) return;
    appendScript({
      selector: 'script[data-cashflow-status-filter]',
      src: "cashflow-report-status-filter.js?v=1",
      datasetKey: "cashflowStatusFilter",
      errorMessage: "Não foi possível carregar o filtro de situação do fluxo de caixa.",
    });
  }

  function loadTasksShoppingAdjustments() {
    if (window.__saberTasksShoppingAdjustmentsLoaded) return;
    appendScript({
      selector: 'script[data-tasks-shopping-adjustments]',
      src: "tasks-shopping-adjustments.js?v=1",
      datasetKey: "tasksShoppingAdjustments",
      errorMessage: "Não foi possível carregar os ajustes da lista de compras.",
    });
  }

  function loadTasksRoutine() {
    if (window.__saberTasksRoutineLoaded) {
      loadTasksShoppingAdjustments();
      return;
    }
    appendScript({
      selector: 'script[data-tasks-routine]',
      src: "tasks-routine.js?v=2",
      datasetKey: "tasksRoutine",
      errorMessage: "Não foi possível carregar Tarefas e Rotina.",
      onLoad: loadTasksShoppingAdjustments,
    });
  }

  function loadWhatsappReminders() {
    if (window.__saberWhatsappRemindersLoaded) return;
    appendScript({
      selector: 'script[data-whatsapp-reminders]',
      src: "whatsapp-reminders.js?v=2",
      datasetKey: "whatsappReminders",
      errorMessage: "Não foi possível carregar os lembretes de WhatsApp.",
    });
  }

  function loadDashboardRedesign() {
    if (window.__saberDashboardRedesignLoaded) return;
    appendScript({
      selector: 'script[data-dashboard-redesign]',
      src: "dashboard-redesign.js?v=1",
      datasetKey: "dashboardRedesign",
      errorMessage: "Não foi possível carregar o painel.",
    });
  }

  function loadEmployeeTaxBillUpload() {
    if (window.__saberEmployeeTaxBillUploadLoaded) return;
    appendScript({
      selector: 'script[data-employee-tax-bill-upload]',
      src: "employee-tax-bill-upload.js?v=1",
      datasetKey: "employeeTaxBillUpload",
      errorMessage: "Não foi possível carregar os comprovantes de funcionários.",
    });
  }

  function loadEmployeeManagement() {
    if (window.__saberEmployeeManagementLoaded) {
      loadEmployeeTaxBillUpload();
      return;
    }
    appendScript({
      selector: 'script[data-employee-management]',
      src: "employee-management.js?v=2",
      datasetKey: "employeeManagement",
      errorMessage: "Não foi possível carregar a gestão de funcionários.",
      onLoad: loadEmployeeTaxBillUpload,
    });
  }

  function loadPreRegistrationRecovery() {
    if (window.__saberPreRegistrationRecoveryLoaded) return;
    appendScript({
      selector: 'script[data-pre-registration-recovery]',
      src: "pre-registration-recovery-fix.js?v=2",
      datasetKey: "preRegistrationRecovery",
      errorMessage: "Não foi possível carregar a recuperação do pré-cadastro.",
    });
  }

  function loadPreRegistrationAdmin() {
    if (window.__saberPreRegistrationAdminLoaded) {
      loadPreRegistrationRecovery();
      return;
    }
    appendScript({
      selector: 'script[data-pre-registration-admin]',
      src: "pre-registration-admin.js?v=2",
      datasetKey: "preRegistrationAdmin",
      errorMessage: "Não foi possível carregar a administração de pré-cadastros.",
      onLoad: loadPreRegistrationRecovery,
    });
  }

  hideLegacyRemoteCard();
  loadSupabaseSync();
  loadRentalIndividualReports();
  loadRentalsMainHub();
  loadRentalReceivablesControl();
  loadCashFlowStatusFilter();
  loadTasksRoutine();
  loadDashboardRedesign();
  loadWhatsappReminders();
  loadEmployeeManagement();
  loadPreRegistrationAdmin();

  const observer = new MutationObserver(hideLegacyRemoteCard);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 15000);
})();
