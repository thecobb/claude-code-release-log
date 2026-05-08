/* ===========================================================================
   app.js — orchestrator for the release log
   ---------------------------------------------------------------------------
   State model (see `state` below):
     - `data`          : the loaded {releases, digests, ...} doc
     - `selected`      : version string of the version currently shown
     - `filter.cat`    : "all" | "added" | … | "pinned"
     - `filter.q`      : search query (debounced)
     - `prefs`         : { mergeDigests, includePrereleases, mono }
     - `local`         : { pins:Set<bullet-id>, pinnedReleases:Set, lastSeen }
     - `mode`          : "default" | "custom-repo" | "custom-url"

   localStorage keys are namespaced under `cclog:` so we can safely coexist
   with other stuff on the same origin.
   =========================================================================== */

import { fetchRepoReleases, fetchAnyGitHubUrl } from "./parsers.js";

const LS = {
  PREFS:    "cclog:prefs",
  LOCAL:    "cclog:local",
  MODE:     "cclog:mode",
  REPO:     "cclog:repo",
  URL:      "cclog:url",
  SELECTED: "cclog:selected",
};

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const AUTO_REFRESH_MS = 15 * 60 * 1000;

// ─── State ────────────────────────────────────────────────────────────────
const state = {
  data: null,
  selected: null,
  filter: { cat: "all", q: "", unreadOnly: false },
  prefs: loadJson(LS.PREFS, { mergeDigests: true, includePrereleases: false, mono: false }),
  local: hydrateLocal(loadJson(LS.LOCAL, { pins: [], pinnedReleases: [], lastSeen: null })),
  mode:  localStorage.getItem(LS.MODE) || "default",
  repo:  localStorage.getItem(LS.REPO) || "",
  url:   localStorage.getItem(LS.URL)  || "",
  refresh: {
    timer: null,
    inFlight: false,
    lastSuccessAt: null,
    intervalMs: AUTO_REFRESH_MS,
  },
};

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

function hydrateLocal(raw) {
  return {
    pins: new Set(raw.pins || []),
    pinnedReleases: new Set(raw.pinnedReleases || []),
    lastSeen: raw.lastSeen || null,
  };
}
function persistLocal() {
  saveJson(LS.LOCAL, {
    pins: [...state.local.pins],
    pinnedReleases: [...state.local.pinnedReleases],
    lastSeen: state.local.lastSeen,
  });
}

// Stable bullet ID = version + 64-bit-ish hash of text. Lets pins survive
// rebuilds of the JSON.
function bulletId(version, text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${version}#${(h >>> 0).toString(36)}`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  document.body.dataset.mode = state.mode;
  document.body.classList.toggle("is-mono", !!state.prefs.mono);

  // Self-link in colophon — useful when this is forked.
  const here = `${location.origin}${location.pathname}`.replace(/index\.html?$/, "");
  $('[data-bind="self-link"]').href = here;

  bindEvents();
  bindSettingsForm();
  bindKeyboardShortcuts();
  startAutoRefresh();

  await loadData();
}

