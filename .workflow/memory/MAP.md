---
id: "MAP"
kind: map
title: "opencode2pi 插件地图：文件职责与宿主集成关键路径"
keywords: ["项目结构", "地图", "main.js", "transport.js", "proxy.js", "zen.js", "manifest", "host-core", "session-launch", "回环端点", "pi.sqlite"]
status: active
created: 2026-10-08
batchRef: 2088b909
---

仓库 D:\Codes\opencode2pi-desktop（本会话项目；远端 https://github.com/banned104/opencode2pi-desktop）。

插件侧：
- main.js —— 回环端点 127.0.0.1:41860/41861/41862（GET /healthz、POST /v1/chat/completions、POST /v1/responses、GET|POST /proxy、GET /v1/models）、命令 opencode.status / opencode.refresh、插件设置 proxyUrl、UPSTREAM_HEADER_TIMEOUT_MS=60s、把 ENOROUTE 等错误变成 502 文本。
- lib/proxy.js —— 候选解析（插件设置 -> env -> Windows 系统代理 reg.exe -> 常见端口探测）、http CONNECT / SOCKS5 隧道（openTunnel / checkCandidate）、DIRECT_SENTINELS / AUTO_SENTINELS / parseProxyUrl、forcedDirect。
- lib/transport.js —— 路由与重试（dialList / dialPlan / walk / orderCandidates、heldProxies、proxyStrikes + 60s 冷却）；state() 暴露 candidates / proxiesOnly / planned / active / notes / failures / lastError / counters{requests,retries,waits,dnsRetries,resolutions,regionRetries}。
- lib/zen.js —— 伪装头（user-agent opencode/1.18.31、x-opencode-client: cli、ses_+12hex+14base62）、免费门禁（tools 必含 bash+read；responses 用扁平工具且不写 tool_choice）、模型目录 S1(zen)∩S2(models.dev) + 静态兜底 + catalog-cache.json。
- manifest.json —— contributes.providers 两个 provider：opencode-free（chat_completions）与 opencode-free-responses（responses），authKind 均为 none，vendorKey 均为 opencode，baseUrl 均指向回环端点；contributes.settings = proxyUrl。

宿主侧（D:\Codes\PI-Desktop，只读参考）：
- crates/host-core/src/plugins/providers.rs —— manifest -> providers 行的 sync_plugin_providers / reconcile_plugin / reconcile_all。
- crates/host-core/src/providers/repository.rs —— 插件行不可编辑（PROVIDER_OWNED_BY_PLUGIN）。
- apps/desktop/electron/main/runtime/session-launch.ts —— 委派模型目录（availableForSubagents）与子代理 pin 解析。
- ~/.pi-desktop/pi.sqlite —— providers 表（owner_plugin_id、config_json.models）；日志 ~/.pi-desktop/logs/app/{session,plugin}.log。
