// Núcleo de estabilidade: preserva o histórico mensal, impede sincronização retroativa do plano
// e remove o bypass universal da senha de recuperação.
(() => {
  if (window.__saberStabilityCoreLoaded) return;
  window.__saberStabilityCoreLoaded = true;

  const SNAPSHOT_VERSION = 2;
  const PRE_APP_SNAPSHOT_KEY = "arteDeAprenderERP.preAppPayments.v1";
  const originalNormalizePayment = normalizePayment;
  const originalSyncPaymentWithStudentPlan = syncPaymentWithStudentPlan;

  function clone(value) {
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
  }

  function normalizeSnapshotItem(item = {}) {
    return {
      id: item.id || item.activityId || uid(),
      activityId: item.activityId || item.id || "",
      name: String(item.name || item.activityName || "").trim(),
      value: Math.max(Number(item.value ?? item.amount ?? item.defaultValue ?? 0), 0),
      startDate: item.startDate || item.start || item.beginDate || item.inicio || "",
    };
  }

  function snapshotItemsFromText(text = "", amount = 0, student = null) {
    const names = String(text || "")
      .split(/\s*;\s*|\s*\|\s*/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length) return [];

    const currentItems = student && typeof studentActivityItems === "function"
      ? studentActivityItems(student)
      : [];

    return names.map((name, index) => {
      const current = currentItems.find((item) => normalizeText(item?.name) === normalizeText(name));
      return normalizeSnapshotItem({
        id: current?.id || current?.activityId || `snapshot-${index}-${name}`,
        activityId: current?.activityId || current?.id || "",
        name,
        value: current ? Number(current.value || 0) : (names.length === 1 ? Number(amount || 0) : 0),
        startDate: current?.startDate || "",
      });
    });
  }

  function rawSavedState() {
    try {
      const guarded = sessionStorage.getItem(PRE_APP_SNAPSHOT_KEY);
      if (guarded) {
        const parsed = JSON.parse(guarded);
        if (Array.isArray(parsed?.payments)) return { payments: parsed.payments, guarded: true };
      }
    } catch {}

    try {
      const raw = localStorage.getItem(STORAGE_KEY)
        || LEGACY_STORAGE_KEYS.map((key) => localStorage.getItem(key)).find(Boolean)
        || "";
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function restorePreInitFields(payment, raw = {}) {
    if (!payment || !raw?.id || String(raw.id) !== String(payment.id)) return false;
    let changed = false;
    const sameIdentity = String(raw.studentId || "") === String(payment.studentId || "")
      && String(raw.period || "") === String(payment.period || "");
    if (!sameIdentity) return false;

    const numericFields = ["amount", "hours", "dueDay"];
    numericFields.forEach((field) => {
      if (raw[field] == null) return;
      const rawValue = Number(raw[field] || 0);
      if (Number(payment[field] || 0) !== rawValue) {
        payment[field] = rawValue;
        changed = true;
      }
    });

    if (raw.activities != null && String(payment.activities || "") !== String(raw.activities || "")) {
      payment.activities = String(raw.activities || "");
      changed = true;
    }
    if (Array.isArray(raw.activityItems) && JSON.stringify(payment.activityItems || []) !== JSON.stringify(raw.activityItems)) {
      payment.activityItems = raw.activityItems.map(normalizeSnapshotItem).filter((item) => item.name);
      changed = true;
    }
    ["generatedFromPlan", "planSnapshotAt", "snapshotVersion", "snapshotBackfilledAt", "monthlyAmountOverride", "monthlyOriginalAmount"].forEach((field) => {
      if (raw[field] == null) return;
      if (JSON.stringify(payment[field]) !== JSON.stringify(raw[field])) {
        payment[field] = clone(raw[field]);
        changed = true;
      }
    });
    if (changed) syncPaymentFee(payment);
    return changed;
  }

  function ensurePaymentSnapshot(payment, student = null, rawPayment = null) {
    if (!payment) return false;
    let changed = false;
    const raw = rawPayment && typeof rawPayment === "object" ? rawPayment : {};

    if (restorePreInitFields(payment, raw)) changed = true;

    let items = Array.isArray(payment.activityItems) && payment.activityItems.length
      ? payment.activityItems.map(normalizeSnapshotItem).filter((item) => item.name)
      : [];

    if (!items.length && Array.isArray(raw.activityItems) && raw.activityItems.length) {
      items = raw.activityItems.map(normalizeSnapshotItem).filter((item) => item.name);
      if (items.length) changed = true;
    }

    const activityText = String(payment.activities || raw.activities || "").trim();
    if (!items.length && activityText) {
      items = snapshotItemsFromText(activityText, payment.amount, student);
      if (items.length) changed = true;
    }

    if (!items.length && student && typeof studentActivityItems === "function") {
      items = studentActivityItems(student).map(normalizeSnapshotItem).filter((item) => item.name);
      if (items.length) {
        changed = true;
        payment.snapshotBackfilledAt ||= new Date().toISOString();
      }
    }

    if (JSON.stringify(payment.activityItems || []) !== JSON.stringify(items)) {
      payment.activityItems = items;
      changed = true;
    }

    const activities = activityText || items.map((item) => item.name).join("; ");
    if (String(payment.activities || "") !== activities) {
      payment.activities = activities;
      changed = true;
    }

    if (Number(payment.snapshotVersion || 0) !== SNAPSHOT_VERSION) {
      payment.snapshotVersion = SNAPSHOT_VERSION;
      changed = true;
    }
    if (!payment.planSnapshotAt) {
      payment.planSnapshotAt = raw.planSnapshotAt || payment.createdAt || new Date().toISOString();
      changed = true;
    }
    if (raw.generatedFromPlan === true && payment.generatedFromPlan !== true) {
      payment.generatedFromPlan = true;
      changed = true;
    }
    if (raw.monthlyAmountOverride === true && payment.monthlyAmountOverride !== true) {
      payment.monthlyAmountOverride = true;
      changed = true;
    }
    if (raw.monthlyOriginalAmount != null && payment.monthlyOriginalAmount == null) {
      payment.monthlyOriginalAmount = Number(raw.monthlyOriginalAmount || 0);
      changed = true;
    }

    return changed;
  }

  // A normalização original descartava os campos de fotografia do plano mensal.
  // A partir daqui eles passam a sobreviver a carregamentos, importações e sincronizações.
  normalizePayment = function normalizePaymentWithSnapshot(payment = {}, fallbackPeriod, fallbackYear) {
    const normalized = originalNormalizePayment(payment, fallbackPeriod, fallbackYear);
    normalized.activityItems = Array.isArray(payment.activityItems)
      ? payment.activityItems.map(normalizeSnapshotItem).filter((item) => item.name)
      : [];
    normalized.activities = String(payment.activities || normalized.activityItems.map((item) => item.name).join("; ") || "");
    normalized.generatedFromPlan = payment.generatedFromPlan === true;
    normalized.planSnapshotAt = payment.planSnapshotAt || payment.createdAt || normalized.createdAt || "";
    normalized.snapshotVersion = Number(payment.snapshotVersion || 0);
    normalized.snapshotBackfilledAt = payment.snapshotBackfilledAt || "";
    normalized.monthlyAmountOverride = payment.monthlyAmountOverride === true;
    normalized.monthlyOriginalAmount = payment.monthlyOriginalAmount == null ? null : Number(payment.monthlyOriginalAmount || 0);
    return normalized;
  };
  try { window.normalizePayment = normalizePayment; } catch {}

  // Uma mensalidade já criada é a fotografia daquele mês. Alterar o cadastro geral
  // passa a afetar somente mensalidades criadas depois da alteração.
  syncPaymentWithStudentPlan = function syncPaymentWithoutRetroactiveChanges(payment, student, options = {}) {
    if (!payment || !student) return false;
    if (options.refreshPlan === true) {
      const changed = originalSyncPaymentWithStudentPlan(payment, student, options);
      ensurePaymentSnapshot(payment, student);
      return changed;
    }
    return ensurePaymentSnapshot(payment, student);
  };
  try { window.syncPaymentWithStudentPlan = syncPaymentWithStudentPlan; } catch {}

  // Recupera a fotografia capturada antes de app.js executar. Assim, até a primeira
  // inicialização após esta atualização não consegue recalcular um mês já existente.
  const raw = rawSavedState();
  const rawPayments = new Map(
    (Array.isArray(raw?.payments) ? raw.payments : [])
      .filter((payment) => payment?.id)
      .map((payment) => [String(payment.id), payment]),
  );

  let migrated = false;
  (state.payments || []).forEach((payment) => {
    const student = getStudent(payment.studentId);
    if (ensurePaymentSnapshot(payment, student, rawPayments.get(String(payment.id)))) migrated = true;
  });

  // Remove o bypass universal: 2704 continua funcionando somente enquanto for a senha
  // efetivamente cadastrada (padrão), e deixa de abrir o app após a definição de outra senha.
  isPasswordValid = async function isPasswordValidWithoutUniversalRecovery(password = "") {
    const typedPassword = String(password || "");
    const stored = storedPasswordHash();
    try {
      const currentHash = await hashPasswordLocal(typedPassword);
      if (currentHash === stored) return true;
    } catch (error) {
      console.warn("Falha ao validar SHA-256. Tentando compatibilidade local.", error);
    }
    if (stored?.startsWith("fnv1a:") && legacyHashPasswordLocal(typedPassword) === stored) return true;
    if (state.settings?.password && typedPassword === state.settings.password) return true;
    return false;
  };
  try { window.isPasswordValid = isPasswordValid; } catch {}

  const zebraHelp = document.querySelector(".zebra-label-settings-card small");
  if (zebraHelp) zebraHelp.textContent = "A etiqueta mostra: nome da criança, mês pago e valor.";
  const securityHelp = document.querySelector(".security-access-card > small");
  if (securityHelp) {
    securityHelp.innerHTML = "Quando estiver habilitado, use a senha cadastrada. A senha <strong>2704</strong> funciona somente enquanto ela for a senha padrão e deixa de funcionar após a criação de uma senha personalizada.";
  }

  if (migrated) {
    try { flushSaveState({ skipRemote: true }); } catch { try { saveState({ skipRemote: true }); } catch {} }
  }
  try { sessionStorage.removeItem(PRE_APP_SNAPSHOT_KEY); } catch {}

  window.__saberPaymentHistory = {
    ensureSnapshot: ensurePaymentSnapshot,
    snapshotItems: (payment) => clone(payment?.activityItems || []),
    version: SNAPSHOT_VERSION,
  };
})();
