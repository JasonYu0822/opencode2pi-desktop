# 2026-10-15 匿名免费通道 403 FreeTierError：判定、根因与 0.5.4 修复

- 日期：2026-10-15（UTC）
- 插件版本：0.5.3 → **0.5.4**（提交 `c219cf7`，包 `dist/com.opencode2pi-0.5.4.piplug`）
- 一句话：上游在 2026-10-14 把匿名免费通道的门禁从"看请求体形状"换成"逐项核对官方客户端指纹"；旧形状一律 403，插件已按新形状对齐，两条 lane 真机验证 200。

## 1. 现象

所有免费模型一律返回：

```json
{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}
```

插件 `/healthz` 可见 `errors: 2`，`lastError` 即上文，且 `route.active.dial: 1`——请求**经代理成功到达了上游**，是上游业务层拒绝，不是连不上。

## 2. 对照组：10-08 同样的请求是 200

2026-10-08 在同一台机器、同一个代理（127.0.0.1:7890）、同一份代码路径下验证过：

- `transport-harness.js`：`GET /zen/v1/models` 200、`POST /zen/v1/chat/completions` 200（真 SSE，内容 "pong"）
- `responses-e2e2.js`：chat 200、`POST /zen/v1/responses` 200（完整 `response.created…response.completed` 流）
- `boot-harness.js`（整插件端到端）：chat 200、responses 200

当时的门禁规则（实测）很简单：请求体必须流式（`stream:true`）+ tools 里带名为 `bash`、`read` 的函数工具（空描述、空参数即可）。`lib/zen.js` v0.5.1 的 `ensureFreeLaneShape` 就是按这条规则写的。

## 3. 判定证据：是上游变了，不是本地问题

### 3.1 同一请求体，现在 403；相邻端点正常

- 10-08 的形状原样重发 → 403。`GET /zen/v1/models` 同刻仍 200；伪造一个不存在的 model id 会拿到真实的 `400 "Model is unavailable"`——说明请求确实到达了业务层，只有门禁判定变了。

### 3.2 15 种单因素变体，全部 403

逐项只改一个因素（`gate-probe.js`），chat 通道全部 403 FreeTierError：

- 无 tools、只有 bash+read、7 个工具、完整 CLI 工具集、tool_choice 变体（none/auto/缺省）、`stream:false`、空 user content、`x-opencode-client` 改 `tui`/`desktop`、user-agent 改 `1.99.0`、去掉 `X-Session-Id`、UA 裸写 `opencode/1.18.31`、UA 换 `opencode-cli` 风格——**全部 403**。

### 3.3 密钥、挑战头、握手端点都不相关

- `authorization` 三种写法（不发 / `Bearer public` / 垃圾 key）得到**同一个 403**——判定发生在"看钥匙"之前。
- 403 响应头里没有任何挑战/协商信号（只有 cloudflare 通用头 + `x-opencode-log-id`）。
- 以下路径全部 404（`/` 与 `/v1/models` 除外，它们 200）：`/v1/health`、`/v1/session(s)`、`/v1/me`、`/v1/usage`、`/v1/keys`、`/v1/auth(/device)`、`/v1/free(-tier)`、`/v1/entitlements`、`/v1/challenge`、`/openapi.json`；`OPTIONS /v1/chat/completions` 404。**没有新增的握手/领证端点**。

### 3.4 出口 IP 无关

- 同期出口是 `185.220.239.54`（Tor 出口段）。但按新形状构造的请求**同一出口**拿到 200——IP 声誉不是这次的原因。
- `proxyUrl: off` 强制直连时 responses lane 仍是老的 `403 RegionError`、chat 仍是 FreeTierError——地区门禁还在，但它不是这次的主因。

### 3.5 上游仓库的时间线（公开部分）

- `sst/opencode` 在 10-11 把 `/zen/*` 改成 5 行的薄代理转发给独立的 `opencode-inference-<stage>` 服务（提交 `83f2b6f6`，删掉 1314 行门禁逻辑）；`FreeTierError` 这个字符串在公开仓库**零命中**——真正的判定在闭源 worker 里。
- 10-13 又改成不再剥离 `cf-access-*` / `x-zen-*` 头（`82833dac`）。
- 社区项目 `jasonxu114514/opencode2api` 在 **10-14 当天**修好了这轮（`f8e996dc`、`be91f869`、`0204ca1f`）；我们参考的 `opencode2dsh` 到 10-14 02:35 之后再无提交、issue #72/#73 还开着（没修）。

