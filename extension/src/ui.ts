// The in-page overlay, and saving files through the service worker. Downloads go through chrome.downloads so a
// sync's many files never hit Chrome's "this site is trying to download multiple files" prompt.

export function overlay(stopLabel = "Stop and download"): { set(msg: string): void; onStop(fn: () => void): void; done(): void } {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:2147483647;background:#1a1d21;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:320px";
  const text = document.createElement("div");
  const stop = document.createElement("button");
  stop.textContent = stopLabel;
  stop.style.cssText = "margin-top:8px;font:inherit;cursor:pointer";
  box.append(text, stop);
  document.body.append(box);
  return {
    set: (msg) => (text.textContent = msg),
    onStop: (fn) => stop.addEventListener("click", fn, { once: true }),
    done: () => {
      stop.remove();
      setTimeout(() => box.remove(), 8000);
    },
  };
}

/** Files "Sync this event" saves: only under Downloads/hackrecon/sync/<stamp>/, plain names, no "..". */
export const SYNC_FILE = /^hackrecon\/sync\/[0-9TZ-]+\/(?:(?:captures|slack-dom)\/)?[A-Za-z0-9][\w.-]*$/;

/** Under GURL's 2 MB URL limit once base64-encoded (4/3) into a data: URL. */
export const PART_BYTES = 1_200_000;

/** Splits a file's bytes into parts named `<name>.part-<i>-of-<n>`; one part keeps the plain name. */
export function splitParts(name: string, bytes: Uint8Array, max = PART_BYTES): { name: string; bytes: Uint8Array }[] {
  const n = Math.max(1, Math.ceil(bytes.length / max));
  if (n === 1) return [{ name, bytes }];
  return Array.from({ length: n }, (_, i) => ({ name: `${name}.part-${i + 1}-of-${n}`, bytes: bytes.subarray(i * max, (i + 1) * max) }));
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Saves text under ~/Downloads/<path> (path starts with hackrecon/). Returns an error message or null. */
export async function saveFile(path: string, text: string, mime = "application/json"): Promise<string | null> {
  for (const part of splitParts(path, new TextEncoder().encode(text))) {
    const r = (await chrome.runtime.sendMessage({ type: "save-file", filename: part.name, url: `data:${mime};base64,${base64(part.bytes)}` })) as { error?: string } | undefined;
    if (!r || r.error) return `${part.name}: ${r?.error ?? "no answer from the service worker"}`;
  }
  return null;
}
