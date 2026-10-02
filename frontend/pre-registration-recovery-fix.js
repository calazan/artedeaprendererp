// Evita que um pré-cadastro seja marcado como matriculado antes de existir no Supabase
// e recupera automaticamente matrículas antigas cujo vínculo aponta para uma criança ausente.
(() => {
  if (window.__saberPreRegistrationRecoveryLoaded) return;
  window.__saberPreRegistrationRecoveryLoaded = true;

  const ENDPOINT = "/api/pre-registration";
  const PENDING_ENROLLMENT_KEY = "arteDeAprenderERP.pendingPreregistrationEnrollment";

  function toast(message) {
    try { showToast(message); } catch { alert(message); }
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

  function studentForRecord(record) {
    const studentId = String(record?.enrolled_student_id || "");
    const data = record?.data || {};
    try {
      return (state.students || []).find((item) => studentId && String(item.id) === studentId)
        || (state.students || []).find((item) => normalized(item.name) === normalized(data.childName)
          && (!data.birthDate || item.birthDate === data.birthDate))
        || null;
    } catch {
      return null;
    }
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

  function recoveredNotes(record) {
    const data = record?.data || {};
    const lines = [
      `Cadastro recuperado do pré-cadastro ${record?.protocol || ""}.`,
      "IMPORTANTE: confira atividades, horas contratadas, mensalidade e vencimento, pois esses dados financeiros não fazem parte do formulário público.",
      data.schoolName || data.schoolYear || data.schoolPeriod
        ? `Escola: ${[data.schoolName, data.schoolYear, data.schoolPeriod].filter(Boolean).join(" · ")}.`
        : "",
      data.serviceInterest ? `Serviço de interesse informado: ${data.serviceInterest}${data.otherService ? ` - ${data.otherService}` : ""}.` : "",
      Array.isArray(data.weekdays) && data.weekdays.length ? `Dias de interesse: ${data.weekdays.join(", ")}.` : "",
      data.emergencyName || data.emergencyPhone
        ? `Contato de emergência: ${[data.emergencyName, data.emergencyRelationship, data.emergencyPhone].filter(Boolean).join(" · ")}.`
        : "",
      data.hasAllergy ? `ALERGIA: ${data.allergyDetails || "informada sem detalhes"}.` : "",
      data.hasFoodRestriction ? `RESTRIÇÃO ALIMENTAR: ${data.foodRestrictionDetails || "informada sem detalhes"}.` : "",
      data.usesMedication ? `MEDICAMENTO: ${data.medicationDetails || "informado sem detalhes"}.` : "",
      data.hasHealthCondition ? `CONDIÇÃO DE SAÚDE: ${data.healthConditionDetails || "informada sem detalhes"}.` : "",
      data.hasUnauthorizedPerson ? `NÃO AUTORIZADO A RETIRAR: ${data.unauthorizedPersonDetails || "informado sem detalhes"}.` : "",
    ].filter(Boolean);
    return lines.join(" | ");
  }

  function buildRecoveredStudent(record) {
    const data = record?.data || {};
    const id = String(record?.enrolled_student_id || "") || (globalThis.crypto?.randomUUID?.() || `recovered-${Date.now()}`);
    const createdAt = String(data.submittedAt || record?.created_at || new Date().toISOString()).slice(0, 10);
    return {
      id,
      name: String(data.childName || "Criança recuperada").trim(),
      birthDate: String(data.birthDate || ""),
      guardian: String(data.guardianName || ""),
      guardianCpf: String(data.guardianCpf || ""),
      phone: String(data.guardianPhone || ""),
      emergencyPhone: String(data.emergencyPhone || ""),
      guardianAddress: addressText(data),
      activities: "",
      activityItems: [],
      contractedHours: 0,
      monthlyValue: 0,
      dueDay: 10,
      status: "active",
      notes: recoveredNotes(record),
      createdAt,
    };
  }

  function openStudent(student) {
    if (!student) return;
    try { fillStudentForm(student); } catch {
      try {
        const editButton = document.querySelector(`[data-edit-student="${CSS.escape(student.id)}"]`);
        editButton?.click();
      } catch {}
    }
    try { switchView("students"); } catch { document.querySelector('[data-view="students"]')?.click(); }
    document.querySelector("#studentForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function pullSupabase() {
    const bridge = window.__saberMaisSupabase;
    if (!bridge?.pullNow) return false;
    try {
      const result = await bridge.pullNow();
      await wait(80);
      return result !== false;
    } catch (error) {
      console.warn("Falha ao baixar o cadastro do Supabase", error);
      return false;
    }
  }

  async function pushSupabase(maxAttempts = 8) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const bridge = window.__saberMaisSupabase;
      const status = bridge?.status?.();
      if (bridge?.syncNow && status?.ready && !status?.busy) {
        try {
          const result = await bridge.syncNow();
          if (result !== false) return true;
        } catch (error) {
          console.warn("Falha ao enviar matrícula ao Supabase", error);
        }
      }
      await wait(450);
    }
    return false;
  }

  async function enrolledRecordById(id) {
    const result = await request("GET", null, "?status=enrolled&limit=500");
    return (Array.isArray(result.records) ? result.records : []).find((record) => String(record.id) === String(id)) || null;
  }

  async function openOrRecoverStudent(recordId) {
    const record = await enrolledRecordById(recordId);
    if (!record) throw new Error("Pré-cadastro matriculado não encontrado.");

    let student = studentForRecord(record);
    if (!student) {
      toast("Atualizando a lista de crianças pelo Supabase...");
      await pullSupabase();
      student = studentForRecord(record);
    }

    if (!student) {
      const childName = record.data?.childName || "esta criança";
      const confirmed = confirm(
        `O pré-cadastro de ${childName} está marcado como matriculado, mas o cadastro oficial não existe no banco. `
        + "Posso recuperar agora os dados pessoais do pré-cadastro. Depois, confira atividades, horas e valor da mensalidade."
      );
      if (!confirmed) return;

      student = buildRecoveredStudent(record);
      state.students ||= [];
      if (!state.students.some((item) => String(item.id) === String(student.id))) state.students.push(student);
      try { flushSaveState(); } catch { try { saveState(); } catch {} }

      const synced = await pushSupabase();
      if (synced) {
        toast("Cadastro recuperado e salvo no Supabase. Confira agora o plano, as atividades e o valor mensal.");
      } else {
        toast("Cadastro recuperado neste aparelho. Confira o plano e tente sincronizar com o Supabase antes de fechar o sistema.");
      }
    }

    openStudent(student);
  }

  // Intercepta o botão antigo, tenta baixar do Supabase e, se o registro realmente estiver órfão,
  // oferece recuperação usando os dados do próprio pré-cadastro.
  document.addEventListener("click", (event) => {
    const button = event.target.closest('[data-prereg-action="open-student"]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    button.disabled = true;
    openOrRecoverStudent(button.dataset.preregId)
      .catch((error) => toast(error.message || "Não foi possível abrir o cadastro."))
      .finally(() => { button.disabled = false; });
  }, true);

  async function findSavedStudent(pending, requestedId, childName, birthDate) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      let student = null;
      try {
        student = (state.students || []).find((item) => requestedId && item.id === requestedId)
          || (state.students || []).find((item) => normalized(item.name) === normalized(childName)
            && (!birthDate || item.birthDate === birthDate));
      } catch {}
      if (student) return student;
      await wait(100);
    }
    return null;
  }

  async function finishEnrollmentSafely(pending, requestedId, childName, birthDate) {
    const student = await findSavedStudent(pending, requestedId, childName, birthDate);
    if (!student) {
      sessionStorage.setItem(PENDING_ENROLLMENT_KEY, JSON.stringify(pending));
      toast("A criança ainda não foi confirmada no cadastro oficial. Salve novamente para concluir a matrícula.");
      return;
    }

    const synced = await pushSupabase();
    if (!synced) {
      sessionStorage.setItem(PENDING_ENROLLMENT_KEY, JSON.stringify({ ...pending, existingStudentId: student.id }));
      toast("A criança foi salva neste aparelho, mas o Supabase ainda não confirmou o envio. O pré-cadastro continuará em conferência para evitar perda de dados.");
      return;
    }

    try {
      await request("PATCH", {
        id: pending.preregistrationId,
        status: "enrolled",
        enrolledStudentId: student.id,
      });
      sessionStorage.removeItem(PENDING_ENROLLMENT_KEY);
      toast("Matrícula efetivada, confirmada no Supabase e pré-cadastro concluído.");
      window.__saberMaisPreRegistrations?.refresh?.();
    } catch (error) {
      sessionStorage.setItem(PENDING_ENROLLMENT_KEY, JSON.stringify({ ...pending, existingStudentId: student.id }));
      console.error("Falha ao concluir pré-cadastro após sincronização", error);
      toast("A criança já está salva no Supabase, mas o pré-cadastro ainda precisa ser concluído. Tente salvar novamente.");
    }
  }

  async function reconcileEnrolledStudents() {
    try {
      const result = await request("GET", null, "?status=enrolled&limit=500");
      const enrolled = Array.isArray(result.records) ? result.records : [];
      if (!enrolled.length) return;

      // Primeiro tenta trazer do Neon qualquer criança que já exista em outro aparelho.
      await pullSupabase();

      const recovered = [];
      for (const record of enrolled) {
        if (studentForRecord(record)) continue;
        if (!record?.enrolled_student_id) continue;

        const student = buildRecoveredStudent(record);
        state.students ||= [];
        if (!state.students.some((item) => String(item.id) === String(student.id))) {
          state.students.push(student);
          recovered.push(student);
        }
      }

      if (!recovered.length) return;

      try { flushSaveState(); } catch { try { saveState(); } catch {} }
      try { renderAll(); } catch { try { renderStudents(); } catch {} }

      const synced = await pushSupabase();
      if (synced) {
        toast(`${recovered.length} matrícula(s) do pré-cadastro foram recuperadas e voltaram para Crianças/Alunos.`);
      } else {
        toast(`${recovered.length} matrícula(s) foram recuperadas neste aparelho e aguardam sincronização com o Neon.`);
      }
    } catch (error) {
      console.warn("Falha ao reconciliar matrículas do pré-cadastro", error);
    }
  }

  // O listener original marcava o pré-cadastro como matriculado cerca de 150 ms após o submit,
  // antes de o envio ao Supabase terminar. Retiramos temporariamente a pendência para impedir isso
  // e só alteramos o status depois que a sincronização da criança foi confirmada.
  document.addEventListener("submit", (event) => {
    if (event.target?.id !== "studentForm") return;
    const raw = sessionStorage.getItem(PENDING_ENROLLMENT_KEY);
    if (!raw) return;

    let pending;
    try { pending = JSON.parse(raw); } catch { return; }

    const requestedId = document.querySelector("#studentId")?.value || pending.existingStudentId || "";
    const childName = document.querySelector("#studentName")?.value.trim() || pending.childName || "";
    const birthDate = document.querySelector("#birthDate")?.value || pending.birthDate || "";

    // O listener de captura do formulário original encontrará a chave vazia e não encerrará
    // o pré-cadastro prematuramente.
    sessionStorage.removeItem(PENDING_ENROLLMENT_KEY);
    window.setTimeout(() => {
      finishEnrollmentSafely(pending, requestedId, childName, birthDate).catch((error) => {
        sessionStorage.setItem(PENDING_ENROLLMENT_KEY, JSON.stringify(pending));
        console.error("Falha na conclusão segura do pré-cadastro", error);
        toast("Não foi possível confirmar a matrícula no Supabase. O pré-cadastro permanecerá em conferência.");
      });
    }, 220);
  }, true);

  // Repara automaticamente registros antigos marcados como matriculados que ficaram sem
  // uma criança correspondente no cadastro principal.
  window.setTimeout(() => {
    reconcileEnrolledStudents().catch((error) => {
      console.warn("Reconciliação automática de pré-cadastros", error);
    });
  }, 1800);
})();
