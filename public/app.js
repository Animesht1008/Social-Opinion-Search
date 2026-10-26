/* Social Opinion Search — inspector UI. */
const $ = (id) => document.getElementById(id);
const state = { user: null, config: null, sources: [] };

/* ------------------------------------------------------------------ DOM helpers */
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === "class") e.className = v;
    else if (k === "style") Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
};
const chip = (text, cls = "") => el("span", { class: `chip ${cls}` }, text);
const f = (x, d = 3) => (typeof x === "number" ? x.toFixed(d) : "–");
const btn = (label, onClick, cls = "") => el("button", { type: "button", class: `btn ${cls}`, onclick: onClick }, label);
const field = (label, input) => el("label", {}, label, input);
const select = (options, value, id) => { const s = el("select", { id }); for (const [v, l] of options) s.append(el("option", { value: v, selected: v === value }, l)); return s; };
const REL_TYPES = [["FRIEND", "Friend"], ["FAMILY", "Family"], ["COLLEAGUE", "Colleague"], ["ACQUAINTANCE", "Acquaintance"]];
const CLOSENESS = [1, 2, 3, 4, 5].map((n) => [String(n), `${n}${n === 1 ? " (distant)" : n === 5 ? " (very close)" : ""}`]);
const showMsg = (node, text, kind = "error") => { node.hidden = !text; node.className = `msg ${kind}`; node.textContent = text || ""; };

/* ------------------------------------------------------------------ API */
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, { method, credentials: "same-origin", headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j.error?.message || res.statusText);
    Object.assign(e, { status: res.status, code: j.error?.code, details: j.error?.details, retryAfter: res.headers.get("retry-after") });
    const authCall = /\/auth\/(login|register|password|account)$/.test(path);
    if (res.status === 401 && !authCall) signedOut();
    throw e;
  }
  return j;
}
const errText = (e) => `${e.message}${e.retryAfter ? ` (try again in ${e.retryAfter}s)` : ""}`;
const errList = (e) => (e.details && Array.isArray(e.details) ? e.details.map((d) => `${d.path}: ${d.message}`).join("; ") : errText(e));

/* ------------------------------------------------------------------ auth screens */
function showAuth() {
  state.user = null;
  $("app").hidden = true; $("userbar").hidden = true; $("auth").hidden = false;
}
function signedOut() { if (state.user) showAuth(); }

async function showApp() {
  $("auth").hidden = true; $("app").hidden = false; $("userbar").hidden = false;
  $("whoami").textContent = `${state.user.displayName} · ${state.user.email}`;
  await loadSources();
  await refreshCircleLine();
  switchTab("search");
}

function bindAuth() {
  document.querySelectorAll("[data-auth]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("[data-auth]").forEach((x) => x.classList.toggle("active", x === b));
    $("form-login").hidden = b.dataset.auth !== "login";
    $("form-register").hidden = b.dataset.auth !== "register";
    showMsg($("auth-msg"), "");
  }));
  $("form-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("/api/v1/auth/login", { method: "POST", body: { email: $("login-email").value, password: $("login-password").value } });
      $("login-password").value = ""; state.user = r.user; await showApp();
    } catch (e) { showMsg($("auth-msg"), errText(e)); }
  });
  $("form-register").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("/api/v1/auth/register", { method: "POST", body: { displayName: $("reg-name").value, email: $("reg-email").value, password: $("reg-password").value } });
      $("reg-password").value = ""; state.user = r.user; await showApp();
    } catch (e) { showMsg($("auth-msg"), errList(e)); }
  });
  $("btn-signout").addEventListener("click", async () => { try { await api("/api/v1/auth/logout", { method: "POST" }); } finally { showAuth(); } });
}

function renderAuthConfig() {
  const c = state.config;
  $("tab-register").hidden = !c.registrationOpen;
  $("pw-hint").textContent = `At least ${c.passwordMinLength} characters. A short passphrase of unrelated words works well. Sessions last ${c.sessionTtlHours} hours.`;
}