async function fetchDataForCurrentMode() {
  if (state.mode === "custom-repo" && state.repo) {
    return fetchRepoReleases(state.repo);
  }
  if (state.mode === "custom-url" && state.url) {
    return fetchAnyGitHubUrl(state.url);
  }
  const res = await fetch("./data/releases.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`couldn't load data/releases.json (${res.status})`);
  return res.json();
}

function restoreSelection() {
  const stored = localStorage.getItem(LS.SELECTED);
  if (stored && state.data.releases.some(r => r.version === stored)) {
    state.selected = stored;
  } else {
    state.selected = state.data.releases[0]?.version || null;
  }
}

async function loadData() {
  document.body.dataset.loaded = "false";
  try {
    state.data = await fetchDataForCurrentMode();
  } catch (err) {
    updateRefreshStatus(`Refresh failed: ${err.message}`);
    renderError(err);
    return;
  }

  restoreSelection();
  document.body.dataset.loaded = "true";
  state.refresh.lastSuccessAt = new Date();
  render();
  updateRefreshStatus();
}

async function refreshData({ manual = false } = {}) {
  if (state.refresh.inFlight) return;
  state.refresh.inFlight = true;
  const btn = $('[data-action="refresh-data"]');
  if (btn) btn.disabled = true;
  if (manual) updateRefreshStatus("Refreshing now…");
  try {
    state.data = await fetchDataForCurrentMode();
    restoreSelection();
    document.body.dataset.loaded = "true";
    state.refresh.lastSuccessAt = new Date();
    render();
    updateRefreshStatus();
  } catch (err) {
    updateRefreshStatus(`Refresh failed: ${err.message}`);
    if (!state.data) renderError(err);
  } finally {
    state.refresh.inFlight = false;
    if (btn) btn.disabled = false;
  }
}

function startAutoRefresh() {
  if (state.refresh.timer) clearInterval(state.refresh.timer);
  state.refresh.timer = setInterval(() => {
    if (document.hidden) return;
    refreshData();
  }, state.refresh.intervalMs);
  updateRefreshStatus();
}

function updateRefreshStatus(message) {
  const el = $('[data-bind="refresh-status"]');
  if (!el) return;
  if (message) {
    el.textContent = message;
    return;
  }
  const mins = Math.round(state.refresh.intervalMs / 60000);
  const parts = [`auto-refresh every ${mins} min`];
  if (state.refresh.lastSuccessAt) parts.push(`last checked ${relativeTime(state.refresh.lastSuccessAt)}`);
  el.textContent = parts.join(" · ");
}

function renderError(err) {
  const reader = $('[data-bind="reader"]');
  reader.innerHTML = `
    <div class="reader__placeholder">
      <p class="kicker">Couldn't load releases</p>
      <h2>${esc(err.message || String(err))}</h2>
      <p>Open <strong>Sources</strong> (top-right) to switch back to the default mode or try a different URL.</p>
    </div>`;
}

// ─── Event wiring ─────────────────────────────────────────────────────────

function bindEvents() {
  // search (debounced)
  let searchT;
  $('[data-bind="search"]').addEventListener("input", e => {
    clearTimeout(searchT);
    const v = e.target.value;
    searchT = setTimeout(() => { state.filter.q = v.trim().toLowerCase(); renderTimeline(); renderReader(); }, 120);
  });

  // category chips
  $$(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      $$(".chip").forEach(c => c.classList.toggle("is-on", c === chip));
      state.filter.cat = chip.dataset.filter;
      renderTimeline();
      renderReader();
    });
  });

  // toolbar buttons
  $('[data-action="refresh-data"]').addEventListener("click", () => refreshData({ manual: true }));
  $('[data-action="open-settings"]').addEventListener("click", () => $('[data-bind="settings"]').showModal());
  $('[data-action="toggle-compare"]').addEventListener("click", openCompare);
  $('[data-action="toggle-unread"]').addEventListener("click", toggleUnread);
}

