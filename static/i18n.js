/* DSH Chat Viewer - UI translations. English is the source language; Chinese
   strings live only in this dictionary. */
'use strict';

const LANGUAGE_KEY = 'dshv.lang';

const ZH = {
  'DSH Chat Viewer': 'DSH 对话查看器',
  'Loading…': '加载中…',
  'Load failed: {message}': '加载失败：{message}',

  'Sessions': '会话',
  'Questions': '提问',
  'Open sessions': '打开会话列表',
  'Open questions': '打开提问列表',
  'Close': '关闭',
  'Follow latest': '跟随最新',
  'Refresh every 3 seconds; new questions and streaming answers appear automatically':
    '每 3 秒刷新一次；新提问和正在生成的回答会自动出现',
  'Show archived': '显示归档',
  'Show archived sessions in the list': '在会话列表中显示已归档的会话',
  'Refresh': '刷新',
  'Refresh now': '立即刷新',
  'Language': '语言',

  'All sessions': '所有会话',
  'Expand sessions (Ctrl+B)': '展开会话列表（Ctrl+B）',
  'Collapse sessions (Ctrl+B cycles: all shown, sessions hidden, all hidden)':
    '折叠会话列表（Ctrl+B 循环：全部显示 → 隐藏会话 → 全部隐藏）',
  'Filter title or working directory…': '过滤标题或工作目录…',
  'Expand questions (Ctrl+Shift+B)': '展开提问列表（Ctrl+Shift+B）',
  'Collapse questions (Ctrl+Shift+B)': '折叠提问列表（Ctrl+Shift+B）',
  'Search questions or answers… (/)': '搜索提问或回答…（/）',
  'Search scope': '搜索范围',
  'Questions + answers': '提问+回答',
  'Questions only': '只搜提问',
  'Answers only': '只搜回答',
  'Search all sessions': '在全部会话中搜索',
  'Answer': '回答',
  'Jump to answer': '跳到回答',
  'Jump to answer body (skips a long question and thinking)':
    '滚动到回答正文（跳过很长的提问和思考过程）',
  'Copy Q&A': '复制问答',
  'Copy question and answer together': '一次复制提问和回答',
  'Copy question': '复制提问',
  'Copy answer': '复制回答',
  'Raw': '原文',
  'Toggle raw Markdown': '在 Markdown 渲染和原始文本之间切换',
  'Choose a session on the left, then a question.': '从左侧选一个会话，再选一条提问。',
  'Data comes from {path}; read-only, never writes to or locks the DSH logs.':
    '数据来自 {path}，只读，不会写入或锁定 DSH 日志。',
  'Resize sessions': '调节会话栏宽度',
  'Resize questions': '调节提问栏宽度',
  'Double-click to reset width': '双击恢复默认宽度',

  'Copy': '复制',
  'Copied': '已复制',
  'Copy failed': '复制失败',
  'Show all ({count} lines)': '展开全部（{count} 行）',
  'Collapse': '收起',
  'Unknown': '未知',
  'Attachment {id}': '附件 {id}',
  'Inline image': '内联图片',
  'Image reference could not be resolved: {name}': '图片引用无法解析：{name}',
  'Image file no longer exists: {name}': '图像文件已不存在：{name}',
  'Todos ({done}/{total})': '待办（{done}/{total}）',
  'Todos': '待办',
  'Custom answer: {text}': '自定义回答：{text}',
  'No answer recorded': '（没有回答记录）',
  '{value} sec': '{value} 秒',
  '{minutes} min {seconds} sec': '{minutes} 分 {seconds} 秒',

  'Tool calls ({count}{names})': '工具调用（{count} 次{names}）',
  ' · load on expand': ' · 展开后加载',
  'Collapse all': '折叠全部',
  'Show all': '展开全部',
  'Filter tools (name/path/command…)': '过滤工具（名称/路径/命令…）',
  'Filter tool calls by keyword': '按关键字过滤工具调用',
  'Include output': '包含输出',
  'When checked, search command output, diffs and error text too; when unchecked, only names/summaries/paths/arguments.':
    '勾选后连命令输出、diff、错误文本一起搜索；取消后只搜名称/摘要/路径/参数。',
  'No matching tools': '没有匹配的工具',
  'Showing {visible} / {total}': '显示 {visible} / 共 {total}',
  'Loading tool calls…': '正在加载工具调用…',
  'Failed to load tool calls: {message}': '加载工具调用失败：{message}',
  'No tool calls': '（没有工具调用）',
  'This call has no result yet (it may still be running).':
    '这个调用还没有结果（可能仍在运行）。',
  'No result matched this call: the turn was interrupted, or the result was not recorded.':
    '没有配到工具结果：这一轮被中断，或结果未入库。',
  '(No output)': '（没有输出）',
  'Error': '错误',
  'Output truncated': '输出过长已截断',
  'exit {code}': 'exit {code}',
  'job {status}': '任务 {status}',
  'Line {start}-{end} of {total}': '第 {start}–{end} 行 / 共 {total} 行',
  'Line {start}-{end}': '第 {start}–{end} 行',
  'Running…': '运行中…',
  'Output': '输出',
  'Content': '内容',
  'Result': '结果',
  'Arguments': '参数',
  'Command': '命令',
  'Prompt': '提示词',
  'Workflow script': '工作流脚本',
  'Diff': 'diff',

  'completed': '已完成',
  'failed': '失败',
  'running': '运行中',
  'cancelled': '已取消',
  'canceled': '已取消',
  'aborted': '已中止',
  'interrupted': '已中断',
  'pending': '待办',
  'in_progress': '进行中',

  'Question #{seq}': '提问 #{seq}',
  'Mid-turn steer': '中途插话',
  'Steer': '插话',
  'Auto continue': '自动继续',
  'In progress': '进行中',
  'Answer {count} chars': '回答 {count} 字',
  '{count} images': '{count} 张图片',
  'Tools: {list}': '工具：{list}',
  'Model {model}': '模型 {model}',
  'tokens {count}': 'tokens {count}',
  'Generating': '正在生成',
  'Ended: {reason}': '结束：{reason}',
  'The answer is still being generated (or this turn only contains tool calls).':
    '回答还没生成完（或这一轮只有工具调用）。',
  'This turn has no text output.': '这一轮没有文字输出。',
  'Thinking ({segments} segments · {chars} chars)': '思考过程（{segments} 段 · {chars} 字）',
  'Step {step}': '步骤 {step}',
  'Segment {n}': '片段 {n}',
  'Context compaction summary ({time})': '上下文压缩摘要（{time}）',
  'Turn todos': '本轮待办',

  'Plan mode: {state}': '计划模式：{state}',
  'on': '开启',
  'off': '关闭',
  'Model: {provider} / {model}': '模型：{provider} / {model}',
  'Model: {model}': '模型：{model}',
  'Working directory: {cwd}': '工作目录：{cwd}',
  'Goal: {goal}': '目标：{goal}',
  'Goal {action}: {goal}': '目标 {action}：{goal}',
  'Approval: {decision}': '审批结果：{decision}',

  'Question + answer': '提问+回答',
  'Question': '提问',
  'Search results (all sessions)': '搜索结果（全部会话）',
  '{count} hits': '{count} 条命中',
  'No hits': '没有命中',
  'No matching questions (try including answers)': '没有命中的提问（试试把范围改成“提问+回答”）',
  'This session has no questions.': '这个会话没有提问。',
  'Reading the session log; the first open of a large session may take a few seconds…':
    '正在读取会话日志，第一次打开大会话可能需要几秒…',
  'Failed to read session': '读取会话失败',
  'Failed to read session.': '读取会话失败。',
  'Please retry, or use Refresh in the top bar.': '请稍后重试，或点右上角“刷新”。',
  'Select a session': '选择一个会话',
  'Choose a session on the left; its full log is read only when opened.':
    '从左侧选择会话；点开后才读取完整日志。',
  '{sessions} sessions · {questions} questions · {workspaces} workspaces · home: {home}':
    '{sessions} 个会话 · {questions} 条提问 · {workspaces} 个工作区 · home：{home}',
  '{count} sessions': '{count} 个会话',
  '{shown} / {total} sessions': '命中 {shown} / 共 {total} 个会话',
  '{shown} / {total} questions': '命中 {shown} / 共 {total} 条',
  '{count} questions': '{count} 提问',
  '{count} questions total': '共 {count} 条提问',
  '{count} messages': '{count} 消息',
  'Pinned': '置顶',
  'Archived': '归档',
  'Subagent': '子会话',
  'No matching sessions': '没有匹配的会话',
  'Questions · {title}': '提问 · {title}',
  'Searching all sessions…': '正在搜索全部会话…',
  'The first search reads every session log. Please wait…':
    '首次搜索需要读取所有会话日志，请稍候…',
  'Search failed': '搜索失败',
  'Search failed: {message}': '搜索失败：{message}',
  'No question content': '（没有提问内容）',
  'No matching tools.': '没有匹配的工具。',
  '{count} items': '{count} 项',
  'Todos: {count}': '待办：{count}',
  'Files: {count}': '文件：{count}',
  '{count} todos': '{count} 项待办',
  '{count} files': '{count} 个文件',
  'Tools: {count}': '工具 {count}',
  'Thinking: {count}': '思考 {count}',
  'Compacted: {count}': '压缩 {count}',
  'Untitled': '（无标题）',
  'None': '无',
  'listSeparator': '、',
  ': {names}': '：{names}',
  '{title} ({done}/{total})': '{title}（{done}/{total}）',
  'Question:\n{q}\n\nAnswer:\n{a}': '提问：\n{q}\n\n回答：\n{a}',
};

