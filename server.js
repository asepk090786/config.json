// Express server that serves config.json and version.json from MySQL cbt_json_history.
// Local files are updated only when the DB history version differs.
const fs = require('fs');
const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const app = express();
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

const appSettings = loadAppSettings();

app.use((req, res, next) => {
  const startTime = Date.now();
  const pathName = req.path;
  const trackPaths = ['/config.json', '/version.json', '/monitor', '/health'];
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
const DB_HOST = process.env.DB_HOST || appSettings.db?.host || '16.78.150.150';
const DB_PORT = process.env.DB_PORT || appSettings.db?.port || 3306;
const DB_DATABASE = process.env.DB_DATABASE || appSettings.db?.database || 'garudacbt';
const DB_USER = process.env.DB_USERNAME || process.env.DB_USER || appSettings.db?.user || 'papah';
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.DB_PASS || appSettings.db?.password || 'adminkece';

const SYNC_MIN_SECONDS = Number(process.env.SYNC_MIN_SECONDS || appSettings.syncMinSeconds || 5);
const SYNC_MAX_SECONDS = Number(process.env.SYNC_MAX_SECONDS || appSettings.syncMaxSeconds || 10);

const SCHOOL_NAME = process.env.SCHOOL_NAME || 'SMA NEGERI 1 PONTANG';
const DESCRIPTION = process.env.SCHOOL_DESCRIPTION || 'Konfigurasi CBT SMA NEGERI 1 PONTANG';
const BASE_URL = process.env.BASE_URL || appSettings.baseUrl || 'https://token.belajar2026.net';
const LOG_FILE = process.env.LOG_FILE || appSettings.logFile || 'sync.log';
const REQUEST_LOG_FILE = process.env.REQUEST_LOG_FILE || 'request.log';

const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_DATABASE,
  user: DB_USER,
  password: DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
});

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

app.get('/monitor', async (req, res) => {
  const requestLogLines = readLastRequestLogLines(50);
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

  <h2>Response status codes</h2>
  <table>
    <tr><th>Status</th><th>Count</th></tr>
    ${Object.entries(requestStats.statusCodes)
      .map(([status, count]) => `<tr><td>${status}</td><td>${count}</td></tr>`)
      .join('')}
  </table>

  <h2>Recent API requests</h2>
  <table>
    <tr><th>Time</th><th>Path</th><th>Method</th><th>Status</th><th>Duration (ms)</th></tr>
    ${requestStats.lastRequests.slice(0, 50)
      .map(r => `<tr><td>${r.time}</td><td>${r.path}</td><td>${r.method}</td><td>${r.status}</td><td>${r.durationMs}</td></tr>`)
      .join('')}
  </table>

  <h2>Request log</h2>
  <pre>${requestLogLines.length > 0 ? requestLogLines.join('\n') : 'No request log entries yet.'}</pre>
</body>
</html>`;
  res.type('text/html').send(html);
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
