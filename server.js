// Express server that serves config.json and version.json from MySQL cbt_json_history.
// Local files are updated only when the DB history version differs.
const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const PORT = process.env.PORT || 3000;

function loadAppSettings() {
  const configPath = path.join(__dirname, 'app-settings.json');
  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error('Failed to read app-settings.json:', err.message || err);
    return {};
  }
}

let appSettings = loadAppSettings();

function getDbConfig(settings) {
  const dbConfig = settings.db || {};
  return {
    host: process.env.DB_HOST || dbConfig.host || '16.78.150.150',
    port: Number(process.env.DB_PORT || dbConfig.port || 3306),
    database: process.env.DB_DATABASE || dbConfig.database || 'garudacbt',
    user: process.env.DB_USERNAME || process.env.DB_USER || dbConfig.user || 'papah',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || dbConfig.password || 'adminkece',
  };
}

function createDbPool(settings) {
  const dbConfig = getDbConfig(settings);
  return mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });
}

let pool = createDbPool(appSettings);

async function reloadDbPool(settings) {
  const oldPool = pool;
  pool = createDbPool(settings);
  try {
    await oldPool.end();
  } catch (err) {
    console.error('Error closing old DB pool:', err.message || err);
  }
}

app.use((req, res, next) => {
  const startTime = Date.now();
  const pathName = req.path;
  const trackPaths = ['/config.json', '/version.json', '/api/config.json', '/api/version.json', '/monitor', '/health'];
  const isApiEndpoint =
    trackPaths.includes(pathName) ||
    pathName.startsWith('/exambro/');

  if (isApiEndpoint) {
    requestStats.total += 1;
    requestStats.byEndpoint[pathName] = (requestStats.byEndpoint[pathName] || 0) + 1;
  }

  res.on('finish', () => {
    if (isApiEndpoint) {
      requestStats.statusCodes[res.statusCode] = (requestStats.statusCodes[res.statusCode] || 0) + 1;
      const delta = Date.now() - startTime;
      const logEntry = `${req.method} ${pathName} ${res.statusCode} ${delta}ms`;
      requestStats.lastRequests.unshift({
        time: new Date().toISOString(),
        path: pathName,
        method: req.method,
        status: res.statusCode,
        durationMs: delta,
      });
      if (requestStats.lastRequests.length > 100) {
        requestStats.lastRequests.pop();
      }
      writeRequestLog(logEntry);
    }
  });

  next();
});

const SYNC_MIN_SECONDS = Number(process.env.SYNC_MIN_SECONDS || appSettings.syncMinSeconds || 5);
const SYNC_MAX_SECONDS = Number(process.env.SYNC_MAX_SECONDS || appSettings.syncMaxSeconds || 10);

const SCHOOL_NAME = process.env.SCHOOL_NAME || 'SMA NEGERI 1 PONTANG';
const DESCRIPTION = process.env.SCHOOL_DESCRIPTION || 'Konfigurasi CBT SMA NEGERI 1 PONTANG';
const BASE_URL = process.env.BASE_URL || appSettings.baseUrl || 'https://token.belajar2026.net';
const LOG_FILE = process.env.LOG_FILE || appSettings.logFile || 'sync.log';
const REQUEST_LOG_FILE = process.env.REQUEST_LOG_FILE || 'request.log';

let lastSync = null;
let nextSync = null;
let syncStatus = 'pending';
let lastSyncError = null;

const requestStats = {
  total: 0,
  byEndpoint: {},
  statusCodes: {},
  lastRequests: [],
  startTime: new Date().toISOString(),
};

function writeLog(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) {
      console.error('Write log failed:', err.message || err);
    }
  });
}

