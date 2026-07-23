# Debug: proxy pool only five

- Session: `proxy-pool-five`
- Status: `[OPEN]`
- Symptom: 线上页面代理池仅显示 5 条。

## Hypotheses

1. 镜像内置代理源只剩少量记录。
2. 补充流程覆盖原始代理源，导致来源持续缩减。
3. xAI 检测条件过严，大部分代理被淘汰。
4. 容器重建覆盖历史代理池数据。

## Evidence log

- 服务器运行镜像：`zhoushu1/relay-scout:9.0`。
- 镜像内 `/app/generated_socks5.txt` 只有 5 行。
- 镜像内代理池：active=5、eliminated=205。
- 自动补充原实现依赖不存在的 `proxy-scraper/output/all_proxies.json`，且早退时未释放 `isRefilling`。
- 复检原实现会用最多 10 条代理覆盖 `generated_socks5.txt`，导致代理源持续缩减。
- 修复后补充任务成功读取并检测 205 条淘汰代理，`lastRefill` 已更新，但 active 仍为 5，说明这 205 条当前均未通过连通性检测。
- 当前缺少持续获取新代理的真实抓取源，因此无法仅靠旧的失效代理恢复到 100 条。