/* ------------------------------------------------------------------ tabs */
function switchTab(name) {
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  for (const t of ["search", "circle", "mine", "eval", "account"]) $(`tab-${t}`).hidden = t !== name;
  if (name === "circle") renderCircle();
  if (name === "mine") renderMine();
  if (name === "eval") loadEval();
  if (name === "account") renderAccount();
}

/* ------------------------------------------------------------------ data sources (shared) */
async function loadSources() {
  const r = await api("/api/v1/data-sources");
  state.sources = r.sources;
  const box = $("source-filter");
  box.replaceChildren(...r.sources.filter((s) => s.displayable && s.opinionCount > 0).map((s) =>
    el("label", { class: "chk", title: `${s.license}` }, el("input", { type: "checkbox", checked: true, "data-source": s.id }), `${s.name} (${s.opinionCount})`)));
}
const selectedSources = () => [...document.querySelectorAll("#source-filter input")].filter((i) => i.checked).map((i) => i.dataset.source);
const allSources = () => [...document.querySelectorAll("#source-filter input")].map((i) => i.dataset.source);

async function refreshCircleLine() {
  try {
    const m = await api("/api/v1/me/access");
    const inner = m.innerCircleIds.length, other = m.connectionIds.length - inner;
    $("circle-line").textContent = `Your inner circle: ${inner} ${inner === 1 ? "person" : "people"} (accepted ${m.innerCircleDefinition.types.join("/").toLowerCase()} with closeness ≥ ${m.innerCircleDefinition.minCloseness}); other connections: ${other}. Manage them in “My circle”.`;
  } catch { /* shown elsewhere */ }
}

/* ------------------------------------------------------------------ search */
function bindSearch() {
  $("form-search").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showMsg($("search-error"), "");
    $("results").hidden = true; // never show the previous search's results next to a new query
    $("go").disabled = true; $("go").textContent = "Searching…";
    try {
      const body = { query: $("query").value, mode: $("mode").value, ranking: $("ranking").value, limit: Number($("limit").value), generateAnswer: $("answer").checked, allowFallback: $("fallback").checked };
      const sel = selectedSources();
      if (sel.length === 0) throw Object.assign(new Error("Select at least one source to search in."), {});
      if (sel.length < allSources().length) body.filters = { dataSources: sel };
      render(await api("/api/v1/search", { method: "POST", body }));
    } catch (e) {
      $("results").hidden = true;
      showMsg($("search-error"), `${e.code ? e.code + ": " : ""}${errList(e)}`);
    } finally { $("go").disabled = false; $("go").textContent = "Search"; }
  });
}

