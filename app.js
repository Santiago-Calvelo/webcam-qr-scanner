'use strict';

/* ============================================================
 * Escáner de QR con webcam (UI en el navegador)
 * - Captura video de la webcam vía getUserMedia
 * - Decodifica QR en tiempo real con jsQR
 * - Muestra el token decodificado en la UI
 *
 * La integración con la API de sage-gestion (POST /guest/scan)
 * queda para un paso posterior.
 * ============================================================ */

// --- Referencias DOM ---
const video = document.getElementById('video');
const canvas = document.getElementById('scan-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const videoWrap = document.getElementById('video-wrap');
const placeholder = document.getElementById('video-placeholder');
const videoError = document.getElementById('video-error');
const cameraSelect = document.getElementById('camera-select');
const toggleBtn = document.getElementById('toggle-scan');
const statusEl = document.getElementById('status');
const lastTokenEl = document.getElementById('last-token');
const lastTokenRawEl = document.getElementById('last-token-raw');
const copyBtn = document.getElementById('copy-token');
const clearBtn = document.getElementById('clear-list');
const historyList = document.getElementById('history-list');
const historyCount = document.getElementById('history-count');
const previewCanvas = document.getElementById('preview-canvas');
const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
const debugFpsEl = document.getElementById('debug-fps');
const debugResEl = document.getElementById('debug-res');
const debugStateEl = document.getElementById('debug-state');
const testImageBtn = document.getElementById('test-image');
const imageInput = document.getElementById('image-input');
const resultCard = document.getElementById('result-card');
const resultStatus = document.getElementById('result-status');
const resultGuest = document.getElementById('result-guest');
const resultDetail = document.getElementById('result-detail');
const resultState = document.getElementById('result-state');
const resultMessage = document.getElementById('result-message');
const sageStatusEl = document.getElementById('sage-status');
const historyCard = document.getElementById('history-card');

// --- Estado ---
let stream = null;
let scanning = false;
let decodeTimer = null;        // timer del loop de decodificación
let lastToken = null;
const history = [];            // resultado de cada escaneo (respuesta del back)
let lastSeenToken = null;      // dedup: ignorar mientras el mismo QR siga en pantalla
let lastSeenAt = 0;
let scanBusy = false;          // evita disparar dos escaneos a la vez
let connected = false;         // ¿sage está conectado? define Respuesta/Historial

const MAX_HISTORY = 200;

// Etiquetas y colores para estados/movimientos de sage.
const STATE_LABELS = {
  NOT_ARRIVED: { label: 'No llegó', cls: 'state-notarrived' },
  INSIDE: { label: 'Dentro', cls: 'state-inside' },
  OUTSIDE: { label: 'Fuera', cls: 'state-outside' },
};
const MOVEMENT_LABELS = {
  ENTRY: { label: 'ENTRADA', cls: 'movement-entry' },
  EXIT: { label: 'SALIDA', cls: 'movement-exit' },
};
const MAX_SCAN_WIDTH = 1280;   // resolución máxima del frame a analizar
const DECODE_INTERVAL_MS = 100; // frecuencia de análisis (~10 fps)

// --- Canvas temporal (preview y prueba con imagen) ---
const tmpCanvas = document.createElement('canvas');
const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });

// --- Métricas de diagnóstico ---
let fpsCount = 0;
let fpsTimer = null;

// --- Feedback sonoro ---
let audioCtx = null;
function beep(ok = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = ok ? 1200 : 300;
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.16);
  } catch (e) {
    /* sin audio disponible: no es crítico */
  }
}

// --- Utilidades ---
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

// Extrae el token: si el texto es una URL, toma el último segmento de la ruta
// (misma lógica que la API de sage-gestion en guest.service.ts).
function extractToken(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.length ? segments[segments.length - 1] : trimmed;
  } catch {
    return trimmed;
  }
}

function formatTime(d) {
  return d.toLocaleTimeString('es-AR', { hour12: false });
}

function flashFrame(kind = 'ok') {
  const cls = kind === 'error' ? 'flash-error' : 'flash';
  videoWrap.classList.add(cls);
  setTimeout(() => videoWrap.classList.remove(cls), 600);
}

