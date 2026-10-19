---
id: "LSN-20261009-clinepass-cline"
kind: lesson
title: "ClinePass 的模型清单与参数以 Cline 官方目录为准"
keywords: ["cline-pass", "ClinePass", "catalog.generated.ts", "cline-recommended.generated.ts", "reasoningOptions", "reasoning-options.ts", "models.dev", "模型参数"]
status: active
created: 2026-10-09T15:24:32+08:00
updated: 2026-10-09T15:24:32+08:00
batchRef: da35132c
---

需要 cline-pass 模型的清单、上下文长度、输出上限、图片能力与思考档位时，读取 cline/cline 仓库的 sdk/packages/llms/src/catalog/catalog.generated.ts 里的 cline-pass 块（提供 contextWindow、maxInputTokens、maxTokens、capabilities、reasoningOptions），以及 sdk/packages/llms/src/catalog/cline-recommended.generated.ts 里的 clinePass 列表（当前为 14 个 slug）。
档位词表与取值限制在 sdk/packages/shared/src/llms/reasoning-options.ts：完全取值为 none/minimal/low/medium/high/xhigh/max，发给接口的 reasoning_effort 排除 none。
以 models.dev 快照作为来源时，上下文长度、输出上限与思考档位这些字段会与官方目录不一致，写入插件 manifest 之前需要逐字段对照官方目录复核。
