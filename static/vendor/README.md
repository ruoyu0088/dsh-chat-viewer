# Vendored browser dependencies

These files are **third-party libraries**, copied into the repository so the
viewer works fully offline without a Node.js build step at runtime.  They are
not part of this project's source code; keep their license files when
redistributing.

| Directory | Version | Upstream | License |
|---|---|---|---|
| `marked/12.0.2/` | 12.0.2 | https://github.com/markedjs/marked | MIT |
| `highlight.js/11.10.0/` | 11.10.0 | https://github.com/highlightjs/highlight.js | BSD-3-Clause |
| `katex/0.16.11/` | 0.16.11 | https://github.com/KaTeX/KaTeX | MIT |

## Files

- `marked/12.0.2/marked.min.js` — Markdown parser.
- `highlight.js/11.10.0/hljs.min.js` — syntax highlighter core.
- `highlight.js/11.10.0/hljs-light.css`, `hljs-dark.css` — light/dark themes.
- `highlight.js/11.10.0/hljs-dos.js`, `hljs-powershell.js` — extra grammars used
  by the viewer (`dos` for `.bat`/`.cmd`, `powershell` for `.ps1`/`pwsh`).
- `katex/0.16.11/katex.min.js`, `katex.min.css`, `fonts/` — math rendering.

## Updating a dependency

1. Read the upstream release notes and license.
2. Replace the files in the versioned directory (or add a new version
   directory and update `static/index.html`).
3. Update the table above and `THIRD_PARTY_NOTICES.md`.
4. Recompute checksums and keep them in the upgrade commit / release notes
   (PowerShell):

   ```powershell
   Get-ChildItem static/vendor -Recurse -File |
     Get-FileHash -Algorithm SHA256 |
     ForEach-Object { "$($_.Hash)  $($_.Path)" }
   ```

5. Run `tests/test_parser.py`, `tests/smoke.py`, and the optional `tests/ui.js`.

The minified bundles are committed as generated/vendored files; see
`.gitattributes`.
