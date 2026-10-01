// Personalização robusta das cores do menu principal e dos submenus do Arte de Aprender.
(() => {
  if (window.__saberNavigationColorCustomizationV2Loaded) return;
  window.__saberNavigationColorCustomizationV2Loaded = true;

  const VERSION = 2;
  const STORAGE_KEY = "arteDeAprenderERP.navigationColors.v2";
  const MAIN_DEFAULTS = {
    dashboard: "#76008a",
    finance: "#f3c524",
    employees: "#3fb9ad",
    students: "#ef477e",
    attendance: "#24b9d8",
    extraEvents: "#f5b92b",
    agenda: "#43c9a8",
    reports: "#8d50b2",
    proposals: "#4bc6c4",
    preRegistrations: "#ad68ca",
    settings: "#682f7c",
    teacherAttendance: "#309a85",
  };
  const SUBMENU_DEFAULTS = [
    "#76008a", "#ef5b94", "#22bddc", "#f6c924", "#43c9a8",
    "#a66bd1", "#e84c7f", "#d6a51a", "#379fbc", "#8a4d9b",
  ];

  let paintTimer = null;
  let editorMounted = false;

  function normalizeHex(value = "") {
    const raw = String(value || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(raw)) {
      return `#${raw.slice(1).split("").map((c) => c + c).join("")}`.toLowerCase();
    }
    return "";
  }

  function readSaved() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (parsed && typeof parsed === "object") {
        return {
          version: VERSION,
          main: parsed.main && typeof parsed.main === "object" ? parsed.main : {},
          submenus: parsed.submenus && typeof parsed.submenus === "object" ? parsed.submenus : {},
        };
      }
    } catch {}
    return { version: VERSION, main: {}, submenus: {} };
  }

  function currentConfig() {
    state.settings ||= {};
    const memory = state.settings.navigationColors && typeof state.settings.navigationColors === "object"
      ? state.settings.navigationColors
      : {};
    const saved = readSaved();
    const merged = {
      version: VERSION,
      main: { ...(saved.main || {}), ...(memory.main || {}) },
      submenus: { ...(saved.submenus || {}), ...(memory.submenus || {}) },
    };
    state.settings.navigationColors = merged;
    return merged;
  }

  function persistConfig() {
    const config = currentConfig();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch {}
    try { saveState(); } catch (error) { console.warn("Não foi possível salvar as cores no estado principal.", error); }
  }

  function shade(hex, percent) {
    const clean = normalizeHex(hex) || "#76008a";
    const value = parseInt(clean.slice(1), 16);
    const amount = Math.round(2.55 * percent);
    const r = Math.max(0, Math.min(255, (value >> 16) + amount));
    const g = Math.max(0, Math.min(255, ((value >> 8) & 255) + amount));
    const b = Math.max(0, Math.min(255, (value & 255) + amount));
    return `#${(0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1)}`;
  }

  function contrast(hex) {
    const clean = normalizeHex(hex) || "#76008a";
    const value = parseInt(clean.slice(1), 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.68 ? "#35280c" : "#ffffff";
  }

  function hashIndex(value = "") {
    let hash = 0;
    for (const char of String(value)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return Math.abs(hash) % SUBMENU_DEFAULTS.length;
  }

  function cleanLabel(button) {
    const clone = button.cloneNode(true);
    clone.querySelectorAll("span,small").forEach((node) => node.remove());
    return clone.textContent.replace(/\s+/g, " ").trim() || "Botão";
  }

  function mainDescriptor(button) {
    if (button.matches(".teacher-tab-link")) {
      return { key: "teacherAttendance", label: "Chamada professores", button };
    }
    const key = button.dataset.view;
    return key ? { key, label: cleanLabel(button), button } : null;
  }

  function submenuGroup(button) {
    if (button.classList.contains("finance-subtab")) return "Financeiro";
    if (button.classList.contains("report-subtab")) return "Relatórios";
    if (button.classList.contains("settings-subtab")) return "Configurações";
    if (button.classList.contains("employee-subtab")) return "Funcionários";
    const cls = [...button.classList].find((name) => name.endsWith("-subtab"));
    return cls ? cls.replace(/-subtab$/, "").replace(/[-_]+/g, " ") : "Submenus";
  }

  function submenuPane(button) {
    const pair = Object.entries(button.dataset).find(([key]) => key.toLowerCase().endsWith("pane"));
    return pair?.[1] || cleanLabel(button).toLowerCase().replace(/\s+/g, "-");
  }

  function submenuDescriptor(button) {
    const group = submenuGroup(button);
    const pane = submenuPane(button);
    return { key: `${group}:${pane}`, group, pane, label: cleanLabel(button), button };
  }

  function mainButtons() {
    const nav = document.querySelector("nav.tabs.menu-final-v414, nav.tabs");
    if (!nav) return [];
    return [...nav.querySelectorAll(":scope > .tab, :scope > .teacher-tab-link")].map(mainDescriptor).filter(Boolean);
  }

  function submenuButtons() {
    return [...document.querySelectorAll('button[class*="subtab"]')]
      .filter((button) => !button.closest("#navigationColorCustomizationPaneV2"))
      .map(submenuDescriptor);
  }

  function defaultMain(key) {
    return MAIN_DEFAULTS[key] || "#76008a";
  }

  function defaultSubmenu(key) {
    return SUBMENU_DEFAULTS[hashIndex(key)];
  }

  function effectiveColor(type, key) {
    const config = currentConfig();
    const saved = normalizeHex(type === "main" ? config.main[key] : config.submenus[key]);
    return saved || (type === "main" ? defaultMain(key) : defaultSubmenu(key));
  }

  function paintButton(button, color) {
    if (!button) return;
    const normalized = normalizeHex(color);
    if (!normalized) return;
    const active = button.classList.contains("is-active");
    const base = active ? shade(normalized, -12) : normalized;
    const text = contrast(base);
    button.style.setProperty("background", `linear-gradient(135deg, ${shade(base, 9)}, ${shade(base, -8)})`, "important");
    button.style.setProperty("background-color", base, "important");
    button.style.setProperty("color", text, "important");
    button.style.setProperty("border-color", "rgba(255,255,255,.32)", "important");
    button.style.setProperty("text-shadow", text === "#ffffff" ? "0 1px 1px rgba(0,0,0,.10)" : "none", "important");
    button.dataset.navigationColorApplied = normalized;
  }

  function applyColors() {
    mainButtons().forEach(({ key, button }) => paintButton(button, effectiveColor("main", key)));
    submenuButtons().forEach(({ key, button }) => paintButton(button, effectiveColor("submenu", key)));
  }

  function schedulePaint() {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(applyColors, 30);
  }

  function setColor(type, key, value) {
    const color = normalizeHex(value);
    if (!color) return false;
    const config = currentConfig();
    if (type === "main") config.main[key] = color;
    else config.submenus[key] = color;
    persistConfig();
    applyColors();
    updateRowState(type, key, color, true);
    return true;
  }

  function resetColor(type, key) {
    const config = currentConfig();
    if (type === "main") delete config.main[key];
    else delete config.submenus[key];
    persistConfig();
    applyColors();
    renderEditor();
  }

  function resetAll() {
    state.settings.navigationColors = { version: VERSION, main: {}, submenus: {} };
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    persistConfig();
    applyColors();
    renderEditor();
    try { showToast("Cores padrão restauradas."); } catch {}
  }

  function injectStyles() {
    if (document.querySelector("#navigationColorCustomizationStyleV2")) return;
    const style = document.createElement("style");
    style.id = "navigationColorCustomizationStyleV2";
    style.textContent = `
      #navigationColorCustomizationPaneV2 .nav-color-intro{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
      #navigationColorCustomizationPaneV2 .nav-color-intro p{margin:5px 0 0;color:var(--muted)}
      #navigationColorCustomizationPaneV2 .nav-color-section{padding:18px;margin-top:16px;border-radius:18px;background:rgba(255,255,255,.5);border:1px solid rgba(124,84,133,.14)}
      #navigationColorCustomizationPaneV2 .nav-color-section h4{margin:0 0 4px}
      #navigationColorCustomizationPaneV2 .nav-color-section>p{margin:0 0 14px;color:var(--muted);font-size:13px}
      #navigationColorCustomizationPaneV2 .nav-color-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
      #navigationColorCustomizationPaneV2 .nav-color-group-title{grid-column:1/-1;font-weight:900;color:var(--primary-dark);margin-top:8px;padding-top:8px;border-top:1px solid rgba(124,84,133,.12)}
      #navigationColorCustomizationPaneV2 .nav-color-row{display:grid;grid-template-columns:minmax(150px,1fr) auto;gap:10px;align-items:center;padding:12px;border-radius:14px;background:rgba(255,255,255,.76);border:1px solid rgba(124,84,133,.12)}
      #navigationColorCustomizationPaneV2 .nav-color-row strong{display:block;font-size:13px}
      #navigationColorCustomizationPaneV2 .nav-color-row small{display:block;margin-top:3px;color:var(--muted)}
      #navigationColorCustomizationPaneV2 .nav-color-controls{display:grid;grid-template-columns:52px 92px auto;gap:7px;align-items:center}
      #navigationColorCustomizationPaneV2 input[type="color"]{width:52px;height:40px;min-height:40px;padding:3px;border-radius:10px;cursor:pointer;background:#fff}
      #navigationColorCustomizationPaneV2 .nav-color-hex{width:92px;min-width:92px;text-transform:uppercase;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
      #navigationColorCustomizationPaneV2 .nav-color-controls button{min-height:38px;padding:0 10px;font-size:12px}
      @media(max-width:760px){#navigationColorCustomizationPaneV2 .nav-color-grid{grid-template-columns:1fr}#navigationColorCustomizationPaneV2 .nav-color-row{grid-template-columns:1fr}#navigationColorCustomizationPaneV2 .nav-color-controls{grid-template-columns:54px minmax(100px,1fr) auto}}
    `;
    document.head.appendChild(style);
  }

  function mountSettingsPane() {
    if (editorMounted) return;
    const tabs = document.querySelector("#settingsView .settings-subtabs");
    if (!tabs) return;
    editorMounted = true;
    injectStyles();

    const oldTab = tabs.querySelector('[data-settings-pane="personalization"]');
    const oldPane = document.querySelector("#navigationColorCustomizationPane");
    if (oldTab) oldTab.remove();
    if (oldPane) oldPane.remove();

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "settings-subtab";
    tab.dataset.settingsPane = "personalization-v2";
    tab.textContent = "Personalização";
    tabs.appendChild(tab);

    const pane = document.createElement("div");
    pane.className = "settings-pane";
    pane.id = "navigationColorCustomizationPaneV2";
    pane.dataset.settingsPaneContent = "personalization-v2";
    pane.innerHTML = `
      <div class="settings-card">
        <div class="nav-color-intro">
          <div><h3>Personalização das cores</h3><p>Escolha uma cor no seletor ou digite o código hexadecimal. A alteração é aplicada imediatamente.</p></div>
          <div class="form-actions"><button type="button" id="refreshNavigationColorsV2">Atualizar lista</button><button type="button" class="secondary" id="resetAllNavigationColorsV2">Restaurar padrão</button></div>
        </div>
        <section class="nav-color-section"><h4>Menu principal</h4><p>Defina uma cor diferente para cada área principal do Arte de Aprender.</p><div class="nav-color-grid" id="navigationMainColorListV2"></div></section>
        <section class="nav-color-section"><h4>Submenus</h4><p>Defina as cores das subabas de Financeiro, Relatórios, Configurações, Funcionários e demais módulos.</p><div class="nav-color-grid" id="navigationSubmenuColorListV2"></div></section>
      </div>`;
    tabs.parentElement?.appendChild(pane);

    tab.addEventListener("click", () => {
      document.querySelectorAll("#settingsView .settings-subtab").forEach((item) => item.classList.toggle("is-active", item === tab));
      document.querySelectorAll("#settingsView .settings-pane").forEach((item) => item.classList.toggle("is-active", item === pane));
      renderEditor();
      applyColors();
    });

    pane.addEventListener("input", handleEditorInput);
    pane.addEventListener("change", handleEditorInput);
    pane.addEventListener("click", handleEditorClick);
    pane.querySelector("#refreshNavigationColorsV2")?.addEventListener("click", () => { renderEditor(); applyColors(); });
    pane.querySelector("#resetAllNavigationColorsV2")?.addEventListener("click", () => {
      if (confirm("Restaurar todas as cores padrão?")) resetAll();
    });
  }

  function colorRow(type, key, label, context = "") {
    const config = currentConfig();
    const custom = normalizeHex(type === "main" ? config.main[key] : config.submenus[key]);
    const color = custom || effectiveColor(type, key);
    return `
      <div class="nav-color-row" data-nav-row="${escapeAttr(type)}|${escapeAttr(key)}">
        <div><strong>${escapeHTML(label)}</strong><small>${escapeHTML(context || (custom ? "Personalizada" : "Padrão"))}</small></div>
        <div class="nav-color-controls">
          <input type="color" value="${color}" data-nav-picker="1" data-nav-color-type="${escapeAttr(type)}" data-nav-color-key="${escapeAttr(key)}" aria-label="Cor de ${escapeAttr(label)}" />
          <input class="nav-color-hex" value="${color.toUpperCase()}" maxlength="7" data-nav-hex="1" data-nav-color-type="${escapeAttr(type)}" data-nav-color-key="${escapeAttr(key)}" aria-label="Código da cor de ${escapeAttr(label)}" />
          <button type="button" class="secondary" data-reset-nav-color="${escapeAttr(type)}|${escapeAttr(key)}">Padrão</button>
        </div>
      </div>`;
  }

  function renderEditor() {
    mountSettingsPane();
    const main = document.querySelector("#navigationMainColorListV2");
    const subs = document.querySelector("#navigationSubmenuColorListV2");
    if (!main || !subs) return;
    main.innerHTML = mainButtons().map(({ key, label }) => colorRow("main", key, label)).join("") || "<p>Nenhum botão encontrado.</p>";
    const groups = new Map();
    submenuButtons().forEach((item) => {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    });
    subs.innerHTML = [...groups.entries()].map(([group, items]) => `<div class="nav-color-group-title">${escapeHTML(group)}</div>${items.map(({ key, label }) => colorRow("submenu", key, label, group)).join("")}`).join("") || "<p>Nenhum submenu encontrado.</p>";
  }

  function updateRowState(type, key, color, custom) {
    const row = [...document.querySelectorAll("#navigationColorCustomizationPaneV2 .nav-color-row")].find((item) => item.dataset.navRow === `${type}|${key}`);
    if (!row) return;
    const picker = row.querySelector("[data-nav-picker]");
    const hex = row.querySelector("[data-nav-hex]");
    if (picker) picker.value = color;
    if (hex) hex.value = color.toUpperCase();
    const small = row.querySelector("small");
    if (small && !small.textContent.includes("Financeiro") && !small.textContent.includes("Relatórios") && !small.textContent.includes("Configurações") && !small.textContent.includes("Funcionários")) small.textContent = custom ? "Personalizada" : "Padrão";
  }

  function handleEditorInput(event) {
    const field = event.target.closest("[data-nav-picker],[data-nav-hex]");
    if (!field) return;
    const type = field.dataset.navColorType;
    const key = field.dataset.navColorKey;
    let value = field.value;
    if (field.matches("[data-nav-hex]") && !normalizeHex(value)) return;
    if (!setColor(type, key, value)) return;
  }

  function handleEditorClick(event) {
    const button = event.target.closest("[data-reset-nav-color]");
    if (!button) return;
    const [type, ...rest] = button.dataset.resetNavColor.split("|");
    resetColor(type, rest.join("|"));
  }

  currentConfig();
  mountSettingsPane();
  applyColors();

  // Observa apenas a chegada de novos botões. Alterações dentro do editor são ignoradas,
  // evitando o loop que recriava os seletores de cor enquanto o usuário os utilizava.
  const observer = new MutationObserver((mutations) => {
    let foundNavigationChange = false;
    for (const mutation of mutations) {
      if (mutation.target?.closest?.("#navigationColorCustomizationPaneV2")) continue;
      for (const node of mutation.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.(".tab,.teacher-tab-link,button[class*='subtab']") || node.querySelector?.(".tab,.teacher-tab-link,button[class*='subtab']")) {
          foundNavigationChange = true;
          break;
        }
      }
      if (foundNavigationChange) break;
    }
    if (!foundNavigationChange) return;
    schedulePaint();
    if (document.querySelector("#navigationColorCustomizationPaneV2.is-active")) setTimeout(renderEditor, 50);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("click", () => setTimeout(applyColors, 0), true);
  window.__saberNavigationColors = { apply: applyColors, renderEditor, resetAll, setColor };
})();
