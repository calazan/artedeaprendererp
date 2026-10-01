// Hotfix: logo monocromática Arte de Aprender nas etiquetas Zebra e no arquivo ZPL.
// Exibe nome da criança, mês pago e valor.
(() => {
  const logoUrl = new URL("logo-zebra.svg", window.location.href).href;
  const ZEBRA_LOGO_GFA = "^GFA,1358,1358,14,000000000C0000000000000000000000000C0CE00F000000000000000000007C79E70F80000000000000000000FE79870F8700000000000000000CFF938F9F8700000000000000001C7F878F9F0400000000000000007CFF03023B6C000000000000000070FE78781F5CF00000000000000070FE7878CE0DF000000000000000020C6CD9E063E000000000000006C1802DDBE7E7C00000000000000FC0807DF76FE7C000000000000007CF287037E7E7EC00000000000007DBFD6007E3E3FC000000000000039BBD0206E7E3F8000000000000000FB5079064C1F60000000000000D8C1D8F9008100F0000000000000F8FFC879718821F8000000000000F07F0C7BFB098198000000000001F3060603DB07C980000000000001F180F303C627E1E000000000000180E8FB92F60FE1F0000000000000067C59D6F607EC600000000000000F1C40F664D7E000000000000001EFCCE07C0D87C1E0000000000001E7EDEF3C8F0731E0000000000003E7E6CFBCEF0F01E0000000000000E7220FBDEE4711C000000000000087030F1F9CE274C000000000000012318F9D1DF0E7C0000000000000183CCF9C19B1C7C00000000000001C3CF61C39F1F1000000000000001E14381C79F3C0000000000000000E30FF1EFC2F06000000000000000F70FFCEFE1C5F00000000000000073003EFFFF8CF80000000000000078080FFFFE08F000000000000000384427FFFCC0200000000000000038C433FFFFFC000000000000000011FEE3FDFFE00000000000000000003FC1F9FBE00000000000000000000381FFB7800000000000000000000001FFA5200000000000000000000001FF98600000000000000000000001FBD8400000000000000000000001F87C400000000000000000000001F8FEC00000000000000000000001F8FFC00000000000000000000001F9FF800000000000000000000001F9FF800000000000000000000001F9FF800000000000000000000001FCFE000000000000000000000003FCFE000000000000000000000003FCFE000000000000000000000003FC7E000000000000000000000007FE7C00000000000000000000000FFF6E0000000000000000000007FFFFFE000000000000000000003FFFFFFFE000000000000000000FFFFF9FFFFF800000000000001FFFFFFF0FFFFFFF800003C000001FFFF81F8FC1FFFF800007C000001FFF800FDF001FFF800007C000001FFFFFFFFFFFFFFF800007C000000FFFFFFFFFFFFFFF800007C0000000000000F0000000000007C00007F803C007FC03C00FF0000FC0001FFC07E01FFF0FFC3FF8000FC0003FFE0FF03FFF1FFE37FE000FC0005FFE0FF037FF9FFF6FFE000FC000FFFE1FF82F9F97FF7FFF0007C000BFFC17F82F9FBFFE5F3F000FFFFFBF1837FC6F1FBF8C5F1F03FFFFFFDF003FFC6F3FBF805F1F1FFFFFFE5F802FFC7FFF2FFCFF3F7FFFFFFC3FF07EFE7FFE2FFCDFFE7FFFFFC01FF85E7E7FFC2FFCFFFC3FFFF00007FC5E7E7F3F3FFCFFF8000FC00001FCFE7F7F1F3FF8FFF8000FC0003CFEFFFF7F1FBF80DFFC000FC0007FFEBFFF7F1FBF80FFFE000FC000FFFCFFFF7F1FBFFCFFFF000FC000FFFDFFFFBFBFBFFEFF7F800FC000FFFDFC3FBFFF9FFF7F7F8007C000FFF9F83FBFFF1FFE7F3F8007C0007FF0F81FBFFE0FFE7E1F0007C0001FC0780F1FF807FC3C000007C000000000000180000000000007C000000000000200000000600003C000000000000203000000600003C0000E739E73C2F3B9EF73EF000180001BD6D3D642DB6D2CDA69800000001F7473C642CB7F2C8A79800000001A96DBD6C2CB696CDB4D800000000EF79F73C2C9B9EC79C70000000000040030000001E000000000000000040070000001C0000000000000";

  function zebraLabelData(payment) {
    const student = getStudent(payment.studentId);
    return {
      childName: student?.name || "Criança",
      month: periodLabel(payment.period || selectedPeriodKey()),
      amount: brl(paymentReceivedAmount(payment)),
    };
  }

  function zebraLogoLabelHTML(payment) {
    const settings = labelSettings();
    const data = zebraLabelData(payment);
    return `
      <!doctype html>
      <html lang="pt-BR">
        <head>
          <meta charset="UTF-8" />
          <title>Etiqueta mensalidade paga</title>
          <style>
            @page { size: ${settings.width}${settings.unit} ${settings.height}${settings.unit}; margin: 0; }
            * { box-sizing: border-box; }
            html, body {
              width: ${settings.width}${settings.unit};
              height: ${settings.height}${settings.unit};
              margin: 0;
              padding: 0;
              background: #fff;
              font-family: Arial, Helvetica, sans-serif;
              color: #000;
            }
            .label {
              width: 100%;
              height: 100%;
              padding: 1.4mm;
              display: grid;
              grid-template-columns: 38% 62%;
              gap: 1.4mm;
              align-items: stretch;
              overflow: hidden;
            }
            .brand {
              min-width: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              border-right: 0.25mm solid #000;
              padding-right: 1.2mm;
            }
            .brand img {
              display: block;
              width: 100%;
              height: 100%;
              max-width: 100%;
              max-height: 100%;
              object-fit: contain;
              filter: grayscale(1) contrast(2);
            }
            .details {
              min-width: 0;
              display: grid;
              grid-template-rows: repeat(3, 1fr);
              align-items: stretch;
            }
            .line {
              min-width: 0;
              display: flex;
              flex-direction: column;
              justify-content: center;
              border-bottom: 0.22mm solid #000;
              line-height: 1;
              padding: 0.35mm 0;
            }
            .line:last-child { border-bottom: 0; }
            .label-text {
              font-size: 6.1pt;
              font-weight: 900;
              letter-spacing: .02em;
              white-space: nowrap;
            }
            .value {
              margin-top: 0.3mm;
              font-size: 8.1pt;
              font-weight: 900;
              line-height: 1.02;
              overflow-wrap: anywhere;
            }
            .name-value { font-size: 7.4pt; }
            .actions {
              position: fixed;
              left: 10px;
              top: 10px;
              display: flex;
              gap: 8px;
              z-index: 10;
            }
            .actions button {
              border: 0;
              border-radius: 10px;
              padding: 10px 14px;
              background: #111827;
              color: #fff;
              font-weight: 800;
              cursor: pointer;
            }
            @media screen { body { outline: 1px solid #ddd; } }
            @media print { .actions { display: none; } }
          </style>
        </head>
        <body>
          <div class="actions"><button data-print-window>Imprimir etiqueta</button></div>
          <main class="label">
            <div class="brand"><img src="${logoUrl}" alt="Arte de Aprender" /></div>
            <div class="details">
              <div class="line"><span class="label-text">CRIANÇA</span><span class="value name-value">${escapeHTML(data.childName)}</span></div>
              <div class="line"><span class="label-text">MÊS PAGO</span><span class="value">${escapeHTML(data.month)}</span></div>
              <div class="line"><span class="label-text">VALOR</span><span class="value">${escapeHTML(data.amount)}</span></div>
            </div>
          </main>
        </body>
      </html>
    `;
  }

  openPaymentLabel = function openPaymentLabelWithMonochromeLogo(paymentId) {
    const payment = state.payments.find((item) => item.id === paymentId);
    if (!payment) return;

    const popup = window.open("", "_blank", "width=520,height=420");
    if (!popup) {
      showToast("O navegador bloqueou a etiqueta. Libere pop-ups para imprimir.");
      return;
    }
    popup.document.open();
    popup.document.write(zebraLogoLabelHTML(payment));
    popup.document.close(),popup.document.querySelector("[data-print-window]")?.addEventListener("click",()=>popup.print());
  };

  paymentLabelZPL = function paymentLabelZPLWithMonochromeLogo(payment) {
    const settings = labelSettings();
    const data = zebraLabelData(payment);
    const widthDots = labelDimensionToDots(settings.width, settings.unit, settings.dpi);
    const heightDots = labelDimensionToDots(settings.height, settings.unit, settings.dpi);

    const logoX = 8;
    const logoY = Math.max(0, Math.floor((heightDots - 97) / 2));
    const infoX = Math.min(130, Math.max(105, Math.floor(widthDots * 0.39)));
    const infoWidth = Math.max(90, widthDots - infoX - 8);
    const block = Math.floor(heightDots / 3);
    const labelFont = Math.max(12, Math.min(16, Math.floor(heightDots / 12)));
    const valueFont = Math.max(16, Math.min(21, Math.floor(heightDots / 9)));
    const nameFont = Math.max(14, Math.min(18, Math.floor(heightDots / 10)));
    const monthFont = Math.max(13, Math.min(17, Math.floor(heightDots / 11.5)));

    const y1 = Math.max(5, Math.floor(block * 0.08));
    const y2 = block + Math.floor(block * 0.08);
    const y3 = block * 2 + Math.floor(block * 0.08);

    return `^XA
^CI28
^PW${widthDots}
^LL${heightDots}
^LH0,0
^FO${logoX},${logoY}${ZEBRA_LOGO_GFA}^FS
^FO${infoX},${y1}^A0N,${labelFont},${labelFont}^FDCRIANCA^FS
^FO${infoX},${y1 + labelFont + 2}^A0N,${nameFont},${nameFont}^FB${infoWidth},2,0,L,0^FD${zplSafeText(data.childName)}^FS
^FO${infoX},${y2}^A0N,${labelFont},${labelFont}^FDMES PAGO^FS
^FO${infoX},${y2 + labelFont + 2}^A0N,${monthFont},${monthFont}^FB${infoWidth},2,0,L,0^FD${zplSafeText(data.month)}^FS
^FO${infoX},${y3}^A0N,${labelFont},${labelFont}^FDVALOR^FS
^FO${infoX},${y3 + labelFont + 2}^A0N,${valueFont},${valueFont}^FB${infoWidth},1,0,L,0^FD${zplSafeText(data.amount)}^FS
^XZ`;
  };

  window.openPaymentLabel = openPaymentLabel;
  window.paymentLabelZPL = paymentLabelZPL;
})();
