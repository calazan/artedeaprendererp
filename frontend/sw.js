const CACHE_NAME = "arte-de-aprender-visual-20261001";
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.min.css?v=20261001",
  "./menu-brand.css?v=20261001",
  "./pre-app-state-guard.js?v=1",
  "./python-auth-bridge.js?v=1",
  "./smg-confirm-dialog.js?v=1",
  "./app.min.js?v=469-a3p3",
  "./local-persistence-reliability.js?v=1",
  "./remote-sync-key-fix.js?v=6",
  "./supabase-admin-sync.js?v=3",
  "./stability-core-fix.js?v=1",
  "./extra-event-attendance-id-fix.js?v=2",
  "./pre-registration-admin.js?v=3",
  "./pre-registration-recovery-fix.js?v=1",
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
  "./supabase-full-state-seed-fix.js?v=1",
  "./logo-zebra.svg?v=1",
  "./cashflow-report-status-filter.js?v=1",
  "./tasks-routine.js?v=1",
  "./tasks-shopping-adjustments.js?v=1",
  "./dashboard-redesign.js?v=20261001",
  "./dashboard-redesign.css?v=20261001",
  "./whatsapp-reminders.js?v=1",
  "./whatsapp-reminders.css?v=1",
  "./main-menu-colors.css?v=20261001",
  "./manifest.json?v=3",
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
  const title = payload.title || "Arte de Aprender ERP";
  const options = {
    body: payload.body || "Você tem uma tarefa agendada.",
    icon: payload.icon || "/app-icon-192.png?v=20261001",
    badge: payload.badge || "/app-icon-192.png?v=20261001",
    tag: payload.tag || `smg-task-${Date.now()}`,
    renotify: payload.renotify === true,
    requireInteraction: payload.requireInteraction === true,
    data: payload.data || { url: "/?smgView=tasks" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification?.data?.url || "/?smgView=tasks", self.location.origin).href;
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

function isVersionedAsset(url) {
  return url.searchParams.has("v") && /\.(?:js|css|png|webp|svg)$/i.test(url.pathname);
}

function isRuntimeShell(url, request) {
  if (request.mode === "navigate") return true;
  return /\.(?:js|css|html|json)$/i.test(url.pathname);
}

async function injectShellHTML(response) {
  if (!response?.ok) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return response;
  let html = await response.text();
  if (!html.includes("main-menu-colors.css")) {
    const tag = '<link rel="stylesheet" href="/main-menu-colors.css?v=20261001" data-main-menu-colors-direct />';
    html = html.includes("</head>") ? html.replace("</head>", `  ${tag}\n  </head>`) : `${tag}${html}`;
  }
  if (!html.includes("pre-app-state-guard.js")) {
    const guard = '<script src="/pre-app-state-guard.js?v=1" data-pre-app-state-guard></script>';
    const appScript = /<script\s+src=["'](?:\/)?app(?:\.min)?\.js(?:\?[^"']*)?["']><\/script>/i;
    if (appScript.test(html)) html = html.replace(appScript, `${guard}\n    $&`);
    else if (html.includes("</body>")) html = html.replace("</body>", `  ${guard}\n  </body>`);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const network = await fetch(event.request, { cache: "no-store" });
        const patched = await injectShellHTML(network);
        if (patched.ok) (await caches.open(CACHE_NAME)).put(event.request, patched.clone());
        return patched;
      } catch {
        const cached = (await caches.match(event.request)) || (await caches.match("./index.html"));
        return cached ? injectShellHTML(cached) : Response.error();
      }
    })());
    return;
  }
  if (isVersionedAsset(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const network = await fetch(event.request);
      if (network.ok) (await caches.open(CACHE_NAME)).put(event.request, network.clone());
      return network;
    })());
    return;
  }
  if (isRuntimeShell(url, event.request)) {
    event.respondWith((async () => {
      try {
        const network = await fetch(event.request, { cache: "no-store" });
        if (network.ok) (await caches.open(CACHE_NAME)).put(event.request, network.clone());
        return network;
      } catch {
        return (await caches.match(event.request)) || Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const network = await fetch(event.request).catch(() => null);
    if (network?.ok) (await caches.open(CACHE_NAME)).put(event.request, network.clone());
    return network || Response.error();
  })());
});
