// Live updates on Plan (D5, user 2026-11-06): after a sync, a new item appears at the end of its section marked
// "New"; a changed item keeps its place marked "Changed", with old → new; nothing reorders until "Show N updates".
// Urgent changes skip the queue: a deadline moved earlier, a claim window or session starting within 60 minutes, or
// a cancellation (a post saying so, quoted). Pure functions over Plan's results; `hr board` inlines this file into
// the page (the CSP allows inline scripts only); bun test loads it directly.
(function (g) {
  const HOUR = 60 * 60 * 1000;
  const CANCELLED = /\b(cancel(?:l)?ed|postponed|called off)\b/i;

  /** Every row Plan shows, by a key stable across syncs: what it is, its section, a signature of what it says,
   *  and its time (a session's start, a credit's claim limit) when it has one. */
  function rows(res) {
    const out = new Map();
    const put = (section, key, label, sig, at, quote) => out.set(`${section}:${key}`, { section, key, label, sig: JSON.stringify(sig), at: at ?? null, quote: quote || "" });
    for (const t of res?.tracks || []) put("tracks", t.track_id, t.name, [t.name, t.fit, t.reason, t.label, (t.steps || []).map((s) => s.id)], null, t.quote);
    for (const c of res?.credits?.credits || []) put("credits", c.offer_id, c.value, [c.value, c.limit, c.limit_unclear, c.claim, c.promo_code], c.limit ? c.limit * 1000 : null, c.quote);
    for (const s of res?.sessions?.sessions || []) put("sessions", `${s.source_url}|${s.sponsor}`, s.quote, [s.start, s.quote], Date.parse(s.start), s.quote);
    for (const p of res?.people?.people || []) for (const r of p.reps) put("people", `${p.sponsor}|${r.person}`, r.name, [r.quote, r.signals, r.likely], null, r.quote);
    return out;
  }

  /** What a sync changed: rows added, rows whose signature changed (with the old row), rows gone. */
  function diff(prev, next) {
    const a = rows(prev), b = rows(next);
    const added = [], changed = [], removed = [];
    for (const [k, r] of b) {
      const old = a.get(k);
      if (!old) added.push(r);
      else if (old.sig !== r.sig) changed.push({ ...r, was: old });
    }
    for (const [k, r] of a) if (!b.has(k)) removed.push(r);
    return { added, changed, removed, count: added.length + changed.length };
  }

  /** D5's urgent rule, as of `nowMs`: deadlines that moved earlier (by id, else by name), and added or changed rows
   *  that start or close within the hour or whose post says cancelled. Each names why, for the Next for you line. */
  function urgent(d, prevMeta, nextMeta, nowMs) {
    const out = [];
    const before = new Map((prevMeta?.deadlines || []).flatMap((x) => [[`id:${x.id}`, x], [`name:${x.name}`, x]]));
    const submission = (m) => (m?.deadlines || []).filter((x) => /\bsubmi(?:ssions?|t)\b/i.test(x.name)).sort((p, q) => Date.parse(p.at) - Date.parse(q.at))[0];
    for (const x of nextMeta?.deadlines || []) {
      const was = before.get(`id:${x.id}`) || before.get(`name:${x.name}`);
      if (was && Date.parse(x.at) < Date.parse(was.at)) out.push({ why: "earlier", key: `deadline:${x.id}`, label: x.name, at: Date.parse(x.at), was: Date.parse(was.at) });
    }
    // A replaced schedule entry has a new name: the submission deadline is compared as one.
    const s0 = submission(prevMeta), s1 = submission(nextMeta);
    if (s0 && s1 && Date.parse(s1.at) < Date.parse(s0.at) && !out.some((u) => u.key === `deadline:${s1.id}`)) out.push({ why: "earlier", key: `deadline:${s1.id}`, label: s1.name, at: Date.parse(s1.at), was: Date.parse(s0.at) });
    for (const r of [...d.added, ...d.changed]) {
      const k = `${r.section}:${r.key}`;
      if (CANCELLED.test(r.quote)) out.push({ why: "cancelled", key: k, label: r.label, at: r.at });
      else if (r.at !== null && r.at > nowMs && r.at - nowMs <= HOUR && (r.section === "sessions" || r.section === "credits")) out.push({ why: r.section === "sessions" ? "starts soon" : "closes soon", key: k, label: r.label, at: r.at });
    }
    return out;
  }

  /** What Plan shows while updates wait: the shown results in their order, each changed row replaced in place, new
   *  rows appended at the end of their section, and rows that are gone kept until "Show N updates". */
  function present(shown, next) {
    const keep = (list, key, nextList) => {
      const kept = list.map((x) => nextList.find((y) => key(y) === key(x)) || x);
      return [...kept, ...nextList.filter((y) => !list.some((x) => key(x) === key(y)))];
    };
    const out = { ...next };
    if (shown?.tracks && next?.tracks) out.tracks = keep(shown.tracks, (t) => t.track_id, next.tracks);
    if (shown?.credits && next?.credits) out.credits = { ...next.credits, credits: keep(shown.credits.credits, (c) => c.offer_id, next.credits.credits) };
    if (shown?.sessions && next?.sessions) out.sessions = { ...next.sessions, sessions: keep(shown.sessions.sessions, (s) => `${s.source_url}|${s.sponsor}`, next.sessions.sessions) };
    if (shown?.people && next?.people)
      out.people = { ...next.people, people: keep(shown.people.people, (p) => p.sponsor, next.people.people).map((p) => {
        const old = shown.people.people.find((x) => x.sponsor === p.sponsor), nw = next.people.people.find((x) => x.sponsor === p.sponsor) || p;
        return old ? { ...nw, reps: keep(old.reps, (r) => r.person, nw.reps) } : nw;
      }) };
    return out;
  }

  g.HRLive = { rows, diff, urgent, present };
})(typeof window !== "undefined" ? window : globalThis);
