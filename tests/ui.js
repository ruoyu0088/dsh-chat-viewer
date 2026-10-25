// Browser-level checks for DSH Chat Viewer.
//
// Prerequisite: the viewer is already running, e.g.
//   C:\pixi_env\.pixi\envs\default\python.exe server.py --port 8766
// Then:
//   cd tests
//   npm install          (once; only needed for this optional UI test)
//   node ui.js
//
// Set BASE when the viewer runs on another port.
const { JSDOM, VirtualConsole } = require('jsdom');
const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};
async function waitFor(fn, timeout = 25000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return true; } catch (e) { /* not ready */ }
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
}
const txt = (el) => (el && el.textContent != null ? String(el.textContent).replace(/\s+/g, ' ').trim() : '');
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

(async () => {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => errors.push(String(e.message || e).slice(0, 200)));

  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.fetch = (input, init) => fetch(new URL(input, BASE + '/'), init);
      win.navigator.clipboard = { writeText: async () => {} };
      win.Element.prototype.scrollIntoView = function () {};
      win.open = () => null;
    },
  });
  const win = dom.window, doc = win.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];

  check('页面启动', await waitFor(() => $$('#chat-list li').length > 0));
  check('无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  check('会话按 workspace 分组', $$('#chat-list li.grp').length > 0, `${$$('#chat-list li.grp').length} 组`);
  check('启动时不自动读取会话日志', $$('#question-list li[data-qid]').length === 0
    && !!$('#answer-body.empty'));

  // The first session is loaded only after clicking it.
  $$('#chat-list li[data-sid]')[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  check('点击会话后加载提问列表', await waitFor(() => $$('#question-list li[data-qid]').length > 0));
  const firstLi = $$('#question-list li[data-qid]')[0];
  const firstQid = firstLi.dataset.qid;
  const [firstSid, firstSeq] = firstQid.split(':');
  const firstTurn = await fetch(
    BASE + `/api/turn/${encodeURIComponent(firstSid)}/${encodeURIComponent(firstSeq)}`
  ).then((r) => r.json());
  firstLi.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  check('回答已渲染', await waitFor(() => !!$('#answer-body .md')
    && txt($('#answer-body .qtext')) === norm(firstTurn.q)));
  const callsDetails = $('#answer-body details.calls');
  let toolCards = [];
  if (callsDetails) {
    check('工具调用外层默认折叠', !callsDetails.open && $$('#answer-body details.call').length === 0);
    callsDetails.open = true;
    callsDetails.dispatchEvent(new win.Event('toggle'));
    check('展开外层后加载工具卡', await waitFor(() => $$('#answer-body details.call').length > 0),
      `${$$('#answer-body details.call').length} 张`);
    toolCards = $$('#answer-body details.call');
    check('单张工具卡默认折叠', toolCards.length > 0 && toolCards.every((c) => !c.open));
    check('折叠时只创建标题行', !$('#answer-body details.call .call-body .code'));
  } else {
    check('工具调用外层默认折叠', true, '本轮没有工具调用');
  }

  const openTool = async (name) => {
    const card = toolCards.find((c) => txt(c.querySelector('.call-name')) === name);
    if (!card) return false;
    card.open = true;
    card.dispatchEvent(new win.Event('toggle'));
    return waitFor(() => card.querySelector('.call-body')?.childElementCount > 0);
  };

  const reasoning = $('#answer-body details.reasoning');
  if (reasoning) check('思考过程可折叠', true, txt(reasoning.querySelector('summary')));

  if (await openTool('pwsh')) {
    const pwshCard = toolCards.find((c) => txt(c.querySelector('.call-name')) === 'pwsh');
    check('PowerShell 命令高亮', !!pwshCard.querySelector('code.language-powershell'));
    pwshCard.open = false;
    pwshCard.dispatchEvent(new win.Event('toggle'));
    check('单张工具卡可再次折叠', !pwshCard.open);
  }
  if (await openTool('read')) {
    const readCard = toolCards.find((c) => txt(c.querySelector('.call-name')) === 'read');
    check('read 结果以代码块显示', !!readCard.querySelector('.code'));
  }
  if (await openTool('ask_user_question')) {
    const ask = $('#answer-body .qask');
    check('ask_user_question 问题卡', !!ask, `${$$('#answer-body .qask').length} 张`);
    const custom = $('#answer-body .qask-custom');
    if (custom) check('ask_user_question 自定义回答', txt(custom).length > 0, txt(custom));
  }
  if (await openTool('todo_write')) {
    const todos = $('#answer-body .todos');
    check('todo 清单', !!todos, todos ? txt(todos.querySelector('.todos-head')) : '');
  }
  if ($$('#answer-body .badge').some((b) => /^exit \d+/.test(txt(b)))) {
    check('exit code 徽章', true);
  }

  // Toolbar: filter, visible-only bulk collapse/expand.
  const filterInput = $('#answer-body .calls-filter');
  if (filterInput) {
    const firstCard = toolCards[0];
    const filterName = firstCard ? txt(firstCard.querySelector('.call-name')) : 'pwsh';
    filterInput.value = filterName;
    filterInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    const visible = $$('#answer-body details.call:not(.hidden)');
    check('工具关键字过滤', visible.length > 0 && visible.length < toolCards.length
      && visible.some((c) => txt(c.querySelector('.call-name')) === filterName),
      `${visible.length} 张`);
    check('过滤计数', /显示 \d+ \/ 共 \d+/.test(txt($('#answer-body .calls-count'))),
      txt($('#answer-body .calls-count')));

    const buttons = $$('#answer-body .calls-toolbar button');
    const expandBtn = buttons.find((b) => txt(b) === '展开全部');
    const collapseBtn = buttons.find((b) => txt(b) === '折叠全部');
    if (expandBtn) {
      expandBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      check('过滤后展开全部（仅可见）', await waitFor(() => $$('#answer-body details.call:not(.hidden)')
        .every((c) => c.open)));
    }
    if (collapseBtn) {
      collapseBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      check('过滤后折叠全部（仅可见）', await waitFor(() => $$('#answer-body details.call:not(.hidden)')
        .every((c) => !c.open)));
    }
    const outputToggle = $('#answer-body .calls-toolbar input[type="checkbox"]');
    check('包含输出开关', !!outputToggle && outputToggle.checked);

    // A keyword that exists only in a tool result must stop matching when the
    // optional "include output" scope is switched off.
    if (outputToggle) {
      const sample = toolCards.find((c) => {
        const words = (c._searchOutput || '').match(/[a-z][a-z0-9_./-]{5,}/gi) || [];
        return words.some((word) => !(c._searchBase || '').includes(word.toLowerCase()));
      });
      const token = sample
        ? ((sample._searchOutput || '').match(/[a-z][a-z0-9_./-]{5,}/gi) || [])
          .find((word) => !(sample._searchBase || '').includes(word.toLowerCase()))
        : '';
      if (sample && token) {
        filterInput.value = token;
        filterInput.dispatchEvent(new win.Event('input', { bubbles: true }));
        check('包含输出时按结果匹配', !sample.classList.contains('hidden'), token);
        outputToggle.checked = false;
        outputToggle.dispatchEvent(new win.Event('change', { bubbles: true }));
        check('关闭输出后不按结果匹配', sample.classList.contains('hidden'), token);
        outputToggle.checked = true;
        outputToggle.dispatchEvent(new win.Event('change', { bubbles: true }));
        check('重新开启输出后恢复匹配', !sample.classList.contains('hidden'), token);
      }
    }

    filterInput.value = '';
    filterInput.dispatchEvent(new win.Event('input', { bubbles: true }));
  }

  const sessions = $$('#chat-list li[data-sid]');
  if (sessions.length > 1) {
    const oldHead = txt($('#q-head'));
    sessions[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('切换会话', await waitFor(() => txt($('#q-head')) !== oldHead
      && $$('#question-list li[data-qid]').length > 0));
  }

  // In-session search
  const scope = $('#q-scope');
  scope.value = 'all'; scope.dispatchEvent(new win.Event('change', { bubbles: true }));
  $('#q-search').value = 'polars'; $('#q-search').dispatchEvent(new win.Event('input', { bubbles: true }));
  check('会话内搜索', await waitFor(() => /命中/.test(txt($('#q-count'))), 8000), txt($('#q-count')));

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
