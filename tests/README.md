# 测试

三个层次，全部从**运行中的真实代码**取数据，不使用 mock。

Python 解释器用 `C:\pixi_env\.pixi\envs\default\python.exe`（Python 3.14，自带 `compression.zstd`）。

## 1. 解析器单测（不需要启动服务）

```bat
C:\pixi_env\.pixi\envs\default\python.exe test_parser.py
```

`fixture.py` 会临时造一个 DSH home：多帧 zstd 日志、workspace/projcache 元数据、正常轮次、注入消息、中途插话、`pwsh` / `read` / `ask_user_question` / `todo_write` 工具结果。

覆盖：

- 多帧 zstd、单帧、损坏的尾帧
- 注入消息不切断回答
- 中途插话（steer）单独成为提问
- `tool/call` ↔ `tool/result` 配对、exit code、stderr、job 耗时
- `read` 的 `<path>/<type>/<content>` 包装与行号还原
- `ask_user_question` 的选中项与自定义回答
- `todo_write` 清单
- workspace / pinned / archived / token 元数据
- 只读元信息建列表（`loaded=false`，标题来自 projcache），点开后才解析完整日志并修正标题/计数
- 用户图片、`@image:`、`[screenshot]`

## 2. HTTP 冒烟（自动起停服务）

```bat
C:\pixi_env\.pixi\envs\default\python.exe smoke.py
```

自己找空闲端口，用临时 DSH home 启动 `server.py`，检查：

- `/api/meta`、`/api/chats`、`/api/chats/<sid>/questions`、`/api/turn/<sid>/<seq>`、`/api/search`
- 列表阶段 `loaded=false`、标题来自 projcache；打开会话后 `loaded=true` 并换成事件里的标题
- `/file` 只提供图片，拒绝 `workspace.json`
- Host 头校验（伪造 `evil.example.com` 返回 403）
- 静态文件

## 3. 页面 DOM（可选，需要 jsdom）

先启动查看器：

```bat
C:\pixi_env\.pixi\envs\default\python.exe ..\server.py --port 8766
```

另开一个终端：

```bat
npm install
node ui.js
```

`BASE` 环境变量可改端口，例如 `set BASE=http://127.0.0.1:8799`。

检查：页面启动、启动时不自动读取日志、点击会话后才加载、无 JS 错误、workspace 分组、提问列表、Markdown 回答、思考过程折叠、工具卡、PowerShell 高亮、`read` 代码块、`ask_user_question` 问题卡与自定义回答、todo、exit 徽章、切换会话、会话内搜索。
