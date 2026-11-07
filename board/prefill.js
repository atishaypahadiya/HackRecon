// P1b on the board (user 2026-11-06): drafts from a repo link, each shown with the lines it came from. The user
// skips the ones that are wrong, then "Use all" fills the rest into the Plan input. Nothing here writes to storage
// or to the plan: Use all fills the form, and the plan is saved only when the user submits it ("Make my plan"). `hr board` inlines this file into the page (the CSP
// allows inline scripts only); bun test loads it directly.
(function (g) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => (/^https:\/\/github\.com\//.test(u || "") ? u : null);

  /** One reviewable item per draft: the description first, then each stack item in the draft's order. */
  function draftItems(draft) {
    const out = [];
    if (draft?.description?.text) out.push({ key: "d", kind: "description", text: draft.description.text, sources: draft.description.sources || [] });
    (draft?.stack || []).forEach((s, k) => out.push({ key: `s${k}`, kind: "stack", name: s.name, used_for: s.used_for || "", sources: s.sources || [], found: s.origin === "sponsor_pass" }));
    return out;
  }

  /** The form after using one item. The description replaces the text; a stack item fills the row with its name
   *  (keeping a use the user typed) or is added as a new row. */
  function applyItem(form, item) {
    if (item.kind === "description") return { ...form, idea: item.text };
    const stack = form.stack.map((r) => ({ ...r }));
    const same = stack.find((r) => r.name.trim().toLowerCase() === item.name.toLowerCase());
    if (same) {
      if (!same.used_for.trim()) same.used_for = item.used_for;
      return { ...form, stack };
    }
    const blank = stack.findIndex((r) => !r.name.trim() && !r.used_for.trim());
    const row = { name: item.name, used_for: item.used_for };
    if (blank >= 0) stack[blank] = row;
    else stack.push(row);
    return { ...form, stack };
  }

  function itemHtml(it) {
    const title = it.kind === "description" ? "Description" : esc(it.name);
    const body =
      it.kind === "description" ? `<p class="dt">${esc(it.text)}</p>`
      : it.used_for ? `<p class="dt">${esc(it.used_for)}</p>`
      : `<p class="dt dm">${it.found ? "Found in the code; no line says what it does." : "No line says what it does."}</p>`;
    const src = it.sources
      .map((s) => {
        const u = safeUrl(s.url);
        return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(s.source)}</a>` : `<span>${esc(s.source)}</span>`}<q>${esc(s.quote)}</q></li>`;
      })
      .join("");
    return `<div class="dr" data-k="${esc(it.key)}"><p class="dn">${title}</p>${body}<ul class="dsrc">${src}</ul><button type="button" class="add skip" aria-label="Skip ${it.kind === "description" ? "the description" : esc(it.name)}">Skip</button></div>`;
  }

  /** Renders the items into root. Skip drops one row (onSkip); "Use all" hands every row still listed to onUse in
   *  order, once, then removes the list and runs onDone. Skipping the last row also ends it. */
  function mountDrafts(root, items, { head = "", onUse, onSkip = () => {}, onDone = () => {} }) {
    let left = [...items];
    const label = () => (left.length === 1 ? "Use this draft" : `Use all ${left.length}`);
    root.innerHTML = left.length ? `<div class="drafts"><p class="l" id="pd-h" tabindex="-1">${esc(head)}</p><p class="cap">Skip any that are wrong, then use the rest. Your plan is saved only when you make it.</p><div class="dl">${left.map(itemHtml).join("")}</div><div class="dgo"><button type="button" class="jump useall">${label()}</button></div></div>` : "";
    if (!left.length) return onDone();
    const end = () => {
      root.innerHTML = "";
      onDone();
    };
    root.querySelector(".useall").addEventListener("click", () => {
      const all = left;
      left = [];
      for (const it of all) onUse(it);
      end();
    });
    root.querySelector(".dl").addEventListener("click", (e) => {
      const btn = e.target.closest("button.skip");
      if (!btn) return;
      const row = btn.closest(".dr");
      const it = left.find((x) => x.key === row.getAttribute("data-k"));
      if (!it) return;
      left = left.filter((x) => x !== it);
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      onSkip(it);
      if (!left.length) return end();
      root.querySelector(".useall").textContent = label();
      (next?.querySelector("button.skip") ?? root.querySelector(".useall")).focus();
    });
  }

  g.HRPrefill = { draftItems, applyItem, mountDrafts };
})(globalThis);