function render(r) {
  $("results").hidden = false;
  $("status").hidden = r.warnings.length === 0;
  $("status").replaceChildren(r.warnings.length ? el("ul", { class: "warn-list" }, r.warnings.map((w) => el("li", {}, w))) : null);
  const i = r.intent;
  $("intent").replaceChildren(el("div", { class: "grid" },
    el("b", {}, "location"), el("span", {}, `${i.location.city ?? "—"}${i.location.neighborhood ? " / " + i.location.neighborhood : ""}`),
    el("b", {}, "topic (soft)"), el("span", {}, i.topic ?? "—"),
    el("b", {}, "aspects"), el("span", {}, i.aspects.length ? i.aspects.map((a) => chip(a)) : "none recognised"),
    el("b", {}, "keywords (lexical)"), el("span", {}, i.keywords.join(", ") || "—"),
    el("b", {}, "hard constraints"), el("span", {}, i.hardConstraints.length ? i.hardConstraints.map((c) => chip(`${c.kind}=${JSON.stringify(c.value)}${c.verifiable ? "" : " (NOT enforced)"} [${c.source}]`, c.verifiable ? "" : "warn")) : "none"),
    el("b", {}, "soft preferences"), el("span", {}, i.softPreferences.join("; ") || "—"),
    el("b", {}, "temporal"), el("span", {}, `${i.temporal.recencyPreference}${i.temporal.since ? ", since " + i.temporal.since : ""}`),
    el("b", {}, "ambiguities"), el("span", {}, i.ambiguities.join(" · ") || "none"),
    el("b", {}, "lexical tsquery"), el("span", {}, r.retrieval.lexicalQuery ?? "—")));
  const a = r.answer;
  $("answerBox").replaceChildren(a ? el("div", {}, chip(`mode: ${a.mode}`, a.mode === "llm" ? "POSITIVE" : "warn"), a.provider ? chip(a.provider) : null, el("pre", {}, a.text), el("div", { class: "muted" }, "Citations: " + (a.citations.map((c) => `${c.id}(${c.kind})`).join(", ") || "none"))) : el("span", { class: "muted" }, "Answer generation was not requested."));
  const online = a?.webRecommendations ?? [];
  const webSources = new Map(r.channels.web.results.map((source) => [source.id, source]));
  const shouldShowOnline = online.length > 0 || (r.webFallback?.requested && r.channels.web.results.length > 0);
  $("online-suggestions-panel").hidden = !shouldShowOnline;
  const sourceLink = (source) => source.url.startsWith("https://") || source.url.startsWith("http://")
    ? el("a", { href: source.url, target: "_blank", rel: "noopener noreferrer" }, source.title || source.url)
    : (source.title || "Source link unavailable");
  $("online-suggestions").replaceChildren(
    ...(online.length
      ? online.map((recommendation, index) => el("article", { class: "recommendation-card" },
        el("h3", {}, `${index + 1}. ${recommendation.name}`),
        el("p", {}, recommendation.overview),
        el("p", {}, el("b", {}, "Visitor feedback / web evidence: "), recommendation.reviewSummary),
        el("div", {}, ...recommendation.sourceIds.map((id) => {
          const source = webSources.get(id);
          return source ? el("p", {}, chip(id, "wide"), sourceLink(source), el("br"), el("small", { class: "muted" }, source.snippet)) : null;
        }))))
      : r.webFallback?.requested
        ? [el("p", { class: "muted" }, r.channels.web.results.length
          ? "Web sources were found, but no individual suggestions could be verified from the returned source snippets. Open the sources below to review them."
          : "No web sources were returned for this query; no online suggestions are available.")]
        : []),
    ...(r.webFallback?.requested && !online.length && r.channels.web.results.length
      ? r.channels.web.results.map((source) => el("p", {}, chip(source.id, "wide"), sourceLink(source), el("br"), el("small", { class: "muted" }, source.snippet)))
      : []));
  $("recommendations").replaceChildren(...(r.placeRecommendations?.length
    ? r.placeRecommendations.map((place) => {
      const status = place.status === "more_positive" ? "More positive signals" :
        place.status === "more_negative" ? "More negative signals" :
          place.status === "conflicting" ? "Conflicting reports" : "No clear sentiment signal";
      const tone = place.status === "more_positive" ? "POSITIVE" : place.status === "more_negative" ? "NEGATIVE" : place.status === "conflicting" ? "MIXED" : "";
      return el("article", { class: "recommendation-card" },
        el("div", {}, el("b", {}, `${place.rank}. ${place.neighborhood}, ${place.city}`), " ", chip(status, tone)),
        el("p", {}, `${place.evidenceCount} selected ${place.evidenceCount === 1 ? "opinion" : "opinions"} · ${place.positive} positive · ${place.negative} negative · ${place.mixed} mixed · ${place.neutral} neutral aspect signals${place.ratedEvidenceCount ? ` · ${place.averageRating}/5 average rating from ${place.ratedEvidenceCount} rated ${place.ratedEvidenceCount === 1 ? "opinion" : "opinions"}` : ""}`),
        place.aspects.length ? el("div", {}, place.aspects.map((aspect) =>
          chip(`${aspect.label}: +${aspect.positive} / −${aspect.negative} / ±${aspect.mixed}`, aspect.negative > aspect.positive ? "NEGATIVE" : aspect.positive > aspect.negative ? "POSITIVE" : "MIXED"))) : null,
        el("small", { class: "muted" }, `Selected evidence: ${place.evidenceIds.join(", ")}`));
    })
    : [el("span", { class: "muted" }, "No neighborhood-level summary can be made from the selected evidence for this query.")]));
  $("selected").replaceChildren(...(r.selected.length ? r.selected.map(evidenceCard) : [el("span", { class: "muted" }, "No evidence selected.")]));
  $("balance").replaceChildren(
    el("table", {}, el("tr", {}, ...["aspect", "positive", "negative", "mixed", "neutral", "conflict?", "evidence"].map((h) => el("th", {}, h))),
      ...r.aspectBalance.map((b) => el("tr", {}, el("td", { class: "l" }, b.label), el("td", {}, b.positive), el("td", {}, b.negative), el("td", {}, b.mixed), el("td", {}, b.neutral), el("td", {}, b.conflicting ? "YES" : "no"), el("td", { class: "l" }, b.evidenceIds.join(", "))))),
    el("div", { class: "muted" }, r.suppressedDuplicates.length ? "Suppressed duplicates: " + r.suppressedDuplicates.map((s) => s.reason).join(" | ") : "No duplicates were suppressed."),
    el("div", { class: "muted" }, `Independent firsthand authors among selected: ${r.adequacy.independentFirsthandSources}. ${r.adequacy.note}`));
  const heads = ["#", "id", "source", "channel", "found by", "lex", "sem", "aspect", "ctx", "spec", "prov", "fresh", "social", "redund.", "final", "eligible", "selection"];
  $("candidates").replaceChildren(el("table", {}, el("tr", {}, ...heads.map((h) => el("th", { class: ["selection", "source"].includes(h) ? "l" : "" }, h))),
    ...r.candidates.map((c) => el("tr", { class: c.selected ? "sel" : c.eligible ? "" : "out" },
      el("td", {}, c.rank), el("td", { class: "l nw" }, c.opinionId), el("td", { class: "l" }, c.dataSource?.name ?? ""), el("td", { class: "l" }, c.channel), el("td", { class: "l" }, c.foundBy.join("+")),
      ...["lexical", "semantic", "aspect", "context", "specificity", "provenance", "freshness", "social", "redundancy"].map((k) => el("td", {}, f(c.components[k], 2))),
      el("td", {}, f(c.finalScore)), el("td", {}, c.eligible ? "yes" : "no"), el("td", { class: "l wrap" }, c.selectionReason)))));
}

