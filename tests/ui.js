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
  $$('#question-list li[data-qid]')[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  check('回答已渲染', await waitFor(() => !!$('#answer-body .md')));
  const callsDetails = $('#answer-body details.calls');
  if (callsDetails) {
    check('工具调用默认折叠', !callsDetails.open && $$('#answer-body .call').length === 0);
    callsDetails.open = true;
    callsDetails.dispatchEvent(new win.Event('toggle'));
    check('展开后加载工具卡', await waitFor(() => $$('#answer-body .call').length > 0),
      `${$$('#answer-body .call').length} 张`);
  } else {
    check('工具调用默认折叠', true, '本轮没有工具调用');
  }

  const reasoning = $('#answer-body details.reasoning');
  if (reasoning) check('思考过程可折叠', true, txt(reasoning.querySelector('summary')));
  const pwshCard = $$('#answer-body .call').find((c) => txt(c.querySelector('.call-name')) === 'pwsh');
  if (pwshCard) check('PowerShell 命令高亮', !!pwshCard.querySelector('code.language-powershell'));
  const readCard = $$('#answer-body .call').find((c) => txt(c.querySelector('.call-name')) === 'read');
  if (readCard) check('read 结果以代码块显示', !!readCard.querySelector('.code'));

  const ask = $('#answer-body .qask');
  if (ask) {
    check('ask_user_question 问题卡', true, `${$$('#answer-body .qask').length} 张`);
    const custom = $('#answer-body .qask-custom');
    if (custom) check('ask_user_question 自定义回答', txt(custom).length > 0, txt(custom));
  }
  const todos = $('#answer-body .todos');
  if (todos) check('todo 清单', true, txt(todos.querySelector('.todos-head')));
  if ($$('#answer-body .badge').some((b) => /^exit \d+/.test(txt(b)))) {
    check('exit code 徽章', true);
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
