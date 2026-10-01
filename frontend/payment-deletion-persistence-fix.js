// Mantém mensalidades excluídas manualmente fora da geração automática e preserva
// a fotografia financeira de qualquer mensalidade já criada.
(() => {
  if (window.__paymentDeletionPersistenceLoaded) return;
  window.__paymentDeletionPersistenceLoaded = true;

  const EXCLUSIONS_FIELD = "paymentExclusions";

  function exclusionKey(studentId = "", period = "") {
    return `${String(period || "").trim()}::${String(studentId || "").trim()}`;
  }

  function normalizeExclusion(item = {}) {
    const studentId = String(item?.studentId || "").trim();
    const period = String(item?.period || "").trim();
    if (!studentId || !/^\d{4}-\d{2}$/.test(period)) return null;
    return {
      id: item.id || `payment-exclusion:${period}:${studentId}`,
      studentId,
      period,
      deletedAt: item.deletedAt || new Date().toISOString(),
    };
  }

  function ensureExclusions(target = state) {
    const raw = Array.isArray(target?.[EXCLUSIONS_FIELD]) ? target[EXCLUSIONS_FIELD] : [];
    const unique = new Map();
    raw.forEach((item) => {
      const normalized = normalizeExclusion(item);
      if (normalized) unique.set(exclusionKey(normalized.studentId, normalized.period), normalized);
    });
    target[EXCLUSIONS_FIELD] = [...unique.values()];
    return target[EXCLUSIONS_FIELD];
  }

  function isPaymentExcluded(studentId, period, target = state) {
    const wanted = exclusionKey(studentId, period);
    return ensureExclusions(target).some((item) => exclusionKey(item.studentId, item.period) === wanted);
  }

  function rememberPaymentDeletion(payment) {
    if (!payment?.studentId || !payment?.period) return false;
    const exclusions = ensureExclusions(state);
    if (isPaymentExcluded(payment.studentId, payment.period, state)) return false;
    exclusions.push(normalizeExclusion({
      studentId: payment.studentId,
      period: payment.period,
      deletedAt: new Date().toISOString(),
    }));
    state[EXCLUSIONS_FIELD] = exclusions.filter(Boolean);
    return true;
  }

  function removeExcludedPayments(target = state) {
    const blocked = new Set(ensureExclusions(target).map((item) => exclusionKey(item.studentId, item.period)));
    if (!blocked.size || !Array.isArray(target?.payments)) return 0;
    const before = target.payments.length;
    target.payments = target.payments.filter((payment) => !blocked.has(exclusionKey(payment?.studentId, payment?.period)));
    return before - target.payments.length;
  }

  const originalNormalizeState = normalizeState;
  normalizeState = function normalizeStateWithPaymentExclusions(data = {}) {
    const normalized = originalNormalizeState(data);
    normalized[EXCLUSIONS_FIELD] = Array.isArray(data?.[EXCLUSIONS_FIELD])
      ? data[EXCLUSIONS_FIELD].map(normalizeExclusion).filter(Boolean)
      : [];
    removeExcludedPayments(normalized);
    return normalized;
  };
  try { window.normalizeState = normalizeState; } catch {}

  ensureExclusions(state);
  const resurrectedOnLoad = removeExcludedPayments(state);
  if (resurrectedOnLoad > 0) flushSaveState();

  ensurePaymentsForPeriod = function ensurePaymentsForPeriodRespectingDeletions(period = selectedPeriodKey(), options = {}) {
    const existingByStudent = new Map(paymentsForPeriod(period).map((payment) => [payment.studentId, payment]));
    const result = { created: 0, updated: 0, skippedPaid: 0, skippedDeleted: 0, preserved: 0 };

    activeStudents().forEach((student) => {
      const existing = existingByStudent.get(student.id);

      if (!existing && isPaymentExcluded(student.id, period)) {
        result.skippedDeleted += 1;
        return;
      }

      if (!existing) {
        const payment = createPaymentFromStudentPlan(student, period);
        window.__saberPaymentHistory?.ensureSnapshot?.(payment, student);
        state.payments.push(payment);
        result.created += 1;
        return;
      }

      // Uma mensalidade existente não é recalculada pelo cadastro geral. Apenas garantimos
      // que sua fotografia histórica esteja completa.
      window.__saberPaymentHistory?.ensureSnapshot?.(existing, student);
      result.preserved += 1;
      if ((existing.receipts || []).length) result.skippedPaid += 1;
    });

    return result;
  };
  try { window.ensurePaymentsForPeriod = ensurePaymentsForPeriod; } catch {}

  const originalConsistencyMessage = consistencyMessage;
  consistencyMessage = function consistencyMessageWithDeletions(result = {}, period = selectedPeriodKey()) {
    const base = originalConsistencyMessage(result, period);
    if (!Number(result.skippedDeleted || 0)) return base;
    return `${base.replace(/\.$/, "")} · ${result.skippedDeleted} mensalidade(s) excluída(s) manualmente preservada(s).`;
  };
  try { window.consistencyMessage = consistencyMessage; } catch {}

  document.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-payment]");
    if (deleteButton) {
      event.preventDefault();
      event.stopImmediatePropagation();

      const paymentId = deleteButton.dataset.deletePayment;
      const payment = state.payments.find((item) => item.id === paymentId);
      if (!payment) return;
      const student = getStudent(payment.studentId);
      if (!confirm(`Excluir a mensalidade de ${student?.name || "criança removida"} deste período? Ela não será recriada automaticamente.`)) return;

      reversePaymentCredit(payment);
      rememberPaymentDeletion(payment);
      state.payments = state.payments.filter((item) => item.id !== paymentId);
      flushSaveState();
      renderAll();
      showToast("Mensalidade excluída definitivamente deste mês.");
      return;
    }

    const generateButton = event.target.closest("#generatePayments");
    if (!generateButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const period = selectedPeriodKey();
    const result = ensurePaymentsForPeriod(period);
    flushSaveState();
    renderAll();

    if (result.created) {
      showToast(consistencyMessage(result, period));
    } else if (result.skippedDeleted) {
      showToast(`${result.skippedDeleted} mensalidade(s) excluída(s) foram mantida(s) fora deste mês.`);
    } else {
      showToast(`Mensalidades de ${periodLabel(period)} já estavam geradas e foram preservadas.`);
    }
  }, true);
})();