function evidenceCard(c) {
  const pols = c.queryAspectPolarity.filter((p) => p.polarity !== "NEUTRAL");
  const comp = c.components;
  const bar = (name, v) => { const i = el("i"); i.style.width = `${Math.round(Math.max(0, Math.min(1, v ?? 0)) * 100)}%`; return el("div", {}, `${name} ${f(v, 2)}`, el("div", { class: "bar" }, i)); };
  const ds = c.dataSource;
  return el("div", { class: "ev" },
    el("div", {}, chip(c.channel === "inner_circle" ? "inner circle" : "wider social", c.channel === "inner_circle" ? "inner" : "wide"), chip(c.sourceType === "SOCIAL_USER" ? "social user" : "public review"), chip(c.firsthand ? "firsthand" : "not firsthand"),
      ds ? chip(ds.name, ds.isSynthetic ? "syn" : "public") : null, ds && !ds.commercialUseAllowed ? chip("non-commercial licence", "warn") : null,
      ...pols.map((p) => chip(`${p.aspect}: ${p.polarity.toLowerCase()}`, p.polarity)), c.isSynthetic ? chip("SYNTHETIC", "syn") : null,
      el("b", {}, ` ${c.opinionId}`), ` · ${c.authorName} · ${c.neighborhood ?? c.city} · ${c.writtenAt.slice(0, 10)} · score ${f(c.finalScore)}`),
    el("blockquote", {}, c.text),
    el("div", { class: "why" }, "Why selected: " + c.selectionReason),
    el("div", { class: "why" }, c.explanation.join(" · ")),
    el("div", { class: "bars" }, bar("lexical", comp.lexical), bar("semantic", comp.semantic), bar("aspect", comp.aspect), bar("context", comp.context), bar("specificity", comp.specificity), bar("provenance", comp.provenance), bar("freshness", comp.freshness)),
    ds ? el("div", { class: "src" }, `Source: ${ds.name} · licence: ${ds.license}${ds.attribution ? " · " + ds.attribution : ""}`) : null);
}

