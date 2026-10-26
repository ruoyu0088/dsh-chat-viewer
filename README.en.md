# DSH Chat Viewer

[中文](README.md) | **English**

A read-only local web viewer for **DeepSeek Harness (DSH)** session history. The
left pane lists all sessions grouped by workspace; selecting a session shows its
questions in the middle pane; selecting a question renders the answer on the
right, including Markdown, images, collapsible thinking, and tool calls.

Data comes directly from the zstd-compressed JSONL logs under
`%USERPROFILE%\.dsh\sessions`. The viewer never writes to or locks the DSH
session store.

## Features

- Session list built from metadata only; the full log is read when a session is
  opened.
- Three-pane layout with **resizable** session and question panes (desktop).
  Drag the divider; double-click it to reset; widths are remembered in
  `localStorage`.
- Responsive layout:
  - below 1100 px, the session pane becomes an off-canvas drawer;
  - below 760 px, both side panes become drawers, leaving the answer full width.
- **Chinese / English UI** with a language selector in the top bar. The choice
  is remembered; the initial language follows the browser (`zh-*` → Chinese,
  otherwise English). Log content is never translated.
- Markdown rendering (marked), math (KaTeX), syntax highlighting
  (highlight.js), inline images, attachments, and file links.
- Collapsible thinking, compaction summaries, todos, notices, and ask/todo
  question cards.
- Tool calls are collapsed and lazy-loaded. A toolbar filters by keyword,
  optionally including output, and can collapse/expand only the visible cards.
  Headers keep status badges (exit code, errors, job status, duration, line
  range).
- Search within a session or across all sessions, with question/answer scope.
- Follow mode refreshes every 3 seconds and preserves the open question.

## Requirements

- **Python 3.14+** (standard library `compression.zstd`). No third-party Python
  packages are required.
- A modern browser. No Node.js is needed at runtime.

## Run

Double-click `run.bat`, or run:

```bat
py -3.14 server.py
```

`run.bat` looks for Python in this order:

1. `DSH_VIEWER_PYTHON` environment variable;
2. the local development environment `C:\pixi_env\.pixi\envs\default\python.exe`;
3. `py -3.14`;
4. `python` from `PATH`, if it is 3.14+.

The default URL is <http://127.0.0.1:8766>. Useful options:

```bat
python server.py --port 8790          :: change port
python server.py --no-open            :: do not open a browser
python server.py --home D:\dsh-home   :: alternate DSH home
```

## Keyboard shortcuts

- `Ctrl+B`: cycle all shown → sessions hidden → all hidden → all shown.
- `Ctrl+Shift+B`: toggle the questions pane.
- `/`: focus search (expands the questions pane if needed).
- `j` / `k` / `↑` / `↓`: move between questions.

## How it works

### Metadata-first loading

`/api/chats` reads only the session header (first zstd frame), the projection
cache, and `workspace.json`. `/api/chats/<sid>/questions` parses the full log on
first open and caches it. The session header is 64 KB at most.

### Zstd framing

DSH logs are append-only JSONL split into many independent Zstandard frames.
`zstd.ZstdFile` streams the frames without materializing each one, which is much
faster than repeatedly calling `zstd.decompress()`.

### Tool calls

`/api/turn/<sid>/<seq>` returns the answer and a tool-call summary but no card
bodies. `/api/turn/<sid>/<seq>/calls` renders the cards only when the outer
tool section is expanded. Individual cards build their body lazily. A
`calls_revision` hash detects when live updates require a reload.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | DSH home, counts, loaded state |
| `GET /api/chats` | session list (metadata only) |
| `GET /api/chats/<sid>/questions` | questions, optional `q` / `scope` |
| `GET /api/turn/<sid>/<seq>` | answer and tool summary |
| `GET /api/turn/<sid>/<seq>/calls` | rendered tool cards |
| `GET /api/search?q=...` | search across sessions |
| `GET /file?path=...` | image files only |
| `GET /attachment?...` | DSH attachments |

## Security

- Binds to `127.0.0.1` by default.
- Validates the `Host` header (DNS-rebinding guard).
- `/file` serves image extensions only and rejects files outside the selected
  working directory.
- No upload, write, or delete endpoints.

## Files

| Path | Purpose |
|---|---|
| `server.py` | standard-library HTTP server and JSON API |
| `lib/dsh.py` | zstd JSONL parsing, turns, tool cards, cache, search |
| `static/index.html` | page shell |
| `static/app.js` | frontend logic, i18n, resizable layout, drawers |
| `static/i18n.js` | English source strings and Chinese dictionary |
| `static/style.css` | light/dark styles and responsive layout |
| `static/vendor/` | pinned third-party browser libraries and licenses |
| `run.bat` | Windows launcher |
| `tests/` | parser, HTTP smoke, and optional jsdom UI tests |

## Tests

```bat
cd tests
py -3.14 test_parser.py
py -3.14 smoke.py
```

Optional browser-level test (needs jsdom and a running viewer):

```bat
cd tests
npm install
node ui.js
```

## Third-party assets

- marked 12.0.2 (MIT)
- highlight.js 11.10.0 (BSD-3-Clause)
- KaTeX 0.16.11 (MIT)

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[static/vendor/README.md](static/vendor/README.md) for versions, licenses, and
the update procedure.

## Known limitations

- Read-only; no editing, deletion, or export beyond copying text.
- The viewer reads local DSH data and is intended for local use.
- Very large sessions may take a few seconds on first open; later opens use the
  in-memory cache.
