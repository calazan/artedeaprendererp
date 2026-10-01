// Lembretes oficiais de mensalidade pelo WhatsApp Business Platform.
(() => {
  if (window.__saberWhatsappRemindersLoaded) return;
  window.__saberWhatsappRemindersLoaded = true;

  const ENDPOINT = "/api/whatsapp-reminders";
  const OFFSET_OPTIONS = [7, 5, 3, 1, 0, -1, -3];
  const TEMPLATE_TEXT = "Olá, {{1}}! Este é um lembrete da mensalidade de {{2}}, no valor de {{3}}, com vencimento em {{4}}. Situação: {{5}}. Caso já tenha realizado o pagamento, desconsidere esta mensagem. Arte de Aprender ERP.";
  let snapshot = null;
  let loading = false;

  const esc = (value) => {
    try { return escapeHTML(value); } catch {
      return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    }
  };
  const attr = (value) => esc(value).replaceAll("`", "&#096;");
  const brl = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value || 0));
  const dateTime = (value) => value ? new Date(value).toLocaleString("pt-BR") : "-";

  function syncKey() {
    try { return String(state?.settings?.remoteSync?.syncKey || "").trim(); } catch { return ""; }
  }

  function students() {
    try { return Array.isArray(state?.students) ? state.students : []; } catch { return []; }
  }

  function normalizePhone(value = "") {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    return digits.startsWith("55") && [12, 13].includes(digits.length) ? digits : "";
  }

  function ensureStylesheet() {
    if (document.querySelector('link[data-whatsapp-reminders-style]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "whatsapp-reminders.css?v=1";
    link.dataset.whatsappRemindersStyle = "true";
    document.head.appendChild(link);
  }

  async function request(action = "status", options = {}) {
    const key = syncKey();
    if (key.length < 32) throw new Error("Informe a chave de sincronização em Configurações > Sincronização remota.");
    const response = await fetch(`${ENDPOINT}?action=${encodeURIComponent(action)}`, {
      method: options.method || "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "x-sync-key": key,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok || data.ok === false) throw new Error(data.error || `Erro HTTP ${response.status}`);
    return data;
  }

  function mountPane() {
    ensureStylesheet();
    const settingsView = document.querySelector("#settingsView");
    const subtabs = settingsView?.querySelector(".settings-subtabs");
    const grid = settingsView?.querySelector(".settings-grid-tabs");
    if (!subtabs || !grid) return null;

    let button = subtabs.querySelector('[data-settings-pane="whatsapp"]');
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "settings-subtab";
      button.dataset.settingsPane = "whatsapp";
      button.textContent = "WhatsApp";
      const securityButton = subtabs.querySelector('[data-settings-pane="security"]');
      subtabs.insertBefore(button, securityButton || null);
      button.addEventListener("click", () => {
        subtabs.querySelectorAll(".settings-subtab").forEach((item) => item.classList.toggle("is-active", item === button));
        grid.querySelectorAll(".settings-pane").forEach((item) => item.classList.toggle("is-active", item.id === "whatsappRemindersPane"));
        render();
        loadStatus();
      });
    }

    let pane = grid.querySelector("#whatsappRemindersPane");
    if (!pane) {
      pane = document.createElement("div");
      pane.id = "whatsappRemindersPane";
      pane.className = "settings-pane";
      pane.dataset.settingsPaneContent = "whatsapp";
      const prints = grid.querySelector('[data-settings-pane-content="prints"]');
      grid.insertBefore(pane, prints || null);
      pane.addEventListener("click", handleClick);
      pane.addEventListener("submit", handleSubmit);
    }
    return pane;
  }

  function providerMarkup(provider = {}) {
    const items = [
      [provider.accessTokenConfigured, "Token da Meta"],
      [provider.phoneNumberConfigured, "Número remetente"],
      [provider.templateName, `Modelo: ${provider.templateName || "não configurado"}`],
      [provider.webhookReady, "Webhook de entrega"],
    ];
    return `<div class="whatsapp-status-grid">${items.map(([ok, label]) => `<span class="whatsapp-status ${ok ? "is-ok" : "is-missing"}">${ok ? "✓" : "!"} ${esc(label)}</span>`).join("")}</div>`;
  }

  function offsetLabel(value) {
    if (value === 0) return "No dia do vencimento";
    if (value > 0) return `${value} dia${value === 1 ? "" : "s"} antes`;
    return `${Math.abs(value)} dia${value === -1 ? "" : "s"} depois`;
  }

  function recipientsMarkup() {
    const enabledIds = new Set((snapshot?.recipients || []).filter((item) => item.enabled).map((item) => String(item.studentId)));
    const active = students().filter((student) => student?.status === "active").sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "pt-BR"));
    if (!active.length) return '<div class="empty"><strong>Nenhuma criança ativa</strong><span>Cadastre uma criança antes de configurar os avisos.</span></div>';
    return `<div class="whatsapp-recipient-list">${active.map((student) => {
      const phone = normalizePhone(student.phone);
      const enabled = enabledIds.has(String(student.id));
      return `<label class="whatsapp-recipient ${!phone ? "has-invalid-phone" : ""}">
        <input type="checkbox" data-whatsapp-student="${attr(student.id)}" ${enabled ? "checked" : ""} ${!phone ? "disabled" : ""} />
        <span><strong>${esc(student.name || "Criança")}</strong><small>${esc(student.guardian || "Responsável não informado")} · ${esc(student.phone || "Sem telefone")}${!phone ? " · telefone inválido" : ""}</small></span>
      </label>`;
    }).join("")}</div>`;
  }

  function historyMarkup(history = []) {
    if (!history.length) return '<div class="empty"><strong>Nenhuma mensagem enviada</strong><span>O histórico aparecerá depois do primeiro teste ou lembrete.</span></div>';
    const labels = { claimed: "Preparando", accepted: "Aceita pela Meta", sent: "Enviada", delivered: "Entregue", read: "Lida", failed: "Falhou" };
    return `<div class="table-wrap"><table class="whatsapp-history"><thead><tr><th>Data</th><th>Criança</th><th>Valor</th><th>Vencimento</th><th>Telefone</th><th>Situação</th></tr></thead><tbody>${history.map((item) => `<tr>
      <td>${esc(dateTime(item.createdAt))}</td>
      <td><strong>${esc(item.studentName || (item.paymentId === "test" ? "Teste" : "-"))}</strong><small>${esc(item.guardianName || "")}</small></td>
      <td>${esc(brl(item.amount))}</td>
      <td>${esc(item.dueDate ? item.dueDate.split("-").reverse().join("/") : "-")}</td>
      <td>${esc(item.recipient || "-")}</td>
      <td><span class="whatsapp-history-status is-${attr(item.status)}">${esc(labels[item.status] || item.status)}</span>${item.error ? `<small title="${attr(item.error)}">${esc(item.error)}</small>` : ""}</td>
    </tr>`).join("")}</tbody></table></div>`;
  }

  function render() {
    const pane = mountPane();
    if (!pane) return;
    const settings = snapshot?.settings || { enabled: false, offsets: [3, 0, -1] };
    const provider = snapshot?.provider || {};
    const enabledIds = new Set((snapshot?.recipients || []).filter((item) => item.enabled).map((item) => String(item.studentId)));
    const eligible = students().filter((student) => student?.status === "active" && enabledIds.has(String(student.id)) && normalizePhone(student.phone)).length;
    const monthlyMessages = eligible * Math.max(1, settings.offsets?.length || 0);
    const estimatedCost = monthlyMessages * 0.034;
    pane.innerHTML = `
      <div class="whatsapp-settings-layout">
        <section class="settings-card whatsapp-intro-card">
          <div class="whatsapp-heading"><div><h3>Lembretes automáticos pelo WhatsApp</h3><p>Envio oficial pela Meta, somente para responsáveis com consentimento confirmado.</p></div><span class="whatsapp-main-badge ${settings.enabled ? "is-on" : ""}">${settings.enabled ? "Automação ativa" : "Automação desligada"}</span></div>
          ${providerMarkup(provider)}
          <div class="whatsapp-cost"><strong>Estimativa atual: ${brl(estimatedCost)}/mês</strong><span>${eligible} responsável(is) · até ${monthlyMessages} mensagem(ns), usando R$ 0,034 como referência.</span></div>
        </section>

        <form class="settings-card whatsapp-config-card" id="whatsappConfigForm">
          <h3>Quando enviar</h3>
          <label class="whatsapp-toggle"><span><strong>Ativar lembretes automáticos</strong><small>A rotina é executada todos os dias às 9h, horário de Brasília.</small></span><input type="checkbox" id="whatsappEnabled" ${settings.enabled ? "checked" : ""} ${!provider.readyToSend ? "disabled" : ""} /></label>
          <div class="whatsapp-offsets">${OFFSET_OPTIONS.map((value) => `<label><input type="checkbox" name="whatsappOffset" value="${value}" ${(settings.offsets || []).includes(value) ? "checked" : ""} /> ${esc(offsetLabel(value))}</label>`).join("")}</div>
          <div class="form-actions"><button type="submit">Salvar automação</button><button type="button" class="secondary" data-whatsapp-dispatch>Processar agora</button></div>
          ${!provider.readyToSend ? '<small class="whatsapp-warning">Configure as credenciais da Meta na Vercel antes de ativar.</small>' : ""}
        </form>

        <section class="settings-card whatsapp-template-card">
          <h3>Modelo aprovado pela Meta</h3>
          <p>Categoria: <strong>Utilidade</strong> · idioma: <strong>${esc(provider.templateLanguage || "pt_BR")}</strong></p>
          <blockquote>${esc(TEMPLATE_TEXT)}</blockquote>
          <button type="button" class="secondary small" data-whatsapp-copy-template>Copiar texto do modelo</button>
        </section>

        <form class="settings-card whatsapp-test-card" id="whatsappTestForm">
          <h3>Enviar mensagem de teste</h3>
          <label>Telefone com DDD<input id="whatsappTestPhone" inputmode="tel" placeholder="(44) 99999-9999" required /></label>
          <button type="submit" ${!provider.readyToSend ? "disabled" : ""}>Enviar teste oficial</button>
          <small>O teste usa o modelo aprovado e pode gerar a tarifa normal da Meta.</small>
        </form>

        <section class="settings-card whatsapp-recipients-card">
          <div class="whatsapp-heading"><div><h3>Responsáveis autorizados</h3><p>Marque somente quem concordou em receber lembretes. A resposta “SAIR” cancela automaticamente.</p></div><button type="button" data-whatsapp-save-recipients>Salvar autorizações</button></div>
          ${recipientsMarkup()}
        </section>

        <section class="settings-card whatsapp-history-card">
          <div class="whatsapp-heading"><div><h3>Histórico de mensagens</h3><p>A situação é atualizada pelo webhook oficial da Meta.</p></div><button type="button" class="secondary small" data-whatsapp-refresh>Atualizar</button></div>
          ${historyMarkup(snapshot?.history || [])}
        </section>
      </div>`;
  }

  async function loadStatus() {
    if (loading) return;
    loading = true;
    try {
      snapshot = await request("status");
      render();
    } catch (error) {
      const pane = mountPane();
      if (pane) pane.innerHTML = `<div class="settings-card whatsapp-error"><h3>WhatsApp</h3><p>${esc(error.message || "Não foi possível carregar a integração.")}</p><button type="button" data-whatsapp-refresh>Tentar novamente</button></div>`;
    } finally {
      loading = false;
    }
  }

  async function saveRecipients() {
    const pane = mountPane();
    const enabledIds = new Set([...pane.querySelectorAll("[data-whatsapp-student]:checked")].map((input) => input.dataset.whatsappStudent));
    const result = await request("save-recipients", { method: "POST", body: { action: "save-recipients", studentIds: [...enabledIds] } });
    snapshot = { ...(snapshot || {}), recipients: result.recipients || [] };
    try { showToast("Autorizações do WhatsApp salvas."); } catch {}
    render();
  }

  async function handleClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.matches("[data-whatsapp-refresh]")) return loadStatus();
      if (button.matches("[data-whatsapp-save-recipients]")) return saveRecipients();
      if (button.matches("[data-whatsapp-copy-template]")) {
        await navigator.clipboard.writeText(TEMPLATE_TEXT);
        try { showToast("Texto do modelo copiado."); } catch {}
        return;
      }
      if (button.matches("[data-whatsapp-dispatch]")) {
        button.disabled = true;
        const result = await request("dispatch", { method: "POST", body: { action: "dispatch" } });
        try { showToast(`Processamento concluído: ${result.sent || 0} enviada(s), ${result.failed || 0} falha(s).`); } catch {}
        await loadStatus();
      }
    } catch (error) {
      try { showToast(error.message || "Não foi possível concluir a operação."); } catch {}
      button.disabled = false;
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.target;
    try {
      if (form.id === "whatsappConfigForm") {
        const offsets = [...form.querySelectorAll('[name="whatsappOffset"]:checked')].map((input) => Number(input.value));
        if (!offsets.length) throw new Error("Selecione pelo menos um momento para o envio.");
        snapshot = { ...(snapshot || {}), ...(await request("save-config", { method: "POST", body: { action: "save-config", settings: { enabled: form.querySelector("#whatsappEnabled").checked, offsets } } })) };
        try { showToast("Automação do WhatsApp salva."); } catch {}
        return render();
      }
      if (form.id === "whatsappTestForm") {
        const phone = form.querySelector("#whatsappTestPhone").value;
        form.querySelector("button").disabled = true;
        await request("test", { method: "POST", body: { action: "test", phone } });
        try { showToast("Mensagem de teste aceita pela Meta."); } catch {}
        await loadStatus();
      }
    } catch (error) {
      try { showToast(error.message || "Não foi possível salvar."); } catch {}
      form.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  }

  function init() {
    mountPane();
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();