/* ------------------------------------------------------------------ my circle */
async function renderCircle(flash) {
  const box = $("tab-circle");
  let r;
  try { r = await api("/api/v1/relationships"); } catch (e) { box.replaceChildren(el("div", { class: "msg error" }, errText(e))); return; }
  const def = r.innerCircleDefinition;
  const act = async (fn, okMsg) => { try { await fn(); await refreshCircleLine(); await renderCircle(okMsg); } catch (e) { await renderCircle(null); showMsg($("circle-msg"), errText(e)); } };
  const typeSel = (v) => select(REL_TYPES, v), closeSel = (v) => select(CLOSENESS, String(v));

  const findForm = el("form", { class: "row end", onsubmit: async (ev) => {
    ev.preventDefault();
    const q = $("find-q").value.trim();
    const out = $("find-results");
    if (q.length < 3) { out.replaceChildren(el("span", { class: "muted" }, "Type at least 3 characters.")); return; }
    try {
      const res = await api(`/api/v1/users/search?q=${encodeURIComponent(q)}`);
      out.replaceChildren(...(res.users.length ? res.users.map((u) => {
        const t = typeSel("FRIEND"), c = closeSel(3);
        return el("div", { class: "item" }, el("span", {}, u.displayName, " ", u.relationship !== "none" ? chip(u.relationship.replace("_", " ")) : null),
          u.relationship === "none" || u.relationship === "request_received" ? el("span", { class: "actions" }, t, c, btn(u.relationship === "request_received" ? "Accept their request" : "Send request", () => act(() => api("/api/v1/relationships", { method: "POST", body: { userId: u.id, type: t.value, closeness: Number(c.value) } }), "Request sent."), "small primary")) : null);
      }) : [el("span", { class: "muted" }, "No matching people. Only people with an account can be found.")]));
    } catch (e) { out.replaceChildren(el("span", { class: "msg error" }, errText(e))); }
  } }, el("label", { class: "grow" }, "Find people by name", el("input", { id: "find-q", type: "search", maxLength: 60, placeholder: "at least 3 letters" })), el("button", { class: "btn primary", type: "submit" }, "Search"));

  const person = (rel, actions) => el("div", { class: "item" },
    el("span", {}, el("b", {}, rel.user.displayName), " ", chip(rel.type.toLowerCase()), chip(`closeness ${rel.closeness}`), rel.status === "ACCEPTED" ? chip(rel.innerCircle ? "inner circle" : "connection", rel.innerCircle ? "inner" : "wide") : null),
    el("span", { class: "actions" }, ...actions));

  box.replaceChildren(
    el("section", { class: "panel" }, el("h2", {}, "How the inner circle works"),
      el("p", {}, `A person is in your inner circle when your relationship is ACCEPTED, its type is one of ${def.types.join(", ")}, and its closeness is at least ${def.minCloseness}. Everyone else you have accepted is an ordinary connection. Pending requests and blocked people grant nothing.`),
    ),
    el("div", { id: "circle-msg", class: `msg ${flash ? "ok" : ""}`, hidden: !flash }, flash || ""),
    el("section", { class: "panel" }, el("h2", {}, "Add someone"), findForm, el("div", { id: "find-results" })),
    el("section", { class: "panel" }, el("h2", {}, `Requests for you (${r.incoming.length})`),
      ...(r.incoming.length ? r.incoming.map((rel) => { const t = typeSel(rel.type), c = closeSel(rel.closeness);
        return person(rel, [t, c, btn("Accept", () => act(() => api(`/api/v1/relationships/${rel.id}/accept`, { method: "POST", body: { type: t.value, closeness: Number(c.value) } }), "Connected."), "small primary"), btn("Decline", () => act(() => api(`/api/v1/relationships/${rel.id}/decline`, { method: "POST" }), "Declined."), "small")]); }) : [el("span", { class: "muted" }, "No pending requests.")])),
    el("section", { class: "panel" }, el("h2", {}, `Your connections (${r.friends.length})`),
      ...(r.friends.length ? r.friends.map((rel) => { const t = typeSel(rel.type), c = closeSel(rel.closeness);
        return person(rel, [t, c, btn("Save", () => act(() => api(`/api/v1/relationships/${rel.id}`, { method: "PATCH", body: { type: t.value, closeness: Number(c.value) } }), "Updated."), "small"),
          btn("Remove", () => confirm(`Remove ${rel.user.displayName}?`) && act(() => api(`/api/v1/relationships/${rel.id}`, { method: "DELETE" }), "Removed."), "small danger"),
          btn("Block", () => confirm(`Block ${rel.user.displayName}? Their opinions will be hidden from you.`) && act(() => api("/api/v1/blocks", { method: "POST", body: { userId: rel.user.id } }), "Blocked."), "small danger")]); }) : [el("span", { class: "muted" }, "No connections yet.")])),
    el("section", { class: "panel" }, el("h2", {}, `Requests you sent (${r.outgoing.length})`),
      ...(r.outgoing.length ? r.outgoing.map((rel) => person(rel, [btn("Cancel", () => act(() => api(`/api/v1/relationships/${rel.id}`, { method: "DELETE" }), "Cancelled."), "small")])) : [el("span", { class: "muted" }, "None.")])),
    el("section", { class: "panel" }, el("h2", {}, `Blocked (${r.blocked.length})`),
      ...(r.blocked.length ? r.blocked.map((rel) => person(rel, [btn("Unblock", () => act(() => api(`/api/v1/blocks/${rel.user.id}`, { method: "DELETE" }), "Unblocked."), "small")])) : [el("span", { class: "muted" }, "Nobody.")])));
}

