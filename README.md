# OpenCode免费模型

**OpenCode Zen 的匿名免费模型，作为正式 provider 出现在 PI-Desktop 的模型选择器里。**
无需 API Key、无需注册；**上游默认自动走本机代理**，所以在中国大陆无需 TUN、也无需改系统 DNS 即可使用。

*本插件完全由AI生成，不保证完全可用。*有问题欢迎提交issue，*~~我会拿AI修的~~*。

## 架构

**近期修复：**
- **协议感知的响应处理**：宿主发送 `stream: false` 时，按 Chat 或 Responses
  方言完整聚合 SSE；流式请求按事件帧解析、校验并只重写需要修正的帧。
- **增量 SSE 解析**：支持 BOM、注释、CRLF/CR/LF、多行 `data:`、任意字节切块和 UTF-8 校验，
  不再用字符串包含关系猜测完成标记。
- **工具调用守卫**：Chat 的分片工具名先缓冲后统一映射；Responses 在 item 与最终快照中同步映射，
  未声明的空名调用会转成可读提示，不会留下半截调用。
- **会话 id**：12 位十六进制时间段改为按对话记忆化的真实倒序时钟，同一对话的重试
  与后续轮次继续复用同一个 `ses_` id，并保留上游配额归组与提示缓存亲和。
- **思考档位**：宿主未选择档位时完全省略 `reasoning_effort`；只有显式 `off`/`none`
  才写成 `"none"`，避免 `big-pickle` 等模型因缺失档位被上游 400。
- **流终止保证**：只有 Chat 的 `[DONE]` 与 Responses 的 `response.completed` /
  `response.incomplete` 才算终止；文本已输出且无未完成工具时会补截断提示，
  其余异常结束会返回明确错误。另保留 120s 空闲看门狗。

宿主在**生成插件进程之前**就读取 manifest 的 `contributes.providers`，聊天窗的模型
选择器只枚举这个宿主 provider 列表——运行时 `registerProvider` 的模型（agent 扩展）
进不了选择器。因此本插件与 commandcode 插件同构：

```
聊天窗模型选择器
   └─「OpenCode免费模型」组（manifest contributes.providers，静态声明+自改写）
        └─ baseUrl http://127.0.0.1:41860/v1 ──► 插件后台服务 zen-proxy（loopback）
                                                     │  附加伪装头 + 体门禁 + Bearer public
                                                     │  上游连接由 lib/transport.js 建立（代理走 CONNECT/SOCKS5）
                                                     └─► https://opencode.ai/inference (SSE 解析/重写/聚合)
```

- **`provider.register`**——把 manifest 声明的服务与模型加进设置的服务列表（即模型
  选择器的数据源）。`authKind: "none"`：宿主不发 Authorization、视为就绪、**PI-Desktop
  里不存任何密钥**；匿名密钥 `public` 由 loopback 层自己附加。
- **`background.service`**——常驻回环端点 `zen-proxy`（onLoad 后由宿主启动，仅绑定
  127.0.0.1，拒绝非回环 Host/Origin）。宿主把请求发到 baseUrl，本进程用
  `lib/transport.js` 转发上游并逐块透传 SSE（不能用宿主的 `net.fetch` 桥——它会把
  响应缓冲成整段文本，流式就没了；也因此不申请 `net.fetch` 权限）。
- **上游代理**——宿主给插件子进程的是**白名单环境变量**（只有 PATH、SystemRoot、
  TEMP 等，不含 `HTTP_PROXY`/`HTTPS_PROXY`/`NODE_USE_ENV_PROXY`），且插件进程的原生
  `fetch` 不读系统代理。于是直连时用的是系统解析器：在 `opencode.ai` 被 DNS 污染的网络里
  每次对话都是 502 `upstream request failed: fetch failed`（真因 `ERR_TLS_CERT_ALTNAME_INVALID`
  被 undici 的 `fetch failed` 吞掉）。现在插件自己解析并拨号，顺序见下文。
- **模型目录自改写**——S1 实时 `GET /zen/v1/models`（带伪装头）∩ S2 models.dev
  （`cost 0/0` 且未废弃），5 分钟刷新；列表变化时改写自己的 `manifest.json`，
  **在插件页重载一次插件**生效（宿主只在加载时读 manifest，与 commandcode 相同）。
- **磁盘缓存**（`lib/zen.js` ModelCatalog）——S1 名单 + S2 元数据每次**真实变化**时
  原子写入宿主数据目录 `~/.pi-desktop/plugins/data/com.opencode2pi/catalog-cache.json`
  （`pi.plugin.getDataPath()`，拿不到则退回插件目录；7 天有效，只在数据真实变化时写——
  既不每 5 分钟落盘，也不在插件包目录里写，开发插件 watcher 永远看不到缓存文件）。
  启动先读盘播种再联网：离线/抖动启动直接沿用上次的
  完整清单与元数据，不会退化成静态兜底去改写 manifest（也就没有"列表缩水 + 思考
  档消失 + 无谓重载"）。缓存缺失/过期/损坏时退回编译期静态清单；Responses
  模型由协议目录发现后动态声明，当前目录若没有对应免费模型则不生成该 provider。

