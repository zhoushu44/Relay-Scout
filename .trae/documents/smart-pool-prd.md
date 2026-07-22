# SOCKS5 智能池需求文档

## 📋 产品概述

**目标**：提供一个固定 API 接口，返回始终可用的 SOCKS5 代理池，自动维护更新。

**核心价值**：
- 应用端只需调用一个固定 API
- 池自动淘汰失效代理
- 池自动补充新代理
- 始终保持 100 条可用代理

---

## 🎯 产品需求

### 1. 固定 API 接口

**接口定义**：
```
GET /api/pool
Query Parameters:
  - region: all | domestic | foreign (默认：all)
  - limit: 数字 (默认：1, 范围：1-500)

Response (limit=1 时):
{
  "success": true,
  "region": "all",
  "count": 1,
  "proxy": {
    "proxy": "socks5://1.2.3.4:8080",
    "quality": "connected",
    "latency": 156,
    "country": "US",
    "isResidential": true,
    "ip": "1.2.3.4",
    "successRate": 95,
    "failures": 0,
    "lastChecked": "2026-07-22T10:29:55Z",
    "createdAt": "2026-07-22T09:00:00Z"
  },
  "poolSize": 210,
  "updated": "2026-07-22T10:30:00Z"
}

Response (limit>1 时):
{
  "success": true,
  "region": "all",
  "count": 10,
  "proxies": [...],
  "poolSize": 210,
  "updated": "2026-07-22T10:30:00Z",
  "stats": {
    "active": 210,
    "pending": 0,
    "eliminated": 23
  }
}
```

**使用场景**：
- `limit=1`：每次请求 1 个代理，随机返回（推荐）
- `limit>1`：批量获取多个代理
- 建议：每次使用只请求 1 个，用完再请求下一个

---

### 2. 池自动维护

#### 2.1 池结构

```
┌─────────────────────────────────────────────┐
│  活跃池 (active_pool)                      │
│  目标：100 条                                 │
│  状态：✅ 在用                              │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│  待复检池 (pending_pool)                    │
│  目标：20 条                                  │
│  状态：⏳ 复检中                             │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│  淘汰池 (eliminated_pool)                   │
│  状态：❌ 已删除（保留历史）                  │
└─────────────────────────────────────────────┘
```

#### 2.2 自动复检

**触发条件**：每 5 分钟自动触发

**复检策略**：
- 复检数量：10 条（随机抽样）
- 复检标准：
  - SOCKS5 连通性
  - 出口 IP 存在
  - 延迟 < 3 秒
- 结果处理：
  - ✅ 成功 → 继续使用，更新 `lastChecked`
  - ❌ 失败 1 次 → 移入待复检池，`failCount = 1`
  - ❌ 失败 2 次 → 移入淘汰池，从活跃池删除

**复检 API**：
```
POST /api/pool/recheck
Body: {
  "count": 10,           // 复检数量
  "strategy": "random"   // random | oldest | worst
}
Response: {
  "success": true,
  "rechecked": 10,
  "passed": 8,
  "failed": 2,
  "eliminated": 1
}
```

#### 2.3 自动补充

**触发条件**：活跃池 < 80 条

**补充策略**：
1. 从待复检池复活（复检成功）
2. 从原始代理源提取新 SOCKS5
3. 快速连通性检测（200 并发，3 秒超时）
4. 合格代理入池（补充到 100 条）

**补充 API**：
```
POST /api/pool/refill
Body: {
  "targetSize": 100
}
Response: {
  "success": true,
  "previousSize": 78,
  "added": 22,
  "newSize": 100
}
```

#### 2.4 淘汰机制

**淘汰条件**：
- 连续 2 次复检失败
- 延迟 > 5 秒
- 出口 IP 不存在
- SOCKS5 连接失败

**淘汰后处理**：
- 移入淘汰池（保留历史记录 7 天）
- 触发自动补充
- 可选：每周复检淘汰池 1 次

---

### 3. 池状态监控

