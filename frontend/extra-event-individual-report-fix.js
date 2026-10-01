// Inclui participantes externos de eventos extras no Relatório Individual.
(() => {
  const EXTRA_PREFIX = "extra-participant:";

  const originalChildReportHTMLContent = childReportHTMLContent;
  const originalExportChildReportPDF = exportChildReportPDF;
  const originalExportChildReportExcel = exportChildReportExcel;

  function normalizedId(value = "") {
    return String(value ?? "").trim();
  }

  function participantIdFromReportId(reportId = "") {
    const value = normalizedId(reportId);
    return value.startsWith(EXTRA_PREFIX) ? value.slice(EXTRA_PREFIX.length) : "";
  }

  function eventForParticipant(participant = {}) {
    const eventId = normalizedId(participant.eventId);
    return (state.extraEvents || []).find((event) => normalizedId(event.id) === eventId) || null;
  }

  function externalEventParticipants() {
    return (state.extraParticipants || [])
      .filter((participant) => {
        const linkedId = normalizedId(participant.linkedStudentId);
        return !linkedId || !state.students.some((student) => normalizedId(student.id) === linkedId);
      })
      .map((participant) => ({ participant, event: eventForParticipant(participant) }))
      .filter(({ event }) => !!event)
      .sort((a, b) => {
        const eventCompare = String(a.event?.name || "Evento extra").localeCompare(String(b.event?.name || "Evento extra"), "pt-BR", { sensitivity: "base" });
        if (eventCompare !== 0) return eventCompare;
        return String(a.participant?.name || "").localeCompare(String(b.participant?.name || ""), "pt-BR", { sensitivity: "base" });
      });
  }

  function individualEntity(reportId = "") {
    const id = normalizedId(reportId);
    if (!id.startsWith(EXTRA_PREFIX)) {
      const student = getStudent(id);
      return student ? { type: "student", id, student } : null;
    }

    const participantId = participantIdFromReportId(id);
    const participant = (state.extraParticipants || []).find((item) => normalizedId(item.id) === participantId);
    if (!participant) return null;
    const event = eventForParticipant(participant);
    return { type: "extra", id, participant, event };
  }

  function reportEntries(reportId = "") {
    return attendanceEntriesForStudent(reportId);
  }

  function extraUsage(entity) {
    const entries = reportEntries(entity.id);
    return {
      entries,
      usedHours: entries.reduce((sum, entry) => sum + Number(entry.hours || 0), 0),
      presentDays: entries.filter((entry) => entry.status === "present").length,
      absentDays: entries.filter((entry) => entry.status === "absent").length,
      excusedDays: entries.filter((entry) => entry.status === "excused").length,
    };
  }

  function participantFinance(participant = {}) {
    const amount = Number(participant.amount || 0);
    const receipts = participant.receipts || [];
    const received = receiptGrossTotal(receipts);
    const remaining = receiptRemaining(amount, receipts);
    const status = receiptFinancialStatus(amount, receipts);
    return { amount, received, remaining, status };
  }

  function eventPeriodText(event = {}) {
    if (!event?.startDate) return "-";
    const end = event.endDate || event.startDate;
    return end && end !== event.startDate
      ? `${formatDateBR(event.startDate)} a ${formatDateBR(end)}`
      : formatDateBR(event.startDate);
  }

  function detailRows(entries = []) {
    return entries.length
      ? entries.map((entry) => `
          <tr>
            <td>${formatDateBR(entry.date)}</td>
            <td>${escapeHTML(attendanceStatusLabel(entry.status))}</td>
            <td>${escapeHTML(entry.checkIn || "-")}</td>
            <td>${escapeHTML(entry.checkOut || "-")}</td>
            <td>${formatHours(entry.hours)}</td>
            <td>${escapeHTML(entry.note || "-")}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="6">Nenhuma presença registrada neste mês.</td></tr>`;
  }

  function renderSelect(select) {
    const previous = select.dataset.selectedStudent || select.value || "";
    const students = state.students.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR", { sensitivity: "base" }));
    const extras = externalEventParticipants();

    const studentOptions = students
      .map((student) => `<option value="${escapeAttr(student.id)}">${escapeHTML(student.name || "Criança sem nome")}</option>`)
      .join("");

    const extraOptions = extras
      .map(({ participant, event }) => {
        const id = extraParticipantAttendanceId(participant.id);
        return `<option value="${escapeAttr(id)}">${escapeHTML(participant.name || "Participante sem nome")} · ${escapeHTML(event?.name || "Evento extra")}</option>`;
      })
      .join("");

    select.innerHTML = `
      ${studentOptions ? `<optgroup label="Crianças cadastradas">${studentOptions}</optgroup>` : ""}
      ${extraOptions ? `<optgroup label="Eventos extras">${extraOptions}</optgroup>` : ""}
    `;

    const validValues = new Set([
      ...students.map((student) => normalizedId(student.id)),
      ...extras.map(({ participant }) => extraParticipantAttendanceId(participant.id)),
    ]);
    const selected = validValues.has(previous)
      ? previous
      : students[0]?.id || (extras[0] ? extraParticipantAttendanceId(extras[0].participant.id) : "");

    select.value = selected;
    select.dataset.selectedStudent = selected;
    return selected;
  }

  selectedIndividualStudentId = function selectedIndividualStudentIdWithEvents() {
    const select = document.querySelector("#individualStudentSelect");
    if (select?.value) return select.value;
    const firstStudent = state.students.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR", { sensitivity: "base" }))[0];
    if (firstStudent) return firstStudent.id;
    const firstExtra = externalEventParticipants()[0];
    return firstExtra ? extraParticipantAttendanceId(firstExtra.participant.id) : "";
  };

  renderIndividualReport = function renderIndividualReportWithEvents() {
    const select = document.querySelector("#individualStudentSelect");
    const summary = document.querySelector("#childReportSummary");
    const table = document.querySelector("#childReportTable");
    if (!select || !summary || !table) return;

    const reportId = renderSelect(select);
    const entity = individualEntity(reportId);
    if (!entity) {
      summary.innerHTML = `<div class="report-card"><span>Relatório individual</span><strong>Nenhuma criança selecionada</strong></div>`;
      table.innerHTML = `<tr><td colspan="6">Nenhum registro disponível.</td></tr>`;
      return;
    }

    if (entity.type === "student") {
      const usage = calculateChildUsage(entity.id);
      const payment = currentPayments().find((item) => normalizedId(item.studentId) === normalizedId(entity.id));
      summary.innerHTML = `
        <div class="report-card"><span>Criança</span><strong>${escapeHTML(entity.student.name || "-")}</strong></div>
        <div class="report-card"><span>Horas contratadas</span><strong>${formatHours(usage.contractedHours)}</strong></div>
        <div class="report-card"><span>Horas utilizadas</span><strong>${formatHours(usage.usedHours)}</strong></div>
        <div class="report-card"><span>Saldo de horas</span><strong>${formatHours(usage.balanceHours)}</strong></div>
        <div class="report-card good"><span>Presenças</span><strong>${usage.presentDays}</strong></div>
        <div class="report-card warn"><span>Faltas</span><strong>${usage.absentDays}</strong></div>
        <div class="report-card"><span>Financeiro</span><strong>${payment ? escapeHTML(financialStatusLabel(paymentFinancialStatus(payment))) : "Não gerado"}</strong></div>
      `;
      table.innerHTML = detailRows(usage.entries);
      return;
    }

    const usage = extraUsage(entity);
    const finance = participantFinance(entity.participant);
    summary.innerHTML = `
      <div class="report-card"><span>Participante</span><strong>${escapeHTML(entity.participant.name || "-")}</strong></div>
      <div class="report-card"><span>Evento extra</span><strong>${escapeHTML(entity.event?.name || "Evento extra")}</strong></div>
      <div class="report-card"><span>Período do evento</span><strong>${escapeHTML(eventPeriodText(entity.event))}</strong></div>
      <div class="report-card"><span>Horas registradas</span><strong>${formatHours(usage.usedHours)}</strong></div>
      <div class="report-card good"><span>Presenças</span><strong>${usage.presentDays}</strong></div>
      <div class="report-card warn"><span>Faltas</span><strong>${usage.absentDays}</strong></div>
      <div class="report-card"><span>Valor do evento</span><strong>${brl(finance.amount)}</strong></div>
      <div class="report-card"><span>Status financeiro</span><strong>${escapeHTML(financialStatusLabel(finance.status))}</strong></div>
    `;
    table.innerHTML = detailRows(usage.entries);
  };

  childReportHTMLContent = function childReportHTMLContentWithEvents(reportId = selectedIndividualStudentId()) {
    const entity = individualEntity(reportId);
    if (!entity) return `<h1>Relatório individual</h1><p>Nenhuma criança selecionada.</p>`;
    if (entity.type === "student") return originalChildReportHTMLContent(reportId);

    const usage = extraUsage(entity);
    const finance = participantFinance(entity.participant);
    const rows = detailRows(usage.entries);
    const methods = [...new Set((entity.participant.receipts || [])
      .map((receipt) => participantPaymentMethodLabel(receipt.method))
      .filter((label) => label && label !== "-"))].join(", ") || participantPaymentMethodLabel(entity.participant.paymentMethod);

    return `${reportZebraStatusStyle()}
      <h1>Relatório individual - ${escapeHTML(entity.participant.name || "Participante")}</h1>
      <p><strong>Período do relatório:</strong> ${escapeHTML(periodLabel())}</p>
      <p><strong>Evento extra:</strong> ${escapeHTML(entity.event?.name || "Evento extra")}</p>
      <p><strong>Período do evento:</strong> ${escapeHTML(eventPeriodText(entity.event))}</p>
      <p><strong>Contato:</strong> ${escapeHTML(entity.participant.phone || "-")}</p>
      <table>
        <tr><th>Horas registradas</th><th>Dias presentes</th><th>Faltas</th><th>Valor do evento</th><th>Recebido</th><th>Saldo</th><th>Forma</th><th>Status financeiro</th></tr>
        <tr>
          <td>${formatHours(usage.usedHours)}</td>
          <td>${usage.presentDays}</td>
          <td>${usage.absentDays}</td>
          <td>${brl(finance.amount)}</td>
          <td>${brl(finance.received)}</td>
          <td>${brl(finance.remaining)}</td>
          <td>${escapeHTML(methods || "-")}</td>
          <td>${escapeHTML(financialStatusLabel(finance.status))}</td>
        </tr>
      </table>
      <h2>Detalhamento diário</h2>
      <table>
        <tr><th>Data</th><th>Status</th><th>Entrada</th><th>Saída</th><th>Horas usadas</th><th>Observação</th></tr>
        ${rows}
      </table>
    `;
  };

  exportChildReportPDF = function exportChildReportPDFWithEvents() {
    const reportId = selectedIndividualStudentId();
    const entity = individualEntity(reportId);
    if (!entity || entity.type === "student") {
      originalExportChildReportPDF();
      return;
    }

    const name = entity.participant.name || "participante";
    const title = `Relatório individual - ${name} - ${periodLabel()}`;
    const pageHTML = buildPrintableReportPage(title, childReportHTMLContent(reportId));
    const popup = window.open("", "_blank", "width=980,height=760");
    if (!popup) {
      downloadHTMLFile(`relatorio-${safeFileName(name)}-${selectedPeriodKey()}.html`, pageHTML);
      showToast("O pop-up foi bloqueado. Baixei o relatório em HTML; abra o arquivo e use Imprimir > Salvar em PDF.");
      return;
    }
    popup.document.open();
    popup.document.write(pageHTML);
    popup.document.close();
  };

  exportChildReportExcel = function exportChildReportExcelWithEvents() {
    const reportId = selectedIndividualStudentId();
    const entity = individualEntity(reportId);
    if (!entity || entity.type === "student") {
      originalExportChildReportExcel();
      return;
    }

    const name = entity.participant.name || "participante";
    const html = `<!doctype html><html><head><meta charset="UTF-8">${exportedReportBlackStyle()}</head><body>${reportHeaderHTML()}${childReportHTMLContent(reportId)}</body></html>`;
    downloadHTMLFile(`relatorio-${safeFileName(name)}-${selectedPeriodKey()}.xls`, html, "application/vnd.ms-excel;charset=utf-8");
    showToast("Relatório individual do participante exportado para Excel.");
  };

  try {
    window.selectedIndividualStudentId = selectedIndividualStudentId;
    window.renderIndividualReport = renderIndividualReport;
    window.childReportHTMLContent = childReportHTMLContent;
    window.exportChildReportPDF = exportChildReportPDF;
    window.exportChildReportExcel = exportChildReportExcel;
  } catch (error) {
    console.warn("Não foi possível publicar as funções do relatório individual com eventos.", error);
  }

  if (document.querySelector("#individualStudentSelect")) renderIndividualReport();
})();