## 上游代理：只影响本插件，不动系统

上游请求的连接由 `lib/transport.js` + `lib/proxy.js` 建立，按下面的顺序挑选路线，
第一个能用就一直用（同一会话粘住；5 分钟后重新解析，解析到的代理会被记住）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | **插件设置 `proxyUrl`** | 在插件设置页填 `http://127.0.0.1:7890`、`socks5://127.0.0.1:1080`（可带 `user:pass@`）；留空/`auto` = 自动 |
| 2 | **环境变量** | `OPENCODE_FREE_PROXY` → `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY` |
| 3 | **Windows 系统代理** | 读注册表 `HKCU\...\Internet Settings`（`ProxyEnable` / `ProxyServer`），也就是 Clash / Clash Verge / SSRDOG 等「使用系统代理」写入的那一项 |
| 4 | **常见本地端口** | `7890 7897 7891 1080 10809 10808 2080 8889 9567 20171 1235 8118`，逐个 TCP 探测 |
| 5 | **直连** | 只在**一条代理候选都没有**时才走（例如设置明确填了 `off`）；有代理候选时永远不会直连。直连在连接/证书层失败时会再用公共 DNS（8.8.8.8 / 9.9.9.9）解析一次真实地址重试 |

- **http/https 代理** 用 `CONNECT` 隧道（支持 `Proxy-Authorization`）；**socks5/socks5h**
  用 RFC 1928/1929 握手，域名按域名原样交给代理解析（**这正是"被污染的本地 DNS 不再相关"的原因**）。
- TLS 会话在我们的隧道之内建立，证书与 SNI 仍按 `opencode.ai` 校验，不做任何降级。
- 候选逐个尝试：某个代理连不上（拒绝/超时/证书错误）会**等 400ms 再拨同一个代理**（最多 3 次，
  等待递增到 900ms），仍不行才换下一个候选；全部候选都失败才判 `ENOROUTE` 并重新解析。
  隧道握手超时 12s（本机代理冷握手常见 5–6s），所以"代理先开、后关"、"端口换了"、节点抖动都
  不需要重载插件。
- **有代理候选时绝不直连**：直连=大陆出口，`muse-spark-*` 这类 region 受限模型必然 403。
  所以代理抖动时的正确行为是**等待并重拨代理**，而不是悄悄退回直连——`/healthz` 的
  `route.proxiesOnly` 必须是 `true`，`route.counters.waits` 会随重拨增长。
- **解析到的代理会被记住**：某次重新解析时本机代理客户端正好在重启（注册表项/端口暂时查不到），
  池子也不会因此变空把下一次请求甩去直连；被记住的候选排在实时探测到的候选之后。某个代理连续
  3 次拨号失败会被排到最后 60 秒，一旦成功立即恢复优先。
- **地区门禁换路线**：某个代理节点的出口被 `403 RegionError: This model is not available in your
  country` 拒绝时，会拿**同一条请求**试下一个代理候选（`/healthz` 的
  `route.counters.regionRetries`）；只有一条候选时该错误原样呈现，不会反复重试。
- **等待有上限**：一次请求里所有失败拨号与等待合计最多 35s，之后返回 `ENOROUTE` 并列出每个候选
  的失败原因；上限低于上游 60s 的响应头超时，所以你看到的是插件的诊断而不是一个裸超时。
- **只影响本插件的上游流量**：loopback 端点、宿主与其它插件都不受影响；不改系统代理、
  不改 hosts、不改 DNS、不需要 TUN。

### 设置与诊断

- 插件设置页（manifest `contributes.settings`）：**上游代理**——`auto`（留空）/
  `off`（直连）/ 具体地址。也可在任何时候用回环端点改：

  ```bash
  curl http://127.0.0.1:41860/healthz          # 端口、目录状态、路线（proxiesOnly/planned/active/counters）、错误
  curl http://127.0.0.1:41860/proxy            # 候选清单 + 每个候选的实时握手结果
  curl -X POST -d '{"url":"http://127.0.0.1:7890"}' http://127.0.0.1:41860/proxy
  curl -X POST -d '{"url":"off"}'              http://127.0.0.1:41860/proxy   # 强制直连
  curl -X POST -d '{"url":"auto"}'             http://127.0.0.1:41860/proxy   # 恢复自动
  ```