const EN = {
  'listSeparator': ', ',
};

const TRANSLATIONS = { zh: ZH, en: EN };
let currentLang = detectLanguage();

function detectLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch (e) { /* private mode */ }
  const nav = String(navigator.language || '').toLowerCase();
  return nav.startsWith('zh') ? 'zh' : 'en';
}

function translate(text, params) {
  const table = TRANSLATIONS[currentLang] || {};
  let out = table[text] !== undefined ? table[text] : String(text == null ? '' : text);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      out = out.replaceAll(`{${key}}`, () => (value == null ? '' : String(value)));
    }
  }
  return out;
}

function applyI18n(root) {
  const scope = root || document;
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
  document.title = translate('DSH Chat Viewer');
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = translate(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', translate(el.getAttribute('data-i18n-placeholder')));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const text = translate(el.getAttribute('data-i18n-title'));
    el.setAttribute('title', text);
    if (el.tagName === 'BUTTON' || el.tagName === 'A'
        || el.tagName === 'SELECT' || el.getAttribute('role') === 'separator') {
      el.setAttribute('aria-label', text);
    }
  });
  const select = document.getElementById('lang-select');
  if (select) select.value = currentLang;
}

function setLanguagePreference(lang) {
  currentLang = lang === 'zh' ? 'zh' : 'en';
  try { localStorage.setItem(LANGUAGE_KEY, currentLang); } catch (e) { /* private mode */ }
}

function getLanguage() {
  return currentLang;
}

window.t = translate;
window.applyI18n = applyI18n;
window.getLanguage = getLanguage;
window.setLanguagePreference = setLanguagePreference;
