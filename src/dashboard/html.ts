/**
 * AIPing Model Router — Dashboard UI
 * Elegant, minimal single-page interface for trial + config
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIPing Model Router</title>
  <style>
    :root {
      --bg: #faf9f7;
      --surface: #fff;
      --border: #e8e6e3;
      --text: #1a1a1a;
      --text-muted: #6b6b6b;
      --accent: #2d7d6e;
      --accent-hover: #236358;
      --error: #c44;
      --success: #2d7d6e;
      --radius: 8px;
      --shadow: 0 1px 3px rgba(0,0,0,.06);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
      padding: 24px;
    }
    .container { max-width: 640px; margin: 0 auto; }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--text);
    }
    .subtitle {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 32px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 24px;
      margin-bottom: 20px;
    }
    .card h2 {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--text);
    }
    .form-group {
      margin-bottom: 16px;
    }
    .form-group:last-child { margin-bottom: 0; }
    label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    input, select, textarea {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.9375rem;
      background: var(--surface);
      transition: border-color .15s;
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    input[type="checkbox"] {
      width: auto;
      margin-right: 8px;
      vertical-align: middle;
    }
    .hint { font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 18px;
      font-size: 0.9375rem;
      font-weight: 500;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background .15s;
    }
    .btn-primary {
      background: var(--accent);
      color: #fff;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-secondary {
      background: var(--border);
      color: var(--text);
    }
    .btn-secondary:hover { background: #ddd; }
    .trial-area {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .trial-area input {
      flex: 1;
    }
    .response-box {
      min-height: 80px;
      padding: 12px;
      background: var(--bg);
      border-radius: 6px;
      font-size: 0.875rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .response-box.empty { color: var(--text-muted); }
    .response-box.error { color: var(--error); }
    .response-box .meta {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .status-bar {
      display: flex;
      gap: 16px;
      font-size: 0.8125rem;
      color: var(--text-muted);
      margin-bottom: 20px;
      padding: 10px 14px;
      background: var(--surface);
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .status-bar span { display: flex; align-items: center; gap: 6px; }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--text-muted);
    }
    .status-dot.ok { background: var(--success); }
    .status-dot.err { background: var(--error); }
    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      padding: 12px 20px;
      border-radius: 6px;
      font-size: 0.875rem;
      z-index: 100;
      animation: fadeIn .2s;
    }
    .toast.success { background: var(--success); color: #fff; }
    .toast.error { background: var(--error); color: #fff; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 520px) { .grid2 { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="container">
    <h1>AIPing Model Router</h1>
    <p class="subtitle">智能路由：本地小模型 + 云端强模型 · 约 90% 请求走本地</p>

    <div class="status-bar" id="statusBar">
      <span id="localStatus"><span class="status-dot"></span> 本地</span>
      <span id="cloudStatus"><span class="status-dot"></span> 云端</span>
      <span id="configStatus"><span class="status-dot"></span> 配置</span>
    </div>

    <div class="card">
      <h2>试用</h2>
      <p class="hint" style="margin-bottom:12px">输入消息测试路由效果，无需配置即可体验（需先保存下方配置）</p>
      <div class="trial-area">
        <input type="text" id="trialInput" placeholder="输入消息，如：你好" />
        <button class="btn btn-primary" id="trialBtn">发送</button>
      </div>
      <div class="response-box empty" id="responseBox">响应将显示在这里</div>
    </div>

    <div class="card">
      <h2>模型配置</h2>
      <p class="hint" style="margin-bottom:16px">本地启动后在此填写，保存后重启 gateway 生效</p>
      <form id="configForm">
        <div class="form-group">
          <label>AIPing API Key</label>
          <input type="password" id="aipingApiKey" placeholder="QC- 开头，从 aiping.cn 获取" autocomplete="off" />
          <div class="hint">https://aiping.cn/user/user-center</div>
        </div>
        <div class="grid2">
          <div class="form-group">
            <label>本地模型</label>
            <input type="text" id="localModel" placeholder="qwen2.5:4b" />
          </div>
          <div class="form-group">
            <label>云端模型</label>
            <input type="text" id="cloudModel" placeholder="Kimi-K2.5" />
          </div>
        </div>
        <div class="form-group">
          <label>本地代理地址</label>
          <input type="text" id="localProxyUrl" placeholder="http://localhost:11434" />
        </div>
        <div class="form-group">
          <label>本地代理 Key（可选）</label>
          <input type="password" id="localProxyKey" placeholder="LM Studio 等需要" autocomplete="off" />
        </div>
        <div class="form-group">
          <label>路由阈值 (0-100)</label>
          <input type="number" id="routingThreshold" min="0" max="100" placeholder="85" />
          <div class="hint">越高越偏本地，85 约 90% 走本地</div>
        </div>
        <div class="form-group">
          <label><input type="checkbox" id="fallbackToCloud" checked /> 本地失败时自动切换云端</label>
        </div>
        <div style="margin-top:20px;display:flex;gap:8px">
          <button type="submit" class="btn btn-primary">保存配置</button>
          <button type="button" class="btn btn-secondary" id="reloadBtn">重新加载</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    const api = (path) => path;

    async function fetchHealth() {
      try {
        const r = await fetch(api('/aiping/health'));
        return r.ok ? await r.json() : null;
      } catch { return null; }
    }

    async function fetchConfig() {
      try {
        const r = await fetch(api('/aiping/api/config'));
        return r.ok ? await r.json() : null;
      } catch { return null; }
    }

    async function saveConfig(data) {
      const r = await fetch(api('/aiping/api/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      return r.ok ? await r.json() : null;
    }

    function toast(msg, type = 'success') {
      const el = document.createElement('div');
      el.className = 'toast ' + type';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2500);
    }

    function updateStatus(h) {
      const localEl = document.getElementById('localStatus');
      const cloudEl = document.getElementById('cloudStatus');
      const configEl = document.getElementById('configStatus');
      if (!h) {
        localEl.innerHTML = '<span class="status-dot err"></span> 无法连接';
        cloudEl.innerHTML = '<span class="status-dot err"></span> 无法连接';
        configEl.innerHTML = '<span class="status-dot"></span> 未知';
        return;
      }
      const localOk = h.localModel && h.localModel !== '(未配置，请运行 openclaw model-router-setup)';
      localEl.innerHTML = localOk
        ? '<span class="status-dot ok"></span> 本地 ' + h.localModel
        : '<span class="status-dot err"></span> 本地未配置';
      cloudEl.innerHTML = h.configured
        ? '<span class="status-dot ok"></span> 云端已配置'
        : '<span class="status-dot err"></span> 云端未配置';
      configEl.innerHTML = '<span class="status-dot ok"></span> 阈值 ' + (h.routingThreshold ?? 85);
    }

    function fillForm(c) {
      if (!c) return;
      document.getElementById('aipingApiKey').value = c.aipingApiKey || '';
      document.getElementById('localModel').value = c.localModel || '';
      document.getElementById('cloudModel').value = c.cloudModel || 'Kimi-K2.5';
      document.getElementById('localProxyUrl').value = c.localProxyUrl || 'http://localhost:11434';
      document.getElementById('localProxyKey').value = c.localProxyKey || '';
      document.getElementById('routingThreshold').value = c.routingThreshold ?? 85;
      document.getElementById('fallbackToCloud').checked = c.fallbackToCloud !== false;
    }

    async function load() {
      const [health, config] = await Promise.all([fetchHealth(), fetchConfig()]);
      updateStatus(health);
      fillForm(config);
    }

    document.getElementById('configForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {
        aipingApiKey: document.getElementById('aipingApiKey').value.trim(),
        localModel: document.getElementById('localModel').value.trim(),
        cloudModel: document.getElementById('cloudModel').value.trim() || 'Kimi-K2.5',
        localProxyUrl: document.getElementById('localProxyUrl').value.trim() || 'http://localhost:11434',
        localProxyKey: document.getElementById('localProxyKey').value.trim(),
        routingThreshold: parseInt(document.getElementById('routingThreshold').value, 10) || 85,
        fallbackToCloud: document.getElementById('fallbackToCloud').checked,
      };
      const ok = await saveConfig(data);
      if (ok) toast('配置已保存，请重启 gateway 生效');
      else toast('保存失败', 'error');
    });

    document.getElementById('reloadBtn').addEventListener('click', load);

    document.getElementById('trialBtn').addEventListener('click', async () => {
      const input = document.getElementById('trialInput');
      const box = document.getElementById('responseBox');
      const btn = document.getElementById('trialBtn');
      const msg = input.value.trim();
      if (!msg) return;
      btn.disabled = true;
      box.className = 'response-box';
      box.textContent = '正在请求...';
      try {
        const r = await fetch(api('/aiping/demo/chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });
        const data = await r.json();
        if (data.error) {
          box.className = 'response-box error';
          box.innerHTML = '<span class="meta">错误</span>' + data.error;
        } else {
          const content = data.choices?.[0]?.message?.content || data.content || JSON.stringify(data);
          const target = data._target || '';
          box.className = 'response-box';
          box.innerHTML = (target ? '<span class="meta">路由: ' + target + '</span>' : '') + content;
        }
      } catch (err) {
        box.className = 'response-box error';
        box.textContent = err.message || '请求失败';
      }
      btn.disabled = false;
    });

    document.getElementById('trialInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('trialBtn').click();
    });

    load();
  </script>
</body>
</html>`;
