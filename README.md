# Relay Scout

一个智能 SOCKS5 代理池管理系统，支持自动抓取、质量检测、智能维护和 API 访问。

## 当前版本

**v1.0**

本版本提供智能代理池维护、单代理提取 API、地区与质量筛选、综合质量概览，以及 GitHub Actions 自动构建并发布 Docker 镜像。

### v1.0 更新说明

- 新增代理池综合质量评分及好/中/差筛选。
- 新增住宅 IP 严格判定；只有已确认住宅、快速且稳定的代理才归类为“好”。
- API 每次请求随机返回一个 SOCKS5 代理。
- API 链接自动使用当前部署服务器地址。
- 自动复检失效代理、连续失败淘汰及低于阈值自动补充。
- GitHub Actions 在推送到 `main` 或 `master` 后自动构建镜像。
- 同一个镜像自动推送 `1.0` 和 `latest` 两个标签。
- Docker Hub 凭据仅从 GitHub Secrets 读取，本地不执行登录、构建或推送。

完整版本记录见 [CHANGELOG.md](./CHANGELOG.md)。

## ✨ 特性

- 🚀 **智能池管理** - 自动维护 100 条可用代理，淘汰失效，补充新代理
- 🔍 **质量检测** - 连通性检测 + xAI 实际访问测试
- 📡 **API 访问** - 每次请求返回一个随机可用代理
- 🌍 **地区筛选** - 支持全部地区/国内/国外代理
- 🎨 **极简界面** - 清晰直观的操作界面
- 🔒 **本地运行** - 所有数据保存在本地，不会上传

## 🚀 快速开始

### 安装依赖

```bash
npm install
```

### 启动服务

```bash
node server.cjs
```

服务启动后访问：http://127.0.0.1:5778

## 📖 功能说明

### 1. 提取 SOCKS5

点击右上角 **"提取 SOCKS5"** 按钮，系统会：
1. 从代理源抓取原始代理
2. 提取 SOCKS5 格式链接
3. 自动进行连通性检测
4. 进行 xAI 质量测试
5. 合格代理自动入池

### 2. 获取代理

点击 **"获取一个代理"** 按钮，从池中随机获取一个可用代理。

- **复制** - 复制代理链接到剪贴板
- **换一个** - 重新获取另一个代理

### 3. 池状态

- **活跃池** - 当前可用代理数量（目标：100 条）
- **待复检** - 等待复检的代理数量
- **已淘汰** - 已淘汰的失效代理数量
- **自动维护** - 每 5 分钟自动复检 10 条代理

### 4. API 链接

页面底部提供 API 链接，可用于集成到其他工具：

```
http://127.0.0.1:5778/api/pool?region=all
```

- 支持地区筛选（all/domestic/foreign）
- 每次请求返回一个随机代理
- 点击"测试 API"验证随机性

## 📡 API 接口

### 获取单个代理

```bash
GET /api/pool?region=all
```

**参数：**
- `region` - 地区筛选（可选）
  - `all` - 全部地区（默认）
  - `domestic` - 国内代理
  - `foreign` - 国外代理

**响应：**
```json
{
  "success": true,
  "region": "all",
  "count": 1,
  "proxy": {
    "proxy": "socks5://206.123.156.238:12110",
    "ip": "47.86.33.52",
    "latency": 411.95,
    "quality": "connected",
    "country": "Unknown",
    "successRate": 100,
    "failures": 0
  },
  "poolSize": 187
}
```

### 获取池状态

```bash
GET /api/pool/stats
```

**响应：**
```json
{
  "success": true,
  "active": 192,
  "pending": 0,
  "eliminated": 18,
  "nextRecheck": "2026-07-22T08:18:10.940Z",
  "lastRefill": "2026-07-22T15:00:39.6070228+08:00",
  "autoRefill": true,
  "autoRecheck": true
}
```

### 提取 SOCKS5

```bash
POST /api/steps/extract
Content-Type: application/json

{
  "region": "all"
}
```

### 复检池代理

```bash
POST /api/pool/recheck
```

## 💡 使用示例

### JavaScript/Node.js

```javascript
// 获取代理
const response = await fetch('http://127.0.0.1:5778/api/pool');
const data = await response.json();
const proxy = data.proxy.proxy; // socks5://...

// 使用代理（示例）
const http = require('http');
const HttpProxyAgent = require('http-proxy-agent');

const agent = new HttpProxyAgent(proxy);
http.get('http://example.com', { agent }, (res) => {
  // ...
});
```

### Python

```python
import requests

# 获取代理
response = requests.get('http://127.0.0.1:5778/api/pool')
data = response.json()
proxy = data['proxy']['proxy']  # socks5://...

# 使用代理
proxies = {
    'http': proxy,
    'https': proxy,
}
response = requests.get('http://example.com', proxies=proxies)
```

### cURL

```bash
# 获取代理
curl http://127.0.0.1:5778/api/pool

# 获取国内代理
curl "http://127.0.0.1:5778/api/pool?region=domestic"

# 查看池状态
curl http://127.0.0.1:5778/api/pool/stats
```