function renderHistory() {
  historyCount.textContent = String(history.length);
  historyList.innerHTML = '';
  history.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'history-item';

    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = item.time;

    const main = document.createElement('span');
    main.className = 'history-main';

    const who = document.createElement('span');
    who.className = 'history-who';
    who.textContent = item.guestName || item.token;
    who.title = item.raw;
    main.appendChild(who);

    if (item.ok) {
      const mv = MOVEMENT_LABELS[item.movement] || { label: item.movement || '', cls: '' };
      if (mv.label) {
        const b = document.createElement('span');
        b.className = 'badge-pill ' + mv.cls;
        b.textContent = mv.label;
        main.appendChild(b);
      }
      const st = STATE_LABELS[item.state] || { label: item.state || '', cls: '' };
      if (st.label) {
        const b = document.createElement('span');
        b.className = 'badge-pill ' + st.cls;
        b.textContent = st.label;
        main.appendChild(b);
      }
    } else {
      const b = document.createElement('span');
      b.className = 'badge-pill badge-error';
      b.textContent = item.status === 401 ? 'NO AUTORIZADO'
        : item.status === 0 ? 'API OFF'
        : 'RECHAZADO';
      main.appendChild(b);
    }

    li.appendChild(time);
    li.appendChild(main);
    historyList.appendChild(li);
  });
}

function onDecode(raw) {
  const token = extractToken(raw);
  if (!token) return;

  const now = Date.now();

  // Ignorar mientras el mismo QR siga en pantalla (evita disparar muchas veces).
  if (token === lastSeenToken) {
    lastSeenAt = now;
    return;
  }
  lastSeenToken = token;
  lastSeenAt = now;

  lastToken = token;
  lastTokenEl.textContent = token;
  lastTokenRawEl.textContent = token === raw ? '' : raw;
  copyBtn.disabled = false;

  scanGuest(token, raw);
}

// --- Integración con la API de sage ---
function extractErrorMessage(body) {
  if (!body) return 'Error desconocido';
  const m = body.message;
  if (Array.isArray(m)) return m.join('; ');
  if (typeof m === 'string' && m) return m;
  if (body.error) return body.error;
  return 'Error ' + (body.statusCode || 'desconocido');
}

function friendlyApiError(status, rawMessage) {
  const m = String(rawMessage || '');
  if (status === 0) return m;
  if (status === 401) return 'No autorizado (401): el secreto compartido no coincide o no está configurado en la API.';
  if (status === 404) return 'Token no encontrado: el invitado no existe o el QR no fue emitido.';
  if (status === 400) return 'Solicitud inválida: ' + m;
  if (m.includes('revoked')) return 'QR revocado.';
  if (m.includes('expired')) return 'QR expirado.';
  if (m.includes('not issued')) return 'QR no emitido todavía.';
  if (m.includes('Re-entry')) return 'Reingreso no permitido: pasó la ventana de 1 hora.';
  if (m.includes('changed by another')) return 'Conflicto: el estado cambió por otro escaneo simultáneo.';
  if (m.includes('Invalid presence')) return 'Conflicto: estado de presencia inválido.';
  return m || ('Error ' + status);
}

function renderResultIdle(msg) {
  resultCard.className = 'card result';
  resultStatus.textContent = msg || 'Sin escaneos todavía';
  resultGuest.textContent = '';
  resultDetail.textContent = '';
  resultState.innerHTML = '';
  resultMessage.textContent = '';
}

function renderSuccessResult(data) {
  const mv = MOVEMENT_LABELS[data.movement] || { label: data.movement || '', cls: '' };
  const st = STATE_LABELS[data.presenceStatus] || { label: data.presenceStatus || '', cls: '' };
  resultCard.className = 'card result result-ok';
  resultStatus.textContent = mv.label === 'ENTRADA' ? '✅ ENTRADA PERMITIDA' : '🚪 SALIDA REGISTRADA';
  resultGuest.textContent = (data.guest && data.guest.name ? data.guest.name : '') +
    (data.guest && data.guest.email ? ' · ' + data.guest.email : '');
  resultDetail.textContent = data.event && data.event.title ? 'Evento: ' + data.event.title : '';
  resultState.innerHTML = 'Estado resultante: <span class="badge-pill ' + st.cls + '">' + st.label + '</span>';
  resultMessage.textContent = 'Movimiento: ' + mv.label + ' · ' + formatTime(new Date(data.occurredAt));
}

function renderErrorResult(status, rawMessage) {
  resultCard.className = 'card result result-error';
  resultStatus.textContent = status === 401 ? '🔒 NO AUTORIZADO'
    : status === 0 ? '🔌 SIN CONEXIÓN'
    : '❌ ACCESO RECHAZADO';
  resultGuest.textContent = '';
  resultDetail.textContent = '';
  resultState.innerHTML = '';
  resultMessage.textContent = friendlyApiError(status, rawMessage);
}