function writeRequestLog(entry) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${entry}\n`;
  fs.appendFile(REQUEST_LOG_FILE, line, (err) => {
    if (err) {
      console.error('Request log write failed:', err.message || err);
    }
  });
}

function readLastRequestLogLines(limit = 50) {
  try {
    if (!fs.existsSync(REQUEST_LOG_FILE)) {
      return [];
    }
    const data = fs.readFileSync(REQUEST_LOG_FILE, 'utf8').trim().split('\n');
    return data.slice(-limit);
  } catch (err) {
    console.error('Failed to read request log:', err.message || err);
    return [];
  }
}

function getRecentConfigVersionRequests(limit = 50) {
  return requestStats.lastRequests
    .filter((r) => [
      '/config.json',
      '/version.json',
      '/api/config.json',
      '/api/version.json',
      '/exambro/config.json',
      '/exambro/version.json',
    ].includes(r.path))
    .slice(0, limit);
}

function formatConfigVersion(date, ms = 0) {
  const pad = (value, length) => String(value).padStart(length, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1, 2),
    pad(date.getDate(), 2),
    pad(date.getHours(), 2),
    pad(date.getMinutes(), 2),
    pad(date.getSeconds(), 2),
    pad(ms, 3),
  ].join('');
}

function formatDateWithTimezone(updated) {
  const normalized = updated.replace(' ', 'T');
  return new Date(`${normalized}+07:00`);
}

function makeHash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function loadLatestConfigApiKey() {
  try {
    const [rows] = await pool.query(
      'SELECT content FROM cbt_json_history WHERE file_name = ? ORDER BY id_json_history DESC LIMIT 1',
      ['config.json']
    );
    if (!rows || rows.length === 0) {
      return null;
    }
    const content = rows[0].content;
    const config = JSON.parse(content);
    return config.api_key || null;
  } catch (err) {
    console.error('Failed to load latest config api_key:', err.message || err);
    return null;
  }
}

function getRequestApiKey(req) {
  return (
    req.query.apikey ||
    req.headers['x-api-key'] ||
    req.headers['x-apikey'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    null
  );
}

async function requireApiKey(req, res) {
  const expected = await loadLatestConfigApiKey();
  if (!expected) {
    return true;
  }
  const provided = getRequestApiKey(req);
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'Invalid or missing apikey' });
    return false;
  }
  return true;
}

async function requireApiKey404(req, res) {
  const expected = await loadLatestConfigApiKey();
  const provided = getRequestApiKey(req);
  if (!provided || !expected || provided !== expected) {
    res.sendStatus(404);
    return false;
  }
  return true;
}

function loadLocalVersion() {
  try {
    const versionPath = path.join(__dirname, 'version.json');
    if (!fs.existsSync(versionPath)) {
      return null;
    }
    const raw = fs.readFileSync(versionPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read local version.json:', err.message || err);
    return null;
  }
}

function getRandomSyncInterval() {
  return Math.floor(Math.random() * (SYNC_MAX_SECONDS - SYNC_MIN_SECONDS + 1)) + SYNC_MIN_SECONDS;
}

async function syncFromDatabase() {
  try {
    writeLog('starting sync from cbt_json_history');

    const [configRows] = await pool.query(
      'SELECT content FROM cbt_json_history WHERE file_name = ? ORDER BY id_json_history DESC LIMIT 1',
      ['config.json']
    );
    const [versionRows] = await pool.query(
      'SELECT content FROM cbt_json_history WHERE file_name = ? ORDER BY id_json_history DESC LIMIT 1',
      ['version.json']
    );

    if (!configRows.length || !versionRows.length) {
      writeLog('missing config.json or version.json in cbt_json_history');
      console.warn('Missing config.json or version.json in cbt_json_history');
      return scheduleNextSync();
    }

    const configString = configRows[0].content;
    const versionString = versionRows[0].content;

    let versionData;
    try {
      versionData = JSON.parse(versionString);
    } catch (err) {
      throw new Error('Invalid JSON in version.json history: ' + err.message);
    }

    const versionId = versionData.config_version;
    if (!versionId) {
      throw new Error('version.json history entry missing config_version');
    }

    const localVersion = loadLocalVersion();
    const localVersionId = localVersion ? localVersion.config_version : null;

    const fileConfigPath = path.join(__dirname, 'config.json');
    const fileVersionPath = path.join(__dirname, 'version.json');

    if (localVersionId === versionId) {
      writeLog(`no update needed, local version ${localVersionId} matches cbt_json_history`);
      console.log(`No update performed; local version ${localVersionId} matches cbt_json_history.`);
    } else {
      fs.writeFileSync(fileConfigPath, configString + '\n', 'utf8');
      fs.writeFileSync(fileVersionPath, versionString + '\n', 'utf8');
      writeLog(`updated local files config.json and version.json to version ${versionId}`);
      console.log(`Updated local files to version ${versionId}`);
    }

    lastSync = new Date().toISOString();
    syncStatus = 'ok';
    lastSyncError = null;
    writeLog(`sync ok version=${versionId}`);
    console.log(`Sync completed: version=${versionId}`);
  } catch (error) {
    lastSync = new Date().toISOString();
    syncStatus = 'error';
    lastSyncError = error.message || String(error);
    writeLog(`sync error ${lastSyncError}`);
    console.error('Sync error:', lastSyncError);
  } finally {
    scheduleNextSync();
  }
}

function scheduleNextSync() {
  const intervalSeconds = getRandomSyncInterval();
  nextSync = new Date(Date.now() + intervalSeconds * 1000).toISOString();
  const scheduleMsg = `Next MySQL sync in ${intervalSeconds} seconds (at ${nextSync})`;
  console.log(scheduleMsg);
  writeLog(scheduleMsg);
  setTimeout(syncFromDatabase, intervalSeconds * 1000);
}

async function sendHistoryJson(req, res, fileName) {
  try {
    if (!(await requireApiKey(req, res))) {
      return;
    }

    const [rows] = await pool.query(
      'SELECT content FROM cbt_json_history WHERE file_name = ? ORDER BY id_json_history DESC LIMIT 1',
      [fileName]
    );
    if (rows && rows.length > 0) {
      res.type('application/json').send(rows[0].content);
    } else {
      res.status(404).json({ error: `${fileName} not found in cbt_json_history` });
    }
  } catch (err) {
    res.status(500).json({ error: 'MySQL error', details: err.message });
  }
}

app.get('/config.json', async (req, res) => sendHistoryJson(req, res, 'config.json'));
app.get('/version.json', async (req, res) => sendHistoryJson(req, res, 'version.json'));
app.get('/exambro/config.json', async (req, res) => sendHistoryJson(req, res, 'config.json'));
app.get('/exambro/version.json', async (req, res) => sendHistoryJson(req, res, 'version.json'));
app.get('/api/config.json', async (req, res) => {
  if (!(await requireApiKey404(req, res))) {
    return;
  }
  await sendHistoryJson(req, res, 'config.json');
});
app.get('/api/version.json', async (req, res) => {
  if (!(await requireApiKey404(req, res))) {
    return;
  }
  await sendHistoryJson(req, res, 'version.json');
});

function renderDbSettingsPage() {
  const dbConfig = getDbConfig(appSettings);
  return `<!DOCTYPE html>