## 🔧 配置说明

### 池管理策略

- **目标大小** - 保持 100 条可用代理
- **自动补充** - 低于 80 条时自动补充到 100 条
- **自动复检** - 每 5 分钟复检 10 条代理
- **淘汰机制** - 连续失败 2 次自动淘汰

### 检测标准

- **连通性** - SOCKS5 握手成功
- **出口 IP** - 能获取到出口 IP
- **延迟** - 平均延迟 < 800ms
- **成功率** - Cloudflare 成功率 ≥ 80%
- **xAI 可用性** - 能打开 xAI 注册页面

## 📁 项目结构

```
.
├── server.cjs              # 主服务器
├── src/
│   └── pages/
│       └── Home.tsx        # 前端页面
├── proxy-scraper/          # 代理抓取器
│   └── output/
│       └── all_proxies.json
├── generated_socks5.txt    # 提取的 SOCKS5 链接
├── socks5-pool.json        # 池数据
└── README.md               # 本文档
```

## 🛠️ 开发

### 技术栈

- **前端** - React + TypeScript + Vite
- **后端** - Node.js (原生 HTTP 服务器)
- **样式** - 内联样式（无 CSS 框架）

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器（前端热重载 + 后端 API）
npm run dev

# 构建生产版本
npm run build
```

## 🐳 Docker 部署

### GitHub Actions 自动构建

推送到 `main` 或 `master` 分支后，GitHub Actions 会自动构建一次镜像，并将同一个镜像推送为以下两个标签：

```text
zhoushu1/relay-scout:1.0
zhoushu1/relay-scout:latest
```

构建、登录和推送全部在 GitHub Actions 中完成，本地不需要也不应执行 `docker login`、`docker build` 或 `docker push`。

**需要配置 GitHub Secrets：**
- `DOCKER_HUB_USERNAME` - Docker Hub 用户名
- `DOCKER_HUB_TOKEN` - Docker Hub Access Token

工作流不会硬编码 Docker Hub 账号，实际镜像名称由 `DOCKER_HUB_USERNAME` 组合生成；上面的 `zhoushu1` 仅作为部署命令示例。

### 宝塔面板部署

#### 1. 安全设置

在宝塔面板中放行 TCP 端口 **8445**：
1. 登录宝塔面板
2. 进入 **安全** 页面
3. 添加规则：放行 TCP 8445 端口

#### 2. 拉取镜像

```bash
docker pull zhoushu1/relay-scout:latest
```

#### 3. 运行容器

```bash
docker run -d \
  --name relay-scout \
  -p 8445:8445 \
  -v /opt/relay-scout/data:/app/proxy-scraper/output \
  --restart always \
  zhoushu1/relay-scout:latest
```

**参数说明：**
- `-d` - 后台运行
- `--name` - 容器名称
- `-p 8445:8445` - 端口映射（宿主机:容器）
- `-v` - 数据卷挂载（持久化代理数据）
- `--restart always` - 自动重启

#### 4. 访问服务

浏览器访问：`http://你的服务器IP:8445`

#### 5. 常用命令

```bash
# 查看日志
docker logs -f relay-scout

# 查看实时日志（最后 100 行）
docker logs --tail 100 -f relay-scout

# 停止容器
docker stop relay-scout

# 启动容器
docker start relay-scout

# 重启容器
docker restart relay-scout

# 查看容器状态
docker ps -a | grep relay-scout

# 更新镜像
docker pull zhoushu1/relay-scout:latest
docker stop relay-scout
docker rm relay-scout
# 重新运行容器（见上方运行命令）
```

#### 6. 更新部署

```bash
# 更新镜像
docker pull zhoushu1/relay-scout:latest

# 停止并删除旧容器
docker stop relay-scout
docker rm relay-scout

# 重新运行（数据卷保留，不会丢失）
docker run -d \
  --name relay-scout \
  -p 8445:8445 \
  -v /opt/relay-scout/data:/app/proxy-scraper/output \
  --restart always \
  zhoushu1/relay-scout:latest
```

### Docker Compose 部署

创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  relay-scout:
    image: zhoushu1/relay-scout:latest
    container_name: relay-scout
    ports:
      - "8445:8445"
    volumes:
      - ./data:/app/proxy-scraper/output
    restart: always
    environment:
      - PORT=8445
      - NODE_ENV=production
```

启动：
```bash
docker-compose up -d
```

查看日志：
```bash
docker-compose logs -f
```

## ⚠️ 注意事项

1. **数据本地化** - 所有代理数据保存在本地，不会上传到云端
2. **代理质量** - 免费公开代理质量参差不齐，建议使用付费住宅代理
3. **法律合规** - 请确保使用代理符合当地法律法规
4. **资源消耗** - 自动复检会消耗一定网络资源，可在设置中调整频率

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

**Relay Scout** - SOCKS5 智能代理池管理系统
