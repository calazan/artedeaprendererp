(() => {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js?v=20261001-online1").catch((error) => {
      console.warn("Service Worker não registrado:", error);
    });
  });
})();
