# OpenCode免费模型

**OpenCode Zen 的匿名免费模型，作为正式 provider 出现在 PI-Desktop 的模型选择器里。**
无需 API Key、无需注册。

*本插件完全由AI生成，不保证完全可用。*有问题欢迎提交issue，*~~我会拿AI修的~~*。

## 架构（v0.4）

宿主在**生成插件进程之前**就读取 manifest 的 `contributes.providers`，聊天窗的模型
选择器只枚举这个宿主 provider 列表——运行时 `registerProvider` 的模型（agent 扩展）
进不了选择器。因此本插件与 commandcode 插件同构：

```
聊天窗模型选择器
   └─「OpenCode免费模型」组（manifest contributes.providers，静态声明+自改写）
        └─ baseUrl http://127.0.0.1:41860/v1 ──► 插件后台服务 zen-proxy（loopback）
                                                     │  附加伪装头 + 体门禁 + Bearer public
                                                     └─► https://opencode.ai/zen/v1/chat/completions (SSE 逐块透传)
```

- **`provider.register`**——把 manifest 声明的服务与模型加进设置的服务列表（即模型
  选择器的数据源）。`authKind: "none"`：宿主不发 Authorization、视为就绪、**PI-Desktop
  里不存任何密钥**；匿名密钥 `public` 由 loopback 层自己附加。
- **`background.service`**——常驻回环端点 `zen-proxy`（onLoad 后由宿主启动，仅绑定
  127.0.0.1，拒绝非回环 Host/Origin）。宿主把请求发到 baseUrl，本进程用**原生 fetch**
  转发上游并逐块透传 SSE（不能用宿主的 `net.fetch` 桥——它会把响应缓冲成整段文本，
  流式就没了）。之所以不申请 `net.fetch` 权限，原因即此。
- **模型目录自改写**——S1 实时 `GET /zen/v1/models`（带伪装头）∩ S2 models.dev
  （`cost 0/0` 且未废弃），5 分钟刷新；列表变化时改写自己的 `manifest.json`，
  **在插件页重载一次插件**生效（宿主只在加载时读 manifest，与 commandcode 相同）。
- **磁盘缓存**（`lib/zen.js` ModelCatalog）——S1 名单 + S2 元数据每次**真实变化**时
  原子写入宿主数据目录 `~/.pi-desktop/plugins/data/local.opencode/catalog-cache.json`
  （`pi.plugin.getDataPath()`，拿不到则退回插件目录；7 天有效，只在数据真实变化时写——
  既不每 5 分钟落盘，也不在插件包目录里写，开发插件 watcher 永远看不到缓存文件）。
  启动先读盘播种再联网：离线/抖动启动直接沿用上次的
  完整清单与元数据，不会退化成静态兜底去改写 manifest（也就没有"列表缩水 + 思考
  档消失 + 无谓重载"）。缓存缺失/过期/损坏时退回编译期静态清单（当前 = 实测在用的
  8 个 chat + 2 个 responses），首次离线加载同样可用。

## 组件项

| 组建 | 内容 |
|---|---|
| `contributes.providers` | ① `opencode-free`（`chat_completions`，8 个聊天通道免费模型）＋ ② `opencode-free-responses`（`responses`，Muse Spark 系列 2 个）——同一回环端点、每种线上协议各一个声明（commandcode 规则：一个 provider 只绑一种协议） |
| `contributes.services` | `zen-proxy`——loopback 代理（`/healthz`、`/v1/models`、`/v1/chat/completions`、`/v1/responses`） |
| `contributes.commands` | 「刷新模型目录」「显示状态」两个命令（toast 报告目录状态与是否需要重载） |

每个模型声明携带 models.dev 的真实元数据：`contextWindow` / `maxTokens` /
**`supportsImages`**（`modalities.input` 含 `image`——mimo 双子、space-bunny、muse
为 true，其余 false）、**`thinkingLevels`**（`reasoning_options` 的 effort 阶梯；
space-bunny 是 low→max，muse 是 minimal→xhigh）——宿主据此生成每个模型的思考菜单。

`muse-spark-*` 在 Zen 上**只答 `/v1/responses`**（OpenAI Responses 线格式），放进
chat provider 就是选择器里的坏项，因此单独成列；loopback 对该 lane 只强制
`stream: true`，其余原样透传到 Zen 自己的 `/v1/responses`（关联头按 `input` 字段
派生，与 chat 的 `messages` 对同一对话得到同一 `ses_`）。`jev-*`（仅 `/systemone`）
仍不声明。