- 手工填的地址只排在第一位：它连不上时仍会按 auto 顺序试后面的候选（日志写明每次失败的原因），
  全失败才判死并重新解析。
- 有些网络里直连会直接超时或证书错误（SNI/IP 层干扰），但有代理候选时根本不会尝试直连——
  `ENOROUTE` / 502 的错误文本会写明是哪个候选、以什么原因失败（并提示可以填 `off` 强制直连）。
- 命令「显示状态」报告**下一次请求会走的路线**（`/healthz` 的 `route.planned`；与上一次实际
  走的路线不同时会附带「上次走 xxx」），以及最后一次错误的原因（不再是 `fetch failed`）。

## 组件项

| 组建 | 内容 |
|---|---|
| `contributes.providers` | ① `opencode-free`（`chat_completions`，只放协议目录标记为 chat 的免费模型）；② 若发现 Responses 模型则追加 `opencode-free-responses`——同一回环端点、每种线上协议各一个声明（一个 provider 只绑一种协议） |
| `contributes.services` | `zen-proxy`——loopback 代理（`/healthz`、`/proxy`、`/v1/models`、`/v1/chat/completions`、`/v1/responses`） |
| `contributes.settings` | `proxyUrl`——上游代理（auto / off / 具体地址） |
| `contributes.commands` | 「刷新模型目录」「显示状态」两个命令（toast 报告目录状态、当前上游与是否需要重载） |

每个模型声明携带 models.dev 的真实元数据：`contextWindow` / `maxTokens` /
**`supportsImages`**（由 `modalities.input` 是否含 `image` 决定）、
**`thinkingLevels`**（由 `reasoning_options` 的 effort 阶梯生成）——宿主据此生成
每个模型的思考菜单。

协议分流来自 OpenCode 模型目录与文档端点表，而不是名称前缀猜测。标记为
`responses` 的免费模型会进入独立 provider；loopback 对该 lane 强制 `stream: true`
并补上同一套门禁工具（**扁平** Responses 形状 `{type,name,description,parameters}`，
不是 chat 的嵌套形状），其余原样透传到 Zen 自己的 `/v1/responses`（关联头按 `input`
字段派生，与 chat 的 `messages` 对同一对话得到同一 `ses_`）。

> ⚠️ 这条 lane 的模型有**地区限制**：中国大陆出口会得到
> `403 RegionError: This model is not available in your country`，必须走非大陆出口（也就是
> 上文「上游代理」里那条代理路线）。有代理候选时插件**不会**直连，所以只要本机代理通就不会
> 撞上它；换一个出口地区可用的节点同样有效。chat 通道的免费模型不受此限。

`jev-*`（仅 `/systemone`）仍不声明。

目录**自动跟踪**：catalog 每次真实变化（含 5 分钟定时刷新）触发 onChange → 立即
改写 manifest → 一次重载后即静默收敛（启动从磁盘播种，同步是 no-op，不会循环）。
**两条清单更新链共用同一份数据**：chat provider 与 responses provider 都由这一次
目录刷新重写（同一 `syncDeclaration` 里一并落盘）；`jev-*` 只有 `/systemone` 通道、
本插件不声明，因此不参与任何一条链。

## 工作原理（请求链路全部在 `lib/zen.js` + `lib/transport.js`）

- **CLI 一致的伪装头**——`user-agent: opencode/1.18.31 (…)`、`x-opencode-client: cli`，
  会话/请求/项目三族关联头；session id 为 OpenCode 规范形状 `ses_+12hex+14base62`，
  且那 12 位十六进制必须是官方**倒序时间戳**编码（低 12 位落在 `0xFC0–0xFFF`，正则
  `^[0-9a-f]{9}f[c-f][0-9a-f]$`）。时间部分按对话记忆化铸造为真实倒序时钟，
  同一对话的重试与后续轮次继续复用同一个会话。
- **免费通道请求形状（两条 lane 都要；已按上游当前规则对齐）**——
  匿名免费流量走 `https://opencode.ai/inference`（`/zen/*` 现在对无密钥请求一律
  `403 FreeTierError`），而且上游会逐项核对"你是不是官方客户端"：
  - 请求体必须流式；
  - tools 里必须有**官方定义**的 `shell`、`edit`、`glob`、`grep`、`read`（描述与参数
    schema 逐字节一致，`lib/opencode-tools.json` 就是原样内嵌的那一份）；空壳桩会被拒；
    旧名 `bash`（客户端 2026-07 已改名 `shell`）会被直接丢掉——留着它整条请求必 403；
  - 头必须同时带 `x-opencode-session` 与 `x-opencode-session-id`，**不能**带
    `x-opencode-request`，`x-opencode-project` 必须是非规范形态的 40 位十六进制；
  - `Authorization: Bearer public` 保留（删掉或大小写写错都会被拒）。
  chat 通道：纯对话补 `tool_choice: "none"`；responses 通道：工具用扁平形状，且**不写
  `tool_choice`**（该通道只接受 `"auto"`，写 `"none"` 会被 `400 only "auto" is supported`
  拒绝）。宿主自己的工具（`Read`/`Bash`…）原样透传——上游不认这些名字；门禁再变时，
  按同一思路重测（对比 `/inference` 与 `/zen`，再逐项开关头/工具/会话 id），不要猜。
