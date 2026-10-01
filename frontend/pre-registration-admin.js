// Integra os pré-cadastros públicos ao painel administrativo do Arte de Aprender.
(() => {
  const ENDPOINT = "/api/pre-registration";
  const PENDING_ENROLLMENT_KEY = "arteDeAprenderERP.pendingPreregistrationEnrollment";
  const PUBLIC_FORM_PATH = "/pre-cadastro.html";
  let currentFilter = "pending";
  let records = [];
  let counts = {};
  let loading = false;

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalized(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function syncKey() {
    try {
      return String(state?.settings?.remoteSync?.syncKey || document.querySelector("#remoteSyncKey")?.value || "").trim();
    } catch {
      return String(document.querySelector("#remoteSyncKey")?.value || "").trim();
    }
  }

  function toast(message) {
    try { showToast(message); } catch { alert(message); }
  }

  function dateTimeBR(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function dateBR(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return value || "-";
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }

  function addressText(data = {}) {
    const address = data.address || {};
    return [
      [address.street, address.number].filter(Boolean).join(", "),
      address.complement,
      address.district,
      [address.city, address.state].filter(Boolean).join(" - "),
      address.cep ? `CEP ${address.cep}` : "",
    ].filter(Boolean).join(" · ");
  }

  function statusLabel(status) {
    return ({
      pending: "Pendente",
      reviewing: "Em conferência",
      enrolled: "Matriculado",
      rejected: "Recusado",
    })[status] || status || "Pendente";
  }

  function statusClass(status) {
    return ({ pending: "warn", reviewing: "working", enrolled: "ok", rejected: "bad" })[status] || "warn";
  }

  function publicLink() {
    return `${location.origin}${PUBLIC_FORM_PATH}`;
  }

  function injectStyle() {
    if (document.querySelector("#preRegistrationAdminStyle")) return;
    const style = document.createElement("style");
    style.id = "preRegistrationAdminStyle";
    style.textContent = `
      .prereg-share-card{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center;padding:20px;margin-bottom:18px;border-radius:18px;background:linear-gradient(135deg,rgba(143,77,156,.12),rgba(243,198,79,.18));border:1px solid rgba(143,77,156,.18)}
      .prereg-share-card h2{margin:0 0 5px}.prereg-share-card p{margin:0;color:var(--muted,#756b78)}
      .prereg-link-box{display:flex;gap:8px;align-items:center;margin-top:12px}.prereg-link-box input{min-width:300px;background:#fff}
      .prereg-actions{display:flex;flex-wrap:wrap;gap:8px}.prereg-actions button{white-space:nowrap}
      .prereg-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:18px}
      .prereg-metric{padding:16px;border:1px solid var(--line,#e5dce7);border-radius:16px;background:rgba(255,255,255,.86)}
      .prereg-metric span{display:block;color:var(--muted,#756b78);font-size:.82rem}.prereg-metric strong{display:block;font-size:1.8rem;margin-top:3px;color:var(--purple,#8f4d9c)}
      .prereg-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
      .prereg-filters{display:flex;gap:7px;flex-wrap:wrap}.prereg-filter{border:1px solid var(--line,#e5dce7);background:#fff;color:inherit;border-radius:999px;padding:8px 13px;font-weight:750}.prereg-filter.is-active{background:var(--purple,#8f4d9c);color:#fff;border-color:var(--purple,#8f4d9c)}
      .prereg-list{display:grid;gap:12px}.prereg-card{padding:17px;border:1px solid var(--line,#e5dce7);border-radius:16px;background:#fff}.prereg-card-head{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:start}.prereg-card h3{margin:0 0 4px}.prereg-summary{display:flex;gap:10px 18px;flex-wrap:wrap;color:var(--muted,#756b78);font-size:.88rem}.prereg-status{display:inline-flex;padding:6px 9px;border-radius:999px;font-size:.76rem;font-weight:850}.prereg-status.warn{background:#fff2cf;color:#805d00}.prereg-status.working{background:#ede9ff;color:#55409b}.prereg-status.ok{background:#e4f6ec;color:#176b43}.prereg-status.bad{background:#fbe8eb;color:#9b2f3b}
      .prereg-details{margin-top:13px;border-top:1px solid var(--line,#e5dce7);padding-top:11px}.prereg-details summary{cursor:pointer;font-weight:800;color:var(--purple,#8f4d9c)}
      .prereg-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px;margin-top:13px}.prereg-detail{padding:10px;border-radius:10px;background:#faf7fb}.prereg-detail span{display:block;color:var(--muted,#756b78);font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}.prereg-detail strong,.prereg-detail p{display:block;margin:3px 0 0;white-space:pre-wrap;line-height:1.4}.prereg-detail.wide{grid-column:1/-1}
      .prereg-card-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.prereg-empty{padding:34px;text-align:center;border:1px dashed var(--line,#e5dce7);border-radius:16px;color:var(--muted,#756b78)}
      .prereg-error{padding:14px;border-radius:12px;background:#fff0f2;color:#8d2632;border:1px solid #efb9c0}
      @media(max-width:800px){.prereg-share-card{grid-template-columns:1fr}.prereg-link-box{align-items:stretch;flex-direction:column}.prereg-link-box input{min-width:0}.prereg-metrics{grid-template-columns:repeat(2,1fr)}.prereg-card-head{grid-template-columns:1fr}.prereg-detail-grid{grid-template-columns:1fr}.prereg-detail.wide{grid-column:auto}}
    `;
    document.head.appendChild(style);
  }

  function mount() {
    if (document.querySelector("#preRegistrationsView")) return;
    const main = document.querySelector("main.main");
    const nav = document.querySelector("nav.tabs");
    if (!main || !nav) return;

    injectStyle();

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.dataset.view = "preRegistrations";
    tab.innerHTML = `Pré-cadastros <span id="preRegistrationNavBadge" style="display:none;margin-left:6px;padding:1px 6px;border-radius:999px;background:#f3c64f;color:#4b3700;font-size:.72rem"></span>`;
    const studentTab = nav.querySelector('[data-view="students"]');
    studentTab?.insertAdjacentElement("afterend", tab);

    const section = document.createElement("section");
    section.className = "view";
    section.id = "preRegistrationsView";
    section.innerHTML = `
      <section class="prereg-share-card glass-card">
        <div>
          <h2>Link de pré-cadastro para os pais</h2>
          <p>Envie este link. Os dados chegarão aqui como pendentes e só entrarão no cadastro oficial após sua conferência.</p>
          <div class="prereg-link-box"><input id="preRegistrationPublicLink" readonly /><button type="button" class="secondary" id="copyPreRegistrationLink">Copiar link</button></div>
        </div>
        <div class="prereg-actions"><button type="button" id="sharePreRegistrationWhatsapp">Enviar pelo WhatsApp</button><button type="button" class="secondary" id="sharePreRegistrationNative">Compartilhar</button></div>
      </section>

      <div class="prereg-metrics">
        <article class="prereg-metric"><span>Pendentes</span><strong id="preregCountPending">0</strong></article>
        <article class="prereg-metric"><span>Em conferência</span><strong id="preregCountReviewing">0</strong></article>
        <article class="prereg-metric"><span>Matriculados</span><strong id="preregCountEnrolled">0</strong></article>
        <article class="prereg-metric"><span>Total recebido</span><strong id="preregCountTotal">0</strong></article>
      </div>

      <section class="panel glass-card">
        <div class="prereg-toolbar">
          <div><h2 style="margin:0 0 4px">Pré-cadastros recebidos</h2><span style="color:var(--muted,#756b78)">Confira as informações antes de preparar a matrícula.</span></div>
          <button type="button" class="secondary" id="refreshPreRegistrations">Atualizar lista</button>
        </div>
        <div class="prereg-filters" id="preRegistrationFilters">
          <button type="button" class="prereg-filter is-active" data-prereg-filter="pending">Pendentes</button>
          <button type="button" class="prereg-filter" data-prereg-filter="reviewing">Em conferência</button>
          <button type="button" class="prereg-filter" data-prereg-filter="enrolled">Matriculados</button>
          <button type="button" class="prereg-filter" data-prereg-filter="rejected">Recusados</button>
          <button type="button" class="prereg-filter" data-prereg-filter="all">Todos</button>
        </div>
        <div class="prereg-list" id="preRegistrationList"><div class="prereg-empty">Abra esta área para carregar os pré-cadastros.</div></div>
      </section>`;

    const attendanceView = document.querySelector("#attendanceView");
    if (attendanceView) attendanceView.insertAdjacentElement("beforebegin", section);
    else main.appendChild(section);

    try {
      views.preRegistrations = section;
      titles.preRegistrations = "Pré-cadastros";
    } catch {}

    document.querySelector("#preRegistrationPublicLink").value = publicLink();
    tab.addEventListener("click", () => openView());
    document.querySelector("#refreshPreRegistrations")?.addEventListener("click", () => loadRecords(true));
    document.querySelector("#copyPreRegistrationLink")?.addEventListener("click", copyLink);
    document.querySelector("#sharePreRegistrationWhatsapp")?.addEventListener("click", shareWhatsapp);
    document.querySelector("#sharePreRegistrationNative")?.addEventListener("click", shareNative);
    document.querySelectorAll("[data-prereg-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        currentFilter = button.dataset.preregFilter || "pending";
        document.querySelectorAll("[data-prereg-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
        loadRecords(true);
      });
    });
    document.querySelector("#preRegistrationList")?.addEventListener("click", handleListAction);
    attachEnrollmentCompletion();

    window.__saberMaisPreRegistrations = {
      refresh: () => loadRecords(true),
      open: openView,
      link: publicLink,
    };
  }

  function openView() {
    try {
      switchView("preRegistrations");
    } catch {
      document.querySelectorAll(".view").forEach((view) => view.classList.remove("is-active"));
      document.querySelector("#preRegistrationsView")?.classList.add("is-active");
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === "preRegistrations"));
      const title = document.querySelector("#viewTitle");
      if (title) title.textContent = "Pré-cadastros";
    }
    loadRecords();
  }

  async function request(method, body, query = "") {
    const key = syncKey();
    if (key.length < 6) throw new Error("A chave de sincronização não está preenchida neste aparelho.");
    const response = await fetch(`${ENDPOINT}${query}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "x-sync-key": key,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok || data.ok === false) throw new Error(data.error || `Erro HTTP ${response.status}`);
    return data;
  }

  async function loadRecords(force = false) {
    if (loading && !force) return;
    loading = true;
    const list = document.querySelector("#preRegistrationList");
    if (list) list.innerHTML = `<div class="prereg-empty">Carregando pré-cadastros...</div>`;
    try {
      const query = currentFilter === "all" ? "" : `?status=${encodeURIComponent(currentFilter)}`;
      const data = await request("GET", null, query);
      records = Array.isArray(data.records) ? data.records : [];
      counts = data.counts || {};
      renderCounts();
      renderRecords();
    } catch (error) {
      if (list) list.innerHTML = `<div class="prereg-error"><strong>Não foi possível carregar.</strong><br>${escapeHTML(error.message || "Falha desconhecida")}</div>`;
    } finally {
      loading = false;
    }
  }

  function renderCounts() {
    const values = {
      preregCountPending: Number(counts.pending || 0),
      preregCountReviewing: Number(counts.reviewing || 0),
      preregCountEnrolled: Number(counts.enrolled || 0),
      preregCountTotal: Number(counts.total || 0),
    };
    Object.entries(values).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) element.textContent = String(value);
    });
    const badge = document.querySelector("#preRegistrationNavBadge");
    const pendingTotal = Number(counts.pending || 0) + Number(counts.reviewing || 0);
    if (badge) {
      badge.textContent = String(pendingTotal);
      badge.style.display = pendingTotal ? "inline-flex" : "none";
    }
  }

  function yesNo(value) {
    return value ? "Sim" : "Não";
  }

  function peopleText(items = []) {
    if (!Array.isArray(items) || !items.length) return "Nenhuma outra pessoa informada.";
    return items.map((person) => [person.name, person.relationship, person.phone, person.document].filter(Boolean).join(" · ")).join("\n");
  }

  function imageLabel(value) {
    return ({
      "internal-social": "Registros internos e divulgação",
      "internal-only": "Somente registros internos",
      none: "Não autorizado",
    })[value] || "Não informado";
  }

  function renderRecords() {
    const list = document.querySelector("#preRegistrationList");
    if (!list) return;
    if (!records.length) {
      list.innerHTML = `<div class="prereg-empty"><strong>Nenhum pré-cadastro nesta situação.</strong><br>Os novos envios aparecerão aqui automaticamente.</div>`;
      return;
    }

    list.innerHTML = records.map((record) => {
      const data = record.data || {};
      const healthSummary = [
        data.hasAllergy ? `Alergia: ${data.allergyDetails || "informada sem detalhes"}` : "",
        data.hasFoodRestriction ? `Restrição alimentar: ${data.foodRestrictionDetails || "informada sem detalhes"}` : "",
        data.usesMedication ? `Medicamento: ${data.medicationDetails || "informado sem detalhes"}` : "",
        data.hasHealthCondition ? `Condição de saúde: ${data.healthConditionDetails || "informada sem detalhes"}` : "",
        data.diagnosisStatus && data.diagnosisStatus !== "Não" ? `Acompanhamento: ${data.diagnosisStatus}${data.diagnosisDetails ? ` — ${data.diagnosisDetails}` : ""}` : "",
      ].filter(Boolean).join("\n") || "Nenhuma condição informada.";
      const service = data.serviceInterest === "Outro" ? (data.otherService || "Outro") : (data.serviceInterest || "-");
      const actionButtons = record.status === "enrolled"
        ? `<button type="button" class="secondary small" data-prereg-action="open-student" data-prereg-id="${escapeHTML(record.id)}">Abrir cadastro</button>`
        : record.status === "rejected"
          ? `<button type="button" class="secondary small" data-prereg-action="reopen" data-prereg-id="${escapeHTML(record.id)}">Reabrir</button>`
          : `<button type="button" class="small" data-prereg-action="enroll" data-prereg-id="${escapeHTML(record.id)}">Efetivar matrícula</button><button type="button" class="danger small" data-prereg-action="reject" data-prereg-id="${escapeHTML(record.id)}">Recusar</button>`;

      return `
        <article class="prereg-card">
          <div class="prereg-card-head">
            <div>
              <h3>${escapeHTML(data.childName || "Criança sem nome")}</h3>
              <div class="prereg-summary"><span><strong>Responsável:</strong> ${escapeHTML(data.guardianName || "-")}</span><span><strong>WhatsApp:</strong> ${escapeHTML(data.guardianPhone || "-")}</span><span><strong>Interesse:</strong> ${escapeHTML(service)}</span><span><strong>Recebido:</strong> ${escapeHTML(dateTimeBR(record.created_at))}</span></div>
            </div>
            <div><span class="prereg-status ${statusClass(record.status)}">${escapeHTML(statusLabel(record.status))}</span><div style="font-size:.72rem;color:var(--muted,#756b78);margin-top:6px;text-align:right">${escapeHTML(record.protocol || "")}</div></div>
          </div>
          <details class="prereg-details">
            <summary>Visualizar todas as informações</summary>
            <div class="prereg-detail-grid">
              <div class="prereg-detail"><span>Nascimento</span><strong>${escapeHTML(dateBR(data.birthDate))}</strong></div>
              <div class="prereg-detail"><span>Escola</span><strong>${escapeHTML([data.schoolName, data.schoolYear, data.schoolPeriod].filter(Boolean).join(" · ") || "-")}</strong></div>
              <div class="prereg-detail"><span>Responsável</span><strong>${escapeHTML([data.guardianName, data.relationship, data.guardianCpf].filter(Boolean).join(" · "))}</strong></div>
              <div class="prereg-detail"><span>Contatos</span><strong>${escapeHTML([data.guardianPhone, data.secondPhone, data.email].filter(Boolean).join(" · ") || "-")}</strong></div>
              <div class="prereg-detail wide"><span>Endereço</span><strong>${escapeHTML(addressText(data) || "-")}</strong></div>
              <div class="prereg-detail wide"><span>Contato de emergência</span><strong>${escapeHTML([data.emergencyName, data.emergencyRelationship, data.emergencyPhone, `Autorizado a buscar: ${yesNo(data.emergencyAuthorizedPickup)}`].filter(Boolean).join(" · "))}</strong></div>
              <div class="prereg-detail wide"><span>Saúde e cuidados</span><p>${escapeHTML(healthSummary)}</p></div>
              <div class="prereg-detail wide"><span>Rotina e comunicação</span><p>${escapeHTML(data.routineDetails || "Nenhuma observação.")}</p></div>
              <div class="prereg-detail"><span>Plano de saúde</span><strong>${escapeHTML(data.healthPlan || "-")}</strong></div>
              <div class="prereg-detail"><span>Unidade de preferência</span><strong>${escapeHTML(data.preferredHospital || "-")}</strong></div>
              <div class="prereg-detail wide"><span>Pessoas autorizadas</span><p>${escapeHTML(peopleText(data.authorizedPeople))}</p></div>
              <div class="prereg-detail wide"><span>Pessoa não autorizada</span><p>${escapeHTML(data.hasUnauthorizedPerson ? (data.unauthorizedPersonDetails || "Sim, sem detalhes") : "Não")}</p></div>
              <div class="prereg-detail"><span>Dias de interesse</span><strong>${escapeHTML((data.weekdays || []).join(", ") || "-")}</strong></div>
              <div class="prereg-detail"><span>Início previsto</span><strong>${escapeHTML(dateBR(data.expectedStartDate))}</strong></div>
              <div class="prereg-detail"><span>Como conheceu</span><strong>${escapeHTML(data.referralSource === "Outro" ? (data.referralOther || "Outro") : (data.referralSource || "-"))}</strong></div>
              <div class="prereg-detail"><span>Uso de imagem</span><strong>${escapeHTML(imageLabel(data.imageAuthorization))}</strong></div>
              <div class="prereg-detail wide"><span>Preenchido por</span><strong>${escapeHTML(data.submitterName || "-")}</strong></div>
            </div>
          </details>
          <div class="prereg-card-actions">${actionButtons}</div>
        </article>`;
    }).join("");
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(publicLink());
      toast("Link de pré-cadastro copiado.");
    } catch {
      const input = document.querySelector("#preRegistrationPublicLink");
      input?.select();
      document.execCommand("copy");
      toast("Link copiado.");
    }
  }

  function shareText() {
    return `Olá! Para realizar o pré-cadastro da criança no Arte de Aprender, preencha o formulário pelo link abaixo:\n\n${publicLink()}\n\nApós o envio, entraremos em contato para conferir as informações e concluir a matrícula.`;
  }

  function shareWhatsapp() {
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText())}`, "_blank", "noopener,noreferrer");
  }

  async function shareNative() {
    if (navigator.share) {
      try {
        await navigator.share({ title: "Pré-cadastro Arte de Aprender", text: shareText(), url: publicLink() });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    await copyLink();
  }

  function recordById(id) {
    return records.find((record) => String(record.id) === String(id));
  }

  async function handleListAction(event) {
    const button = event.target.closest("[data-prereg-action]");
    if (!button) return;
    const record = recordById(button.dataset.preregId);
    if (!record) return;
    const action = button.dataset.preregAction;
    button.disabled = true;
    try {
      if (action === "enroll") await prepareEnrollment(record);
      if (action === "reject") await rejectRecord(record);
      if (action === "reopen") await setStatus(record, "pending");
      if (action === "open-student") openEnrolledStudent(record);
    } catch (error) {
      toast(error.message || "Não foi possível concluir a ação.");
    } finally {
      button.disabled = false;
    }
  }

  function composeNotes(data = {}, protocol = "") {
    const lines = [
      protocol ? `Pré-cadastro: ${protocol}` : "",
      data.schoolName || data.schoolYear || data.schoolPeriod ? `Escola: ${[data.schoolName, data.schoolYear, data.schoolPeriod].filter(Boolean).join(" · ")}` : "",
      data.secondPhone ? `Segundo telefone: ${data.secondPhone}` : "",
      data.email ? `E-mail: ${data.email}` : "",
      data.profession ? `Profissão do responsável: ${data.profession}` : "",
      data.emergencyName || data.emergencyRelationship ? `Contato de emergência: ${[data.emergencyName, data.emergencyRelationship, data.emergencyPhone].filter(Boolean).join(" · ")}. Autorizado a buscar: ${yesNo(data.emergencyAuthorizedPickup)}.` : "",
      data.hasAllergy ? `ALERGIA: ${data.allergyDetails || "Sim, sem detalhes"}` : "Sem alergia informada.",
      data.hasFoodRestriction ? `RESTRIÇÃO ALIMENTAR: ${data.foodRestrictionDetails || "Sim, sem detalhes"}` : "",
      data.usesMedication ? `MEDICAMENTO: ${data.medicationDetails || "Sim, sem detalhes"}` : "",
      data.hasHealthCondition ? `CONDIÇÃO DE SAÚDE: ${data.healthConditionDetails || "Sim, sem detalhes"}` : "",
      data.diagnosisStatus && data.diagnosisStatus !== "Não" ? `ACOMPANHAMENTO: ${data.diagnosisStatus}${data.diagnosisDetails ? ` — ${data.diagnosisDetails}` : ""}` : "",
      data.routineDetails ? `Rotina/comportamento/comunicação: ${data.routineDetails}` : "",
      data.healthPlan ? `Plano de saúde: ${data.healthPlan}` : "",
      data.preferredHospital ? `Unidade de saúde preferencial: ${data.preferredHospital}` : "",
      Array.isArray(data.authorizedPeople) && data.authorizedPeople.length ? `Pessoas autorizadas: ${peopleText(data.authorizedPeople).replaceAll("\n", "; ")}` : "",
      data.hasUnauthorizedPerson ? `NÃO AUTORIZADO A RETIRAR: ${data.unauthorizedPersonDetails || "informado sem detalhes"}` : "",
      data.weekdays?.length ? `Dias de interesse: ${data.weekdays.join(", ")}` : "",
      data.expectedStartDate ? `Início previsto: ${dateBR(data.expectedStartDate)}` : "",
      `Uso de imagem: ${imageLabel(data.imageAuthorization)}.`,
    ].filter(Boolean);
    return lines.join(" | ");
  }

  function existingStudentFor(data = {}) {
    try {
      return state.students.find((student) => normalized(student.name) === normalized(data.childName) && (!data.birthDate || student.birthDate === data.birthDate));
    } catch {
      return null;
    }
  }

  async function prepareEnrollment(record) {
    const data = record.data || {};
    const existing = existingStudentFor(data);
    const message = existing
      ? `Já existe uma criança chamada ${existing.name} com esta data de nascimento. Os dados do pré-cadastro serão carregados para revisar o cadastro existente. Continuar?`
      : `Os dados de ${data.childName || "esta criança"} serão levados para o cadastro oficial. Depois, escolha as atividades, valores e clique em “Salvar criança”. Continuar?`;
    if (!confirm(message)) return;

    try { clearStudentForm(); } catch {}
    const values = {
      studentId: existing?.id || "",
      studentName: data.childName || "",
      birthDate: data.birthDate || "",
      guardianName: data.guardianName || "",
      guardianCpf: data.guardianCpf || "",
      guardianPhone: data.guardianPhone || "",
      emergencyPhone: data.emergencyPhone || "",
      guardianAddress: addressText(data),
      contractedHours: existing?.contractedHours || 0,
      monthlyValue: existing?.monthlyValue || 0,
      dueDay: existing?.dueDay || 10,
      studentStatus: existing?.status || "active",
      studentNotes: [existing?.notes || "", composeNotes(data, record.protocol)].filter(Boolean).join(" | "),
    };
    Object.entries(values).forEach(([id, value]) => {
      const field = document.getElementById(id);
      if (field) field.value = value;
    });
    try { renderStudentActivityPicker(existing?.activityItems || []); } catch {}

    sessionStorage.setItem(PENDING_ENROLLMENT_KEY, JSON.stringify({
      preregistrationId: record.id,
      protocol: record.protocol || "",
      existingStudentId: existing?.id || "",
      childName: data.childName || "",
      birthDate: data.birthDate || "",
    }));
    await setStatus(record, "reviewing", false);
    try { switchView("students"); } catch {
      document.querySelector('[data-view="students"]')?.click();
    }
    document.querySelector("#studentForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelector("#studentName")?.focus();
    toast("Dados carregados. Complete o plano e clique em Salvar criança para finalizar.");
  }

  async function setStatus(record, status, refresh = true, enrolledStudentId = "") {
    await request("PATCH", { id: record.id, status, enrolledStudentId });
    record.status = status;
    if (refresh) await loadRecords(true);
  }

  async function rejectRecord(record) {
    const name = record.data?.childName || "este pré-cadastro";
    if (!confirm(`Marcar o pré-cadastro de ${name} como recusado? Os dados continuarão arquivados para consulta.`)) return;
    await setStatus(record, "rejected");
    toast("Pré-cadastro marcado como recusado.");
  }

  function openEnrolledStudent(record) {
    const studentId = record.enrolled_student_id || "";
    let student = null;
    try {
      student = state.students.find((item) => item.id === studentId) || existingStudentFor(record.data || {});
    } catch {}
    if (!student) {
      toast("O cadastro ainda não foi baixado para este aparelho. Atualize os dados do Supabase.");
      return;
    }
    try { fillStudentForm(student); } catch {
      const editButton = document.querySelector(`[data-edit-student="${CSS.escape(student.id)}"]`);
      editButton?.click();
    }
    try { switchView("students"); } catch { document.querySelector('[data-view="students"]')?.click(); }
    document.querySelector("#studentForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function attachEnrollmentCompletion() {
    const form = document.querySelector("#studentForm");
    if (!form || form.dataset.preregCompletionAttached === "true") return;
    form.dataset.preregCompletionAttached = "true";
    form.addEventListener("submit", () => {
      const raw = sessionStorage.getItem(PENDING_ENROLLMENT_KEY);
      if (!raw) return;
      let pending;
      try { pending = JSON.parse(raw); } catch { return; }
      const requestedId = document.querySelector("#studentId")?.value || pending.existingStudentId || "";
      const childName = document.querySelector("#studentName")?.value.trim() || pending.childName || "";
      const birthDate = document.querySelector("#birthDate")?.value || pending.birthDate || "";

      window.setTimeout(async () => {
        let student;
        try {
          student = state.students.find((item) => requestedId && item.id === requestedId)
            || state.students.find((item) => normalized(item.name) === normalized(childName) && (!birthDate || item.birthDate === birthDate));
        } catch {}
        if (!student) return;
        try {
          await request("PATCH", {
            id: pending.preregistrationId,
            status: "enrolled",
            enrolledStudentId: student.id,
          });
          sessionStorage.removeItem(PENDING_ENROLLMENT_KEY);
          toast("Matrícula efetivada e pré-cadastro concluído.");
          loadRecords(true).catch(() => {});
        } catch (error) {
          console.error("Falha ao concluir pré-cadastro", error);
          toast("A criança foi salva, mas o pré-cadastro ainda precisa ser concluído. Abra Pré-cadastros e tente novamente.");
        }
      }, 150);
    }, true);
  }

  function initialize() {
    mount();
    const key = syncKey();
    if (key.length >= 6) loadRecords(true).catch(() => {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else window.setTimeout(initialize, 0);
})();
