// Recibo simplificado: mostra somente o valor da mensalidade, sem taxas ou valor líquido.
(() => {
  try {
    openReceipt = function openReceiptMonthlyValueOnly(paymentId) {
      const payment = state.payments.find((item) => item.id === paymentId);
      if (!payment) return;

      const student = getStudent(payment.studentId);
      const logoUrl = new URL("logo-zebra.svg", window.location.href).href;
      const receiptNumber = payment.id.slice(0, 8).toUpperCase();
      const receipts = payment.receipts || [];
      const payerNames = [...new Set(receipts.map((receipt) => receipt.payer).filter(Boolean))];
      const methodNames = [...new Set(
        receipts
          .map((receipt) => paymentMethodLabel(receipt.method))
          .filter((label) => label !== "-"),
      )];
      const lastReceipt = receipts.at(-1);
      const paymentDate = lastReceipt?.date
        ? new Date(`${lastReceipt.date}T00:00:00`).toLocaleDateString("pt-BR")
        : new Date().toLocaleDateString("pt-BR");

      const receiptHTML = `
        <!doctype html>
        <html lang="pt-BR">
          <head>
            <meta charset="UTF-8" />
            <title>Recibo Arte de Aprender</title>
            <style>
              @page { size: 14cm 10cm; margin: 0; }
              * { box-sizing: border-box; }
              html, body {
                width: 14cm;
                height: 10cm;
                margin: 0;
                padding: 0;
                font-family: Arial, sans-serif;
                color: #000;
                background: #fff;
              }
              .receipt {
                width: 14cm;
                height: 10cm;
                margin: 0;
                background: #fff;
                border: 0.4mm solid #000;
                border-radius: 0;
                padding: 0.45cm 0.55cm;
                overflow: hidden;
              }
              .head {
                display: flex;
                justify-content: space-between;
                gap: 0.35cm;
                align-items: center;
                border-bottom: 0.25mm solid #000;
                padding-bottom: 0.22cm;
                margin-bottom: 0.22cm;
              }
              img { width: 2.2cm; max-height: 1.35cm; object-fit: contain; }
              h1 { margin: 0; font-size: 13pt; color: #000; line-height: 1.05; }
              .number { color: #000; font-weight: 700; font-size: 8pt; margin-top: 0.08cm; }
              .line {
                display: grid;
                grid-template-columns: 3.05cm 1fr;
                gap: 0.22cm;
                padding: 0.13cm 0;
                border-bottom: 0.15mm solid #000;
                line-height: 1.15;
              }
              .label { color: #000; font-weight: 700; font-size: 8pt; }
              .value { font-weight: 700; font-size: 8.5pt; }
              .amount { font-size: 13pt; color: #000; }
              p { margin: 0.35cm 0 0; color: #000; line-height: 1.3; font-size: 8pt; }
              .sign { margin-top: 0.72cm; text-align: center; font-size: 8pt; }
              .sign div { width: 5.5cm; max-width: 100%; margin: 0 auto 0.08cm; border-top: 0.2mm solid #000; }
              .actions {
                position: fixed;
                left: 0.25cm;
                top: 0.25cm;
                display: flex;
                gap: 0.15cm;
                z-index: 2;
              }
              button { border: 0; border-radius: 8px; padding: 8px 12px; font-weight: 700; cursor: pointer; background: #111827; color: #fff; }
              @media screen { body { background: #f3f4f6; padding-top: 1.15cm; } .receipt { margin: 0 auto; } }
              @media print { .actions { display: none; } body { background: #fff; padding: 0; } .receipt { border: 0.4mm solid #000; } }
            </style>
          </head>
          <body>
            <div class="actions"><button data-print-window>Imprimir</button></div>
            <main class="receipt">
              <div class="head">
                <img src="${logoUrl}" alt="Arte de Aprender" />
                <div>
                  <h1>Recibo de pagamento</h1>
                  <div class="number">Recibo nº ${escapeHTML(receiptNumber)}</div>
                </div>
              </div>
              <div class="line"><span class="label">Recebemos de</span><span class="value">${escapeHTML(payerNames.join(", ") || student?.guardian || "Responsável")}</span></div>
              <div class="line"><span class="label">Referente à criança</span><span class="value">${escapeHTML(student?.name || "-")}</span></div>
              <div class="line"><span class="label">Período</span><span class="value">${escapeHTML(periodLabel(payment.period))}</span></div>
              <div class="line"><span class="label">Forma de pagamento</span><span class="value">${escapeHTML(methodNames.join(", ") || paymentMethodLabel(payment.method))}</span></div>
              <div class="line"><span class="label">Data do pagamento</span><span class="value">${paymentDate}</span></div>
              <div class="line"><span class="label">Valor da mensalidade</span><span class="value amount">${brl(payment.amount)}</span></div>
              <p>Declaramos o recebimento do valor acima referente à mensalidade/atividade contratada no Arte de Aprender.</p>
              <div class="sign"><div></div><strong>Arte de Aprender</strong></div>
            </main>
          </body>
        </html>
      `;

      const popup = window.open("", "_blank", "width=620,height=480");
      if (!popup) {
        showToast("O navegador bloqueou a janela do recibo. Libere pop-ups para imprimir.");
        return;
      }
      popup.document.open();
      popup.document.write(receiptHTML);
      popup.document.close(),popup.document.querySelector("[data-print-window]")?.addEventListener("click",()=>popup.print());
    };

    window.openReceipt = openReceipt;
  } catch (error) {
    console.error("Não foi possível aplicar o recibo simplificado.", error);
  }
})();

// Fallback para uso isolado. No app principal, extra-event-attendance-id-fix.js gerencia
// a ordem de todos os módulos e esta fila não é iniciada.
(() => {
  if (window.__saberOrderedModulesManaged) return;

  const modules = [
    ["zebraLogoLabelFix", "zebra-logo-label-fix.js?v=2"],
    ["generalReportActivityValueFix", "general-report-activity-value-fix.js?v=2"],
    ["monthlyPaymentAmountFix", "monthly-payment-amount-fix.js?v=2"],
  ];

  function attrName(key) {
    return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  }

  function load(index = 0) {
    if (index >= modules.length) return;
    const [key, src] = modules[index];
    const existing = document.querySelector(`script[data-${attrName(key)}]`);
    if (existing) {
      if (existing.dataset.loaded === "true") load(index + 1);
      else {
        existing.addEventListener("load", () => load(index + 1), { once: true });
        existing.addEventListener("error", () => load(index + 1), { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.dataset[key] = "true";
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      load(index + 1);
    }, { once: true });
    script.addEventListener("error", () => {
      console.error(`Falha ao carregar módulo: ${src}`);
      load(index + 1);
    }, { once: true });
    document.body.appendChild(script);
  }

  load();
})();