async function scanGuest(token, raw) {
  if (scanBusy) return;
  if (!connected) return; // sin conexión: no hay respuesta ni historial
  scanBusy = true;
  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qrToken: token }),
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }

    const item = {
      token,
      raw,
      time: formatTime(new Date()),
      ok: res.ok,
      status: res.status,
      guestName: body && body.guest ? body.guest.name : '',
      email: body && body.guest ? body.guest.email : '',
      eventTitle: body && body.event ? body.event.title : '',
      movement: body ? body.movement : '',
      state: body ? body.presenceStatus : '',
      message: res.ok ? '' : extractErrorMessage(body),
    };

    if (res.ok && body) {
      renderSuccessResult(body);
      beep(true);
      flashFrame('ok');
    } else {
      renderErrorResult(res.status, item.message);
      beep(false);
      flashFrame('error');
    }

    history.unshift(item);
    if (history.length > MAX_HISTORY) history.pop();
    renderHistory();
  } catch (e) {
    const item = {
      token,
      raw,
      time: formatTime(new Date()),
      ok: false,
      status: 0,
      guestName: '',
      email: '',
      eventTitle: '',
      movement: '',
      state: '',
      message: 'No se pudo conectar con /api/scan: ' + (e && e.message ? e.message : e),
    };
    renderErrorResult(0, item.message);
    beep(false);
    flashFrame('error');
    history.unshift(item);
    if (history.length > MAX_HISTORY) history.pop();
    renderHistory();
  } finally {
    scanBusy = false;
  }
}

// --- Estado de conexión con sage ---
function setSageConnected(isConnected) {
  connected = isConnected;
  sageStatusEl.classList.toggle('sage-on', isConnected);
  sageStatusEl.classList.toggle('sage-off', !isConnected);
  sageStatusEl.title = isConnected ? 'Conectado a sage' : 'Sin conexión con sage';
  resultCard.hidden = !isConnected;
  historyCard.hidden = !isConnected;
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    setSageConnected(Boolean(cfg.connected));
  } catch (e) {
    setSageConnected(false);
  }
}

function startConfigPolling() {
  loadConfig();
  setInterval(loadConfig, 4000);
}

