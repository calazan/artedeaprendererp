const CACHE_NAME = "arte-de-aprender-static-20261001-online-only";
const PRECACHE = [
  "./styles.min.css?v=20261001",
  "./menu-brand.css?v=20261001",
  "./python-auth-bridge.js?v=3",
  "./smg-confirm-dialog.js?v=1",
  "./app.min.js?v=469-online2",
  "./local-persistence-reliability.js?v=2",
  "./remote-sync-key-fix.js?v=8",
  "./supabase-admin-sync.js?v=6",
  "./stability-core-fix.js?v=1",
  "./system-health-indicator.js?v=1",
  "./extra-event-attendance-id-fix.js?v=2",
  "./pre-registration-admin.js?v=4",
  "./pre-registration-recovery-fix.js?v=3",
  "./receipt-monthly-value-only-fix.js?v=3",
  "./zebra-logo-label-fix.js?v=2",
  "./general-report-activity-value-fix.js?v=2",
  "./extra-event-individual-report-fix.js?v=1",
  "./overdue-payment-indicator-fix.js?v=1",
  "./employee-management.js?v=3",
  "./main-menu-colors.js?v=20261001",
  "./payment-deletion-persistence-fix.js?v=2",
  "./navigation-color-customization-v2.js?v=20261001",
  "./employee-tax-bill-upload.js?v=1",
  "./monthly-payment-amount-fix.js?v=2",
  "./logo-zebra.svg?v=1",
  "./cashflow-report-status-filter.js?v=1",
  "./tasks-routine.js?v=1",
  "./tasks-shopping-adjustments.js?v=1",
  "./dashboard-redesign.js?v=20261001",
  "./dashboard-redesign.css?v=20261001",
  "./whatsapp-reminders.js?v=1",
  "./whatsapp-reminders.css?v=1",
  "./main-menu-colors.css?v=20261001",
  "./banner-login.webp?v=20261001",
  "./banner-dashboard.webp?v=20261001",
  "./banner-precadastro.webp?v=20261001",
  "./logo-circular.webp?v=20261001",
  "./logo-horizontal.webp?v=20261001",
  "./app-icon-192.png?v=20261001"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        for (const file of PRECACHE) {
          try {
            const response = await fetch(file, { cache: "reload" });
            if (response.ok) await cache.put(file, response);
          } catch {}
        }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json?.() || {}; } catch {
    try { payload = { body: event.data?.text?.() || "Você tem uma tarefa no Arte de Aprender." }; } catch { payload = {}; }
  }
  event.waitUntil(self.registration.showNotification(payload.title || "Arte de Aprender ERP", {
    body: payload.body || "Você tem uma tarefa agendada.",
    icon: payload.icon || "/app-icon-192.png?v=20261001",
    badge: payload.badge || "/app-icon-192.png?v=20261001",
    tag: payload.tag || `smg-task-${Date.now()}`,
    renotify: payload.renotify === true,
    requireInteraction: payload.requireInteraction === true,
    data: payload.data || { url: "/?smgView=tasks" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification?.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      try { await existing.navigate(target); } catch {}
      await existing.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});

function isVersionedStaticAsset(url) {
  return url.searchParams.has("v")
    && /\.(?:js|css|png|webp|svg)$/i.test(url.pathname);
}

function offlinePage() {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sem conexão</title></head><body style="font-family:system-ui;padding:32px;text-align:center"><h1>Sem conexão</h1><p>O Arte de Aprender ERP funciona online. Reconecte-se à internet e tente novamente.</p><button onclick="location.reload()">Tentar novamente</button></body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request, { cache: "no-store" }).catch(offlinePage));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  if (isVersionedStaticAsset(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const network = await fetch(event.request);
      if (network.ok) (await caches.open(CACHE_NAME)).put(event.request, network.clone());
      return network;
    })());
    return;
  }

  event.respondWith(fetch(event.request, { cache: "no-store" }));
});
