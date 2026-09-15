# devin-proxy

把本机 **Devin Desktop** 账号里的模型（Claude / GPT / Gemini / GLM / Grok / Kimi / DeepSeek / SWE 等）反代成 **OpenAI** 与 **Anthropic** 兼容接口，供 Cherry Studio、Claude Code、Codex CLI 等任意兼容客户端使用。

> **重要**：使用本项目需要有效的 Devin 订阅。本项目不提供账号、订阅或额度；所有调用都消耗你自己账号的额度。

## 特性

- **零登录**：自动读取本机 Devin Desktop 已保存的登录态，无需再走 OAuth
- **三种协议**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`（含 `count_tokens`），全部支持流式
- **实时模型目录**：`GET /v1/models` 直接从 Devin 拉取当前可用模型（200+），带 10 分钟缓存，不再维护过期静态大表
- **JWT 缓存**：上游 JWT 有效期 15 分钟，缓存后每次请求省下约 2~3 秒握手延迟
- **客户端断连即停**：客户端取消请求时立刻中止上游流，不烧额度
- **可选访问密钥**：`PROXY_API_KEY` 保护 `/v1/*`，默认只监听 `127.0.0.1`
- **零运行时依赖**：Bun + TypeScript，手写 Protobuf 编解码

## 前置条件

- [Bun](https://bun.sh) ≥ 1.3
- 本机安装并登录了 Devin Desktop（或按下文用 `login` / `DEVIN_API_KEY` 提供 token）

## 快速开始

```bash
bun install
bun run status      # 确认能读到本地 Devin Desktop 的登录态，并显示账号信息
bun run start       # 启动反代，默认 http://127.0.0.1:3000
```

启动后横幅会显示 token 来源与指纹：

```
devin-proxy listening at http://127.0.0.1:3000
  OpenAI:    POST /v1/chat/completions, POST /v1/responses, GET /v1/models
  Anthropic: POST /v1/messages (+ /v1/messages/count_tokens)
  Health:    GET  /health
  Token:     desktop (C:\Users\...\Devin\User\globalStorage\state.vscdb) devin-session-token$…xxxxxx
  Proxy key: disabled (PROXY_API_KEY unset)
```

验证：

```bash
curl http://127.0.0.1:3000/v1/models | head -c 400

curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"glm-5-2-none","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":32}'
```

## CLI 命令

| 命令 | 说明 |
| --- | --- |
| `bun run start` | 启动反代（`serve`，默认子命令） |
| `bun run dev` | 启动并监听源码变更自动重启 |
| `bun run status` | 显示 token 来源、指纹，以及上游账号的邮箱 / 套餐 / JWT 剩余时间 |
| `bun run models` | 表格列出当前账号可用的全部模型 |
| `bun run login` | OAuth PKCE 登录，token 写入 `~/.devin-proxy/token`（供未安装 Desktop 的机器使用） |
| `bun run login -- --paste` | 无法自动打开浏览器时，手动粘贴回调 URL |
| `bun run login -- --print` | 只打印 token，不保存 |
| `bun run src/index.ts --help` | 帮助 |

## Token 来源链

反代进程自己持有上游凭证，客户端**不需要也不应**传 Devin token。解析顺序（命中即停）：

1. 环境变量 `DEVIN_API_KEY`
2. token 文件 `~/.devin-proxy/token`（由 `bun run login` 写入；目录可用 `DEVIN_PROXY_CONFIG_DIR` 覆盖）
3. 本机 Devin Desktop 的 `state.vscdb`（自动定位）
   - Windows：`%APPDATA%\Devin\User\globalStorage\state.vscdb`
   - macOS：`~/Library/Application Support/Devin/User/globalStorage/state.vscdb`
   - Linux：`~/.config/Devin/User/globalStorage/state.vscdb`
   - 可用 `DEVIN_DESKTOP_STATE_DB` 显式指定

三者都拿不到时启动直接报错并给出指引。上游拒绝凭证时会自动重新走一遍解析链并重试一次（例如你在 Desktop 里重新登录后 token 变了，无需重启反代）。

## 配置

所有配置通过环境变量（Bun 会自动加载当前目录的 `.env`，参考 `.env.example`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；开放局域网请改 `0.0.0.0` 并**务必**设置 `PROXY_API_KEY` |
| `PROXY_API_KEY` | 未设置 | 设置后 `/v1/*` 需携带 `Authorization: Bearer <key>` 或 `x-api-key: <key>`；`/health` 不受限 |
| `DEVIN_API_KEY` | 未设置 | 上游 token 覆盖（来源链第一级） |
| `DEVIN_BASE_URL` | `https://server.codeium.com` | 上游 API 地址覆盖 |
| `DEVIN_PROXY_CONFIG_DIR` | `~/.devin-proxy` | token 文件所在目录 |
| `DEVIN_DESKTOP_STATE_DB` | 按平台自动 | 显式指定 Devin Desktop 的 `state.vscdb` 路径 |
| `MODEL_MAP` | 空 | 模型别名映射，`alias=uid,alias2=uid2`；用于客户端模型名固定的场景（见下） |
| `MODELS_TTL_MS` | `600000` | 模型目录缓存时长（毫秒）；`GET /v1/models?refresh=1` 可强制刷新 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`，输出到 stderr |

`model` 字段接受任意上游模型 uid（以 `bun run models` 或 `GET /v1/models` 输出为准），未知 uid 原样透传给 Devin；响应中的 `model` 回填客户端传入的原始值。

## 客户端配置

### Cherry Studio / NextChat / Open WebUI 等（OpenAI 协议）

| 配置项 | 值 |
| --- | --- |
| API 地址 | `http://127.0.0.1:3000/v1` |
| API Key | `PROXY_API_KEY` 的值；未设置时填任意非空字符串 |
| 模型 | 从 `GET /v1/models` 获取，如 `claude-opus-5-medium`、`gpt-5-6-sol-high`、`glm-5-2-none` |

### Claude Code（Anthropic 协议）

Claude Code 发出的模型名是固定的 Anthropic 命名，用 `MODEL_MAP` 把它们映射到 Devin 的 uid：

```bash
# 启动反代
MODEL_MAP="claude-sonnet-4-5=claude-sonnet-5-medium,claude-opus-4-1=claude-opus-5-medium,claude-3-5-haiku-latest=gemini-3-8-flash-low" \
PROXY_API_KEY=my-secret bun run start

# 另一个终端启动 Claude Code
export ANTHROPIC_BASE_URL=http://127.0.0.1:3000
export ANTHROPIC_AUTH_TOKEN=my-secret
export ANTHROPIC_MODEL=claude-sonnet-4-5
claude
```

也可以直接把 `ANTHROPIC_MODEL` 设成 Devin uid（如 `claude-opus-5-high`），此时无需 `MODEL_MAP`。反代会自动剥离 Claude Code 系统提示里被 Devin 内容策略拒绝的样板段落，并过滤掉 Devin 不接受的 `Read` / `TaskOutput` / `WebSearch` 宿主工具声明（其余工具正常透传并由 Claude Code 本地执行）。

### Codex CLI（OpenAI Responses 协议）

```bash
export OPENAI_BASE_URL=http://127.0.0.1:3000/v1
export OPENAI_API_KEY=my-secret
codex -m gpt-5-6-sol-high
```

识别到 Codex 请求时，反代会剥离其系统提示中被上游拒绝的两行样板，并忽略 Codex 顶层 `tools` 里的宿主工具清单（Devin 会把它们当 MCP 配置校验而拒绝整个请求）。

### curl 示例

```bash
# OpenAI Chat Completions（流式）
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5-medium","stream":true,"messages":[{"role":"user","content":"用一句话介绍你自己"}]}'

# Anthropic Messages
curl http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5-medium","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'

# OpenAI Responses
curl http://127.0.0.1:3000/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5-6-sol-medium","input":"Hello"}'
```

## 协议映射说明

- **思考内容**：OpenAI 协议下以 `reasoning_content` 字段返回（流式与非流式），Anthropic 协议下为 `thinking` 块，Responses 协议下为 `reasoning` 输出项。
- **工具调用**：三种协议均支持。OpenAI 流式 `tool_calls` 带 `index`，符合 SDK 聚合规范。
- **usage**：均映射上游真实 token 统计，含缓存命中数（`cached_tokens` / `cache_read_input_tokens`）。
- **错误**：上游限流 → `429 rate_limit_error`；凭证失效 → `401 authentication_error`；其他上游错误 → `502 api_error`。流式过程中的错误以协议各自的错误事件返回。
- **采样参数**：`temperature` 默认 0.4，传 0 会被夹到 0.01（上游部分模型拒绝 0）；`max_tokens` 默认 64000。

## 安全说明

- 反代进程持有你的 Devin 登录凭证，**默认只监听 `127.0.0.1`**。若要开放到局域网（`HOST=0.0.0.0`），必须同时设置 `PROXY_API_KEY`，否则同网段任何人都能用你的额度。
- 日志与 CLI 输出只显示 token 指纹（前缀 + 尾 6 位），不会打印完整 token 或 JWT。`LOG_LEVEL=debug` 会打印请求体（不含凭证），排障后请调回。
- `~/.devin-proxy/token` 与 `.env` 都是明文凭证，已在 `.gitignore` 中，请勿提交。

## 架构

```text
客户端（Cherry Studio / Claude Code / Codex ...）
    │  OpenAI / Anthropic / Responses JSON (+SSE)
    ▼
devin-proxy（Bun）
    ├─ token.ts     DEVIN_API_KEY → ~/.devin-proxy/token → Devin Desktop state.vscdb
    ├─ upstream.ts  GetUserJwt（15min 缓存）→ GetChatMessage（Connect + Protobuf + gzip 流）
    └─ handlers/    三种协议 ↔ 内部消息格式互转
    │  Connect 协议（Protobuf over HTTP/1.1）
    ▼
Devin / Windsurf Cascade API（server.codeium.com）
```

主要文件：

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | CLI 入口（serve / login / status / models） |
| `src/config.ts` | 环境变量 → `ProxyConfig` |
| `src/desktop.ts` | 定位并读取 Devin Desktop 的 `state.vscdb` |
| `src/token.ts` | token 解析链与缓存 |
| `src/login.ts` | OAuth PKCE 登录 + 本地回调服务器 |
| `src/proto.ts` | 所需消息的最小 Protobuf 编解码器 |
| `src/upstream.ts` | 上游客户端：GetUserJwt（缓存）、GetChatMessage 流、模型发现 |
| `src/models.ts` | 模型目录缓存与 `MODEL_MAP` 别名 |
| `src/convert.ts` | OpenAI / Anthropic / Responses ↔ 内部格式 ↔ Devin prompt |
| `src/sanitize.ts` | 针对 Claude Code / Codex 系统提示的经验性清洗 |
| `src/server.ts` + `src/handlers/` | 路由、鉴权、日志与各协议 handler |

## 开发与测试

```bash
bun run typecheck                    # tsc --noEmit
bun test                             # 离线测试（假上游），live 用例自动跳过
LIVE=1 bun test test/live.test.ts    # 1 次真实上游调用，验证协议仍可用
```

## 致谢与许可

协议层（Protobuf 编解码、Connect 流解析、格式转换、Claude Code / Codex 清洗规则）参考并移植自 [CaiJingLong/devin-gateway](https://github.com/caijinglong/devin-gateway) 及其分支 [szhadmin/devin-gateway-fix](https://github.com/szhadmin/devin-gateway-fix)（MIT）。本项目同样以 [MIT License](LICENSE) 发布。
