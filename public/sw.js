// Lullabuy service worker: recall-watch notifications only (no caching, no fetch interception).
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "Lullabuy", body: event.data ? event.data.text() : "" }; }
  const title = typeof d.title === "string" ? d.title.slice(0, 120) : "Lullabuy";
  const body = typeof d.body === "string" ? d.body.slice(0, 300) : "";
  const url = typeof d.url === "string" && d.url.startsWith("/") ? d.url : "/watch";
  event.waitUntil(self.registration.showNotification(title, { body, tag: typeof d.tag === "string" ? d.tag : undefined, icon: "/icons/icon-192.png", data: { url } }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/watch";
  event.waitUntil(self.clients.openWindow(url));
});
