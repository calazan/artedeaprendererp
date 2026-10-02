// Permite anexar boleto/guia PDF ao imposto antes do pagamento.
(() => {
  if (window.__saberEmployeeTaxBillUploadLoaded) return;
  window.__saberEmployeeTaxBillUploadLoaded = true;

  const ENDPOINT = "/api/employee-documents";
  const KIND = "tax_bill";
  const MAX_BYTES = 3_000_000;
  let bills = [];
  let loading = false;
  let loadedPeriod = "";
  let paintTimer = null;

  function syncKey() {
    return String(state?.settings?.remoteSync?.syncKey || document.querySelector("#remoteSyncKey")?.value || "").trim();
  }

  function periodKey() {
    try { return selectedPeriodKey(); } catch { return ""; }
  }

  function toast(message) {
    try { showToast(message); } catch { alert(message); }
  }

  function escapeAttr(value = "") {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function parseTaxKey(raw = "") {
    const value = String(raw || "");
    const separator = value.lastIndexOf(":");
    if (separator < 1) return { employeeId: "", taxId: "" };
    return { employeeId: value.slice(0, separator), taxId: value.slice(separator + 1) };
  }

  function employees() {
    return Array.isArray(state?.employees) ? state.employees : [];
  }

  function taxById(employeeId, taxId) {
    const employee = employees().find((item) => String(item.id) === String(employeeId));
    const tax = employee?.taxes?.find((item) => String(item.id) === String(taxId));
    return { employee, tax };
  }

  async function request(url, options = {}) {
    const key = syncKey();
    if (key.length < 6) throw new Error("Chave interna não configurada.");
    return fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: {
        Accept: "application/json",
        "x-sync-key": key,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.onerror = () => reject(reader.error || new Error("Falha ao ler o PDF."));
      reader.readAsDataURL(file);
    });
  }

  function billForTax(taxId) {
    const docs = bills.filter((doc) => doc.kind === KIND && String(doc.relatedId) === String(taxId));
    return docs.at(-1) || null;
  }

  async function loadBills(force = false) {
    const period = periodKey();
    if (!period || loading || (!force && loadedPeriod === period)) return;
    loading = true;
    try {
      const response = await request(`${ENDPOINT}?period=${encodeURIComponent(period)}&kind=${KIND}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "Falha ao carregar boletos.");
      bills = Array.isArray(data.documents) ? data.documents : [];
      loadedPeriod = period;
      paintTaxTable();
    } catch (error) {
      console.warn("Não foi possível carregar os boletos dos impostos.", error);
    } finally {
      loading = false;
    }
  }

  async function uploadBill({ employeeId, taxId, file }) {
    if (!file) return false;
    if (file.type !== "application/pdf" && !String(file.name || "").toLowerCase().endsWith(".pdf")) {
      toast("Selecione um arquivo PDF para o boleto ou guia.");
      return false;
    }
    if (file.size > MAX_BYTES) {
      toast("O PDF deve ter no máximo 3 MB.");
      return false;
    }
    const { tax } = taxById(employeeId, taxId);
    if (!tax) {
      toast("Não encontrei o imposto para vincular o boleto.");
      return false;
    }
    try {
      toast("Enviando boleto...");
      const dataBase64 = await fileToBase64(file);
      const response = await request(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({
          employeeId,
          kind: KIND,
          period: tax.period || periodKey(),
          relatedId: taxId,
          filename: file.name,
          mimeType: "application/pdf",
          dataBase64,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || "Falha ao enviar boleto.");

      const previous = billForTax(taxId);
      if (previous?.id && previous.id !== data.document?.id) {
        request(`${ENDPOINT}?id=${encodeURIComponent(previous.id)}`, { method: "DELETE" }).catch(() => {});
      }
      loadedPeriod = "";
      await loadBills(true);
      toast("Boleto anexado ao imposto pendente.");
      return true;
    } catch (error) {
      console.error(error);
      toast(error.message || "Não consegui anexar o boleto.");
      return false;
    }
  }

  async function openBill(documentId) {
    if (!documentId) return;
    try {
      const response = await request(`${ENDPOINT}?id=${encodeURIComponent(documentId)}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Falha ao abrir boleto.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const popup = window.open(url, "_blank", "noopener,noreferrer");
      if (!popup) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        link.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      console.error(error);
      toast(error.message || "Não consegui abrir o boleto.");
    }
  }

  function billCell(employeeId, taxId) {
    const bill = billForTax(taxId);
    if (bill) {
      return `<td data-tax-bill-cell="${escapeAttr(taxId)}"><div class="row-actions"><button type="button" class="small" data-open-tax-bill="${escapeAttr(bill.id)}">Abrir boleto</button><label class="small secondary" style="display:inline-flex;align-items:center;cursor:pointer">Trocar PDF<input type="file" hidden accept="application/pdf,.pdf" data-tax-bill-upload="${escapeAttr(employeeId)}:${escapeAttr(taxId)}" /></label></div><small>${escapeAttr(bill.filename || "Boleto.pdf")}</small></td>`;
    }
    return `<td data-tax-bill-cell="${escapeAttr(taxId)}"><label class="small secondary" style="display:inline-flex;align-items:center;cursor:pointer">Anexar boleto<input type="file" hidden accept="application/pdf,.pdf" data-tax-bill-upload="${escapeAttr(employeeId)}:${escapeAttr(taxId)}" /></label><small>PDF para pagamento posterior</small></td>`;
  }

  function paintTaxTable() {
    const table = document.querySelector("#employeeTaxTable")?.closest("table");
    const tbody = document.querySelector("#employeeTaxTable");
    if (!table || !tbody) return;

    const headRow = table.querySelector("thead tr");
    if (headRow && !headRow.querySelector('[data-tax-bill-head]')) {
      const cells = [...headRow.children];
      const receiptHead = cells.find((cell) => String(cell.textContent || "").trim().toLowerCase().includes("comprovante"));
      const th = document.createElement("th");
      th.dataset.taxBillHead = "true";
      th.textContent = "Boleto / guia";
      if (receiptHead) headRow.insertBefore(th, receiptHead);
      else headRow.insertBefore(th, headRow.lastElementChild);
    }

    [...tbody.querySelectorAll("tr")].forEach((row) => {
      if (row.querySelector(".empty")) {
        const cell = row.querySelector("td[colspan]");
        if (cell && Number(cell.colSpan || 0) < 9) cell.colSpan = 9;
        return;
      }
      const action = row.querySelector("[data-pay-tax], [data-reverse-tax], [data-delete-tax]");
      const raw = action?.dataset.payTax || action?.dataset.reverseTax || action?.dataset.deleteTax || "";
      const { employeeId, taxId } = parseTaxKey(raw);
      if (!employeeId || !taxId) return;
      const existing = row.querySelector(`[data-tax-bill-cell="${CSS.escape(taxId)}"]`);
      if (existing) {
        const temp = document.createElement("tbody");
        temp.innerHTML = `<tr>${billCell(employeeId, taxId)}</tr>`;
        const replacement = temp.querySelector("td");
        if (replacement && existing.innerHTML !== replacement.innerHTML) existing.replaceWith(replacement);
        return;
      }
      const temp = document.createElement("tbody");
      temp.innerHTML = `<tr>${billCell(employeeId, taxId)}</tr>`;
      const td = temp.querySelector("td");
      if (!td) return;
      const receiptInput = row.querySelector("[data-tax-receipt-upload]");
      const receiptButton = row.querySelector("[data-open-employee-document]");
      const receiptCell = receiptInput?.closest("td") || receiptButton?.closest("td");
      if (receiptCell) row.insertBefore(td, receiptCell);
      else row.insertBefore(td, row.lastElementChild);
    });
  }

  function mountTaxFormFile() {
    const form = document.querySelector("#employeeTaxForm");
    if (!form || form.querySelector("#taxBillFile")) return;
    const actions = form.querySelector(".employee-actions");
    const label = document.createElement("label");
    label.className = "employee-span-2";
    label.innerHTML = `Boleto / guia para pagar depois (PDF)<input id="taxBillFile" type="file" accept="application/pdf,.pdf" /><small>Opcional. O imposto continua pendente até você registrar o pagamento.</small>`;
    if (actions) form.insertBefore(label, actions);
    else form.appendChild(label);

    form.addEventListener("submit", () => {
      const file = document.querySelector("#taxBillFile")?.files?.[0] || null;
      if (!file) return;
      const employeeId = document.querySelector("#taxEmployeeId")?.value || "";
      const before = new Set((taxById(employeeId, "").employee?.taxes || []).map((tax) => String(tax.id)));
      const period = document.querySelector("#taxPeriod")?.value || periodKey();
      const type = document.querySelector("#taxType")?.value || "";
      const amount = Number(document.querySelector("#taxAmount")?.value || 0);
      const dueDate = document.querySelector("#taxDueDate")?.value || "";
      setTimeout(async () => {
        const employee = employees().find((item) => String(item.id) === String(employeeId));
        const candidates = (employee?.taxes || []).filter((tax) => !before.has(String(tax.id)) && tax.period === period && String(tax.type) === String(type) && Math.abs(Number(tax.amount || 0) - amount) < 0.01 && String(tax.dueDate || "") === dueDate);
        const tax = candidates.at(-1) || (employee?.taxes || []).filter((item) => !before.has(String(item.id))).at(-1);
        if (tax) await uploadBill({ employeeId, taxId: tax.id, file });
        const field = document.querySelector("#taxBillFile");
        if (field) field.value = "";
      }, 120);
    });
  }

  document.addEventListener("change", async (event) => {
    const input = event.target.closest("input[data-tax-bill-upload]");
    if (!input || !input.files?.[0]) return;
    const { employeeId, taxId } = parseTaxKey(input.dataset.taxBillUpload || "");
    if (!employeeId || !taxId) return;
    await uploadBill({ employeeId, taxId, file: input.files[0] });
    input.value = "";
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-tax-bill]");
    if (button) openBill(button.dataset.openTaxBill);
  });

  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      if (mutation.type !== "childList") return false;
      return [...mutation.addedNodes].some((node) => node.nodeType === 1 && (node.matches?.("#employeesView, #employeeTaxTable, tr") || node.querySelector?.("#employeeTaxTable, #employeeTaxForm")));
    });
    if (!relevant) return;
    clearTimeout(paintTimer);
    paintTimer = setTimeout(() => {
      mountTaxFormFile();
      loadBills();
      paintTaxTable();
    }, 60);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  mountTaxFormFile();
  loadBills(true);
  paintTaxTable();

  // Recarrega os boletos ao mudar a competência do sistema.
  document.addEventListener("change", (event) => {
    if (!event.target.matches("#monthPicker, #yearPicker, #taxPeriod")) return;
    loadedPeriod = "";
    setTimeout(() => loadBills(true), 0);
  });
})();
