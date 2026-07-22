# 更新日志

本文档记录 Relay Scout SOCKS5 智能代理池的重要版本变化。

格式参考 Keep a Changelog，并使用语义化版本号。

## [1.0] - 2026-07-22

### 新增

- 新增 SOCKS5 智能代理池及固定单代理提取 API。
- 新增 `region=all|domestic|foreign` 地区筛选。
- 新增 `grade=all|good|medium|poor` 综合质量筛选。
- 新增综合质量分数、平均延迟、近一轮成功率、稳定代理比例和 xAI 可用数量展示。
- 新增住宅 IP 严格分类；“好”代理必须已确认住宅、成功率高、延迟低且出口稳定。
- 新增池自动复检、连续失败淘汰及低于阈值自动补充。
- 新增页面 API 链接复制、当前部署地址自动识别和连续请求测试。
- 新增 Docker 多阶段构建和宝塔 TCP 8445 部署支持。
- 新增 GitHub Actions 自动发布 Docker Hub 镜像。

### 变更

- GitHub Actions 在推送到 `main` 或 `master` 后自动执行。
- 同一次构建产生的同一个镜像同时推送为 `1.0` 和 `latest`。
- Docker Hub 用户名和 Token 仅从 `DOCKER_HUB_USERNAME`、`DOCKER_HUB_TOKEN` GitHub Secrets 读取。
- 容器服务端口统一为 `0.0.0.0:8445`，部署端口映射为 `8445:8445`。
- 未确认住宅属性的代理不再错误归类为优质住宅代理。

### 安全

- `.dockerignore` 保持排除 `.env` 和 `.env.*`，防止环境配置进入 Docker 构建上下文。
- 工作流不硬编码 Docker Hub 登录账号或 Token。
- 本地无需执行 Docker 登录、构建或推送操作。

### 部署更新

已有容器可通过以下命令更新到 v1.0 固定版本：

```bash
docker pull zhoushu1/relay-scout:1.0
docker stop relay-scout
docker rm relay-scout
docker run -d \
  --name relay-scout \
  -p 8445:8445 \
  -v /opt/relay-scout/data:/app/proxy-scraper/output \
  --restart always \
  zhoushu1/relay-scout:1.0
```

跟随最新版本可继续使用：

```bash
docker pull zhoushu1/relay-scout:latest
```
