import { useState, useEffect, useCallback } from "react";
import { Copy, RefreshCw, Server, Wifi, Download } from "lucide-react";

const API = "";

type Proxy = {
  proxy: string;
  ip: string;
  latency: number;
  quality: string;
  country: string;
};

type PoolStats = {
  active: number;
  pending: number;
  eliminated: number;
};

type QualitySummary = {
  score: number;
  grade: 'good' | 'medium' | 'poor';
  averageLatency: number;
  latestSuccessRate: number;
  stableRate: number;
  residential: number;
  unknownNetwork: number;
};

export default function Home() {
  const [current, setCurrent] = useState<Proxy | null>(null);
  const [stats, setStats] = useState<PoolStats>({ active: 0, pending: 0, eliminated: 0 });
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [pipelineStep, setPipelineStep] = useState(0);     // 0=未开始, 1=抓取, 2=提取, 3=检测
  const [pipelineProgress, setPipelineProgress] = useState(0);
  const [pipelineMessage, setPipelineMessage] = useState('');
  const [apiRegion, setApiRegion] = useState<'all' | 'domestic' | 'foreign'>('all');
  const [apiGrade, setApiGrade] = useState<'all' | 'good' | 'medium' | 'poor'>('all');
  const [quality, setQuality] = useState<QualitySummary>({ score: 0, grade: 'poor', averageLatency: 0, latestSuccessRate: 0, stableRate: 0, residential: 0, unknownNetwork: 0 });
  const [apiCopied, setApiCopied] = useState(false);
  const [serverIp, setServerIp] = useState('');
  const [testingApi, setTestingApi] = useState(false);
  const [testResults, setTestResults] = useState<string[]>([]);
 
  // 自动获取当前服务器地址
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setServerIp(window.location.origin);
    }
  }, []);

  const baseUrl = serverIp || 'http://127.0.0.1:5778';
  const apiLink = `${baseUrl}/api/pool?region=${apiRegion}&grade=${apiGrade}`;

  const fetchStats = useCallback(async () => {
    try {
      const [statsResponse, qualityResponse] = await Promise.all([
        fetch(`${API}/api/pool/stats`),
        fetch(`${API}/api/pool/quality`),
      ]);
      const statsData = await statsResponse.json();
      const qualityData = await qualityResponse.json();
      if (statsData.success) setStats({ active: statsData.active, pending: statsData.pending, eliminated: statsData.eliminated });
      if (qualityData.success) setQuality(qualityData);
    } catch {}
  }, []);

  const getProxy = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/pool`);
      const d = await r.json();
      if (d.success && d.proxy) setCurrent(d.proxy);
    } catch {}
    setLoading(false);
    fetchStats();
  }, [fetchStats]);

  const extractSocks5 = useCallback(async () => {
    setExtracting(true);
    setPipelineStep(1);
    setPipelineProgress(0);
    setPipelineMessage('第 1 步：抓取代理源...');
    try {
      const response = await fetch(`${API}/api/pipeline`, { method: 'POST' });
      if (!response.ok || !response.body) throw new Error(`服务返回 ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const event of events) {
          const lines = event.split('\n');
          const type = lines.find((line) => line.startsWith('event: '))?.slice(7);
          const dataLine = lines.find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(6));
          if (type === 'status') {
            if (data.step) setPipelineStep(data.step);
            if (data.progress != null) setPipelineProgress(data.progress);
            if (data.message) setPipelineMessage(data.message);
          } else if (type === 'error') {
            throw new Error(data.error || '流水线执行失败');
          } else if (type === 'done') {
            setPipelineProgress(100);
            fetchStats();
          }
        }
        if (done) break;
      }
    } catch (e) {
      alert(`错误：${e instanceof Error ? e.message : '无法连接服务'}`);
    } finally {
      setExtracting(false);
      setPipelineStep(0);
    }
  }, [fetchStats]);

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const copyApiLink = async () => {
    await navigator.clipboard.writeText(apiLink);
    setApiCopied(true);
    setTimeout(() => setApiCopied(false), 1500);
  };

  const testApi = useCallback(async () => {
    setTestingApi(true);
    setTestResults([]);
    try {
      const results: string[] = [];
      // 连续请求 5 次，验证每次返回不同代理
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`${baseUrl}/api/pool?region=${apiRegion}&grade=${apiGrade}`);
        const d = await r.json();
        if (d.success && d.proxy) {
          results.push(d.proxy.proxy);
        }
        // 稍微延迟，避免并发问题
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      setTestResults(results);
    } catch (e) {
      setTestResults(['测试失败：无法连接服务']);
    }
    setTestingApi(false);
  }, [baseUrl, apiRegion, apiGrade]);

  useEffect(() => {
    fetchStats();
    const timer = setInterval(fetchStats, 30000);
    return () => clearInterval(timer);
  }, [fetchStats]);

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0f0d',
      color: '#d1e7dd',
      fontFamily: 'system-ui, sans-serif',
      padding: '40px 20px',
    }}>
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        {/* Header */}
        <header style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '60px',
          paddingBottom: '20px',
          borderBottom: '1px solid #1f3a2f',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '40px',
              height: '40px',
              borderRadius: '8px',
              background: '#1a3a2f',
              display: 'grid',
              placeItems: 'center',
              color: '#4ade80',
            }}>
              <Wifi size={20} />
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Relay Scout</h1>
              <p style={{ margin: '4px 0 0', fontSize: '12px', color: '#6b9080' }}>SOCKS5 智能代理池</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button
                onClick={extractSocks5}
                disabled={extracting}
                style={{
                  padding: '8px 16px',
                  background: extracting ? '#1f3a2f' : 'transparent',
                  color: extracting ? '#6b9080' : '#d1e7dd',
                  border: `1px solid ${extracting ? '#1f3a2f' : '#2d5a4a'}`,
                  borderRadius: '6px',
                  cursor: extracting ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '13px',
                  fontWeight: 500,
                }}
              >
                <Download size={14} />
                {extracting ? `${pipelineMessage}` : '提取 SOCKS5'}
              </button>
              {extracting && (
                <div style={{ width: '120px', height: '4px', background: '#1f3a2f', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${pipelineProgress}%`, height: '100%', background: '#4ade80', borderRadius: '2px', transition: 'width 0.3s' }} />
                </div>
              )}
            <div style={{ fontSize: '13px', color: '#6b9080' }}>
              池：<span style={{ color: '#4ade80', fontWeight: 600 }}>{stats.active}</span> 条
            </div>
          </div>
        </header>

        {/* Main Card */}
        <main>
          {current ? (
            <div style={{
              background: '#11221d',
              borderRadius: '12px',
              padding: '32px',
              border: '1px solid #1f3a2f',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <span style={{ fontSize: '14px', color: '#6b9080' }}>当前代理</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => copy(current.proxy)}
                    style={{
                      padding: '8px 16px',
                      background: copied ? '#166534' : '#1f3a2f',
                      color: copied ? '#86efac' : '#d1e7dd',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      fontWeight: 500,
                    }}
                  >
                    <Copy size={14} />
                    {copied ? '已复制' : '复制'}
                  </button>
                  <button
                    onClick={getProxy}
                    disabled={loading}
                    style={{
                      padding: '8px 16px',
                      background: '#22c55e',
                      color: '#052e16',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      opacity: loading ? 0.7 : 1,
                    }}
                  >
                    {loading ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    换一个
                  </button>
                </div>
              </div>

              <div style={{
                background: '#0a0f0d',
                padding: '20px',
                borderRadius: '8px',
                fontFamily: 'monospace',
                fontSize: '16px',
                color: '#4ade80',
                marginBottom: '24px',
                wordBreak: 'break-all',
              }}>
                {current.proxy}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
                <div>
                  <div style={{ fontSize: '12px', color: '#6b9080', marginBottom: '4px' }}>延迟</div>
                  <div style={{ fontSize: '16px', fontWeight: 600, color: '#fbbf24' }}>{Math.round(current.latency)} ms</div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: '#6b9080', marginBottom: '4px' }}>出口 IP</div>
                  <div style={{ fontSize: '14px', color: '#d1e7dd' }}>{current.ip}</div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: '#6b9080', marginBottom: '4px' }}>质量</div>
                  <div style={{ fontSize: '14px', color: '#4ade80' }}>
                    {current.quality === 'cf_passed' ? 'CF 可用' : '连通'}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{
              background: '#11221d',
              borderRadius: '12px',
              padding: '60px 32px',
              border: '1px solid #1f3a2f',
              textAlign: 'center',
            }}>
              <div style={{
                width: '64px',
                height: '64px',
                margin: '0 auto 24px',
                borderRadius: '12px',
                background: '#1a3a2f',
                display: 'grid',
                placeItems: 'center',
                color: '#4ade80',
              }}>
                <Wifi size={32} />
              </div>
              <h2 style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: 600, color: '#d1e7dd' }}>获取代理</h2>
              <p style={{ margin: '0 0 24px', fontSize: '14px', color: '#6b9080' }}>从池中随机获取一个可用代理</p>
              <button
                onClick={getProxy}
                disabled={loading}
                style={{
                  padding: '12px 32px',
                  background: '#22c55e',
                  color: '#052e16',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                }}
              >
                {loading ? <RefreshCw size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                获取一个代理
              </button>
            </div>
          )}

          {/* Quality overview */}
          <div style={{ marginTop: '24px', padding: '24px', background: '#11221d', borderRadius: '12px', border: '1px solid #1f3a2f' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '18px' }}>
              <div>
                <div style={{ fontSize: '12px', color: '#6b9080', marginBottom: '5px' }}>综合质量</div>
                <strong style={{ fontSize: '26px', color: quality.grade === 'good' ? '#4ade80' : quality.grade === 'medium' ? '#fbbf24' : '#f87171' }}>
                  {quality.score} 分（{quality.grade === 'good' ? '好' : quality.grade === 'medium' ? '中' : '差'}）
                </strong>
              </div>
              <div style={{ fontSize: '12px', color: '#6b9080' }}>已确认住宅 {quality.residential} 条 · 类型未知 {quality.unknownNetwork} 条</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: '12px' }}>
              {[
                ['平均延迟', `${quality.averageLatency}ms`],
                ['近一轮成功率', `${quality.latestSuccessRate}%`],
                ['稳定代理', `${quality.stableRate}%`],
              ].map(([label, value]) => (
                <div key={label} style={{ padding: '14px', background: '#0a0f0d', borderRadius: '8px' }}>
                  <div style={{ fontSize: '11px', color: '#6b9080', marginBottom: '6px' }}>{label}</div>
                  <div style={{ fontSize: '17px', fontWeight: 700, color: '#d1e7dd' }}>{value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Stats */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '16px',
            marginTop: '24px',
          }}>
            <div style={{
              background: '#11221d',
              padding: '20px',
              borderRadius: '8px',
              border: '1px solid #1f3a2f',
            }}>
              <div style={{ fontSize: '12px', color: '#6b9080', marginBottom: '8px' }}>活跃池</div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#4ade80' }}>{stats.active}</div>
              <div style={{ fontSize: '11px', color: '#6b9080', marginTop: '4px' }}>可用代理</div>
            </div>
            <div style={{
              background: '#11221d',
              padding: '20px',
              borderRadius: '8px',
              border: '1px solid #1f3a2f',
            }}>
              <div style={{ fontSize: '12px', color: '#6b9080', marginBottom: '8px' }}>待复检</div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#fbbf24' }}>{stats.pending}</div>
              <div style={{ fontSize: '11px', color: '#6b9080', marginTop: '4px' }}>等待复检</div>
            </div>
            <div style={{
              background: '#11221d',
              padding: '20px',
              borderRadius: '8px',
              border: '1px solid #1f3a2f',
            }}>
              <div style={{ fontSize: '12px', color: '#6b9080', marginBottom: '8px' }}>已淘汰</div>
              <div style={{ fontSize: '24px', fontWeight: 700, color: '#f87171' }}>{stats.eliminated}</div>
              <div style={{ fontSize: '11px', color: '#6b9080', marginTop: '4px' }}>失效代理</div>
            </div>
          </div>

          {/* Note */}
          <div style={{
            marginTop: '24px',
            padding: '16px',
            background: '#1a3a2f',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontSize: '13px',
            color: '#6b9080',
          }}>
            <Server size={16} />
            <span>池自动维护中 · 每 5 分钟复检 10 条 · 淘汰失效代理 · 补充新代理</span>
          </div>

          {/* API Link */}
          <div style={{
            marginTop: '24px',
            padding: '24px',
            background: '#11221d',
            borderRadius: '12px',
            border: '1px solid #1f3a2f',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#d1e7dd' }}>
                API 链接
              </h3>
              <button
                onClick={testApi}
                disabled={testingApi}
                style={{
                  padding: '6px 12px',
                  background: testingApi ? '#1f3a2f' : 'transparent',
                  color: testingApi ? '#6b9080' : '#d1e7dd',
                  border: `1px solid ${testingApi ? '#1f3a2f' : '#2d5a4a'}`,
                  borderRadius: '6px',
                  cursor: testingApi ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12px',
                  fontWeight: 500,
                }}
              >
                🧪 {testingApi ? '测试中...' : '测试 API'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
              <select
                value={apiRegion}
                onChange={(e) => setApiRegion(e.target.value as typeof apiRegion)}
                style={{
                  padding: '10px 14px',
                  background: '#0a0f0d',
                  color: '#d1e7dd',
                  border: '1px solid #2d5a4a',
                  borderRadius: '6px',
                  fontSize: '13px',
                  cursor: 'pointer',
                  outline: 'none',
                }}
              >
                <option value="all">全部地区</option>
                <option value="domestic">国内</option>
                <option value="foreign">国外</option>
              </select>
              <select
                value={apiGrade}
                onChange={(e) => setApiGrade(e.target.value as typeof apiGrade)}
                style={{
                  padding: '10px 14px',
                  background: '#0a0f0d',
                  color: '#d1e7dd',
                  border: '1px solid #2d5a4a',
                  borderRadius: '6px',
                  fontSize: '13px',
                  cursor: 'pointer',
                  outline: 'none',
                }}
              >
                <option value="all">全部质量</option>
                <option value="good">好 · 已确认住宅且快速稳定</option>
                <option value="medium">中 · 可用或住宅未知</option>
                <option value="poor">差 · 低分或不稳定</option>
              </select>
              <div style={{ flex: 1, display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  value={apiLink}
                  readOnly
                  style={{
                    flex: 1,
                    padding: '10px 14px',
                    background: '#0a0f0d',
                    color: '#4ade80',
                    border: '1px solid #2d5a4a',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontFamily: 'monospace',
                    outline: 'none',
                  }}
                />
                <button
                  onClick={copyApiLink}
                  style={{
                    padding: '10px 20px',
                    background: apiCopied ? '#166534' : '#22c55e',
                    color: apiCopied ? '#86efac' : '#052e16',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Copy size={14} />
                  {apiCopied ? '已复制' : '复制链接'}
                </button>
              </div>
            </div>
            
            {/* 测试结果显示 */}
            {testResults.length > 0 && (
              <div style={{
                marginTop: '16px',
                padding: '16px',
                background: '#0a0f0d',
                borderRadius: '6px',
                border: '1px solid #2d5a4a',
              }}>
                <div style={{ fontSize: '12px', color: '#fbbf24', marginBottom: '8px', fontWeight: 600 }}>
                  测试结果（连续 5 次请求）：
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: '11px', color: '#9ca3af', lineHeight: 1.8 }}>
                  {testResults.map((proxy, i) => (
                    <div key={i}>
                      <span style={{ color: '#6b9080' }}>{i + 1}.</span> {proxy}
                    </div>
                  ))}
                </div>
                {testResults.length >= 2 && testResults.every((p, i, arr) => i === 0 || p !== arr[i - 1]) && (
                  <div style={{ marginTop: '8px', fontSize: '12px', color: '#4ade80' }}>
                    ✅ 验证通过：每次请求返回不同代理
                  </div>
                )}
                {testResults.length >= 2 && testResults.some((p, i, arr) => i > 0 && p === arr[i - 1]) && (
                  <div style={{ marginTop: '8px', fontSize: '12px', color: '#f87171' }}>
                    ⚠️ 发现重复：代理可能未随机返回
                  </div>
                )}
              </div>
            )}
            
            <div style={{ fontSize: '12px', color: '#6b9080', lineHeight: 1.6, marginTop: '16px' }}>
              <div style={{ marginBottom: '8px' }}>
                <span style={{ color: '#fbbf24', fontWeight: 600 }}>说明：</span>
                每次请求返回一个 SOCKS5 代理链接
              </div>
              <div style={{ fontFamily: 'monospace', color: '#9ca3af', fontSize: '11px' }}>
                <div>示例：curl "{apiLink}"</div>
                <div>返回：{`{"proxy": "socks5://IP:PORT", "ip": "...", "latency": 123, ...}`}</div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
