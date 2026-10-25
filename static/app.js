/* DSH Chat Viewer - front end (vanilla JS, no build step) */
'use strict';

const $ = (sel) => document.querySelector(sel);

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
  const p = (v) => String(v).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sameDay ? hm : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

function fmtDuration(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} 秒`;
  return `${Math.floor(n / 60_000)} 分 ${Math.round((n % 60_000) / 1000)} 秒`;
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
  if (ref.kind === 'attachment') return `附件 ${ref.id}`;
  if (ref.kind === 'url') return basename(ref.url) || ref.url;
  if (ref.kind === 'data') return '内联图片';
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
    note.textContent = '图片引用无法解析：' + (refLabel(ref) || '（未知）');
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
    note.textContent = '图像文件已不存在：' + (refLabel(ref) || '（未知）');
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
  lb.textContent = label || lang || '';
  head.appendChild(lb);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-' + (lang || 'plaintext');
  code.textContent = text == null ? '' : String(text);
  pre.appendChild(code);
  wrap.append(head, pre);

  const copy = document.createElement('button');
  copy.className = 'ghost tiny';
  copy.textContent = '复制';
  copy.onclick = async () => {
    try { await copyText(code.textContent); flash(copy, '已复制'); }
    catch (e) { flash(copy, '复制失败'); }
  };
  head.appendChild(copy);

  const lines = code.textContent.split('\n').length;
  if (lines > (opts.lineLimit || 22)) {
    pre.classList.add('clamped');
    const more = document.createElement('button');
    more.className = 'ghost tiny';
    more.textContent = `展开全部（${lines} 行）`;
    more.onclick = () => {
      const opened = pre.classList.toggle('clamped') === false;
      more.textContent = opened ? '收起' : `展开全部（${lines} 行）`;
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
      if (p.closest && p.closest('.katex')) return NodeFilter.FILTER_REJECT;  // 别把公式拆坏
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
  // 至少要有一个字母、反斜杠命令或数学符号；纯数字/货币不当公式
  return /[A-Za-z\\^_{}=+\-*\/()\[\]]/.test(tex);
}

/* 在 markdown 解析之前把公式换成占位符：
   否则 marked 会吃掉公式里的 _ * 等字符，多行 $$...$$ 也会被拆段。 */
function protectMath(md) {
  const slots = [];
  const take = (tex, display) => {
    slots.push({ tex, display });
    return MATH_SLOT(slots.length - 1);
  };
  const parts = String(md || '').split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  const text = parts.map((seg, idx) => {
    if (idx % 2 === 1) return seg;                    // 代码块里的 $ 原样保留
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
    // 独占一段的展示公式：去掉 <p> 包裹，避免块级元素套在段落里
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
  head.textContent = `${title || '待办'}（${done}/${todos.length}）`;
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

function renderNotices(notices) {
  if (!Array.isArray(notices) || !notices.length) return null;
  const box = document.createElement('div');
  box.className = 'notices';
  for (const notice of notices) {
    const line = document.createElement('div');
    line.className = 'notice';
    const kind = document.createElement('span');
    kind.className = 'notice-kind';
    kind.textContent = String(notice.kind || '');
    const text = document.createElement('span');
    text.textContent = notice.text || '';
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
      custom.textContent = '自定义回答：' + q.custom;
      card.appendChild(custom);
    }
    if (!selected.length && !q.custom) {
      const none = document.createElement('div');
      none.className = 'qask-none';
      none.textContent = '（没有回答记录）';
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
    .map((x) => `${x.name}×${x.count}`).join('、');
  return `工具调用（${total} 次${names ? '：' + names : ''}）`
    + (turn.callsLoaded ? '' : ' · 展开后加载');
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
      if (!body.childElementCount) renderCallList(body, turn);
      return;
    }
    loadTurnCalls(turn, body, det);
  };

  det.addEventListener('toggle', () => {
    turn.callsOpen = det.open;
    if (det.open) maybeLoad();
  });

  if (turn.callsLoaded) {
    renderCallList(body, turn);
  } else if (det.open) {
    maybeLoad();      // preserved open state after a re-render
  }
  return det;
}

function renderCallList(container, turn) {
  container.textContent = '';
  const calls = turn.calls || [];
  calls.forEach((call, i) => container.appendChild(renderCall(call, i + 1, turn)));
  if (!calls.length) {
    const none = document.createElement('div');
    none.className = 'call-none';
    none.textContent = '（没有工具调用）';
    container.appendChild(none);
  }
}

async function loadTurnCalls(turn, body, det) {
  if (turn.callsLoading) return;
  const qid = turn.q_id;
  const revision = turn.calls_revision;
  turn.callsLoading = true;
  body.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'call-none';
  loading.textContent = '正在加载工具调用…';
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
    if (body.isConnected) renderCallList(body, current);
  } catch (e) {
    if (body.isConnected) {
      body.textContent = '';
      const note = document.createElement('div');
      note.className = 'call-none';
      note.textContent = '加载工具调用失败：' + e.message;
      body.appendChild(note);
    }
  } finally {
    turn.callsLoading = false;
  }
}

function renderCall(call, idx, turn) {
  const card = document.createElement('div');
  card.className = 'call';

  const head = document.createElement('div');
  head.className = 'call-head';
  const num = document.createElement('span');
  num.className = 'call-idx';
  num.textContent = idx;
  const name = document.createElement('span');
  name.className = 'call-name';
  name.textContent = call.name;
  head.append(num, name);
  if (call.summary) {
    const s = document.createElement('span');
    s.className = 'call-sum';
    s.textContent = call.summary;
    s.title = call.summary;
    head.appendChild(s);
  }
  card.appendChild(head);

  const res = call.result;
  const badges = document.createElement('div');
  badges.className = 'call-badges';
  if (res) {
    if (res.exit_code !== undefined && res.exit_code !== null) {
      badges.appendChild(badge('exit ' + res.exit_code, Number(res.exit_code) === 0 ? 'ok' : 'bad'));
    }
    if (res.is_error || res.error) badges.appendChild(badge('错误', 'bad'));
    if (res.truncated) badges.appendChild(badge('输出过长已截断', 'warn'));
    if (res.line_range) {
      const lr = res.line_range;
      badges.appendChild(badge(
        lr.total ? `第 ${lr.start}–${lr.end} 行 / 共 ${lr.total} 行` : `第 ${lr.start}–${lr.end} 行`,
        'src'
      ));
    }
  }
  if (call.job) {
    if (call.job.status) badges.appendChild(badge('job ' + call.job.status,
      String(call.job.status).toLowerCase() === 'completed' ? 'ok' : 'warn'));
    if (call.job.duration_ms !== undefined && call.job.duration_ms !== null) {
      badges.appendChild(badge(fmtDuration(call.job.duration_ms), 'src'));
    }
  }
  if (!res && turn && turn.open) badges.appendChild(badge('运行中…', 'open'));
  if (badges.children.length) card.appendChild(badges);

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
    if (info.children.length) card.appendChild(info);
  }

  // Structured tool-specific views -------------------------------------
  if (Array.isArray(call.questions) && call.questions.length) {
    const ask = renderAskQuestions(call.questions);
    if (ask) card.appendChild(ask);
  }
  if (Array.isArray(call.todos) && call.todos.length) {
    const todos = renderTodos(call.todos, '待办');
    if (todos) card.appendChild(todos);
  }
  if (Array.isArray(call.files) && call.files.length) {
    const files = renderPresentFiles(call.files);
    if (files) card.appendChild(files);
  }

  // Arguments: command / code / diff / JSON ----------------------------
  if (call.arg_view && call.arg_view.text) {
    card.appendChild(codeBlock(
      call.arg_view.text,
      call.arg_view.lang,
      call.arg_view.label
    ));
  }

  if (!res) {
    const none = document.createElement('div');
    none.className = 'call-none';
    none.textContent = (turn && turn.open)
      ? '这个调用还没有结果（可能仍在运行）。'
      : '没有配到工具结果：这一轮被中断，或结果未入库。';
    card.appendChild(none);
    return card;
  }

  if (res.error) card.appendChild(codeBlock(res.error, 'plaintext', '错误信息'));
  (res.images || []).forEach((ref) => card.appendChild(imageFig(ref)));

  if (call.name === 'todo_write') {
    // The result is just "Updated todo list..." — keep it as a small note.
    const parts = (res.parts || []).filter((p) => p.text && p.text.trim());
    if (parts.length) {
      const note = document.createElement('div');
      note.className = 'call-note';
      note.textContent = parts.map((p) => p.text).join('\n').slice(0, 600);
      card.appendChild(note);
    }
    return card;
  }
  if (call.name === 'ask_user_question') {
    return card;   // questions / selected answers already rendered above
  }

  const parts = res.parts || [];
  parts.forEach((part) => {
    if (!part.text || !part.text.trim()) return;
    const label = part.label && !/^(output|content|result|结果|输出)$/.test(part.label)
      ? part.label
      : (part.kind === 'diff' ? 'diff' : '输出');
    card.appendChild(codeBlock(part.text, part.lang, label));
  });

  if (!parts.length && !(res.images || []).length && !res.error) {
    const none = document.createElement('div');
    none.className = 'call-none';
    none.textContent = '（没有输出）';
    card.appendChild(none);
  }
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
  let text = `${n} 个会话 · ${q} 条提问 · ${workspaces.size} 个工作区`;
  if (window.__home) text += ` · ${window.__home}`;
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
    ? `命中 ${chats.length} / 共 ${state.chats.length} 个会话`
    : `共 ${state.chats.length} 个会话`;

  if (!chats.length) {
    list.innerHTML = '<li class="empty-note">没有匹配的会话</li>';
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
    group.textContent = ws.title || (ws.path ? basename(ws.path) : '(未知工作区)');
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
      title.textContent = chat.title || chat.id;
      const sub = document.createElement('div');
      sub.className = 'item-sub';
      const time = document.createElement('span');
      time.textContent = fmtTime(chat.last_activity_at || chat.created_at);
      const q = document.createElement('span');
      q.textContent = `${chat.questions} 提问`;
      sub.append(time, q);
      if (chat.message_count) {
        const m = document.createElement('span');
        m.textContent = `${chat.message_count} 消息`;
        sub.appendChild(m);
      }
      if (chat.open) {
        const dot = document.createElement('span');
        dot.className = 'open-dot';
        dot.title = '正在生成';
        sub.appendChild(dot);
      }
      if (chat.pinned) sub.appendChild(badge('置顶', 'pin'));
      if (chat.archived) sub.appendChild(badge('归档', 'arch'));
      if (chat.origin === 'subagent') sub.appendChild(badge('子会话', 'src'));
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

/* ---------------- questions ---------------- */
async function openChat(sid, opts = {}) {
  state.sid = sid;
  state.chat = state.chats.find((c) => c.id === sid) || { id: sid, title: sid };
  renderChats();
  $('#q-head').textContent = '正在读取会话…';
  $('#q-count').textContent = '';
  $('#question-list').innerHTML = '<li class="empty-note">正在读取会话日志，第一次打开大会话可能需要几秒…</li>';
  const ok = await loadQuestions();
  if (!ok) {
    showAnswerError('读取会话失败');
    return;
  }
  if (opts.qid) {
    const ids = state.turns.map((t) => t.q_id);
    if (ids.includes(opts.qid)) return openTurn(opts.qid);
    // question filtered out — clear search so it shows up
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

function clearAnswer(message = '这个会话还没有提问。') {
  const box = $('#answer-body');
  state.turn = null;
  state.qid = null;
  $('#a-head').textContent = '回答';
  box.classList.add('empty');
  box.textContent = '';
  const p = document.createElement('p');
  p.textContent = message;
  box.appendChild(p);
}

function showAnswerError(message) {
  const box = $('#answer-body');
  state.turn = null;
  $('#a-head').textContent = '读取失败';
  box.classList.remove('empty');
  box.textContent = '';
  const p = document.createElement('p');
  p.textContent = message + '。请稍后重试，或点右上角“刷新”。';
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
    $('#q-head').textContent = '正在读取会话…';
    count.textContent = '';
    list.innerHTML = '<li class="empty-note">正在读取会话日志，第一次打开大会话可能需要几秒…</li>';
  }, 250);
  try {
    const data = await api(`/api/chats/${encodeURIComponent(sid)}/questions?${params}`);
    if (state.sid !== sid || requestId !== questionsRequest) return false;
    state.chat = data.chat || state.chat;
    state.turns = data.questions || [];
    state.total = data.total || 0;
    const title = (state.chat && state.chat.title) || '提问列表';
    $('#q-head').textContent = `提问 · ${title}`;
    $('#q-head').title = title;
    renderQuestions();
    return true;
  } catch (e) {
    if (state.sid !== sid || requestId !== questionsRequest) return false;
    state.turns = [];
    state.total = 0;
    $('#q-head').textContent = '读取失败';
    count.textContent = '';
    list.innerHTML = '<li class="empty-note">读取会话失败：' + esc(e.message) + '</li>';
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
    ? `命中 ${n} / 共 ${state.total} 条`
    : `共 ${state.total} 条提问`;

  if (!n) {
    list.innerHTML = '<li class="empty-note">' + (state.term
      ? '没有命中的提问（试试把范围改成“提问+回答”）'
      : '这个会话没有提问') + '</li>';
    return;
  }
  state.turns.forEach((t, i) => {
    const li = document.createElement('li');
    li.dataset.qid = t.q_id;
    if (t.q_id === state.qid) li.classList.add('active');
    const tools = (t.tool_summary || []).reduce((a, x) => a + x.count, 0);
    const imgs = (t.q_images || []).length;
    const title = document.createElement('div');
    title.className = 'item-title';
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = `${i + 1}.`;
    title.append(idx, document.createTextNode(t.preview || ''));
    const sub = document.createElement('div');
    sub.className = 'item-sub';
    for (const text of [
      fmtTime(t.ts),
      `回答 ${t.answer_chars || 0} 字`,
    ]) {
      if (!text) continue;
      const span = document.createElement('span');
      span.textContent = text;
      sub.appendChild(span);
    }
    if (imgs) sub.appendChild(badge(`图 ${imgs}`, 'src'));
    if (tools) sub.appendChild(badge(`工具 ${tools}`, 'src'));
    if (t.reasoning_chars) sub.appendChild(badge(`思考 ${fmtNum(t.reasoning_chars)}`, 'src'));
    if (t.todos) sub.appendChild(badge(`待办 ${t.todos}`, 'src'));
    if (t.compactions) sub.appendChild(badge(`压缩 ${t.compactions}`, 'src'));
    if (t.steer) sub.appendChild(tag('插话', 'tag-steer'));
    if (t.synthetic) sub.appendChild(badge('自动继续', 'src'));
    if (t.open) sub.appendChild(badge('进行中', 'open'));
    li.append(title, sub);
    li.title = t.q || '';
    li.onclick = () => openTurn(t.q_id);
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
    $('#q-head').textContent = '正在搜索全部会话…';
    count.textContent = '';
    list.innerHTML = '<li class="empty-note">首次搜索需要读取所有会话日志，请稍候…</li>';
  }, 250);
  try {
    const data = await api(`/api/search?${params}`);
    if (requestId !== searchRequest || state.term.trim() !== term) return;
    state.searchResults = data.results || [];
    renderSearchResults(term);
  } catch (e) {
    if (requestId !== searchRequest) return;
    $('#q-head').textContent = '搜索失败';
    count.textContent = '';
    list.innerHTML = '<li class="empty-note">搜索失败：' + esc(e.message) + '</li>';
  } finally {
    clearTimeout(timer);
  }
}

function renderSearchResults(term) {
  const list = $('#question-list');
  list.textContent = '';
  $('#q-head').textContent = '搜索结果（全部会话）';
  $('#q-count').textContent = `${state.searchResults.length} 条命中`;
  if (!state.searchResults.length) {
    list.innerHTML = '<li class="empty-note">没有命中</li>';
    return;
  }
  let lastSid = null;
  for (const r of state.searchResults) {
    if (r.session_id !== lastSid) {
      lastSid = r.session_id;
      const h = document.createElement('li');
      h.className = 'grp';
      h.textContent = r.title || r.session_id;
      list.appendChild(h);
    }
    const li = document.createElement('li');
    li.dataset.qid = r.q_id;
    if (r.q_id === state.qid) li.classList.add('active');
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = r.q_preview || '';
    const sub = document.createElement('div');
    sub.className = 'item-sub';
    for (const text of [r.where, fmtTime(r.ts)]) {
      if (!text) continue;
      const span = document.createElement('span');
      span.textContent = text;
      sub.appendChild(span);
    }
    if (r.steer) sub.appendChild(tag('插话', 'tag-steer'));
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
  } else {
    data.callsOpen = false;
    data.callsLoaded = false;
    data.calls = [];
  }
  state.turn = data;
}

async function openTurn(qid) {
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
  const t = state.turn;
  const box = $('#answer-body');
  if (!t) return;
  box.classList.remove('empty');
  $('#a-head').textContent = `回答 · ${(t.chat && t.chat.title) || ''}`;

  const tools = t.tool_summary || [];
  const toolLine = tools.length ? tools.map((x) => `${x.name}×${x.count}`).join(', ') : '无';
  const images = (t.answer || '').match(/MEDIA:\s*[^\s`"'<>]+/g) || [];
  const tokens = t.tokens || {};
  const tokenTotal = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
    .reduce((a, key) => a + (Number(tokens[key]) || 0), 0);

  const qBlock = document.createElement('div');
  qBlock.className = 'q-block';
  const qlabel = document.createElement('div');
  qlabel.className = 'qlabel';
  qlabel.textContent = `提问 #${t.seq}`;
  if (t.steer) qlabel.appendChild(tag(' 中途插话', 'tag-steer'));
  if (t.synthetic) qlabel.appendChild(badge(' 自动继续', 'src'));
  const qtext = document.createElement('div');
  qtext.className = 'qtext';
  qtext.textContent = t.q || '';
  const qmeta = document.createElement('div');
  qmeta.className = 'qmeta';
  for (const text of [
    fmtTime(t.ts),
    `回答 ${(t.answer || '').length} 字`,
    images.length ? `图片 ${images.length} 张` : '',
    `工具：${toolLine}`,
    t.model ? `模型 ${t.model}` : '',
    tokenTotal ? `tokens ${fmtNum(tokenTotal)}` : '',
  ]) {
    if (!text) continue;
    const span = document.createElement('span');
    span.textContent = text;
    qmeta.appendChild(span);
  }
  if (t.open) qmeta.appendChild(badge('正在生成', 'open'));
  if (t.end_reason && t.end_reason.kind && t.end_reason.kind !== 'completed') {
    qmeta.appendChild(badge('结束：' + t.end_reason.kind, 'warn'));
  }
  qBlock.append(qlabel, qtext, qmeta);

  const qImgs = document.createElement('div');
  qImgs.className = 'q-images';
  for (const ref of t.q_images || []) qImgs.appendChild(imageFig(ref));
  if (qImgs.children.length) qBlock.appendChild(qImgs);

  box.textContent = '';
  box.appendChild(qBlock);

  const notices = renderNotices(t.notices);
  if (notices) box.appendChild(notices);

  // Thinking ------------------------------------------------------------
  const reasoning = t.reasoning || [];
  if (reasoning.length) {
    const det = document.createElement('details');
    det.className = 'reasoning';
    const sum = document.createElement('summary');
    const chars = reasoning.reduce((a, r) => a + (r.text || '').length, 0);
    sum.textContent = `思考过程（${reasoning.length} 段 · ${fmtNum(chars)} 字）`;
    det.appendChild(sum);
    reasoning.forEach((r, i) => {
      const step = document.createElement('div');
      step.className = 'reason-step';
      const head = document.createElement('div');
      head.className = 'reason-step-head';
      head.textContent = r.step ? `步骤 ${r.step}` : `片段 ${i + 1}`;
      const pre = document.createElement('pre');
      pre.className = 'reason-text';
      pre.textContent = r.text || '';
      step.append(head, pre);
      det.appendChild(step);
    });
    box.appendChild(det);
  }

  // Compaction summaries ------------------------------------------------
  for (const comp of t.compactions || []) {
    const det = document.createElement('details');
    det.className = 'compaction';
    const sum = document.createElement('summary');
    sum.textContent = `上下文压缩摘要（${fmtTime(comp.ts)}）`;
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
  const todos = renderTodos(t.todos, '本轮待办');
  if (todos) box.appendChild(todos);

  // Answer --------------------------------------------------------------
  const label = document.createElement('div');
  label.className = 'a-label';
  label.textContent = (t.answer || '').trim()
    ? '回答'
    : (t.open ? '回答还没生成完（或这一轮只有工具调用）' : '这一轮没有文字输出');
  const body = document.createElement('div');
  if (state.raw) {
    body.innerHTML = `<pre class="md-raw">${esc(t.answer || '')}</pre>`;
  } else {
    body.className = 'md';
    body.innerHTML = mdToHtml(t.answer || '');
  }
  box.append(label, body);
  if (!state.raw) {
    patchImages(body);
    highlightCode(body);
  }

  const answerImgs = document.createElement('div');
  answerImgs.className = 'q-images';
  for (const ref of t.answer_images || []) answerImgs.appendChild(imageFig(ref));
  if (answerImgs.children.length) box.appendChild(answerImgs);

  const calls = renderCalls(t);
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
      // same list — refresh the open answer if it is the newest one and still growing
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

/* Ctrl+B 三态循环：全部显示 → 隐藏会话 → 全部隐藏 → 全部显示 */
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
  try { await copyText(state.turn.q || ''); flash($('#btn-copy-q'), '已复制'); }
  catch (e) { flash($('#btn-copy-q'), '复制失败'); }
});

