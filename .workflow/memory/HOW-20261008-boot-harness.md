---
id: "HOW-20261008-boot-harness"
kind: procedure
title: "插件改动的验证与打包流程（含 boot-harness 副本陷阱）"
keywords: ["验证", "打包", "PluginCheck", "PluginPack", "boot-harness", "plugin-copy", "真机验证", "no-direct-harness", "提交"]
status: active
created: 2026-10-08
batchRef: 61a04c51
---

改完代码的固定动作：
1. 语法：`node --check main.js` + `node --check lib\*.js`。
2. 离线 harness（都在 $env:PI_SCRATCH_DIR）：`no-direct-harness.js`（路由 9 个用例：抖动重拨不直连 / 代理全挂时目标服务器零流量 / ENOROUTE / 单候选地区 403 原样返回 / 多候选地区换路线 / 记住代理 / off 强制直连 / abort 立即生效 / 无代理时直连可用）；`proxy-fix-harness.js` + `socks5-server.js`（SOCKS5 无认证/RFC1929/裸 % 密码、已 abort 的 signal、死候选+活代理，只判「不崩」）。
3. 真机：`transport-harness.js`（候选解析 + 隧道握手 + /zen/v1/models + chat SSE + models.dev，走本机 7890）、`boot-harness.js`（stub `pi` 起真插件，端口 41999，跑 chat / responses / 命令 / 坏代理回退）、`responses-e2e2.js`（responses lane，auto 与 off 对照）。
4. 校验与打包只能用内置工具 PluginCheck / PluginPack（workdir = 仓库根；产物 dist/com.opencode2pi-<version>.piplug）。
5. 提交：`git commit -F <msgfile>`（仓库 core.autocrlf=true；dist/ 与 *.piplug 已被 .gitignore 排除）。

⚠️ 陷阱：boot-harness.js 把仓库复制到 $env:PI_SCRATCH_DIR\plugin-copy 之后**不会重新拷贝**。改完代码必须先删除并重拷 plugin-copy，否则你验证的是旧代码（本会话因此一度误判「改动没生效」）。
