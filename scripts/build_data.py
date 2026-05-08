#!/usr/bin/env python3
"""
build_data.py
=============

Fetch all primary Claude Code release sources, normalize them into a single
JSON document, and write it to ``data/releases.json`` for the static site to
consume.

Sources merged:
  1. CHANGELOG.md (raw, source of truth for per-version bullets)
       https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
  2. GitHub Releases API (source of truth for publish dates / tag URLs)
       https://api.github.com/repos/anthropics/claude-code/releases
  3. What's New weekly digests (curated narrative on what matters)
       https://code.claude.com/docs/en/whats-new
       https://code.claude.com/docs/en/whats-new/<slug>

The script is idempotent and runs from a GitHub Action on a schedule. Network
failures for a single source are logged but do not abort the whole build —
the others still publish.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "data" / "releases.json"

CHANGELOG_URL = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md"
RELEASES_API_URL = "https://api.github.com/repos/anthropics/claude-code/releases?per_page=100"
WHATS_NEW_INDEX_URL = "https://code.claude.com/docs/en/whats-new"

USER_AGENT = "claude-code-tracker/1.0 (+https://github.com)"

# Categories used to bucket changelog bullets. Order matters — first match wins.
# Tuned for the conventions actually used by Anthropic in CHANGELOG.md.
CATEGORY_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("breaking",   re.compile(r"^\s*(breaking|removed|deprecated)\b", re.I)),
    ("security",   re.compile(r"\bsecurity\b|\bCVE-\d+", re.I)),
    ("added",      re.compile(r"^\s*(added|new|introduce[sd]?|now\s+(supports?|works?|accepts?|shows?))\b", re.I)),
    ("fixed",      re.compile(r"^\s*fixed\b", re.I)),
    ("improved",   re.compile(r"^\s*(improved|updated|changed|tweaked|refactor|polish)\b", re.I)),
]


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Bullet:
    text: str
    category: str  # one of: added, fixed, improved, breaking, security, other
    scope: str | None = None  # e.g. "VSCode", "MCP", inferred from leading [Tag]


@dataclass
class Release:
    version: str
    published_at: str | None = None
    bullets: list[Bullet] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)  # which feeds saw this version
    github_url: str | None = None
    github_body: str | None = None  # raw release body if different from changelog
    digest_summary: str | None = None  # synthesized from What's New if available
    digest_url: str | None = None
    is_prerelease: bool = False


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def fetch(url: str, timeout: int = 30) -> str:
    """GET a URL and return the body as text. Raises on non-2xx."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        encoding = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(encoding, errors="replace")


def fetch_json(url: str, timeout: int = 30) -> object:
    token = os.environ.get("GITHUB_TOKEN")
    headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# Source 1: CHANGELOG.md
# ---------------------------------------------------------------------------

VERSION_HEADER = re.compile(r"^##\s+v?(\d+(?:\.\d+){1,3}(?:[-+][\w.]+)?)\s*$", re.M)
SCOPE_PREFIX = re.compile(r"^\[([^\]]+)\]\s+")


def categorize(text: str) -> str:
    plain = SCOPE_PREFIX.sub("", text).strip()
    for label, pattern in CATEGORY_RULES:
        if pattern.search(plain):
            return label
    return "other"


def parse_changelog(text: str) -> dict[str, Release]:
    """Parse CHANGELOG.md into {version: Release}."""
    releases: dict[str, Release] = {}
    matches = list(VERSION_HEADER.finditer(text))
    for i, m in enumerate(matches):
        version = m.group(1)
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        bullets = parse_bullets(body)
        releases[version] = Release(
            version=version,
            bullets=bullets,
            sources=["changelog"],
        )
    return releases


def parse_bullets(body: str) -> list[Bullet]:
    """Extract top-level `- ` bullets, joining wrapped continuation lines."""
    bullets: list[Bullet] = []
    current: list[str] | None = None
    for raw_line in body.splitlines():
        if raw_line.startswith("- "):
            if current:
                bullets.append(_finalize_bullet(" ".join(current)))
            current = [raw_line[2:].strip()]
        elif current is not None and raw_line.startswith(("  ", "\t")):
            current.append(raw_line.strip())
        elif raw_line.strip() == "":
            if current:
                bullets.append(_finalize_bullet(" ".join(current)))
                current = None
        else:
            # ignore subheadings or stray prose
            if current:
                bullets.append(_finalize_bullet(" ".join(current)))
                current = None
    if current:
        bullets.append(_finalize_bullet(" ".join(current)))
    return bullets


def _finalize_bullet(text: str) -> Bullet:
    text = text.strip()
    scope = None
    m = SCOPE_PREFIX.match(text)
    if m:
        scope = m.group(1)
    return Bullet(text=text, category=categorize(text), scope=scope)


# ---------------------------------------------------------------------------
# Source 2: GitHub Releases API
# ---------------------------------------------------------------------------

def fetch_github_releases(api_url: str = RELEASES_API_URL) -> list[dict]:
    """Return up to ~100 most recent releases from the GitHub API.

    Falls back to an empty list if the request fails (e.g. unauthenticated rate
    limit). The CHANGELOG-derived data is sufficient on its own; this source
    just enriches it with publish dates and html_urls.
    """
    try:
        data = fetch_json(api_url)
    except (urllib.error.URLError, urllib.error.HTTPError) as exc:
        print(f"[warn] GitHub releases API unavailable: {exc}", file=sys.stderr)
        return []
    if not isinstance(data, list):
        print(f"[warn] Unexpected releases API shape: {data!r}", file=sys.stderr)
        return []
    return data


