# 更新日志

## custom-fix-preview - 2026-06-18

- KV 订阅结果持久化缓存：冷启动后无需重新抓取全量订阅链接，降低对 SUBAPI 转换后端的压力。
- 网页界面隐藏非关键订阅转换配置（仅保留 SUBAPI / SUBCONFIG / VERSION 可见）。
- wrangler.toml 启用 KV 命名空间绑定。
- 版本标记更新为 custom-fix-2026-06-18-kv-sub-cache。

## custom-fix - 2026-06-17

- 修复远程订阅 URL 不变但上游优选结果变化时，最终订阅缓存可能继续复用旧节点的问题。
- 为传给订阅转换后端的临时源 URL 增加内容指纹 `src`，避免外部转换后端按固定源 URL 复用旧转换结果。
- 为订阅响应增加 `X-Sub-Source-Fingerprint`，便于确认本次源内容是否发生变化。

## custom-fix - 2026-06-16

- 为多 `SUBAPI` 增加自适应后端选择策略：优先健康且更快的后端，同时在健康后端之间做轻量轮换。
- 为多 `SUBAPI` 增加错峰并发抢答，支持 `SUBAPISTAGGER` 调整后端并发间隔，以缩短慢后端拖累的等待时间。
- 在绑定 `KV` 时持久化 `SUBAPI` 健康度，减少 Worker 重启或切换 isolate 后的重新学习成本。
- 为订阅响应增加 `X-Sub-Converter` 与 `X-Sub-Converter-Strategy` 响应头，便于确认本次实际使用的转换后端。
- 在编辑页中增加 `SUBAPI STRATEGY` 展示。
- 在网页内添加 `Modified by FisheeHei` 标记。

## custom-fix - 2026-06-12

- 优化 Cloudflare Pages 部署逻辑，支持 Pages 静态资源回退。
- 将运行配置改为按请求读取，避免全局变量在多请求间串值。
- 支持多个 `SUBAPI`，可用逗号、竖线或换行分隔，转换失败时自动尝试下一个。
- 新增订阅拉取重试与超时控制：`SUBRETRY`、`SUBTIMEOUT`。
- 新增订阅转换后端超时控制：`SUBAPITIMEOUT`。
- 新增订阅结果缓存：`SUBCACHE`，并支持 `?refresh=1` 强制刷新缓存。
- 新增版本响应头 `X-Custom-Fix-Version` 和订阅缓存状态头 `X-Sub-Cache`。
- 新增 `SHOW_FAILED_SUB`，可控制是否在订阅结果中显示异常订阅占位节点。
- `/TOKEN` 编辑页增加当前变量状态、版本标记和链接数量统计。
- 删除自动同步上游仓库的 GitHub Actions workflow。
