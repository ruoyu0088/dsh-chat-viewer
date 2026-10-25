# DSH Chat Viewer

只读地查看 **DeepSeek Harness（DSH）** 的历史会话：左边是**所有会话**（按 workspace 分组），
点开后中间是**这个会话里的所有提问**（过长的截断显示），再点一条提问，右边显示**它的回答**
（Markdown 渲染、**图像直接显示**）、**可折叠的思考过程**和**可视化的工具调用**。

中间上方可以搜索提问或回答，也可以跨全部会话搜索。数据直接来自
`%USERPROFILE%\.dsh\sessions` 下的 zstd 压缩 JSONL 日志，**只读**，不会写入或锁定 DSH 的会话库。

---

## 功能

- **三栏布局**：所有会话 / 提问列表 / 回答；两栏可折叠（VSCode 风格），状态记在 localStorage。
- **会话分组**：按 workspace 显示；置顶、归档、进行中、模型、提问数、消息数、最后活动时间。
- **提问列表**：真实用户提问、中途插话（steer）、自动继续、进行中标记；回答字数、工具数、思考字数、
  待办数、压缩次数、图片数。
- **回答渲染**：Markdown、GFM 表格、KaTeX 数学公式、highlight.js 语法高亮、代码块复制/折叠、
  「原文」切换、搜索高亮。
- **思考过程**：`assistant/message` 里的 `reasoning` 块默认折叠，按步骤展示，不污染回答正文。
- **工具调用卡片**：按工具类型分别显示，而不是丢一段 JSON（详见下表）。
- **图片**：Markdown 本地图片、DSH `image` 内容块、`@image:` / `MEDIA:` 路径、附件 id；
  点击放大、缺图提示；`/file` 只允许图片、限制 40 MB。
- **搜索**：当前会话的提问/回答/全部；跨全部会话；搜索结果按会话分组。
- **跟随最新**：每 3 秒检查日志；新提问自动进列表，正在生成的回答会继续长出来。
- **只读安全**：只监听 `127.0.0.1`；`/file` 与 `/api/*` 校验 Host 头；不执行任何 DSH 命令。

---

## 数据来源

DSH 的会话存储与 Hermes 的 SQLite `state.db` 完全不同，是**事件溯源 + 追加式 zstd JSONL**：

```text
%USERPROFILE%\.dsh\
  sessions\
    --C-Users-ruoyu-Documents-project--\        # 规范化后的工作目录
      session-<uuid>\
        session.v4.jsonl.zstd                    # 当前格式；也可能是 .jsonl / .v3 / .v2 ...
  storages\
    workspace.json                               # workspace、置顶、归档、会话列表
    session_projcache\sessions\<session-id>.json # 标题、模型、token、turn outline
```

- 文件是**多个独立 Zstandard 帧首尾拼接**：头部一帧，之后每个持久化批次一帧。
  Python 3.14 的 `compression.zstd.decompress` 能一次解开所有帧。
- 日志是**追加式**的：压缩（compaction）不会覆盖旧历史，只追加新的摘要事件；
  所以查看器直接按时间顺序展示全部记录，不需要像 Hermes 那样从 `active/compacted` 多层消息重建。
- 当前支持 v4 日志；同一个会话目录有多个代际时，自动选择版本号最高的文件（压缩优先）。
- 正在写入的会话，最后一帧可能是**未完成帧**；查看器会忽略它，等下一次刷新再读完整帧。

### 提问 / 回答的配对

- 一条 `user/message` 且 `source.kind === "user"` 开启一条提问。
- 注入消息**不是提问、也不结束当前回答**：
  `runtime-context`、`skill-catalog`、`time-context`、`user-approval` 等
  `source.kind` 不是 `user` 的消息会被跳过。
- 两条真实用户消息之间的所有 `assistant/message` 文本块拼成回答。
- **中途插话**（一轮回答进行中用户又发话）：DSH 会再追加一条 `user/message`，但没有新的
  `turn/start`；查看器把它识别为「插话」，单独成为一条提问，后续回答归到这条提问下。
- **自动继续**：如果一轮开始后还没有用户提问就出现助手输出，会生成一条「自动继续」提问，
  避免内容丢失。
- 思考块（`reasoning`）与回答正文分开；工具调用用 `tool/call.callId` 与
  `tool/result.message.toolCallId` 配对。