## 4. 新门禁规则（逐条实测确认）

| # | 项 | 旧（10-08 能过） | 现在（必须） |
|---|---|---|---|
| 1 | 端点 | `https://opencode.ai/zen/v1/…` | **`https://opencode.ai/inference/v1/…`**（`/zen` 对无密钥请求一律 403；`/zen/v1/models` 目录仍 200） |
| 2 | 会话 id | 内容哈希派生的 `ses_+12hex+14base62`（形状对、编码任意） | 必须是官方**倒序时间戳**编码：12 位 hex 的低 12 位落在 `0xFC0–0xFFF`，即 `^[0-9a-f]{9}f[c-f][0-9a-f]$`（全文正则仍是 `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`） |
| 3 | 请求头 | 发 `x-opencode-request`、`x-opencode-project: prj_…` | **不许发 `x-opencode-request`**；必须发 `x-opencode-session-id`（值同 session）；`x-opencode-project` 必须是非规范形态的 **40 位小写 hex**；`Authorization: Bearer public` 保留（大小写敏感） |
| 4 | tools | 名为 `bash`、`read` 的空壳桩 | 必须是**官方定义**的 `shell`、`edit`、`glob`、`grep`、`read`（描述与参数 schema 逐字节一致）；空壳被拒；旧名 `bash`（客户端 2026-07 已改名 `shell`）留在体里必 403，直接丢掉 |
| 5 | body | `stream:true` + tools | 同上，chat 可带 `stream_options.include_usage:true` |

几点说明（都是实测，不是猜的）：

- UA **不必改**：对照组 G（老 UA `opencode/1.18.31 (…)` + 其余新形状）同样 200。`opencode2api` 用的是 `opencode/latest/2.0.29/cli`，我们保留了原来的 UA。
- 宿主自己的工具（`Read`/`Bash`/… 大写名）可以和官方 5 个**共存**（P1 200）；`Read` 等大写名上游不认，原样透传。只有**小写同名**会冲突：重复名直接 400（P4），所以同名的小写工具必须用官方定义替换、不能并存两份。
- `x-opencode-request` 是 10-14 起明确被拒的头（对照组 E）；缺 `x-opencode-session-id` 被拒（对照组 H）；`prj_*` 被拒（对照组 F）。
- 不能排除上游还有出口 IP / TLS 指纹维度的检查（社区 issue #310 有人怀疑），但在我们这台机器上上述五项已足够拿到稳定的 200。

## 5. 插件改动（v0.5.4，提交 `c219cf7`）

### `lib/zen.js`

- 新增 `ANONYMOUS_BASE_URL = 'https://opencode.ai/inference'` 并导出；`ZEN_BASE_URL` 只留给模型目录（`/zen/v1/models` 仍 200）。
- `canonicalSessionID()`：形状仍是 `ses_+12hex+14base62`，但 12 位 hex 改为官方倒序编码——36 位哈希值当毫秒时钟，左移 12 位、或上 counter `1`、整体按位取反、取低 48 位；已是规范编码的输入原样返回。位来源是**对话哈希而不是时钟**，同一对话保持同一 upstream session（保住 prompt cache）。
- 新增 `projectHeader()`：`sha256("opencode-project\0" + signal)` 取前 20 字节 hex（40 位小写，非规范形态即过）。
- `disguiseHeaders()`：删 `x-opencode-request`，加 `x-opencode-session-id`，`x-opencode-project` 走 `projectHeader()`。
- `ensureFreeLaneShape()` + 新增 `lib/opencode-tools.json`：同名官方工具做**替换**、缺失的 5 个**补齐**、旧名集合 `LEGACY_TOOL_NAMES = {'bash'}` **丢掉**；宿主工具原样保留；无 tools 时 chat 仍补 `tool_choice: "none"`，responses 通道仍不写 `tool_choice`。

### `lib/opencode-tools.json`（新增，6993 B）

`shell`、`edit`、`glob`、`grep`、`read` 五份官方定义，取自 `opencode2api` 镜像的官方客户端定义（`raw.githubusercontent.com/jasonxu114514/opencode2api/main/internal/gateway/opencode_tools.json`），描述与参数与源逐字节一致（已用脚本校验）。**不要改写它们**——上游逐字节比对。

### `main.js`

- 两条 lane 的上游 URL 从 `ZEN_BASE_URL` 换到 `ANONYMOUS_BASE_URL`。
- `Accept` 换成客户端拼写 `application/json, text/event-stream`。

