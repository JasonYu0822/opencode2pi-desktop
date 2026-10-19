---
id: "LSN-20261008-availableforsubagents-subagent"
kind: lesson
title: "插件声明的模型拿不到 availableForSubagents，只能被 subagent 定义钉住"
keywords: ["availableForSubagents", "可供 AI 自动调度", "子代理", "Task.model", "委派", "vendorKey 歧义", "providerAlias", "~/.agents/subagents", "PROVIDER_OWNED_BY_PLUGIN"]
status: active
created: 2026-10-08
batchRef: 2088b909
---

PI-Desktop 的「可供 AI 自动调度」（ModelBinding.availableForSubagents，中文界面开关见 apps/desktop/src/components/settings/ModelSelectionPanes.tsx:983-1004）对插件声明的模型永久关闭，三条封锁：
1. manifest 声明不了：host-core 解析插件模型时把 available_for_subagents / supports_documents / native_web_search 硬编码为 None（crates/host-core/src/plugins/providers.rs:189-191）；插件只能声明 id/name/contextWindow/maxTokens/supportsImages/thinkingLevels/defaultThinkingLevel（外加未入文档的 thinkingProtocol）。
2. 用户也勾不上：唯一写 binding 的 RPC providers.update 对插件行直接 bail PROVIDER_OWNED_BY_PLUGIN（crates/host-core/src/providers/repository.rs:264-271），前端对 plugin 行连编辑入口都不渲染（apps/desktop/src/components/settings/ServiceList.tsx:79-89）。
3. 即便放开，reconcile 会整体替换 config_json.models（plugins/providers.rs:308-311 + providers/catalog.rs:260-264），宿主每次启动都跑 reconcile_all（state.rs:119），用户勾的值会被声明覆盖。

可行的委派路径（无需任何插件改动）：用户自己写 ~/.agents/subagents/<id>.md，用 frontmatter `model: <provider>/<model>` 钉住（可选 fallbackModels / thinkingLevel / maxTokens）。解析门槛只有「provider 启用 + authKind≠none 时要有 key」，我们 authKind=none 免 key（packages/agent-runtime/src/subagent-definitions.ts:475-494）。

别名坑：两个 provider 共用 vendorKey opencode，findSubagentProviderSource（同文件 395-410）只在「恰好一行匹配」时才用 vendorKey / 显示名，且 providerAlias 会把中文剥掉（OpenCode免费模型 -> opencode；OpenCode免费模型 · Responses -> opencodesponses）。所以写 `opencode/<model>` 不可靠，用显示名或精确 row id `plugin:com.opencode2pi:opencode-free/<model>`。
