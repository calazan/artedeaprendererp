// Redesign visual do Painel principal. Mantém o menu lateral e a navegação existentes.
(() => {
  if (window.__saberDashboardRedesignLoaded) return;
  window.__saberDashboardRedesignLoaded = true;

  const same = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();
  const esc = (value) => {
    try { return escapeHTML(value); } catch {
      return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    }
  };
  const attr = (value) => esc(value).replaceAll("`", "&#096;");

  function isDashboardActive(dashboard) {
    return dashboard?.classList.contains("is-active") === true;
  }

  function ensureStylesheet() {
    if (document.querySelector('link[data-dashboard-redesign-style]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "dashboard-redesign.css?v=1";
    link.dataset.dashboardRedesignStyle = "true";
    document.head.appendChild(link);
  }

  function todayISO() {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());
      const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
      return `${map.year}-${map.month}-${map.day}`;
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function dateFromIso(dateText) {
    const [year, month, day] = String(dateText || "").split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12));
  }

  function weekday(dateText) {
    return dateFromIso(dateText).getUTCDay();
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
    if (!task) return {};
    task.occurrences = task.occurrences && typeof task.occurrences === "object" && !Array.isArray(task.occurrences) ? task.occurrences : {};
    if (!task.occurrences[dateText] && create) task.occurrences[dateText] = {};
    return task.occurrences[dateText] || {};
  }

  function taskList() {
    try {
      state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
      return state.tasks;
    } catch {
      return [];
    }
  }

  function todayTasks() {
    const dateText = todayISO();
    const priorityRank = { high: 0, normal: 1, low: 2 };
    return taskList()
      .filter((task) => recursOn(task, dateText) && occurrenceState(task, dateText).status !== "completed")
      .sort((a, b) => (priorityRank[a.priority || "normal"] ?? 1) - (priorityRank[b.priority || "normal"] ?? 1)
        || String(a.time || "23:59").localeCompare(String(b.time || "23:59"))
        || String(a.title || "").localeCompare(String(b.title || ""), "pt-BR"));
  }

  function ensureLayout() {
    ensureStylesheet();
    const dashboard = document.querySelector("#dashboardView");
    if (!dashboard || !isDashboardActive(dashboard)) return null;
    dashboard.classList.add("dashboard-redesigned");

    const hero = dashboard.querySelector(".brand-hero-banner");
    const heroImage = hero?.querySelector(".hero-banner-only");
    if (heroImage && !heroImage.dataset.dashboardBannerApplied) {
      heroImage.src = "dashboard-banner.svg?v=1";
      heroImage.alt = "Arte de Aprender ERP — Organização simples para sua rotina";
      heroImage.dataset.dashboardBannerApplied = "true";
    }

    const legacyGrid = dashboard.querySelector(".dashboard-grid");
    const attendancePanel = legacyGrid?.querySelector(".panel:first-child") || dashboard.querySelector("#todayPresent")?.closest(".panel");
    const cashPanel = dashboard.querySelector("#metricCash")?.closest(".panel");
    const alertPanel = dashboard.querySelector("#alertsList")?.closest(".panel");
    const metricGrid = dashboard.querySelector(".metric-grid");
    const oldTaskCard = dashboard.querySelector("#taskDashboardCard");

    cashPanel?.classList.add("dashboard-hidden-legacy");
    oldTaskCard?.classList.add("dashboard-hidden-legacy");
    legacyGrid?.classList.add("dashboard-hidden-legacy");

    let layout = dashboard.querySelector("#dashboardRedesignLayout");
    if (!layout) {
      layout = document.createElement("div");
      layout.id = "dashboardRedesignLayout";
      layout.className = "dashboard-redesign-layout";
      layout.innerHTML = '<div class="dashboard-redesign-left" id="dashboardRedesignLeft"></div><div class="dashboard-redesign-right" id="dashboardRedesignRight"></div>';
      if (metricGrid) metricGrid.insertAdjacentElement("beforebegin", layout);
      else hero?.insertAdjacentElement("afterend", layout);
    }

    const left = layout.querySelector("#dashboardRedesignLeft");
    const right = layout.querySelector("#dashboardRedesignRight");

    if (attendancePanel && attendancePanel.parentElement !== left) {
      attendancePanel.classList.add("dashboard-attendance-card");
      left?.appendChild(attendancePanel);
    }
    if (alertPanel && alertPanel.parentElement !== left) {
      alertPanel.classList.add("dashboard-alerts-card");
      left?.appendChild(alertPanel);
    }

    let taskPanel = dashboard.querySelector("#dashboardPriorityTasks");
    if (!taskPanel) {
      taskPanel = document.createElement("section");
      taskPanel.id = "dashboardPriorityTasks";
      taskPanel.className = "panel glass-card dashboard-priority-panel";
      right?.appendChild(taskPanel);
    } else if (taskPanel.parentElement !== right) {
      right?.appendChild(taskPanel);
    }

    if (metricGrid) {
      metricGrid.classList.add("dashboard-bottom-metrics");
      if (metricGrid.parentElement !== dashboard) dashboard.appendChild(metricGrid);
      else if (layout.nextElementSibling !== metricGrid) dashboard.appendChild(metricGrid);
    }

    return { dashboard, taskPanel };
  }

  function priorityMeta(priority) {
    if (priority === "high") return { key: "high", label: "Alta prioridade", icon: "⚑" };
    if (priority === "low") return { key: "low", label: "Baixa prioridade", icon: "⚑" };
    return { key: "medium", label: "Média prioridade", icon: "⚑" };
  }

  function renderPriorityGroup(tasks, priority) {
    const meta = priorityMeta(priority);
    const rows = tasks.filter((task) => (priority === "medium" ? !["high", "low"].includes(task.priority) : task.priority === priority));
    const visible = rows.slice(0, 4);
    const body = visible.length
      ? visible.map((task) => `<div class="dashboard-priority-row"><span class="dashboard-priority-time">${esc(task.time || "--:--")}</span><div class="dashboard-priority-title"><strong>${esc(task.title || "Tarefa")}</strong>${task.assignee ? `<small>${esc(task.assignee)}</small>` : ""}</div><button type="button" class="dashboard-priority-complete" data-dashboard-complete-task="${attr(task.id)}" title="Marcar como concluída">✓</button></div>`).join("")
      : '<div class="dashboard-priority-empty">Nenhuma tarefa pendente nesta prioridade.</div>';
    const more = rows.length > visible.length ? `<div class="dashboard-priority-more">+ ${rows.length - visible.length} tarefa(s)</div>` : "";
    return `<section class="dashboard-priority-group is-${meta.key}"><div class="dashboard-priority-head"><span>${meta.icon} ${meta.label}</span><span>${rows.length}</span></div><div class="dashboard-priority-body">${body}${more}</div></section>`;
  }

  function renderPriorityTasks() {
    const ensured = ensureLayout();
    const panel = ensured?.taskPanel;
    if (!panel) return;
    const tasks = todayTasks();
    panel.innerHTML = `<div class="panel-head"><div><h2>Tarefas de hoje</h2><span>${tasks.length} pendente(s) para hoje</span></div></div><div class="dashboard-priority-groups">${renderPriorityGroup(tasks, "high")}${renderPriorityGroup(tasks, "medium")}${renderPriorityGroup(tasks, "low")}</div><div class="dashboard-priority-footer"><button type="button" class="small" data-dashboard-open-tasks>Ver todas em Tarefas e Rotina</button></div>`;

    panel.querySelectorAll("[data-dashboard-complete-task]").forEach((button) => {
      button.addEventListener("click", () => completeTask(button.dataset.dashboardCompleteTask));
    });
    panel.querySelector("[data-dashboard-open-tasks]")?.addEventListener("click", () => {
      try { switchView("tasks"); } catch {}
      document.querySelector('.tab[data-view="tasks"]')?.click?.();
    });
  }

  async function completeTask(id) {
    const task = taskList().find((item) => same(item.id, id));
    if (!task) return;
    const dateText = todayISO();
    const occurrence = occurrenceState(task, dateText, true);
    occurrence.status = "completed";
    occurrence.completedAt = new Date().toISOString();
    occurrence.snoozedUntil = "";
    task.updatedAt = new Date().toISOString();
    try { saveState(); } catch {}
    renderPriorityTasks();
    try { showToast("Tarefa concluída."); } catch {}

    const key = String(state?.settings?.remoteSync?.syncKey || "").trim();
    if (key.length < 32 || !navigator.onLine) return;
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sync-key": key },
        body: JSON.stringify({ task }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.warn("Não foi possível sincronizar a conclusão da tarefa agora.", error);
    }
  }

  function refresh() {
    ensureLayout();
    renderPriorityTasks();
  }

  function init() {
    ensureStylesheet();
    refresh();
    setTimeout(refresh, 700);
    setTimeout(refresh, 1800);
    setInterval(refresh, 8000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