**状态 API**：
```
GET /api/pool/stats
Response: {
  "active": 100,           // 活跃池数量
  "pending": 15,           // 待复检数量
  "eliminated": 23,        // 淘汰池数量
  "nextRecheck": "2026-07-22T10:35:00Z",
  "lastRefill": "2026-07-22T10:20:00Z",
  "autoRefill": true,
  "autoRecheck": true
}
```

**质量分布**：
```
GET /api/pool/quality
Response: {
  "xai_ready": 15,
  "cf_passed": 45,
  "connected": 40
}
```

---

## 🛠️ 技术实现

### 1. 数据结构

```javascript
// 代理对象
{
  "proxy": "socks5://1.2.3.4:8080",
  "quality": "connected",  // connected | cf_passed | xai_ready
  "latency": 156,
  "country": "US",
  "isResidential": true,
  "ip": "1.2.3.4",
  "successRate": 95,
  "failCount": 0,
  "lastChecked": "2026-07-22T10:29:55Z",
  "createdAt": "2026-07-22T09:00:00Z",
  "updatedAt": "2026-07-22T10:29:55Z"
}

// 池状态
{
  "active": [],      // 活跃池
  "pending": [],     // 待复检池
  "eliminated": [],  // 淘汰池
  "stats": {
    "activeCount": 100,
    "pendingCount": 15,
    "eliminatedCount": 23,
    "lastRecheck": "2026-07-22T10:30:00Z",
    "lastRefill": "2026-07-22T10:20:00Z"
  }
}
```

### 2. 定时器

```javascript
// 每 5 分钟复检
setInterval(() => {
  if (!isRechecking) {
    recheckPool(10);  // 复检 10 条
  }
}, 5 * 60 * 1000);

// 每 1 分钟检查是否需要补充
setInterval(() => {
  if (activePool.length < 80 && !isRefilling) {
    refillPool(100);  // 补充到 100 条
  }
}, 60 * 1000);
```

### 3. 并发控制

```javascript
// 防止并发复检
let isRechecking = false;

// 防止并发补充
let isRefilling = false;

// 任务队列
const taskQueue = [];
```

---

## 📊 预期效果

### 时间轴示例

```
0 分钟  → 初始检测，收集 100 条入池
5 分钟  → 复检 10 条，失败 2 条淘汰，活跃池=98
6 分钟  → 检测到 < 80，触发补充，补充 20 条，活跃池=118
10 分钟 → 复检 10 条，失败 1 条淘汰，活跃池=117
15 分钟 → 复检 10 条，失败 3 条淘汰，活跃池=114
20 分钟 → 复检 10 条，失败 2 条淘汰，活跃池=112
...     → 循环，保持活跃池 100-120 条
```

### 质量指标

| 指标 | 目标值 | 说明 |
|---|---|---|
| 活跃池大小 | 100 ± 20 | 始终保持在 80-120 条 |
| 复检通过率 | > 80% | 5 分钟内复检成功率 |
| 补充成功率 | > 50% | 新代理检测通过率 |
| API 响应时间 | < 100ms | 获取池接口的响应时间 |
| 代理可用率 | > 90% | 返回的代理中实际可用的比例 |

---

## ✅ 验收标准

### 功能验收

- [ ] `GET /api/pool` 始终返回 100 条代理
- [ ] 活跃池 < 80 条时自动触发补充
- [ ] 每 5 分钟自动复检 10 条
- [ ] 连续 2 次失败自动淘汰
- [ ] 淘汰后自动补充新代理
- [ ] `GET /api/pool/stats` 返回准确状态

### 性能验收

- [ ] API 响应时间 < 100ms
- [ ] 复检 10 条耗时 < 2 分钟
- [ ] 补充 20 条耗时 < 5 分钟
- [ ] 并发控制正常（无死锁）

### 稳定性验收

- [ ] 连续运行 24 小时无崩溃
- [ ] 活跃池始终保持在 80-120 条
- [ ] 代理可用率 > 90%
- [ ] 内存占用 < 500MB

---

## 🔄 更新日志

- 2026-07-22: 初始版本创建
- 2026-07-22: 实现智能池管理
- 2026-07-22: 测试验证