/* ------------------------------------------------------------------ my opinions */
const VIS = [["CONNECTIONS", "My connections"], ["INNER_CIRCLE", "My inner circle only"], ["PUBLIC", "Everyone"], ["PRIVATE", "Only me"]];
const CATS = [["hotel_area", "Hotel / area to stay"], ["cafe", "Café / work spot"], ["restaurant", "Restaurant"], ["other", "Other"]];
async function renderMine(flash) {
  const box = $("tab-mine");
  let r;
  try { r = await api("/api/v1/opinions/mine"); } catch (e) { box.replaceChildren(el("div", { class: "msg error" }, errText(e))); return; }
  const msg = el("div", { class: `msg ${flash ? "ok" : ""}`, hidden: !flash }, flash || "");
  const editForm = (o) => {
    const text = el("textarea", { rows: 4, minLength: 20, maxLength: 2000, required: true }, o.text);
    const city = el("input", { required: true, maxLength: 80, value: o.city });
    const hood = el("input", { maxLength: 80, value: o.neighborhood || "" });
    const cat = select(CATS, o.category), vis = select(VIS, o.visibility);
    const first = el("input", { type: "checkbox", checked: o.firsthand });
    const rating = select([["", "no rating"], ...[1, 2, 3, 4, 5].map((n) => [String(n), `${n} ★`])], o.rating == null ? "" : String(o.rating));
    const editMsg = el("div", { class: "msg", hidden: true });
    const form = el("form", { class: "stack", onsubmit: async (ev) => {
      ev.preventDefault();
      const body = { text: text.value, city: city.value, category: cat.value, visibility: vis.value, firsthand: first.checked };
      if (hood.value.trim()) body.neighborhood = hood.value;
      if (rating.value) body.rating = Number(rating.value);
      try {
        const result = await api(`/api/v1/opinions/${o.id}`, { method: "PATCH", body });
        await renderMine(`Opinion updated. Semantic index: ${result.embedding}.${result.note ? ` ${result.note}` : ""}`);
      } catch (e) { showMsg(editMsg, errList(e)); }
    } },
      field("Your opinion (20–2000 characters)", text),
      el("div", { class: "row" }, field("City", city), field("Area (optional)", hood), field("Type of place", cat), field("Rating (optional)", rating)),
      el("div", { class: "row" }, field("Who can read it", vis), el("label", { class: "chk" }, first, "I experienced this myself (firsthand)")),
      el("div", { class: "row" }, el("button", { class: "btn primary", type: "submit" }, "Save changes"), btn("Cancel", () => renderMine())));
    return el("div", { class: "opinion-edit" }, form, editMsg);
  };
  const text = el("textarea", { id: "op-text", rows: 4, maxLength: 2000, required: true, placeholder: "What did you notice? Be specific: lighting, people around, transport, noise, price, hygiene…" });
  const city = el("input", { id: "op-city", required: true, maxLength: 80, placeholder: "e.g. Mumbai" });
  const hood = el("input", { id: "op-hood", maxLength: 80, placeholder: "optional, e.g. Colaba" });
  const cat = select(CATS, "hotel_area"), vis = select(VIS, "CONNECTIONS");
  const first = el("input", { type: "checkbox", checked: true });
  const rating = select([["", "no rating"], ...[1, 2, 3, 4, 5].map((n) => [String(n), `${n} ★`])], "");
  const form = el("form", { class: "stack", onsubmit: async (ev) => {
    ev.preventDefault();
    try {
      const body = { text: text.value, city: city.value, category: cat.value, visibility: vis.value, firsthand: first.checked };
      if (hood.value.trim()) body.neighborhood = hood.value;
      if (rating.value) body.rating = Number(rating.value);
      const res = await api("/api/v1/opinions", { method: "POST", body });
      await renderMine(`Posted. Aspects detected: ${res.aspects.map((a) => `${a.aspect} (${a.polarity.toLowerCase()})`).join(", ") || "none"} · semantic index: ${res.embedding}.`);
      loadSources();
    } catch (e) { showMsg(msg, errList(e)); }
  } },
    field("Your opinion (20–2000 characters)", text),
    el("div", { class: "row" }, field("City", city), field("Area (optional)", hood), field("Type of place", cat), field("Rating (optional)", rating)),
    el("div", { class: "row" }, field("Who can read it", vis), el("label", { class: "chk" }, first, "I experienced this myself (firsthand)")),
    el("button", { class: "btn primary", type: "submit" }, "Post opinion"));
  box.replaceChildren(
    el("section", { class: "panel" }, el("h2", {}, "Share an opinion"), form, msg),
    el("section", { class: "panel" }, el("h2", {}, `Your opinions (${r.opinions.length})`),
      ...(r.opinions.length ? r.opinions.map((o) => {
        const card = el("div", { class: "opinion" },
          el("div", {}, chip(o.visibility.toLowerCase().replace("_", " ")), chip(o.category), chip(o.firsthand ? "firsthand" : "not firsthand"), el("b", {}, ` ${o.neighborhood ? o.neighborhood + ", " : ""}${o.city}`), ` · ${o.writtenAt.slice(0, 10)} · ${o.id}`),
          el("p", {}, o.text),
          o.source.id === "user-generated"
            ? el("div", { class: "actions" },
              btn("Edit", () => {
                card.querySelector(".opinion-edit")?.remove();
                card.append(editForm(o));
              }, "small"),
              btn("Delete", async () => { if (confirm("Delete this opinion?")) { try { await api(`/api/v1/opinions/${o.id}`, { method: "DELETE" }); await renderMine("Deleted."); loadSources(); } catch (e) { showMsg(msg, errText(e)); } } }, "small danger"))
            : chip(`source: ${o.source.name}`, "syn"));
        return card;
      }) : [el("span", { class: "muted" }, "You have not posted anything yet.")])));
}

