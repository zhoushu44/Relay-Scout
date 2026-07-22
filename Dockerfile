# 多阶段构建 - 前端构建
FROM node:20-alpine AS builder

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装构建依赖
RUN npm ci

# 复制源代码
COPY . .

# 构建前端
RUN npm run build

# 生产阶段
FROM node:20-alpine

WORKDIR /app

# 安装 pm2 + Python3 及检测依赖
RUN npm install -g pm2 && apk add --no-cache python3 py3-pip
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir aiohttp aiohttp-socks PyYAML
ENV PATH="/opt/venv/bin:$PATH"

# 复制 package 文件
COPY package*.json ./

# 安装生产依赖
RUN npm ci --only=production

# 从构建阶段复制文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.cjs ./
COPY --from=builder /app/cf_quality_checker.py ./
COPY --from=builder /app/generated_socks5.txt ./
COPY --from=builder /app/socks5-pool.json ./

# 暴露端口
EXPOSE 8445

# 环境变量
ENV PORT=8445
ENV NODE_ENV=production

# 启动服务
CMD ["pm2-runtime", "server.cjs"]
