// Relatório geral: exibe as atividades e valores preservados na própria mensalidade.
(() => {
  function normalizePair(item = {}) {
    return {
      name: String(item?.name || item?.activityName || "Atividade").trim() || "Atividade",
      value: Math.max(Number(item?.value ?? item?.amount ?? 0), 0),
    };
  }

  function namesFromText(text = "") {
    return String(text || "")
      .split(/\s*;\s*|\s*\|\s*/)
      .map((name) => name.trim())
      .filter(Boolean);
  }

  function reportActivityPairs(payment, student) {
    const paymentItems = Array.isArray(payment?.activityItems)
      ? payment.activityItems.map(normalizePair).filter((item) => item.name)
      : [];
    if (paymentItems.length) return paymentItems;

    const paymentNames = namesFromText(payment?.activities || "");
    if (paymentNames.length) {
      if (paymentNames.length === 1) {
        return [{ name: paymentNames[0], value: Number(payment?.amount || 0) }];
      }
      return paymentNames.map((name) => ({ name, value: 0 }));
    }

    // Compatibilidade com mensalidades antigas sem fotografia histórica.
    const items = student && typeof studentActivityItems === "function" ? studentActivityItems(student) : [];
    if (items.length) return items.map(normalizePair);

    const legacyNames = namesFromText(student?.activities || "");
    if (!legacyNames.length) return [];
    if (legacyNames.length === 1) {
      return [{ name: legacyNames[0], value: Number(payment?.amount || student?.monthlyValue || 0) }];
    }
    return legacyNames.map((name) => ({ name, value: 0 }));
  }

  function activityNamesHTML(payment, student) {
    const pairs = reportActivityPairs(payment, student);
    if (!pairs.length) return "-";
    return pairs.map((item) => escapeHTML(item.name)).join("<br>");
  }

  function activityValuesHTML(payment, student) {
    const pairs = reportActivityPairs(payment, student);
    if (!pairs.length) return "-";
    return pairs.map((item) => item.value > 0 ? brl(item.value) : "-").join("<br>");
  }

  function activityNamesText(payment, student) {
    const pairs = reportActivityPairs(payment, student);
    return pairs.length ? pairs.map((item) => item.name).join("; ") : "";
  }

  function activityValuesText(payment, student) {
    const pairs = reportActivityPairs(payment, student);
    return pairs.length ? pairs.map((item) => item.value > 0 ? brl(item.value) : "-").join("; ") : "";
  }

  completeReportHTMLContent = function completeReportHTMLContentWithActivityValues() {
    const summary = calculateSummary();
    const paymentsRows = summary.payments.length
      ? summary.payments
          .map((payment) => {
            const student = getStudent(payment.studentId);
            const status = paymentFinancialStatus(payment);
            return `
              <tr class="${status === "paid" ? "report-row-paid" : "report-row-pending"}">
                <td>${escapeHTML(student?.name || "Criança removida")}</td>
                <td>${escapeHTML(student?.guardian || "-")}</td>
                <td>${activityNamesHTML(payment, student)}</td>
                <td>${activityValuesHTML(payment, student)}</td>
                <td><span class="${status === "paid" ? "report-status-paid" : "report-status-pending"}">${financialStatusLabel(status)}</span></td>
                <td>${formatHours(calculateChildUsage(payment.studentId).usedHours)}</td>
                <td>${brl(payment.amount)}<small>Falta ${brl(paymentRemainingAmount(payment))}</small></td>
                <td>${paymentReceivedAmount(payment) > 0 ? brl(paymentNetAmount(payment)) : "-"}</td>
              </tr>`;
          })
          .join("")
      : `<tr><td colspan="8">Sem registros.</td></tr>`;

    const byCategory = summary.expenses.reduce((acc, expense) => {
      const category = expense.category || "Sem categoria";
      acc[category] = (acc[category] || 0) + Number(expense.amount || 0);
      return acc;
    }, {});

    const expenseRows = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([category, total]) => `<tr><td>${escapeHTML(category)}</td><td>${brl(total)}</td></tr>`)
      .join("") || `<tr><td colspan="2">Sem registros.</td></tr>`;

    return `
      <h1>Relatório completo mensal - ${escapeHTML(periodLabel())}</h1>
      <p>Arte de Aprender</p>
      ${reportPixPaymentHTML()}
      <table>
        <tr><th>Previsto</th><th>Recebido líquido</th><th>A receber</th><th>Despesas</th><th>Resultado</th></tr>
        <tr><td>${brl(summary.expected)}</td><td>${brl(summary.received)}</td><td>${brl(summary.pending)}</td><td>${brl(summary.expenseTotal)}</td><td>${brl(summary.result)}</td></tr>
      </table>
      <h2>Pagamentos por criança</h2>
      <table>
        <tr><th>Criança</th><th>Responsável</th><th>Atividade</th><th>Valor da atividade</th><th>Status</th><th>Horas utilizadas</th><th>Mensalidade</th><th>Creditado</th></tr>
        ${paymentsRows}
      </table>
      <h2>Despesas por categoria</h2>
      <table>
        <tr><th>Categoria</th><th>Total</th></tr>
        ${expenseRows}
      </table>
    `;
  };

  completeReportCSVRows = function completeReportCSVRowsWithActivityValues() {
    const summary = calculateSummary();
    const paymentRows = summary.payments.map((payment) => {
      const student = getStudent(payment.studentId);
      return {
        "Seção": "Pagamentos",
        "Descrição": student?.name || "Criança removida",
        "Detalhe": student?.guardian || "",
        "Atividade(s)": activityNamesText(payment, student),
        "Valor(es) da atividade": activityValuesText(payment, student),
        "Status": financialStatusLabel(paymentFinancialStatus(payment)),
        "Valor previsto": brl(payment.amount),
        "Recebido": brl(paymentReceivedAmount(payment)),
        "Saldo": brl(paymentRemainingAmount(payment)),
        "Líquido": paymentReceivedAmount(payment) > 0 ? brl(paymentNetAmount(payment)) : "",
      };
    });

    const expenseRows = summary.expenses.map((expense) => ({
      "Seção": "Despesas",
      "Descrição": expense.description || "",
      "Detalhe": expense.category || "",
      "Atividade(s)": "",
      "Valor(es) da atividade": "",
      "Status": expense.status === "paid" ? "Pago" : "Pendente",
      "Valor previsto": brl(expense.amount),
      "Recebido": "",
      "Saldo": "",
      "Líquido": "",
    }));

    return paymentRows.concat(expenseRows);
  };

  window.completeReportHTMLContent = completeReportHTMLContent;
  window.completeReportCSVRows = completeReportCSVRows;
  window.__reportActivityPairs = reportActivityPairs;
})();
