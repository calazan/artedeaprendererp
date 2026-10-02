// Ajustes da área Tarefas e Rotina: lista de compras marcável e conclusão explícita.
(() => {
  if (window.__saberTasksShoppingAdjustmentsLoaded) return;
  window.__saberTasksShoppingAdjustmentsLoaded = true;

  const PUSH_LEGACY_PATH = "/api/task-push";
  const PUSH_CURRENT_PATH = "/api/tasks?action=push";

  function patchLegacyPushEndpoint() {
    if (window.__saberTaskPushEndpointPatched) return;
    window.__saberTaskPushEndpointPatched = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = function saberTaskFetchCompat(input, init) {
      try {
        if (typeof input === "string" && input.startsWith(PUSH_LEGACY_PATH)) {
          input = input.replace(PUSH_LEGACY_PATH, PUSH_CURRENT_PATH);
        } else if (input instanceof Request) {
          const url = new URL(input.url, location.href);
          if (url.pathname === PUSH_LEGACY_PATH) {
            url.pathname = "/api/tasks";
            url.searchParams.set("action", "push");
            input = new Request(url.href, input);
          }
        }
      } catch {}
      return originalFetch(input, init);
    };
  }

  const normalize = (value) => String(value || "").trim().toLowerCase();
  const same = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function purchaseItems(text) {
    const counts = new Map();
    return String(text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 80)
      .map((textValue) => {
        const normalized = normalize(textValue);
        const occurrence = (counts.get(normalized) || 0) + 1;
        counts.set(normalized, occurrence);
        return {
          key: `shop-${hashText(`${normalized}#${occurrence}`)}`,
          text: textValue,
        };
      });
  }

  function taskList() {
    try {
      state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
      return state.tasks;
    } catch {
      return [];
    }
  }

  function taskById(id) {
    return taskList().find((task) => same(task?.id, id));
  }

  function occurrenceState(task, dateText, create = false) {
    if (!task) return {};
    task.occurrences = task.occurrences && typeof task.occurrences === "object" && !Array.isArray(task.occurrences)
      ? task.occurrences
      : {};
    if (!task.occurrences[dateText] && create) task.occurrences[dateText] = {};
    return task.occurrences[dateText] || {};
  }

  async function persistTask(task) {
    if (!task) return false;
    task.updatedAt = new Date().toISOString();
    task.syncPending = false;
    try { saveState(); } catch {}

    if (!navigator.onLine) {
      task.syncPending = true;
      try { saveState(); } catch {}
      return false;
    }

    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ task }),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || `Falha HTTP ${response.status}`);
      task.syncPending = false;
      try { saveState(); } catch {}
      return true;
    } catch (error) {
      task.syncPending = true;
      try { saveState(); } catch {}
      console.warn("Lista de compras salva localmente; sincronização pendente.", error);
      return false;
    }
  }

  function setLabelText(label, text) {
    if (!label) return;
    const node = [...label.childNodes].find((item) => item.nodeType === Node.TEXT_NODE && item.textContent.trim());
    if (node && node.textContent.trim() !== text) node.textContent = text;
  }

  function patchForm() {
    const form = document.querySelector("#taskRoutineForm");
    if (!form) return;

    const notes = form.querySelector('textarea[name="notes"]');
    if (notes) {
      const label = notes.closest("label");
      setLabelText(label, "Lista de compras");
      if (notes.placeholder !== "Digite um produto por linha...") notes.placeholder = "Digite um produto por linha...";
      notes.setAttribute("aria-label", "Lista de compras, um produto por linha");
      let help = label?.querySelector("[data-shopping-help]");
      if (!help && label) {
        help = document.createElement("small");
        help.dataset.shoppingHelp = "1";
        help.textContent = "Digite um produto por linha. Depois você poderá marcar cada item como comprado.";
        label.appendChild(help);
      }
    }

    const checklist = form.querySelector('textarea[name="checklistText"]');
    if (checklist) {
      const label = checklist.closest("label");
      setLabelText(label, "Etapas da tarefa (opcional)");
      const help = label?.querySelector("small:not([data-shopping-help])");
      if (help && help.textContent !== "Use para etapas que não fazem parte da lista de compras.") {
        help.textContent = "Use para etapas que não fazem parte da lista de compras.";
      }
    }
  }

  function ensureStyles() {
    if (document.querySelector("#tasksShoppingAdjustmentsStyles")) return;
    const style = document.createElement("style");
    style.id = "tasksShoppingAdjustmentsStyles";
    style.textContent = `
      .task-shopping-list{margin-top:10px;padding:11px 12px;border:1px solid rgba(126,82,142,.16);border-radius:13px;background:rgba(250,247,252,.74)}
      .task-shopping-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:8px}
      .task-shopping-head strong{font-size:12px;color:#5f3972}.task-shopping-head span{font-size:10px;color:var(--muted,#64748b)}
      .task-shopping-items{display:grid;gap:6px}.task-shopping-item{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:9px;background:rgba(255,255,255,.72);font-size:12px;font-weight:650;cursor:pointer}
      .task-shopping-item input{width:auto;flex:0 0 auto}.task-shopping-item.is-bought span{text-decoration:line-through;opacity:.58}
      .task-complete-visible{font-size:11px!important;font-weight:850!important;padding:8px 11px!important;background:#16a34a!important;color:#fff!important;border-color:#15803d!important}
      .task-complete-visible.is-reopen{background:rgba(22,163,74,.08)!important;color:#166534!important;border-color:rgba(22,163,74,.25)!important}
      .task-card-actions .task-complete-visible{flex:1 1 100%;justify-content:center}
      .task-card.is-complete .task-shopping-list{opacity:.72}
      @media(max-width:640px){.task-shopping-head{align-items:flex-start}.task-card-actions .task-complete-visible{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function shoppingBlock(task, dateText, completed) {
    const items = purchaseItems(task?.notes || "");
    if (!items.length) return null;
    const occurrence = occurrenceState(task, dateText);
    const done = new Set(Array.isArray(occurrence.shoppingDone) ? occurrence.shoppingDone.map(String) : []);

    const block = document.createElement("div");
    block.className = "task-shopping-list";
    block.dataset.taskShoppingList = "1";
    block.innerHTML = `<div class="task-shopping-head"><strong>Lista de compras</strong><span data-shopping-progress></span></div><div class="task-shopping-items"></div>`;
    const itemWrap = block.querySelector(".task-shopping-items");

    items.forEach((item) => {
      const label = document.createElement("label");
      label.className = `task-shopping-item ${done.has(item.key) ? "is-bought" : ""}`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = done.has(item.key);
      input.disabled = completed;
      input.dataset.shoppingItem = item.key;
      input.dataset.taskId = String(task.id || "");
      input.dataset.taskDate = String(dateText || "");
      const text = document.createElement("span");
      text.textContent = item.text;
      label.append(input, text);
      itemWrap.appendChild(label);
    });

    const bought = items.filter((item) => done.has(item.key)).length;
    const progress = block.querySelector("[data-shopping-progress]");
    if (progress) progress.textContent = `${bought}/${items.length} comprados`;
    return block;
  }

  function patchCard(card) {
    if (!(card instanceof HTMLElement)) return;
    const toggle = card.querySelector("[data-task-toggle]");
    if (!toggle) return;
    const taskId = String(toggle.dataset.taskToggle || "");
    const dateText = String(toggle.dataset.taskDate || "");
    const task = taskById(taskId);
    if (!task) return;
    const completed = card.classList.contains("is-complete");
    const main = card.querySelector(".task-main");
    if (!main) return;

    const oldNotes = main.querySelector(".task-notes");
    if (oldNotes) oldNotes.remove();

    const existingShopping = main.querySelector("[data-task-shopping-list]");
    const desiredItems = purchaseItems(task.notes || "");
    if (!desiredItems.length) {
      existingShopping?.remove();
    } else if (!existingShopping) {
      const block = shoppingBlock(task, dateText, completed);
      if (block) {
        const checklist = main.querySelector(".task-checklist");
        if (checklist) main.insertBefore(block, checklist);
        else main.appendChild(block);
      }
    }

    const actions = card.querySelector(".task-card-actions");
    if (actions && !actions.querySelector("[data-task-visible-toggle]")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `small task-complete-visible ${completed ? "is-reopen" : ""}`;
      button.dataset.taskVisibleToggle = "1";
      button.textContent = completed ? "↺ Reabrir tarefa" : "✓ Marcar tarefa como concluída";
      button.addEventListener("click", () => toggle.click());
      actions.prepend(button);
    }
  }

  function patchAll() {
    ensureStyles();
    patchForm();
    document.querySelectorAll("#tasksView .task-card").forEach(patchCard);
  }

  document.addEventListener("change", async (event) => {
    const input = event.target?.closest?.("[data-shopping-item]");
    if (!input) return;
    const task = taskById(input.dataset.taskId);
    if (!task) return;
    const dateText = String(input.dataset.taskDate || "");
    const occurrence = occurrenceState(task, dateText, true);
    const done = new Set(Array.isArray(occurrence.shoppingDone) ? occurrence.shoppingDone.map(String) : []);
    if (input.checked) done.add(String(input.dataset.shoppingItem));
    else done.delete(String(input.dataset.shoppingItem));
    occurrence.shoppingDone = [...done];
    input.closest(".task-shopping-item")?.classList.toggle("is-bought", input.checked);

    const block = input.closest(".task-shopping-list");
    if (block) {
      const all = [...block.querySelectorAll("[data-shopping-item]")];
      const bought = all.filter((item) => item.checked).length;
      const progress = block.querySelector("[data-shopping-progress]");
      if (progress) progress.textContent = `${bought}/${all.length} comprados`;
    }

    const synced = await persistTask(task);
    if (!synced) {
      try { showToast("Item marcado neste aparelho; sincronização pendente."); } catch {}
    }
  });

  patchLegacyPushEndpoint();
  patchAll();

  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      patchAll();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
