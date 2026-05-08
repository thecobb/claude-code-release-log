/* ===========================================================================
   parsers.js
   ---------------------------------------------------------------------------
   Client-side ingest for the two non-default modes:

     • custom-repo : owner/name -> GitHub Releases API
     • custom-url  : any github.com / raw.githubusercontent.com URL
                       -> auto-detect releases page, single tag, or raw .md

   The shape we emit matches what `scripts/build_data.py` writes to
   data/releases.json, so the renderer doesn't need to know the source.
   =========================================================================== */

const GITHUB_API = "https://api.github.com";

// Same category rules as the python builder, kept in sync deliberately.
const CATEGORY_RULES = [
  ["breaking", /^\s*(breaking|removed|deprecated)\b/i],
  ["security", /\bsecurity\b|\bCVE-\d+/i],
  ["added",    /^\s*(added|new|introduce[sd]?|now\s+(supports?|works?|accepts?|shows?))\b/i],
  ["fixed",    /^\s*fixed\b/i],
  ["improved", /^\s*(improved|updated|changed|tweaked|refactor|polish)\b/i],
];

const SCOPE_PREFIX = /^\[([^\]]+)\]\s+/;
const VERSION_HEADER = /^##\s+v?(\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?)\s*(?:[-–—]\s*(.+?))?\s*$/gm;
// "Keep a Changelog" style: `## [1.0.0] - 2024-01-01`
const KAC_VERSION_HEADER = /^##\s+\[v?(\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?)\]\s*[-–—]\s*(\d{4}-\d{2}-\d{2})/gm;


export function categorize(text) {
  const plain = text.replace(SCOPE_PREFIX, "").trim();
  for (const [label, rx] of CATEGORY_RULES) {
    if (rx.test(plain)) return label;
  }
  return "other";
}

function finalizeBullet(text) {
  text = text.trim();
  const m = text.match(SCOPE_PREFIX);
  return {
    text,
    category: categorize(text),
    scope: m ? m[1] : null,
  };
}

/**
 * Pull top-level `- ` bullets out of a markdown body. Handles wrapped
 * continuation lines (indented by 2 spaces) and stops at blank lines or
 * subheadings, matching the Python parser.
 */
export function parseBullets(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let current = null;
  for (const raw of lines) {
    if (raw.startsWith("- ")) {
      if (current) out.push(finalizeBullet(current.join(" ")));
      current = [raw.slice(2).trim()];
    } else if (current && /^(\s{2,}|\t)/.test(raw)) {
      current.push(raw.trim());
    } else if (raw.trim() === "") {
      if (current) { out.push(finalizeBullet(current.join(" "))); current = null; }
    } else {
      if (current) { out.push(finalizeBullet(current.join(" "))); current = null; }
    }
  }
  if (current) out.push(finalizeBullet(current.join(" ")));
  return out;
}

/**
 * Parse a CHANGELOG.md / RELEASES.md / NEWS.md body. Supports plain
 * `## 1.2.3` headers and Keep-a-Changelog `## [1.2.3] - 2024-..` headers.
 */
export function parseMarkdownChangelog(text) {
  const releases = new Map();

  // First pass: KAC-style with embedded dates wins on date.
  const kacMatches = [...text.matchAll(KAC_VERSION_HEADER)];
  if (kacMatches.length) {
    for (let i = 0; i < kacMatches.length; i++) {
      const m = kacMatches[i];
      const version = m[1];
      const date = m[2] + "T00:00:00Z";
      const start = m.index + m[0].length;
      const end = i + 1 < kacMatches.length ? kacMatches[i + 1].index : text.length;
      releases.set(version, {
        version,
        published_at: date,
        bullets: parseBullets(text.slice(start, end)),
        sources: ["custom"],
      });
    }
    return [...releases.values()];
  }

  // Fallback: plain `## v?X.Y.Z` headers, no embedded date.
  const matches = [...text.matchAll(VERSION_HEADER)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const version = m[1];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    releases.set(version, {
      version,
      published_at: null,
      bullets: parseBullets(text.slice(start, end)),
      sources: ["custom"],
    });
  }
  return [...releases.values()];
}


