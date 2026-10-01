// Filtro de exportação do Relatório de Fluxo de Caixa por situação.
(() => {
  if (window.__saberCashFlowStatusFilterLoaded) return;
  window.__saberCashFlowStatusFilterLoaded = true;

  const originalCashFlowReportHTMLContent = cashFlowReportHTMLContent;
  const originalReportCSVRows = reportCSVRows;
  const originalReportFilenamePrefix = reportFilenamePrefix;

  function selectedStatus() {
    const value = document.querySelector("#cashFlowExportStatus")?.value || "all";
    return ["all", "paid", "pending"].includes(value) ? value : "all";
  }

  function html(value) {
    try { return escapeHTML(value); } catch {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }
  }

  function pendingIncomeRows() {
    return currentPayments()
      .filter((payment) => paymentRemainingAmount(payment) > 0.009)
      .map((payment) => {
        const student = getStudent(payment.studentId);
        return {
          payment,
          student,
          expected: Number(payment.amount || 0),
          received: Number(paymentReceivedAmount(payment) || 0),
          remaining: Number(paymentRemainingAmount(payment) || 0),
          status: financialStatusLabel(paymentFinancialStatus(payment)),
        };
      })
      .sort((a, b) => String(a.student?.name || "").localeCompare(String(b.student?.name || ""), "pt-BR", { sensitivity: "base" }));
  }

  function pendingExpenseRows() {
    return currentExpenses()
      .filter((expense) => expense.status !== "paid")
      .slice()
      .sort((a, b) => String(expenseReferenceDate(a) || "").localeCompare(String(expenseReferenceDate(b) || "")));
  }

  function paidSections(incomes, expenses) {
    const incomeRows = incomes.length
      ? incomes.map((income) => `<tr class="report-row-paid"><td>${formatDateBR(income.date)}</td><td>${html(income.source)}</td><td>${html(income.description)}</td><td>${html(income.detail || "-")}</td><td>${html(income.method || income.account || "-")}</td><td>${brl(income.gross)}</td><td>${brl(income.fee)}</td><td>${brl(income.net)}</td></tr>`).join("")
      : `<tr><td colspan="8">Nenhuma entrada recebida neste mês.</td></tr>`;

    const expenseRows = expenses.length
      ? expenses.map(({ expense, date, amount, account }) => `<tr class="report-row-paid"><td>${formatDateBR(date)}</td><td>${formatDateBR(expenseReferenceDate(expense))}</td><td>${html(expense.description)}</td><td>${html(expense.category || "-")}</td><td>${html(account || "-")}</td><td>${brl(amount)}</td></tr>`).join("")
      : `<tr><td colspan="6">Nenhuma saída paga neste mês.</td></tr>`;

    return `
      <h2>Entradas recebidas</h2>
      <table>
        <tr><th>Data</th><th>Origem</th><th>Descrição</th><th>Detalhe</th><th>Forma/Conta</th><th>Bruto</th><th>Taxa</th><th>Líquido</th></tr>
        ${incomeRows}
      </table>
      <h2>Saídas pagas</h2>
      <table>
        <tr><th>Pagamento</th><th>Vencimento</th><th>Descrição</th><th>Categoria</th><th>Conta bancária</th><th>Valor</th></tr>
        ${expenseRows}
      </table>`;
  }

  function pendingSections(payments, expenses) {
    const paymentRows = payments.length
      ? payments.map(({ payment, student, expected, received, remaining, status }) => `<tr class="report-row-pending"><td>${html(student?.name || "Criança removida")}</td><td>${html(student?.guardian || "-")}</td><td>${payment.dueDay ? `Dia ${Number(payment.dueDay)}` : "-"}</td><td>${html(status)}</td><td>${brl(expected)}</td><td>${brl(received)}</td><td><strong>${brl(remaining)}</strong></td></tr>`).join("")
      : `<tr><td colspan="7">Nenhuma mensalidade pendente neste mês.</td></tr>`;

    const expenseRows = expenses.length
      ? expenses.map((expense) => `<tr class="report-row-pending"><td>${formatDateBR(expenseReferenceDate(expense))}</td><td>${html(expense.description || "-")}</td><td>${html(expense.category || "-")}</td><td>Pendente</td><td>${brl(expense.amount)}</td></tr>`).join("")
      : `<tr><td colspan="5">Nenhuma saída pendente neste mês.</td></tr>`;

    return `
      <h2>Entradas pendentes</h2>
      <table>
        <tr><th>Criança</th><th>Responsável</th><th>Vencimento</th><th>Status</th><th>Previsto</th><th>Já recebido</th><th>Saldo pendente</th></tr>
        ${paymentRows}
      </table>
      <h2>Saídas pendentes</h2>
      <table>
        <tr><th>Vencimento</th><th>Descrição</th><th>Categoria</th><th>Status</th><th>Valor</th></tr>
        ${expenseRows}
      </table>`;
  }

  cashFlowReportHTMLContent = function cashFlowReportHTMLContentFiltered() {
    const status = selectedStatus();
    if (status === "all" && !document.querySelector("#cashFlowExportStatus")) {
      return originalCashFlowReportHTMLContent();
    }

    const incomes = paidIncomeRows();
    const paidExpenses = paidExpenseRows();
    const openPayments = pendingIncomeRows();
    const openExpenses = pendingExpenseRows();
    const incomeTotal = incomes.reduce((sum, item) => sum + Number(item.net || 0), 0);
    const expenseTotal = paidExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const openIncomeTotal = openPayments.reduce((sum, item) => sum + Number(item.remaining || 0), 0);
    const openExpenseTotal = openExpenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);

    const label = status === "paid" ? "apenas pagos" : status === "pending" ? "apenas pendentes" : "pagos e pendentes";
    const summary = status === "paid"
      ? `<table><tr><th>Entradas recebidas</th><th>Saídas pagas</th><th>Saldo realizado</th></tr><tr><td>${brl(incomeTotal)}</td><td>${brl(expenseTotal)}</td><td>${brl(incomeTotal - expenseTotal)}</td></tr></table>`
      : status === "pending"
        ? `<table><tr><th>Entradas pendentes</th><th>Saídas pendentes</th><th>Saldo projetado</th></tr><tr><td>${brl(openIncomeTotal)}</td><td>${brl(openExpenseTotal)}</td><td>${brl(openIncomeTotal - openExpenseTotal)}</td></tr></table>`
        : `<table><tr><th>Entradas recebidas</th><th>Saídas pagas</th><th>Saldo realizado</th><th>Entradas pendentes</th><th>Saídas pendentes</th></tr><tr><td>${brl(incomeTotal)}</td><td>${brl(expenseTotal)}</td><td>${brl(incomeTotal - expenseTotal)}</td><td>${brl(openIncomeTotal)}</td><td>${brl(openExpenseTotal)}</td></tr></table>`;

    return `
      <h1>Relatório de fluxo de caixa - ${html(periodLabel())}</h1>
      <p>Arte de Aprender · ${html(label)}</p>
      ${summary}
      ${status !== "pending" ? paidSections(incomes, paidExpenses) : ""}
      ${status !== "paid" ? pendingSections(openPayments, openExpenses) : ""}
    `;
  };

  function paidCSVRows() {
    const incomes = paidIncomeRows().map((income) => ({
      "Situação": "Pago/Recebido",
      "Tipo": income.source || "Entrada",
      "Data": income.date ? formatDateBR(income.date) : "",
      "Vencimento": "",
      "Descrição": income.description || "",
      "Responsável/Categoria": income.detail || "",
      "Forma/Conta": income.method || income.account || "",
      "Valor previsto": brl(income.gross || 0),
      "Recebido/Pago": brl(income.gross || 0),
      "Saldo pendente": brl(0),
      "Taxa": brl(income.fee || 0),
      "Líquido": brl(income.net || 0),
    }));

    const expenses = paidExpenseRows().map(({ expense, date, amount, account }) => ({
      "Situação": "Pago/Recebido",
      "Tipo": "Despesa",
      "Data": date ? formatDateBR(date) : "",
      "Vencimento": formatDateBR(expenseReferenceDate(expense)),
      "Descrição": expense.description || "",
      "Responsável/Categoria": expense.category || "",
      "Forma/Conta": account || "",
      "Valor previsto": brl(amount || 0),
      "Recebido/Pago": brl(amount || 0),
      "Saldo pendente": brl(0),
      "Taxa": "",
      "Líquido": `-${brl(amount || 0)}`,
    }));
    return [...incomes, ...expenses];
  }

  function pendingCSVRows() {
    const payments = pendingIncomeRows().map(({ payment, student, expected, received, remaining, status }) => ({
      "Situação": "Pendente",
      "Tipo": "Mensalidade",
      "Data": "",
      "Vencimento": payment.dueDay ? `Dia ${Number(payment.dueDay)}` : "",
      "Descrição": student?.name || "Criança removida",
      "Responsável/Categoria": student?.guardian || "",
      "Forma/Conta": "",
      "Valor previsto": brl(expected),
      "Recebido/Pago": brl(received),
      "Saldo pendente": brl(remaining),
      "Taxa": brl(paymentFeeAmount(payment) || 0),
      "Líquido": status,
    }));

    const expenses = pendingExpenseRows().map((expense) => ({
      "Situação": "Pendente",
      "Tipo": "Despesa",
      "Data": expense.date ? formatDateBR(expense.date) : "",
      "Vencimento": formatDateBR(expenseReferenceDate(expense)),
      "Descrição": expense.description || "",
      "Responsável/Categoria": expense.category || "",
      "Forma/Conta": "",
      "Valor previsto": brl(expense.amount || 0),
      "Recebido/Pago": brl(0),
      "Saldo pendente": brl(expense.amount || 0),
      "Taxa": "",
      "Líquido": "",
    }));
    return [...payments, ...expenses];
  }

  reportCSVRows = function reportCSVRowsWithCashFlowStatus(type = selectedReportType()) {
    if (type !== "cashflow") return originalReportCSVRows(type);
    const status = selectedStatus();
    if (status === "paid") return paidCSVRows();
    if (status === "pending") return pendingCSVRows();
    return [...paidCSVRows(), ...pendingCSVRows()];
  };

  reportFilenamePrefix = function reportFilenamePrefixWithCashFlowStatus(type = selectedReportType()) {
    if (type !== "cashflow") return originalReportFilenamePrefix(type);
    const status = selectedStatus();
    if (status === "paid") return "fluxo-caixa-pagos";
    if (status === "pending") return "fluxo-caixa-pendentes";
    return "fluxo-caixa";
  };

  function mountFilter() {
    if (document.querySelector("#cashFlowExportStatusField")) return;
    const formatField = document.querySelector("#reportExportFormat")?.closest("label");
    const exportBox = document.querySelector("#reportType")?.closest(".report-export-box");
    if (!exportBox) return;
    const field = document.createElement("label");
    field.id = "cashFlowExportStatusField";
    field.className = "inline-field report-status-field is-hidden";
    field.innerHTML = `Situação do fluxo de caixa
      <select id="cashFlowExportStatus">
        <option value="all">Pagos e pendentes</option>
        <option value="pending">Apenas pendentes</option>
        <option value="paid">Apenas pagos</option>
      </select>`;
    if (formatField) formatField.insertAdjacentElement("beforebegin", field);
    else exportBox.appendChild(field);
    field.querySelector("select")?.addEventListener("change", () => {
      try { renderReports(); } catch {}
    });
  }

  function updateVisibility() {
    mountFilter();
    const field = document.querySelector("#cashFlowExportStatusField");
    if (!field) return;
    const visible = document.querySelector("#reportType")?.value === "cashflow";
    field.classList.toggle("is-hidden", !visible);
  }

  document.querySelector("#reportType")?.addEventListener("change", () => setTimeout(updateVisibility, 0));
  document.querySelector('.tab[data-view="reports"]')?.addEventListener("click", () => setTimeout(updateVisibility, 0));
  mountFilter();
  updateVisibility();
})();