- 工具卡还会关联 `job/registered` / `job/settled`，显示后台任务状态与耗时。

---

## 工具调用怎么显示

| 调用 | 显示方式 |
|---|---|
| `pwsh` / `bash` | 命令（PowerShell/Bash 高亮）+ 输出 + `stderr` + `exit N` 徽章 + job 状态/耗时 |
| `read` | 文件路径、行号范围、内容（自动去掉 DSH 的 `N: ` 行号前缀，按后缀高亮） |
| `write` | 写入路径 + 内容（按后缀识别语言） |
| `edit` / `patch` | 路径 + **diff 视图**（`-old` / `+new`） |
| `glob` / `grep` | pattern、path + 结果 |
| `ask_user_question` | 问题、选项、**用户选中的选项**，以及自定义文字回答 |
| `todo_write` | 清单（✓ / ▸ / ○ / ×），并显示本轮最新待办 |
| `web_search` / `web_fetch` | 查询/URL + 结果文本 |
| `present` | 交付文件列表 |
| `skill` | 技能名 + 技能内容 |
| `subagent` / `subagent_fork` | 子代理描述/提示词 + 结果 |
| `workflow` | 工作流名称 + JS 脚本 + 结果 |
| `load_workspace_dependencies` / `job_*` / `schedule_*` / `goal_*` 等 | 参数与结果 JSON（美化） |
| 其他 | 参数 JSON + 结果文本/JSON，统一兜底 |

每个代码块都可单独复制；超过 22 行自动折叠，可「展开全部」。
结果里的 `MEDIA:` 图片、`<type>image</type>` 或 image 内容块会直接显示。

---

## DSH 特有信息

- **思考过程**：折叠在回答上方，按 `step` 分段。
- **workspace**：会话按工作目录分组，显示完整路径。
- **模型 / token**：会话列表与回答头部显示模型；token 总量来自 `session_projcache`。
- **进行中**：最后一个 `turn/start` 还没有 `turn/end` 时，显示「进行中/正在生成」。
- **上下文压缩**：`compaction/summary` 显示为独立的折叠卡片，保留压缩前的完整历史。
- **ask_user_question**：用户的选择与自定义回答直接显示在工具卡里，不需要去翻 JSON。
- **job 耗时**：`job/settled` 的 `startedAt`/`finishedAt` 换算成毫秒/秒。

---

## 运行

需要 **Python 3.14+**（标准库自带 `compression.zstd`）。本项目在
`C:\pixi_env\.pixi\envs\default\python.exe`（Python 3.14.8）上开发，**不需要安装任何第三方包**。

双击 `run.bat`，浏览器会自动打开 <http://127.0.0.1:8766>。

命令行等价写法：

```bat
C:\pixi_env\.pixi\envs\default\python.exe server.py
```

常用参数：

```bat
python server.py --port 8790          :: 换端口（默认 8766，避开 Hermes 查看器的 8765）
python server.py --no-open            :: 不自动开浏览器
python server.py --home D:\dsh-home   :: 指定 DSH home（默认 %USERPROFILE%\.dsh 或 $DSH_HOME）
```

> 如果 `run.bat` 里的 Python 路径不对，改 `PYEXE` 即可；也可以用任何 Python 3.14+ 运行 `server.py`。

### 界面快捷键

- `Ctrl+B`：三态循环（全部显示 → 隐藏会话栏 → 全部隐藏 → 全部显示）
- `Ctrl+Shift+B`：只折叠/展开提问栏
- `/`：聚焦搜索（提问栏折叠时先展开）
- `j` / `k` / `↑` / `↓`：切换提问
- `Esc`：从搜索框失焦
- 回答区按钮：跳到回答、复制问答、复制提问、复制回答、原文

---

## API

| 路径 | 说明 |
|---|---|
| `GET /api/meta` | DSH home、会话数、提问数、workspace 数 |
| `GET /api/chats` | 所有会话（标题/目录/模型/token/提问数/置顶/归档/进行中） |
| `GET /api/chats/{sid}/questions?q=&scope=q\|a\|all` | 该会话的提问列表（可过滤） |
| `GET /api/turn/{sid}/{seq}` | 单条提问：完整提问、回答、思考、工具卡、压缩摘要、待办 |
| `GET /api/search?q=&scope=&sid=&limit=` | 跨会话搜索 |
| `GET /file?path=<绝对路径>` | 只读提供**图片**文件（唯一允许的读取类型） |
| `GET /attachment?id=<附件id>&sid=<会话id>` | 只读提供 DSH 图片附件（在已知附件目录中查找） |