// ─── GitHub Releases API ──────────────────────────────────────────────────

async function ghJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) {
    const limit = res.headers.get("x-ratelimit-remaining");
    if (res.status === 403 && limit === "0") {
      throw new Error("GitHub API rate limit hit (60/hr unauthenticated). Try again in an hour, or use the build action in this repo.");
    }
    throw new Error(`GitHub returned ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

/** Convert one /releases item into our internal release shape. */
function releaseFromGitHubItem(item) {
  const version = (item.tag_name || "").replace(/^v/, "");
  const body = item.body || "";
  // The body of a GitHub release is usually a markdown bullet list. Parse
  // it the same way we parse CHANGELOG section bodies — the categorizer
  // does the heavy lifting.
  const bullets = parseBullets(body);
  return {
    version,
    published_at: item.published_at || null,
    bullets,
    sources: ["github_releases"],
    github_url: item.html_url || null,
    github_body: body || null,
    is_prerelease: !!item.prerelease,
  };
}

export async function fetchRepoReleases(slug, { perPage = 50, pages = 2 } = {}) {
  const [owner, name] = slug.split("/").map(s => s.trim());
  if (!owner || !name) throw new Error('Repo must look like "owner/name"');
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=${perPage}&page=${page}`;
    const items = await ghJson(url);
    if (!Array.isArray(items) || !items.length) break;
    for (const item of items) out.push(releaseFromGitHubItem(item));
    if (items.length < perPage) break;
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    default_repo: slug,
    release_count: out.length,
    releases: out,
    digests: [],
    source_label: `github.com/${slug}`,
  };
}


// ─── Single GitHub URL ingest ────────────────────────────────────────────

/**
 * Detect what a pasted github.com / raw.githubusercontent.com URL points at
 * and parse it. Supported:
 *
 *   /owner/repo                                 -> releases list
 *   /owner/repo/releases                        -> releases list
 *   /owner/repo/releases/tag/<tag>              -> single release
 *   /owner/repo/blob/<branch>/<path>.md         -> raw markdown changelog
 *   raw.githubusercontent.com/owner/repo/<…>.md -> raw markdown changelog
 */
export async function fetchAnyGitHubUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("Not a valid URL."); }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);

  if (host === "raw.githubusercontent.com") {
    // /owner/repo/branch/path...
    const [owner, repo] = parts;
    if (!owner || !repo) throw new Error("Raw URL missing owner/repo.");
    const text = await (await fetch(u.toString())).text();
    return wrapMarkdown(text, `${owner}/${repo}`, u.toString());
  }

  if (host !== "github.com") {
    throw new Error("Only github.com and raw.githubusercontent.com URLs are supported.");
  }

  const [owner, repo, kind, ...rest] = parts;
  if (!owner || !repo) throw new Error("URL is missing owner/repo.");
  const slug = `${owner}/${repo}`;

  // /owner/repo or /owner/repo/releases
  if (!kind || kind === "releases" && rest.length === 0) {
    return fetchRepoReleases(slug);
  }

  // /owner/repo/releases/tag/<tag>
  if (kind === "releases" && rest[0] === "tag" && rest[1]) {
    const tag = decodeURIComponent(rest.slice(1).join("/"));
    const item = await ghJson(`${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    const release = releaseFromGitHubItem(item);
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      default_repo: slug,
      release_count: 1,
      releases: [release],
      digests: [],
      source_label: `github.com/${slug}@${tag}`,
    };
  }

  // /owner/repo/blob/<branch>/<path>
  if (kind === "blob" && rest.length >= 2) {
    const [branch, ...path] = rest;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path.join("/")}`;
    const text = await (await fetch(rawUrl)).text();
    return wrapMarkdown(text, slug, rawUrl);
  }

  throw new Error(`Don't know how to ingest path: ${u.pathname}`);
}

function wrapMarkdown(text, slug, sourceUrl) {
  const releases = parseMarkdownChangelog(text);
  if (!releases.length) {
    throw new Error("Couldn't find any version headings (## 1.2.3 …) in that markdown file.");
  }
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    default_repo: slug,
    release_count: releases.length,
    releases,
    digests: [],
    source_label: sourceUrl,
  };
}