/* ------------------------------------------------------------------ evaluation */
async function loadEval() {
  const box = $("evalBox");
  try {
    const r = await (await fetch("/api/v1/evaluation/summary", { credentials: "same-origin" })).json();
    if (r.error) { box.textContent = r.error.message; return; }
    const s = r.summary;
    const cols = ["P@5", "P@5 strict (grade 3)", "NDCG@5", "candidate recall", "aspect coverage", "hard-constraint satisfaction", "duplicate rate selected", "inner-circle share (selected)", "retrieval ms (median)"];
    box.replaceChildren(
      el("div", { class: "muted" }, `Run ${r.id} at ${r.createdAt} · ${s.queryCount} queries, ${s.judgmentCount} judgments · embeddings: ${s.embedding.available ? s.embedding.modelKey + " (" + s.embedding.kind + ")" : "UNAVAILABLE — semantic metrics not computed"} · leak sweep: ${s.leakSweep.unauthorizedCandidates} unauthorized candidates in ${s.leakSweep.searches} searches`),
      el("div", { class: "scroll" }, el("table", {}, el("tr", {}, el("th", { class: "l" }, "config"), ...cols.map((c) => el("th", {}, c))),
        ...Object.entries(s.configs).map(([name, v]) => v.unavailable ? el("tr", {}, el("td", { class: "l" }, name), el("td", { class: "l", colSpan: cols.length }, v.unavailable)) : el("tr", {}, el("td", { class: "l" }, name), ...cols.map((c) => el("td", {}, f(v.all[c], c.includes("ms") ? 1 : 3))))))));
  } catch (e) { box.textContent = e.message; }
}