// --- Cámara ---
async function refreshCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    cameraSelect.innerHTML = '';
    cams.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Cámara ${i + 1}`;
      cameraSelect.appendChild(opt);
    });
    cameraSelect.disabled = cams.length === 0;
    return cams;
  } catch (e) {
    return [];
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
}

function friendlyError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Permiso de cámara denegado.\nAutorizá el acceso a la cámara en el navegador y recargá.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No se encontró ninguna cámara conectada.\nConectá una webcam y recargá.';
    case 'NotReadableError':
      return 'La cámara está en uso por otra aplicación.\nCerrá las apps que usan la cámara y reintentá.';
    default:
      return 'No se pudo acceder a la cámara: ' + (err ? err.message : 'error desconocido') +
        '\n\nNota: la webcam requiere un contexto seguro. Usá la URL http://localhost:8080 (npm start).';
  }
}

async function startCamera(deviceId) {
  stopCamera();

  const videoConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  };
  if (deviceId) {
    videoConstraints.deviceId = { exact: deviceId };
  } else {
    videoConstraints.facingMode = 'environment';
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    placeholder.style.display = 'none';
    videoWrap.classList.add('active');
    videoError.textContent = '';
    return true;
  } catch (err) {
    videoError.textContent = friendlyError(err);
    placeholder.style.display = 'flex';
    videoWrap.classList.remove('active');
    setStatus('Error', 'status-error');
    return false;
  }
}

// --- Escaneo ---
async function startScanning() {
  if (!stream) {
    const ok = await startCamera(cameraSelect.value);
    if (!ok) return;
  }
  scanning = true;
  toggleBtn.textContent = 'Detener';
  setStatus('Escaneando…', 'status-scanning');
  fpsTimer = null;
  fpsCount = 0;
  decodeTimer = setInterval(processFrame, DECODE_INTERVAL_MS);
}

function stopScanning() {
  scanning = false;
  if (decodeTimer) clearInterval(decodeTimer);
  decodeTimer = null;
  toggleBtn.textContent = 'Iniciar';
  setStatus('Detenido', 'status-idle');
}

async function toggleScan() {
  if (scanning) {
    stopScanning();
  } else {
    await startScanning();
  }
}

// Convierte un frame a escala de grises (ayuda en QR de bajo contraste).
function toGrayscale(imageData) {
  const d = imageData.data;
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const gray = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    out[i] = gray;
    out[i + 1] = gray;
    out[i + 2] = gray;
    out[i + 3] = 255;
  }
  return out;
}

// Prueba varias estrategias de decodificación sobre un mismo frame.
function decodeFrame(imageData) {
  const strategies = [
    { data: imageData.data, invert: 'attemptBoth' },
    { data: toGrayscale(imageData), invert: 'attemptBoth' },
  ];
  for (const s of strategies) {
    try {
      const code = jsQR(s.data, imageData.width, imageData.height, {
        inversionAttempts: s.invert,
      });
      if (code && code.data) return code;
    } catch (e) {
      /* ignorar estrategia fallida */
    }
  }
  return null;
}

function drawPreview(imageData) {
  tmpCanvas.width = imageData.width;
  tmpCanvas.height = imageData.height;
  tmpCtx.putImageData(imageData, 0, 0);
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  previewCtx.drawImage(tmpCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
}

function updateDebug(w, h, detected) {
  fpsCount++;
  const now = performance.now();
  if (!fpsTimer) fpsTimer = now;
  const elapsed = now - fpsTimer;
  if (elapsed >= 1000) {
    debugFpsEl.textContent = 'FPS: ' + Math.round((fpsCount * 1000) / elapsed);
    fpsCount = 0;
    fpsTimer = now;
  }
  debugResEl.textContent = 'Frame: ' + w + 'x' + h;
  debugStateEl.textContent = detected ? 'QR detectado ✓' : 'Buscando QR…';
  debugStateEl.className = detected ? 'debug-ok' : 'debug-wait';
}

function processFrame() {
  if (!scanning) return;

  if (video.readyState >= 2 && video.videoWidth > 0) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // 1) Pasada a resolución completa (limitada a MAX_SCAN_WIDTH).
    const scale = Math.min(1, MAX_SCAN_WIDTH / vw);
    let w = Math.round(vw * scale);
    let h = Math.round(vh * scale);

    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    ctx.drawImage(video, 0, 0, w, h);
    let imageData = ctx.getImageData(0, 0, w, h);
    let code = decodeFrame(imageData);

    // 2) Si falla, pasada reducida (más tolerante a ruido/desenfoque).
    if (!code && w > 640) {
      const s2 = 640 / vw;
      const w2 = Math.round(vw * s2);
      const h2 = Math.round(vh * s2);
      if (canvas.width !== w2) canvas.width = w2;
      if (canvas.height !== h2) canvas.height = h2;
      ctx.drawImage(video, 0, 0, w2, h2);
      imageData = ctx.getImageData(0, 0, w2, h2);
      code = decodeFrame(imageData);
    }

    drawPreview(imageData);
    updateDebug(imageData.width, imageData.height, !!code);

    if (code && code.data) {
      onDecode(code.data);
    } else if (lastSeenToken && Date.now() - lastSeenAt > 400) {
      // El QR salió del encuadre: habilitar una nueva lectura del mismo token.
      lastSeenToken = null;
    }
  }
}

// --- Acciones de UI ---
copyBtn.addEventListener('click', async () => {
  if (!lastToken) return;
  try {
    await navigator.clipboard.writeText(lastToken);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = lastToken;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copyBtn.textContent = '¡Copiado!';
  setTimeout(() => (copyBtn.textContent = 'Copiar token'), 1200);
});

clearBtn.addEventListener('click', () => {
  history.length = 0;
  renderHistory();
});

toggleBtn.addEventListener('click', toggleScan);

cameraSelect.addEventListener('change', async () => {
  // Si hay varias cámaras, al cambiar reiniciamos la captura con la elegida.
  if (stream || scanning) {
    await startCamera(cameraSelect.value);
    if (scanning) {
      clearInterval(decodeTimer);
      decodeTimer = setInterval(processFrame, DECODE_INTERVAL_MS);
    }
  }
});

// --- Prueba con imagen (diagnóstico: ¿es el QR o la cámara?) ---
function decodeImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    tmpCanvas.width = img.width;
    tmpCanvas.height = img.height;
    tmpCtx.drawImage(img, 0, 0);
    const imageData = tmpCtx.getImageData(0, 0, tmpCanvas.width, tmpCanvas.height);
    const code = decodeFrame(imageData);
    if (code && code.data) {
      onDecode(code.data);
      debugStateEl.textContent = 'Imagen: QR detectado ✓';
      debugStateEl.className = 'debug-ok';
    } else {
      debugStateEl.textContent = 'Imagen: no se detectó QR';
      debugStateEl.className = 'debug-wait';
    }
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    debugStateEl.textContent = 'Imagen: no se pudo cargar';
    debugStateEl.className = 'debug-wait';
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

testImageBtn.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  const file = imageInput.files && imageInput.files[0];
  if (file) decodeImageFile(file);
  imageInput.value = '';
});

// --- Inicialización ---
async function init() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    videoError.textContent =
      'Este navegador no soporta acceso a la webcam.\nUsá Chrome, Edge o Firefox.';
    placeholder.style.display = 'flex';
    return;
  }
  if (typeof jsQR === 'undefined') {
    videoError.textContent = 'No se pudo cargar la librería jsQR (jsqr.js).';
    placeholder.style.display = 'flex';
    return;
  }

  startConfigPolling();
  await refreshCameras();
  toggleBtn.disabled = false;

  // Arrancar automáticamente con la cámara por defecto.
  const ok = await startCamera(cameraSelect.value);
  await refreshCameras(); // re-enumerar para tener labels reales
  if (ok) {
    await startScanning();
  }
}

init();
