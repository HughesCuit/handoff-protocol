const app = document.getElementById("app");
const pending = new Map();
let requestId = 1;

function request(method, params) {
  const id = requestId++;
  window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id !== undefined && pending.has(message.id)) {
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(message.error);
    else handler.resolve(message.result);
    return;
  }
  if (message.method === "ui/notifications/tool-result") {
    app.textContent = message.params?.structuredContent?.message ?? "Context Map ready";
  }
});

export function refresh() {
  return request("tools/call", { name: "get_context_map", arguments: {} });
}