$('#btn-copy-a').addEventListener('click', async () => {
  if (!state.turn) return;
  try { await copyText(state.turn.answer || ''); flash($('#btn-copy-a'), '已复制'); }
  catch (e) { flash($('#btn-copy-a'), '复制失败'); }
});

/* 一次复制提问 + 回答 */
$('#btn-copy-qa').addEventListener('click', async () => {
  if (!state.turn) return;
  const q = (state.turn.q || '').trim();
  const a = (state.turn.answer || '').trim();
  try {
    await copyText(`提问：\n${q}\n\n回答：\n${a}`);
    flash($('#btn-copy-qa'), '已复制');
  } catch (e) {
    flash($('#btn-copy-qa'), '复制失败');
  }
});

/* 跳到回答正文（跳过很长的提问和思考过程） */
$('#btn-jump-a').addEventListener('click', () => {
  const label = document.querySelector('#answer-body .a-label');
  if (!label) return;
  label.scrollIntoView({ behavior: 'smooth', block: 'start' });
  label.classList.remove('flash');
  void label.offsetWidth;      // restart the animation
  label.classList.add('flash');
  setTimeout(() => label.classList.remove('flash'), 1400);
});

/* 折叠/展开两栏：栏头 « 与折叠后的竖条 » 都走同一个开关 */
document.querySelectorAll('.rail, .collapse').forEach((el) => {
  el.addEventListener('click', () => togglePane(el.dataset.pane));
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '');

  // Ctrl+B 三态循环；Ctrl+Shift+B 只切提问栏
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
(async function boot() {
  try {
    restorePanes();
    const meta = await api('/api/meta');
    window.__home = `home：${meta.home}`;
    await loadChats();
    if (state.chats.length) {
      $('#q-head').textContent = '选择一个会话';
      $('#q-count').textContent = `${state.chats.length} 个会话`;
      $('#question-list').innerHTML =
        '<li class="empty-note">从左侧选择会话；点开后才读取完整日志。</li>';
    }
    setInterval(tick, 3000);
  } catch (e) {
    $('#meta').textContent = '加载失败：' + e.message;
  }
})();