/* ------------------------------------------------------------------ account */
function renderAccount() {
  const box = $("tab-account");
  const msg = el("div", { class: "msg", hidden: true });
  const cur = el("input", { type: "password", autocomplete: "current-password", required: true, maxLength: 128 });
  const next = el("input", { type: "password", autocomplete: "new-password", required: true, maxLength: 128 });
  const del = el("input", { type: "password", autocomplete: "current-password", required: true, maxLength: 128 });
  box.replaceChildren(
    el("section", { class: "panel" }, el("h2", {}, "Account"), el("p", {}, el("b", {}, state.user.displayName), " · ", state.user.email),
      el("div", { class: "row" }, btn("Sign out everywhere", async () => { try { const r = await api("/api/v1/auth/logout-all", { method: "POST" }); showAuth(); void r; } catch (e) { showMsg(msg, errText(e)); } }))),
    msg,
    el("section", { class: "panel" }, el("h2", {}, "Change password"), el("form", { class: "stack", onsubmit: async (ev) => {
      ev.preventDefault();
      try { const r = await api("/api/v1/auth/password", { method: "POST", body: { currentPassword: cur.value, newPassword: next.value } }); cur.value = next.value = ""; showMsg(msg, `Password changed. ${r.otherSessionsRevoked} other session(s) signed out.`, "ok"); } catch (e) { showMsg(msg, errText(e)); }
    } }, field("Current password", cur), field("New password", next), el("button", { class: "btn primary", type: "submit" }, "Change password"))),
    el("section", { class: "panel" }, el("h2", {}, "Delete account"),
      el("p", { class: "muted" }, "Permanently deletes your account, sessions, connections and every opinion you posted. This cannot be undone."),
      el("form", { class: "stack", onsubmit: async (ev) => {
        ev.preventDefault();
        if (!confirm("Permanently delete your account and everything you posted?")) return;
        try { await api("/api/v1/auth/account", { method: "DELETE", body: { password: del.value } }); showAuth(); } catch (e) { showMsg(msg, errText(e)); }
      } }, field("Confirm with your password", del), el("button", { class: "btn danger", type: "submit" }, "Delete my account"))));
}

/* ------------------------------------------------------------------ boot */
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
bindAuth();
bindSearch();
(async function boot() {
  try {
    state.config = await api("/api/v1/auth/config");
    renderAuthConfig();
    try { state.user = (await api("/api/v1/auth/me")).user; await showApp(); } catch { showAuth(); }
  } catch (e) {
    $("auth").hidden = false;
    showMsg($("auth-msg"), `Cannot reach the server: ${e.message}`);
  }
})();
