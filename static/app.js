/* DSH Chat Viewer - front end (vanilla JS, no build step) */
'use strict';

const $ = (sel) => document.querySelector(sel);
const t = window.t;

const state = {
  chats: [],
  chatFilter: '',
  showArchived: true,
  sid: null,
  chat: null,
  turns: [],          // questions of the open session (possibly filtered)
  total: 0,
  qid: null,          // "<session-id>:<seq>"
  turn: null,
  raw: false,
  term: '',
  scope: 'all',
  searchAll: false,
  searchResults: null,
  follow: true,
  questionsLoading: false,
  lang: window.getLanguage(),
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtTime(ts) {
  if (!ts) return '';
  let n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  if (n < 1e11) n *= 1000;                 // tolerate seconds
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  const locale = state.lang === 'zh' ? 'zh-CN' : 'en-US';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return d.toLocaleString(locale, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return t('{value} sec', { value: (n / 1000).toFixed(n < 10_000 ? 1 : 0) });
  return t('{minutes} min {seconds} sec', {
    minutes: Math.floor(n / 60_000),
    seconds: Math.round((n % 60_000) / 1000),
  });
}

function fmtNum(n) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

async function api(path) {
  const res = await fetch(path, { cache: 'no-store' });
  let data;
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------------- images ---------------- */
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const isImagePath = (s) => IMG_RE.test(String(s || '').trim().replace(/[?#].*$/, ''));
const stripMedia = (s) => String(s || '').trim()
  .replace(/^MEDIA:\s*/i, '').replace(/^file:\/\/\//i, '').replace(/\\/g, '/');
const basename = (p) => stripMedia(p).split('/').filter(Boolean).pop() || '';

function resolveLocalPath(p) {
  let value = stripMedia(p);
  if (!value) return value;
  if (/^[A-Za-z]:\//.test(value) || value.startsWith('//') || value.startsWith('/')) return value;
  const cwd = state.chat && state.chat.cwd;
  if (!cwd) return value;
  value = value.replace(/^\.\//, '');
  return stripMedia(cwd).replace(/\/+$/, '') + '/' + value;
}

function refLabel(ref) {
  if (!ref) return '';
  if (typeof ref === 'string') return basename(ref);
  if (ref.kind === 'path') return basename(ref.path);
  if (ref.kind === 'attachment') return t('Attachment {id}', { id: ref.id });
  if (ref.kind === 'url') return basename(ref.url) || ref.url;
  if (ref.kind === 'data') return t('Inline image');
  return basename(ref.path || ref.url || '');
}

function refUrl(ref) {
  if (!ref) return '';
  if (typeof ref === 'string') return '/file?path=' + encodeURIComponent(resolveLocalPath(ref));
  if (ref.kind === 'data' && ref.src) return ref.src;
  if (ref.kind === 'url' && ref.url) return ref.url;
  if (ref.kind === 'attachment' && ref.id) {
    const params = new URLSearchParams({ id: ref.id });
    if (state.sid) params.set('sid', state.sid);
    return '/attachment?' + params.toString();
  }
  if (ref.kind === 'path' && ref.path) return '/file?path=' + encodeURIComponent(resolveLocalPath(ref.path));
  if (ref.path) return '/file?path=' + encodeURIComponent(resolveLocalPath(ref.path));
  if (ref.src) return ref.src;
  if (ref.url) return ref.url;
  return '';
}

function imageFig(ref, small) {
  const src = refUrl(ref);
  const fig = document.createElement('figure');
  fig.className = 'img-fig' + (small ? ' small' : '');
  if (!src) {
    const note = document.createElement('div');
    note.className = 'img-note';
    note.textContent = t('Image reference could not be resolved: {name}', {
      name: refLabel(ref) || t('Unknown'),
    });
    fig.appendChild(note);
    return fig;
  }
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.src = src;
  img.alt = refLabel(ref);
  img.title = refLabel(ref);
  img.onerror = () => {
    const note = document.createElement('div');
    note.className = 'img-note';
    note.textContent = t('Image file no longer exists: {name}', {
      name: refLabel(ref) || t('Unknown'),
    });
    note.title = refLabel(ref);
    img.replaceWith(note);
  };
  img.addEventListener('click', () => window.open(src, '_blank'));
  const cap = document.createElement('figcaption');
  cap.textContent = refLabel(ref);
  fig.append(img, cap);
  return fig;
}

/* turn `MEDIA:C:\x\y.png` lines (outside code fences) into markdown images */
function mediaToImages(md) {
  const parts = String(md || '').split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts.map((seg, i) => {
    if (i % 2 === 1) return seg;                       // fenced code: leave alone
    return seg
      .replace(/^[ \t]*MEDIA:[ \t]*(.+?)[ \t]*$/gm, (m, p) => `\n![image](${stripMedia(p)})\n`)
      .replace(/MEDIA:[ \t]*([^\s`"'<>]+)/g, (m, p) => `![image](${stripMedia(p)})`);
  }).join('');
}

function patchImages(root) {
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (/^(https?:|data:|blob:|\/file\?|\/attachment\?)/i.test(src)) { img.classList.add('md-img'); return; }
    if (!isImagePath(src)) return;
    img.replaceWith(imageFig({ kind: 'path', path: src }, true));
  });
  root.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^\s*javascript:/i.test(href)) a.removeAttribute('href');
    if (isImagePath(href) && !/^https?:/i.test(href)) a.replaceWith(imageFig({ kind: 'path', path: href }));
  });
}

/* ---------------- syntax highlighting + code blocks ---------------- */
function highlightCode(root) {
  if (!window.hljs) return;
  root.querySelectorAll('pre code').forEach((el) => {
    const cls = [...el.classList].find((c) => c.startsWith('language-'));
    const lang = cls ? cls.slice('language-'.length) : '';
    if (lang && !window.hljs.getLanguage(lang)) {
      el.classList.remove(cls);          // grammar not bundled: show plain, skip the console warning
      return;
    }
    try { window.hljs.highlightElement(el); } catch (e) { /* unsupported language */ }
  });
}

function codeBlock(text, lang, label, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'code';
  const head = document.createElement('div');
  head.className = 'code-head';
  const lb = document.createElement('span');
  lb.className = 'code-label';
  lb.textContent = label ? t(label) : (lang || '');
  head.appendChild(lb);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-' + (lang || 'plaintext');
  code.textContent = text == null ? '' : String(text);
  pre.appendChild(code);
  wrap.append(head, pre);

  const copy = document.createElement('button');
  copy.className = 'ghost tiny';
  copy.textContent = t('Copy');
  copy.onclick = async () => {
    try { await copyText(code.textContent); flash(copy, t('Copied')); }
    catch (e) { flash(copy, t('Copy failed')); }
  };
  head.appendChild(copy);

  const lines = code.textContent.split('\n').length;
  if (lines > (opts.lineLimit || 22)) {
    pre.classList.add('clamped');
    const more = document.createElement('button');
    more.className = 'ghost tiny';
    more.textContent = t('Show all ({count} lines)', { count: lines });
    more.onclick = () => {
      const opened = pre.classList.toggle('clamped') === false;
      more.textContent = opened ? t('Collapse') : t('Show all ({count} lines)', { count: lines });
    };
    head.appendChild(more);
  }
  highlightCode(wrap);
  return wrap;
}

/* ---------------- highlight search hits ---------------- */
function highlightIn(root, term) {
  if (!term) return;
  const needle = term.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      const p = node.parentNode;
      if (!p || p.nodeName === 'MARK' || p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE'
        || p.nodeName === 'BUTTON') return NodeFilter.FILTER_REJECT;
      if (p.closest && p.closest('.katex')) return NodeFilter.FILTER_REJECT;  // never split formulas
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const hits = [];
  while (walker.nextNode()) hits.push(walker.currentNode);
  for (const node of hits) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let i = 0, low = text.toLowerCase();
    for (;;) {
      const at = low.indexOf(needle, i);
      if (at < 0) { frag.appendChild(document.createTextNode(text.slice(i))); break; }
      if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)));
      const m = document.createElement('mark');
      m.textContent = text.slice(at, at + needle.length);
      frag.appendChild(m);
      i = at + needle.length;
    }
    node.parentNode.replaceChild(frag, node);
  }
}

/* ---------------- math (KaTeX) ---------------- */
const MATH_SLOT = (i) => `%%DSHMATH${i}%%`;

function looksLikeMath(tex) {
  // Require at least a letter, a command backslash, or a math symbol; plain
  // numbers and currency amounts are not formulas.
  return /[A-Za-z\\^_{}=+\-*\/()\[\]]/.test(tex);
}

/* Replace formulas with placeholders before Markdown parsing; otherwise
   marked eats underscores/asterisks inside formulas and splits multi-line
   $$...$$ blocks. */
function protectMath(md) {
  const slots = [];
  const take = (tex, display) => {
    slots.push({ tex, display });
    return MATH_SLOT(slots.length - 1);
  };
  const parts = String(md || '').split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  const text = parts.map((seg, idx) => {
    if (idx % 2 === 1) return seg;                    // keep $ inside code fences
    let s = seg;
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => take(tex.trim(), true));
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => take(tex.trim(), true));
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => take(tex.trim(), false));
    s = s.replace(/(^|[^\\$])\$(?!\s)([^$\n]{1,400}?)(?<!\s)\$(?!\d)/g,
      (m, lead, tex) => (looksLikeMath(tex) ? lead + take(tex, false) : m));
    return s;
  }).join('');
  return { text, slots };
}

function mathExpander(slots) {
  const render = (i) => {
    const item = slots[Number(i)];
    if (!item) return '';
    try {
      return window.katex.renderToString(item.tex, {
        displayMode: item.display, throwOnError: false, strict: 'ignore', output: 'html',
      });
    } catch (e) {
      return `<code class="math-error">${esc(item.tex)}</code>`;
    }
  };
  return (html) => {
    // Remove the <p> wrapper from a display formula that occupies its own
    // paragraph; block elements must not be nested inside a paragraph.
    const withBlocks = html.replace(/<p>\s*%%DSHMATH(\d+)%%\s*<\/p>/g,
      (m, i) => `<div class="math-block">${render(i)}</div>`);
    return withBlocks.replace(/%%DSHMATH(\d+)%%/g, (m, i) => render(i));
  };
}

/* ---------------- markdown ---------------- */
function mdToHtml(md) {
  const prepared = mediaToImages(md || '');
  const { text: src, slots } = protectMath(prepared);
  if (typeof window.marked === 'undefined') return `<pre class="md-raw">${esc(prepared)}</pre>`;
  let html;
  try {
    const opts = { gfm: true, breaks: true };
    html = (window.marked.parse ? window.marked.parse(src, opts) : window.marked(src, opts));
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<(iframe|object|embed|form|base|meta|link|style)\b[^>]*>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  } catch (e) {
    return `<pre class="md-raw">${esc(prepared)}</pre>`;
  }
  if (typeof window.katex === 'undefined') {
    return html.replace(/%%DSHMATH(\d+)%%/g,
      (m, i) => `<code class="math-error">${esc((slots[Number(i)] || {}).tex || '')}</code>`);
  }
  return mathExpander(slots)(html);
}

/* ---------------- badges / small UI ---------------- */
function badge(text, cls) {
  const span = document.createElement('span');
  span.className = 'badge ' + (cls || '');
  span.textContent = text;
  return span;
}

function tag(text, cls) {
  const span = document.createElement('span');
  span.className = cls || 'badge';
  span.textContent = text;
  return span;
}

function renderTodos(todos, title) {
  if (!Array.isArray(todos) || !todos.length) return null;
  const box = document.createElement('div');
  box.className = 'todos';
  const done = todos.filter((t) => t.status === 'completed' || t.status === 'done').length;
  const head = document.createElement('div');
  head.className = 'todos-head';
  head.textContent = t('{title} ({done}/{total})', {
    title: title || t('Todos'), done, total: todos.length,
  });
  box.appendChild(head);
  for (const todo of todos) {
    const item = document.createElement('div');
    const status = String(todo.status || '');
    item.className = 'todo-item ' + status;
    const icon = document.createElement('span');
    icon.className = 'todo-status';
    icon.textContent = status === 'completed' || status === 'done' ? '✓'
      : status === 'in_progress' || status === 'active' ? '▸'
      : status === 'cancelled' || status === 'canceled' ? '×' : '○';
    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = todo.content || '';
    item.append(icon, text);
    box.appendChild(item);
  }
  return box;
}

function noticeText(notice) {
  if (notice.key === 'plan_mode') {
    return t('Plan mode: {state}', { state: t(notice.active ? 'on' : 'off') });
  }
  if (notice.key === 'model_switch') {
    if (notice.provider && notice.model) {
      return t('Model: {provider} / {model}', {
        provider: notice.provider, model: notice.model,
      });
    }
    return t('Model: {model}', { model: notice.model || notice.provider || '' });
  }
  if (notice.key === 'working_directory') {
    return t('Working directory: {cwd}', { cwd: notice.cwd });
  }
  if (notice.key === 'goal') {
    if (notice.action) {
      return t('Goal {action}: {goal}', { action: notice.action, goal: notice.goal || '' });
    }
    return t('Goal: {goal}', { goal: notice.goal || '' });
  }
  if (notice.key === 'approval') {
    return t('Approval: {decision}', { decision: notice.decision });
  }
  return '';
}

function renderNotices(notices) {
  if (!Array.isArray(notices) || !notices.length) return null;
  const box = document.createElement('div');
  box.className = 'notices';
  for (const notice of notices) {
    const textValue = noticeText(notice);
    if (!textValue) continue;
    const line = document.createElement('div');
    line.className = 'notice';
    const kind = document.createElement('span');
    kind.className = 'notice-kind';
    kind.textContent = String(notice.kind || '');
    const text = document.createElement('span');
    text.textContent = textValue;
    line.append(kind, text);
    box.appendChild(line);
  }
  return box;
}

function renderAskQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'qask-list';
  for (const q of questions) {
    const card = document.createElement('div');
    card.className = 'qask';
    if (q.header) {
      const h = document.createElement('div');
      h.className = 'qask-head';
      h.textContent = q.header;
      card.appendChild(h);
    }
    const question = document.createElement('div');
    question.className = 'qask-q';
    question.textContent = q.question || '';
    card.appendChild(question);

    const selected = Array.isArray(q.selected) ? q.selected.map(String) : [];
    const opts = Array.isArray(q.options) ? q.options : [];
    const ul = document.createElement('ul');
    ul.className = 'qask-opts';
    for (const opt of opts) {
      const li = document.createElement('li');
      li.className = 'qask-opt' + (selected.includes(String(opt.label)) ? ' selected' : '');
      li.textContent = opt.label || '';
      if (opt.description) {
        const desc = document.createElement('span');
        desc.className = 'hint';
        desc.textContent = ' — ' + opt.description;
        li.appendChild(desc);
      }
      ul.appendChild(li);
    }
    // A custom answer may not correspond to any option.
    for (const value of selected) {
      if (!opts.some((o) => String(o.label) === value)) {
        const li = document.createElement('li');
        li.className = 'qask-opt selected';
        li.textContent = value;
        ul.appendChild(li);
      }
    }
    if (ul.children.length) card.appendChild(ul);

    if (q.custom) {
      const custom = document.createElement('div');
      custom.className = 'qask-custom';
      custom.textContent = t('Custom answer: {text}', { text: q.custom });
      card.appendChild(custom);
    }
    if (!selected.length && !q.custom) {
      const none = document.createElement('div');
      none.className = 'qask-none';
      none.textContent = t('No answer recorded');
      card.appendChild(none);
    }
    wrap.appendChild(card);
  }
  return wrap;
}

function renderPresentFiles(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const ul = document.createElement('ul');
  ul.className = 'present-files';
  for (const file of files) {
    const li = document.createElement('li');
    if (typeof file === 'string') {
      li.textContent = file;
    } else if (file && typeof file === 'object') {
      li.textContent = file.path || file.file || file.name || JSON.stringify(file);
      if (file.description) li.title = file.description;
    }
    ul.appendChild(li);
  }
  return ul;
}

/* ---------------- tool calls ---------------- */
function callsSummary(turn) {
  const total = Number(turn.call_count)
    || (turn.tool_summary || []).reduce((a, x) => a + (x.count || 0), 0);
  const names = (turn.tool_summary || [])
    .map((x) => `${x.name}×${x.count}`).join(t('listSeparator'));
  return t('Tool calls ({count}{names})', {
    count: total,
    names: names ? t(': {names}', { names }) : '',
  }) + (turn.callsLoaded ? '' : t(' · load on expand'));
}

function renderCalls(turn) {
  const total = Number(turn.call_count)
    || (turn.tool_summary || []).reduce((a, x) => a + (x.count || 0), 0);
  if (!total) return null;

  const det = document.createElement('details');
  det.className = 'calls';
  det.open = !!turn.callsOpen;

  const sum = document.createElement('summary');
  sum.textContent = callsSummary(turn);
  const body = document.createElement('div');
  body.className = 'calls-body';
  det.append(sum, body);

  const maybeLoad = () => {
    if (!det.open) return;
    if (turn.callsLoaded) {
      if (!body.childElementCount) renderCallsPanel(body, turn);
      return;
    }
    loadTurnCalls(turn, body, det);
  };

  det.addEventListener('toggle', () => {
    turn.callsOpen = det.open;
    if (det.open) maybeLoad();
  });

  if (turn.callsLoaded) {
    renderCallsPanel(body, turn);
  } else if (det.open) {
    maybeLoad();      // preserved open state after a re-render
  }
  return det;
}

function callStateKey(call, idx) {
  return String(call.id || `${call.name || 'tool'}-${idx}`);
}

function callSearchText(call) {
  const base = [];
  const output = [];
  const add = (bucket, value) => {
    if (value === undefined || value === null) return;
    const text = String(value);
    if (text.trim()) bucket.push(text);
  };
  add(base, call.name);
  add(base, call.summary);
  for (const info of call.info || []) add(base, info);
  if (call.arg_view) {
    add(base, call.arg_view.label);
    add(base, call.arg_view.text);
  }
  for (const q of call.questions || []) {
    add(base, q.header);
    add(base, q.question);
    for (const option of q.options || []) {
      add(base, option.label);
      add(base, option.description);
    }
    for (const selected of q.selected || []) add(output, selected);
    add(output, q.custom);
  }
  for (const todo of call.todos || []) {
    add(base, todo.content);
    add(base, todo.status);
  }
  for (const file of call.files || []) {
    if (typeof file === 'string') add(base, file);
    else if (file && typeof file === 'object') {
      add(base, file.path || file.file || file.name);
      add(base, file.description);
    }
  }
  add(base, call.url);
  for (const query of call.queries || []) add(base, query);
  add(base, call.skill);

  const res = call.result;
  if (res) {
    add(base, res.path);
    add(base, res.exit_code);
    if (res.exit_code !== undefined && res.exit_code !== null) {
      add(base, `exit ${res.exit_code}`);
    }
    if (res.line_range) {
      add(base, `${res.line_range.start}-${res.line_range.end}/${res.line_range.total || ''}`);
    }
    add(output, res.error);
    for (const part of res.parts || []) add(output, part.text);
    for (const image of res.images || []) {
      add(output, image.path || image.id || image.url || refLabel(image));
    }
  }
  if (call.job) {
    add(base, call.job.status);
    if (call.job.status) add(base, `job ${call.job.status}`);
    add(base, call.job.duration_ms);
    add(output, call.job.detail);
  }
  return {
    base: base.join('\n').toLowerCase(),
    output: output.join('\n').toLowerCase(),
  };
}

function renderCallsPanel(container, turn) {
  turn.callOpen = turn.callOpen || {};
  if (turn.callFilter === undefined) turn.callFilter = '';
  if (turn.filterOutput === undefined) turn.filterOutput = true;

  container.textContent = '';
  const toolbar = document.createElement('div');
  toolbar.className = 'calls-toolbar';

  const collapse = document.createElement('button');
  collapse.type = 'button';
  collapse.className = 'ghost tiny';
  collapse.textContent = t('Collapse all');

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'ghost tiny';
  expand.textContent = t('Show all');

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'calls-filter';
  filter.placeholder = t('Filter tools (name/path/command…)');
  filter.value = turn.callFilter;
  filter.setAttribute('aria-label', t('Filter tool calls by keyword'));

  const outputLabel = document.createElement('label');
  outputLabel.className = 'chk';
  outputLabel.title = t('When checked, search command output, diffs and error text too; when unchecked, only names/summaries/paths/arguments.');
  const outputToggle = document.createElement('input');
  outputToggle.type = 'checkbox';
  outputToggle.checked = turn.filterOutput !== false;
  outputLabel.append(outputToggle, document.createTextNode(' ' + t('Include output')));

  const count = document.createElement('span');
  count.className = 'hint calls-count';

  toolbar.append(collapse, expand, filter, outputLabel, count);

  const list = document.createElement('div');
  list.className = 'calls-list';
  const empty = document.createElement('div');
  empty.className = 'call-none calls-empty';
  empty.textContent = t('No matching tools');
  empty.hidden = true;

  const applyFilter = () => {
    const term = String(turn.callFilter || '').trim().toLowerCase();
    const includeOutput = turn.filterOutput !== false;
    const cards = [...list.querySelectorAll('details.call')];
    let visible = 0;
    for (const card of cards) {
      const hay = (card._searchBase || '')
        + (includeOutput ? '\n' + (card._searchOutput || '') : '');
      const show = !term || hay.includes(term);
      card.classList.toggle('hidden', !show);
      if (show) visible++;
    }
    count.textContent = t('Showing {visible} / {total}', { visible, total: cards.length });
    empty.hidden = visible !== 0 || cards.length === 0;
  };

  const setVisibleOpen = (open) => {
    for (const card of list.querySelectorAll('details.call')) {
      if (card.classList.contains('hidden')) continue;
      card.open = open;
      turn.callOpen[card.dataset.callKey] = open;
    }
  };

  filter.addEventListener('input', () => {
    turn.callFilter = filter.value;
    applyFilter();
  });
  outputToggle.addEventListener('change', () => {
    turn.filterOutput = outputToggle.checked;
    applyFilter();
  });
  collapse.addEventListener('click', () => setVisibleOpen(false));
  expand.addEventListener('click', () => setVisibleOpen(true));

  container.append(toolbar, list, empty);

  const calls = turn.calls || [];
  calls.forEach((call, i) => list.appendChild(renderCall(call, i + 1, turn)));
  applyFilter();
}

async function loadTurnCalls(turn, body, det) {
  if (turn.callsLoading) return;
  const qid = turn.q_id;
  const revision = turn.calls_revision;
  turn.callsLoading = true;
  body.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'call-none';
  loading.textContent = t('Loading tool calls…');
  body.appendChild(loading);
  try {
    const [sid, seq] = splitQid(qid);
    const data = await api(
      `/api/turn/${encodeURIComponent(sid)}/${encodeURIComponent(seq)}/calls`
    );
    const current = state.turn;
    if (!current || current.q_id !== qid || current.calls_revision !== revision) return;
    current.calls = data.calls || [];
    current.callsLoaded = true;
    current.call_count = data.call_count || current.calls.length;
    if (det) {
      const sum = det.querySelector('summary');
      if (sum) sum.textContent = callsSummary(current);
    }
    if (body.isConnected) {
      renderCallsPanel(body, current);
    } else if (state.turn === current) {
      // The answer was re-rendered while the call payload was loading.
      renderAnswer();
    }
  } catch (e) {
    if (body.isConnected) {
      body.textContent = '';
      const note = document.createElement('div');
      note.className = 'call-none';
      note.textContent = t('Failed to load tool calls: {message}', { message: e.message });
      body.appendChild(note);
    }
  } finally {
    turn.callsLoading = false;
  }
}

function renderCall(call, idx, turn) {
  const card = document.createElement('details');
  card.className = 'call';
  const key = callStateKey(call, idx);
  card.dataset.callKey = key;

  const head = document.createElement('summary');
  head.className = 'call-head';
  const toggle = document.createElement('span');
  toggle.className = 'call-toggle';
  toggle.textContent = '▸';
  const num = document.createElement('span');
  num.className = 'call-idx';
  num.textContent = idx;
  const name = document.createElement('span');
  name.className = 'call-name';
  name.textContent = call.name;
  head.append(toggle, num, name);
  let summary = call.summary;
  if (!summary) {
    if (Array.isArray(call.questions) && call.questions.length) {
      summary = t('{count} questions', { count: call.questions.length });
    } else if (Array.isArray(call.todos) && call.todos.length) {
      summary = t('{count} todos', { count: call.todos.length });
    } else if (Array.isArray(call.files) && call.files.length) {
      summary = t('{count} files', { count: call.files.length });
    } else if (call.name === 'subagent' || call.name === 'subagent_fork') {
      summary = t('Subagent');
    }
  }
  if (summary) {
    const s = document.createElement('span');
    s.className = 'call-sum';
    s.textContent = summary;
    s.title = summary;
    head.appendChild(s);
  }

  const res = call.result;
  const badges = document.createElement('div');
  badges.className = 'call-badges';
  if (res) {
    if (res.exit_code !== undefined && res.exit_code !== null) {
      badges.appendChild(badge(t('exit {code}', { code: res.exit_code }),
        Number(res.exit_code) === 0 ? 'ok' : 'bad'));
    }
    if (res.is_error || res.error) badges.appendChild(badge(t('Error'), 'bad'));
    if (res.truncated) badges.appendChild(badge(t('Output truncated'), 'warn'));
    if (res.line_range) {
      const lr = res.line_range;
      badges.appendChild(badge(
        lr.total
          ? t('Line {start}-{end} of {total}', { start: lr.start, end: lr.end, total: lr.total })
          : t('Line {start}-{end}', { start: lr.start, end: lr.end }),
        'src'
      ));
    }
  }
  if (call.job) {
    if (call.job.status) badges.appendChild(badge(
      t('job {status}', { status: t(String(call.job.status)) }),
      String(call.job.status).toLowerCase() === 'completed' ? 'ok' : 'warn'
    ));
    if (call.job.duration_ms !== undefined && call.job.duration_ms !== null) {
      badges.appendChild(badge(fmtDuration(call.job.duration_ms), 'src'));
    }
  }
  if (!res && turn && turn.open) badges.appendChild(badge(t('Running…'), 'open'));
  if (badges.children.length) head.appendChild(badges);

  const body = document.createElement('div');
  body.className = 'call-body';
  card.append(head, body);

  const search = callSearchText(call);
  card._searchBase = search.base;
  card._searchOutput = search.output;

  const buildBody = () => {
    if (body.dataset.built === '1') return;
    body.dataset.built = '1';

    if (Array.isArray(call.info) && call.info.length) {
      const info = document.createElement('div');
      info.className = 'call-info';
      for (const value of call.info) {
        if (!value) continue;
        const chip = document.createElement('span');
        chip.className = 'call-chip';
        chip.textContent = value;
        chip.title = value;
        info.appendChild(chip);
      }
      if (info.children.length) body.appendChild(info);
    }

    if (Array.isArray(call.questions) && call.questions.length) {
      const ask = renderAskQuestions(call.questions);
      if (ask) body.appendChild(ask);
    }
    if (Array.isArray(call.todos) && call.todos.length) {
      const todos = renderTodos(call.todos, t('Todos'));
      if (todos) body.appendChild(todos);
    }
    if (Array.isArray(call.files) && call.files.length) {
      const files = renderPresentFiles(call.files);
      if (files) body.appendChild(files);
    }

    if (call.arg_view && call.arg_view.text) {
      body.appendChild(codeBlock(
        call.arg_view.text,
        call.arg_view.lang,
        call.arg_view.label
      ));
    }

    if (!res) {
      const none = document.createElement('div');
      none.className = 'call-none';
      none.textContent = (turn && turn.open)
        ? t('This call has no result yet (it may still be running).')
        : t('No result matched this call: the turn was interrupted, or the result was not recorded.');
      body.appendChild(none);
      return;
    }

    if (res.error) body.appendChild(codeBlock(res.error, 'plaintext', t('Error')));
    (res.images || []).forEach((ref) => body.appendChild(imageFig(ref)));

    if (call.name === 'todo_write') {
      const parts = (res.parts || []).filter((p) => p.text && p.text.trim());
      if (parts.length) {
        const note = document.createElement('div');
        note.className = 'call-note';
        note.textContent = parts.map((p) => p.text).join('\n').slice(0, 600);
        body.appendChild(note);
      }
      return;
    }
    if (call.name === 'ask_user_question') {
      return;   // questions / selected answers already rendered above
    }

    const parts = res.parts || [];
    parts.forEach((part) => {
      if (!part.text || !part.text.trim()) return;
      const label = part.label
        || (part.kind === 'diff' ? t('Diff') : t('Output'));
      body.appendChild(codeBlock(part.text, part.lang, label));
    });

    if (!parts.length && !(res.images || []).length && !res.error) {
      const none = document.createElement('div');
      none.className = 'call-none';
      none.textContent = t('(No output)');
      body.appendChild(none);
    }
  };

  card.addEventListener('toggle', () => {
    turn.callOpen[key] = card.open;
    if (card.open) buildBody();
  });
  card.open = !!(turn.callOpen && turn.callOpen[key]);
  if (card.open) buildBody();
  return card;
}

/* ---------------- sessions ---------------- */
async function loadChats() {
  const data = await api('/api/chats');
  state.chats = data.chats || [];
  renderChats();
  renderMeta();
}

function renderMeta() {
  const n = state.chats.length;
  const q = state.chats.reduce((a, c) => a + (c.questions || 0), 0);
  const workspaces = new Set(state.chats.map((c) => (c.workspace || {}).id || (c.workspace || {}).path || c.cwd));
  let text = t('{sessions} sessions · {questions} questions · {workspaces} workspaces · home: {home}', {
    sessions: n,
    questions: q,
    workspaces: workspaces.size,
    home: window.__home || '',
  });
  $('#meta').textContent = text;
  $('#meta').title = text;
}

function chatMatches(chat, term) {
  if (!term) return true;
  const hay = [
    chat.title, chat.cwd, (chat.workspace || {}).title,
    (chat.workspace || {}).path, chat.model, chat.id,
  ].join('\n').toLowerCase();
  return hay.includes(term);
}

function renderChats() {
  const list = $('#chat-list');
  const term = state.chatFilter.trim().toLowerCase();
  list.textContent = '';
  const chats = state.chats.filter((c) =>
    (state.showArchived || !c.archived) && chatMatches(c, term));
  $('#chat-count').textContent = term
    ? t('{shown} / {total} sessions', { shown: chats.length, total: state.chats.length })
    : t('{count} sessions', { count: state.chats.length });

  if (!chats.length) {
    list.innerHTML = `<li class="empty-note">${esc(t('No matching sessions'))}</li>`;
    return;
  }

  const groups = new Map();
  for (const chat of chats) {
    const ws = chat.workspace || {};
    const key = ws.id || ws.path || chat.cwd || '';
    if (!groups.has(key)) groups.set(key, { ws, items: [] });
    groups.get(key).items.push(chat);
  }

  for (const { ws, items } of groups.values()) {
    const group = document.createElement('li');
    group.className = 'grp';
    group.textContent = ws.title || (ws.path ? basename(ws.path) : t('Unknown'));
    if (ws.path) {
      const path = document.createElement('span');
      path.className = 'grp-path';
      path.textContent = ws.path;
      path.title = ws.path;
      group.appendChild(path);
    }
    list.appendChild(group);

    for (const chat of items) {
      const li = document.createElement('li');
      li.dataset.sid = chat.id;
      if (chat.id === state.sid) li.classList.add('active');

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = chat.title || t('Untitled');
      const sub = document.createElement('div');
      sub.className = 'item-sub';
      const time = document.createElement('span');
      time.textContent = fmtTime(chat.last_activity_at || chat.created_at);
      const q = document.createElement('span');
      q.textContent = t('{count} questions', { count: chat.questions });
      sub.append(time, q);
      if (chat.message_count) {
        const m = document.createElement('span');
        m.textContent = t('{count} messages', { count: chat.message_count });
        sub.appendChild(m);
      }
      if (chat.open) {
        const dot = document.createElement('span');
        dot.className = 'open-dot';
        dot.title = t('Generating');
        sub.appendChild(dot);
      }
      if (chat.pinned) sub.appendChild(badge(t('Pinned'), 'pin'));
      if (chat.archived) sub.appendChild(badge(t('Archived'), 'arch'));
      if (chat.origin === 'subagent') sub.appendChild(badge(t('Subagent'), 'src'));
      if (chat.model) {
        const model = document.createElement('span');
        model.textContent = chat.model;
        sub.appendChild(model);
      }
      li.append(title, sub);
      li.title = [chat.title, chat.cwd, chat.model, chat.id, chat.parent, chat.error]
        .filter(Boolean).join('\n');
      li.onclick = () => openChat(chat.id);
      list.appendChild(li);
    }
  }
  highlightIn(list, state.chatFilter.trim());
}

function questionDisplayText(item) {
  if (item.q && String(item.q).trim()) return item.q;
  if (item.synthetic || item.synthetic_kind === 'auto') return t('Auto continue');
  const images = item.image_count || (item.q_images || []).length;
  if (images) return t('{count} images', { count: images });
  return t('No question content');
}

function questionDisplayPreview(item) {
  return item.preview || questionDisplayText(item);
}

/* ---------------- questions ---------------- */
async function openChat(sid, opts = {}) {
  closeDrawers();
  state.sid = sid;
  state.chat = state.chats.find((c) => c.id === sid) || { id: sid, title: sid };
  renderChats();
  $('#q-head').textContent = t('Reading the session log; the first open of a large session may take a few seconds…');
  $('#q-count').textContent = '';
  $('#question-list').innerHTML = `<li class="empty-note">${esc(t('Reading the session log; the first open of a large session may take a few seconds…'))}</li>`;
  const ok = await loadQuestions();
  if (!ok) {
    showAnswerError(t('Failed to read session'));
    return;
  }
  if (opts.qid) {
    const ids = state.turns.map((t) => t.q_id);
    if (ids.includes(opts.qid)) return openTurn(opts.qid);
    // The question was filtered out; clear the search so it shows up again.
    $('#q-search').value = '';
    state.term = '';
    await loadQuestions();
    if (state.turns.some((t) => t.q_id === opts.qid)) return openTurn(opts.qid);
  } else if (state.turns.length && state.follow) {
    openTurn(state.turns[state.turns.length - 1].q_id);
  } else if (!state.turns.length) {
    clearAnswer();
  }
}

function clearAnswer(message) {
  const box = $('#answer-body');
  state.turn = null;
  state.qid = null;
  $('#a-head').textContent = t('Answer');
  box.classList.add('empty');
  box.textContent = '';
  const p = document.createElement('p');
  p.textContent = message || t('This session has no questions.');
  box.appendChild(p);
}

function showAnswerError(message) {
  const box = $('#answer-body');
  state.turn = null;
  $('#a-head').textContent = t('Failed to read session');
  box.classList.remove('empty');
  box.textContent = '';
  const p = document.createElement('p');
  p.textContent = message + '. ' + t('Please retry, or use Refresh in the top bar.');
  box.appendChild(p);
}

let questionsRequest = 0;
async function loadQuestions() {
  if (!state.sid) { state.questionsLoading = false; return false; }
  const sid = state.sid;
  const requestId = ++questionsRequest;
  state.questionsLoading = true;
  const params = new URLSearchParams();
  if (state.term) { params.set('q', state.term); params.set('scope', state.scope); }
  const list = $('#question-list');
  const count = $('#q-count');
  const timer = setTimeout(() => {
    if (state.sid !== sid || requestId !== questionsRequest) return;
    $('#q-head').textContent = t('Reading the session log; the first open of a large session may take a few seconds…');
    count.textContent = '';
    list.innerHTML = `<li class="empty-note">${esc(t('Reading the session log; the first open of a large session may take a few seconds…'))}</li>`;
  }, 250);
  try {
    const data = await api(`/api/chats/${encodeURIComponent(sid)}/questions?${params}`);
    if (state.sid !== sid || requestId !== questionsRequest) return false;
    state.chat = data.chat || state.chat;
    state.turns = data.questions || [];
    state.total = data.total || 0;
    const title = (state.chat && state.chat.title) || t('Untitled');
    $('#q-head').textContent = t('Questions · {title}', { title });
    $('#q-head').title = title;
    renderQuestions();
    return true;
  } catch (e) {
    if (state.sid !== sid || requestId !== questionsRequest) return false;
    state.turns = [];
    state.total = 0;
    $('#q-head').textContent = t('Failed to read session');
    count.textContent = '';
    list.innerHTML = `<li class="empty-note">${esc(t('Failed to read session') + ': ' + e.message)}</li>`;
    return false;
  } finally {
    clearTimeout(timer);
    if (requestId === questionsRequest) state.questionsLoading = false;
  }
}

function renderQuestions() {
  const list = $('#question-list');
  list.textContent = '';
  state.searchResults = null;
  const n = state.turns.length;
  $('#q-count').textContent = state.term
    ? t('{shown} / {total} questions', { shown: n, total: state.total })
    : t('{count} questions total', { count: state.total });

  if (!n) {
    list.innerHTML = `<li class="empty-note">${esc(state.term
      ? t('No matching questions (try including answers)')
      : t('This session has no questions.'))}</li>`;
    return;
  }
  state.turns.forEach((item, i) => {
    const li = document.createElement('li');
    li.dataset.qid = item.q_id;
    if (item.q_id === state.qid) li.classList.add('active');
    const tools = (item.tool_summary || []).reduce((a, x) => a + x.count, 0);
    const imgs = (item.q_images || []).length;
    const title = document.createElement('div');
    title.className = 'item-title';
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `${i + 1}.`;
    title.append(idx, document.createTextNode(questionDisplayPreview(item)));
    const sub = document.createElement('div');
    sub.className = 'item-sub';
    for (const text of [
      fmtTime(item.ts),
      t('Answer {count} chars', { count: item.answer_chars || 0 }),
    ]) {
      if (!text) continue;
      const span = document.createElement('span');
      span.textContent = text;
      sub.appendChild(span);
    }
    if (imgs) sub.appendChild(badge(t('{count} images', { count: imgs }), 'src'));
    if (tools) sub.appendChild(badge(t('Tools: {count}', { count: tools }), 'src'));
    if (item.reasoning_chars) sub.appendChild(badge(t('Thinking: {count}', { count: fmtNum(item.reasoning_chars) }), 'src'));
    if (item.todos) sub.appendChild(badge(t('Todos: {count}', { count: item.todos }), 'src'));
    if (item.compactions) sub.appendChild(badge(t('Compacted: {count}', { count: item.compactions }), 'src'));
    if (item.steer) sub.appendChild(tag(t('Steer'), 'tag-steer'));
    if (item.synthetic) sub.appendChild(badge(t('Auto continue'), 'src'));
    if (item.open) sub.appendChild(badge(t('In progress'), 'open'));
    li.append(title, sub);
    li.title = questionDisplayText(item);
    li.onclick = () => openTurn(item.q_id);
    list.appendChild(li);
  });
  highlightIn(list, state.term);
}

/* ---------------- global search ---------------- */
let searchTimer = null;
let searchRequest = 0;
async function runGlobalSearch() {
  const term = state.term.trim();
  if (!term) { await loadQuestions(); return; }
  const requestId = ++searchRequest;
  const params = new URLSearchParams({ q: term, scope: state.scope, limit: '300' });
  const list = $('#question-list');
  const count = $('#q-count');
  const timer = setTimeout(() => {
    if (requestId !== searchRequest) return;
    $('#q-head').textContent = t('Searching all sessions…');
    count.textContent = '';
    list.innerHTML = `<li class="empty-note">${esc(t('The first search reads every session log. Please wait…'))}</li>`;
  }, 250);
  try {
    const data = await api(`/api/search?${params}`);
    if (requestId !== searchRequest || state.term.trim() !== term) return;
    state.searchResults = data.results || [];
    renderSearchResults(term);
  } catch (e) {
    if (requestId !== searchRequest) return;
    $('#q-head').textContent = t('Search failed');
    count.textContent = '';
    list.innerHTML = `<li class="empty-note">${esc(t('Search failed: {message}', { message: e.message }))}</li>`;
  } finally {
    clearTimeout(timer);
  }
}

function renderSearchResults(term) {
  const list = $('#question-list');
  list.textContent = '';
  $('#q-head').textContent = t('Search results (all sessions)');
  $('#q-count').textContent = t('{count} hits', { count: state.searchResults.length });
  if (!state.searchResults.length) {
    list.innerHTML = `<li class="empty-note">${esc(t('No hits'))}</li>`;
    return;
  }
  let lastSid = null;
  for (const r of state.searchResults) {
    if (r.session_id !== lastSid) {
      lastSid = r.session_id;
      const h = document.createElement('li');
      h.className = 'grp';
      h.textContent = r.title || t('Untitled');
      list.appendChild(h);
    }
    const li = document.createElement('li');
    li.dataset.qid = r.q_id;
    if (r.q_id === state.qid) li.classList.add('active');
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = r.q_preview
      || (r.image_count ? t('{count} images', { count: r.image_count }) : t('No question content'));
    const sub = document.createElement('div');
    sub.className = 'item-sub';
    for (const text of [t(r.where), fmtTime(r.ts)]) {
      if (!text) continue;
      const span = document.createElement('span');
      span.textContent = text;
      sub.appendChild(span);
    }
    if (r.steer) sub.appendChild(tag(t('Steer'), 'tag-steer'));
    li.append(title, sub);
    li.title = r.a_preview || '';
    li.onclick = () => openChat(r.session_id, { qid: r.q_id });
    list.appendChild(li);
  }
  highlightIn(list, term);
}

/* ---------------- answer ---------------- */
let turnRequest = 0;

function splitQid(qid) {
  const text = String(qid);
  const at = text.lastIndexOf(':');
  if (at > 0) return [text.slice(0, at), text.slice(at + 1)];
  return [state.sid, text];
}

function adoptTurn(data) {
  const prev = state.turn;
  if (prev && prev.q_id === data.q_id) {
    const sameRevision = prev.calls_revision === data.calls_revision;
    data.callsOpen = !!prev.callsOpen;
    data.callsLoaded = !!prev.callsLoaded && sameRevision;
    data.calls = data.callsLoaded ? (prev.calls || []) : [];
    data.callsLoading = false;
    data.callOpen = prev.callOpen || {};
    data.callFilter = prev.callFilter || '';
    data.filterOutput = prev.filterOutput !== false;
  } else {
    data.callsOpen = false;
    data.callsLoaded = false;
    data.calls = [];
    data.callOpen = {};
    data.callFilter = '';
    data.filterOutput = true;
  }
  state.turn = data;
}

async function openTurn(qid) {
  if (isDrawerMode('questions')) closeDrawers();
  const requestId = ++turnRequest;
  state.qid = qid;
  const [sid, seq] = splitQid(qid);
  const data = await api(`/api/turn/${encodeURIComponent(sid)}/${encodeURIComponent(seq)}`);
  if (requestId !== turnRequest) return;
  adoptTurn(data);
  state.raw = false;
  $('#btn-raw').classList.remove('on');
  renderAnswer();
  for (const li of document.querySelectorAll('#question-list li')) {
    li.classList.toggle('active', li.dataset.qid === qid);
  }
}

function renderAnswer() {
  const turn = state.turn;
  const box = $('#answer-body');
  if (!turn) return;
  box.classList.remove('empty');
  const title = (turn.chat && turn.chat.title) || '';
  $('#a-head').textContent = title ? `${t('Answer')} · ${title}` : t('Answer');

  const tools = turn.tool_summary || [];
  const toolLine = tools.length
    ? tools.map((x) => `${x.name}×${x.count}`).join(t('listSeparator'))
    : t('None');
  const images = (turn.answer || '').match(/MEDIA:\s*[^\s`"'<>]+/g) || [];
  const tokens = turn.tokens || {};
  const tokenTotal = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
    .reduce((a, key) => a + (Number(tokens[key]) || 0), 0);

  const qBlock = document.createElement('div');
  qBlock.className = 'q-block';
  const qlabel = document.createElement('div');
  qlabel.className = 'qlabel';
  qlabel.textContent = t('Question #{seq}', { seq: turn.seq });
  if (turn.steer) qlabel.appendChild(tag(' ' + t('Mid-turn steer'), 'tag-steer'));
  if (turn.synthetic) qlabel.appendChild(badge(' ' + t('Auto continue'), 'src'));
  const qtext = document.createElement('div');
  qtext.className = 'qtext';
  qtext.textContent = questionDisplayText(turn);
  const qmeta = document.createElement('div');
  qmeta.className = 'qmeta';
  for (const text of [
    fmtTime(turn.ts),
    t('Answer {count} chars', { count: (turn.answer || '').length }),
    images.length ? t('{count} images', { count: images.length }) : '',
    t('Tools: {list}', { list: toolLine }),
    turn.model ? t('Model {model}', { model: turn.model }) : '',
    tokenTotal ? t('tokens {count}', { count: fmtNum(tokenTotal) }) : '',
  ]) {
    if (!text) continue;
    const span = document.createElement('span');
    span.textContent = text;
    qmeta.appendChild(span);
  }
  if (turn.open) qmeta.appendChild(badge(t('Generating'), 'open'));
  if (turn.end_reason && turn.end_reason.kind && turn.end_reason.kind !== 'completed') {
    qmeta.appendChild(badge(t('Ended: {reason}', { reason: t(turn.end_reason.kind) }), 'warn'));
  }
  qBlock.append(qlabel, qtext, qmeta);

  const qImgs = document.createElement('div');
  qImgs.className = 'q-images';
  for (const ref of turn.q_images || []) qImgs.appendChild(imageFig(ref));
  if (qImgs.children.length) qBlock.appendChild(qImgs);

  box.textContent = '';
  box.appendChild(qBlock);

  const notices = renderNotices(turn.notices);
  if (notices) box.appendChild(notices);

  // Thinking ------------------------------------------------------------
  const reasoning = turn.reasoning || [];
  if (reasoning.length) {
    const det = document.createElement('details');
    det.className = 'reasoning';
    const sum = document.createElement('summary');
    const chars = reasoning.reduce((a, r) => a + (r.text || '').length, 0);
    sum.textContent = t('Thinking ({segments} segments · {chars} chars)', {
      segments: reasoning.length, chars: fmtNum(chars),
    });
    det.appendChild(sum);
    reasoning.forEach((r, i) => {
      const step = document.createElement('div');
      step.className = 'reason-step';
      const head = document.createElement('div');
      head.className = 'reason-step-head';
      head.textContent = r.step ? t('Step {step}', { step: r.step }) : t('Segment {n}', { n: i + 1 });
      const pre = document.createElement('pre');
      pre.className = 'reason-text';
      pre.textContent = r.text || '';
      step.append(head, pre);
      det.appendChild(step);
    });
    box.appendChild(det);
  }

  // Compaction summaries ------------------------------------------------
  for (const comp of turn.compactions || []) {
    const det = document.createElement('details');
    det.className = 'compaction';
    const sum = document.createElement('summary');
    sum.textContent = t('Context compaction summary ({time})', { time: fmtTime(comp.ts) });
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'md';
    body.innerHTML = mdToHtml(comp.text || '');
    det.appendChild(body);
    patchImages(body);
    highlightCode(body);
    box.appendChild(det);
  }

  // Latest todo list ----------------------------------------------------
  const todos = renderTodos(turn.todos, t('Turn todos'));
  if (todos) box.appendChild(todos);

  // Answer --------------------------------------------------------------
  const label = document.createElement('div');
  label.className = 'a-label';
  label.textContent = (turn.answer || '').trim()
    ? t('Answer')
    : (turn.open
      ? t('The answer is still being generated (or this turn only contains tool calls).')
      : t('This turn has no text output.'));
  const body = document.createElement('div');
  if (state.raw) {
    body.innerHTML = `<pre class="md-raw">${esc(turn.answer || '')}</pre>`;
  } else {
    body.className = 'md';
    body.innerHTML = mdToHtml(turn.answer || '');
  }
  box.append(label, body);
  if (!state.raw) {
    patchImages(body);
    highlightCode(body);
  }

  const answerImgs = document.createElement('div');
  answerImgs.className = 'q-images';
  for (const ref of turn.answer_images || []) answerImgs.appendChild(imageFig(ref));
  if (answerImgs.children.length) box.appendChild(answerImgs);

  const calls = renderCalls(turn);
  if (calls) box.appendChild(calls);

  highlightIn(box, state.term);
  box.scrollTop = 0;
}

/* ---------------- follow (live) ---------------- */
function callsFingerprint(turn) {
  return `${(turn && turn.call_count) || 0}|${(turn && turn.calls_revision) || ''}`;
}

async function tick() {
  if (!state.follow) return;
  if (state.searchAll && state.term.trim()) return;   // don't fight the global search view
  try {
    await loadChats();
    if (!state.sid || state.questionsLoading) return;
    const prevIds = state.turns.map((t) => t.q_id);
    const wasLastSelected = prevIds.length && prevIds[prevIds.length - 1] === state.qid;
    await loadQuestions();
    const ids = state.turns.map((t) => t.q_id);
    const grew = ids.length !== prevIds.length || ids.some((v, i) => v !== prevIds[i]);
    if (state.searchResults) return;          // don't fight the search view
    if (!grew) {
      // same list - refresh the open answer if it is the newest one and still growing
      if (state.qid && ids[ids.length - 1] === state.qid) {
        const [sid, seq] = splitQid(state.qid);
        const data = await api(`/api/turn/${encodeURIComponent(sid)}/${encodeURIComponent(seq)}`);
        const before = (state.turn && state.turn.answer) || '';
        const changed = (data.answer || '') !== before ||
          callsFingerprint(data) !== callsFingerprint(state.turn) ||
          (data.reasoning || []).length !== ((state.turn || {}).reasoning || []).length;
        if (changed) {
          const box = $('#answer-body');
          const keep = box.scrollTop > 4 ? box.scrollTop : 0;
          adoptTurn(data);
          renderAnswer();
          box.scrollTop = keep;
        }
      }
      return;
    }
    if (wasLastSelected && ids.length) openTurn(ids[ids.length - 1]);  // follow the newest question
  } catch (e) { /* keep the UI alive */ }
}

/* ---------------- collapsible panes (VSCode style) ---------------- */
const PANES = {
  chats: { el: '#pane-chats', bodyClass: 'hide-chats', key: 'dshv.collapsed.chats' },
  questions: { el: '#pane-questions', bodyClass: 'hide-questions', key: 'dshv.collapsed.questions' },
};

function isCollapsed(name) {
  const cfg = PANES[name];
  return !!cfg && document.querySelector(cfg.el).classList.contains('collapsed');
}

function setCollapsed(name, collapsed, persist = true) {
  const cfg = PANES[name];
  if (!cfg) return;
  const pane = document.querySelector(cfg.el);
  if (!pane) return;
  pane.classList.toggle('collapsed', collapsed);
  document.body.classList.toggle(cfg.bodyClass, collapsed);
  if (persist) {
    try { localStorage.setItem(cfg.key, collapsed ? '1' : '0'); } catch (e) { /* private mode */ }
  }
}

function togglePane(name) { setCollapsed(name, !isCollapsed(name)); }

/* Ctrl+B cycles: all shown -> sessions hidden -> all hidden -> all shown */
function cyclePanes() {
  const chatsHidden = isCollapsed('chats');
  const questionsHidden = isCollapsed('questions');
  if (!chatsHidden && !questionsHidden) {
    setCollapsed('chats', true);
  } else if (chatsHidden && !questionsHidden) {
    setCollapsed('questions', true);
  } else {
    setCollapsed('chats', false);
    setCollapsed('questions', false);
  }
}

function restorePanes() {
  for (const name of Object.keys(PANES)) {
    let saved = null;
    try { saved = localStorage.getItem(PANES[name].key); } catch (e) { /* private mode */ }
    if (saved === '1') setCollapsed(name, true, false);
  }
}

/* ---------------- resizable panes ---------------- */
const PANE_LAYOUT = {
  chats: {
    min: 180, max: 600, fallback: 280,
    cssVar: '--w-chats', storageKey: 'dshv.width.chats',
    pane: '#pane-chats', resizer: '#resizer-chats',
  },
  questions: {
    min: 220, max: 800, fallback: 360,
    cssVar: '--w-questions', storageKey: 'dshv.width.questions',
    pane: '#pane-questions', resizer: '#resizer-questions',
  },
};
const ANSWER_MIN_WIDTH = 360;
const RESIZER_WIDTH = 12;
let paneDrag = null;

function isDrawerMode(name) {
  return name === 'chats' ? window.innerWidth <= 1100 : window.innerWidth <= 760;
}

function paneWidth(name) {
  const cfg = PANE_LAYOUT[name];
  const pane = document.querySelector(cfg.pane);
  if (pane) {
    const width = pane.getBoundingClientRect().width;
    if (width > 0) return width;
  }
  return cfg.fallback;
}

function readPaneWidth(name) {
  try {
    const value = Number(localStorage.getItem(PANE_LAYOUT[name].storageKey));
    if (isFinite(value) && value > 0) return value;
  } catch (e) { /* private mode */ }
  return null;
}

function maxPaneWidth(name) {
  const cfg = PANE_LAYOUT[name];
  const other = name === 'chats' ? 'questions' : 'chats';
  const otherWidth = isDrawerMode(other) ? 0 : (isCollapsed(other) ? 40 : paneWidth(other));
  const available = window.innerWidth - otherWidth - RESIZER_WIDTH - ANSWER_MIN_WIDTH;
  return Math.max(cfg.min, Math.min(cfg.max, available));
}

function clampPaneWidth(name, width) {
  const cfg = PANE_LAYOUT[name];
  return Math.round(Math.max(cfg.min, Math.min(maxPaneWidth(name), width)));
}

function applyPaneWidth(name, width, persist) {
  const cfg = PANE_LAYOUT[name];
  const value = clampPaneWidth(name, width);
  document.documentElement.style.setProperty(cfg.cssVar, `${value}px`);
  const resizer = document.querySelector(cfg.resizer);
  if (resizer) {
    resizer.setAttribute('aria-valuenow', String(Math.round(value)));
    resizer.setAttribute('aria-valuemin', String(cfg.min));
    resizer.setAttribute('aria-valuemax', String(Math.round(maxPaneWidth(name))));
  }
  if (persist) {
    try { localStorage.setItem(cfg.storageKey, String(value)); } catch (e) { /* private mode */ }
  }
  return value;
}

function resetPaneWidth(name) {
  applyPaneWidth(name, PANE_LAYOUT[name].fallback, true);
}

function loadPaneWidths() {
  for (const name of Object.keys(PANE_LAYOUT)) {
    const saved = readPaneWidth(name);
    applyPaneWidth(name, saved || PANE_LAYOUT[name].fallback, false);
  }
}

function clampPaneWidths() {
  for (const name of Object.keys(PANE_LAYOUT)) {
    if (isDrawerMode(name)) continue;
    const saved = readPaneWidth(name);
    applyPaneWidth(name, saved || paneWidth(name), false);
  }
}

function initResizers() {
  for (const name of Object.keys(PANE_LAYOUT)) {
    const cfg = PANE_LAYOUT[name];
    const resizer = document.querySelector(cfg.resizer);
    if (!resizer) continue;

    resizer.addEventListener('pointerdown', (event) => {
      if (isDrawerMode(name) || isCollapsed(name)) return;
      paneDrag = { name, startX: event.clientX, startWidth: paneWidth(name) };
      document.body.classList.add('resizing');
      resizer.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    resizer.addEventListener('pointermove', (event) => {
      if (!paneDrag || paneDrag.name !== name) return;
      const delta = event.clientX - paneDrag.startX;
      applyPaneWidth(name, paneDrag.startWidth + delta, false);
    });

    const finishDrag = (event) => {
      if (!paneDrag || paneDrag.name !== name) return;
      const value = applyPaneWidth(name, paneWidth(name), false);
      try { localStorage.setItem(cfg.storageKey, String(value)); } catch (e) { /* private mode */ }
      paneDrag = null;
      document.body.classList.remove('resizing');
      resizer.releasePointerCapture?.(event.pointerId);
    };
    resizer.addEventListener('pointerup', finishDrag);
    resizer.addEventListener('pointercancel', finishDrag);

    resizer.addEventListener('dblclick', () => resetPaneWidth(name));
    resizer.addEventListener('keydown', (event) => {
      if (isDrawerMode(name) || isCollapsed(name)) return;
      const step = event.shiftKey ? 32 : 16;
      let width = paneWidth(name);
      if (event.key === 'ArrowLeft') width -= step;
      else if (event.key === 'ArrowRight') width += step;
      else if (event.key === 'Home') width = cfg.min;
      else if (event.key === 'End') width = cfg.max;
      else return;
      event.preventDefault();
      applyPaneWidth(name, width, true);
    });
  }
}

/* ---------------- mobile drawers ---------------- */
function drawerOpen(name) {
  return document.body.classList.contains(`drawer-${name}`);
}

function openDrawer(name) {
  if (!isDrawerMode(name)) return;
  closeDrawers();
  document.body.classList.add('drawer-open', `drawer-${name}`);
  const pane = document.querySelector(PANE_LAYOUT[name].pane);
  if (pane) pane.classList.add('drawer-force');
  const button = document.querySelector(`.topbar-drawer[data-drawer="${name}"]`);
  if (button) button.setAttribute('aria-expanded', 'true');
  const backdrop = $('#drawer-backdrop');
  if (backdrop) backdrop.hidden = false;
}

function closeDrawers() {
  for (const name of Object.keys(PANE_LAYOUT)) {
    document.body.classList.remove(`drawer-${name}`);
    const pane = document.querySelector(PANE_LAYOUT[name].pane);
    if (pane) pane.classList.remove('drawer-force');
    const button = document.querySelector(`.topbar-drawer[data-drawer="${name}"]`);
    if (button) button.setAttribute('aria-expanded', 'false');
  }
  document.body.classList.remove('drawer-open');
  const backdrop = $('#drawer-backdrop');
  if (backdrop) backdrop.hidden = true;
}

function syncResponsiveLayout() {
  for (const name of Object.keys(PANE_LAYOUT)) {
    if (!isDrawerMode(name) && drawerOpen(name)) closeDrawers();
  }
  clampPaneWidths();
}

function initDrawers() {
  document.querySelectorAll('.topbar-drawer').forEach((button) => {
    button.addEventListener('click', () => {
      const name = button.dataset.drawer;
      if (drawerOpen(name)) closeDrawers();
      else openDrawer(name);
    });
  });
  document.querySelectorAll('[data-drawer-close]').forEach((button) => {
    button.addEventListener('click', closeDrawers);
  });
  const backdrop = $('#drawer-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeDrawers);
}

/* ---------------- clipboard / flash ---------------- */
async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 900);
}

/* ---------------- wiring ---------------- */
$('#chat-filter').addEventListener('input', (e) => {
  state.chatFilter = e.target.value;
  renderChats();
});

$('#show-archived').addEventListener('change', (e) => {
  state.showArchived = e.target.checked;
  renderChats();
});

$('#q-search').addEventListener('input', (e) => {
  state.term = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (state.searchAll) runGlobalSearch();
    else if (state.sid) loadQuestions();
  }, 200);
});

$('#q-scope').addEventListener('change', (e) => {
  state.scope = e.target.value;
  if (state.term) { if (state.searchAll) runGlobalSearch(); else if (state.sid) loadQuestions(); }
});

$('#search-all-chats').addEventListener('change', (e) => {
  state.searchAll = e.target.checked;
  if (state.term) { if (state.searchAll) runGlobalSearch(); else if (state.sid) loadQuestions(); }
  else if (state.sid) loadQuestions();
});

$('#follow').addEventListener('change', (e) => { state.follow = e.target.checked; });

$('#lang-select').addEventListener('change', (e) => switchLanguage(e.target.value));

$('#btn-refresh').addEventListener('click', async () => {
  await loadChats();
  if (state.searchAll && state.term.trim()) await runGlobalSearch();
  else if (state.sid) await loadQuestions();
  if (state.qid) await openTurn(state.qid);
});

$('#btn-raw').addEventListener('click', (e) => {
  if (!state.turn) return;
  state.raw = !state.raw;
  e.target.classList.toggle('on', state.raw);
  renderAnswer();
});

$('#btn-copy-q').addEventListener('click', async () => {
  if (!state.turn) return;
  try { await copyText(state.turn.q || ''); flash($('#btn-copy-q'), t('Copied')); }
  catch (e) { flash($('#btn-copy-q'), t('Copy failed')); }
});

$('#btn-copy-a').addEventListener('click', async () => {
  if (!state.turn) return;
  try { await copyText(state.turn.answer || ''); flash($('#btn-copy-a'), t('Copied')); }
  catch (e) { flash($('#btn-copy-a'), t('Copy failed')); }
});

/* Copy question and answer together. */
$('#btn-copy-qa').addEventListener('click', async () => {
  if (!state.turn) return;
  const q = (state.turn.q || '').trim();
  const a = (state.turn.answer || '').trim();
  try {
    await copyText(t('Question:\n{q}\n\nAnswer:\n{a}', { q, a }));
    flash($('#btn-copy-qa'), t('Copied'));
  } catch (e) {
    flash($('#btn-copy-qa'), t('Copy failed'));
  }
});

/* Jump to the answer body, skipping a long question and thinking. */
$('#btn-jump-a').addEventListener('click', () => {
  const label = document.querySelector('#answer-body .a-label');
  if (!label) return;
  label.scrollIntoView({ behavior: 'smooth', block: 'start' });
  label.classList.remove('flash');
  void label.offsetWidth;      // restart the animation
  label.classList.add('flash');
  setTimeout(() => label.classList.remove('flash'), 1400);
});

/* Collapse/expand the two side panes: the header « and the rail » share one toggle. */
document.querySelectorAll('.rail, .collapse').forEach((el) => {
  el.addEventListener('click', () => togglePane(el.dataset.pane));
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');

  // Ctrl+B cycles both panes; Ctrl+Shift+B toggles only the questions pane.
  if (e.ctrlKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault();
    if (e.shiftKey) togglePane('questions');
    else cyclePanes();
    return;
  }
  if (e.key === '/' && !typing) {
    e.preventDefault();
    if (isCollapsed('questions')) setCollapsed('questions', false);
    $('#q-search').focus();
    return;
  }
  if (e.key === 'Escape' && typing) { document.activeElement.blur(); return; }
  if (typing || !state.turns.length) return;
  if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'ArrowUp' || e.key === 'k') {
    const ids = state.turns.map((t) => t.q_id);
    let i = ids.indexOf(state.qid);
    i = (e.key === 'ArrowDown' || e.key === 'j') ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
    e.preventDefault();
    if (ids[i] !== state.qid) {
      const li = document.querySelector(`#question-list li[data-qid="${CSS.escape(ids[i])}"]`);
      if (li) li.scrollIntoView({ block: 'nearest' });
      openTurn(ids[i]);
    }
  }
});

/* ---------------- boot ---------------- */
function updateEmptyHint() {
  const hint = $('#empty-hint');
  if (hint) {
    hint.textContent = t('Data comes from {path}; read-only, never writes to or locks the DSH logs.',
      { path: '~/.dsh/sessions' });
  }
}

function switchLanguage(lang) {
  setLanguagePreference(lang);
  state.lang = getLanguage();
  applyI18n();
  updateEmptyHint();
  renderMeta();
  renderChats();
  if (state.searchAll && state.term.trim()) {
    runGlobalSearch();
  } else if (state.sid) {
    const title = (state.chat && state.chat.title) || t('Untitled');
    $('#q-head').textContent = t('Questions · {title}', { title });
    if (state.term) loadQuestions();
    else renderQuestions();
  } else if (state.chats.length) {
    $('#q-head').textContent = t('Select a session');
    $('#q-count').textContent = t('{count} sessions', { count: state.chats.length });
    $('#question-list').innerHTML = `<li class="empty-note">${esc(t('Choose a session on the left; its full log is read only when opened.'))}</li>`;
  }
  if (state.turn) renderAnswer();
}

(async function boot() {
  try {
    applyI18n();
    updateEmptyHint();
    restorePanes();
    initResizers();
    initDrawers();
    loadPaneWidths();
    syncResponsiveLayout();
    window.addEventListener('resize', syncResponsiveLayout);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDrawers();
    });
    const meta = await api('/api/meta');
    window.__home = meta.home;
    await loadChats();
    if (state.chats.length) {
      $('#q-head').textContent = t('Select a session');
      $('#q-count').textContent = t('{count} sessions', { count: state.chats.length });
      $('#question-list').innerHTML = `<li class="empty-note">${esc(t('Choose a session on the left; its full log is read only when opened.'))}</li>`;
    }
    setInterval(tick, 3000);
  } catch (e) {
    $('#meta').textContent = t('Load failed: {message}', { message: e.message });
  }
})();