function bindSettingsForm() {
  const dialog = $('[data-bind="settings"]');

  // pre-fill
  for (const r of $$('input[name="mode"]', dialog)) r.checked = (r.value === state.mode);
  $('[data-bind="custom-repo"]', dialog).value = state.repo;
  $('[data-bind="custom-url"]',  dialog).value = state.url;
  $('[data-bind="pref-merge-digests"]',     dialog).checked = state.prefs.mergeDigests;
  $('[data-bind="pref-include-prereleases"]', dialog).checked = state.prefs.includePrereleases;
  $('[data-bind="pref-mono"]',              dialog).checked = state.prefs.mono;

  // live-update body[data-mode] as the radio changes (so the conditional
  // fields show/hide without closing the dialog).
  for (const r of $$('input[name="mode"]', dialog)) {
    r.addEventListener("change", () => { document.body.dataset.mode = r.value; });
  }

  // local-data buttons
  $('[data-action="export-state"]', dialog).addEventListener("click", exportState);
  $('[data-action="import-state"]', dialog).addEventListener("click", importState);
  $('[data-action="reset-state"]',  dialog).addEventListener("click", resetState);

  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "apply") {
      // restore mode tag if user cancelled
      document.body.dataset.mode = state.mode;
      return;
    }
    state.mode  = $('input[name="mode"]:checked', dialog).value;
    state.repo  = $('[data-bind="custom-repo"]', dialog).value.trim();
    state.url   = $('[data-bind="custom-url"]',  dialog).value.trim();
    state.prefs = {
      mergeDigests:       $('[data-bind="pref-merge-digests"]',     dialog).checked,
      includePrereleases: $('[data-bind="pref-include-prereleases"]', dialog).checked,
      mono:               $('[data-bind="pref-mono"]',              dialog).checked,
    };
    saveJson(LS.PREFS, state.prefs);
    localStorage.setItem(LS.MODE, state.mode);
    localStorage.setItem(LS.REPO, state.repo);
    localStorage.setItem(LS.URL,  state.url);
    document.body.dataset.mode = state.mode;
    document.body.classList.toggle("is-mono", state.prefs.mono);
    state.filter = { cat: "all", q: "" };
    $('[data-bind="search"]').value = "";
    $$(".chip").forEach(c => c.classList.toggle("is-on", c.dataset.filter === "all"));
    updateRefreshStatus("Applying source changes…");
    await loadData();
  });
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", e => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const visible = currentlyVisible();
    const idx = visible.findIndex(r => r.version === state.selected);
    switch (e.key) {
      case "j":
        if (idx < visible.length - 1) select(visible[idx + 1].version);
        break;
      case "k":
        if (idx > 0) select(visible[idx - 1].version);
        break;
      case "p":
        if (state.selected) togglePinRelease(state.selected);
        break;
      case "/":
        e.preventDefault();
        $('[data-bind="search"]').focus();
        break;
      case "c":
        openCompare();
        break;
      case "r":
        refreshData({ manual: true });
        break;
      case "s":
        $('[data-bind="settings"]').showModal();
        break;
      case "u":
        toggleUnread();
        break;
      case "Escape":
        if ($('[data-bind="search"]').value) {
          $('[data-bind="search"]').value = "";
          state.filter.q = "";
          renderTimeline(); renderReader();
        }
        break;
    }
  });
}

// ─── Rendering ────────────────────────────────────────────────────────────

function render() {
  // header generated_at line
  const gen = state.data.generated_at ? new Date(state.data.generated_at) : null;
  const sourceLabel = state.data.source_label || "anthropics/claude-code";
  $('[data-bind="generated-at"]').textContent =
    `${sourceLabel} · ${gen ? "refreshed " + relativeTime(gen) : "offline"}`;

  // unread badge
  const unread = countUnread();
  const badge = $('[data-bind="unread-count"]');
  badge.textContent = unread;
  badge.hidden = unread === 0;

  // populate compare pickers
  const fromSel = $('[data-bind="compare-from"]');
  const toSel = $('[data-bind="compare-to"]');
  fromSel.innerHTML = toSel.innerHTML = "";
  for (const r of state.data.releases) {
    const dateBit = r.published_at ? `  · ${r.published_at.slice(0, 10)}` : "";
    fromSel.insertAdjacentHTML("beforeend", `<option value="${esc(r.version)}">${esc(r.version)}${dateBit}</option>`);
    toSel.insertAdjacentHTML("beforeend",   `<option value="${esc(r.version)}">${esc(r.version)}${dateBit}</option>`);
  }
  // sensible defaults: most recent two
  if (state.data.releases[1]) fromSel.value = state.data.releases[1].version;
  if (state.data.releases[0]) toSel.value = state.data.releases[0].version;

  renderTimeline();
  renderReader();
}

