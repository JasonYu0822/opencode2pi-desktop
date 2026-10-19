---
id: "LSN-20261008-provider"
kind: lesson
title: "卸载重装插件后 provider 行会丢失，会话静默降级到默认模型"
keywords: ["installFromPath", "installFromPackage", "reconcile_plugin", "reconcile_all", "provider 行丢失", "静默降级", "卸载重装", "deepseek-flash"]
status: active
created: 2026-10-08
batchRef: 2088b909
---

症状：插件看着已装好，但日志里没有真实 upstream 调用；session 存的是 plugin:com.opencode2pi:opencode-free，而该 turn 的 prompt.accepted 记录的是另一个 provider/model（实测 a6576d87…/deepseek-flash）——用户感知为「我的模型被换掉了」。

原因：宿主 crates/host-core/src/rpc/mod.rs 的 plugins.installFromPath / installFromPackage（约 4465 / 4495）在 enable 分支不调用 plugins::reconcile_plugin，所以 providers 表里 owner_plugin_id 非空的行为空（`SELECT id FROM providers WHERE owner_plugin_id IS NOT NULL` 为空），模型选择器/provider 查不到插件的两条 provider 行。

规避/恢复：(a) 重启宿主——crates/host-core/src/state.rs:119 的 reconcile_all 会把行补回来；(b) 插件禁用再启用——rpc/mod.rs:4387 会跑 reconcile_plugin；(c) 宿主补丁：在 install 的 enable 分支补一次 reconcile。

判定手法：用 node:sqlite 只读查 ~/.pi-desktop/pi.sqlite 的 providers（id / owner_plugin_id / config_json.models）。
