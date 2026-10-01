// Corrige a chamada administrativa para IDs de participantes de eventos que contêm dois-pontos.
(() => {
  const EXTRA_PREFIX = "extra-participant:";
  const VALID_STATUSES = new Set(["present", "absent", "excused", "unset"]);
  const VALID_PERIODS = new Set(["morning", "afternoon", "full"]);

  function normalizedId(value = "") {
    return String(value ?? "").trim();
  }

  function splitAtLastColon(raw = "") {
    const value = String(raw || "");
    const separator = value.lastIndexOf(":");
    if (separator <= 0 || separator >= value.length - 1) return ["", ""];
    return [value.slice(0, separator), value.slice(separator + 1)];
  }

  try {
    participantsForEvent = function participantsForEventNormalized(eventId) {
      const wanted = normalizedId(eventId);
      return (state.extraParticipants || []).filter((participant) => normalizedId(participant?.eventId) === wanted);
    };
  } catch (error) {
    console.warn("Não foi possível normalizar os participantes dos eventos.", error);
  }

  document.addEventListener("click", (event) => {
    const quickButton = event.target.closest("[data-quick-time]");
    const rawQuick = quickButton?.dataset.quickTime || "";
    if (rawQuick.startsWith(EXTRA_PREFIX)) {
      const [studentId, period] = splitAtLastColon(rawQuick);
      if (!studentId || !VALID_PERIODS.has(period)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      applyQuickAttendanceTime(studentId, period);
      saveState();
      renderAll();
      showToast("Horário do participante registrado.");
      return;
    }

    const presenceButton = event.target.closest("[data-presence]");
    const rawPresence = presenceButton?.dataset.presence || "";
    if (!rawPresence.startsWith(EXTRA_PREFIX)) return;
    const [studentId, status] = splitAtLastColon(rawPresence);
    if (!studentId || !VALID_STATUSES.has(status)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const date = document.querySelector("#attendanceDate")?.value || todayISO();
    const item = ensureAttendanceItem(date, studentId);
    item.status = status;
    if (status !== "present") {
      item.hours = 0;
      item.checkIn = "";
      item.checkOut = "";
    }
    touchAttendanceItem(item);
    saveState();
    renderAll();
    showToast("Presença do participante registrada.");
  }, true);

  if (!document.querySelector("#preRegistrationMenuPinkStyle")) {
    const style = document.createElement("style");
    style.id = "preRegistrationMenuPinkStyle";
    style.textContent = `
      .tabs .tab[data-view="preRegistrations"] {
        background: linear-gradient(135deg, #e96aa7, #c94f8b) !important;
        color: #ffffff !important;
        border-color: transparent !important;
        box-shadow: 0 8px 18px rgba(201, 79, 139, 0.24) !important;
      }
      .tabs .tab[data-view="preRegistrations"]:hover { filter: brightness(1.06); transform: translateY(-1px); }
      .tabs .tab[data-view="preRegistrations"].is-active {
        background: linear-gradient(135deg, #d85b98, #ad3e77) !important;
        color: #ffffff !important;
        box-shadow: 0 9px 22px rgba(173, 62, 119, 0.3) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // Uma única fila controla todos os módulos complementares. Isso elimina a concorrência
  // entre vários createElement('script') executados ao mesmo tempo.
  window.__saberOrderedModulesManaged = true;
  const orderedScripts = [
    ["preRegistrationAdmin", "pre-registration-admin.js?v=3"],
    ["preRegistrationRecoveryFix", "pre-registration-recovery-fix.js?v=1"],
    ["receiptMonthlyValueOnlyFix", "receipt-monthly-value-only-fix.js?v=3"],
    ["zebraLogoLabelFix", "zebra-logo-label-fix.js?v=2"],
    ["generalReportActivityValueFix", "general-report-activity-value-fix.js?v=2"],
    ["extraEventIndividualReportFix", "extra-event-individual-report-fix.js?v=1"],
    ["overduePaymentIndicatorFix", "overdue-payment-indicator-fix.js?v=1"],
    ["rentalsRepassesFinance", "rentals-repasses-finance.js?v=3"],
    ["employeeManagement", "employee-management.js?v=3"],
    ["mainMenuColors", "main-menu-colors.js?v=3"],
    ["paymentDeletionPersistenceFix", "payment-deletion-persistence-fix.js?v=2"],
    ["rentalRepassesEnhancement", "rental-repasses-enhancement.js?v=1"],
    ["rentalRepassPayUiFix", "rental-repass-pay-ui-fix.js?v=1"],
    ["navigationColorCustomizationV2", "navigation-color-customization-v2.js?v=2"],
    ["employeeTaxBillUpload", "employee-tax-bill-upload.js?v=1"],
    ["monthlyPaymentAmountFix", "monthly-payment-amount-fix.js?v=2"],
    ["supabaseFullStateSeedFix", "supabase-full-state-seed-fix.js?v=1"],
  ];

  function dataAttributeName(key) {
    return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  }

  function loadOrdered(index = 0) {
    if (index >= orderedScripts.length) return;
    const [key, src] = orderedScripts[index];
    const selector = `script[data-${dataAttributeName(key)}]`;
    const existing = document.querySelector(selector);
    if (existing) {
      if (existing.dataset.loaded === "true" || existing.readyState === "complete") {
        loadOrdered(index + 1);
      } else {
        existing.addEventListener("load", () => loadOrdered(index + 1), { once: true });
        existing.addEventListener("error", () => loadOrdered(index + 1), { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.dataset[key] = "true";
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      loadOrdered(index + 1);
    }, { once: true });
    script.addEventListener("error", () => {
      console.error(`Falha ao carregar módulo: ${src}`);
      loadOrdered(index + 1);
    }, { once: true });
    document.body.appendChild(script);
  }

  loadOrdered();

  document.addEventListener("click", (event) => {
    const button = event.target.closest('.finance-subtab[data-finance-pane="rentals"]');
    if (!button) return;
    switchFinancePane("rentals");
  });
})();
