// Relatórios individuais de Financeiro > Locações e repasses.
// Mantém o modelo de dados atual e cria visões imprimíveis por cadastro.
(() => {
  if (window.__saberRentalIndividualReportsLoaded) return;
  window.__saberRentalIndividualReportsLoaded = true;

  function html(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function money(value) {
    return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function currentPeriod() {
    try { return selectedPeriodKey(); } catch {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }
  }

  function periodName(value = currentPeriod()) {
    try { return periodLabel(value); } catch {
      const [year, month] = String(value || "").split("-");
      return `${month || "--"}/${year || "----"}`;
    }
  }

  function dateBR(value = "") {
    if (!value) return "-";
    try {
      const [year, month, day] = String(value).slice(0, 10).split("-");
      if (year && month && day) return `${day}/${month}/${year}`;
    } catch {}
    return String(value);
  }

  function rental() {
    try {
      return state?.rentalManagement && typeof state.rentalManagement === "object"
        ? state.rentalManagement
        : {};
    } catch {
      return {};
    }
  }

  function bankAccountName(accountId) {
    if (!accountId) return "-";
    try {
      const account = typeof getBankAccount === "function"
        ? getBankAccount(accountId)
        : (state?.bankAccounts || []).find((item) => String(item.id) === String(accountId));
      return account?.name || account?.bank || "Conta cadastrada";
    } catch {
      return "Conta cadastrada";
    }
  }

  function selectedPsychActivityName() {
    const config = rental().psychopedagogy || {};
    try {
      const activity = (state?.activityCatalog || []).find((item) => String(item.id) === String(config.activityId));
      return activity?.name || "Psicopedagogia";
    } catch {
      return "Psicopedagogia";
    }
  }

  function showMessage(message) {
    try {
      if (typeof showToast === "function") return showToast(message);
    } catch {}
    console.info(message);
  }

  function cleanTableFromBody(bodySelector) {
    const body = document.querySelector(bodySelector);
    const table = body?.closest("table");
    if (!table) return '<div class="empty-report">Nenhum dado disponível.</div>';
    const clone = table.cloneNode(true);
    clone.querySelectorAll("button,input,select,textarea").forEach((item) => item.remove());
    clone.querySelectorAll("tr").forEach((row) => {
      const cells = row.querySelectorAll("th,td");
      if (cells.length) cells[cells.length - 1].remove();
    });
    return clone.outerHTML;
  }

  function cloneBlock(selector, emptyText = "Nenhum dado disponível.") {
    const source = document.querySelector(selector);
    if (!source || !String(source.textContent || "").trim()) {
      return `<div class="empty-report">${html(emptyText)}</div>`;
    }
    const clone = source.cloneNode(true);
    clone.querySelectorAll("button,input,select,textarea").forEach((item) => item.remove());
    return clone.outerHTML;
  }

  function infoGrid(items) {
    return `<div class="info-grid">${items.map(([label, value, wide = false]) => `
      <div class="info-item${wide ? " wide" : ""}"><span>${html(label)}</span><strong>${html(value || "-")}</strong></div>`).join("")}</div>`;
  }

  function historyTable(records, kind) {
    if (!records.length) return '<div class="empty-report">Nenhum lançamento registrado.</div>';
    const rows = records.map((item) => `
      <tr>
        <td>${html(dateBR(item.date || item.paidDate || item.dueDate || ""))}</td>
        <td>${html(periodName(item.period || ""))}</td>
        <td><strong>${money(item.amount)}</strong></td>
        <td>${html(bankAccountName(item.bankAccountId || ""))}</td>
        <td>${html(item.note || "-")}</td>
      </tr>`).join("");
    return `<table><thead><tr><th>Data</th><th>Competência</th><th>${kind === "clinic" ? "Recebido" : "Repasse"}</th><th>Conta</th><th>Observação</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function materialsTable(items) {
    if (!items.length) return '<div class="empty-report">Nenhum material ou equipamento registrado para esta locação.</div>';
    const rows = items
      .slice()
      .sort((a, b) => String(a.description || "").localeCompare(String(b.description || ""), "pt-BR", { sensitivity: "base" }))
      .map((item) => `
        <tr>
          <td>${html(dateBR(item.date || ""))}</td>
          <td><strong>${html(item.description || "Item")}</strong></td>
          <td>${item.purchasedBy === "clinic" ? "Clínica / locatário" : "Arte de Aprender"}</td>
          <td>${money(item.amount)}</td>
          <td>${html(item.note || "-")}</td>
        </tr>`).join("");
    return `<table><thead><tr><th>Data</th><th>Material / equipamento</th><th>Adquirido por</th><th>Valor</th><th>Observação</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function reportShell(title, subtitle, body) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><style>
      :root{font-family:Arial,Helvetica,sans-serif;color:#302536;background:#fff}
      *{box-sizing:border-box}body{margin:0;padding:30px;background:#fff;color:#302536}
      .toolbar{display:flex;justify-content:flex-end;gap:8px;margin-bottom:18px}.toolbar button{border:0;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}.toolbar .print{background:#713978;color:#fff}.toolbar .close{background:#eee7f0;color:#49364c}
      .report-head{border-bottom:3px solid #713978;padding-bottom:14px;margin-bottom:20px}.report-head h1{margin:0;color:#713978;font-size:25px}.report-head p{margin:6px 0 0;color:#6d6470;font-size:13px}
      h2{font-size:17px;margin:24px 0 10px;color:#5c3161}h3{font-size:14px;margin:18px 0 8px;color:#5c3161}
      .info-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0 18px}.info-item{border:1px solid #e4dbe6;border-radius:11px;padding:10px 12px;background:#fbf8fc}.info-item.wide{grid-column:span 4}.info-item span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#776d79}.info-item strong{display:block;margin-top:4px;font-size:13px;color:#302536;white-space:pre-wrap}
      .rental-summary-grid,.equipment-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:10px 0 16px}.rental-stat,.equipment-summary>*{border:1px solid #e4dbe6;border-radius:11px;padding:10px 12px;background:#fbf8fc}.rental-stat span,.equipment-summary span{display:block;font-size:10px;color:#776d79}.rental-stat strong,.equipment-summary strong{display:block;margin-top:4px;font-size:15px;color:#302536}
      .clinic-outstanding-list{display:grid;gap:7px;margin:8px 0 16px}.clinic-outstanding-item,.clinic-outstanding-row{border:1px solid #eadfea;border-radius:10px;padding:9px 11px;background:#fffaf4}
      table{width:100%;border-collapse:collapse;margin:8px 0 18px;font-size:11px}th,td{border:1px solid #dfd7e1;padding:7px 8px;text-align:left;vertical-align:top}th{background:#f2e9f4;color:#543258;font-size:10px;text-transform:uppercase}tbody tr:nth-child(even){background:#fcfafc}
      .empty-report{padding:12px;border:1px dashed #d8cbdc;border-radius:10px;color:#746b77;background:#fbf9fb;font-size:12px}
      .report-footer{margin-top:28px;padding-top:10px;border-top:1px solid #e4dbe6;color:#817984;font-size:10px}
      @media(max-width:800px){body{padding:16px}.info-grid,.rental-summary-grid,.equipment-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.info-item.wide{grid-column:span 2}table{font-size:10px}}
      @media print{body{padding:0}.toolbar{display:none!important}.report-head{margin-top:0}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}.info-grid,.rental-summary-grid,.equipment-summary{break-inside:avoid}@page{size:A4 landscape;margin:10mm}}
    </style></head><body><div class="toolbar"><button class="close" onclick="window.close()">Fechar</button><button class="print" onclick="window.print()">Imprimir / salvar em PDF</button></div><header class="report-head"><h1>${html(title)}</h1><p>${html(subtitle)}</p></header>${body}<footer class="report-footer">Relatório gerado pelo Arte de Aprender ERP em ${html(new Date().toLocaleString("pt-BR"))}.</footer></body></html>`;
  }

  function openReport(title, subtitle, body) {
    const win = window.open("", "_blank", "width=1180,height=820");
    if (!win) {
      showMessage("O navegador bloqueou a janela do relatório. Libere pop-ups para gerar o relatório.");
      return;
    }
    win.document.open();
    win.document.write(reportShell(title, subtitle, body));
    win.document.close();
    win.focus();
  }

  function psychReport() {
    try { window.renderRentalsFinance?.(); } catch {}
    const data = rental();
    const config = data.psychopedagogy || {};
    const reportPeriod = currentPeriod();
    const repasses = (data.repasses || []).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const body = `
      ${infoGrid([
        ["Profissional", config.professionalName || "Psicopedagoga"],
        ["Atividade vinculada", selectedPsychActivityName()],
        ["Percentual de repasse", `${Number(config.repassPercent ?? 60).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`],
        ["Período em análise", periodName(reportPeriod)],
      ])}
      <h2>Resumo do período</h2>
      ${cloneBlock("#psychRentalSummary", "Sem resumo disponível para o período.")}
      <h2>Crianças vinculadas</h2>
      ${cleanTableFromBody("#psychStudentsTable")}
      <h2>Histórico de repasses da profissional</h2>
      ${historyTable(repasses, "psych")}`;
    openReport(
      `Relatório de repasses · ${config.professionalName || "Psicopedagoga"}`,
      `Psicopedagogia · ${periodName(reportPeriod)}`,
      body,
    );
  }

  function clinicReport() {
    try { window.renderRentalsFinance?.(); } catch {}
    const data = rental();
    const config = data.clinic || {};
    const reportPeriod = currentPeriod();
    const receipts = (data.clinicReceipts || []).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const materials = (data.equipment || []).slice();
    const body = `
      ${infoGrid([
        ["Locatário / clínica", config.tenantName || "Clínica"],
        ["Sala / espaço", config.roomName || "Sala"],
        ["Valor mensal", money(config.monthlyRent || 0)],
        ["Vencimento", config.dueDay ? `Dia ${config.dueDay}` : "-"],
        ["Início da locação", dateBR(config.startDate || "")],
        ["Período em análise", periodName(reportPeriod)],
        ["Observações do cadastro", config.notes || "-", true],
      ])}
      <h2>Resumo financeiro do período</h2>
      ${cloneBlock("#clinicRentalSummary", "Sem resumo financeiro disponível para o período.")}
      <h2>Pendências da locação</h2>
      ${cloneBlock("#clinicOutstandingList", "Nenhuma pendência registrada.")}
      <h2>Histórico de recebimentos da sublocação</h2>
      ${historyTable(receipts, "clinic")}
      <h2>Materiais e equipamentos vinculados à sala</h2>
      ${cloneBlock("#clinicEquipmentSummary", "Sem resumo patrimonial disponível.")}
      ${materialsTable(materials)}`;
    openReport(
      `Relatório de sublocação · ${config.roomName || "Sala"}`,
      `${config.tenantName || "Clínica"} · ${periodName(reportPeriod)}`,
      body,
    );
  }

  function injectStyles() {
    if (document.querySelector("#rentalIndividualReportStyles")) return;
    const style = document.createElement("style");
    style.id = "rentalIndividualReportStyles";
    style.textContent = `
      .rental-individual-report-btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:8px 12px;border-radius:12px;border:1px solid rgba(113,57,120,.20)!important;background:linear-gradient(135deg,#815087,#65386b)!important;color:#fff!important;font-weight:800;font-size:12px;box-shadow:0 7px 16px rgba(80,45,86,.16)}
      .rental-individual-report-btn:hover{filter:brightness(1.04)}
      .rental-report-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
      @media(max-width:720px){.rental-report-head-actions{width:100%;justify-content:flex-start}.rental-individual-report-btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function appendReportButton(cardSelector, buttonId, label, action) {
    const card = document.querySelector(cardSelector);
    const head = card?.querySelector(":scope > .panel-head");
    if (!card || !head || document.querySelector(`#${buttonId}`)) return false;

    let actions = head.querySelector(".rental-report-head-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "rental-report-head-actions";
      const badge = head.querySelector(":scope > .rental-badge");
      if (badge) actions.appendChild(badge);
      head.appendChild(actions);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.id = buttonId;
    button.className = "rental-individual-report-btn";
    button.textContent = label;
    button.addEventListener("click", action);
    actions.appendChild(button);
    return true;
  }

  function rebrandMaterials() {
    const box = document.querySelector(".rental-clinic-card .equipment-box");
    if (!box) return;
    const heading = box.querySelector("h3");
    const subtitle = box.querySelector(".panel-head span");
    const input = box.querySelector("#clinicEquipmentDescription");
    const label = input?.closest("label");
    const headingText = "Materiais e equipamentos da parceria";
    const subtitleText = "Registre materiais, móveis e equipamentos vinculados à sala e quem realizou cada compra.";
    const labelText = "Material / equipamento / item";
    const placeholder = "Ex.: material pedagógico, maca, ar-condicionado, armário...";
    if (heading && heading.textContent !== headingText) heading.textContent = headingText;
    if (subtitle && subtitle.textContent !== subtitleText) subtitle.textContent = subtitleText;
    if (label?.firstChild?.nodeType === Node.TEXT_NODE && String(label.firstChild.textContent || "").trim() !== labelText) {
      label.firstChild.textContent = labelText;
    }
    if (input && input.placeholder !== placeholder) input.placeholder = placeholder;
  }

  function mount() {
    injectStyles();
    rebrandMaterials();
    const psych = appendReportButton(
      ".rental-psych-card",
      "psychIndividualReport",
      "Relatório da Psicopedagogia",
      psychReport,
    );
    const clinic = appendReportButton(
      ".rental-clinic-card",
      "clinicIndividualReport",
      "Relatório da sublocação",
      clinicReport,
    );
    return psych || clinic || (document.querySelector("#psychIndividualReport") && document.querySelector("#clinicIndividualReport"));
  }

  mount();
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    mount();
    if ((document.querySelector("#psychIndividualReport") && document.querySelector("#clinicIndividualReport")) || attempts >= 40) {
      window.clearInterval(timer);
    }
  }, 500);

  const observer = new MutationObserver(() => {
    if (!document.querySelector("#psychIndividualReport") || !document.querySelector("#clinicIndividualReport")) mount();
    rebrandMaterials();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 30000);

  window.smgRentalReports = {
    psychopedagogy: psychReport,
    clinicRental: clinicReport,
  };
})();