目录**自动跟踪**：catalog 每次真实变化（含 5 分钟定时刷新）触发 onChange → 立即
改写 manifest → 一次重载后即静默收敛（启动从磁盘播种，同步是 no-op，不会循环）。
**两条清单更新链共用同一份数据**：chat provider 与 responses provider 都由这一次
目录刷新重写（同一 `syncDeclaration` 里一并落盘）；`jev-*` 只有 `/systemone` 通道、
本插件不声明，因此不参与任何一条链。

## 工作原理（请求链路全部在 `lib/zen.js`）

- **CLI 一致的伪装头**——`user-agent: opencode/1.18.31 (…)`、`x-opencode-client: cli`，
  会话/请求/项目三族关联头；session id 为 OpenCode 规范形状 `ses_+12hex+14base62`
  （免费通道 403 门禁的形状校验），按**对话首条用户消息**派生、同一对话稳定。
- **免费通道体门禁**——请求体必须流式，且 tools 含名为 `bash`、`read` 的占位工具；
  纯对话时补 `tool_choice: "none"`，已有真实工具则只补齐缺失项。
- **思考档位归一**——档位由宿主写（宿主读取声明的 `thinkingLevels` 生成菜单并写入
  `reasoning_effort`），代理层把 `off`/缺失/非法值规范成 `"none"`（该通道唯一能真正
  关掉 always-think 模型的写法），合法档位原样透传。
- **SSE 逐块透传**——两端都是 openai chat completions 方言，无需重编码，流式零损耗。
- 未移植（有意为之）：IP 池/代理轮换子系统（配额规避）、legacy Go sidecar。

> 匿名通道按 **IP** 限速，是 OpenCode 提供的免费入口，请合理使用；429/403 错误会原样呈现。

## 开发

1. 插件页 **Load development plugin** 指向本目录（含 `manifest.json` 的那一层，即仓库根目录）。
2. **权限已从 `agent.extension` 换为 `provider.register` + `background.service`，
   必须在插件页显式重载并重新授权**（权限变化不会由热重载放大）。
3. 重载后回到聊天窗：模型选择器应出现 **OpenCode免费模型** 分组及免费模型，
   **直接像内置模型一样选择对话**（无需任何命令切换）。
4. 目录刷新导致模型列表变化时，运行命令「刷新模型目录」或查看「显示状态」，
   toast 会提示“请重载一次插件”。
5. 诊断：`curl http://127.0.0.1:41860/healthz`（目录状态、端口、错误计数）。
6. 校验与打包（PI-Desktop 内置工具，**不需要 pnpm**）：

| 步骤 | 工具 | 产物 |
|---|---|---|
| 校验 | `PluginCheck` | 按安装器同款规则报错/警告 |
| 打包 | `PluginPack` | `dist/local.opencode-0.4.0.piplug`（store-only zip；`.git`/`node_modules`/`dist` 自动排除，<2000 文件、<50 MB、无符号链接） |
| 安装 | 插件页 → 头部溢出菜单 → **「安装插件包」** | 选中 `.piplug` 文件即装（与「加载开发插件」的目录方式无关） |

### 权限说明

| 权限 | 用途 |
|---|---|
| `provider.register` | 把此插件声明的服务与模型添加到设置的服务列表（模型选择器可见）；接口地址与模型由插件提供，**密钥留在 PI-Desktop 中——而本插件声明 `authKind: none`，连密钥都不需要** |
| `background.service` | 常驻回环端点，承接宿主发来的对话请求并转发上游 |

插件进程**会**发起网络请求（上游 `opencode.ai` 与元数据 `models.dev`，经原生 fetch，
为保留 SSE 流式），除此之外无遥测、无第三方服务器、无磁盘凭据。

## 致谢

- [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（MIT，© FishBottle7），没有它我就不会想到可以这么弄。
- [pi-commandcode-desktop](https://github.com/eric8bit/pi-commandcode-desktop)（MIT），provider能力是参考它实现的。
- [opencode2api](https://github.com/jasonxu114514/opencode2api)，上游匿名通道实现的源头，配享太庙。
- [OpenCode](https://opencode.ai)，免费匿名 Zen 通道的提供方。