def merge_github_releases(releases: dict[str, Release], gh: Iterable[dict]) -> None:
    for r in gh:
        tag = (r.get("tag_name") or "").lstrip("v")
        if not tag:
            continue
        rel = releases.setdefault(tag, Release(version=tag, sources=[]))
        rel.published_at = r.get("published_at") or rel.published_at
        rel.github_url = r.get("html_url")
        rel.github_body = r.get("body") or None
        rel.is_prerelease = bool(r.get("prerelease"))
        if "github_releases" not in rel.sources:
            rel.sources.append("github_releases")


# ---------------------------------------------------------------------------
# Source 3: What's New weekly digests
# ---------------------------------------------------------------------------

class _LinkExtractor(HTMLParser):
    """Pull href values from anchor tags that look like weekly digest links."""

    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href") or ""
        if "/whats-new/" in href and href != "/docs/en/whats-new":
            self.links.append(href)


WEEK_LINK = re.compile(r"/docs/en/whats-new/(\d{4}-w\d+)")
VERSION_RANGE = re.compile(r"v(\d+(?:\.\d+){1,3})\s*[–-]\s*v(\d+(?:\.\d+){1,3})")


def discover_digest_slugs() -> list[str]:
    try:
        body = fetch(WHATS_NEW_INDEX_URL)
    except Exception as exc:
        print(f"[warn] whats-new index unavailable: {exc}", file=sys.stderr)
        return []
    return list(dict.fromkeys(WEEK_LINK.findall(body)))


def fetch_digest(slug: str) -> dict | None:
    url = f"https://code.claude.com/docs/en/whats-new/{slug}"
    try:
        body = fetch(url)
    except Exception as exc:
        print(f"[warn] digest {slug} unavailable: {exc}", file=sys.stderr)
        return None
    # Strip HTML tags to get readable text content
    text = re.sub(r"<script[\s\S]*?</script>", " ", body)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    version_range = VERSION_RANGE.search(text)
    versions: list[str] = []
    if version_range:
        lo, hi = version_range.groups()
        versions = expand_version_range(lo, hi)

    # Heuristic: pull the first ~600 chars after "What's new" / week heading
    summary_match = re.search(r"(Week\s+\d+[\s\S]{0,1500})", text)
    summary = summary_match.group(1).strip() if summary_match else text[:1500]

    return {
        "slug": slug,
        "url": url,
        "versions": versions,
        "summary": summary,
    }


def expand_version_range(lo: str, hi: str) -> list[str]:
    """Best-effort expansion: handles N.N.N to N.N.M ranges by patch."""
    lo_parts = [int(p) for p in lo.split(".")]
    hi_parts = [int(p) for p in hi.split(".")]
    if len(lo_parts) != len(hi_parts) or lo_parts[:-1] != hi_parts[:-1]:
        return [lo, hi]
    return [".".join(str(p) for p in lo_parts[:-1] + [n])
            for n in range(lo_parts[-1], hi_parts[-1] + 1)]


def merge_digests(releases: dict[str, Release], digests: list[dict]) -> None:
    for d in digests:
        for v in d["versions"]:
            rel = releases.setdefault(v, Release(version=v, sources=[]))
            rel.digest_summary = d["summary"][:1200]
            rel.digest_url = d["url"]
            if "whats_new" not in rel.sources:
                rel.sources.append("whats_new")


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------

def version_key(v: str) -> tuple:
    """Sort key that handles N.N.N and N.N.N-suffix forms."""
    head, _, _ = v.partition("-")
    nums = []
    for p in head.split("."):
        try:
            nums.append(int(p))
        except ValueError:
            nums.append(0)
    while len(nums) < 4:
        nums.append(0)
    return tuple(nums)


def build() -> dict:
    print(f"[info] Fetching CHANGELOG.md…", file=sys.stderr)
    changelog_text = fetch(CHANGELOG_URL)
    releases = parse_changelog(changelog_text)
    print(f"[info]   parsed {len(releases)} versions", file=sys.stderr)

    print(f"[info] Fetching GitHub releases API…", file=sys.stderr)
    gh = fetch_github_releases()
    merge_github_releases(releases, gh)
    print(f"[info]   merged {len(gh)} GitHub releases", file=sys.stderr)

    print(f"[info] Fetching What's New digests…", file=sys.stderr)
    slugs = discover_digest_slugs()
    digests = [d for d in (fetch_digest(s) for s in slugs) if d]
    merge_digests(releases, digests)
    print(f"[info]   merged {len(digests)} weekly digests", file=sys.stderr)

    sorted_releases = sorted(
        releases.values(), key=lambda r: version_key(r.version), reverse=True
    )

    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "default_repo": "anthropics/claude-code",
        "release_count": len(sorted_releases),
        "releases": [serialize_release(r) for r in sorted_releases],
        "digests": digests,
    }


def serialize_release(r: Release) -> dict:
    out = asdict(r)
    counts: dict[str, int] = {}
    for b in r.bullets:
        counts[b.category] = counts.get(b.category, 0) + 1
    out["category_counts"] = counts
    return out


def main() -> int:
    try:
        doc = build()
    except Exception as exc:
        print(f"[error] build failed: {exc}", file=sys.stderr)
        return 1
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[info] Wrote {OUT_PATH} ({OUT_PATH.stat().st_size:,} bytes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
