import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type SpikeReport = { stage: string; url: string; detail: unknown };

window.addEventListener("DOMContentLoaded", () => {
  const list = document.querySelector<HTMLOListElement>("#reports");
  document.querySelector("#open-ceac")?.addEventListener("click", () => {
    invoke("open_ceac_window").catch((e) => console.error("open_ceac_window failed", e));
  });
  listen<SpikeReport>("spike-report", (event) => {
    const item = document.createElement("li");
    item.textContent = `${new Date().toLocaleTimeString()} ${event.payload.stage} ${JSON.stringify(event.payload.detail)}`;
    list?.appendChild(item);
  });
  listen<Record<string, string>>("case-result", (event) => {
    const item = document.createElement("li");
    item.textContent = `${new Date().toLocaleTimeString()} RESULT ${event.payload.status} · ${event.payload.lastUpdated}`;
    list?.appendChild(item);
  });
});
