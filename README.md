# The Claude Code Release Log

A reading-first tracker for [Claude Code](https://github.com/anthropics/claude-code) releases. Aggregates the official `CHANGELOG.md`, the GitHub Releases feed, and the weekly *What's New* digests into a single, searchable, keyboard-driven timeline.

> Inspired by [marckrenn/claude-code-changelog](https://github.com/marckrenn/claude-code-changelog), which archives the extracted system prompts of each release as markdown. This project is the complement: a reading view focused on **understanding** what changed and what to act on, with multi-source aggregation and live overrides.

---

## Why this exists

The official Claude Code changelog is dense — sometimes 25+ bullets per release, with breaking changes, env vars, and hot-reload behavior buried among scope-tagged fixes. Three separate surfaces publish it (the docs site, the GitHub releases feed, and a curated weekly digest), and none of them is a great *reading* experience for someone who actually uses the tool every day.

This site solves that by:

- **Aggregating** all three sources into one timeline, deduped by version
- **Categorizing** every bullet into Added / Fixed / Improved / Breaking / Security so you can scan or filter
- **Surfacing the weekly digest summary** alongside the raw bullets when one is available
- Letting you **pin** the items you care about and **mark releases as read** so subsequent visits show only what's new
- Letting you **switch the source** to any other GitHub repo or any markdown changelog URL — same UI, same shortcuts

## Features

| | |
|---|---|
| **Multi-source merge** | `CHANGELOG.md` + GitHub Releases API + What's New weekly digests, deduped by version |
| **Live source switching** | Track any `owner/name` repo, or paste any GitHub releases / single-tag / raw `.md` URL — UI parses it client-side |
| **Search** | Full-text across versions, bullets, and digest bodies |
| **Category filters** | Added / Fixed / Improved / Breaking / Security / Pinned |
| **Pin & read state** | Pin individual bullets or whole releases; "mark all up to here as read" |
| **Compare** | Diff two versions: every bullet between them, grouped by category |
| **Keyboard-driven** | `j`/`k` step versions · `/` search · `p` pin · `c` compare · `s` sources |
| **Local-only state** | Pins, read state, and source preferences live in `localStorage`. Export/import as JSON. |
| **Deploys to Pages** | Pure static site. The action below rebuilds the JSON on schedule, while the page also supports manual refresh and periodic browser rechecks. |

## Quick start

1. **Fork** or template this repo.
2. Enable **GitHub Pages**: *Settings → Pages → Build and deployment → Source: GitHub Actions*.
3. The workflow at `.github/workflows/refresh-data.yml` will run on push, then every 6 hours after that. It rebuilds `data/releases.json` and redeploys Pages.
4. The page itself fetches `data/releases.json` on first load, lets you manually refresh in-browser, and re-checks periodically while the tab stays open.
5. Visit `https://<your-username>.github.io/<repo-name>/`.

That's it for the default `anthropics/claude-code` view. If you want to track a different repo, two options:

**Soft override (per-browser, no fork):** Open *Sources* (top-right gear), choose *Track a different GitHub repo*, paste `owner/name`, click *Apply & reload*. The page fetches releases live from the GitHub API, client-side. Limited to ~60 unauthenticated requests/hr per IP.

**Hard override (every visitor sees it):** Edit the constants at the top of `scripts/build_data.py`:

```python
CHANGELOG_URL        = "https://raw.githubusercontent.com/<owner>/<repo>/main/CHANGELOG.md"
RELEASES_API_URL     = "https://api.github.com/repos/<owner>/<repo>/releases?per_page=100"
WHATS_NEW_INDEX_URL  = ""   # leave empty if your project doesn't have one
```

Then push. The action rebuilds.

## Architecture

```
.
├── index.html                    # markup + templates
├── assets/
│   ├── style.css                 # editorial dark theme (Fraunces + JetBrains Mono)
│   ├── app.js                    # render, search, filter, pin, compare, settings
│   └── parsers.js                # client-side parsers for the override modes
├── data/
│   └── releases.json             # built artifact, committed by the action
├── scripts/
│   └── build_data.py             # the data fetcher
└── .github/workflows/
    └── refresh-data.yml          # cron: */6h, push: main
```

**Data flow:**

```
                   ┌────────────────────┐
                   │  CHANGELOG.md      │ ── source of truth for bullets
                   ├────────────────────┤
   build_data.py ──┤  GitHub Releases   │ ── source of truth for dates
                   ├────────────────────┤
                   │  What's New page   │ ── source of curated digests
                   └────────────────────┘
                            │
                            ▼
                  data/releases.json (committed by action)
                            │
                            ▼
              index.html  +  app.js  +  style.css

  In override modes, app.js → parsers.js fetches & parses live in the browser
  and feeds the same renderer.
```

The bullet categorizer is deliberately mirrored between `build_data.py` (default mode) and `parsers.js` (override modes) so output looks identical regardless of source.

## Custom-URL ingest

When you paste a URL in the *Ingest any GitHub release-notes URL* mode, the parser auto-detects:

| URL shape | What happens |
|---|---|
| `github.com/owner/repo` | `/releases` API |
| `github.com/owner/repo/releases` | `/releases` API |
| `github.com/owner/repo/releases/tag/X` | single release fetch |
| `github.com/owner/repo/blob/<branch>/CHANGELOG.md` | raw fetch + markdown parse |
| `raw.githubusercontent.com/.../*.md` | raw fetch + markdown parse |

The markdown parser handles two heading conventions:

- Plain: `## 1.2.3` or `## v1.2.3`
- [Keep a Changelog](https://keepachangelog.com/): `## [1.2.3] - 2024-01-15` (date is captured)

## Categorization rules

The same regex-driven classifier runs in Python and JavaScript. First match wins, in this order:

1. **breaking** — leading `breaking|removed|deprecated`
2. **security** — `security` or `CVE-XXXX`
3. **added** — `added|new|introduce|now supports/works/accepts/shows`
4. **fixed** — leading `fixed`
5. **improved** — `improved|updated|changed|tweaked|refactor|polish`
6. **other** — fallthrough

If you hit a project that uses different conventions, edit `CATEGORY_RULES` in both files. They're at the top.

## Privacy

Nothing is sent off your machine. Pins, read state, and source preferences live in `localStorage` under the `cclog:` namespace. The site makes outbound requests to:

- `data/releases.json` (same-origin, your fork)
- `api.github.com` and `raw.githubusercontent.com` (only in override modes, same as the GitHub UI)

Use *Sources → Local data → Reset* to wipe everything for the origin.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | next / previous version in the rail |
| `/` | focus search |
| `p` | pin / unpin the selected release |
| `c` | open compare |
| `s` | open sources |
| `Esc` | clear search |

## Acknowledgements

- [marckrenn/claude-code-changelog](https://github.com/marckrenn/claude-code-changelog) — for the idea of treating Claude Code's evolution as a first-class document
- [anthropics/claude-code](https://github.com/anthropics/claude-code) — the upstream
- [Fraunces](https://fonts.google.com/specimen/Fraunces) — the display serif
- [JetBrains Mono](https://www.jetbrains.com/mono/) — for the version numbers

## License

MIT — see [LICENSE](LICENSE).

This project is not affiliated with Anthropic. It republishes content from public sources for a reading-friendly UI; all release-notes copy belongs to its respective authors.