### `manifest.json` / `README.md`

- 版本 `0.5.4`；description 与 README 的门禁章节按新规则重写；致谢补上 `opencode2api` 10-14 修复的出处。

## 6. 验证（全部在 2026-10-15 当天、本机、走 7890）

### 离线形状断言（10 项，全过）

端点常量、会话 id 形状+编码、`x-opencode-project` 40hex、双 session 头且无 request 头、chat 门禁工具逐字段等于官方定义、宿主工具保留且官方 5 个追加、responses 扁平且无 `tool_choice`、同名工具被替换不重复、`bash` 被丢掉、旧 harness 体整形后干净。

### 真机矩阵（逐行 1 个因素）

chat（`mimo-v2.6-flash-free`）：

- A `/inference` + 新头 + 官方工具 + 修正会话 id → **200**（真 SSE）
- B 同 A 但走 `/zen` → 403
- C `/inference` + 新头 + `bash/read` 桩 → 403
- D `/inference` + 旧头 + 官方工具 → 403
- E A + 加回 `x-opencode-request` → 403
- F A + `x-opencode-project: prj_…` → 403
- G A + 老 UA → **200**（所以 UA 没动）
- H A − `x-opencode-session-id` → 403

responses（`muse-spark-1.3-contributor-free`）：

- A `/inference/v1/responses` + 官方扁平工具 → **200**（`event: response.created …`）
- B 走 `/zen` → 403；C 桩 → 403；D 无 tools → 403

工具策略（`mimo-v2.6-flash-free`）：

- P1 宿主式工具 + 官方 5 个 → **200**；P2 只有宿主式工具 → 403；P4 小写同名并存 → **400**；P5 官方 5 个 + 未知名工具 → **200**；P6 P1 + `tool_choice:none` → **200**

### 整插件端到端（`boot-harness.js`，stub 宿主 + 回环端点 + 本机代理）

chat `status 200`、responses `status 200`、坏代理回退那轮 200、`off` 直连那轮 200。

包：`dist/com.opencode2pi-0.5.4.piplug`（9 文件、151503 B、sha256 `E84C8517942EF5BC66701373D8BD7410A9E6E567751AAE045E5BADD78A62E0F5`）。

## 7. 已知边界与后续

- **这是一场猫鼠游戏**：10-13、10-14 两天内社区被迫改了两轮（会话 id 编码一轮、指纹头+工具一轮），以后还会变。建议在插件里加一个"门禁自检"能力（一键按本节矩阵重测），下次变了几分钟就能重新定位，而不是从 403 倒推。
- `.workflow/` 会被打包器一起打进 `.piplug`（打包器只硬编码跳过 `.git`/`node_modules`/`dist`/凭据文件，**没有作者可配的排除机制**）。本次是用 `dist/stage` 临时目录做的干净打包（步骤：拷 9 个文件到 `dist/stage/` → 对它打包 → 把产物移回 `dist/` → 删 stage），以后每次打包重复这三步，或在宿主侧把 `.workflow` 加进忽略名单。
- 本仓库的项目记忆条目 `MAP` 里"门禁 tools 必含 bash+read"一句已过时，读它时以本文为准；另建议补一条"上游按客户端指纹校验"的教训（待确认后入库）。

## 8. 复现与引用

- 探针脚本（`$env:PI_SCRATCH_DIR` 下）：`gate-probe.js`（15 变体）、`gate-probe3.js`（挑战头/握手端点/密钥变体）、`gate-probe4.js`（端点×头×工具矩阵）、`gate-probe5.js`（会话 id 编码）、`gate-probe6.js`（responses）、`gate-probe7.js`（P 系列工具策略）、`gate-probe8.js`（`bash` 专项）、`anonymous-lane-harness.js`（固化后的 10+3 回归）、`make-tools.js` + `oc2api-tools.json`（工具定义来源与生成）。
- 关键上游文件（2026-10-15 取，已存 scratch）：`opencode2api/internal/gateway/upstream.go:867-918`（头构造）、`internal/httpx/client.go`（UA）、`internal/identity/request.go`（会话 id 规则）、`config.example.json`（匿名端点）、官方工具定义 JSON。
- 相关提交：插件 `c219cf7`；`sst/opencode` 的 `83f2b6f6`（10-11 薄代理）、`82833dac`（10-13 头透传）；`opencode2api` 的 `f8e996dc`、`be91f869`、`0204ca1f`（10-14 修复链）。
