# Setup notes

## First push

```bash
gh repo create claude-code-release-log --public --source=. --remote=origin --push
```

(or use the web UI; this folder is the full repo).

## Enable Pages

After the first push, go to **Settings → Pages** and set:

- **Source:** GitHub Actions

The first run of the workflow will take a few minutes (it has to fetch all
of the What's New digest pages). After that, Pages will redeploy whenever
`data/releases.json` changes.

## Watching the workflow

```bash
gh run watch
```

## Forcing a refresh

```bash
gh workflow run "Refresh release data"
```

## Tracking a different upstream

Edit the three URL constants at the top of `scripts/build_data.py`:

- `CHANGELOG_URL`
- `RELEASES_API_URL`
- `WHATS_NEW_INDEX_URL`  (set to `""` if there is no equivalent)

Push. The action picks it up.

## Local development

```bash
python3 scripts/build_data.py        # rebuild the JSON
python3 -m http.server 8000          # serve the static site
open http://localhost:8000
```

There is no build step. Just edit and refresh.