- **思考档位归一**——档位由宿主写（宿主读取声明的 `thinkingLevels` 生成菜单并写入
  `reasoning_effort`）。未选择时完全省略该字段；只有显式 `off`/`none` 才写
  `"none"`；合法档位原样透传，非法值不注入。
- **流式与非流式响应**——`stream: true` 时按完整 SSE 帧解析，工具调用分片先缓冲再
  重写；正常终止原样结束，文本已输出但上游提前断开时补截断提示，其余异常返回明确错误。
  `stream: false` 时用同一协议解析器聚合成完整 JSON。
- **连接层**（`lib/transport.js` + `lib/proxy.js`）——代理隧道 / 直连 / 公共 DNS 兜底，
  见上文「上游代理」。
- 未移植（有意为之）：IP 池/代理轮换子系统（配额规避）、legacy Go sidecar。

> 匿名通道按 **IP** 限速，是 OpenCode 提供的免费入口，请合理使用；429/403 错误会原样呈现。

## 开发

1. 插件页 **Load development plugin** 指向本目录（含 `manifest.json` 的那一层，即仓库根目录）。
2. **权限已从 `agent.extension` 换为 `provider.register` + `background.service`，
   必须在插件页显式重载并重新授权**（权限变化不会由热重载放大）。
   代理能力**没有新增任何权限**：隧道用 `node:net`/`node:tls` 自己实现，
   系统代理经 `reg.exe` 读取（读不到就退化为端口探测，不影响可用性）。
3. 重载后回到聊天窗：模型选择器应出现 **OpenCode免费模型** 分组及免费模型，
   **直接像内置模型一样选择对话**（无需任何命令切换）。
4. 目录刷新导致模型列表变化时，运行命令「刷新模型目录」或查看「显示状态」，
   toast 会提示“请重载一次插件”。
5. 诊断：`curl http://127.0.0.1:41860/healthz`（目录状态、端口、**当前上游路线**、错误
   计数）与 `curl http://127.0.0.1:41860/proxy`（候选与握手结果）。
6. 校验与打包（PI-Desktop 内置工具，**不需要 pnpm**）：

| 步骤 | 工具 | 产物 |
|---|---|---|
| 校验 | `PluginCheck` | 按安装器同款规则报错/警告 |
| 打包 | `PluginPack` | `dist/*.piplug`（store-only zip；`.git`/`node_modules`/`dist` 自动排除，<2000 文件、<50 MB、无符号链接） |
| 安装 | 插件页 → 头部溢出菜单 → **「安装插件包」** | 选中 `.piplug` 文件即装（与「加载开发插件」的目录方式无关） |

### 权限说明

| 权限 | 用途 |
|---|---|
| `provider.register` | 把此插件声明的服务与模型添加到设置的服务列表（模型选择器可见）；接口地址与模型由插件提供，**密钥留在 PI-Desktop 中——而本插件声明 `authKind: none`，连密钥都不需要** |
| `background.service` | 常驻回环端点，承接宿主发来的对话请求并转发上游 |

插件进程**会**发起网络请求（上游 `opencode.ai`、必要时经本机代理，以及元数据
`models.dev`），为保留 SSE 流式而使用 `node:https` 自建连接；除此之外无遥测、无第三方
服务器、无磁盘凭据。

## 致谢

- [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（MIT，© FishBottle7），没有它我就不会想到可以这么弄。
- [pi-commandcode-desktop](https://github.com/eric8bit/pi-commandcode-desktop)（MIT），provider能力是参考它实现的。
- [opencode2api](https://github.com/jasonxu114514/opencode2api)，上游匿名通道实现的源头，配享太庙；其"镜像官方客户端指纹"的修复（端点、会话 id 编码、头集合、官方工具定义）是当前门禁实现的直接依据，`lib/opencode-tools.json` 内嵌的定义即取自其镜像的官方客户端定义（描述与参数 schema 逐字节保留）。
- [OpenCode](https://opencode.ai)，免费匿名 Zen 通道的提供方。
- [LinuxDO](https://linux.do/)，感谢l站各位佬的帖子给了我灵感 ~~*（虽然具体是哪些帖子已经找不到了）*~~。
