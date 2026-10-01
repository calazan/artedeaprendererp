(() => {
  const form = document.querySelector("#preRegistrationForm");
  const alertBox = document.querySelector("#formAlert");
  const submitButton = document.querySelector("#submitButton");
  const successCard = document.querySelector("#successCard");
  const protocolNumber = document.querySelector("#protocolNumber");
  const peopleList = document.querySelector("#authorizedPeopleList");
  const progressBar = document.querySelector("#progressBar");
  const progressLabel = document.querySelector("#progressLabel");

  if (!form) return;

  function byId(id) {
    return document.getElementById(id);
  }

  function digits(value = "") {
    return String(value).replace(/\D/g, "");
  }

  function formatCpf(value) {
    const clean = digits(value).slice(0, 11);
    return clean
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1-$2");
  }

  function formatPhone(value) {
    const clean = digits(value).slice(0, 11);
    if (clean.length <= 10) {
      return clean.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d)/, "$1-$2");
    }
    return clean.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d)/, "$1-$2");
  }

  function formatCep(value) {
    return digits(value).slice(0, 8).replace(/^(\d{5})(\d)/, "$1-$2");
  }

  function validCpf(value) {
    const cpf = digits(value);
    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
    const calc = (length) => {
      let sum = 0;
      for (let i = 0; i < length; i += 1) sum += Number(cpf[i]) * (length + 1 - i);
      const remainder = (sum * 10) % 11;
      return remainder === 10 ? 0 : remainder;
    };
    return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
  }

  function showAlert(message) {
    alertBox.textContent = message;
    alertBox.classList.add("is-visible");
    alertBox.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function clearAlert() {
    alertBox.textContent = "";
    alertBox.classList.remove("is-visible");
  }

  function toggleConditional(select) {
    const target = byId(select.dataset.conditionalTarget || "");
    if (!target) return;
    const visible = select.value === "true" || select.value === "Outro";
    target.classList.toggle("is-visible", visible);
    target.querySelectorAll("input, textarea, select").forEach((field) => {
      field.disabled = !visible;
      if (!visible) field.value = "";
    });
  }

  document.querySelectorAll("[data-conditional-target]").forEach((select) => {
    select.addEventListener("change", () => toggleConditional(select));
    toggleConditional(select);
  });

  const diagnosisSelect = document.querySelector("[data-diagnosis-select]");
  function toggleDiagnosis() {
    const box = byId("diagnosisDetailsBox");
    const visible = diagnosisSelect?.value && diagnosisSelect.value !== "Não";
    box?.classList.toggle("is-visible", Boolean(visible));
    box?.querySelectorAll("textarea").forEach((field) => {
      field.disabled = !visible;
      if (!visible) field.value = "";
    });
  }
  diagnosisSelect?.addEventListener("change", toggleDiagnosis);
  toggleDiagnosis();

  function personRow() {
    const row = document.createElement("div");
    row.className = "authorized-person";
    row.innerHTML = `
      <input data-person-name placeholder="Nome completo" maxlength="160" aria-label="Nome da pessoa autorizada" />
      <input data-person-relationship placeholder="Parentesco" maxlength="80" aria-label="Parentesco da pessoa autorizada" />
      <input data-person-phone type="tel" inputmode="tel" placeholder="Telefone" maxlength="16" aria-label="Telefone da pessoa autorizada" />
      <input data-person-document placeholder="CPF ou documento" maxlength="40" aria-label="Documento da pessoa autorizada" />
      <button type="button" class="remove-person" aria-label="Remover pessoa autorizada">X</button>`;
    row.querySelector("[data-person-phone]")?.addEventListener("input", (event) => {
      event.target.value = formatPhone(event.target.value);
    });
    row.querySelector(".remove-person")?.addEventListener("click", () => row.remove());
    return row;
  }

  document.querySelector("#addAuthorizedPerson")?.addEventListener("click", () => {
    peopleList.appendChild(personRow());
    peopleList.lastElementChild?.querySelector("input")?.focus();
  });

  ["guardianPhone", "secondPhone", "emergencyPhone"].forEach((id) => {
    byId(id)?.addEventListener("input", (event) => { event.target.value = formatPhone(event.target.value); });
  });
  byId("guardianCpf")?.addEventListener("input", (event) => {
    event.target.value = formatCpf(event.target.value);
    event.target.setCustomValidity("");
  });
  byId("guardianCpf")?.addEventListener("blur", (event) => {
    event.target.setCustomValidity(validCpf(event.target.value) ? "" : "Informe um CPF válido.");
  });
  byId("cep")?.addEventListener("input", (event) => { event.target.value = formatCep(event.target.value); });
  byId("state")?.addEventListener("input", (event) => { event.target.value = event.target.value.replace(/[^a-z]/gi, "").toUpperCase().slice(0, 2); });

  function updateProgress() {
    const required = [...form.querySelectorAll("[required]")].filter((field) => !field.disabled);
    if (!required.length) return;
    const groups = new Set();
    let completed = 0;
    let total = 0;

    required.forEach((field) => {
      if (field.type === "radio") {
        if (groups.has(field.name)) return;
        groups.add(field.name);
        total += 1;
        if (form.querySelector(`input[name="${field.name}"]:checked`)) completed += 1;
        return;
      }
      total += 1;
      if (field.type === "checkbox" ? field.checked : Boolean(field.value.trim())) completed += 1;
    });

    const percent = Math.round((completed / Math.max(total, 1)) * 100);
    progressBar.style.width = `${percent}%`;
    progressLabel.textContent = `${percent}%`;
  }

  form.addEventListener("input", updateProgress);
  form.addEventListener("change", updateProgress);
  updateProgress();

  function checkedValue(name) {
    return form.querySelector(`input[name="${name}"]:checked`)?.value || "";
  }

  function collectPeople() {
    return [...peopleList.querySelectorAll(".authorized-person")].map((row) => ({
      name: row.querySelector("[data-person-name]")?.value.trim() || "",
      relationship: row.querySelector("[data-person-relationship]")?.value.trim() || "",
      phone: row.querySelector("[data-person-phone]")?.value.trim() || "",
      document: row.querySelector("[data-person-document]")?.value.trim() || "",
    })).filter((person) => person.name || person.phone || person.document);
  }

  function payload() {
    return {
      website: byId("website").value,
      childName: byId("childName").value,
      birthDate: byId("birthDate").value,
      schoolName: byId("schoolName").value,
      schoolYear: byId("schoolYear").value,
      schoolPeriod: byId("schoolPeriod").value,
      guardianName: byId("guardianName").value,
      guardianCpf: byId("guardianCpf").value,
      relationship: byId("relationship").value,
      guardianPhone: byId("guardianPhone").value,
      secondPhone: byId("secondPhone").value,
      email: byId("email").value,
      profession: byId("profession").value,
      address: {
        cep: byId("cep").value,
        street: byId("street").value,
        number: byId("addressNumber").value,
        complement: byId("complement").value,
        district: byId("district").value,
        city: byId("city").value,
        state: byId("state").value,
      },
      emergencyName: byId("emergencyName").value,
      emergencyRelationship: byId("emergencyRelationship").value,
      emergencyPhone: byId("emergencyPhone").value,
      emergencyAuthorizedPickup: checkedValue("emergencyAuthorizedPickup") === "true",
      hasAllergy: byId("hasAllergy").value === "true",
      allergyDetails: byId("allergyDetails").value,
      hasFoodRestriction: byId("hasFoodRestriction").value === "true",
      foodRestrictionDetails: byId("foodRestrictionDetails").value,
      usesMedication: byId("usesMedication").value === "true",
      medicationDetails: byId("medicationDetails").value,
      hasHealthCondition: byId("hasHealthCondition").value === "true",
      healthConditionDetails: byId("healthConditionDetails").value,
      diagnosisStatus: byId("diagnosisStatus").value,
      diagnosisDetails: byId("diagnosisDetails").value,
      routineDetails: byId("routineDetails").value,
      healthPlan: byId("healthPlan").value,
      preferredHospital: byId("preferredHospital").value,
      authorizedPeople: collectPeople(),
      hasUnauthorizedPerson: byId("hasUnauthorizedPerson").value === "true",
      unauthorizedPersonDetails: byId("unauthorizedPersonDetails").value,
      serviceInterest: byId("serviceInterest").value,
      otherService: byId("otherService").value,
      weekdays: [...form.querySelectorAll('input[name="weekdays"]:checked')].map((field) => field.value),
      expectedStartDate: byId("expectedStartDate").value,
      referralSource: byId("referralSource").value,
      referralOther: byId("referralOther").value,
      imageAuthorization: checkedValue("imageAuthorization"),
      submitterName: byId("submitterName").value,
      consents: {
        contact: byId("consentContact").checked,
        truth: byId("consentTruth").checked,
        storage: byId("consentStorage").checked,
        responsibility: byId("consentResponsibility").checked,
      },
    };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert();

    const cpfField = byId("guardianCpf");
    cpfField.setCustomValidity(validCpf(cpfField.value) ? "" : "Informe um CPF válido.");
    if (!form.reportValidity()) {
      const invalid = form.querySelector(":invalid");
      invalid?.scrollIntoView({ behavior: "smooth", block: "center" });
      showAlert("Revise os campos obrigatórios destacados antes de enviar.");
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Enviando...";

    try {
      const response = await fetch("/api/pre-registration", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload()),
      });
      let data = {};
      try { data = await response.json(); } catch { data = {}; }
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Não foi possível enviar o pré-cadastro.");
      }

      protocolNumber.textContent = data.protocol || "Recebido";
      form.style.display = "none";
      document.querySelector(".progress-card").style.display = "none";
      successCard.classList.add("is-visible");
      successCard.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      showAlert(`${error.message || "Falha no envio."} Verifique sua conexão e tente novamente.`);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Enviar pré-cadastro";
    }
  });
})();
