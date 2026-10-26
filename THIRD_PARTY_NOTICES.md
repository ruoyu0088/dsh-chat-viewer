# Third-party static assets

The viewer ships local, offline copies of the following browser libraries so it
can run without CDN access or a Node.js build step. They are **not** part of
this project's source code; preserve their copyright and license notices when
redistributing.

| Vendored path | Version | Upstream | License | License text |
|---|---|---|---|---|
| `static/vendor/marked/12.0.2/marked.min.js` | 12.0.2 | [marked](https://github.com/markedjs/marked) | MIT | [marked-MIT.txt](static/vendor/LICENSES/marked-MIT.txt) |
| `static/vendor/highlight.js/11.10.0/` | 11.10.0 | [highlight.js](https://github.com/highlightjs/highlight.js) | BSD-3-Clause | [highlight.js-BSD-3-Clause.txt](static/vendor/LICENSES/highlight.js-BSD-3-Clause.txt) |
| `static/vendor/katex/0.16.11/` | 0.16.11 | [KaTeX](https://github.com/KaTeX/KaTeX) | MIT | [katex-MIT.txt](static/vendor/LICENSES/katex-MIT.txt) |

`highlight.js/11.10.0/` includes the light/dark themes and the `dos` /
`powershell` grammar additions used by the viewer.

See [`static/vendor/README.md`](static/vendor/README.md) for the file list and
the update procedure.

The Python code and the viewer's own `static/app.js`, `static/style.css`, and
`static/index.html` are original to this project and use no third-party Python
packages.
