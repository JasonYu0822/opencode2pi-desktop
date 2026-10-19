---
id: "LSN-20261009-pi-desktop-provider"
kind: lesson
title: "PI-Desktop 插件 provider 的模型长度可由用户修改，思考档位存在取值缺口"
keywords: ["PI-Desktop", "ModelSelectionPanes", "contextWindowSource", "thinkingLevels", "reasoning_effort", "none", "上下文窗口", "思考档位", "插件 provider"]
status: active
created: 2026-10-09T15:24:32+08:00
updated: 2026-10-09T15:24:32+08:00
batchRef: da35132c
---

PI-Desktop 里每个模型行的上下文窗口与最大输出两个数字可以编辑：默认跟随公布数值，对应 contextWindowSource 取值 catalog，用户编辑后取值改为 user，实现在 apps/desktop/src/components/settings/ModelSelectionPanes.tsx。可以修改的只是 PI-Desktop 据以规划的长度，真实上限仍由服务端决定。
思考档位的完整取值为 off/minimal/low/medium/high/xhigh/max，其中 off 表示不发送 reasoning_effort 参数，而 Cline 表示不思考的取值是 none、由客户端显式发送，两者无法互换；插件 manifest 的 thinkingLevels 无法声明 none，因此只有开关的模型只能不声明档位。