`seq` 是 DSH 事件日志里的序号；前端用 `<sid>:<seq>` 作为提问的唯一 id。

---

## 安全边界

- 只监听 `127.0.0.1`；`/file` 与 `/api/*` 校验 Host 头（默认只接受 loopback，防 DNS rebinding）。
- `/file` 只允许图片后缀（png/jpg/jpeg/gif/webp/bmp/svg/ico/avif），≤ 40 MB；
  SVG 额外加 `Content-Security-Policy: sandbox`；永不返回其它文件。
- `/attachment` 只在 DSH 已知附件目录中按 id 查找，不接受任意路径。
- 会话日志以只读方式读取，不写入、不加锁；DSH 可以同时运行。
- 不执行日志里的任何命令；工具结果只作为文本/Markdown 显示。

---

## 与 Hermes 版的差异

| | Hermes Chat Viewer | DSH Chat Viewer |
|---|---|---|
| 存储 | SQLite `state.db` | 追加式 zstd JSONL |
| 轮次重建 | 需要处理 `active/compacted`、压缩副本、注入消息 | 事件流直接分组；压缩只追加摘要 |
| 提问识别 | `display_kind` + 注入前缀 | `user/message.source.kind === "user"` |
| 思考过程 | 不显示 | 折叠显示 |
| 工具调用 | `terminal` / `patch` / 批量外壳 | `pwsh` / `edit` / `ask_user_question` / `todo_write` 等 |
| 分组 | 所有 Chat | 按 workspace 分组 |
| 运行 | Python + SQLite | Python 3.14 + 标准库 zstd |

---

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | 标准库 HTTP 服务（无第三方依赖），提供 API + 静态文件 + `/file` / `/attachment` |
| `lib/dsh.py` | 读取 zstd JSONL、解析事件、构建提问/回答/工具卡、缓存与搜索 |
| `static/index.html` | 三栏页面骨架 |
| `static/app.js` | 前端逻辑（列表、搜索、高亮、图像、工具卡、跟随刷新） |
| `static/style.css` | 样式（浅色/深色自动） |
| `static/marked.min.js` | Markdown 渲染（本地副本，离线可用） |
| `static/katex/` | KaTeX 数学公式（js/css/字体，本地副本，离线可用） |
| `static/hljs*.js` / `hljs-*.css` | highlight.js 语法高亮（本地副本，离线可用） |
| `run.bat` | 用 `C:\pixi_env` 的 Python 启动并打开浏览器 |
| `THIRD_PARTY_NOTICES.md` | marked / KaTeX / highlight.js 的许可说明 |
| `tests/` | 解析器单测、HTTP 冒烟、可选 jsdom 页面测试 |

---

## 测试

```bat
cd tests
C:\pixi_env\.pixi\envs\default\python.exe test_parser.py
C:\pixi_env\.pixi\envs\default\python.exe smoke.py
```

页面测试（可选，需要 jsdom；先启动查看器）：

```bat
cd tests
npm install
node ui.js
```

详见 [`tests/README.md`](tests/README.md)。

---

## 已知限制

- **格式**：主要针对 v4 的 `user/message` / `assistant/message` / `tool/call` / `tool/result` 结构。
  更早的 v3 日志若使用 `tool-result` 包装，工具结果可能只显示为普通注入消息；同一会话目录存在
  v4 时会自动选 v4。
- **zstd**：必须用 Python 3.14+；Python 3.12 没有 `compression.zstd`。
- **实时尾帧**：正在写入的未完成 zstd 帧会被忽略，下一次刷新（3 秒内）再读；不会报错。
- **附件**：图片附件按 id 在 `.dsh/attachments`、`.dsh/media`、`.dsh/storages/*` 等已知目录里查找；
  找不到时显示「图像文件已不存在」，不影响其它内容。
- **子代理**：子会话若单独落盘，会作为独立会话出现在左侧；暂未做父子树折叠。
- **只读**：没有删除、编辑、重命名、导出会话的功能。