<html lang="id">
<head>
` +
  `  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Admin DB Settings</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 16px; background: #f7f8fb; color: #111; }
    .container { max-width: 700px; margin: auto; background: #fff; padding: 24px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
    label { display: block; margin-top: 16px; font-weight: 600; }
    input { width: 100%; padding: 10px; margin-top: 6px; border: 1px solid #ccc; border-radius: 6px; }
    button { margin-top: 20px; padding: 12px 18px; background: #0054d2; color: white; border: none; border-radius: 8px; cursor: pointer; }
    button:hover { background: #003faa; }
    .note { margin: 10px 0 0; color: #555; font-size: 0.95rem; }
    .status { margin-top: 16px; padding: 12px; border-radius: 8px; display: none; }
    .status.success { background: #e6ffed; color: #0f5f28; border: 1px solid #8fe19a; }
    .status.error { background: #ffe8e8; color: #8f1b1b; border: 1px solid #f1a2a2; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Admin Database Settings</h1>
    <p>Atur koneksi DB yang digunakan server untuk mengambil data JSON.</p>
    <p class="note">Jika variabel lingkungan DB_HOST / DB_USER / DB_PASSWORD aktif, nilai pada file <code>app-settings.json</code> akan tertimpa.</p>
    <form id="settingsForm">
      <label>Host DB</label>
      <input type="text" id="host" value="${dbConfig.host}" required />
      <label>Port DB</label>
      <input type="number" id="port" value="${dbConfig.port}" required />
      <label>Database</label>
      <input type="text" id="database" value="${dbConfig.database}" required />
      <label>Username DB</label>
      <input type="text" id="user" value="${dbConfig.user}" required />
      <label>Password DB</label>
      <input type="password" id="password" value="${dbConfig.password}" required />
      <button type="submit">Simpan Konfigurasi</button>
      <div class="status" id="status"></div>
    </form>
    <div class="note">
      <strong>Catatan:</strong>
      <ul>
        <li>Jika menampilkan <strong>OVERWRITE</strong>, berarti pengaturan lingkungan aktif dan akan menimpa setting file.</li>
      </ul>
    </div>
  </div>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      const form = document.getElementById('settingsForm');
      const status = document.getElementById('status');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        status.style.display = 'none';
        const payload = {
          host: document.getElementById('host').value.trim(),
          port: Number(document.getElementById('port').value),
          database: document.getElementById('database').value.trim(),
          user: document.getElementById('user').value.trim(),
          password: document.getElementById('password').value,
        };
        try {
          const response = await fetch(window.location.pathname, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const result = await response.json();
          status.className = 'status ' + (response.ok ? 'success' : 'error');
          status.textContent = response.ok ? result.message : result.error || 'Gagal menyimpan';
          status.style.display = 'block';
        } catch (err) {
          status.className = 'status error';
          status.textContent = err.message || 'Gagal menyimpan pengaturan';
          status.style.display = 'block';
        }
      });
    });
  </script>
</body>
</html>`;
}

app.get('/admin/db-settings', (req, res) => {
  res.type('text/html').send(renderDbSettingsPage());
});
app.get('/api/admin/db-settings', (req, res) => {
  res.type('text/html').send(renderDbSettingsPage());
});

const saveDbSettingsHandler = async (req, res) => {
  const { host, port, database, user, password } = req.body;
  if (!host || !port || !database || !user || !password) {
    return res.status(400).json({ error: 'Semua field DB wajib diisi.' });
  }

  const newSettings = {
    ...appSettings,
    db: {
      host: String(host),
      port: Number(port) || 3306,
      database: String(database),
      user: String(user),
      password: String(password),
    },
  };

  try {
    fs.writeFileSync(path.join(__dirname, 'app-settings.json'), JSON.stringify(newSettings, null, 2) + '\n', 'utf8');
    appSettings = newSettings;
    await reloadDbPool(appSettings);
    res.json({ success: true, message: 'Pengaturan DB berhasil disimpan dan diaktifkan.' });
  } catch (err) {
    console.error('Failed to save admin DB settings:', err.message || err);
    res.status(500).json({ error: 'Gagal menyimpan pengaturan DB.', details: err.message });
  }
};

app.post('/admin/db-settings', saveDbSettingsHandler);
app.post('/api/admin/db-settings', saveDbSettingsHandler);

app.get('/monitor', async (req, res) => {
  const requestLogLines = readLastRequestLogLines(50);
  const filteredRequestLogLines = requestLogLines.filter((line) =>
    line.includes('/config.json') ||
    line.includes('/version.json') ||
    line.includes('/api/config.json') ||
    line.includes('/api/version.json')
  );
  const recentConfigVersionRequests = getRecentConfigVersionRequests(50);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="10" />
  <title>API Monitor</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 16px; color: #222; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    pre { background: #f4f4f4; padding: 12px; border-radius: 6px; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f0f0f0; }
  </style>
</head>
<body>
  <h1>API Monitor</h1>
  <p><strong>Server port:</strong> ${PORT}</p>
  <p><strong>Sync status:</strong> ${syncStatus}</p>
  <p><strong>Last sync:</strong> ${lastSync}</p>
  <p><strong>Next sync:</strong> ${nextSync}</p>
  <p><strong>Last sync error:</strong> ${lastSyncError || 'none'}</p>
  <p><strong>Uptime since:</strong> ${requestStats.startTime}</p>
  <p><strong>Total request count:</strong> ${requestStats.total}</p>

  <h2>Request counts by endpoint</h2>
  <table>
    <tr><th>Endpoint</th><th>Count</th></tr>
    ${Object.entries(requestStats.byEndpoint)
      .map(([path, count]) => `<tr><td>${path}</td><td>${count}</td></tr>`)
      .join('')}
  </table>

  <h2>Version/Config request counts</h2>
  <table>
    <tr><th>Endpoint</th><th>Count</th></tr>
    ${['/config.json', '/version.json', '/exambro/config.json', '/exambro/version.json']
      .map((path) => `<tr><td>${path}</td><td>${requestStats.byEndpoint[path] || 0}</td></tr>`)
      .join('')}
  </table>

  <h2>Response status codes</h2>
  <table>
    <tr><th>Status</th><th>Count</th></tr>
    ${Object.entries(requestStats.statusCodes)
      .map(([status, count]) => `<tr><td>${status}</td><td>${count}</td></tr>`)
      .join('')}
  </table>

  <h2>Recent version/config requests</h2>
  <table>
    <tr><th>Time</th><th>Path</th><th>Method</th><th>Status</th><th>Duration (ms)</th></tr>
    ${recentConfigVersionRequests.length > 0
      ? recentConfigVersionRequests
          .map((r) => `<tr><td>${r.time}</td><td>${r.path}</td><td>${r.method}</td><td>${r.status}</td><td>${r.durationMs}</td></tr>`)
          .join('')
      : '<tr><td colspan="5">No version/config requests yet.</td></tr>'}
  </table>

  <h2>Filtered request log (config/version only)</h2>
  <pre>${filteredRequestLogLines.length > 0 ? filteredRequestLogLines.join('\n') : 'No version/config request log entries yet.'}</pre>
</body>
</html>`;
  res.type('text/html').send(html);
});

function renderApiMonitorPage() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>API Monitor - AJAX Polling</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 16px; color: #222; background: #f7f9fc; }
    h1 { font-size: 26px; margin-bottom: 8px; }
    .card { background: white; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); padding: 18px; margin-bottom: 18px; }
    .card h2 { margin-top: 0; }
    label { display: block; margin: 10px 0 4px; font-weight: 600; }
    input, button { font-size: 1rem; }
    input { width: 100%; max-width: 420px; padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
    button { padding: 10px 16px; margin-right: 8px; border: none; border-radius: 6px; cursor: pointer; background: #0066cc; color: white; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .log { background: #101828; color: #e2e8f0; padding: 14px; border-radius: 8px; font-family: Menlo, Monaco, monospace; white-space: pre-wrap; max-height: 360px; overflow-y: auto; }
    .status { display: inline-block; margin: 0 0 12px; padding: 10px 14px; border-radius: 8px; background: #eef6ff; color: #0b3d91; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .summary-item { background: #f4f7fb; border-radius: 8px; padding: 12px; }
  </style>
</head>
<body>
  <h1>API Monitor</h1>
  <p class="status">Halaman ini melakukan polling AJAX ke <code>/api/config.json</code> dan <code>/api/version.json</code>.</p>
  <div class="card">
    <h2>Polling settings</h2>
    <label for="apiKey">API Key (apikey query parameter)</label>
    <input id="apiKey" type="text" placeholder="Masukkan apikey untuk /api/config.json & /api/version.json" />
    <label for="pollInterval">Interval polling (ms)</label>
    <input id="pollInterval" type="number" min="1000" value="5000" />
    <div style="margin-top: 12px;">
      <button id="startPolling">Mulai polling</button>
      <button id="stopPolling" disabled>Berhenti polling</button>
      <button id="refreshState">Refresh state sekarang</button>
    </div>
  </div>

  <div class="card">
    <h2>Polling hasil /api/config.json dan /api/version.json</h2>
    <div id="pollLog" class="log">Menunggu polling...</div>
  </div>

  <div class="card">
    <h2>Monitor server state</h2>
    <div id="stateSummary" class="summary-grid"></div>
    <h3>Log dinamis request /config.json dan /version.json</h3>
    <div id="requestLog" class="log">Menunggu data log server...</div>
  </div>

  <script>
    const apiKeyInput = document.getElementById('apiKey');
    const pollIntervalInput = document.getElementById('pollInterval');
    const startButton = document.getElementById('startPolling');
    const stopButton = document.getElementById('stopPolling');
    const refreshStateButton = document.getElementById('refreshState');
    const pollLog = document.getElementById('pollLog');
    const stateSummary = document.getElementById('stateSummary');
    const requestLog = document.getElementById('requestLog');

    let pollTimer = null;
    let stateTimer = null;
    const maxLogLines = 40;
    const appendLog = (element, text) => {
      const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
      const line = now + ' ' + text;
      const lines = element.textContent ? element.textContent.split('\n') : [];
      lines.unshift(line);
      if (lines.length > maxLogLines) lines.length = maxLogLines;
      element.textContent = lines.join('\n');
    };

    async function fetchMonitorState() {
      try {
        const resp = await fetch('/api/monitor/state', { cache: 'no-store' });
        if (!resp.ok) {
          throw new Error('Status ' + resp.status);
        }
        const data = await resp.json();
        stateSummary.innerHTML =
          '<div class="summary-item"><strong>Port</strong><div>' + data.port + '</div></div>' +
          '<div class="summary-item"><strong>Sync status</strong><div>' + data.syncStatus + '</div></div>' +
          '<div class="summary-item"><strong>Last sync</strong><div>' + (data.lastSync || 'n/a') + '</div></div>' +
          '<div class="summary-item"><strong>Next sync</strong><div>' + (data.nextSync || 'n/a') + '</div></div>' +
          '<div class="summary-item"><strong>Last sync error</strong><div>' + (data.lastSyncError || 'none') + '</div></div>' +
          '<div class="summary-item"><strong>Total requests</strong><div>' + data.requestStats.total + '</div></div>';

        const recentLines = data.filteredRequestLogLines.length > 0
          ? data.filteredRequestLogLines.slice(-20).reverse().join('\n')
          : 'Tidak ada entri log terbaru untuk /config.json atau /version.json.';
        requestLog.textContent = recentLines;
      } catch (err) {
        requestLog.textContent = 'Gagal memuat state server: ' + err.message;
      }
    }

    async function pollEndpoints() {
      const apiKey = apiKeyInput.value.trim();
      const intervalMs = Number(pollIntervalInput.value) || 5000;
      const query = apiKey ? '?apikey=' + encodeURIComponent(apiKey) : '';
      const targets = ['/api/config.json', '/api/version.json'];

      appendLog(pollLog, 'Memulai polling ' + targets.join(' dan ') + (query ? ' dengan apikey' : ' tanpa apikey'));
      const results = await Promise.all(targets.map(async (path) => {
        try {
          const response = await fetch(path + query, { cache: 'no-store' });
          const text = await response.text();
          const contentPreview = text.length > 200 ? text.slice(0, 200) + '...' : text;
          const status = response.ok ? 'OK' : 'ERR ' + response.status;
          appendLog(pollLog, path + ' -> ' + status + ' (' + response.status + ') ' + contentPreview.replace(/\n/g, ' '));
        } catch (error) {
          appendLog(pollLog, path + ' -> FETCH ERROR ' + error.message);
        }
      }));
      if (!pollTimer) {
        pollTimer = setInterval(async () => {
          await pollEndpoints();
        }, intervalMs);
      }
    }

    function startPolling() {
      if (pollTimer) return;
      pollEndpoints();
      stopButton.disabled = false;
      startButton.disabled = true;
    }

    function stopPolling() {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
      appendLog(pollLog, 'Polling dihentikan.');
      stopButton.disabled = true;
      startButton.disabled = false;
    }

    startButton.addEventListener('click', () => {
      startPolling();
    });

    stopButton.addEventListener('click', () => {
      stopPolling();
    });

    refreshStateButton.addEventListener('click', fetchMonitorState);

    window.addEventListener('load', () => {
      fetchMonitorState();
      stateTimer = setInterval(fetchMonitorState, 5000);
    });
  </script>
</body>
</html>`;
}

app.get('/api/monitor', (req, res) => {
  res.type('text/html').send(renderApiMonitorPage());
});

app.get('/api/monitor/state', (req, res) => {
  const filteredRequestLogLines = readLastRequestLogLines(50).filter((line) =>
    line.includes('/config.json') ||
    line.includes('/version.json') ||
    line.includes('/api/config.json') ||
    line.includes('/api/version.json')
  );
  res.json({
    port: PORT,
    syncStatus,
    lastSync,
    nextSync,
    lastSyncError,
    requestStats,
    filteredRequestLogLines,
  });
});

app.get('/health', async (req, res) => {
  try {
    const mysqlOk = await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      mysql: mysqlOk ? 'connected' : 'disconnected',
      syncStatus,
      lastSync,
      nextSync,
      lastSyncError,
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      mysql: 'disconnected',
      syncStatus,
      lastSync,
      lastSyncError: err.message || String(err),
    });
  }
});

async function start() {
  app.listen(PORT, () => {
    const startMessage = `JSON server running on port ${PORT}`;
    console.log(startMessage);
    writeLog(startMessage);
  });
  await syncFromDatabase();
}

start().catch((error) => {
  const errText = `Server start error: ${error.message || error}`;
  console.error(errText);
  writeLog(errText);
  process.exit(1);
});
