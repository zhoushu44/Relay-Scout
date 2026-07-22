const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = __dirname;
const port = Number(process.env.PORT || 5778);
const runs = new Map();
let activeRun = null;
const poolFile = path.join(root, 'socks5-pool.json');
const stepStateFile = path.join(root, 'step-state.json');
const domesticCodes = new Set(['CN', 'CHN', '中国', 'CHINA', '中国大陆']);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readPool = () => readJson(poolFile, { active: [], pending: [], eliminated: [], stats: { activeCount: 0, pendingCount: 0, eliminatedCount: 0, lastRecheck: null, lastRefill: null } });
const writePool = (pool) => {
  pool.stats = {
    activeCount: pool.active?.length || 0,
    pendingCount: pool.pending?.length || 0,
    eliminatedCount: pool.eliminated?.length || 0,
    lastRecheck: pool.stats?.lastRecheck || null,
    lastRefill: pool.stats?.lastRefill || null
  };
  fs.writeFileSync(poolFile, JSON.stringify(pool, null, 2), 'utf8');
};
function getRegion(item) {
  const value = String(item.countryCode || item.country_code || item.country || item.region || '').trim().toUpperCase();
  if (!value) return 'unknown';
  return domesticCodes.has(value) ? 'domestic' : 'foreign';
}
function extractSocks5(region = 'all') {
  const source = path.join(root, 'proxy-scraper', 'output', 'all_proxies.json');
  if (!fs.existsSync(source)) throw new Error('请先执行第 1 步抓取代理源');
  const parsed = readJson(source, []); const data = Array.isArray(parsed) ? parsed : parsed.proxies || parsed.data || [];
  const unique = new Map();
  for (const item of data) {
    const raw = String(item.proxy || item.url || '').trim();
    const protocol = String(item.protocol || (raw.match(/^([^:]+):\/\//) || [])[1] || '').toLowerCase();
    const address = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') || `${item.ip || item.host || ''}:${item.port || ''}`;
    const match = address.match(/^([^:@]+):([0-9]+)$/); const itemRegion = getRegion(item);
    if (!['socks5', 'socks5h'].includes(protocol) || !match || (region !== 'all' && itemRegion !== region)) continue;
    unique.set(`${match[1].toLowerCase()}:${match[2]}`, { link: `socks5://${match[1]}:${match[2]}`, region: itemRegion });
  }
  const selected = [...unique.values()]; const links = selected.map((item) => item.link);
  fs.writeFileSync(path.join(root, 'generated_socks5.txt'), links.join('\n') + (links.length ? '\n' : ''), 'utf8');
  return { links, newCount: links.length, reusedCount: 0, region };
}
// 智能池管理函数
let isRechecking = false;
let isRefilling = false;
const POOL_TARGET_SIZE = 100;
const POOL_MIN_THRESHOLD = 80;
const POOL_RECHECK_COUNT = 10;
const POOL_RECHECK_INTERVAL = 5 * 60 * 1000; // 5 分钟
const POOL_CHECK_INTERVAL = 60 * 1000; // 1 分钟

function scoreProxy(item) {
  const rate = Math.max(0, Math.min(100, Number(item.successRate ?? item.rate) || 0));
  const latency = Number(item.latency) || 9999;
  const failures = Number(item.failures) || 0;
  const stable = failures === 0 && item.ip && item.ip !== '-';
  const residential = item.isResidential === true || item.is_residential === true;
  const latencyScore = latency <= 300 ? 25 : latency <= 800 ? 20 : latency <= 1500 ? 12 : latency <= 3000 ? 5 : 0;
  const targetScore = item.quality === 'xai_ready' ? 10 : item.quality === 'cf_passed' ? 6 : 2;
  const score = Math.round(rate * 0.3 + latencyScore + (stable ? 15 : 0) + (failures === 0 ? 15 : failures === 1 ? 6 : 0) + targetScore + (residential ? 5 : 0));
  const grade = residential && score >= 80 && latency <= 800 && rate >= 90 && stable
    ? 'good'
    : score >= 50 ? 'medium' : 'poor';
  return {
    ...item,
    score,
    grade,
    networkType: residential ? 'residential' : 'unknown',
    stable: Boolean(stable)
  };
}

function poolList(region = 'all', grade = 'all') {
  const pool = readPool();
  return (pool.active || [])
    .filter(item => region === 'all' || item.region === region)
    .map(scoreProxy)
    .filter(item => grade === 'all' || item.grade === grade);
}

function poolQualitySummary(items) {
  const list = items.map(scoreProxy);
  const total = list.length;
  const average = key => total ? list.reduce((sum, item) => sum + (Number(item[key]) || 0), 0) / total : 0;
  return {
    score: Math.round(average('score')),
    grade: total && average('score') >= 80 ? 'good' : total && average('score') >= 50 ? 'medium' : 'poor',
    averageLatency: Math.round(average('latency')),
    latestSuccessRate: Math.round(average('successRate')),
    stableRate: total ? Math.round(list.filter(item => item.stable).length / total * 100) : 0,
    xaiReady: list.filter(item => item.quality === 'xai_ready').length,
    residential: list.filter(item => item.networkType === 'residential').length,
    unknownNetwork: list.filter(item => item.networkType === 'unknown').length,
    grades: {
      good: list.filter(item => item.grade === 'good').length,
      medium: list.filter(item => item.grade === 'medium').length,
      poor: list.filter(item => item.grade === 'poor').length
    }
  };
}

function preparePoolCheck() {
  const links = poolList('all').slice(0, POOL_RECHECK_COUNT).map((item) => item.proxy);
  fs.writeFileSync(path.join(root, 'generated_socks5.txt'), links.join('\n') + (links.length ? '\n' : ''), 'utf8');
}

function applySmartRecheck(results) {
  const pool = readPool();
  const checked = new Map(results.map((item) => [item.proxy, item]));
  let passed = 0, failed = 0, eliminated = 0;
  
  pool.active = (pool.active || []).flatMap((item) => {
    const result = checked.get(item.proxy);
    if (!result) return [item];
    
    const success = result.qualified && result.exit_ip && result.exit_ip !== '-';
    if (success) {
      passed++;
      return [{ ...item, ...result, failures: 0, lastChecked: new Date().toISOString() }];
    } else {
      failed++;
      const newFailures = (item.failures || 0) + 1;
      if (newFailures >= 2) {
        eliminated++;
        pool.eliminated = pool.eliminated || [];
        pool.eliminated.push({ ...item, eliminatedAt: new Date().toISOString(), reason: '连续失败 2 次' });
        return [];
      }
      return [{ ...item, failures: newFailures, lastChecked: new Date().toISOString() }];
    }
  });
  
  pool.stats.lastRecheck = new Date().toISOString();
  writePool(pool);
  return { rechecked: results.length, passed, failed, eliminated, activeCount: pool.active.length };
}

function persistQualified(results) {
  const pool = readPool() || { active: [], pending: [], eliminated: [] };
  pool.active = Array.isArray(pool.active) ? pool.active : [];
  const existing = new Set(pool.active.map((item) => item.proxy));
  let added = 0;
  
  for (const item of results.filter((row) => {
    const connected = row.exit_ip && row.exit_ip !== '-' && row.successes > 0;
    return connected && ['domestic', 'foreign', 'unknown'].includes(row.region || 'unknown');
  })) {
    if (existing.has(item.proxy)) continue;
    pool.active.push({
      proxy: item.proxy,
      quality: 'connected',
      latency: item.latency || 0,
      country: item.country || item.country_code || 'Unknown',
      region: item.region || 'unknown',
      isResidential: item.is_residential || false,
      ip: item.exit_ip,
      successRate: item.rate || 0,
      failures: 0,
      lastChecked: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });
    existing.add(item.proxy);
    added++;
  }
  
  writePool(pool);
  return { added, activeCount: pool.active.length };
}

async function smartRefill(targetSize = POOL_TARGET_SIZE) {
  if (isRefilling) return { success: false, reason: '已在补充中' };
  
  const pool = readPool();
  const currentSize = pool.active?.length || 0;
  if (currentSize >= targetSize) {
    return { success: true, previousSize: currentSize, added: 0, newSize: currentSize, reason: '池大小已达标' };
  }
  
  isRefilling = true;
  const needed = targetSize - currentSize;
  
  try {
    const source = path.join(root, 'proxy-scraper', 'output', 'all_proxies.json');
    if (!fs.existsSync(source)) {
      return { success: false, reason: '请先执行第 1 步抓取代理源' };
    }
    
    const parsed = readJson(source, []);
    const data = Array.isArray(parsed) ? parsed : parsed.proxies || parsed.data || [];
    const unique = new Map();
    
    const existingProxies = new Set((pool.active || []).map(p => p.proxy));
    
    for (const item of data) {
      if (unique.size >= needed * 3) break;
      
      const raw = String(item.proxy || item.url || '').trim();
      const protocol = String(item.protocol || (raw.match(/^([^:]+):\/\//) || [])[1] || '').toLowerCase();
      const address = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') || `${item.ip || item.host || ''}:${item.port || ''}`;
      const match = address.match(/^([^:@]+):([0-9]+)$/);
      
      if (!['socks5', 'socks5h'].includes(protocol) || !match) continue;
      
      const proxyUrl = `socks5://${match[1]}:${match[2]}`;
      if (existingProxies.has(proxyUrl) || unique.has(proxyUrl)) continue;
      
      unique.set(proxyUrl, { proxy: proxyUrl, region: getRegion(item) });
    }
    
    const newLinks = [...unique.values()].map(p => p.proxy);
    if (newLinks.length === 0) {
      isRefilling = false;
      return { success: false, reason: '没有新的代理可补充' };
    }
    
    fs.writeFileSync(path.join(root, 'generated_socks5.txt'), newLinks.join('\n') + (newLinks.length ? '\n' : ''), 'utf8');
    
    const resultFile = path.join(root, `refill-${Date.now()}.json`);
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const args = ['cf_quality_checker.py', '-f', path.join(root, 'generated_socks5.txt'), '-u', 'https://www.cloudflare.com/cdn-cgi/trace', '-n', '1', '-c', '200', '-t', '3', '--threshold', '0', '--max-latency', '3000', '--json-output', resultFile];
    
    await new Promise((resolve, reject) => {
      const child = spawn(python, args, { cwd: root, windowsHide: true });
      child.on('close', (code) => {
        if (code === 0 || code === 2) resolve();
        else reject(new Error(`检测失败，退出码：${code}`));
      });
      child.on('error', reject);
    });
    
    const results = readJson(resultFile, []);
    const { added, activeCount } = persistQualified(results);
    
    try { fs.unlinkSync(resultFile); } catch {}
    
    pool.stats.lastRefill = new Date().toISOString();
    writePool(pool);
    
    isRefilling = false;
    return { success: true, previousSize: currentSize, added, newSize: activeCount };
    
  } catch (error) {
    isRefilling = false;
    return { success: false, error: error.message };
  }
}

async function smartRecheck(count = POOL_RECHECK_COUNT) {
  if (isRechecking) return { success: false, reason: '已在复检中' };
  
  const pool = readPool();
  const activeCount = pool.active?.length || 0;
  if (activeCount === 0) {
    return { success: false, reason: '活跃池为空' };
  }
  
  isRechecking = true;
  
  try {
    const toCheck = [];
    const strategy = 'random';
    
    if (strategy === 'random') {
      const shuffled = [...(pool.active || [])].sort(() => Math.random() - 0.5);
      toCheck.push(...shuffled.slice(0, count));
    }
    
    if (toCheck.length === 0) {
      isRechecking = false;
      return { success: false, reason: '没有需要复检的代理' };
    }
    
    fs.writeFileSync(path.join(root, 'generated_socks5.txt'), toCheck.map(p => p.proxy).join('\n') + (toCheck.length ? '\n' : ''), 'utf8');
    
    const resultFile = path.join(root, `recheck-${Date.now()}.json`);
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const args = ['cf_quality_checker.py', '-f', path.join(root, 'generated_socks5.txt'), '-u', 'https://www.cloudflare.com/cdn-cgi/trace', '-n', '1', '-c', '50', '-t', '3', '--threshold', '0', '--max-latency', '3000', '--json-output', resultFile];
    
    await new Promise((resolve, reject) => {
      const child = spawn(python, args, { cwd: root, windowsHide: true });
      child.on('close', (code) => {
        if (code === 0 || code === 2) resolve();
        else reject(new Error(`检测失败，退出码：${code}`));
      });
      child.on('error', reject);
    });
    
    const results = readJson(resultFile, []);
    const recheckResult = applySmartRecheck(results);
    
    try { fs.unlinkSync(resultFile); } catch {}
    
    isRechecking = false;
    return { success: true, ...recheckResult };
    
  } catch (error) {
    isRechecking = false;
    return { success: false, error: error.message };
  }
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); }
function sendEvent(run, type, data) { run.clients.forEach((res) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); }
function safeNumber(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function summarize(run) { const results = run.results || []; const latencies = results.filter((item) => item.latency); return { total: results.length, qualified: results.filter((item) => item.qualified).length, averageRate: results.length ? results.reduce((sum, item) => sum + (item.rate || 0), 0) / results.length : 0, averageLatency: latencies.length ? latencies.reduce((sum, item) => sum + item.latency, 0) / latencies.length : 0, results }; }
function runTask(run) {
  const resultFile = path.join(root, `${run.id}.json`); const isScrape = run.config.mode === 'scrape'; const isConnectivity = run.config.mode === 'connectivity';
  const inputFile = path.join(root, 'generated_socks5.txt'); if (run.config.mode === 'recheck') preparePoolCheck(); const python = process.platform === 'win32' ? 'python' : 'python3';
  const checkInput = run.config.mode === 'check' ? path.join(root, 'alive_socks5.txt') : inputFile;
  const checkUrl = run.config.url;
  const args = isScrape
    ? ['src/index.js', '--all', '--no-verify']
    : ['cf_quality_checker.py', '-f', checkInput, '-u', checkUrl, '-n', String(run.config.attempts), '-c', String(run.config.concurrent), '-t', String(run.config.timeout), '--threshold', isConnectivity ? '0' : '90', '--max-latency', isConnectivity ? '10000' : '800', '--json-output', resultFile];
  run.status = isScrape ? 'scraping' : 'checking'; sendEvent(run, 'status', { status: run.status, progress: isScrape ? 5 : 55, message: isScrape ? '第一阶段：抓取原始代理/IP（不按历史池过滤）' : '第三阶段：检测连通性、出口 IP 稳定性、延迟、CF 成功率与信誉' });
  const child = spawn(isScrape ? process.execPath : python, args, { cwd: isScrape ? path.join(root, 'proxy-scraper') : root, windowsHide: true }); run.child = child;
  child.stdout.on('data', (chunk) => sendEvent(run, 'status', { status: run.status, progress: isScrape ? 15 : 70, message: chunk.toString().trim() }));
  child.stderr.on('data', (chunk) => sendEvent(run, 'log', { message: chunk.toString().trim() }));
  child.on('close', (code) => { if (run.stopped) { run.child = null; activeRun = null; return; } if (isScrape) { run.results = []; } else { const loaded = readJson(resultFile, []); run.results = Array.isArray(loaded) ? loaded : []; } run.results = run.results.map((item) => ({ ...item, region: item.region || 'unknown' })); if (isConnectivity) { const alive = run.results.filter((item) => item.exit_ip && item.exit_ip !== '-' && item.successes > 0).map((item) => item.proxy); fs.writeFileSync(path.join(root, 'alive_socks5.txt'), alive.join('\n') + (alive.length ? '\n' : ''), 'utf8'); } if (run.config.mode === 'recheck') run.pool = applyRecheck(run.results); else if (!isScrape && run.config.mode === 'check') run.pool = persistQualified(run.results); run.status = code === 0 || code === 2 ? 'done' : 'failed'; sendEvent(run, 'summary', summarize(run)); sendEvent(run, 'done', { status: run.status, code }); run.child = null; activeRun = null; try { fs.unlinkSync(resultFile); } catch {} });
}
function body(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', (chunk) => data += chunk); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (error) { reject(error); } }); }); }
function startRun(config = {}) { if (activeRun) return null; const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; const mode = ['scrape', 'check', 'connectivity', 'recheck'].includes(config.mode) ? config.mode : 'scrape'; const run = { id, config: { mode, url: config.url || 'https://accounts.x.ai/sign-up?redirect=grok-com', attempts: safeNumber(config.attempts, 10, 1, 100), concurrent: safeNumber(config.concurrent, 10, 1, 100), timeout: safeNumber(config.timeout, 10, 1, 120) }, status: 'queued', results: [], clients: [], stopped: false }; runs.set(id, run); activeRun = run; runTask(run); return run; }
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, active: Boolean(activeRun) });
  if (req.method === 'GET' && url.pathname === '/api/steps') return json(res, 200, readJson(stepStateFile, {}));
  if (req.method === 'GET' && url.pathname === '/api/pool') {
    const region = ['all', 'domestic', 'foreign'].includes(url.searchParams.get('region')) ? url.searchParams.get('region') : 'all';
    const grade = ['all', 'good', 'medium', 'poor'].includes(url.searchParams.get('grade')) ? url.searchParams.get('grade') : 'all';
    const limit = Number(url.searchParams.get('limit')) || 1; // 默认返回 1 个
    
    // 如果是 1，随机返回 1 个；否则返回多个
    const pool = readPool();
    const activeList = poolList(region, grade);
    
    if (limit === 1) {
      // 随机选 1 个
      const randomIndex = Math.floor(Math.random() * activeList.length);
      const proxy = activeList[randomIndex] || null;
      return json(res, 200, {
        success: true,
        region,
        grade,
        count: proxy ? 1 : 0,
        proxy: proxy,
        poolSize: activeList.length,
        updated: pool.stats?.lastRecheck || pool.stats?.lastRefill || new Date().toISOString()
      });
    } else {
      // 批量返回
      const list = activeList.slice(0, Math.min(limit, 500));
      return json(res, 200, {
        success: true,
        region,
        count: list.length,
        proxies: list,
        poolSize: activeList.length,
        updated: pool.stats?.lastRecheck || pool.stats?.lastRefill || new Date().toISOString(),
        stats: {
          active: pool.active?.length || 0,
          pending: pool.pending?.length || 0,
          eliminated: pool.eliminated?.length || 0
        }
      });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/pool/stats') {
    const pool = readPool();
    return json(res, 200, {
      success: true,
      active: pool.active?.length || 0,
      pending: pool.pending?.length || 0,
      eliminated: pool.eliminated?.length || 0,
      nextRecheck: pool.stats?.lastRecheck ? new Date(new Date(pool.stats.lastRecheck).getTime() + POOL_RECHECK_INTERVAL).toISOString() : null,
      lastRefill: pool.stats?.lastRefill || null,
      autoRefill: true,
      autoRecheck: true,
      isRechecking,
      isRefilling
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/pool/quality') {
    const pool = readPool();
    return json(res, 200, { success: true, ...poolQualitySummary(pool.active || []) });
  }
  if (req.method === 'POST' && url.pathname === '/api/pool/recheck') {
    if (activeRun) return json(res, 409, { error: '已有任务运行中，请稍后再试' });
    if (isRechecking) return json(res, 409, { error: '已在复检中' });
    try {
      const config = await body(req);
      const count = Math.min(Math.max(1, Number(config.count) || POOL_RECHECK_COUNT), 50);
      smartRecheck(count).then(() => console.log('复检完成'));
      return json(res, 202, { success: true, message: '复检已开始' });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/pool/refill') {
    if (isRefilling) return json(res, 409, { error: '已在补充中' });
    try {
      const config = await body(req);
      const targetSize = Math.min(Math.max(10, Number(config.targetSize) || POOL_TARGET_SIZE), 500);
      smartRefill(targetSize).then(() => console.log('补充完成'));
      return json(res, 202, { success: true, message: '补充已开始' });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/steps/extract') { try { const config = await body(req); return json(res, 200, extractSocks5(['all', 'domestic', 'foreign'].includes(config.region) ? config.region : 'all')); } catch (error) { return json(res, 400, { error: error.message }); } }
  if (req.method === 'POST' && url.pathname === '/api/runs') { try { const config = await body(req); if (!/^https?:\/\//i.test(config.url || '')) return json(res, 400, { error: '目标 URL 必须是 HTTP 或 HTTPS 地址' }); const run = startRun(config); if (!run) return json(res, 409, { error: '已有任务运行中，请先等待完成' }); return json(res, 202, { id: run.id, status: run.status }); } catch (error) { return json(res, 400, { error: error.message }); } }
  const match = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(events|stop))?$/); if (match) { const run = runs.get(match[1]); if (!run) return json(res, 404, { error: '任务不存在' }); if (req.method === 'GET' && match[2] === 'events') { res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' }); run.clients.push(res); res.write(`event: status\ndata: ${JSON.stringify({ status: run.status, progress: 0 })}\n\n`); req.on('close', () => run.clients = run.clients.filter((client) => client !== res)); return; } if (req.method === 'POST' && match[2] === 'stop') { run.stopped = true; run.status = 'stopped'; run.child?.kill(); activeRun = null; return json(res, 200, { status: run.status }); } if (req.method === 'GET') return json(res, 200, { ...run, clients: undefined, child: undefined }); }
  if (req.method === 'GET') { const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const filePath = path.join(root, 'dist', file); if (fs.existsSync(filePath)) { const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' }; res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' }); return fs.createReadStream(filePath).pipe(res); } }
  json(res, 404, { error: 'Not found' });
});
// 智能池管理定时器
setInterval(async () => {
  if (!activeRun && !isRechecking && (readPool().active?.length || 0) > 0) {
    console.log('定时复检开始');
    await smartRecheck(POOL_RECHECK_COUNT);
  }
}, POOL_RECHECK_INTERVAL);

setInterval(async () => {
  const pool = readPool();
  const activeCount = pool.active?.length || 0;
  if (activeCount < POOL_MIN_THRESHOLD && !isRefilling && !activeRun) {
    console.log(`活跃池不足 (${activeCount}/${POOL_MIN_THRESHOLD})，触发补充`);
    await smartRefill(POOL_TARGET_SIZE);
  }
}, POOL_CHECK_INTERVAL);

console.log('智能池管理已启动：目标大小=' + POOL_TARGET_SIZE + ', 复检间隔=' + (POOL_RECHECK_INTERVAL/60000) + '分钟');
server.listen(port, '127.0.0.1', () => console.log(`API ready at http://127.0.0.1:${port}`));
