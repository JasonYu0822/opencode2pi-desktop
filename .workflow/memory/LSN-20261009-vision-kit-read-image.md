---
id: "LSN-20261009-vision-kit-read-image"
kind: lesson
title: "vision-kit「read_image」只接受工作区内路径，工作区外的图片先用通配符复制进来"
keywords: ["read_image", "vision-kit", "path escapes the plugin's root", "读图", "工作区外路径", "通配符", "中文路径", "Copy-Item"]
status: active
created: 2026-10-09T17:20:34+08:00
updated: 2026-10-09T17:20:34+08:00
batchRef: 22df4249
---

用 plugin_io_github_muzimu217_vision_kit_read_image 读图时，路径必须位于当前工作区根目录之内。传入 "C:\\Users\\Ban\\Pictures\\洛少爷\\task_xxx_0.png" 这类工作区外路径会返回 "path escapes the plugin's root"，图片无法挂载。

处理办法：先把图片复制进工作区（例如 ".\\_probe_vision.png"），用工作区相对路径调用读取，看完删除临时文件。

中文目录名会带来第二个故障：PowerShell 里直接写含中文的字面量路径，Copy-Item 报「找不到路径……因为该路径不存在」，而 Get-ChildItem 明明能列出该文件。把中文那一段换成通配符即可通过，例如 "C:\\Users\\Ban\\Pictures\\*\\task_5Dmr6XFfrLS7Um2gMPa3b6qhLS2TlXpc_0.png"。

另外，读取本身只把图片作为多模态图片块附在工具返回值里，工具不返回任何文字描述，画面内容要到下一次模型轮次才可见。
