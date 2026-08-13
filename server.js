'use strict';

/* ============================================================
 * Servidor local del escáner de QR.
 * - Sirve la app estática (webcam + jsQR).
 * - Proxy de /api/scan hacia la API de sage-gestion (POST /guest/scan),
 *   inyectando el secreto compartido (header X-Scanner-Secret) del lado
 *   del servidor, para que el secreto no quede expuesto en el navegador.
 *
 * Variables de entorno (archivo .env en esta carpeta):
 *   SCANNER_SHARED_SECRET  → secreto compartido con la API de sage
 *   SAGE_API_URL           → URL base de la API (default http://localhost:3000)
 *   PORT                   → puerto de este servidor (default 8080)
 * ============================================================ */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Cargar .env si existe (Node >= 20.6 usa process.loadEnvFile).
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
} catch (e) {
  /* sin .env: se usan las variables ya presentes en el entorno */
}

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const APP_URL = `http://localhost:${PORT}`;
const SAGE_API_URL = (process.env.SAGE_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const SHARED_SECRET = process.env.SCANNER_SHARED_SECRET || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Lee el body de un request POST.
function readBody(req, cb) {
  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => cb(data));
  req.on('error', () => cb(null));
}

// Proxy: POST /api/scan  →  POST {SAGE_API_URL}/guest/scan  (con secreto).
function proxyScan(req, res) {
  readBody(req, (body) => {
    const target = SAGE_API_URL + '/guest/scan';
    let upstream;
    try {
      upstream = new URL(target);
    } catch (e) {
      return sendJson(res, 500, {
        statusCode: 500,
        message: 'SAGE_API_URL inválida: ' + target,
        error: (e && e.message) || String(e),
        target: target,
      });
    }
    const lib = upstream.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    if (SHARED_SECRET) headers['X-Scanner-Secret'] = SHARED_SECRET;

    const upstreamReq = lib.request({
      host: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: upstream.pathname + upstream.search,
      method: 'POST',
      headers,
    }, (upstreamRes) => {
      let data = '';
      upstreamRes.on('data', (chunk) => { data += chunk; });
      upstreamRes.on('end', () => {
        res.writeHead(upstreamRes.statusCode || 502, {
          'Content-Type': upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
        });
        res.end(data);
      });
    });

    upstreamReq.on('error', (err) => {
      sendJson(res, 502, {
        statusCode: 502,
        message: 'No se pudo conectar con la API de sage (' + target + '): ' + err.message,
      });
    });

    upstreamReq.end(body);
  });
}

// Verifica si la API de sage responde (GET /).
function checkSageReachable(cb) {
  if (!SHARED_SECRET) return cb(false);
  let upstream;
  try {
    upstream = new URL(SAGE_API_URL + '/');
  } catch (e) {
    return cb(false);
  }
  const lib = upstream.protocol === 'https:' ? https : http;
  const req = lib.request({
    host: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    path: upstream.pathname + upstream.search,
    method: 'GET',
    timeout: 1500,
  }, (res) => {
    const ok = res.statusCode >= 200 && res.statusCode < 500;
    res.resume();
    cb(ok);
  });
  req.on('error', () => cb(false));
  req.on('timeout', () => { req.destroy(); cb(false); });
  req.end();
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (req.method === 'POST' && urlPath === '/api/scan') {
    return proxyScan(req, res);
  }

  if (req.method === 'GET' && urlPath === '/api/config') {
    return checkSageReachable((reachable) => {
      sendJson(res, 200, {
        apiUrl: SAGE_API_URL,
        secretConfigured: Boolean(SHARED_SECRET),
        connected: Boolean(SHARED_SECRET) && reachable,
      });
    });
  }

  let filePath = urlPath;
  if (filePath === '/') filePath = '/index.html';

  const fullPath = path.normalize(path.join(ROOT, filePath));

  // Protección contra path traversal.
  if (!fullPath.startsWith(ROOT + path.sep) && fullPath !== ROOT) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

// Abre el navegador automáticamente al levantar el servidor.
function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log('  No pude abrir el navegador automáticamente.');
      console.log('  Abrí manualmente: ' + url);
    }
  });
}

// Mensaje claro si el puerto ya está ocupado.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('❌ El puerto ' + PORT + ' ya está en uso.');
    console.error('   - Si el escáner ya está corriendo, abrí ' + APP_URL);
    console.error('   - Para liberar el puerto:');
    console.error('       netstat -ano | findstr :' + PORT);
    console.error('       taskkill /F /PID <PID>');
    console.error('   - O usá otro puerto:  PORT=8081 npm start');
  } else {
    console.error('Error del servidor:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('==================================================');
  console.log('  Escáner de QR en ejecución:');
  console.log('  ' + APP_URL);
  console.log('  API de sage: ' + SAGE_API_URL);
  console.log('  Secreto compartido: ' + (SHARED_SECRET ? 'configurado ✓' : 'NO configurado ✗'));
  console.log('  Abriendo el navegador…  (Ctrl+C para detener)');
  console.log('==================================================');
  openBrowser(APP_URL);
});
