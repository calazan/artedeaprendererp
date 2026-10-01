(() => {
  const form = document.querySelector("#login");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.querySelector("#error");
    if (error) error.textContent = "";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          email: document.querySelector("#email")?.value || "",
          password: document.querySelector("#password")?.value || "",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Não foi possível entrar.");
      const requested = String(form.dataset.next || "/");
      const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
      location.replace(next);
    } catch (reason) {
      if (error) error.textContent = reason?.message || "Falha de autenticação.";
    }
  });
})();
