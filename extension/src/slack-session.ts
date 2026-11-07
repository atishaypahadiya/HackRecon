// Content script on app.slack.com/client/* (handoff.ts): asks the service worker whether this workspace was synced
// before, and only then hands it the tab's session. Reads nothing else and changes nothing on the page.
import { readSlackSession } from "./handoff.ts";

// No run-once flag: after an extension reload the worker injects this again into open tabs, and an orphaned copy's
// flag would block it. A second hand-off of the same session is a no-op in the worker.
const s = readSlackSession(location, localStorage);
if (s)
  void chrome.runtime
    .sendMessage({ type: "slack-known", team: s.team, origin: s.origin })
    .then((r: { known?: boolean } | undefined) => (r?.known ? chrome.runtime.sendMessage({ type: "slack-session", slack: s }) : undefined))
    .catch(() => {});
export {};
