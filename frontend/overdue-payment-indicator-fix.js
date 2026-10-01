// Mostra, na mensalidade do mês atual, débitos de meses anteriores da mesma criança.
(() => {
  if (typeof renderPayments !== "function") return;

  const originalRenderPayments = renderPayments;

  function sameId(a, b) {
    return String(a ?? "").trim() === String(b ?? "").trim();
  }

  function previousOpenPayments(studentId, currentPeriod = selectedPeriodKey()) {
    return (state.payments || [])
      .filter((payment) => {
        const period = String(payment?.period || "");
        return sameId(payment?.studentId, studentId)
          && /^\d{4}-\d{2}$/.test(period)
          && period < currentPeriod
          && paymentRemainingAmount(payment) > 0.009;
      })
      .sort((a, b) => String(a.period).localeCompare(String(b.period)));
  }

  function sortedCurrentPayments() {
    return currentPayments().slice().sort((a, b) => {
      const studentA = getStudent(a.studentId);
      const studentB = getStudent(b.studentId);
      const nameCompare = String(studentA?.name || "Criança removida").localeCompare(
        String(studentB?.name || "Criança removida"),
        "pt-BR",
        { sensitivity: "base" },
      );
      if (nameCompare !== 0) return nameCompare;
      return String(studentA?.guardian || "").localeCompare(
        String(studentB?.guardian || ""),
        "pt-BR",
        { sensitivity: "base" },
      );
    });
  }

  function ensureOverdueStyle() {
    if (document.querySelector("#overduePaymentIndicatorStyle")) return;
    const style = document.createElement("style");
    style.id = "overduePaymentIndicatorStyle";
    style.textContent = `
      #paymentsTable tr.has-overdue-history > td:first-child {
        border-left: 4px solid #dc2626;
      }
      .overdue-history-alert {
        display: grid;
        gap: 4px;
        margin-top: 9px;
        padding: 9px 10px;
        border: 1px solid rgba(220, 38, 38, 0.35);
        border-radius: 10px;
        background: rgba(254, 226, 226, 0.82);
        color: #7f1d1d;
        line-height: 1.28;
      }
      .overdue-history-alert strong {
        color: #991b1b;
        font-size: 12px;
      }
      .overdue-history-alert span {
        color: #7f1d1d;
        font-size: 11px;
        font-weight: 600;
      }
      .overdue-history-alert em {
        color: #991b1b;
        font-size: 11px;
        font-style: normal;
        font-weight: 800;
      }
      [data-theme="dark"] .overdue-history-alert,
      body[data-theme="dark"] .overdue-history-alert {
        background: rgba(127, 29, 29, 0.28);
        border-color: rgba(248, 113, 113, 0.52);
        color: #fecaca;
      }
      [data-theme="dark"] .overdue-history-alert strong,
      [data-theme="dark"] .overdue-history-alert span,
      [data-theme="dark"] .overdue-history-alert em,
      body[data-theme="dark"] .overdue-history-alert strong,
      body[data-theme="dark"] .overdue-history-alert span,
      body[data-theme="dark"] .overdue-history-alert em {
        color: #fecaca;
      }
    `;
    document.head.appendChild(style);
  }

  function decoratePaymentsWithOverdueHistory() {
    const tbody = document.querySelector("#paymentsTable");
    if (!tbody) return;

    const payments = sortedCurrentPayments();
    const rows = Array.from(tbody.children).filter((element) => element.tagName === "TR");

    payments.forEach((payment, index) => {
      const row = rows[index];
      if (!row) return;

      row.classList.remove("has-overdue-history");
      row.querySelector(".overdue-history-alert")?.remove();

      const overdue = previousOpenPayments(payment.studentId);
      if (!overdue.length) return;

      const total = overdue.reduce((sum, item) => sum + paymentRemainingAmount(item), 0);
      const details = overdue.map((item) => {
        const remaining = paymentRemainingAmount(item);
        const received = paymentReceivedAmount(item);
        const statusText = received > 0.009 ? `falta ${brl(remaining)} (parcial)` : brl(remaining);
        return `${periodLabel(item.period)}: ${statusText}`;
      });

      const alert = document.createElement("div");
      alert.className = "overdue-history-alert";
      alert.setAttribute("role", "note");
      alert.innerHTML = `
        <strong>⚠ ${overdue.length} mensalidade${overdue.length === 1 ? " anterior pendente" : "s anteriores pendentes"}</strong>
        <span>${escapeHTML(details.join(" · "))}</span>
        <em>Total atrasado: ${escapeHTML(brl(total))}</em>
      `;

      const firstCell = row.cells?.[0];
      if (!firstCell) return;
      row.classList.add("has-overdue-history");
      firstCell.appendChild(alert);
    });
  }

  renderPayments = function renderPaymentsWithOverdueIndicator() {
    originalRenderPayments();
    decoratePaymentsWithOverdueHistory();
  };

  try {
    window.renderPayments = renderPayments;
  } catch (error) {
    console.warn("Não foi possível publicar o indicador de mensalidades atrasadas.", error);
  }

  ensureOverdueStyle();
  if (document.querySelector("#paymentsTable")) renderPayments();
})();
