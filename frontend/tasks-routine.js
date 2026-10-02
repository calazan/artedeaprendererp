// Tarefas e Rotina do Arte de Aprender ERP: agenda operacional, recorrência e notificações push.
(() => {
  if (window.__saberTasksRoutineLoaded) return;
  window.__saberTasksRoutineLoaded = true;

  let activeFilter = "today";
  let editingId = "";
  let pullInFlight = false;
  let notificationStatusText = "Verificando notificações...";
  const deletedRemoteIds = new Set();
  const LOCAL_ALERT_PREFIX = "smg.task.local-alert.";

  const esc = (value) => {
    try { return escapeHTML(value); } catch {
      return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    }
  };
  const attr = (value) => esc(value).replaceAll("`", "&#096;");
  const makeId = () => {
    try { return uid(); } catch { return globalThis.crypto?.randomUUID?.() || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  };
  const today = () => {
    try { return todayISO(); } catch {
      const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
      return formatter.format(new Date());
    }
  };
  const nowIso = () => new Date().toISOString();

  function tasks() {
    state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
    return state.tasks;
  }

  function same(a, b) {
    return String(a ?? "").trim() === String(b ?? "").trim();
  }

  function dateFromIso(dateText) {
    const [year, month, day] = String(dateText || "").split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12));
  }

  function addDays(dateText, amount) {
    const date = dateFromIso(dateText);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  }

  function weekday(dateText) {
    return dateFromIso(dateText).getUTCDay();
  }

  function formatDate(dateText) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ""))) return "-";
    const [year, month, day] = String(dateText).split("-");
    return `${day}/${month}/${year}`;
  }

  function formatShortDate(dateText) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ""))) return "-";
    const [year, month, day] = String(dateText).split("-");
    return `${day}/${month}`;
  }

  function recurrenceLabel(task) {
    const map = {
      none: "Não repete",
      daily: "Todos os dias",
      weekdays: "Dias úteis",
      weekly: "Semanal",
      custom: "Dias escolhidos",
      monthly: "Mensal",
    };
    return map[task.recurrence || "none"] || "Não repete";
  }

  function priorityLabel(priority) {
    return priority === "high" ? "Alta" : priority === "low" ? "Baixa" : "Normal";
  }

  function taskTypeLabel(task) {
    return task.type === "appointment" ? "Compromisso" : "Tarefa";
  }

  function reminderLabel(minutes) {
    const value = Number(minutes || 0);
    if (value === 0) return "No horário";
    if (value === 1440) return "1 dia antes";
    if (value >= 60) return `${value / 60}h antes`;
    return `${value} min antes`;
  }

  function recursOn(task, dateText) {
    if (!task?.active || !task.date || dateText < task.date) return false;
    if (task.recurrenceUntil && dateText > task.recurrenceUntil) return false;
    const recurrence = task.recurrence || "none";
    if (recurrence === "none") return dateText === task.date;
    if (recurrence === "daily") return true;
    const day = weekday(dateText);
    if (recurrence === "weekdays") return day >= 1 && day <= 5;
    if (recurrence === "weekly") return day === weekday(task.date);
    if (recurrence === "custom") return Array.isArray(task.weekdays) && task.weekdays.map(Number).includes(day);
    if (recurrence === "monthly") return Number(dateText.slice(8, 10)) === Number(task.date.slice(8, 10));
    return false;
  }

  function occurrenceState(task, dateText, create = false) {
    task.occurrences = task.occurrences && typeof task.occurrences === "object" && !Array.isArray(task.occurrences) ? task.occurrences : {};
    if (!task.occurrences[dateText] && create) task.occurrences[dateText] = {};
    return task.occurrences[dateText] || {};
  }

  function isComplete(task, dateText) {
    return occurrenceState(task, dateText).status === "completed";
  }

  function localDateTime(dateText, timeText) {
    const [year, month, day] = String(dateText).split("-").map(Number);
    const [hour, minute] = String(timeText || "00:00").split(":").map(Number);
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  function isOverdue(task, dateText) {
    return !isComplete(task, dateText) && localDateTime(dateText, task.time).getTime() < Date.now();
  }

  function occurrence(task, dateText) {
    const stateValue = occurrenceState(task, dateText);
    return {
      task,
      date: dateText,
      completed: stateValue.status === "completed",
      overdue: isOverdue(task, dateText),
      snoozedUntil: stateValue.snoozedUntil || "",
    };
  }

  function occurrencesForToday() {
    const dateText = today();
    return tasks().filter((task) => recursOn(task, dateText)).map((task) => occurrence(task, dateText)).sort(sortOccurrences);
  }

  function upcomingOccurrences() {
    const rows = [];
    let dateText = addDays(today(), 1);
    for (let index = 0; index < 31; index += 1) {
      tasks().forEach((task) => {
        if (recursOn(task, dateText) && !isComplete(task, dateText)) rows.push(occurrence(task, dateText));
      });
      dateText = addDays(dateText, 1);
      if (rows.length >= 150) break;
    }
    return rows.sort(sortOccurrences).slice(0, 150);
  }

  function overdueOccurrences() {
    const rows = [];
    let dateText = addDays(today(), -30);
    for (let index = 0; index <= 30; index += 1) {
      tasks().forEach((task) => {
        if (recursOn(task, dateText) && isOverdue(task, dateText)) rows.push(occurrence(task, dateText));
      });
      dateText = addDays(dateText, 1);
    }
    tasks().forEach((task) => {
      if (recursOn(task, today()) && isOverdue(task, today())) rows.push(occurrence(task, today()));
    });
    const unique = new Map(rows.map((row) => [`${row.task.id}|${row.date}`, row]));
    return [...unique.values()].sort(sortOccurrences);
  }

  function completedOccurrences() {
    const rows = [];
    tasks().forEach((task) => {
      Object.entries(task.occurrences || {}).forEach(([dateText, value]) => {
        if (value?.status === "completed") rows.push(occurrence(task, dateText));
      });
    });
    return rows.sort((a, b) => String(b.date + b.task.time).localeCompare(String(a.date + a.task.time))).slice(0, 200);
  }

  function sortOccurrences(a, b) {
    return String(`${a.date}T${a.task.time || "00:00"}`).localeCompare(String(`${b.date}T${b.task.time || "00:00"}`))
      || String(a.task.title || "").localeCompare(String(b.task.title || ""), "pt-BR");
  }

  function selectedOccurrences() {
    if (activeFilter === "upcoming") return upcomingOccurrences();
    if (activeFilter === "overdue") return overdueOccurrences();
    if (activeFilter === "completed") return completedOccurrences();
    return occurrencesForToday();
  }

  function ensureStyles() {
    if (document.querySelector("#tasksRoutineStyles")) return;
    const style = document.createElement("style");
    style.id = "tasksRoutineStyles";
    style.textContent = `
      .tab[data-view="tasks"]{background:linear-gradient(135deg,#6f3d93,#9b5eaa)!important;color:#fff!important;border-color:rgba(255,255,255,.22)!important}
      .tab[data-view="tasks"].is-active{background:linear-gradient(135deg,#563079,#7f4794)!important}
      #tasksView.is-active{display:block}
      .tasks-shell{display:grid;gap:16px}
      .task-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
      .task-stat{padding:13px 14px;border:1px solid rgba(126,82,142,.16);border-radius:15px;background:rgba(255,255,255,.64)}
      .task-stat span{display:block;font-size:11px;color:var(--muted,#64748b)}.task-stat strong{display:block;font-size:22px;margin-top:3px}.task-stat.warn{background:rgba(254,243,199,.62)}.task-stat.bad{background:rgba(254,226,226,.62)}.task-stat.good{background:rgba(220,252,231,.62)}
      .task-push-card{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center;padding:15px 16px;border-radius:16px;border:1px solid rgba(126,82,142,.16);background:linear-gradient(135deg,rgba(247,241,250,.9),rgba(255,251,225,.75))}
      .task-push-card h3{margin:0 0 4px}.task-push-card p{margin:0;color:var(--muted,#64748b);font-size:12px}.task-push-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .task-form{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px;align-items:end}.task-form label{display:grid;gap:6px;font-size:12px;font-weight:750}.task-form .span-2{grid-column:span 2}.task-form .span-4{grid-column:span 4}.task-form textarea{min-height:76px;resize:vertical}
      .task-weekdays{display:flex;gap:6px;flex-wrap:wrap}.task-weekdays label{display:flex;align-items:center;gap:5px;padding:7px 9px;border:1px solid rgba(148,163,184,.25);border-radius:10px;background:#fff;font-size:11px}.task-weekdays input{width:auto}
      .task-form-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}
      .task-filters{display:flex;gap:8px;flex-wrap:wrap}.task-filter{box-shadow:none!important;background:rgba(126,82,142,.08)!important;color:#6b3f7d!important;border:1px solid rgba(126,82,142,.18)!important}.task-filter.is-active{background:linear-gradient(135deg,#6f3d93,#9b5eaa)!important;color:#fff!important}
      .task-list{display:grid;gap:10px}.task-card{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:start;padding:13px 14px;border:1px solid rgba(148,163,184,.22);border-radius:15px;background:rgba(255,255,255,.72)}.task-card.is-overdue{border-color:rgba(220,38,38,.24);background:rgba(254,242,242,.76)}.task-card.is-complete{opacity:.7;background:rgba(240,253,244,.72)}
      .task-check-button{width:32px;height:32px;padding:0;border-radius:10px;display:grid;place-items:center;font-weight:900}.task-card.is-complete .task-check-button{background:#16a34a!important;color:#fff!important}
      .task-main h3{margin:0;font-size:15px}.task-card.is-complete .task-main h3{text-decoration:line-through}.task-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}.task-chip{display:inline-flex;padding:4px 7px;border-radius:999px;font-size:10px;font-weight:800;background:rgba(99,102,241,.08);color:#4f46e5}.task-chip.high{background:#fee2e2;color:#b91c1c}.task-chip.appointment{background:#e0f2fe;color:#0369a1}.task-chip.overdue{background:#fee2e2;color:#b91c1c}.task-chip.snoozed{background:#fef3c7;color:#92400e}
      .task-notes{margin:8px 0 0;color:var(--muted,#64748b);font-size:12px;white-space:pre-wrap}.task-checklist{display:grid;gap:5px;margin-top:8px}.task-checklist label{display:flex;gap:7px;align-items:center;font-size:12px;font-weight:600}.task-checklist input{width:auto}
      .task-card-actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;max-width:220px}.task-card-actions button{padding:6px 8px;font-size:10px}
      .task-empty{padding:28px;text-align:center;border:1px dashed rgba(148,163,184,.35);border-radius:15px;color:var(--muted,#64748b)}
      #taskDashboardCard{margin-top:16px}.task-dashboard-line{display:flex;justify-content:space-between;gap:12px;align-items:center}.task-dashboard-counts{display:flex;gap:14px;flex-wrap:wrap}.task-dashboard-counts span{font-size:12px}.task-dashboard-counts strong{font-size:16px;margin-right:4px}
      @media(max-width:900px){.task-form{grid-template-columns:repeat(2,minmax(0,1fr))}.task-summary-grid{grid-template-columns:repeat(2,1fr)}.task-card{grid-template-columns:auto 1fr}.task-card-actions{grid-column:2;justify-content:flex-start;max-width:none}.task-push-card{grid-template-columns:1fr}.task-push-actions{justify-content:flex-start}}
      @media(max-width:640px){.task-form,.task-summary-grid{grid-template-columns:1fr}.task-form .span-2,.task-form .span-4{grid-column:auto}.task-form-actions{justify-content:flex-start}.task-card{grid-template-columns:auto 1fr}.task-dashboard-line{display:grid}.task-push-actions button{flex:1 1 auto}}
    `;
    document.head.appendChild(style);
  }

  function mountView() {
    ensureStyles();
    let tab = document.querySelector('.tab[data-view="tasks"]');
    if (!tab) {
      tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab";
      tab.dataset.view = "tasks";
      tab.textContent = "Tarefas e Rotina";
      const agendaTab = document.querySelector('.tab[data-view="agenda"]');
      agendaTab?.insertAdjacentElement("afterend", tab);
      tab.addEventListener("click", () => {
        switchView("tasks");
        renderTasksView();
      });
    }

    let view = document.querySelector("#tasksView");
    if (!view) {
      view = document.createElement("section");
      view.className = "view";
      view.id = "tasksView";
      const agendaView = document.querySelector("#agendaView");
      agendaView?.insertAdjacentElement("afterend", view);
    }

    try {
      views.tasks = view;
      titles.tasks = "Tarefas e Rotina";
    } catch (error) {
      console.warn("Não foi possível registrar Tarefas e Rotina no roteador.", error);
    }
    mountDashboardCard();
  }

  function mountDashboardCard() {
    if (document.querySelector("#taskDashboardCard")) return;
    const alerts = document.querySelector("#alertsList")?.closest?.(".panel");
    if (!alerts) return;
    const card = document.createElement("section");
    card.className = "panel glass-card";
    card.id = "taskDashboardCard";
    card.innerHTML = `<div class="panel-head"><div><h2>Tarefas de hoje</h2><span>Rotina operacional do Arte de Aprender</span></div><button type="button" class="small" data-open-tasks>Abrir tarefas</button></div><div class="task-dashboard-line"><div class="task-dashboard-counts" id="taskDashboardCounts"></div></div>`;
    alerts.insertAdjacentElement("beforebegin", card);
    card.querySelector("[data-open-tasks]")?.addEventListener("click", () => {
      switchView("tasks");
      renderTasksView();
    });
  }

  function renderDashboardSummary() {
    mountDashboardCard();
    const target = document.querySelector("#taskDashboardCounts");
    if (!target) return;
    const rows = occurrencesForToday();
    const pending = rows.filter((row) => !row.completed).length;
    const overdue = rows.filter((row) => row.overdue).length;
    const completed = rows.filter((row) => row.completed).length;
    target.innerHTML = `<span><strong>${pending}</strong>pendentes</span><span><strong>${overdue}</strong>atrasadas</span><span><strong>${completed}</strong>concluídas</span>`;
  }

  function statusCounts() {
    const todayRows = occurrencesForToday();
    return {
      pending: todayRows.filter((row) => !row.completed).length,
      overdue: overdueOccurrences().length,
      upcoming: upcomingOccurrences().length,
      completed: completedOccurrences().filter((row) => row.date === today()).length,
    };
  }

  function recurrenceOptions(value) {
    const options = [
      ["none", "Não repetir"], ["daily", "Todos os dias"], ["weekdays", "Dias úteis"], ["weekly", "Semanal"], ["custom", "Dias escolhidos"], ["monthly", "Mensal"],
    ];
    return options.map(([id, label]) => `<option value="${id}" ${value === id ? "selected" : ""}>${label}</option>`).join("");
  }

  function reminderOptions(value) {
    const options = [[0,"No horário"],[5,"5 min antes"],[10,"10 min antes"],[15,"15 min antes"],[30,"30 min antes"],[60,"1h antes"],[120,"2h antes"],[1440,"1 dia antes"]];
    return options.map(([minutes, label]) => `<option value="${minutes}" ${Number(value) === minutes ? "selected" : ""}>${label}</option>`).join("");
  }

  function weekdayControls(selected = []) {
    const labels = [[1,"Seg"],[2,"Ter"],[3,"Qua"],[4,"Qui"],[5,"Sex"],[6,"Sáb"],[0,"Dom"]];
    const selectedSet = new Set((selected || []).map(Number));
    return labels.map(([id, label]) => `<label><input type="checkbox" name="weekday" value="${id}" ${selectedSet.has(id) ? "checked" : ""}>${label}</label>`).join("");
  }

  function taskFormHtml() {
    const task = tasks().find((item) => same(item.id, editingId)) || {};
    const checklistText = (task.checklist || []).map((item) => item.text).join("\n");
    return `<section class="panel glass-card">
      <div class="panel-head"><div><h2>${task.id ? "Editar tarefa" : "Nova tarefa / compromisso"}</h2><span>Cadastre o que precisa ser feito e quando deseja ser avisado.</span></div></div>
      <form class="task-form" id="taskRoutineForm">
        <input type="hidden" name="id" value="${attr(task.id || "")}">
        <label>Tipo<select name="type"><option value="task" ${task.type !== "appointment" ? "selected" : ""}>Tarefa</option><option value="appointment" ${task.type === "appointment" ? "selected" : ""}>Compromisso</option></select></label>
        <label class="span-2">Título<input name="title" maxlength="200" value="${attr(task.title || "")}" placeholder="Ex.: Conferir pagamentos" required></label>
        <label>Responsável<input name="assignee" maxlength="120" value="${attr(task.assignee || "")}" placeholder="Ex.: Manu"></label>
        <label>Data inicial<input name="date" type="date" value="${attr(task.date || today())}" required></label>
        <label>Horário<input name="time" type="time" value="${attr(task.time || "08:00")}" required></label>
        <label>Prioridade<select name="priority"><option value="low" ${task.priority === "low" ? "selected" : ""}>Baixa</option><option value="normal" ${!task.priority || task.priority === "normal" ? "selected" : ""}>Normal</option><option value="high" ${task.priority === "high" ? "selected" : ""}>Alta</option></select></label>
        <label>Lembrete<select name="reminderMinutes">${reminderOptions(task.reminderMinutes ?? 10)}</select></label>
        <label>Repetição<select name="recurrence">${recurrenceOptions(task.recurrence || "none")}</select></label>
        <label>Repetir até<input name="recurrenceUntil" type="date" value="${attr(task.recurrenceUntil || "")}"><small>Opcional</small></label>
        <div class="span-2" data-task-weekdays-wrap style="${task.recurrence === "custom" ? "" : "display:none"}"><span style="font-size:12px;font-weight:750;display:block;margin-bottom:6px">Dias da semana</span><div class="task-weekdays">${weekdayControls(task.weekdays || [])}</div></div>
        <label class="span-2">Observações<textarea name="notes" maxlength="3000" placeholder="Informações importantes...">${esc(task.notes || "")}</textarea></label>
        <label class="span-2">Checklist<textarea name="checklistText" placeholder="Um item por linha">${esc(checklistText)}</textarea><small>Cada linha vira um item marcável.</small></label>
        <div class="span-4 task-form-actions"><button type="submit">${task.id ? "Salvar alterações" : "Adicionar tarefa"}</button>${task.id ? '<button type="button" class="secondary" data-task-cancel-edit>Cancelar</button>' : ""}</div>
      </form>
    </section>`;
  }

  function notificationCardHtml() {
    return `<div class="task-push-card"><div><h3>Notificações no celular</h3><p id="taskPushStatus">${esc(notificationStatusText)}</p></div><div class="task-push-actions"><button type="button" class="small" data-task-enable-push>Ativar neste aparelho</button><button type="button" class="small secondary" data-task-test-push>Testar aviso</button><button type="button" class="small secondary" data-task-disable-push>Desativar</button></div></div>`;
  }

  function taskCardHtml(row) {
    const task = row.task;
    const stateValue = occurrenceState(task, row.date);
    const doneIds = new Set(Array.isArray(stateValue.checklistDone) ? stateValue.checklistDone : []);
    const snoozed = stateValue.snoozedUntil && new Date(stateValue.snoozedUntil).getTime() > Date.now();
    const checklist = (task.checklist || []).length ? `<div class="task-checklist">${task.checklist.map((item) => `<label><input type="checkbox" data-task-checkitem="${attr(task.id)}" data-task-date="${attr(row.date)}" value="${attr(item.id)}" ${doneIds.has(item.id) ? "checked" : ""}>${esc(item.text)}</label>`).join("")}</div>` : "";
    const snoozeLabel = snoozed ? `<span class="task-chip snoozed">Adiado até ${new Date(stateValue.snoozedUntil).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>` : "";
    return `<article class="task-card ${row.completed ? "is-complete" : ""} ${row.overdue ? "is-overdue" : ""}">
      <button type="button" class="task-check-button ${row.completed ? "secondary" : ""}" data-task-toggle="${attr(task.id)}" data-task-date="${attr(row.date)}" title="${row.completed ? "Reabrir" : "Concluir"}">${row.completed ? "✓" : "○"}</button>
      <div class="task-main"><h3>${esc(task.title)}</h3><div class="task-meta"><span class="task-chip ${task.type === "appointment" ? "appointment" : ""}">${esc(taskTypeLabel(task))}</span><span class="task-chip">${formatShortDate(row.date)} · ${esc(task.time)}</span><span class="task-chip ${task.priority === "high" ? "high" : ""}">${esc(priorityLabel(task.priority))}</span>${task.assignee ? `<span class="task-chip">${esc(task.assignee)}</span>` : ""}${task.recurrence && task.recurrence !== "none" ? `<span class="task-chip">${esc(recurrenceLabel(task))}</span>` : ""}${row.overdue ? '<span class="task-chip overdue">Atrasada</span>' : ""}${snoozeLabel}</div>${task.notes ? `<p class="task-notes">${esc(task.notes)}</p>` : ""}${checklist}</div>
      <div class="task-card-actions">${!row.completed && row.date === today() ? `<button type="button" class="small secondary" data-task-snooze="10" data-task-id="${attr(task.id)}" data-task-date="${attr(row.date)}">+10 min</button><button type="button" class="small secondary" data-task-snooze="30" data-task-id="${attr(task.id)}" data-task-date="${attr(row.date)}">+30 min</button>` : ""}<button type="button" class="small secondary" data-task-edit="${attr(task.id)}">Editar</button><button type="button" class="small danger" data-task-delete="${attr(task.id)}">Excluir</button></div>
    </article>`;
  }

  function renderTasksView() {
    mountView();
    const view = document.querySelector("#tasksView");
    if (!view) return;
    const counts = statusCounts();
    const rows = selectedOccurrences();
    const filterLabels = [["today","Hoje"],["upcoming","Próximas"],["overdue","Atrasadas"],["completed","Concluídas"]];
    view.innerHTML = `<div class="tasks-shell">
      <div class="task-summary-grid"><div class="task-stat"><span>Pendentes hoje</span><strong>${counts.pending}</strong></div><div class="task-stat bad"><span>Atrasadas</span><strong>${counts.overdue}</strong></div><div class="task-stat warn"><span>Próximas 30 dias</span><strong>${counts.upcoming}</strong></div><div class="task-stat good"><span>Concluídas hoje</span><strong>${counts.completed}</strong></div></div>
      ${notificationCardHtml()}
      ${taskFormHtml()}
      <section class="panel glass-card"><div class="panel-head"><div><h2>Minha rotina</h2><span>Tarefas sincronizadas entre seus aparelhos.</span></div><div class="task-filters">${filterLabels.map(([id,label]) => `<button type="button" class="small task-filter ${activeFilter === id ? "is-active" : ""}" data-task-filter="${id}">${label}</button>`).join("")}</div></div><div class="task-list">${rows.length ? rows.map(taskCardHtml).join("") : `<div class="task-empty"><strong>Nada por aqui.</strong><br>${activeFilter === "today" ? "Cadastre uma tarefa acima para começar sua rotina." : "Nenhum item neste filtro."}</div>`}</div></section>
    </div>`;
    bindTaskView();
    renderDashboardSummary();
    refreshPushStatus();
  }

  function checklistFromText(text, existing = []) {
    const oldByText = new Map((existing || []).map((item) => [String(item.text || "").trim().toLowerCase(), item]));
    return [...new Set(String(text || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].slice(0, 50).map((item) => {
      const old = oldByText.get(item.toLowerCase());
      return { id: old?.id || makeId(), text: item };
    });
  }

  async function handleTaskSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = String(form.elements.id?.value || "").trim() || makeId();
    const existing = tasks().find((item) => same(item.id, id));
    const title = String(form.elements.title?.value || "").trim();
    const date = String(form.elements.date?.value || "");
    const time = String(form.elements.time?.value || "");
    if (!title || !date || !time) return showToast("Informe título, data e horário.");
    const recurrence = String(form.elements.recurrence?.value || "none");
    const weekdays = [...form.querySelectorAll('input[name="weekday"]:checked')].map((item) => Number(item.value));
    if (recurrence === "custom" && !weekdays.length) return showToast("Escolha pelo menos um dia da semana.");
    const task = {
      ...(existing || {}),
      id,
      title,
      type: form.elements.type?.value === "appointment" ? "appointment" : "task",
      date,
      time,
      assignee: String(form.elements.assignee?.value || "").trim(),
      priority: String(form.elements.priority?.value || "normal"),
      recurrence,
      weekdays,
      recurrenceUntil: String(form.elements.recurrenceUntil?.value || ""),
      reminderMinutes: Number(form.elements.reminderMinutes?.value || 0),
      timezone: "America/Sao_Paulo",
      notes: String(form.elements.notes?.value || "").trim(),
      checklist: checklistFromText(form.elements.checklistText?.value || "", existing?.checklist || []),
      occurrences: existing?.occurrences || {},
      active: true,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso(),
      syncPending: false,
    };
    upsertLocalTask(task);
    editingId = "";
    saveState();
    renderTasksView();
    const remoteOk = await pushTask(task);
    showToast(remoteOk ? "Tarefa salva e sincronizada." : "Tarefa salva neste aparelho; a sincronização será tentada novamente.");
  }

  function upsertLocalTask(task) {
    const index = tasks().findIndex((item) => same(item.id, task.id));
    if (index >= 0) tasks()[index] = task;
    else tasks().push(task);
  }

  async function updateTask(task, toastMessage = "Tarefa atualizada.") {
    task.updatedAt = nowIso();
    task.syncPending = false;
    upsertLocalTask(task);
    saveState();
    renderTasksView();
    const remoteOk = await pushTask(task);
    if (!remoteOk) {
      task.syncPending = true;
      saveState();
    }
    if (toastMessage) showToast(remoteOk ? toastMessage : `${toastMessage} Sincronização pendente.`);
  }

  function bindTaskView() {
    const form = document.querySelector("#taskRoutineForm");
    form?.addEventListener("submit", handleTaskSubmit);
    form?.elements.recurrence?.addEventListener("change", () => {
      const wrap = form.querySelector("[data-task-weekdays-wrap]");
      if (wrap) wrap.style.display = form.elements.recurrence.value === "custom" ? "" : "none";
    });
    document.querySelector("[data-task-cancel-edit]")?.addEventListener("click", () => { editingId = ""; renderTasksView(); });
    document.querySelectorAll("[data-task-filter]").forEach((button) => button.addEventListener("click", () => { activeFilter = button.dataset.taskFilter; renderTasksView(); }));
    document.querySelectorAll("[data-task-edit]").forEach((button) => button.addEventListener("click", () => { editingId = button.dataset.taskEdit; renderTasksView(); document.querySelector("#taskRoutineForm")?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
    document.querySelectorAll("[data-task-toggle]").forEach((button) => button.addEventListener("click", async () => {
      const task = tasks().find((item) => same(item.id, button.dataset.taskToggle));
      if (!task) return;
      const stateValue = occurrenceState(task, button.dataset.taskDate, true);
      const complete = stateValue.status !== "completed";
      stateValue.status = complete ? "completed" : "open";
      stateValue.completedAt = complete ? nowIso() : "";
      stateValue.snoozedUntil = "";
      await updateTask(task, complete ? "Tarefa concluída." : "Tarefa reaberta.");
    }));
    document.querySelectorAll("[data-task-snooze]").forEach((button) => button.addEventListener("click", async () => {
      const task = tasks().find((item) => same(item.id, button.dataset.taskId));
      if (!task) return;
      const minutes = Number(button.dataset.taskSnooze || 10);
      const stateValue = occurrenceState(task, button.dataset.taskDate, true);
      stateValue.snoozedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      stateValue.status = stateValue.status === "completed" ? "completed" : "open";
      await updateTask(task, `Lembrete adiado por ${minutes} minutos.`);
    }));
    document.querySelectorAll("[data-task-checkitem]").forEach((input) => input.addEventListener("change", async () => {
      const task = tasks().find((item) => same(item.id, input.dataset.taskCheckitem));
      if (!task) return;
      const stateValue = occurrenceState(task, input.dataset.taskDate, true);
      const done = new Set(Array.isArray(stateValue.checklistDone) ? stateValue.checklistDone : []);
      if (input.checked) done.add(input.value); else done.delete(input.value);
      stateValue.checklistDone = [...done];
      await updateTask(task, "");
    }));
    document.querySelectorAll("[data-task-delete]").forEach((button) => button.addEventListener("click", async () => {
      const task = tasks().find((item) => same(item.id, button.dataset.taskDelete));
      if (!task) return;
      const confirmed = typeof window.smgConfirm === "function"
        ? await window.smgConfirm({ title: "Excluir tarefa", message: `Excluir “${task.title}” e todas as recorrências futuras?`, confirmText: "Excluir", tone: "danger" })
        : window.confirm(`Excluir “${task.title}”?`);
      if (!confirmed) return;
      const ok = await deleteTaskRemote(task.id);
      if (!ok) return showToast("Não foi possível excluir no Neon. Tente novamente.");
      state.tasks = tasks().filter((item) => !same(item.id, task.id));
      if (editingId === task.id) editingId = "";
      saveState();
      renderTasksView();
      showToast("Tarefa excluída.");
    }));
    document.querySelector("[data-task-enable-push]")?.addEventListener("click", enablePush);
    document.querySelector("[data-task-disable-push]")?.addEventListener("click", disablePush);
    document.querySelector("[data-task-test-push]")?.addEventListener("click", testPush);
  }

  async function taskFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const response = await fetch(url, { ...options, headers, cache: "no-store", credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Falha HTTP ${response.status}`);
    return payload;
  }

  async function pushTask(task) {
    try {
      const payload = await taskFetch("/api/tasks", { method: "POST", body: JSON.stringify({ task }) });
      if (payload.task) {
        const local = tasks().find((item) => same(item.id, task.id));
        if (local) local.syncPending = false;
      }
      return true;
    } catch (error) {
      console.warn("Task sync pending", error);
      const local = tasks().find((item) => same(item.id, task.id));
      if (local) local.syncPending = true;
      return false;
    }
  }

  async function deleteTaskRemote(id) {
    try {
      await taskFetch("/api/tasks", { method: "DELETE", body: JSON.stringify({ id }) });
      return true;
    } catch (error) {
      console.warn("Task delete failed", error);
      return false;
    }
  }

  function taskUpdatedMs(task) {
    const parsed = Date.parse(String(task?.updatedAt || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async function pullTasks({ silent = true } = {}) {
    if (pullInFlight || !navigator.onLine) return false;
    pullInFlight = true;
    try {
      const payload = await taskFetch("/api/tasks");
      const remoteTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      const deletedIds = new Set(Array.isArray(payload.deletedIds) ? payload.deletedIds.map(String) : []);
      deletedIds.forEach((id) => deletedRemoteIds.add(id));
      const merged = new Map();
      tasks().forEach((task) => { if (!deletedIds.has(String(task.id))) merged.set(String(task.id), task); });
      remoteTasks.forEach((remote) => {
        const id = String(remote.id || "");
        if (!id || deletedIds.has(id)) return;
        const local = merged.get(id);
        if (!local || taskUpdatedMs(remote) >= taskUpdatedMs(local) || !local.syncPending) merged.set(id, { ...remote, syncPending: false });
      });
      state.tasks = [...merged.values()];
      saveState();
      for (const task of state.tasks.filter((item) => item.syncPending)) await pushTask(task);
      renderDashboardSummary();
      if (document.querySelector("#tasksView")?.classList.contains("is-active")) renderTasksView();
      return true;
    } catch (error) {
      if (!silent) showToast(`Não foi possível atualizar as tarefas: ${error.message}`);
      console.warn("Task pull failed", error);
      return false;
    } finally {
      pullInFlight = false;
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
  }

  async function currentPushSubscription() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  }

  function deviceLabel() {
    const platform = navigator.userAgentData?.platform || navigator.platform || "Aparelho";
    const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad/i.test(navigator.userAgent);
    return `${mobile ? "Celular" : "Computador"} · ${platform}`.slice(0, 150);
  }

  async function refreshPushStatus() {
    const element = document.querySelector("#taskPushStatus");
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      notificationStatusText = isIOS ? "No iPhone, adicione o Arte de Aprender à Tela de Início e abra pelo ícone para ativar os avisos." : "Este navegador não oferece notificações push para PWA.";
      if (element) element.textContent = notificationStatusText;
      return;
    }
    try {
      const subscription = await currentPushSubscription();
      if (Notification.permission === "denied") notificationStatusText = "Notificações bloqueadas nas configurações deste aparelho.";
      else if (subscription) notificationStatusText = "Notificações ativas neste aparelho. Os lembretes podem chegar mesmo com o app fechado.";
      else if (Notification.permission === "granted") notificationStatusText = "Permissão concedida; clique em “Ativar neste aparelho” para concluir a inscrição.";
      else notificationStatusText = "Clique em “Ativar neste aparelho” e permita as notificações quando o celular solicitar.";
    } catch {
      notificationStatusText = "Não foi possível verificar a inscrição de notificações.";
    }
    if (element) element.textContent = notificationStatusText;
  }

  async function enablePush() {
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Este aparelho não oferece Push Web neste modo. No iPhone, instale o PWA na Tela de Início.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("A permissão de notificações não foi concedida.");
      const config = await taskFetch("/api/task-push");
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
      }
      await taskFetch("/api/task-push", { method: "POST", body: JSON.stringify({ action: "subscribe", subscription: subscription.toJSON(), deviceLabel: deviceLabel() }) });
      notificationStatusText = "Notificações ativas neste aparelho. Os lembretes podem chegar mesmo com o app fechado.";
      refreshPushStatus();
      showToast("Notificações ativadas neste aparelho.");
    } catch (error) {
      showToast(error.message || "Não foi possível ativar as notificações.");
      notificationStatusText = error.message || "Falha ao ativar notificações.";
      refreshPushStatus();
    }
  }

  async function disablePush() {
    try {
      const subscription = await currentPushSubscription();
      if (!subscription) return showToast("As notificações já estão desativadas neste aparelho.");
      try { await taskFetch("/api/task-push", { method: "POST", body: JSON.stringify({ action: "unsubscribe", endpoint: subscription.endpoint }) }); } catch {}
      await subscription.unsubscribe();
      notificationStatusText = "Notificações desativadas neste aparelho.";
      refreshPushStatus();
      showToast("Notificações desativadas.");
    } catch (error) {
      showToast(error.message || "Não foi possível desativar as notificações.");
    }
  }

  async function testPush() {
    try {
      const subscription = await currentPushSubscription();
      if (!subscription) throw new Error("Ative as notificações neste aparelho primeiro.");
      await taskFetch("/api/task-push", { method: "POST", body: JSON.stringify({ action: "test", subscription: subscription.toJSON(), deviceLabel: deviceLabel() }) });
      showToast("Aviso de teste enviado. Ele deve aparecer em alguns segundos.");
    } catch (error) {
      showToast(error.message || "Não foi possível enviar o aviso de teste.");
    }
  }

  async function localReminderFallback() {
    if (!("Notification" in window) || Notification.permission !== "granted" || !("serviceWorker" in navigator)) return;
    try {
      if (await currentPushSubscription()) return;
    } catch {}
    const now = Date.now();
    const dateText = today();
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    if (!registration) return;
    for (const task of tasks()) {
      if (!recursOn(task, dateText) || isComplete(task, dateText)) continue;
      const stateValue = occurrenceState(task, dateText);
      const base = localDateTime(dateText, task.time).getTime() - Number(task.reminderMinutes || 0) * 60 * 1000;
      const snooze = stateValue.snoozedUntil ? Date.parse(stateValue.snoozedUntil) : 0;
      const scheduled = snooze > base ? snooze : base;
      if (now < scheduled || now - scheduled > 60 * 1000) continue;
      const key = `${LOCAL_ALERT_PREFIX}${task.id}.${dateText}.${scheduled}`;
      if (localStorage.getItem(key)) continue;
      localStorage.setItem(key, "1");
      await registration.showNotification(`Arte de Aprender · ${taskTypeLabel(task)}`, { body: `${task.time} — ${task.title}${task.assignee ? ` · ${task.assignee}` : ""}`, icon: "/app-icon-192.png?v=1", badge: "/favicon-96.png?v=1", tag: `smg-task-${task.id}-${dateText}`, data: { url: `/?smgView=tasks&task=${encodeURIComponent(task.id)}&date=${dateText}` } });
    }
  }

  function openFromUrl() {
    const params = new URLSearchParams(location.search);
    if (params.get("smgView") !== "tasks") return;
    setTimeout(() => {
      try { switchView("tasks"); renderTasksView(); } catch {}
      const id = params.get("task");
      if (id) editingId = "";
    }, 500);
  }

  function init() {
    try {
      mountView();
      renderDashboardSummary();
      renderTasksView();
      openFromUrl();
      setTimeout(() => pullTasks({ silent: true }), 1000);
      setInterval(() => pullTasks({ silent: true }), 90 * 1000);
      setInterval(() => { renderDashboardSummary(); localReminderFallback(); }, 30 * 1000);
      window.addEventListener("online", () => pullTasks({ silent: true }));
    } catch (error) {
      console.error("Falha ao iniciar Tarefas e Rotina", error);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