function currentlyVisible() {
  const q = state.filter.q;
  const cat = state.filter.cat;
  return state.data.releases.filter(r => {
    if (!state.prefs.includePrereleases && r.is_prerelease) return false;
    if (state.filter.unreadOnly) {
      if (!state.local.lastSeen || !r.published_at || r.published_at <= state.local.lastSeen) return false;
    }
    if (cat === "pinned" && !state.local.pinnedReleases.has(r.version)) return false;
    if (cat !== "all" && cat !== "pinned") {
      if (!(r.bullets || []).some(b => b.category === cat)) return false;
    }
    if (q) {
      const hay =
        r.version.toLowerCase() + " " +
        (r.bullets || []).map(b => b.text).join(" ").toLowerCase() + " " +
        (r.digest_summary || "").toLowerCase() + " " +
        (r.github_body || "").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTimeline() {
  const ol = $('[data-bind="timeline"]');
  ol.innerHTML = "";
  const tpl = $('[data-bind="tpl-timeline-item"]').content;

  const visible = currentlyVisible();
  $('[data-bind="rail-meta"]').textContent =
    visible.length === state.data.releases.length
      ? `${visible.length} releases`
      : `${visible.length} of ${state.data.releases.length} shown`;

  let lastMajor = null;
  for (const r of visible) {
    const major = r.version.split(".").slice(0, 2).join(".");
    if (major !== lastMajor) {
      const li = document.createElement("li");
      li.className = "timeline__major";
      li.textContent = `Series ${major}`;
      ol.appendChild(li);
      lastMajor = major;
    }
    const item = tpl.cloneNode(true);
    const li = item.querySelector(".timeline__item");
    li.dataset.version = r.version;
    if (r.version === state.selected) li.classList.add("is-current");
    if (state.local.pinnedReleases.has(r.version)) li.classList.add("is-pinned");
    if (r.is_prerelease) li.classList.add("is-prerelease");
    if (state.local.lastSeen && r.published_at && r.published_at > state.local.lastSeen) {
      li.classList.add("is-unread");
    }
    item.querySelector(".timeline__version").textContent = r.version;
    item.querySelector(".timeline__date").textContent =
      r.published_at ? formatDate(r.published_at) : "—";
    item.querySelector(".timeline__counts").textContent = countsLine(r);
    li.querySelector(".timeline__btn").addEventListener("click", () => select(r.version));
    ol.appendChild(item);
  }
}

function countsLine(r) {
  const c = r.category_counts || {};
  const parts = [];
  if (c.added)    parts.push(`+${c.added}`);
  if (c.fixed)    parts.push(`⌁${c.fixed}`);
  if (c.improved) parts.push(`↑${c.improved}`);
  if (c.breaking) parts.push(`!${c.breaking}`);
  return parts.join(" ");
}

function renderReader() {
  const reader = $('[data-bind="reader"]');
  if (!state.selected) return;
  const r = state.data.releases.find(x => x.version === state.selected);
  if (!r) {
    renderError(new Error(`Version ${state.selected} not found.`));
    return;
  }

  const tpl = $('[data-bind="tpl-release"]').content.cloneNode(true);

  // sources line — shows which feeds saw this version
  const srcEl = tpl.querySelector(".release__sources");
  for (const s of (r.sources || [])) {
    const span = document.createElement("span");
    span.textContent = sourceLabel(s);
    span.classList.add(`is-${s.replace(/_/g, "-")}`);
    srcEl.appendChild(span);
  }

  tpl.querySelector(".release__version").textContent = r.version;
  tpl.querySelector(".release__date").textContent = r.published_at
    ? `${formatDate(r.published_at, true)} · ${relativeTime(new Date(r.published_at))}`
    : "Date unknown";

  // pin / mark-read / source link
  const pinBtn = tpl.querySelector('[data-action="pin-release"]');
  const isPinned = state.local.pinnedReleases.has(r.version);
  pinBtn.textContent = isPinned ? "★ Pinned" : "★ Pin";
  if (isPinned) pinBtn.setAttribute("aria-pressed", "true");
  pinBtn.addEventListener("click", () => togglePinRelease(r.version));

  tpl.querySelector('[data-action="mark-read-through"]').addEventListener("click", () => {
    if (r.published_at) {
      state.local.lastSeen = r.published_at;
      persistLocal();
      renderTimeline();
      render();  // refresh badge
    }
  });

  const sourceLink = tpl.querySelector('[data-action="open-source"]');
  if (r.github_url) {
    sourceLink.href = r.github_url;
  } else {
    sourceLink.href = `https://github.com/${state.data.default_repo || "anthropics/claude-code"}/releases/tag/v${encodeURIComponent(r.version)}`;
  }

  // digest
  if (state.prefs.mergeDigests && r.digest_summary && r.digest_url) {
    const sec = tpl.querySelector(".release__digest");
    sec.hidden = false;
    sec.querySelector(".release__digest-body").textContent = r.digest_summary;
    sec.querySelector('[data-action="open-digest"]').href = r.digest_url;
  }

  // bullets — grouped by category, filtered by current filters
  const groups = {};
  for (const b of (r.bullets || [])) {
    (groups[b.category] = groups[b.category] || []).push(b);
  }
  const cats = ["breaking", "added", "improved", "fixed", "security", "other"];
  for (const cat of cats) {
    const sec = tpl.querySelector(`.release__group[data-cat="${cat}"]`);
    let items = groups[cat] || [];
    if (state.filter.cat === "pinned") {
      items = items.filter(b => state.local.pins.has(bulletId(r.version, b.text)));
    } else if (state.filter.cat !== "all" && state.filter.cat !== cat) {
      items = [];
    }
    if (state.filter.q) {
      items = items.filter(b => b.text.toLowerCase().includes(state.filter.q));
    }
    if (!items.length) { sec.hidden = true; continue; }
    sec.hidden = false;
    const ul = sec.querySelector(".release__bullets");
    ul.innerHTML = "";
    for (const b of items) {
      ul.appendChild(renderBullet(r.version, b));
    }
  }

  reader.innerHTML = "";
  reader.appendChild(tpl);
  // remember selection
  localStorage.setItem(LS.SELECTED, r.version);
}

function renderBullet(version, b) {
  const li = document.createElement("li");
  const id = bulletId(version, b.text);
  if (state.local.pins.has(id)) li.classList.add("is-pinned");
  let html = "";
  if (b.scope) html += `<span class="scope">${esc(b.scope)}</span>`;
  // Strip the leading [scope] from display since we render it as a chip.
  let text = b.scope ? b.text.replace(/^\[[^\]]+\]\s+/, "") : b.text;
  html += renderInlineMarkdown(text);
  if (state.filter.q) html = highlight(html, state.filter.q);
  li.innerHTML = html;
  li.title = "Click to pin / unpin";
  li.addEventListener("click", () => {
    if (state.local.pins.has(id)) state.local.pins.delete(id);
    else state.local.pins.add(id);
    li.classList.toggle("is-pinned");
    persistLocal();
  });
  return li;
}

/** Tiny markdown-inline renderer: `code`, **bold**, *italic*, [text](url). */
function renderInlineMarkdown(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  s = s.replace(/(^|[\s(])\*([^*]+)\*/g, (_, lead, c) => `${lead}<em>${c}</em>`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) =>
    `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  return s;
}

function highlight(html, q) {
  if (!q) return html;
  // We can't naively wrap matches because we may have already produced HTML
  // tags above. Walk the DOM after insertion instead. Cheaper: build a
  // detached fragment and walk text nodes.
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  const walk = node => {
    if (node.nodeType === 3) {
      const v = node.nodeValue;
      if (!re.test(v)) return;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = re.exec(v))) {
        if (m.index > last) frag.appendChild(document.createTextNode(v.slice(last, m.index)));
        const mark = document.createElement("mark");
        mark.textContent = m[0];
        frag.appendChild(mark);
        last = m.index + m[0].length;
      }
      if (last < v.length) frag.appendChild(document.createTextNode(v.slice(last)));
      node.parentNode.replaceChild(frag, node);
    } else if (node.nodeType === 1 && node.nodeName !== "MARK") {
      [...node.childNodes].forEach(walk);
    }
  };
  [...tmp.childNodes].forEach(walk);
  return tmp.innerHTML;
}

// ─── Selection / pin / read ───────────────────────────────────────────────

function select(version) {
  state.selected = version;
  $$(".timeline__item").forEach(li => li.classList.toggle("is-current", li.dataset.version === version));
  // scroll selected into view in the rail
  const cur = $(`.timeline__item[data-version="${CSS.escape(version)}"]`);
  if (cur) cur.scrollIntoView({ block: "nearest" });
  renderReader();
}

function togglePinRelease(version) {
  if (state.local.pinnedReleases.has(version)) state.local.pinnedReleases.delete(version);
  else state.local.pinnedReleases.add(version);
  persistLocal();
  renderTimeline();
  renderReader();
}

function countUnread() {
  if (!state.local.lastSeen) return 0;
  return (state.data?.releases || []).filter(r => r.published_at && r.published_at > state.local.lastSeen).length;
}

function toggleUnread() {
  const btn = $('[data-action="toggle-unread"]');
  state.filter.unreadOnly = !state.filter.unreadOnly;
  btn.setAttribute("aria-pressed", String(state.filter.unreadOnly));
  renderTimeline();
  renderReader();
}

// ─── Compare ──────────────────────────────────────────────────────────────

function openCompare() {
  $('[data-bind="compare"]').showModal();
  doCompare();
  $('[data-bind="compare-from"]').onchange = doCompare;
  $('[data-bind="compare-to"]').onchange = doCompare;
}

function doCompare() {
  const fromV = $('[data-bind="compare-from"]').value;
  const toV   = $('[data-bind="compare-to"]').value;
  const all = state.data.releases;
  const fromIdx = all.findIndex(r => r.version === fromV);
  const toIdx   = all.findIndex(r => r.version === toV);
  if (fromIdx < 0 || toIdx < 0) return;
  const [a, b] = fromIdx < toIdx ? [toIdx, fromIdx] : [fromIdx, toIdx];
  // releases is newest-first, so older has larger index
  const slice = all.slice(b, a);  // exclusive of older bound
  const groups = { breaking: [], added: [], improved: [], fixed: [], security: [], other: [] };
  for (const r of slice) {
    for (const bullet of (r.bullets || [])) {
      groups[bullet.category]?.push({ version: r.version, ...bullet });
    }
  }
  const body = $('[data-bind="compare-body"]');
  body.innerHTML = "";
  const cats = ["breaking", "added", "improved", "fixed", "security", "other"];
  const labels = { breaking:"Breaking", added:"Added", improved:"Improved", fixed:"Fixed", security:"Security", other:"Other" };
  let any = false;
  for (const cat of cats) {
    if (!groups[cat].length) continue;
    any = true;
    const group = document.createElement("div");
    group.className = "compare__group";
    group.innerHTML = `<h3>${labels[cat]} <span class="kicker">${groups[cat].length} item${groups[cat].length === 1 ? "" : "s"}</span></h3>`;
    const ul = document.createElement("ul");
    ul.className = "compare__list";
    for (const it of groups[cat]) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="compare__version">${esc(it.version)}</span>${renderInlineMarkdown(it.text)}`;
      ul.appendChild(li);
    }
    group.appendChild(ul);
    body.appendChild(group);
  }
  if (!any) {
    body.innerHTML = `<p class="reader__placeholder"><em>No changes between these two versions in the current data.</em></p>`;
  }
}

// ─── Local-data import/export/reset ───────────────────────────────────────

function exportState() {
  const blob = new Blob([JSON.stringify({
    prefs: state.prefs,
    local: {
      pins: [...state.local.pins],
      pinnedReleases: [...state.local.pinnedReleases],
      lastSeen: state.local.lastSeen,
    },
    mode: state.mode, repo: state.repo, url: state.url,
  }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `claude-code-tracker-state-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importState() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "application/json,.json";
  inp.onchange = async () => {
    const file = inp.files?.[0]; if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      if (obj.prefs) saveJson(LS.PREFS, obj.prefs);
      if (obj.local) saveJson(LS.LOCAL, obj.local);
      if (obj.mode)  localStorage.setItem(LS.MODE, obj.mode);
      if (obj.repo)  localStorage.setItem(LS.REPO, obj.repo);
      if (obj.url)   localStorage.setItem(LS.URL,  obj.url);
      location.reload();
    } catch (e) { alert("Couldn't parse that file: " + e.message); }
  };
  inp.click();
}

function resetState() {
  if (!confirm("Wipe all local pins, read state, and source preferences from this browser?")) return;
  for (const k of Object.values(LS)) localStorage.removeItem(k);
  location.reload();
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sourceLabel(s) {
  switch (s) {
    case "changelog":       return "CHANGELOG.md";
    case "github_releases": return "GitHub Releases";
    case "whats_new":       return "What's New";
    case "custom":          return "Custom";
    default:                return s;
  }
}

function formatDate(iso, full = false) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (full) return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return d.toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });
}

function relativeTime(d) {
  const diffSec = (Date.now() - d.getTime()) / 1000;
  const u = [
    [60, "second"], [60, "minute"], [24, "hour"],
    [7, "day"], [4.345, "week"], [12, "month"], [Infinity, "year"],
  ];
  let val = diffSec, unit = "second";
  for (const [k, name] of u) {
    if (val < k) { unit = name; break; }
    val /= k;
  }
  const v = Math.round(val);
  return `${v} ${unit}${v === 1 ? "" : "s"} ago`;
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
