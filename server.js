// server.js

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const httpModule = require('http');
const httpsModule = require('https');
const Datastore = require('nedb');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net'); 
const fs = require('fs');
require('dotenv').config();
const mqtt = require('mqtt');
const sharp = require("sharp");
const { WebSocketServer } = require('ws');

const DB_BASE_DIR = process.env.DOZZPLATE_DB_DIR
  ? path.resolve(process.env.DOZZPLATE_DB_DIR)
  : __dirname;
const DOZZPLATE_PYTHON_CANDIDATES = [
  process.env.DOZZPLATE_PYTHON,
  path.join(__dirname, 'venv', 'bin', 'python3'),
  path.join(__dirname, 'venv', 'bin', 'python'),
  'python3',
];
const PYTHON_BIN = DOZZPLATE_PYTHON_CANDIDATES.find((candidate) => {
  if (!candidate) return false;
  if (candidate === 'python3') return true;
  return fs.existsSync(candidate);
}) || 'python3';

function resolveDbFile(fileName) {
  return path.join(DB_BASE_DIR, fileName);
}

const INTERNAL_SOCKET_TOKEN = process.env.INTERNAL_SOCKET_TOKEN || null;
const SHARED_PLATE_BATCH_ENABLED = (process.env.SHARED_PLATE_BATCH_ENABLED || 'true').trim().toLowerCase() !== 'false';
const SHARED_PLATE_BATCH_IDLE_STOP_MS = Number.isFinite(Number(process.env.SHARED_PLATE_BATCH_IDLE_STOP_MS))
  ? Math.max(0, Number(process.env.SHARED_PLATE_BATCH_IDLE_STOP_MS))
  : 3000;
const PLATE_SYNC_REQUIRE_TOKEN = (process.env.PLATE_SYNC_REQUIRE_TOKEN || 'false').trim().toLowerCase() === 'true';
const MG300_TCP_PORT = 9000;
const MG300_GATEWAY_ENABLED = parseStoredBoolean(process.env.MG300_GATEWAY_ENABLED, true);
const MG300_GATEWAY_PORT = Number.isFinite(Number(process.env.MG300_GATEWAY_PORT))
  ? Math.max(1, Number(process.env.MG300_GATEWAY_PORT))
  : 9001;
const MG300_GATEWAY_EVENT_FORWARD_TOKEN = String(process.env.MG300_GATEWAY_EVENT_FORWARD_TOKEN || '').trim();
const MG300_SOCKET_TIMEOUT_MS = Number.isFinite(Number(process.env.MG300_SOCKET_TIMEOUT_MS))
  ? Math.max(500, Number(process.env.MG300_SOCKET_TIMEOUT_MS))
  : 3000;
const MG300_MAX_RETRIES = Number.isFinite(Number(process.env.MG300_MAX_RETRIES))
  ? Math.max(1, Number(process.env.MG300_MAX_RETRIES))
  : 5;
const MG300_RETRY_BASE_DELAY_MS = Number.isFinite(Number(process.env.MG300_RETRY_BASE_DELAY_MS))
  ? Math.max(100, Number(process.env.MG300_RETRY_BASE_DELAY_MS))
  : 400;
const MG300_MIN_COMMAND_GAP_MS = Number.isFinite(Number(process.env.MG300_MIN_COMMAND_GAP_MS))
  ? Math.max(0, Number(process.env.MG300_MIN_COMMAND_GAP_MS))
  : 150;
const VIDEO_DELIVERY_MODE = (process.env.VIDEO_DELIVERY_MODE || 'mpegts').trim().toLowerCase();
const VIDEO_SOCKET_FALLBACK = (process.env.VIDEO_SOCKET_FALLBACK || 'true').trim().toLowerCase() !== 'false';
const MEDIA_STREAM_PATH_TEMPLATE = process.env.MEDIA_STREAM_PATH_TEMPLATE || '{channelId}';
const MPEGTS_WS_ENABLED = (process.env.MPEGTS_WS_ENABLED || 'true').trim().toLowerCase() !== 'false';
const MPEGTS_DEFAULT_FPS = Number.isFinite(Number(process.env.MPEGTS_DEFAULT_FPS))
  ? Math.max(1, Number(process.env.MPEGTS_DEFAULT_FPS))
  : 12;
const MPEGTS_BITRATE_KBPS = Number.isFinite(Number(process.env.MPEGTS_BITRATE_KBPS))
  ? Math.max(400, Number(process.env.MPEGTS_BITRATE_KBPS))
  : 1600;
const MPEGTS_QUALITY = Number.isFinite(Number(process.env.MPEGTS_QUALITY))
  ? Math.min(31, Math.max(2, Number(process.env.MPEGTS_QUALITY)))
  : 6;
const MPEGTS_IDLE_STOP_MS = Number.isFinite(Number(process.env.MPEGTS_IDLE_STOP_MS))
  ? Math.max(1000, Number(process.env.MPEGTS_IDLE_STOP_MS))
  : 8000;
const MPEGTS_STDIN_MAX_BUFFER_BYTES = Number.isFinite(Number(process.env.MPEGTS_STDIN_MAX_BUFFER_BYTES))
  ? Math.max(32768, Number(process.env.MPEGTS_STDIN_MAX_BUFFER_BYTES))
  : 1024 * 1024;
const MPEGTS_WS_PREFIX = '/ws/mpegts/';
const PLATE_DEBUG_ENABLED = (process.env.PLATE_DEBUG || 'false').trim().toLowerCase() === 'true';
const FRAME_DEBUG_INTERVAL_MS = Number.isFinite(Number(process.env.FRAME_DEBUG_INTERVAL_MS))
  ? Math.max(1000, Number(process.env.FRAME_DEBUG_INTERVAL_MS))
  : 10000;
const frameTrafficStats = new Map();
const noConsumerLogAt = new Map();

function debugLog(...args) {
  if (!PLATE_DEBUG_ENABLED) return;
  console.log('[PLATE_DEBUG]', ...args);
}

function shouldRateLog(map, key, intervalMs = 10000) {
  const now = Date.now();
  const last = map.get(key) || 0;
  if (now - last < intervalMs) return false;
  map.set(key, now);
  return true;
}

function parseStoredBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') {
    return Boolean(defaultValue);
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return Boolean(defaultValue);
}

function normalizeDurationMs(value, defaultValue = 15000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(1000, Math.min(10 * 60 * 1000, Math.round(parsed)));
}

// opcional: restringe processos internos por IP (loopback)
function isLoopback(addr = "") {
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("::ffff:127.0.0.1");
}

// Configuração do body-parser
// Configuração do body-parser
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Inicialização dos bancos de dados
const settingsDb = new Datastore({ filename: resolveDbFile('settings.db'), autoload: true });
const actionsDb = new Datastore({ filename: resolveDbFile('actions.db'), autoload: true });
const areasDb = new Datastore({ filename: resolveDbFile('areas.db'), autoload: true });
const directionsDb = new Datastore({ filename: resolveDbFile('directions.db'), autoload: true });
const mg3000Db = new Datastore({ filename: resolveDbFile('mg3000.db'), autoload: true });
const interlocksDb = new Datastore({ filename: resolveDbFile('interlocks.db'), autoload: true });
const platesDb = new Datastore({ filename: resolveDbFile('plates.db'), autoload: true });
const eventsDb = new Datastore({ filename: resolveDbFile('events.db'), autoload: true });

const session = require('express-session');

// >>> LOGIN FIXO (você pediu hardcoded) <<<<
const AUTH_USER = 'admin';
const AUTH_PASS = 'admin';

// Se estiver atrás de proxy (Nginx/Cloudflare) e usando HTTPS, isso é essencial:
app.set('trust proxy', 1);

const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'; // true em HTTPS
const COOKIE_SAMESITE = COOKIE_SECURE ? 'none' : 'lax';

// Session middleware (precisa vir antes das rotas protegidas)
const sessionMiddleware = session({
  name: 'dozz.sid',
  secret: process.env.SESSION_SECRET || 'change-this-secret-now', // troque em produção
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: COOKIE_SAMESITE,
    secure: COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 8, // 8h
  }
});

app.use(sessionMiddleware);

const io = require('socket.io')(http, {
  cors: {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    methods: ["GET", "POST"],
    credentials: true,
  }
});

// Compartilhar sessão do Express com o Socket.IO (engine-level: req/res reais)
io.engine.use(sessionMiddleware);

// Bloquear conexões não autenticadas
io.use((socket, next) => {
  // 1) Browser autenticado via sessão
  if (socket.request?.session?.auth === true) return next();

  // 2) Cliente interno autenticado via token no handshake
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.["x-internal-token"] ||
    socket.handshake.query?.token;

  if (INTERNAL_SOCKET_TOKEN && token === INTERNAL_SOCKET_TOKEN) {
    // opcional: só aceitar token vindo do loopback
    const addr = socket.handshake.address || socket.conn?.remoteAddress || "";
    if (!isLoopback(addr)) {
      return next(new Error("unauthorized"));
    }

    socket.isInternal = true;
    return next();
  }

  return next(new Error("unauthorized"));
});

// -------------------- MQTT (Radar Speed) --------------------

const mqttClient = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
});

// ---- Mapeamento radarId <-> channelId e controle de inscrições MQTT ----
const radarIdToChannel = new Map();     // radarId -> channelId
const subscribedRadars = new Set();     // conjunto de radarIds já inscritos

function topicsForRadar(radarId) {
  return {
    readSpeed:  `readSpeed-${radarId}`,
    dozzspeed:  `dozzspeed-${radarId}`,
    settings:   `settings-${radarId}`,
  };
}

function ensureRadarSubscription(radarId) {
  if (!radarId) return;
  if (!mqttClient.connected) {
    // Quando reconectar, o on('connect') re-inscreve tudo de subscribedRadars
    subscribedRadars.add(radarId);
    return;
  }
  if (subscribedRadars.has(radarId)) return;

  const { readSpeed, dozzspeed, settings } = topicsForRadar(radarId);

  mqttClient.subscribe(readSpeed,  (err) => {
    if (!err) console.log('[MQTT] subscribed:', readSpeed);
  });
  mqttClient.subscribe(dozzspeed,  (err) => {
    if (!err) console.log('[MQTT] subscribed:', dozzspeed);
  });
  mqttClient.subscribe(settings,   (err) => {
    if (!err) console.log('[MQTT] subscribed:', settings);
  });

  subscribedRadars.add(radarId);
}

mqttClient.on('connect', () => {
  console.log('[MQTT] conectado (Dozz Vision/Speed).');

  // Reinscreve todos os radares que já conhecemos (útil em reconexões)
  for (const radarId of subscribedRadars) {
    const { readSpeed, dozzspeed, settings } = topicsForRadar(radarId);

    mqttClient.subscribe(readSpeed,  (err) => {
      if (!err) console.log('[MQTT] subscribed (reconnect):', readSpeed);
    });
    mqttClient.subscribe(dozzspeed,  (err) => {
      if (!err) console.log('[MQTT] subscribed (reconnect):', dozzspeed);
    });
    mqttClient.subscribe(settings,   (err) => {
      if (!err) console.log('[MQTT] subscribed (reconnect):', settings);
    });
  }
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] erro:', err.message);
});

mqttClient.on('message', (topic, payload) => {
  const text = payload.toString();
  console.log(`[MQTT] ${topic}: ${text}`);

  // Tratamento de readSpeed-<radarId>
  if (topic.startsWith('readSpeed-')) {
    const radarId = topic.substring('readSpeed-'.length);
    const speed = Number(text);
    if (!Number.isFinite(speed)) {
      console.warn('[SPEED] Payload inválido em', topic, ':', text);
      return;
    }

    const channelId = radarIdToChannel.get(radarId);
    if (!channelId) {
      console.warn(`[SPEED] Chegou leitura de ${topic} (radarId=${radarId}) mas não há canal associado.`);
      return;
    }

    handleSpeedReading(channelId, radarId, speed, Date.now());
  }

  // (Se quiser, aqui você pode tratar outros tópicos, ex: dozzspeed-<radarId> para log, etc.)

  // repassa para todos os browsers via Socket.IO
  io.emit('mqtt', {
    type: 'mqtt',
    topic,
    payload: text,
    ts: Date.now(),
  });
});

// Dicionário para armazenar processos ativos por canal
let processes = {};
let plateBatchWorkerProcess = null;
let plateBatchWorkerStdoutBuffer = '';
let plateBatchIdleTimer = null;
const plateBatchChannelIds = new Set();

// Evita corrida entre eventos de placa simultâneos no mesmo canal
const plateDetectionLocks = new Set();

// Serializa comandos TCP por controlador MG300 (ip:porta)
const mg300CommandQueues = new Map();
const mg300LastCommandAt = new Map();
const plateSyncWriteQueues = new Map();
const gateStatusByChannel = new Map();
const mg3000RuntimeByKey = new Map();
const gateCooldownByChannel = new Map();
let gateDecisionQueue = Promise.resolve();
const INTERLOCK_SETTINGS_ID = '__interlock_settings__';
const DEFAULT_GATE_COMMAND_COOLDOWN_MS = 15000;

// 1 sessão ativa por canal (janela de correlação)
const speedSessions = new Map(); // channelId -> { sessionId, radarId, speed, speedTimestampMs, deadlineMs, timer, cleanupTimer }

function makeSessionId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toMs(x) {
  if (x === null || x === undefined) return Date.now();
  if (typeof x === 'number') return x;
  const d = (x instanceof Date) ? x : new Date(x);
  const t = d.getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function findOneAsync(db, query) {
  return new Promise((resolve, reject) => {
    db.findOne(query, (err, doc) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(doc);
    });
  });
}

function findAsync(db, query = {}) {
  return new Promise((resolve, reject) => {
    db.find(query, (err, docs) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(Array.isArray(docs) ? docs : []);
    });
  });
}

function countAsync(db, query = {}) {
  return new Promise((resolve, reject) => {
    db.count(query, (err, count) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(Number.isFinite(count) ? count : 0);
    });
  });
}

function removeAsync(db, query, options = {}) {
  return new Promise((resolve, reject) => {
    db.remove(query, options, (err, numRemoved) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(Number.isFinite(numRemoved) ? numRemoved : 0);
    });
  });
}

function insertAsync(db, docs) {
  return new Promise((resolve, reject) => {
    db.insert(docs, (err, inserted) => {
      if (err) {
        reject(err);
        return;
      }
      if (Array.isArray(docs)) {
        resolve(Array.isArray(inserted) ? inserted : []);
        return;
      }
      resolve(inserted || null);
    });
  });
}

function updateAsync(db, query, update, options = {}) {
  return new Promise((resolve, reject) => {
    db.update(query, update, options, (err, numReplaced, upsert) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ numReplaced, upsert: Boolean(upsert) });
    });
  });
}

function enqueuePlateSyncWrite(queueKey, taskFn) {
  const key = String(queueKey || 'default');
  const previous = plateSyncWriteQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => taskFn());

  plateSyncWriteQueues.set(key, next);
  next.finally(() => {
    if (plateSyncWriteQueues.get(key) === next) {
      plateSyncWriteQueues.delete(key);
    }
  });

  return next;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeChannelId(value) {
  return String(value || '').trim();
}

function normalizeControllerAddress(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/g, '')
    .replace(/:\d+$/g, '')
    .replace(/^::ffff:/, '');
}

function toIntegerOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGateStatusFromDoorStatus(doorStatus) {
  if (doorStatus === true) return 'closed';
  if (doorStatus === false) return 'open';
  return 'unknown';
}

function parseMg300DoorStatus(buffer) {
  const bytes = new Uint8Array(buffer);
  return {
    door1: (bytes[5] & 0x0F) !== 0x00,
    door2: (bytes[5] & 0xF0) !== 0x00,
    door3: (bytes[4] & 0x0F) !== 0x00,
    door4: (bytes[4] & 0xF0) === 0x40,
  };
}

function getChannelMg300ReceptorIndex(channel = {}) {
  return toIntegerOrNull(channel.receptorAdd);
}

function getChannelMg300DoorNumber(channel = {}) {
  return toIntegerOrNull(channel.port);
}

function getEventMg300ReceptorIndex(event = {}) {
  const receptorIndex = toIntegerOrNull(event.receptorIndex);
  if (receptorIndex !== null) return receptorIndex;

  const receptorAdd = toIntegerOrNull(event.receptorAdd ?? event.receptor);
  if (receptorAdd !== null) return Math.max(0, receptorAdd - 1);

  return null;
}

function bufferToPrintableAscii(buffer) {
  return Buffer.from(buffer)
    .toString('ascii')
    .replace(/[^\x20-\x7E]/g, '.')
    .slice(0, 160);
}

function describeDoorStatus(doorStatus) {
  if (doorStatus === true) return 'fechado';
  if (doorStatus === false) return 'aberto';
  return 'desconhecido';
}

function describeMg300Event(event = {}) {
  const parts = [
    `type=${event.eventType || '-'}`,
    `key=${event.eventKey || '-'}`,
    `rec=${event.receptorAdd ?? '-'}`,
    `door=${event.doorNumber ?? '-'}`,
    `status=${describeDoorStatus(event.doorStatus)}`,
    `rf=${event.rfId || '-'}`,
    `apiKey=${event.apiKey || '-'}`,
    `addr=${event.controllerAddress || '-'}`,
  ];
  if (event.apiEventKey && event.apiEventKey !== event.eventKey) {
    parts.splice(2, 0, `apiEvent=${event.apiEventKey}`);
  }
  if (event.receiverOriginName) {
    parts.splice(3, 0, `origin=${event.receiverOriginName}`);
  }
  return parts.join(' ');
}

function resolveMg3000ApiEventKey(eventPayload = {}) {
  if (Object.prototype.hasOwnProperty.call(eventPayload, 'apiEventKey')) {
    return String(eventPayload.apiEventKey || '').trim();
  }

  const eventKey = String(eventPayload.eventKey || '').trim();
  if (['passagem', 'dispositivoAcionado', 'statusTrigger'].includes(eventKey)) return '';
  if (eventKey === 'acionamentoPc') return 'baseAbriu';
  return eventKey;
}

function buildControllerRuntimeKey({ apiKey, controllerAddress } = {}) {
  const normalizedApiKey = String(apiKey || '').trim();
  if (normalizedApiKey) return `api:${normalizedApiKey}`;
  const normalizedAddress = normalizeControllerAddress(controllerAddress);
  if (normalizedAddress) return `addr:${normalizedAddress}`;
  return 'unknown';
}

function findOnlineMg3000RuntimeForChannel(channel = {}) {
  const channelApiKey = String(channel.mg3000ApiKey || channel.apiKey || '').trim();
  const channelAddress = normalizeControllerAddress(channel.equipAdd || channel.vehicleAdd);

  if (channelApiKey) {
    const byApiKey = mg3000RuntimeByKey.get(`api:${channelApiKey}`);
    if (byApiKey?.online === true) return byApiKey;
  }

  for (const runtime of mg3000RuntimeByKey.values()) {
    if (runtime?.online !== true) continue;
    const runtimeApiKey = String(runtime.apiKey || '').trim();
    const runtimeAddress = normalizeControllerAddress(runtime.controllerAddress);
    if (channelApiKey && runtimeApiKey && channelApiKey === runtimeApiKey) return runtime;
    if (channelAddress && runtimeAddress && channelAddress === runtimeAddress) return runtime;
  }

  return null;
}

function queryMg300SensorStatusOnce(ip, port, rec) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const command = Buffer.from([0x00, 0x5D, 0x01, rec]);
    const checksum = calculateChecksum(command);
    const commandWithChecksum = Buffer.concat([command, Buffer.from([checksum])]);
    let settled = false;

    console.log(`[mg3000-status] tx get-status ${ip}:${port} rec=${rec} hex=${commandWithChecksum.toString('hex')}`);

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      if (!socket.destroyed) socket.destroy();
      fn(value);
    };

    socket.setTimeout(MG300_SOCKET_TIMEOUT_MS);
    socket.setNoDelay(true);

    socket.once('connect', () => {
      socket.write(commandWithChecksum, (writeError) => {
        if (writeError) settle(reject, writeError);
      });
    });

    socket.on('data', (data) => {
      console.log(`[mg3000-status] rx get-status ${ip}:${port} rec=${rec} len=${data.length} hex=${data.toString('hex')}`);
      if (Buffer.isBuffer(data) && data[1] === 0x5D) {
        const doorsStatus = parseMg300DoorStatus(data);
        console.log(`[mg3000-status] parsed rec=${data[3]} door1=${describeDoorStatus(doorsStatus.door1)} door2=${describeDoorStatus(doorsStatus.door2)} door3=${describeDoorStatus(doorsStatus.door3)} door4=${describeDoorStatus(doorsStatus.door4)}`);
        settle(resolve, {
          statusCode: 200,
          receptorIndex: data[3],
          doorsStatus,
          rawHex: data.toString('hex'),
        });
        return;
      }

      const error = new Error('Resposta inesperada do MG300 na consulta de status.');
      error.responseHex = Buffer.isBuffer(data) ? data.toString('hex') : null;
      settle(reject, error);
    });

    socket.once('timeout', () => {
      const timeoutError = new Error(`Timeout consultando status do MG300 (${MG300_SOCKET_TIMEOUT_MS} ms).`);
      timeoutError.code = 'MG300_TIMEOUT';
      settle(reject, timeoutError);
    });

    socket.once('error', (error) => {
      settle(reject, error);
    });

    socket.connect({ host: ip, port });
  });
}

async function queryMg300SensorStatus(ip, port, rec) {
  const queueKey = `${ip}:${port}`;
  return enqueueMg300Command(queueKey, async () => {
    await waitForMg300Gap(queueKey);
    try {
      return await queryMg300SensorStatusOnce(ip, port, rec);
    } finally {
      mg300LastCommandAt.set(queueKey, Date.now());
    }
  });
}

async function refreshMg300StatusForChannel(channel = {}, reason = 'status_query') {
  const doorDriver = normalizeDoorDriver(channel.doorDriver);
  if (doorDriver === 'dozz_vehicle') return null;

  const controllerAddress = normalizeControllerAddress(channel.equipAdd);
  const receptorIndex = getChannelMg300ReceptorIndex(channel);
  const doorNumber = getChannelMg300DoorNumber(channel);
  if (!controllerAddress || receptorIndex === null || doorNumber === null) return null;

  console.log(`[mg3000-status] consulta canal=${channel._id || '-'} nome="${channel.name || ''}" ctrl=${controllerAddress}:${MG300_TCP_PORT} rec=${receptorIndex} door=${doorNumber} reason=${reason}`);
  const status = await queryMg300SensorStatus(controllerAddress, MG300_TCP_PORT, receptorIndex);
  const onlineRuntime = findOnlineMg3000RuntimeForChannel(channel);
  const matchingChannels = await findAsync(settingsDb, {});
  const sameControllerChannels = matchingChannels.filter((candidate) => (
    normalizeControllerAddress(candidate.equipAdd) === controllerAddress
    && getChannelMg300ReceptorIndex(candidate) === receptorIndex
  ));

  const updates = [];
  for (const candidate of sameControllerChannels) {
    const candidateDoor = getChannelMg300DoorNumber(candidate);
    const doorStatus = status?.doorsStatus?.[`door${candidateDoor}`];
    if (doorStatus !== true && doorStatus !== false) continue;

    const update = setChannelGateStatus(candidate._id, normalizeGateStatusFromDoorStatus(doorStatus), {
      doorStatus,
      controllerOnline: true,
      controllerKey: onlineRuntime?.key || buildControllerRuntimeKey({
        apiKey: candidate.mg3000ApiKey || candidate.apiKey || onlineRuntime?.apiKey,
        controllerAddress,
      }),
      controllerAddress,
      apiKey: candidate.mg3000ApiKey || candidate.apiKey || onlineRuntime?.apiKey || null,
      receptorAdd: receptorIndex,
      door: candidateDoor,
      lastEventKey: reason,
      lastRawHex: status?.rawHex || null,
    });
    if (update) {
      updates.push(update);
      console.log(`[mg3000-status] canal atualizado id=${candidate._id} nome="${candidate.name || ''}" rec=${receptorIndex} door=${candidateDoor} status=${describeDoorStatus(doorStatus)} gate=${update.gateStatus}`);
    }
  }

  if (updates.length > 0) {
    console.log(`[mg3000-status] status inicial atualizado rec=${receptorIndex} canais=${updates.length}`);
  } else {
    console.warn(`[mg3000-status] consulta sem canal atualizado rec=${receptorIndex} door=${doorNumber} raw=${status?.rawHex || '-'}`);
  }

  return { status, updates };
}

function refreshMg300StatusForChannelSoon(channel, reason = 'channel_start') {
  refreshMg300StatusForChannel(channel, reason).catch((error) => {
    console.warn(
      `[mg3000-status] falha ao consultar status inicial do canal ${channel?._id || ''}:`,
      error?.code || error?.message || error
    );
  });
}

async function refreshMg300StatusFromGatewayEvent(eventPayload = {}, reason = 'gateway_event_status_refresh') {
  const controllerAddress = normalizeControllerAddress(eventPayload.controllerAddress);
  const receptorIndex = getEventMg300ReceptorIndex(eventPayload);
  if (!controllerAddress || receptorIndex === null) {
    console.warn(`[mg3000-status] evento sem dados para consulta de status ${describeMg300Event(eventPayload)}`);
    return null;
  }

  console.log(`[mg3000-status] consulta por evento ${describeMg300Event(eventPayload)} reason=${reason}`);
  const status = await queryMg300SensorStatus(controllerAddress, MG300_TCP_PORT, receptorIndex);
  const channels = await findAsync(settingsDb, {});
  const sameControllerChannels = channels.filter((candidate) => (
    normalizeControllerAddress(candidate.equipAdd) === controllerAddress
    && getChannelMg300ReceptorIndex(candidate) === receptorIndex
  ));

  const runtimeKey = buildControllerRuntimeKey(eventPayload);
  const updates = [];
  for (const channel of sameControllerChannels) {
    const doorNumber = getChannelMg300DoorNumber(channel);
    const doorStatus = status?.doorsStatus?.[`door${doorNumber}`];
    if (doorStatus !== true && doorStatus !== false) {
      console.warn(`[mg3000-status] status sem door${doorNumber} para canal=${channel._id} raw=${status?.rawHex || '-'}`);
      continue;
    }

    const update = setChannelGateStatus(channel._id, normalizeGateStatusFromDoorStatus(doorStatus), {
      doorStatus,
      controllerOnline: true,
      controllerKey: runtimeKey,
      controllerAddress,
      apiKey: eventPayload.apiKey || channel.mg3000ApiKey || channel.apiKey || null,
      receptorAdd: receptorIndex,
      door: doorNumber,
      lastEventKey: `${reason}:${eventPayload.eventKey || 'event'}`,
      lastRawHex: status?.rawHex || eventPayload.rawHex || null,
    });
    if (update) {
      updates.push(update);
      console.log(`[mg3000-status] refresh por evento atualizou canal=${channel._id} nome="${channel.name || ''}" rec=${receptorIndex} door=${doorNumber} status=${describeDoorStatus(doorStatus)} gate=${update.gateStatus}`);
    }
  }

  if (updates.length === 0) {
    console.warn(`[mg3000-status] refresh por evento sem canais atualizados rec=${receptorIndex} raw=${status?.rawHex || '-'}`);
  }

  return { status, updates };
}

function scheduleMg300StatusRefreshFromGatewayEvent(eventPayload = {}) {
  const delaysMs = [250, 1500, 4000];
  delaysMs.forEach((delayMs) => {
    setTimeout(() => {
      refreshMg300StatusFromGatewayEvent(eventPayload, `after_${delayMs}ms`)
        .catch((error) => {
          console.warn(
            `[mg3000-status] falha no refresh por evento delay=${delayMs}ms:`,
            error?.code || error?.message || error
          );
        });
    }, delayMs);
  });
}

function emitGatewayStatusUpdate(eventName, payload) {
  try {
    io.emit(eventName, payload);
  } catch (_) {
    // no-op
  }
}

function setMg3000RuntimeStatus(runtimeKey, patch = {}) {
  const key = String(runtimeKey || '').trim() || 'unknown';
  const now = Date.now();
  const previous = mg3000RuntimeByKey.get(key) || {};
  const next = {
    ...previous,
    ...patch,
    key,
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
  };
  mg3000RuntimeByKey.set(key, next);
  emitGatewayStatusUpdate('mg3000-status-updated', next);
  return next;
}

function removeMg3000RuntimeStatus(runtimeKey, patch = {}) {
  const key = String(runtimeKey || '').trim();
  if (!key || !mg3000RuntimeByKey.has(key)) return null;

  const now = Date.now();
  const previous = mg3000RuntimeByKey.get(key) || {};
  const next = {
    ...previous,
    ...patch,
    key,
    online: false,
    removed: true,
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
  };
  mg3000RuntimeByKey.delete(key);
  emitGatewayStatusUpdate('mg3000-status-updated', next);
  return next;
}

function setChannelGateStatus(channelId, status, patch = {}) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return null;

  const now = Date.now();
  const previous = gateStatusByChannel.get(normalizedChannelId) || {};
  const next = {
    channelId: normalizedChannelId,
    gateStatus: status || previous.gateStatus || 'unknown',
    doorStatus: patch.doorStatus !== undefined
      ? patch.doorStatus
      : (previous.doorStatus !== undefined ? previous.doorStatus : null),
    controllerOnline: patch.controllerOnline !== undefined
      ? Boolean(patch.controllerOnline)
      : Boolean(previous.controllerOnline),
    controllerKey: patch.controllerKey || previous.controllerKey || null,
    controllerAddress: patch.controllerAddress || previous.controllerAddress || null,
    apiKey: patch.apiKey || previous.apiKey || null,
    receptorAdd: patch.receptorAdd !== undefined ? patch.receptorAdd : previous.receptorAdd,
    door: patch.door !== undefined ? patch.door : previous.door,
    lastEventKey: patch.lastEventKey || previous.lastEventKey || null,
    lastRawHex: patch.lastRawHex || previous.lastRawHex || null,
    lastReason: patch.lastReason || previous.lastReason || null,
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
  };

  gateStatusByChannel.set(normalizedChannelId, next);
  if (next.gateStatus === 'closed' || next.doorStatus === true) {
    clearChannelGateCooldown(normalizedChannelId, 'gate_closed', { emit: false });
  }
  emitGatewayStatusUpdate('gate-status-updated', {
    ...next,
    ...getChannelGateCooldownPayload(normalizedChannelId),
  });
  return next;
}

function markControllerChannelsOffline(runtimeKey) {
  for (const [channelId, state] of gateStatusByChannel.entries()) {
    if (state?.controllerKey !== runtimeKey) continue;
    setChannelGateStatus(channelId, state.gateStatus || 'unknown', {
      ...state,
      controllerOnline: false,
      lastReason: 'controller_offline',
    });
  }
}

function getChannelGateRuntime(channelId) {
  const normalizedChannelId = normalizeChannelId(channelId);
  return gateStatusByChannel.get(normalizedChannelId) || {
    channelId: normalizedChannelId,
    gateStatus: 'unknown',
    doorStatus: null,
    controllerOnline: false,
    updatedAt: 0,
    updatedAtIso: null,
  };
}

function numberMatchesAny(value, candidates) {
  const parsed = toIntegerOrNull(value);
  if (parsed === null) return false;
  return candidates.some((candidate) => parsed === candidate);
}

function channelMatchesMg3000Event(channel = {}, event = {}) {
  const recIndex = toIntegerOrNull(event.receptorIndex);
  const recAdd = toIntegerOrNull(event.receptorAdd);
  const doorIndex = toIntegerOrNull(event.doorIndex);
  const doorNumber = toIntegerOrNull(event.doorNumber);

  const recCandidates = [recIndex, recAdd].filter((value) => value !== null);
  const doorCandidates = [doorIndex, doorNumber].filter((value) => value !== null);

  const recMatches = recCandidates.length === 0 || numberMatchesAny(channel.receptorAdd, recCandidates);
  const doorMatches = doorCandidates.length === 0 || numberMatchesAny(channel.port, doorCandidates);
  if (!recMatches || !doorMatches) return false;

  const channelControllerAddress = normalizeControllerAddress(channel.equipAdd);
  const eventControllerAddress = normalizeControllerAddress(event.controllerAddress);
  const channelApiKey = String(channel.mg3000ApiKey || channel.apiKey || '').trim();
  const eventApiKey = String(event.apiKey || '').trim();

  if (channelApiKey && eventApiKey) return channelApiKey === eventApiKey;
  if (channelControllerAddress && eventControllerAddress) return channelControllerAddress === eventControllerAddress;
  return true;
}

function getChannelPhysicalDoorKey(channel = {}) {
  const channelId = normalizeChannelId(channel._id);
  const doorDriver = normalizeDoorDriver(channel.doorDriver);

  if (doorDriver === 'dozz_vehicle') {
    const controllerAddress = normalizeControllerAddress(channel.vehicleAdd || channel.equipAdd);
    const vehicleChannel = toIntegerOrNull(channel.vehicleChannel || channel.port);
    if (controllerAddress && vehicleChannel !== null) {
      return `dozz_vehicle:${controllerAddress}:ch:${vehicleChannel}`;
    }
    return channelId ? `channel:${channelId}` : null;
  }

  const controllerAddress = normalizeControllerAddress(channel.equipAdd);
  const apiKey = String(channel.mg3000ApiKey || channel.apiKey || '').trim();
  const receptorIndex = toIntegerOrNull(channel.receptorAdd);
  const doorNumber = toIntegerOrNull(channel.port);
  const controllerKey = controllerAddress || (apiKey ? `api:${apiKey}` : '');
  if (controllerKey && receptorIndex !== null && doorNumber !== null) {
    return `mg3000:${controllerKey}:rec:${receptorIndex}:door:${doorNumber}`;
  }

  return channelId ? `channel:${channelId}` : null;
}

function getChannelPhysicalDoorLabel(channel = {}) {
  const doorDriver = normalizeDoorDriver(channel.doorDriver);
  if (doorDriver === 'dozz_vehicle') {
    const controllerAddress = normalizeControllerAddress(channel.vehicleAdd || channel.equipAdd) || 'sem-controladora';
    const vehicleChannel = toIntegerOrNull(channel.vehicleChannel || channel.port);
    return `Vehicle ${controllerAddress} canal ${vehicleChannel ?? '-'}`;
  }

  const controllerAddress = normalizeControllerAddress(channel.equipAdd) || 'sem-controladora';
  const receptorIndex = toIntegerOrNull(channel.receptorAdd);
  const doorNumber = toIntegerOrNull(channel.port);
  return `MG3000 ${controllerAddress} rec ${receptorIndex ?? '-'} porta ${doorNumber ?? '-'}`;
}

function buildPhysicalDoorGroups(channels = []) {
  const groupsByKey = new Map();
  for (const channel of channels) {
    const key = getChannelPhysicalDoorKey(channel);
    if (!key) continue;
    const existing = groupsByKey.get(key) || {
      key,
      name: getChannelPhysicalDoorLabel(channel),
      doorDriver: normalizeDoorDriver(channel.doorDriver),
      controllerAddress: normalizeControllerAddress(channel.equipAdd || channel.vehicleAdd),
      receptorAdd: channel.receptorAdd ?? null,
      door: channel.port ?? channel.vehicleChannel ?? null,
      channelIds: [],
      channels: [],
    };
    existing.channelIds.push(channel._id);
    existing.channels.push({
      channelId: channel._id,
      doorKey: getChannelPhysicalDoorKey(channel),
      name: channel.name || channel._id,
      channelType: channel.channel_type || '',
    });
    groupsByKey.set(key, existing);
  }

  return Array.from(groupsByKey.values())
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function getInterlockDoorKeys(interlock = {}, channels = []) {
  const directDoorKeys = Array.isArray(interlock.doorKeys)
    ? interlock.doorKeys.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (directDoorKeys.length > 0) return Array.from(new Set(directDoorKeys));

  const channelById = new Map(channels.map((channel) => [String(channel._id), channel]));
  const legacyChannelIds = Array.isArray(interlock.channelIds)
    ? interlock.channelIds.map(normalizeChannelId).filter(Boolean)
    : [];
  return Array.from(new Set(legacyChannelIds.map((channelId) => (
    getChannelPhysicalDoorKey(channelById.get(channelId)) || `channel:${channelId}`
  )).filter(Boolean)));
}

function getPhysicalDoorRuntimeState(doorKey, channels = []) {
  const members = channels.filter((channel) => getChannelPhysicalDoorKey(channel) === doorKey);
  if (members.length === 0) {
    return {
      gateStatus: 'unknown',
      doorStatus: null,
      updatedAt: 0,
      channelIds: [],
    };
  }

  const states = members.map((channel) => getChannelGateRuntime(channel._id));
  const activeCooldown = members
    .map((channel) => getActiveChannelGateCooldown(channel._id))
    .find(Boolean);
  if (activeCooldown) {
    return {
      gateStatus: 'opening',
      doorStatus: false,
      updatedAt: Date.now(),
      channelIds: members.map((channel) => channel._id),
      cooldown: activeCooldown,
    };
  }

  const openState = states.find((state) => state.gateStatus === 'open' || state.gateStatus === 'opening');
  if (openState) return { ...openState, channelIds: members.map((channel) => channel._id) };

  const unknownState = states.find((state) => !state.gateStatus || state.gateStatus === 'unknown');
  if (unknownState) return { ...unknownState, channelIds: members.map((channel) => channel._id) };

  const newestState = states.reduce((best, state) => (
    Number(state.updatedAt || 0) > Number(best.updatedAt || 0) ? state : best
  ), states[0] || {});
  return { ...newestState, channelIds: members.map((channel) => channel._id) };
}

async function findChannelsForMg3000Event(event = {}) {
  const channels = await findAsync(settingsDb, {});
  const matches = channels.filter((channel) => channelMatchesMg3000Event(channel, event));
  if (matches.length <= 1) return matches;

  const eventControllerAddress = normalizeControllerAddress(event.controllerAddress);
  const eventApiKey = String(event.apiKey || '').trim();
  const strictMatches = matches.filter((channel) => {
    const channelControllerAddress = normalizeControllerAddress(channel.equipAdd);
    const channelApiKey = String(channel.mg3000ApiKey || channel.apiKey || '').trim();
    return (eventApiKey && channelApiKey === eventApiKey)
      || (eventControllerAddress && channelControllerAddress === eventControllerAddress);
  });

  return strictMatches.length > 0 ? strictMatches : matches;
}

function normalizeInterlockDoc(payload = {}, existing = null) {
  const channelIds = Array.isArray(payload.channelIds)
    ? payload.channelIds.map(normalizeChannelId).filter(Boolean)
    : [];
  const uniqueChannelIds = Array.from(new Set(channelIds));
  const doorKeys = Array.isArray(payload.doorKeys)
    ? payload.doorKeys.map((item) => String(item || '').trim()).filter(Boolean)
    : (Array.isArray(existing?.doorKeys) ? existing.doorKeys : []);
  const uniqueDoorKeys = Array.from(new Set(doorKeys));
  const now = Date.now();
  return {
    ...(existing || {}),
    name: String(payload.name || existing?.name || '').trim() || 'Intertravamento',
    enabled: payload.enabled !== false && String(payload.enabled || '').toLowerCase() !== 'false',
    doorKeys: uniqueDoorKeys,
    channelIds: uniqueChannelIds,
    blockUnknown: payload.blockUnknown !== false && String(payload.blockUnknown || '').toLowerCase() !== 'false',
    staleAfterMs: Math.max(1000, Number(payload.staleAfterMs || existing?.staleAfterMs || 15000)),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function normalizeInterlockSettingsDoc(payload = {}, existing = null) {
  const now = Date.now();
  return {
    ...(existing || {}),
    _id: INTERLOCK_SETTINGS_ID,
    type: 'settings',
    gateCommandCooldownMs: normalizeDurationMs(
      payload.gateCommandCooldownMs ?? existing?.gateCommandCooldownMs,
      DEFAULT_GATE_COMMAND_COOLDOWN_MS
    ),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

async function getInterlockSettings() {
  const existing = await findOneAsync(interlocksDb, { _id: INTERLOCK_SETTINGS_ID }).catch(() => null);
  return normalizeInterlockSettingsDoc(existing || {}, existing);
}

async function saveInterlockSettings(payload = {}) {
  const existing = await findOneAsync(interlocksDb, { _id: INTERLOCK_SETTINGS_ID }).catch(() => null);
  const doc = normalizeInterlockSettingsDoc(payload, existing);
  await updateAsync(interlocksDb, { _id: INTERLOCK_SETTINGS_ID }, doc, { upsert: true });
  return doc;
}

function getChannelGateCooldownPayload(channelId) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return {
    cooldownActive: false,
    cooldownRemainingMs: 0,
    cooldownExpiresAt: null,
  };

  const cooldown = gateCooldownByChannel.get(normalizedChannelId);
  if (!cooldown) return {
    cooldownActive: false,
    cooldownRemainingMs: 0,
    cooldownExpiresAt: null,
  };

  const remainingMs = Math.max(0, Number(cooldown.expiresAt || 0) - Date.now());
  return {
    cooldownActive: remainingMs > 0,
    cooldownRemainingMs: remainingMs,
    cooldownExpiresAt: cooldown.expiresAtIso || null,
    cooldownStartedAt: cooldown.startedAtIso || null,
    cooldownReason: cooldown.reason || null,
  };
}

function emitChannelGateState(channelId, extra = {}) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return;
  const state = getChannelGateRuntime(normalizedChannelId);
  emitGatewayStatusUpdate('gate-status-updated', {
    ...state,
    ...getChannelGateCooldownPayload(normalizedChannelId),
    ...extra,
  });
}

function clearChannelGateCooldown(channelId, reason = 'cleared', options = {}) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return false;

  const cooldown = gateCooldownByChannel.get(normalizedChannelId);
  if (!cooldown) return false;
  if (cooldown.timer) clearTimeout(cooldown.timer);
  gateCooldownByChannel.delete(normalizedChannelId);
  console.log(`[gate-cooldown] liberado channel=${normalizedChannelId} reason=${reason}`);
  if (options.emit !== false) {
    emitChannelGateState(normalizedChannelId, {
      cooldownActive: false,
      cooldownRemainingMs: 0,
      cooldownExpiresAt: null,
      cooldownReason: reason,
    });
  }
  return true;
}

function getActiveChannelGateCooldown(channelId) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return null;

  const cooldown = gateCooldownByChannel.get(normalizedChannelId);
  if (!cooldown) return null;

  const state = getChannelGateRuntime(normalizedChannelId);
  const statusUpdatedAt = Number(state?.updatedAt || 0);
  if ((state?.gateStatus === 'closed' || state?.doorStatus === true) && statusUpdatedAt >= Number(cooldown.startedAt || 0)) {
    clearChannelGateCooldown(normalizedChannelId, 'gate_closed');
    return null;
  }

  const remainingMs = Number(cooldown.expiresAt || 0) - Date.now();
  if (remainingMs <= 0) {
    clearChannelGateCooldown(normalizedChannelId, 'expired');
    return null;
  }

  return {
    ...cooldown,
    remainingMs,
  };
}

function startChannelGateCooldown(channelId, cooldownMs, reason = 'command_open') {
  const normalizedChannelId = normalizeChannelId(channelId);
  const safeCooldownMs = normalizeDurationMs(cooldownMs, DEFAULT_GATE_COMMAND_COOLDOWN_MS);
  if (!normalizedChannelId || safeCooldownMs <= 0) return null;

  clearChannelGateCooldown(normalizedChannelId, 'replaced', { emit: false });

  const startedAt = Date.now();
  const expiresAt = startedAt + safeCooldownMs;
  const cooldown = {
    channelId: normalizedChannelId,
    reason,
    startedAt,
    startedAtIso: new Date(startedAt).toISOString(),
    expiresAt,
    expiresAtIso: new Date(expiresAt).toISOString(),
    durationMs: safeCooldownMs,
    timer: setTimeout(() => {
      clearChannelGateCooldown(normalizedChannelId, 'expired');
    }, safeCooldownMs),
  };
  if (cooldown.timer?.unref) cooldown.timer.unref();
  gateCooldownByChannel.set(normalizedChannelId, cooldown);
  console.log(`[gate-cooldown] ativo channel=${normalizedChannelId} durationMs=${safeCooldownMs} reason=${reason}`);
  emitChannelGateState(normalizedChannelId);
  return cooldown;
}

async function startPhysicalDoorCooldownForChannel(channelId, cooldownMs, reason = 'command_open') {
  const normalizedChannelId = normalizeChannelId(channelId);
  const channels = await findAsync(settingsDb, {});
  const sourceChannel = channels.find((channel) => String(channel._id) === normalizedChannelId);
  const doorKey = getChannelPhysicalDoorKey(sourceChannel) || `channel:${normalizedChannelId}`;
  const memberChannelIds = channels
    .filter((channel) => getChannelPhysicalDoorKey(channel) === doorKey)
    .map((channel) => channel._id)
    .filter(Boolean);
  const uniqueChannelIds = Array.from(new Set(memberChannelIds.length > 0 ? memberChannelIds : [normalizedChannelId]));

  console.log(`[gate-cooldown] aplicando por porta doorKey=${doorKey} canais=${uniqueChannelIds.join(',')}`);
  return uniqueChannelIds.map((memberChannelId) => (
    startChannelGateCooldown(memberChannelId, cooldownMs, `${reason}:door`)
  )).filter(Boolean);
}

function isGateStateBlocking(state = {}, staleAfterMs, blockUnknown) {
  const ageMs = state?.updatedAt ? Date.now() - Number(state.updatedAt) : Number.POSITIVE_INFINITY;
  const isStale = ageMs > staleAfterMs;
  const gateStatus = isStale ? 'unknown' : String(state?.gateStatus || 'unknown');
  if (gateStatus === 'open' || gateStatus === 'opening') return true;
  return blockUnknown && gateStatus === 'unknown';
}

async function evaluateChannelInterlock(channelId) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return { allowed: true };

  const channels = await findAsync(settingsDb, {});
  const targetChannel = channels.find((channel) => String(channel._id) === normalizedChannelId);
  const targetDoorKey = getChannelPhysicalDoorKey(targetChannel) || `channel:${normalizedChannelId}`;
  const interlocks = await findAsync(interlocksDb, { enabled: { $ne: false } });
  for (const interlock of interlocks) {
    if (interlock?._id === INTERLOCK_SETTINGS_ID || interlock?.type === 'settings') continue;

    const doorKeys = getInterlockDoorKeys(interlock, channels);
    if (!doorKeys.includes(targetDoorKey)) continue;

    const staleAfterMs = Math.max(1000, Number(interlock.staleAfterMs || 15000));
    const blockUnknown = interlock.blockUnknown !== false;
    for (const linkedDoorKey of doorKeys) {
      if (!linkedDoorKey || linkedDoorKey === targetDoorKey) continue;
      const linkedState = getPhysicalDoorRuntimeState(linkedDoorKey, channels);
      if (!isGateStateBlocking(linkedState, staleAfterMs, blockUnknown)) continue;

      return {
        allowed: false,
        reason: 'interlock_blocked',
        interlockId: interlock._id,
        interlockName: interlock.name,
        blockingDoorKey: linkedDoorKey,
        blockingChannelId: linkedState.channelIds?.[0] || null,
        blockingGateStatus: linkedState.gateStatus || 'unknown',
        blockingUpdatedAt: linkedState.updatedAtIso || null,
      };
    }
  }

  return { allowed: true };
}

function enqueueGateDecision(taskFn) {
  const run = gateDecisionQueue
    .catch(() => undefined)
    .then(() => taskFn());
  gateDecisionQueue = run.catch(() => undefined);
  return run;
}

function mgBcdToDecimal(bcdValue) {
  return ((bcdValue & 0xF0) >> 4) * 10 + (bcdValue & 0x0F);
}

function getMg3000EventCode(frame) {
  return (frame[0] & 0xF0) >> 4;
}

function getMg3000ReceiverOrigin(frame) {
  return (frame[10] & 0xF0) >> 4;
}

function getMg3000ReceiverOriginName(origin) {
  switch (origin) {
    case 0x01: return 'RF';
    case 0x02: return 'TA';
    case 0x03: return 'CT';
    case 0x06: return 'TP';
    default: return origin ? `0x${origin.toString(16).toUpperCase()}` : null;
  }
}

function getMg3000EventType(frame) {
  const eventType = getMg3000EventCode(frame);
  const receiverOrigin = getMg3000ReceiverOrigin(frame);
  switch (eventType) {
    case 0x00:
      if (receiverOrigin === 0x06) return 'tagRFID';
      if (receiverOrigin === 0x01) return 'acessoRf';
      return 'dispositivoAcionado';
    case 0x01: return 'passagem';
    case 0x06: return 'acionamentoPc';
    case 0x08: return 'clonagem';
    case 0x09: return 'panicoRf';
    case 0x0C: return 'eventoReceptor';
    default: return null;
  }
}

function getMg3000CaronaFlag(frame) {
  return (frame[14] & 0x08) !== 0;
}

function getMg3000ButtonIndex(frame) {
  return (frame[14] & 0x30) >> 4;
}

function getMg3000PassageIndex(frame) {
  return frame[14] & 0b00000111;
}

function getMg3000SensorFlags(frame) {
  return {
    sensor1Closed: (frame[15] & 0x01) !== 0,
    sensor2Closed: (frame[15] & 0x02) !== 0,
  };
}

function getMg3000ReceiverEvent(frame) {
  switch (frame[15]) {
    case 0xF9: return 'arrombamento';
    case 0xFA: return 'portaFechou';
    case 0xFB: return 'portaAbriu';
    case 0xFF: return 'portaAberta';
    default: return null;
  }
}

function parseMg3000Serial(frame) {
  const byte0 = frame[0] & 0x0F;
  return [byte0, frame[1], frame[2], frame[3]]
    .map((byte) => byte.toString(16))
    .join('');
}

function parseMg3000EventDate(frame) {
  const hour = mgBcdToDecimal(frame[4]);
  const minute = mgBcdToDecimal(frame[5]);
  const second = mgBcdToDecimal(frame[6]);
  const day = mgBcdToDecimal(frame[7]);
  const month = mgBcdToDecimal(frame[8]);
  const year = mgBcdToDecimal(frame[9]);
  const date = new Date(
    `20${String(year).padStart(2, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
  );
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function parseMg3000Frame(rawData) {
  const data = Buffer.from(rawData);
  if (data.length < 18) return null;

  const frame = data.slice(3, -1);
  if (frame.length < 16) return null;

  const eventCode = getMg3000EventCode(frame);
  const eventType = getMg3000EventType(frame);
  if (!eventType) return null;

  const receiverOrigin = getMg3000ReceiverOrigin(frame);
  const receptorIndex = frame[10] & 0x0F;
  const timestamp = parseMg3000EventDate(frame).toISOString();
  const base = {
    eventCode,
    eventType,
    receiverOrigin,
    receiverOriginName: getMg3000ReceiverOriginName(receiverOrigin),
    receptorIndex,
    receptorAdd: receptorIndex + 1,
    timestamp,
    rawHex: data.toString('hex'),
  };

  if (eventType === 'eventoReceptor') {
    const eventKey = getMg3000ReceiverEvent(frame);
    const doorIndex = getMg3000ButtonIndex(frame);
    const doorNumber = doorIndex + 1;
    const doorStatus = eventKey === 'portaFechou'
      ? true
      : (eventKey === 'portaAbriu' || eventKey === 'portaAberta' ? false : null);
    return {
      ...base,
      eventKey,
      apiEventKey: eventKey,
      doorIndex,
      doorNumber,
      doorStatus,
      gateStatus: normalizeGateStatusFromDoorStatus(doorStatus),
    };
  }

  let eventKey = eventType;
  let apiEventKey = eventType;
  let doorIndex = getMg3000ButtonIndex(frame);
  const extra = {};

  if (eventType === 'passagem') {
    const carona = getMg3000CaronaFlag(frame);
    doorIndex = getMg3000PassageIndex(frame);
    eventKey = carona ? 'carona' : 'passagem';
    apiEventKey = carona ? 'carona' : null;
    extra.carona = carona;
  } else if (eventType === 'acionamentoPc') {
    apiEventKey = 'baseAbriu';
  } else if (eventType === 'dispositivoAcionado') {
    apiEventKey = null;
    extra.sensorStatus = getMg3000SensorFlags(frame);
  }

  return {
    ...base,
    ...extra,
    eventKey,
    apiEventKey,
    rfId: parseMg3000Serial(frame),
    doorIndex,
    doorNumber: doorIndex + 1,
    batLow: (frame[14] & 0x80) !== 0,
  };
}

async function forwardMg3000EventToApiRedis(eventPayload) {
  if (!API_MG3000_EVENT_ENDPOINT) {
    console.warn(`[mg3000-gateway] forward desabilitado sem MG3000_EVENT_URL event=${describeMg300Event(eventPayload)}`);
    return;
  }
  const forwardEventKey = resolveMg3000ApiEventKey(eventPayload);
  if (!forwardEventKey) {
    console.log(`[mg3000-gateway] forward ignorado: evento local-only ${describeMg300Event(eventPayload)}`);
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (MG300_GATEWAY_EVENT_FORWARD_TOKEN) {
      headers['x-internal-token'] = MG300_GATEWAY_EVENT_FORWARD_TOKEN;
    }

    const forwardPayload = {
      ...eventPayload,
      eventKey: forwardEventKey,
      originalEventKey: eventPayload.eventKey || null,
      originalEventType: eventPayload.eventType || null,
    };

    console.log(`[mg3000-gateway] forward -> ${API_MG3000_EVENT_ENDPOINT} ${describeMg300Event(forwardPayload)}`);
    const resp = await fetch(API_MG3000_EVENT_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(forwardPayload),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[mg3000-gateway] forward falhou:', resp.status, txt);
    } else {
      const txt = await resp.text().catch(() => '');
      console.log(`[mg3000-gateway] forward ok status=${resp.status} body=${txt.slice(0, 240)}`);
    }
  } catch (error) {
    console.error('[mg3000-gateway] erro ao encaminhar evento:', error?.message || error);
  }
}

async function applyMg3000EventToLocalState(eventPayload) {
  console.log(`[mg3000-gateway] evento local recebido ${describeMg300Event(eventPayload)} raw=${eventPayload.rawHex || '-'}`);
  const runtimeKey = buildControllerRuntimeKey(eventPayload);
  setMg3000RuntimeStatus(runtimeKey, {
    online: true,
    apiKey: eventPayload.apiKey || null,
    mac: eventPayload.mac || null,
    controllerAddress: eventPayload.controllerAddress || null,
    lastEventKey: eventPayload.eventKey || null,
    lastRawHex: eventPayload.rawHex || null,
  });

  if (eventPayload.doorStatus === null || eventPayload.doorStatus === undefined) {
    console.log(`[mg3000-gateway] evento sem status de porta, agendando consulta de status ${describeMg300Event(eventPayload)}`);
    scheduleMg300StatusRefreshFromGatewayEvent(eventPayload);
    emitGatewayStatusUpdate('mg3000-event', eventPayload);
    return [];
  }

  const channels = await findChannelsForMg3000Event(eventPayload);
  console.log(`[mg3000-gateway] canais casados=${channels.length} ${channels.map((channel) => `${channel._id}:${channel.name || ''}`).join(', ') || '-'}`);
  const updates = channels.map((channel) => setChannelGateStatus(channel._id, eventPayload.gateStatus, {
    doorStatus: eventPayload.doorStatus,
    controllerOnline: true,
    controllerKey: runtimeKey,
    controllerAddress: eventPayload.controllerAddress || null,
    apiKey: eventPayload.apiKey || null,
    receptorAdd: eventPayload.receptorAdd,
    door: eventPayload.doorNumber,
    lastEventKey: eventPayload.eventKey,
    lastRawHex: eventPayload.rawHex,
  })).filter(Boolean);
  updates.forEach((update) => {
    console.log(`[mg3000-gateway] canal atualizado id=${update.channelId} rec=${update.receptorAdd} door=${update.door} status=${describeDoorStatus(update.doorStatus)} gate=${update.gateStatus} event=${update.lastEventKey}`);
  });
  if (updates.length === 0) {
    console.warn(`[mg3000-gateway] nenhum canal atualizado para ${describeMg300Event(eventPayload)}`);
  }

  const localEvent = {
    eventType: 'mg3000_gateway',
    channelIds: updates.map((item) => item.channelId),
    eventKey: eventPayload.eventKey,
    receptorAdd: eventPayload.receptorAdd,
    door: eventPayload.doorNumber,
    doorStatus: eventPayload.doorStatus,
    gateStatus: eventPayload.gateStatus,
    controllerAddress: eventPayload.controllerAddress || null,
    apiKey: eventPayload.apiKey || null,
    timestamp: Date.now(),
  };
  insertAsync(eventsDb, localEvent).catch((error) => {
    console.error('[mg3000-gateway] erro ao salvar evento local:', error?.message || error);
  });

  emitGatewayStatusUpdate('mg3000-event', {
    ...eventPayload,
    channelIds: updates.map((item) => item.channelId),
  });
  return updates;
}

async function handleMg3000GatewayData(socketState, rawData) {
  console.log(`[mg3000-gateway] rx from=${socketState.controllerAddress || '-'} len=${rawData.length} ascii="${bufferToPrintableAscii(rawData)}" hex=${rawData.toString('hex')}`);
  const ascii = rawData.toString('ascii').replace(/\0.*$/g, '').trim();
  if (ascii.startsWith('@') && ascii.includes('@')) {
    const [, mac, apiKey] = ascii.split('@');
    const previousRuntimeKey = socketState.runtimeKey;
    socketState.mac = String(mac || '').trim();
    socketState.apiKey = String(apiKey || '').trim();
    socketState.runtimeKey = buildControllerRuntimeKey(socketState);
    console.log(`[mg3000-gateway] identificacao mac=${socketState.mac || '-'} apiKey=${socketState.apiKey || '-'} addr=${socketState.controllerAddress || '-'} runtime=${socketState.runtimeKey}`);
    if (previousRuntimeKey && previousRuntimeKey !== socketState.runtimeKey) {
      removeMg3000RuntimeStatus(previousRuntimeKey, {
        controllerAddress: socketState.controllerAddress || null,
        mac: socketState.mac || null,
        apiKey: socketState.apiKey || null,
        lastEventKey: 'identify',
      });
      markControllerChannelsOffline(previousRuntimeKey);
    }
    setMg3000RuntimeStatus(socketState.runtimeKey, {
      online: true,
      mac: socketState.mac || null,
      apiKey: socketState.apiKey || null,
      controllerAddress: socketState.controllerAddress || null,
      lastEventKey: 'connect',
    });
    return;
  }

  const parsed = parseMg3000Frame(rawData);
  if (!parsed) {
    console.warn(`[mg3000-gateway] frame nao parseado from=${socketState.controllerAddress || '-'} ascii="${bufferToPrintableAscii(rawData)}" hex=${rawData.toString('hex')}`);
    return;
  }

  const eventPayload = {
    ...parsed,
    apiKey: socketState.apiKey || null,
    mac: socketState.mac || null,
    controllerAddress: socketState.controllerAddress || null,
  };
  console.log(`[mg3000-gateway] parsed ${describeMg300Event(eventPayload)}`);
  await applyMg3000EventToLocalState(eventPayload);
  await forwardMg3000EventToApiRedis(eventPayload);
}

function startMg3000GatewayServer() {
  if (!MG300_GATEWAY_ENABLED) {
    console.log('[mg3000-gateway] desabilitado');
    return;
  }

  const server = net.createServer((socket) => {
    const controllerAddress = normalizeControllerAddress(socket.remoteAddress || '');
    const socketState = {
      controllerAddress,
      runtimeKey: buildControllerRuntimeKey({ controllerAddress }),
      apiKey: null,
      mac: null,
      offlineMarked: false,
    };

    console.log(`[mg3000-gateway] conectado addr=${controllerAddress || '-'} remotePort=${socket.remotePort || '-'} localPort=${socket.localPort || '-'}`);
    setMg3000RuntimeStatus(socketState.runtimeKey, {
      online: true,
      controllerAddress,
      lastEventKey: 'connect',
    });

    socket.setKeepAlive(true, 5000);
    socket.on('data', (rawData) => {
      handleMg3000GatewayData(socketState, rawData).catch((error) => {
        console.error('[mg3000-gateway] erro ao processar frame:', error?.message || error);
      });
    });

    const markOffline = (reason = 'disconnect') => {
      console.log(`[mg3000-gateway] desconectado addr=${controllerAddress || '-'} reason=${reason} runtime=${socketState.runtimeKey}`);
      if (socketState.offlineMarked) return;
      socketState.offlineMarked = true;
      setMg3000RuntimeStatus(socketState.runtimeKey, {
        online: false,
        controllerAddress,
        apiKey: socketState.apiKey || null,
        mac: socketState.mac || null,
        lastEventKey: reason,
      });
      markControllerChannelsOffline(socketState.runtimeKey);
    };
    socket.on('error', (error) => markOffline(`error:${error?.code || error?.message || 'socket'}`));
    socket.on('close', () => markOffline('close'));
    socket.on('end', () => markOffline('end'));
  });

  server.on('error', (error) => {
    console.error('[mg3000-gateway] falha no listener:', error?.message || error);
  });

  server.listen(MG300_GATEWAY_PORT, () => {
    console.log(`[mg3000-gateway] escutando porta ${MG300_GATEWAY_PORT}`);
  });
}

async function buildGatewayStatusPayload() {
  const channels = await findAsync(settingsDb, {});
  const processRows = Object.entries(processes || {}).map(([channelId, info]) => ({
    channelId,
    status: info?.status || 'stopped',
    errorType: info?.errorType || null,
  }));
  const processByChannel = new Map(processRows.map((item) => [item.channelId, item]));
  const channelStates = {};
  const channelDoorStatus = {};

  const channelPayload = channels.map((channel) => {
    const runtime = getChannelGateRuntime(channel._id);
    const controllerRuntime = findOnlineMg3000RuntimeForChannel(channel);
    const controllerOnline = runtime.controllerOnline === true || controllerRuntime?.online === true;
    const process = processByChannel.get(channel._id) || { channelId: channel._id, status: 'stopped' };
    const cooldown = getChannelGateCooldownPayload(channel._id);
    const item = {
      channelId: channel._id,
      name: channel.name || channel._id,
      channelType: channel.channel_type || '',
      processStatus: process.status || 'stopped',
      gateStatus: runtime.gateStatus || 'unknown',
      doorStatus: runtime.doorStatus ?? null,
      controllerOnline,
      controllerKey: runtime.controllerKey || controllerRuntime?.key || null,
      controllerAddress: runtime.controllerAddress || controllerRuntime?.controllerAddress || channel.equipAdd || null,
      apiKey: runtime.apiKey || channel.mg3000ApiKey || channel.apiKey || controllerRuntime?.apiKey || null,
      receptorAdd: runtime.receptorAdd ?? channel.receptorAdd ?? null,
      door: runtime.door ?? channel.port ?? null,
      updatedAt: runtime.updatedAtIso || controllerRuntime?.updatedAtIso || null,
      lastEventKey: runtime.lastEventKey || controllerRuntime?.lastEventKey || null,
      ...cooldown,
    };
    channelStates[channel._id] = item;
    channelDoorStatus[channel._id] = item.doorStatus;
    return item;
  });

  const anyProcessStopped = processRows.some((item) => item.status && item.status !== 'running');
  const controllers = Array.from(mg3000RuntimeByKey.values());
  return {
    ok: true,
    online: true,
    anyProcessStopped,
    generatedAt: new Date().toISOString(),
    cpuPlate: {
      online: true,
      processCount: processRows.length,
      runningProcesses: processRows.filter((item) => item.status === 'running').length,
    },
    processes: processRows,
    mg3000: controllers,
    channels: channelPayload,
    doorStatus: {
      channels: channelDoorStatus,
      channelStates,
      mg3000: controllers,
    },
  };
}

function clearPlateBatchIdleTimer() {
  if (!plateBatchIdleTimer) return;
  clearTimeout(plateBatchIdleTimer);
  plateBatchIdleTimer = null;
}

function stopSharedPlateBatchWorker(reason = 'stopped') {
  clearPlateBatchIdleTimer();
  const proc = plateBatchWorkerProcess;
  if (!proc) return;

  try {
    if (proc.stdin && !proc.stdin.destroyed && proc.stdin.writable) {
      proc.stdin.write(JSON.stringify({ action: 'shutdown', reason }) + '\n');
    }
  } catch (_) {
    // no-op
  }

  try {
    proc.kill('SIGTERM');
  } catch (_) {
    // no-op
  }

  setTimeout(() => {
    if (plateBatchWorkerProcess === proc && !proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch (_) {
        // no-op
      }
    }
  }, 1800);
}

function schedulePlateBatchIdleShutdown() {
  clearPlateBatchIdleTimer();
  if (plateBatchChannelIds.size > 0) return;
  if (!plateBatchWorkerProcess) return;
  if (SHARED_PLATE_BATCH_IDLE_STOP_MS <= 0) {
    stopSharedPlateBatchWorker('idle');
    return;
  }
  plateBatchIdleTimer = setTimeout(() => {
    if (plateBatchChannelIds.size === 0) {
      stopSharedPlateBatchWorker('idle');
    }
  }, SHARED_PLATE_BATCH_IDLE_STOP_MS);
}

function ensureSharedPlateBatchWorker() {
  if (!SHARED_PLATE_BATCH_ENABLED) return null;
  clearPlateBatchIdleTimer();

  if (plateBatchWorkerProcess && !plateBatchWorkerProcess.killed) {
    return plateBatchWorkerProcess;
  }

  const args = ['plateReaderBatch.py'];
  if (INTERNAL_SOCKET_TOKEN) {
    args.push('--socket_token', INTERNAL_SOCKET_TOKEN);
  }

  const proc = spawn(PYTHON_BIN, args);
  plateBatchWorkerProcess = proc;
  plateBatchWorkerStdoutBuffer = '';

  console.log('[plate-batch] worker iniciado:', [PYTHON_BIN, ...args].join(' '));

  proc.stdout.on('data', (data) => {
    plateBatchWorkerStdoutBuffer += data.toString();
    const lines = plateBatchWorkerStdoutBuffer.split('\n');
    plateBatchWorkerStdoutBuffer = lines.pop() || '';
    lines.forEach((line) => {
      const msg = String(line || '').trim();
      if (!msg) return;
      console.log(msg);
    });
  });

  proc.stderr.on('data', (data) => {
    console.error(`[plate-batch][stderr] ${data.toString()}`);
  });

  proc.on('close', (code) => {
    const affected = Array.from(plateBatchChannelIds);
    plateBatchChannelIds.clear();
    clearPlateBatchIdleTimer();
    plateBatchWorkerProcess = null;
    plateBatchWorkerStdoutBuffer = '';

    console.warn(`[plate-batch] worker encerrado com código ${code}`);

    affected.forEach((channelId) => {
      const info = processes[channelId];
      if (!info || info.managedBy !== 'plate_batch') return;
      info.status = 'error';
      info.errorType = 'shared_worker_closed';
      io.emit('process-error', { channelId, errorType: 'shared_worker_closed' });
      io.emit('process-stopped', { channelId });
      delete processes[channelId];
    });
  });

  return proc;
}

function sendSharedPlateBatchCommand(command) {
  const proc = ensureSharedPlateBatchWorker();
  if (!proc) return false;
  if (!proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) return false;

  try {
    proc.stdin.write(JSON.stringify(command) + '\n');
    return true;
  } catch (error) {
    console.error('[plate-batch] falha ao enviar comando:', error?.message || error);
    return false;
  }
}

function registerPlateChannelOnSharedWorker(config) {
  clearPlateBatchIdleTimer();
  const ok = sendSharedPlateBatchCommand({
    action: 'add_channel',
    config,
  });
  if (!ok) return false;
  plateBatchChannelIds.add(config.channelId);
  return true;
}

function unregisterPlateChannelOnSharedWorker(channelId) {
  if (!channelId) return false;
  const existed = plateBatchChannelIds.has(channelId);
  if (existed) {
    sendSharedPlateBatchCommand({
      action: 'remove_channel',
      channelId,
    });
    plateBatchChannelIds.delete(channelId);
  }
  schedulePlateBatchIdleShutdown();
  return existed;
}

async function waitForMg300Gap(queueKey) {
  if (MG300_MIN_COMMAND_GAP_MS <= 0) return;
  const lastAt = mg300LastCommandAt.get(queueKey) || 0;
  const waitMs = lastAt + MG300_MIN_COMMAND_GAP_MS - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function enqueueMg300Command(queueKey, taskFn) {
  const previous = mg300CommandQueues.get(queueKey) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => taskFn());

  mg300CommandQueues.set(queueKey, next);
  next.finally(() => {
    if (mg300CommandQueues.get(queueKey) === next) {
      mg300CommandQueues.delete(queueKey);
    }
  });

  return next;
}


// Requisições pendentes de "live capture" baseadas em eventos reais de placa
// Map: channelId -> { res, timer, startedAt, areaId }
const liveCaptureWaits = new Map();

// timeWindow por canal (ms) para correlação speed x plate
const channelTimeWindowMs = new Map();

// aceita "8", 8, "8000", 8000 etc.
// regra: valores <= 120 assumimos que estão em segundos (converte para ms)
function normalizeTimeWindowMs(v, fallbackMs = 8000) {
  if (v === undefined || v === null || v === '') return fallbackMs;

  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;

  // se vier em segundos (ex: 6, 8, 10)
  if (n <= 120) return Math.round(n * 1000);

  // se vier em ms (ex: 8000, 6000)
  return Math.round(n);
}

function normalizeHttpEndpoint(rawValue, envName) {
  if (!rawValue) return null;
  try {
    return new URL(rawValue).toString();
  } catch (error) {
    console.warn(`${envName} inválido (${rawValue}). Envio para essa API será desabilitado.`);
    return null;
  }
}

function sanitizeStreamPath(pathValue) {
  return String(pathValue || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, '-');
}

function applyTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_m, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function resolveChannelStreamPath(channel) {
  const vars = {
    channelId: channel?._id || '',
    cameraIp: channel?.cameraIp || '',
    dvrChannel: channel?.dvrChannel ?? '',
    name: channel?.name || '',
    areaId: channel?.areaId || '',
  };
  return sanitizeStreamPath(applyTemplate(MEDIA_STREAM_PATH_TEMPLATE, vars));
}

function buildMediaUrlsForChannel(channel) {
  const streamPath = resolveChannelStreamPath(channel);
  if (!streamPath) {
    return { streamPath: null, mpegtsWsUrl: null };
  }

  const encodedChannelId = encodeURIComponent(channel?._id || '');
  const mpegtsWsUrl = encodedChannelId ? `${MPEGTS_WS_PREFIX}${encodedChannelId}` : null;

  return { streamPath, mpegtsWsUrl };
}

function resolveVideoDeliveryConfig(channel) {
  const { streamPath, mpegtsWsUrl } = buildMediaUrlsForChannel(channel);
  const requestedMode = VIDEO_DELIVERY_MODE;
  let mode = requestedMode === 'socket' ? 'socket' : 'mpegts';
  if (!['socket', 'mpegts'].includes(mode)) mode = 'mpegts';
  if (!MPEGTS_WS_ENABLED && mode === 'mpegts') mode = 'socket';
  if (mode === 'mpegts' && !mpegtsWsUrl) mode = 'socket';

  return {
    requestedMode,
    mode,
    streamPath,
    mpegtsWsUrl,
    socketFallback: VIDEO_SOCKET_FALLBACK,
  };
}

const mpegTsWsServer = new WebSocketServer({ noServer: true });
const mpegTsPipelines = new Map(); // channelId -> { ffmpeg, clients, idleTimer, restartTimer, ... }
const socketVideoConsumersByChannel = new Map(); // channelId -> Map(socketId, refCount)
const socketVideoConsumersBySocket = new Map(); // socketId -> Map(channelId, refCount)

function logDbRuntimeInfo() {
  const dbFiles = {
    settings: resolveDbFile('settings.db'),
    actions: resolveDbFile('actions.db'),
    areas: resolveDbFile('areas.db'),
    directions: resolveDbFile('directions.db'),
    mg3000: resolveDbFile('mg3000.db'),
    interlocks: resolveDbFile('interlocks.db'),
    plates: resolveDbFile('plates.db'),
    events: resolveDbFile('events.db'),
  };

  console.log('[DB] baseDir:', DB_BASE_DIR);
  console.log('[DB] files:', dbFiles);

  platesDb.count({}, (err, count) => {
    if (err) {
      console.error('[DB] erro ao contar plates:', err.message);
      return;
    }
    console.log(`[DB] plates records loaded: ${count}`);
  });
}

function normalizeChannelId(channelId) {
  return String(channelId || '').trim();
}

function registerSocketVideoConsumer(socketId, channelId) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!socketId || !normalizedChannelId) return;

  const channelMap = socketVideoConsumersByChannel.get(normalizedChannelId) || new Map();
  channelMap.set(socketId, (channelMap.get(socketId) || 0) + 1);
  socketVideoConsumersByChannel.set(normalizedChannelId, channelMap);

  const socketMap = socketVideoConsumersBySocket.get(socketId) || new Map();
  socketMap.set(normalizedChannelId, (socketMap.get(normalizedChannelId) || 0) + 1);
  socketVideoConsumersBySocket.set(socketId, socketMap);
}

function unregisterSocketVideoConsumer(socketId, channelId) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!socketId || !normalizedChannelId) return;

  const channelMap = socketVideoConsumersByChannel.get(normalizedChannelId);
  if (channelMap) {
    const nextCount = (channelMap.get(socketId) || 0) - 1;
    if (nextCount > 0) {
      channelMap.set(socketId, nextCount);
    } else {
      channelMap.delete(socketId);
    }
    if (channelMap.size === 0) {
      socketVideoConsumersByChannel.delete(normalizedChannelId);
    }
  }

  const socketMap = socketVideoConsumersBySocket.get(socketId);
  if (socketMap) {
    const nextCount = (socketMap.get(normalizedChannelId) || 0) - 1;
    if (nextCount > 0) {
      socketMap.set(normalizedChannelId, nextCount);
    } else {
      socketMap.delete(normalizedChannelId);
    }
    if (socketMap.size === 0) {
      socketVideoConsumersBySocket.delete(socketId);
    }
  }
}

function clearSocketVideoConsumersForSocket(socketId) {
  if (!socketId) return;
  const socketMap = socketVideoConsumersBySocket.get(socketId);
  if (!socketMap) return;

  socketMap.forEach((count, channelId) => {
    const channelMap = socketVideoConsumersByChannel.get(channelId);
    if (!channelMap) return;

    const nextCount = (channelMap.get(socketId) || 0) - count;
    if (nextCount > 0) {
      channelMap.set(socketId, nextCount);
    } else {
      channelMap.delete(socketId);
    }

    if (channelMap.size === 0) {
      socketVideoConsumersByChannel.delete(channelId);
    }
  });

  socketVideoConsumersBySocket.delete(socketId);
}

function getVideoRuntimeStats(channelId) {
  const normalizedChannelId = normalizeChannelId(channelId);
  const pipeline = mpegTsPipelines.get(normalizedChannelId);
  const wsClients = pipeline?.clients?.size || 0;
  const socketClients = socketVideoConsumersByChannel.get(normalizedChannelId)?.size || 0;

  let activeTransport = 'idle';
  if (wsClients > 0 && socketClients > 0) {
    activeTransport = 'mixed';
  } else if (wsClients > 0) {
    activeTransport = 'mpegts';
  } else if (socketClients > 0) {
    activeTransport = 'socket';
  }

  return {
    activeTransport,
    wsClients,
    socketClients,
    ffmpegRunning: Boolean(pipeline?.ffmpeg),
  };
}

function emitSocketFrameToConsumers(channelId, payload) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId || !payload) return 0;

  const consumers = socketVideoConsumersByChannel.get(normalizedChannelId);
  if (!consumers || consumers.size === 0) {
    if (PLATE_DEBUG_ENABLED && shouldRateLog(noConsumerLogAt, normalizedChannelId, FRAME_DEBUG_INTERVAL_MS)) {
      debugLog(`frame sem consumidor socket | channel=${normalizedChannelId}`);
    }
    return 0;
  }

  let emittedCount = 0;
  consumers.forEach((_refCount, socketId) => {
    io.to(socketId).emit('frame', payload);
    emittedCount += 1;
  });

  return emittedCount;
}

function createSessionLikeResponse() {
  return {
    getHeader: () => undefined,
    setHeader: () => undefined,
    writeHead: () => undefined,
    end: () => undefined,
  };
}

function runSessionForUpgrade(req) {
  return new Promise((resolve, reject) => {
    const res = createSessionLikeResponse();
    sessionMiddleware(req, res, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(req.session);
    });
  });
}

function rejectUpgrade(socket, statusCode, statusText) {
  try {
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  } catch (_) {
    // no-op
  }
  try {
    socket.destroy();
  } catch (_) {
    // no-op
  }
}

function getOrCreateMpegTsPipeline(channelId) {
  if (mpegTsPipelines.has(channelId)) {
    return mpegTsPipelines.get(channelId);
  }

  const pipeline = {
    channelId,
    clients: new Set(),
    ffmpeg: null,
    idleTimer: null,
    restartTimer: null,
    frameRate: MPEGTS_DEFAULT_FPS,
    receivedFrames: 0,
    droppedFrames: 0,
  };
  mpegTsPipelines.set(channelId, pipeline);
  return pipeline;
}

function clearMpegTsTimer(timerId) {
  if (!timerId) return null;
  try {
    clearTimeout(timerId);
  } catch (_) {
    // no-op
  }
  return null;
}

function broadcastMpegTsChunk(pipeline, chunk) {
  if (!chunk || chunk.length === 0) return;
  const deadClients = [];

  pipeline.clients.forEach((ws) => {
    if (!ws || ws.readyState !== 1) {
      deadClients.push(ws);
      return;
    }
    try {
      ws.send(chunk, { binary: true }, () => undefined);
    } catch (_) {
      deadClients.push(ws);
    }
  });

  deadClients.forEach((ws) => {
    pipeline.clients.delete(ws);
  });
}

function stopMpegTsPipeline(pipeline, reason = 'stopped') {
  if (!pipeline) return;

  pipeline.idleTimer = clearMpegTsTimer(pipeline.idleTimer);
  pipeline.restartTimer = clearMpegTsTimer(pipeline.restartTimer);

  if (!pipeline.ffmpeg) return;

  const ffmpegProcess = pipeline.ffmpeg;
  pipeline.ffmpeg = null;

  try {
    if (ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
      ffmpegProcess.stdin.end();
    }
  } catch (_) {
    // no-op
  }

  try {
    ffmpegProcess.kill('SIGTERM');
  } catch (_) {
    // no-op
  }

  setTimeout(() => {
    try {
      if (!ffmpegProcess.killed) {
        ffmpegProcess.kill('SIGKILL');
      }
    } catch (_) {
      // no-op
    }
  }, 1200);

  console.log(`[MPEGTS] pipeline ${pipeline.channelId} ${reason}`);
}

function scheduleMpegTsIdleStop(pipeline) {
  pipeline.idleTimer = clearMpegTsTimer(pipeline.idleTimer);
  if (pipeline.clients.size > 0) return;

  pipeline.idleTimer = setTimeout(() => {
    pipeline.idleTimer = null;
    if (pipeline.clients.size > 0) return;
    stopMpegTsPipeline(pipeline, 'idle_timeout');
    if (pipeline.clients.size === 0 && !pipeline.ffmpeg) {
      mpegTsPipelines.delete(pipeline.channelId);
    }
  }, MPEGTS_IDLE_STOP_MS);
}

function startMpegTsPipeline(pipeline, frameRateHint = MPEGTS_DEFAULT_FPS) {
  if (!MPEGTS_WS_ENABLED) return;
  if (pipeline.ffmpeg) return;

  const fps = Number.isFinite(Number(frameRateHint))
    ? Math.max(1, Number(frameRateHint))
    : MPEGTS_DEFAULT_FPS;

  pipeline.frameRate = fps;
  pipeline.restartTimer = clearMpegTsTimer(pipeline.restartTimer);
  pipeline.receivedFrames = 0;
  pipeline.droppedFrames = 0;

  const bitrateValue = `${MPEGTS_BITRATE_KBPS}k`;
  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-f', 'mjpeg',
    '-r', String(fps),
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'mpeg1video',
    '-bf', '0',
    '-q:v', String(MPEGTS_QUALITY),
    '-b:v', bitrateValue,
    '-maxrate', bitrateValue,
    '-bufsize', `${MPEGTS_BITRATE_KBPS * 2}k`,
    '-f', 'mpegts',
    'pipe:1',
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  pipeline.ffmpeg = ffmpegProcess;
  console.log(`[MPEGTS] ffmpeg start channel=${pipeline.channelId} fps=${fps}`);

  ffmpegProcess.stdout.on('data', (chunk) => {
    broadcastMpegTsChunk(pipeline, chunk);
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const message = data.toString().trim();
    if (!message) return;
    console.warn(`[MPEGTS] ffmpeg(${pipeline.channelId}): ${message}`);
  });

  ffmpegProcess.on('error', (error) => {
    console.error(`[MPEGTS] erro ffmpeg em ${pipeline.channelId}:`, error.message);
  });

  ffmpegProcess.on('close', (code, signal) => {
    const hadProcess = pipeline.ffmpeg === ffmpegProcess;
    if (hadProcess) {
      pipeline.ffmpeg = null;
    }

    if (code !== 0 && signal !== 'SIGTERM') {
      console.warn(
        `[MPEGTS] ffmpeg fechado em ${pipeline.channelId} (code=${code}, signal=${signal || 'none'})`
      );
    }

    if (pipeline.clients.size > 0 && !pipeline.restartTimer) {
      pipeline.restartTimer = setTimeout(() => {
        pipeline.restartTimer = null;
        if (pipeline.clients.size > 0 && !pipeline.ffmpeg) {
          startMpegTsPipeline(pipeline, pipeline.frameRate);
        }
      }, 1000);
    } else if (pipeline.clients.size === 0) {
      scheduleMpegTsIdleStop(pipeline);
    }
  });
}

function pushFrameToMpegTs(channelId, image, frameRateHint = MPEGTS_DEFAULT_FPS) {
  if (!MPEGTS_WS_ENABLED) return;
  if (!channelId || !image) return;

  const pipeline = mpegTsPipelines.get(channelId);
  if (!pipeline || pipeline.clients.size === 0) return;

  if (!pipeline.ffmpeg) {
    startMpegTsPipeline(pipeline, frameRateHint);
  }

  const ffmpegProcess = pipeline.ffmpeg;
  if (!ffmpegProcess || !ffmpegProcess.stdin || ffmpegProcess.stdin.destroyed) return;

  let frameBuffer = null;
  if (Buffer.isBuffer(image)) {
    frameBuffer = image;
  } else if (image instanceof ArrayBuffer) {
    frameBuffer = Buffer.from(image);
  } else if (ArrayBuffer.isView(image)) {
    frameBuffer = Buffer.from(image.buffer, image.byteOffset, image.byteLength);
  } else if (typeof image === 'string' && image.length > 0) {
    frameBuffer = Buffer.from(image, 'base64');
  }

  if (!frameBuffer) return;
  if (frameBuffer.length === 0) return;

  if (ffmpegProcess.stdin.writableLength > MPEGTS_STDIN_MAX_BUFFER_BYTES) {
    pipeline.droppedFrames += 1;
    return;
  }

  try {
    pipeline.receivedFrames += 1;
    ffmpegProcess.stdin.write(frameBuffer);
  } catch (_) {
    pipeline.droppedFrames += 1;
  }
}

mpegTsWsServer.on('connection', (ws, _req, channel) => {
  const channelId = channel?.id;
  const frameRate = channel?.frameRate || MPEGTS_DEFAULT_FPS;
  if (!channelId) {
    try {
      ws.close(1008, 'channel_required');
    } catch (_) {
      // no-op
    }
    return;
  }

  const pipeline = getOrCreateMpegTsPipeline(channelId);
  pipeline.idleTimer = clearMpegTsTimer(pipeline.idleTimer);
  pipeline.clients.add(ws);
  startMpegTsPipeline(pipeline, frameRate);

  ws.on('close', () => {
    pipeline.clients.delete(ws);
    scheduleMpegTsIdleStop(pipeline);
  });

  ws.on('error', () => {
    pipeline.clients.delete(ws);
    scheduleMpegTsIdleStop(pipeline);
  });
});

http.on('upgrade', async (req, socket, head) => {
  if (!MPEGTS_WS_ENABLED) return;

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || '', 'http://localhost');
  } catch (_) {
    return;
  }

  if (!parsedUrl.pathname.startsWith(MPEGTS_WS_PREFIX)) {
    return;
  }

  const channelId = decodeURIComponent(parsedUrl.pathname.slice(MPEGTS_WS_PREFIX.length) || '').trim();
  if (!channelId || channelId.includes('/') || channelId.includes('\\')) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }

  try {
    await runSessionForUpgrade(req);
  } catch (error) {
    console.error('[MPEGTS] erro ao validar sessão de upgrade:', error.message);
    rejectUpgrade(socket, 500, 'Internal Server Error');
    return;
  }

  const token = parsedUrl.searchParams.get('token');
  const isAuthorizedSession = req.session?.auth === true;
  const isAuthorizedToken = INTERNAL_SOCKET_TOKEN && token === INTERNAL_SOCKET_TOKEN;
  if (!isAuthorizedSession && !isAuthorizedToken) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  settingsDb.findOne({ _id: channelId }, (err, channel) => {
    if (err || !channel) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const frameRate = Math.max(1, Number(channel.fps) || MPEGTS_DEFAULT_FPS);
    mpegTsWsServer.handleUpgrade(req, socket, head, (ws) => {
      mpegTsWsServer.emit('connection', ws, req, { id: channelId, frameRate });
    });
  });
});

// ==== Envio HTTP para a API central de eventos de placa ====
const API_PLATE_ENDPOINT = normalizeHttpEndpoint(process.env.PLATE_EVENT_URL, 'PLATE_EVENT_URL');
const API_VEHICLE_PLATE_ENDPOINT = normalizeHttpEndpoint(
  process.env.VEHICLE_PLATE_EVENT_URL,
  'VEHICLE_PLATE_EVENT_URL'
) || deriveVehiclePlateEndpoint(API_PLATE_ENDPOINT);
const API_MG3000_EVENT_ENDPOINT = normalizeHttpEndpoint(
  process.env.MG3000_EVENT_URL || process.env.MG3000_EVENT_ENDPOINT,
  'MG3000_EVENT_URL'
) || deriveMg3000EventEndpoint(API_PLATE_ENDPOINT);
const API_SPEED_ENDPOINT = normalizeHttpEndpoint(process.env.SPEED_EVENT_URL, 'SPEED_EVENT_URL');
const VEHICLE_APIKEY_FETCH_TIMEOUT_MS = Number.isFinite(Number(process.env.VEHICLE_APIKEY_FETCH_TIMEOUT_MS))
  ? Math.max(500, Number(process.env.VEHICLE_APIKEY_FETCH_TIMEOUT_MS))
  : 1500;
const VEHICLE_APIKEY_CACHE_TTL_MS = Number.isFinite(Number(process.env.VEHICLE_APIKEY_CACHE_TTL_MS))
  ? Math.max(1000, Number(process.env.VEHICLE_APIKEY_CACHE_TTL_MS))
  : 5 * 60 * 1000;
let warnedMissingPlateEventUrl = false;
let warnedMissingVehiclePlateEventUrl = false;
let warnedMissingSpeedEventUrl = false;
const vehicleApiKeyCache = new Map();

// speed threshold por canal (km/h): maxSpeed + tolerance
const channelMaxSpeed = new Map();  
const channelTolerance = new Map();
const channelDecisionSpeed = new Map(); // channelId -> number

// Node 18+ já tem fetch global. Se for Node < 18 e precisar, descomente:
// const fetch = require('node-fetch');

function deriveVehiclePlateEndpoint(baseEndpoint) {
  if (!baseEndpoint) return null;
  try {
    const parsed = new URL(baseEndpoint);
    parsed.pathname = '/vehicle/plateevent';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function deriveMg3000EventEndpoint(baseEndpoint) {
  if (!baseEndpoint) return null;
  try {
    const parsed = new URL(baseEndpoint);
    parsed.pathname = '/mg3000/event';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function resolveVehicleNetworkFromChannel(channel = {}) {
  return {
    host: String(channel?.vehicleAdd || channel?.equipAdd || '').trim(),
    port: toPositiveInt(channel?.vehiclePort || channel?.equipPort, 80),
    user: String(channel?.vehicleUser || '').trim(),
    pass: String(channel?.vehiclePass || '').trim(),
  };
}

function buildVehicleAuthHeaders(channel = {}) {
  const { user, pass } = resolveVehicleNetworkFromChannel(channel);
  if (!user && !pass) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  };
}

async function fetchVehicleApiKeyFromController(channel, channelId) {
  const { host, port } = resolveVehicleNetworkFromChannel(channel);
  if (!host) return '';

  const cacheKey = `${host}:${port}`;
  const cached = vehicleApiKeyCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now && cached.apiKey) {
    return cached.apiKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VEHICLE_APIKEY_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`http://${host}:${port}/api/config`, {
      method: 'GET',
      headers: buildVehicleAuthHeaders(channel),
      signal: controller.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn(
        `[plateevent] Canal ${channelId}: falha ao obter apiKey do Dozz Vehicle (${host}:${port}) status=${resp.status} body=${txt}`
      );
      return '';
    }

    const json = await resp.json().catch(() => ({}));
    const resolvedApiKey = String(
      json?.apiKey || json?.config?.apiKey || ''
    ).trim();
    if (!resolvedApiKey) {
      console.warn(
        `[plateevent] Canal ${channelId}: Dozz Vehicle (${host}:${port}) respondeu sem apiKey em /api/config.`
      );
      return '';
    }

    vehicleApiKeyCache.set(cacheKey, {
      apiKey: resolvedApiKey,
      expiresAt: now + VEHICLE_APIKEY_CACHE_TTL_MS
    });
    return resolvedApiKey;
  } catch (error) {
    const msg = error?.name === 'AbortError'
      ? `timeout ${VEHICLE_APIKEY_FETCH_TIMEOUT_MS}ms`
      : (error?.message || String(error));
    console.warn(
      `[plateevent] Canal ${channelId}: erro ao consultar apiKey no Dozz Vehicle (${host}:${port}): ${msg}`
    );
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function postPlateEvent({ plate, channelId, camera }) {
  try {
    const normalizedPlate = String(plate || '').trim().toUpperCase();
    if (!normalizedPlate) return;

    const doorDriver = normalizeDoorDriver(camera?.doorDriver);
    if (doorDriver === 'dozz_vehicle') {
      if (!API_VEHICLE_PLATE_ENDPOINT) {
        if (!warnedMissingVehiclePlateEventUrl) {
          warnedMissingVehiclePlateEventUrl = true;
          console.warn(
            'VEHICLE_PLATE_EVENT_URL/PLATE_EVENT_URL não definido. Envio de vehicle/plateevent desabilitado.'
          );
        }
        return;
      }

      let apiKey = String(camera?.apiKey || '').trim();
      if (!apiKey) {
        apiKey = await fetchVehicleApiKeyFromController(camera, channelId);
      }
      const vehicleChannel = toPositiveInt(camera?.vehicleChannel || camera?.port, 0);
      if (!apiKey || vehicleChannel < 1) {
        const missing = [];
        if (!apiKey) missing.push('apiKey');
        if (vehicleChannel < 1) missing.push('channel');
        console.warn(
          `[plateevent] Canal ${channelId}: payload inválido para dozz_vehicle (faltando: ${missing.join(', ') || 'desconhecido'}).`
        );
        return;
      }

      const payload = {
        apiKey,
        plate: normalizedPlate,
        channel: String(vehicleChannel),
        source: 'dozz_plate'
      };

      const resp = await fetch(API_VEHICLE_PLATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        console.error('vehicle/plateevent falhou:', resp.status, txt);
      }
      return;
    }

    if (!API_PLATE_ENDPOINT) {
      if (!warnedMissingPlateEventUrl) {
        warnedMissingPlateEventUrl = true;
        console.warn('PLATE_EVENT_URL não definido. Envio de plateevent desabilitado.');
      }
      return;
    }

    const equipAdd = String(camera?.equipAdd || '').trim();
    const receptorAdd = camera?.receptorAdd;
    const port = camera?.port;
    const missingLegacyPayload = !equipAdd
      || receptorAdd === undefined
      || receptorAdd === null
      || String(receptorAdd).trim() === ''
      || port === undefined
      || port === null
      || String(port).trim() === '';
    if (missingLegacyPayload) {
      console.warn(
        `[plateevent] Canal ${channelId}: payload inválido para /plateevent (equipAdd/receptorAdd/port ausentes).`
      );
      return;
    }

    const payload = {
      plate: normalizedPlate,
      equipAdd,
      receptorAdd: String(receptorAdd).trim(),
      port: String(port).trim()
    };
    const resp = await fetch(API_PLATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('plateevent falhou:', resp.status, txt);
    }
  } catch (e) {
    console.error('Erro ao enviar plateevent:', e);
  }
}

function postSpeedEvent(event) {
  // sendSpeedEventToApi(event);
  console.log('Dont send event to API')
}

// Helper para fazer o POST na API central
function sendSpeedEventToApi(event) {
  if (!API_SPEED_ENDPOINT) {
    if (!warnedMissingSpeedEventUrl) {
      warnedMissingSpeedEventUrl = true;
      console.warn('SPEED_EVENT_URL não definido. Envio de speedevent desabilitado.');
    }
    return;
  }

  console.log('Enviando speedEvent para API central:', {
    channelId: event.channelId,
    speed: event.speed,
  });

  fetch(API_SPEED_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
    .then((resp) => {
      if (!resp.ok) {
        return resp
          .text()
          .catch(() => '')
          .then((txt) => {
            console.error('speedevent falhou:', resp.status, txt);
          });
      } else {
        console.log('speedevent enviado com sucesso');
      }
    })
    .catch((e) => {
      console.error('Erro ao enviar speedevent:', e);
    });
}

// Página de login
app.get('/login', (req, res) => {
  if (req.session?.auth === true) return res.redirect('/');
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// API login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};

  if (username === AUTH_USER && password === AUTH_PASS) {
    // evita session fixation
    return req.session.regenerate((err) => {
      if (err) return res.status(500).json({ ok: false, message: 'Erro ao criar sessão.' });

      req.session.auth = true;
      req.session.user = username;

      // garante persistência antes de responder
      req.session.save((err2) => {
        if (err2) return res.status(500).json({ ok: false, message: 'Erro ao salvar sessão.' });
        return res.json({ ok: true });
      });
    });
  }

  return res.status(401).json({ ok: false, message: 'Usuário ou senha inválidos.' });
});

// API logout
app.post('/api/logout', (req, res) => {
  req.session?.destroy?.(() => {
    res.clearCookie("dozz.sid", {
      httpOnly: true,
      sameSite: COOKIE_SAMESITE,
      secure: COOKIE_SECURE,
    });
    return res.json({ ok: true });
  });
});

// ========================
// STATIC PROTEGIDO
// - Assets do login liberados
// - Todo o resto só autenticado
// ========================
const staticMiddleware = express.static(path.join(__dirname, 'public'), {
  index: false, // evita servir index.html automaticamente
});

app.use((req, res, next) => {
  // libera assets do login e rotas públicas
  if (isPublicPath(req)) {
    return staticMiddleware(req, res, next);
  }

  // autenticado -> pode acessar qualquer estático
  if (req.session?.auth === true) {
    return staticMiddleware(req, res, next);
  }

  // não autenticado -> não serve arquivo estático aqui
  return next();
});


function isPublicPath(req) {
  const p = req.path || '';

  // libera login e endpoints de auth
  if (p === '/login' || p === '/api/login') return true;

  // libera assets estáticos necessários para renderizar o login
  if (p.startsWith('/styles') || p.startsWith('/css') || p.startsWith('/js') || p.startsWith('/assets') || p.startsWith('/img') || p === '/favicon.ico') return true;

  return false;
}

function hasInternalSyncAccess(req) {
  const pathName = req.path || '';
  const internalPaths = new Set(['/sync', '/settings', '/api/processesStatus']);
  const isInternalCommandPath = /^\/api\/channels\/[^/]+\/open$/.test(pathName);
  if (!internalPaths.has(pathName) && !isInternalCommandPath) return false;

  // Compatibilidade: por padrão, /sync e /settings não exigem token.
  // Para exigir token, defina PLATE_SYNC_REQUIRE_TOKEN=true.
  if (!PLATE_SYNC_REQUIRE_TOKEN) return true;
  if (!INTERNAL_SOCKET_TOKEN) return true;

  const token =
    req.headers?.['x-internal-token'] ||
    req.query?.token ||
    req.body?.token;

  return String(token || '').trim() === INTERNAL_SOCKET_TOKEN;
}

app.use((req, res, next) => {
  if (isPublicPath(req) || hasInternalSyncAccess(req)) return next();

  // se autenticado, segue
  if (req.session?.auth === true) return next();

  if (((req.path || '') === '/sync' || (req.path || '') === '/settings') && PLATE_SYNC_REQUIRE_TOKEN) {
    return res.status(401).json({ ok: false, message: 'Internal sync token required' });
  }

  // Para APIs: devolve 401 (frontend pode redirecionar)
  if ((req.path || '').startsWith('/api') || (req.path || '').startsWith('/capture') || (req.path || '').startsWith('/filtered-events')) {
    return res.status(401).json({ ok: false, message: 'Not authenticated' });
  }

  // Para páginas: manda pro login
  return res.redirect('/login');
});

// Rotas para servir as páginas HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/settings.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/channel_actions.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'channel_actions.html'));
});

app.get('/video.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'video.html'));
});

app.get('/mosaic.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mosaic.html'));
});

// Endpoint para obter todos os canais
app.get('/api/channels', (req, res) => {
  settingsDb.find({}, (err, docs) => {
    if (err) {
      res.status(500).send('Erro ao obter canais');
    } else {
      res.send(docs);
    }
  });
});

// Endpoint para obter canais ativos
app.get('/api/active-channels', (req, res) => {
  const activeChannelIds = Object.keys(processes);
  settingsDb.find({ _id: { $in: activeChannelIds } }, (err, activeChannels) => {
    if (err) {
      res.status(500).send('Erro ao obter canais ativos');
    } else {
      res.send(activeChannels);
    }
  });
});

app.get('/api/processesStatus', async (req, res) => {
  try {
    res.json(await buildGatewayStatusPayload());
  } catch (error) {
    console.error('[processesStatus] erro:', error);
    res.status(500).json({ ok: false, online: false, anyProcessStopped: true, error: error?.message || String(error) });
  }
});

app.get('/api/gate-status', async (req, res) => {
  try {
    res.json(await buildGatewayStatusPayload());
  } catch (error) {
    console.error('[gate-status] erro:', error);
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/api/mg3000/events', async (req, res) => {
  try {
    const body = req.body || {};
    console.log('[mg3000-events] http recebido body=', JSON.stringify(body).slice(0, 1000));
    const eventKey = String(body.eventKey || '').trim();
    const doorStatus = body.doorStatus === true || body.status === true || body.gateStatus === 'closed'
      ? true
      : (body.doorStatus === false || body.status === false || body.gateStatus === 'open' ? false : null);
    const normalizedEventKey = eventKey || (doorStatus === true ? 'portaFechou' : 'portaAbriu');
    const payload = {
      ...body,
      eventKey: normalizedEventKey,
      apiEventKey: resolveMg3000ApiEventKey({ eventKey: normalizedEventKey }) || null,
      receptorAdd: toIntegerOrNull(body.receptorAdd ?? body.receptor) ?? 1,
      doorNumber: toIntegerOrNull(body.door ?? body.port ?? body.doorNumber) ?? 1,
      controllerAddress: body.controllerAddress || body.equipAdd || null,
      apiKey: body.apiKey || null,
      doorStatus,
      gateStatus: normalizeGateStatusFromDoorStatus(doorStatus),
      timestamp: body.timestamp || new Date().toISOString(),
      rawHex: body.rawHex || null,
    };
    console.log(`[mg3000-events] http normalizado ${describeMg300Event(payload)}`);
    await applyMg3000EventToLocalState(payload);
    await forwardMg3000EventToApiRedis(payload);
    res.json({ ok: true, event: payload });
  } catch (error) {
    console.error('[mg3000-events] erro:', error);
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get('/api/interlocks', async (req, res) => {
  try {
    const channels = await findAsync(settingsDb, {});
    const docs = (await findAsync(interlocksDb, {}))
      .filter((doc) => doc?._id !== INTERLOCK_SETTINGS_ID && doc?.type !== 'settings');
    docs.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    res.json({
      ok: true,
      interlocks: docs,
      settings: await getInterlockSettings(),
      doors: buildPhysicalDoorGroups(channels),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get('/api/interlocks/settings', async (req, res) => {
  try {
    res.json({ ok: true, settings: await getInterlockSettings() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/api/interlocks/settings', async (req, res) => {
  try {
    res.json({ ok: true, settings: await saveInterlockSettings(req.body || {}) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/api/interlocks', async (req, res) => {
  try {
    if (String(req.body?._id || '') === INTERLOCK_SETTINGS_ID) {
      return res.status(400).json({ ok: false, error: 'ID reservado para configuração global.' });
    }
    const existing = req.body?._id
      ? await findOneAsync(interlocksDb, { _id: String(req.body._id) }).catch(() => null)
      : null;
    const doc = normalizeInterlockDoc(req.body || {}, existing);
    const interlockMemberCount = doc.doorKeys.length || doc.channelIds.length;
    if (interlockMemberCount < 2) {
      return res.status(400).json({ ok: false, error: 'Selecione pelo menos 2 portas.' });
    }

    if (existing?._id) {
      await updateAsync(interlocksDb, { _id: existing._id }, doc, {});
      return res.json({ ok: true, interlock: doc });
    }

    const inserted = await insertAsync(interlocksDb, doc);
    res.json({ ok: true, interlock: inserted });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.delete('/api/interlocks/:interlockId', async (req, res) => {
  try {
    const removed = await removeAsync(interlocksDb, { _id: req.params.interlockId }, {});
    res.json({ ok: true, removed });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get('/api/doors', async (req, res) => {
  try {
    res.json({ ok: true, doors: buildPhysicalDoorGroups(await findAsync(settingsDb, {})) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

// Endpoint para obter um canal específico
app.get('/api/channels/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  settingsDb.findOne({ _id: channelId }, (err, channel) => {
    if (err || !channel) {
      res.status(500).send('Canal não encontrado');
    } else {
      res.send(channel);
    }
  });
});

app.all('/api/channels/:channelId/open', async (req, res) => {
  try {
    await openDoor(req.params.channelId);
    res.json({ ok: true });
  } catch (error) {
    const statusCode = error?.code === 'interlock_blocked'
      ? 409
      : (error?.code === 'gate_cooldown' ? 429 : 500);
    res.status(statusCode).json({
      ok: false,
      code: error?.code || 'open_failed',
      error: error?.message || String(error),
      interlock: error?.interlock || null,
      cooldown: error?.cooldown || null,
    });
  }
});

app.get('/api/video-stream/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  settingsDb.findOne({ _id: channelId }, (err, channel) => {
    if (err || !channel) {
      return res.status(404).json({ ok: false, error: 'Canal não encontrado' });
    }

    const config = resolveVideoDeliveryConfig(channel);
    return res.json({
      ok: true,
      channelId,
      ...config,
      runtime: getVideoRuntimeStats(channelId),
    });
  });
});

// Endpoint para criar ou atualizar um canal
app.post('/api/channels', (req, res) => {
  const channel = req.body;
  if (channel._id) {
    // Atualizar canal existente
    settingsDb.update({ _id: channel._id }, channel, {}, (err, numReplaced) => {
      if (err) {
        res.status(500).send('Erro ao atualizar canal');
      } else {
        res.send({ success: true });
        refreshRunningSharedPlateChannel(channel._id);
      }
    });
  } else {
    // Criar novo canal
    settingsDb.insert(channel, (err, newDoc) => {
      if (err) {
        res.status(500).send('Erro ao criar canal');
      } else {
        res.send(newDoc);
      }
    });
  }
});

// Endpoint para excluir um canal
app.delete('/api/channels/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  settingsDb.remove({ _id: channelId }, {}, (err, numRemoved) => {
    if (err) {
      res.status(500).send('Erro ao excluir canal');
    } else {
      // Remover ações, áreas e direções associadas ao canal
      actionsDb.remove({ channelId }, { multi: true }, (err) => {
        if (err) console.error('Erro ao remover ações associadas ao canal:', err);
      });
      areasDb.remove({ channelId }, { multi: true }, (err) => {
        if (err) console.error('Erro ao remover áreas associadas ao canal:', err);
      });
      directionsDb.remove({ channelId }, { multi: true }, (err) => {
        if (err) console.error('Erro ao remover direções associadas ao canal:', err);
      });
      res.send({ success: true });
    }
  });
});

// Endpoint para obter o status dos processos
app.get('/process-status', (req, res) => {
  const processStatus = Object.keys(processes).map(channelId => ({
    channelId,
    status: processes[channelId].status
  }));
  console.log('Process Status:', processStatus); // Adicionado para depuração
  res.json({ processes: processStatus });
});

// Função para iniciar o processo de detecção para um canal
app.post('/start-process/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  settingsDb.findOne({ _id: channelId }, (err, channel) => {
    if (err || !channel) {
      return res.status(500).send({ success: false, message: 'Canal não encontrado' });
    }

    if (processes[channelId]) {
      return res.send({ success: false, message: 'Processo já está em execução para este canal' });
    }

    actionsDb.find({ channelId }, (err, actions) => {
      if (err) {
        return res.status(500).send('Erro ao obter ações');
      }
      areasDb.find({ channelId }, (err, areas) => {
        if (err) {
          return res.status(500).send('Erro ao obter áreas');
        }
        directionsDb.find({ channelId }, (err, directions) => {
          if (err) {
            return res.status(500).send('Erro ao obter direções');
          }

          // Verificar tipo do canal
          const isPlateChannel = channel.channel_type;
          if (isPlateChannel === 'plate') {
            startPlateRecognition(channel, actions, areas, directions, res);
          } else if (isPlateChannel === 'ia') {
            startIAScanning(channel, actions, areas, directions, res);
          } else if (isPlateChannel === 'speed') {
            startSpeed(channel, res);
          }
        });
      });
    });
  });
});

function buildPlateBatchChannelConfig(channel, actions, areas, directions) {
  const channelId = channel._id;
  const ip = channel.cameraIp;
  const user = channel.username;
  const password = channel.password;
  const imgSize = Number(channel.imgSize) || 640;
  const device = channel.device;
  const frameRate = channel.fps || 5;
  const vectorSenseEnabled = parseStoredBoolean(channel.vectorSenseEnabled, true);
  const motionMode = String(channel.movementDirection || 'aproximando');
  const motionSensitivity = Number.isFinite(Number(channel.movementSensitivity))
    ? Math.max(1, Math.min(100, Number(channel.movementSensitivity)))
    : 60;
  const plateGuardEnabled = parseStoredBoolean(channel.plateGuardEnabled, true);
  const plateGuardDetEveryN = Number.isFinite(Number(channel.plateGuardDetEveryN))
    ? Math.max(1, Number(channel.plateGuardDetEveryN))
    : 2;
  const plateGuardVehicleConf = Number.isFinite(Number(channel.plateGuardVehicleConf))
    ? Math.max(0, Math.min(1, Number(channel.plateGuardVehicleConf)))
    : 0.22;
  const plateGuardFraudConf = Number.isFinite(Number(channel.plateGuardFraudConf))
    ? Math.max(0, Math.min(1, Number(channel.plateGuardFraudConf)))
    : 0.22;
  const plateGuardMinPlateOverlap = Number.isFinite(Number(channel.plateGuardMinPlateOverlap))
    ? Math.max(0, Math.min(1, Number(channel.plateGuardMinPlateOverlap)))
    : 0.55;
  const plateGuardExpandFactor = Number.isFinite(Number(channel.plateGuardExpandFactor))
    ? Math.max(1, Number(channel.plateGuardExpandFactor))
    : 1.8;
  const plateGuardFraudClasses = String(
    channel.plateGuardFraudClasses || 'person,cell phone,book,remote,laptop,tv'
  ).trim();
  const previewWebSide = Number.isFinite(Number(channel.previewWebSide))
    ? Math.max(320, Math.min(1920, Number(channel.previewWebSide)))
    : 640;
  const previewWebJpegQuality = Number.isFinite(Number(channel.previewWebJpegQuality))
    ? Math.max(10, Math.min(100, Number(channel.previewWebJpegQuality)))
    : 15;

  const safeActions = Array.isArray(actions) ? actions : [];
  const safeAreas = Array.isArray(areas) ? areas : [];
  const safeDirections = Array.isArray(directions) ? directions : [];
  const areasWithDirections = safeAreas.map((area) => ({
    ...area,
    directions: safeDirections.filter((direction) => direction.areaId === area._id),
  }));

  return {
    channelId,
    ip,
    user,
    password,
    dvrChannel: channel.dvrChannel,
    frameRate,
    imgSize,
    device,
    previewWebSide,
    previewWebJpegQuality,
    vectorSenseEnabled,
    motionMode,
    motionSensitivity,
    plateGuardEnabled,
    plateGuardDetEveryN,
    plateGuardVehicleConf,
    plateGuardFraudConf,
    plateGuardMinPlateOverlap,
    plateGuardExpandFactor,
    plateGuardFraudClasses,
    actions: safeActions,
    areas: areasWithDirections,
  };
}

function refreshRunningSharedPlateChannel(channelId) {
  const procInfo = processes[channelId];
  if (!procInfo || procInfo.managedBy !== 'plate_batch') return;

  settingsDb.findOne({ _id: channelId }, (channelErr, channel) => {
    if (channelErr || !channel) {
      console.error(`[plate-batch] Falha ao carregar canal para refresh runtime: ${channelId}`);
      return;
    }

    const channelType = String(channel.channel_type || 'plate').trim() || 'plate';
    if (channelType !== 'plate') {
      unregisterPlateChannelOnSharedWorker(channelId);
      io.emit('process-stopped', { channelId });
      delete processes[channelId];
      return;
    }

    actionsDb.find({ channelId }, (actionsErr, actions) => {
      if (actionsErr) {
        console.error(`[plate-batch] Falha ao carregar actions para refresh runtime: ${channelId}`, actionsErr);
        return;
      }
      areasDb.find({ channelId }, (areasErr, areas) => {
        if (areasErr) {
          console.error(`[plate-batch] Falha ao carregar areas para refresh runtime: ${channelId}`, areasErr);
          return;
        }
        directionsDb.find({ channelId }, (directionsErr, directions) => {
          if (directionsErr) {
            console.error(`[plate-batch] Falha ao carregar directions para refresh runtime: ${channelId}`, directionsErr);
            return;
          }

          const sharedConfig = buildPlateBatchChannelConfig(channel, actions, areas, directions);
          const ok = registerPlateChannelOnSharedWorker(sharedConfig);
          if (!ok) {
            processes[channelId].status = 'error';
            processes[channelId].errorType = 'shared_worker_update_failed';
            io.emit('process-error', { channelId, errorType: 'shared_worker_update_failed' });
            return;
          }

          processes[channelId].status = 'starting';
          processes[channelId].errorType = null;
          io.emit('process-starting', { channelId });
          refreshMg300StatusForChannelSoon(channel, 'channel_runtime_refresh');
          console.log(`[plate-batch] Configuração do canal aplicada em runtime: ${channelId}`);
        });
      });
    });
  });
}

function prewarmSharedPlateBatchWorkerFromSettings() {
  if (!SHARED_PLATE_BATCH_ENABLED) return;
  const proc = ensureSharedPlateBatchWorker();
  if (!proc) return;

  settingsDb.find({}, (err, channels) => {
    if (err || !Array.isArray(channels)) {
      console.warn('[plate-batch] Falha ao buscar settings para preload de modelo.');
      return;
    }

    const firstPlate = channels.find((channel) => {
      const channelType = String(channel?.channel_type || 'plate').trim() || 'plate';
      return channelType === 'plate';
    });

    if (!firstPlate) return;

    const imgSize = Number.isFinite(Number(firstPlate.imgSize))
      ? Math.max(320, Math.min(1920, Number(firstPlate.imgSize)))
      : 640;
    const rawDevice = String(firstPlate.device || 'cpu').trim().toLowerCase();
    const device = rawDevice.startsWith('gpu') || rawDevice === 'cuda' ? 'gpu' : 'cpu';
    sendSharedPlateBatchCommand({
      action: 'preload_bundle',
      imgSize,
      device,
      withDetector: false,
    });
  });
}

function startIAScanning(channel, actions, areas, directions, res) {
  // Lógica original do dozzVision
  areas.forEach((area) => {
    area.directions = directions.filter((direction) => direction.areaId === area._id);
  });

  const actionsBase64 = Buffer.from(JSON.stringify(actions)).toString('base64');
  const areasBase64 = Buffer.from(JSON.stringify(areas)).toString('base64');

  const args = [
    'detector.py',
    '--ip', channel.cameraIp,
    '--user', channel.username,
    '--password', channel.password,
    '--frame_rate', channel.fps.toString(),
    '--dvr_channel', channel.dvrChannel.toString(),
    '--device', channel.device,
    '--channel_id', channel._id,
    '--actions', actionsBase64,
    '--areas', areasBase64,
  ];

  const pythonProcess = spawn(PYTHON_BIN, args);

  processes[channel._id] = { process: pythonProcess, status: 'starting' };
  io.emit('process-starting', { channelId: channel._id });

  pythonProcess.stdout.on('data', (data) => {
    console.log(`Python stdout for channel ${channel._id}: ${data}`);
    let lines = data.toString().split('\n');
    lines.forEach((line) => {
      if (line.trim() === '') return;
      try {
        const jsonData = JSON.parse(line);
        if (jsonData.type === 'video_dimensions') {
          processes[channel._id].status = 'running';
          io.emit('process-started', { channelId: channel._id });
        } else if (jsonData.type === 'event') {
          const eventData = jsonData.data;
          handleEventFromPython(channel._id, eventData);
        } else if (jsonData.type === 'error') {
          console.error(`Erro no processo Python para o canal ${channel._id}: ${jsonData.data}`);
          processes[channel._id].status = 'error';
          io.emit('process-error', { channelId: channel._id, errorType: jsonData.data });
        }
      } catch (e) {
        console.error(`Erro ao processar saída do Python para o canal ${channel._id}: ${e.message}`);
        console.error(`Linha que causou o erro: ${line}`);
      }
    });
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`Erro no processo Python para o canal ${channel._id}: ${data.toString()}`);
  });

  pythonProcess.on('close', (code) => {
    if (processes[channel._id]) {
      processes[channel._id].status = 'stopped';
    }
    io.emit('process-stopped', { channelId: channel._id });
    console.log(`Processo Python para o canal ${channel._id} foi encerrado com código ${code}`);
    delete processes[channel._id];
  });

  res.send({ success: true });
}

// Função para iniciar o reconhecimento de placas (adaptada do dozzPlate)
function startPlateRecognition(channel, actions, areas, directions, res) {
  const sharedConfig = buildPlateBatchChannelConfig(channel, actions, areas, directions);
  const {
    channelId,
    ip,
    user,
    password,
    dvrChannel,
    frameRate,
    imgSize,
    device,
    previewWebSide,
    previewWebJpegQuality,
    vectorSenseEnabled,
    motionMode,
    motionSensitivity,
    plateGuardEnabled,
    plateGuardDetEveryN,
    plateGuardVehicleConf,
    plateGuardFraudConf,
    plateGuardMinPlateOverlap,
    plateGuardExpandFactor,
    plateGuardFraudClasses,
  } = sharedConfig;

  if (SHARED_PLATE_BATCH_ENABLED) {
    const registered = registerPlateChannelOnSharedWorker(sharedConfig);
    if (!registered) {
      return res.status(500).send({
        success: false,
        message: 'Falha ao registrar canal no worker compartilhado de placa',
      });
    }

    processes[channelId] = {
      process: plateBatchWorkerProcess,
      status: 'starting',
      managedBy: 'plate_batch',
      lastPlateDetectionTime: 0,
    };

    io.emit('process-starting', { channelId: channel._id });
    refreshMg300StatusForChannelSoon(channel, 'channel_start');
    return res.send({ success: true, sharedWorker: true });
  }

  const actionsBase64 = Buffer.from(JSON.stringify(sharedConfig.actions)).toString('base64');
  const areasBase64 = Buffer.from(JSON.stringify(sharedConfig.areas)).toString('base64');

  const args = [
    'plateReader.py', 
    '--ip', ip, 
    '--user', user, 
    '--password', password, 
    '--frame_rate', frameRate.toString(), 
    '--device', device,
    '--channel_id', channelId,
    '--dvr_channel', String(dvrChannel),
    '--imgsz', imgSize.toString(),
    '--stream_preview_side', previewWebSide.toString(),
    '--stream_jpeg_quality', previewWebJpegQuality.toString(),
    '--actions', actionsBase64,
    '--areas', areasBase64,
    '--vector_sense_enabled', vectorSenseEnabled ? 'true' : 'false',
    '--motion_mode', motionMode,
    '--motion_sensitivity', motionSensitivity.toString(),
    '--plate_guard_enabled', plateGuardEnabled ? 'true' : 'false',
    '--plate_guard_det_every_n', plateGuardDetEveryN.toString(),
    '--plate_guard_vehicle_conf', plateGuardVehicleConf.toString(),
    '--plate_guard_fraud_conf', plateGuardFraudConf.toString(),
    '--plate_guard_min_plate_overlap', plateGuardMinPlateOverlap.toString(),
    '--plate_guard_expand_factor', plateGuardExpandFactor.toString(),
    '--plate_guard_fraud_classes', plateGuardFraudClasses,
  ];

  if (INTERNAL_SOCKET_TOKEN) {
    args.push('--socket_token', INTERNAL_SOCKET_TOKEN);
  }

  const process = spawn(PYTHON_BIN, args);
  console.log(
    PYTHON_BIN,
    'plateReader.py', 
    '--ip', ip, 
    '--user', user, 
    '--password', password, 
    '--frame_rate', frameRate.toString(), 
    '--device', device,
    '--channel_id', channelId,
    '--dvr_channel', String(dvrChannel),
    '--imgsz', imgSize.toString(),
    '--stream_preview_side', previewWebSide.toString(),
    '--stream_jpeg_quality', previewWebJpegQuality.toString(),
    '--actions', actionsBase64,
    '--areas', areasBase64,
    '--vector_sense_enabled', vectorSenseEnabled ? 'true' : 'false',
    '--motion_mode', motionMode,
    '--motion_sensitivity', motionSensitivity.toString(),
    '--plate_guard_enabled', plateGuardEnabled ? 'true' : 'false',
    '--plate_guard_det_every_n', plateGuardDetEveryN.toString(),
    '--plate_guard_vehicle_conf', plateGuardVehicleConf.toString(),
    '--plate_guard_fraud_conf', plateGuardFraudConf.toString(),
    '--plate_guard_min_plate_overlap', plateGuardMinPlateOverlap.toString(),
    '--plate_guard_expand_factor', plateGuardExpandFactor.toString(),
    '--plate_guard_fraud_classes', plateGuardFraudClasses,
  );

  processes[channelId] = {
    process: process,
    status: 'starting',
    lastPlateDetectionTime: 0
  };

  io.emit('process-starting', { channelId: channel._id });
  refreshMg300StatusForChannelSoon(channel, 'channel_start');

  process.stdout.on('data', (data) => {
    const output = data.toString();
    console.log(output)
  });

  process.stderr.on('data', (data) => {
    console.error(`stderr [${ip}]: ${data.toString()}`);
  });

  process.on('error', (err) => {
    console.error(`Erro ao iniciar processo Plate para o canal ${channelId}:`, err);
  });

  process.on('close', (code) => {
    if (processes[channelId]) {
      processes[channelId].status = 'stopped';
    }
    io.emit('process-stopped', { channelId });
    console.log(`Processo Plate para o canal ${channelId} (ip ${ip}) foi encerrado com código ${code}`);
    delete processes[channelId];
  });
  
}

// Função para iniciar o reconhecimento de placas (adaptada do dozzPlate)
function startSpeed(channel, res) {
  const channelId = channel._id;
  const radarId = channel.radarId;
  const ip = channel.cameraIp;
  const user = channel.username;
  const password = channel.password;
  const imgSize = channel.imgSize;
  const device = channel.device;
  const frameRate = channel.fps || 5;
  const plateGuardEnabled = String(channel.plateGuardEnabled ?? 'true').trim().toLowerCase() !== 'false';
  const plateGuardDetEveryN = Number.isFinite(Number(channel.plateGuardDetEveryN))
    ? Math.max(1, Number(channel.plateGuardDetEveryN))
    : 2;
  const plateGuardVehicleConf = Number.isFinite(Number(channel.plateGuardVehicleConf))
    ? Math.max(0, Math.min(1, Number(channel.plateGuardVehicleConf)))
    : 0.22;
  const plateGuardFraudConf = Number.isFinite(Number(channel.plateGuardFraudConf))
    ? Math.max(0, Math.min(1, Number(channel.plateGuardFraudConf)))
    : 0.22;
  const plateGuardMinPlateOverlap = Number.isFinite(Number(channel.plateGuardMinPlateOverlap))
    ? Math.max(0, Math.min(1, Number(channel.plateGuardMinPlateOverlap)))
    : 0.55;
  const plateGuardExpandFactor = Number.isFinite(Number(channel.plateGuardExpandFactor))
    ? Math.max(1, Number(channel.plateGuardExpandFactor))
    : 1.8;
  const plateGuardFraudClasses = String(
    channel.plateGuardFraudClasses || 'person,cell phone,book,remote,laptop,tv'
  ).trim();
  const previewWebSide = Number.isFinite(Number(channel.previewWebSide))
    ? Math.max(320, Math.min(1920, Number(channel.previewWebSide)))
    : 640;
  const previewWebJpegQuality = Number.isFinite(Number(channel.previewWebJpegQuality))
    ? Math.max(10, Math.min(100, Number(channel.previewWebJpegQuality)))
    : 15;

  const maxSpeedNum = Number(channel.maxSpeed);
  const tolNum = Number(channel.tolerance);
  
  // Se não vier config, deixe como NaN e NÃO bloqueie (fail-open) ou defina default
  const decisionSpeed =
    (Number.isFinite(maxSpeedNum) ? maxSpeedNum : NaN) +
    (Number.isFinite(tolNum) ? tolNum : 0);

    channelMaxSpeed.set(channelId, maxSpeedNum);
    channelTolerance.set(channelId, tolNum);
    channelDecisionSpeed.set(channelId, decisionSpeed);

  console.log(`[SPEED] decisionSpeed canal ${channelId}: ${decisionSpeed} (max=${channel.maxSpeed}, tol=${channel.tolerance})`);

  // timeWindow configurável por canal (usado na janela speed x plate)
  const twMs = normalizeTimeWindowMs(channel.timeWindow, 8000);
  channelTimeWindowMs.set(channelId, twMs);
  console.log(`[SPEED] timeWindow do canal ${channelId}: ${twMs} ms (raw=${channel.timeWindow})`);

  if (!radarId) {
    console.error(`Canal ${channelId} é do tipo speed mas não tem radarId configurado.`);
  } else {
    radarIdToChannel.set(radarId, channelId);
    ensureRadarSubscription(radarId);
    console.log(`[SPEED] Canal ${channelId} associado ao radarId ${radarId}`);
  }

  const args = [
    'speed.py', 
    '--ip', ip, 
    '--user', user, 
    '--password', password, 
    '--frame_rate', frameRate.toString(), 
    '--device', device,
    '--channel_id', channelId,
    '--radarId', radarId,
    '--dvr_channel', channel.dvrChannel.toString(),
    '--imgsz', imgSize,
    '--stream_preview_side', previewWebSide.toString(),
    '--stream_jpeg_quality', previewWebJpegQuality.toString(),
    '--plate_guard_enabled', plateGuardEnabled ? 'true' : 'false',
    '--plate_guard_det_every_n', plateGuardDetEveryN.toString(),
    '--plate_guard_vehicle_conf', plateGuardVehicleConf.toString(),
    '--plate_guard_fraud_conf', plateGuardFraudConf.toString(),
    '--plate_guard_min_plate_overlap', plateGuardMinPlateOverlap.toString(),
    '--plate_guard_expand_factor', plateGuardExpandFactor.toString(),
    '--plate_guard_fraud_classes', plateGuardFraudClasses,
  ];

  if (INTERNAL_SOCKET_TOKEN) {
    args.push('--socket_token', INTERNAL_SOCKET_TOKEN);
  }
  
  const process = spawn(PYTHON_BIN, args);
  console.log(
    PYTHON_BIN,
    'speed.py', 
    '--ip', ip, 
    '--user', user, 
    '--password', password, 
    '--frame_rate', frameRate.toString(), 
    '--device', device,
    '--channel_id', channelId,
    '--radarId', radarId,
    '--dvr_channel', channel.dvrChannel.toString(),
    '--imgsz', imgSize,
    '--stream_preview_side', previewWebSide.toString(),
    '--stream_jpeg_quality', previewWebJpegQuality.toString(),
    '--plate_guard_enabled', plateGuardEnabled ? 'true' : 'false',
    '--plate_guard_det_every_n', plateGuardDetEveryN.toString(),
    '--plate_guard_vehicle_conf', plateGuardVehicleConf.toString(),
    '--plate_guard_fraud_conf', plateGuardFraudConf.toString(),
    '--plate_guard_min_plate_overlap', plateGuardMinPlateOverlap.toString(),
    '--plate_guard_expand_factor', plateGuardExpandFactor.toString(),
    '--plate_guard_fraud_classes', plateGuardFraudClasses
  );

  processes[channelId] = {
    process: process,
    status: 'starting',
    lastPlateDetectionTime: 0
  };

  io.emit('process-starting', { channelId: channel._id });

  process.stdout.on('data', (data) => {
    const output = data.toString();
    console.log(output)
  });

  process.stderr.on('data', (data) => {
    console.error(`stderr [${ip}]: ${data.toString()}`);
  });

  process.on('close', (code) => {
    if (processes[channelId]) {
      processes[channelId].status = 'stopped';
    }
    io.emit('process-stopped', { channelId });
    console.log(`Processo Speed para o canal ${channelId} (ip ${ip}) foi encerrado com código ${code}`);
    delete processes[channelId];
  });
  
}

function handlePlateDetection(channelId, plateData, direction, timestamp, metadata = {}) {
  const shouldLock = direction === true;
  if (shouldLock && plateDetectionLocks.has(channelId)) {
    console.log(`[plate] Ignorando evento concorrente no canal ${channelId} para evitar duplicidade de comando.`);
    return;
  }

  if (shouldLock) {
    plateDetectionLocks.add(channelId);
  }

  const releaseLock = () => {
    if (shouldLock) {
      plateDetectionLocks.delete(channelId);
    }
  };

  settingsDb.findOne({ _id: channelId }, (err, camera) => {
    if (err || !camera) {
      console.error(`Câmera com channelId ${channelId} não encontrada no settingsDb.`);
      releaseLock();
      return;
    }

    // Aplicar lógica de supressão de 5s apenas se direction === true
    if (direction === true) {
      const now = Date.now();
      const lastTime = processes[channelId]?.lastPlateDetectionTime || 0;
      // Verificar intervalo de supressão (5s)
      if (now - lastTime < 5000) {
        console.log(`Ignorando placa detectada em ${channelId} devido ao intervalo de supressão.`);
        releaseLock();
        return;
      }

      const cooldown = getActiveChannelGateCooldown(channelId);
      if (cooldown) {
        if (processes[channelId]) {
          processes[channelId].lastPlateDetectionTime = Date.now();
        }
        console.log(`[gate-cooldown] ignorando placa no canal ${channelId}; restanteMs=${Math.ceil(cooldown.remainingMs)} reason=${cooldown.reason || '-'}`);
        releaseLock();
        return;
      }
    }

    platesDb.find({}, (err, docs) => {
      try {
        if (err) {
          console.error('Erro ao consultar platesDb:', err);
          return;
        }

        let plateFound = false;
        for (const doc of docs) {
          const { userName, unid, grupo, devices } = doc;
          const safeDevices = Array.isArray(devices) ? devices : [];
          for (const device of safeDevices) {
            const dbPlate = device.plate;
            if (platesMatch(plateData, dbPlate)) {
              console.log(`Placa correspondente encontrada: ${dbPlate}`);
              plateFound = true;

              // Atualizar o lastPlateDetectionTime somente se direction === true
              if (direction === true) {
                if (processes[channelId]) {
                  processes[channelId].lastPlateDetectionTime = Date.now();
                }

                openDoor(channelId)
                  .then(() => {
                    io.to(channelId).emit('door-command-result', {
                      channelId,
                      plate: dbPlate,
                      accepted: true,
                      direction: true,
                      timestamp: Date.now(),
                    });
                  })
                  .catch((error) => {
                    console.error(`Erro ao abrir porta no canal ${channelId}:`, error);
                    io.to(channelId).emit('door-command-result', {
                      channelId,
                      plate: dbPlate,
                      accepted: false,
                      direction: true,
                      message: error?.code || error?.message || 'unknown_error',
                      timestamp: Date.now(),
                    });
                  });
                console.log('Open Door')

                // >>> ENVIAR EVENTO HTTP PARA A API CENTRAL <<<
                // Usa os parâmetros cadastrados no canal (camera) que já pegamos no início da função
                postPlateEvent({
                  plate: dbPlate,
                  channelId,
                  camera
                });

                const customerInfo = {
                  plate: dbPlate,
                  name: userName,
                  group: grupo,
                  unit: unid,
                  make: device.make,
                  model: device.model,
                  color: device.color,
                };

                const tsMs = toMs(timestamp);

                const event = {
                  eventType: 'plate',
                  channelId: channelId,
                  customerInfo: customerInfo,
                  timestamp: tsMs,
                  vectorSenseEnabled: metadata.vectorSenseEnabled ?? null,
                  motionMode: metadata.motionMode || null,
                  expectedOrientation: metadata.expectedOrientation || null,
                  vehicleOrientation: metadata.vehicleOrientation || null,
                  orientationConf: metadata.orientationConf ?? null,
                  orientationCounts: metadata.orientationCounts || null,
                  orientationScores: metadata.orientationScores || null,
                  sourceEventType: metadata.eventType || null,
                };

                // Salvar no eventsDb
                eventsDb.insert(event, (err, newDoc) => {
                  if (err) {
                    console.error('Erro ao salvar o evento no banco de dados:', err);
                  } else {
                    console.log('Evento salvo no banco de dados:', newDoc);
                  }
                });

                // Emitir para o frontend o evento plate-found com dados do cliente
                io.emit('plate-found', event);
                break;
              }
            }
          }
          if (plateFound) break;
        }
        if (!plateFound) {
          console.log(`Nenhuma correspondência encontrada para a placa: ${plateData}`);
          // io.emit('plate-not-found', { ip, plate: plateData });
        }
      } finally {
        releaseLock();
      }
    });
  });
}

function handleSpeedReading(channelId, radarId, speed, timestamp) {
  const speedTimestampMs = toMs(timestamp);
  const windowMs = channelTimeWindowMs.get(channelId) ?? 8000;

  const maxSpeed = channelMaxSpeed.get(channelId);        // number ou NaN
  const tolerance = channelTolerance.get(channelId);      // number ou NaN
  const decisionSpeed = channelDecisionSpeed.get(channelId); // number ou NaN

  const speedNum = Number(speed);
  if (!Number.isFinite(speedNum)) return;

  const hasMax = Number.isFinite(maxSpeed);
  const tolEff = Number.isFinite(tolerance) ? tolerance : 0;
  const decisionEff = hasMax ? (maxSpeed + tolEff) : NaN;

  // 3 estados: ok (verde), warn (amarelo), violate (vermelho)
  // Se não tiver maxSpeed configurado, status "unknown" e não inicia sessão
  let status = "unknown";
  if (hasMax) {
    if (speedNum <= maxSpeed) status = "ok";
    else if (speedNum <= decisionEff) status = "warn";
    else status = "violate";
  }

  const violates = (status === "violate");
  const hasDecision = hasMax; // decisão depende de maxSpeed (tolerância pode ser 0)

  const payload = {
    channelId,
    radarId,
    speed: speedNum,
    speedTimestamp: new Date(speedTimestampMs).toISOString(),
    windowMs,

    // parâmetros para o overlay / UI
    speedLimit: hasMax ? maxSpeed : null,
    tolerance: Number.isFinite(tolerance) ? tolerance : null,
    decisionSpeed: hasMax ? decisionEff : null,

    status,       // "ok" | "warn" | "violate" | "unknown"
    violates,
    hasActiveSession: speedSessions.has(channelId),
  };

  // 1) SEMPRE avisa o Python (room do canal) para mostrar a velocidade e pintar a borda
  io.to(channelId).emit("speed-reading", payload);

  // Se não tem maxSpeed, não inicia sessão/IA
  if (!hasDecision) {
    console.log(`[SPEED] Canal ${channelId} sem maxSpeed válido. Não inicia sessão. speed=${speedNum}`);
    return;
  }

  // Se não violou, não inicia sessão/IA
  if (!violates) {
    console.log(`[SPEED] ${speedNum} <= ${decisionEff} (${status}) -> não inicia sessão IA (canal=${channelId})`);
    return;
  }

  // Se já tem sessão ativa, não inicia outra
  if (speedSessions.has(channelId)) {
    console.log(`[SPEED] Sessão já ativa no canal ${channelId}. Não inicia nova sessão.`);
    return;
  }

  // 2) Violou e não há sessão -> inicia sessão
  const sessionId = makeSessionId();
  const deadlineMs = Date.now() + windowMs;

  console.log(
    `[SPEED] Sessão iniciada canal=${channelId} radar=${radarId} speed=${speedNum} window=${windowMs}ms sessionId=${sessionId}`
  );

  const timer = setTimeout(() => {
    const s = speedSessions.get(channelId);
    if (!s || s.sessionId !== sessionId) return;

    console.log(`[SPEED] Timeout da sessão canal=${channelId} sessionId=${sessionId} → solicitando finalize no Python`);

    io.to(channelId).emit("speed-session-timeout", { channelId, radarId, sessionId });

    s.cleanupTimer = setTimeout(() => {
      const s2 = speedSessions.get(channelId);
      if (s2 && s2.sessionId === sessionId) {
        console.warn(`[SPEED] Limpando sessão pendurada canal=${channelId} sessionId=${sessionId}`);
        speedSessions.delete(channelId);
      }
    }, 5000);
  }, windowMs);

  speedSessions.set(channelId, {
    sessionId,
    radarId,
    speed: speedNum,
    speedTimestampMs,
    deadlineMs,
    timer,
    cleanupTimer: null,
  });

  // inclui speedLimit/tolerance/status no start também (ajuda o Python a fixar)
  io.to(channelId).emit("speed-session-start", {
    channelId,
    radarId,
    sessionId,
    speed: speedNum,
    speedTimestamp: new Date(speedTimestampMs).toISOString(),
    windowMs,
    deadlineMs,
    speedLimit: maxSpeed,
    tolerance: Number.isFinite(tolerance) ? tolerance : 0,
    decisionSpeed: decisionEff,
    status: "violate",
  });
}

// salva evento só de velocidade (sem placa)
function saveSpeedOnlyEvent(channelId, radarId, speed, speedTimestamp, fileName) {
  const speedTsMs = toMs(speedTimestamp);
  const event = {
    eventType: 'speed_plate',
    channelId,
    radarId,
    speed,
    speedTimestamp: speedTsMs, // <-- padronizado
    timestamp: speedTsMs,      // ou use outro timestamp se preferir
    plate: null,
    customerInfo: null,
    notRegistered: true,
    hasPlate: false,
    ...(fileName ? { fileName } : {}),
  };

  eventsDb.insert(event, (err) => {
    if (err) console.error('Erro ao salvar evento speed_only:', err);
  });

  postSpeedEvent(event);
  io.emit('speed-event', event);
}

// salva evento só de PLACA (sem velocidade)
// function savePlateOnlyEvent(channelId, radarId, plateData, timestamp, fileName) {
//   const eventTimestamp = timestamp ? new Date(timestamp) : new Date();

//   platesDb.find({}, (err, docs) => {
//     if (err) {
//       console.error('Erro ao consultar platesDb:', err);
//       return;
//     }

//     let plateFound = false;
//     let matchedDevice = null;
//     let matchedDoc = null;

//     // Procurar placa no banco
//     for (const doc of docs) {
//       for (const device of doc.devices) {
//         const dbPlate = device.plate;
//         if (platesMatch(plateData, dbPlate)) {
//           plateFound = true;
//           matchedDevice = device;
//           matchedDoc = doc;
//           break;
//         }
//       }
//       if (plateFound) break;
//     }

//     const baseEvent = {
//       eventType: 'speed_plate',
//       channelId,
//       radarId,
//       speed: null,            // sem velocidade
//       speedTimestamp: null,   // sem velocidade
//       timestamp: eventTimestamp,
//       hasPlate: true,
//       plate: plateData,
//       fileName: fileName
//     };

//     let event;

//     if (plateFound && matchedDevice && matchedDoc) {
//       event = {
//         ...baseEvent,
//         // plate: matchedDevice.plate,
//         customerInfo: {
//           name: matchedDoc.userName,
//           unit: matchedDoc.unid,
//           group: matchedDoc.grupo,
//           make: matchedDevice.make,
//           model: matchedDevice.model,
//           color: matchedDevice.color,
//         },
//         notRegistered: false,
//       };
//     } else {
//       event = {
//         ...baseEvent,
//         // plate: plateData,
//         customerInfo: null,
//         notRegistered: true,
//       };
//     }

//     eventsDb.insert(event, (err, newDoc) => {
//       if (err) {
//         console.error('Erro ao salvar evento plate_only:', err);
//       } else {
//         // console.log('Evento plate_only salvo (sem velocidade):', newDoc);
//       }
//     });

//     // >>> ENVIAR EVENTO HTTP PARA A API CENTRAL <<<
//     // Usa os parâmetros cadastrados no canal (camera) que já pegamos no início da função
//     postSpeedEvent(baseEvent);

//     io.emit('speed-event', event);
//   });
// }


function tryResolveLiveCapture(channelId, payload) {
  const pending = liveCaptureWaits.get(channelId);
  if (!pending) return;

  liveCaptureWaits.delete(channelId);
  clearTimeout(pending.timer);

  const { res } = pending;
  const {
    plate,
    eventType = 'plate',
    radarId = null,
    fileName = null,
    timestamp = new Date().toISOString(),
    source = 'live-window',
  } = payload || {};

  if (!plate) {
    return res.status(404).json({
      ok: false,
      error: 'Evento de placa sem valor de placa recebido',
    });
  }

  return res.json({
    ok: true,
    plate,
    eventType,
    radarId,
    fileName,
    timestamp,
    source,
  });
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDoorDriver(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'dozz_vehicle' || normalized === 'dozzvehicle' || normalized === 'vehicle') {
    return 'dozz_vehicle';
  }
  return 'mg3000';
}

function postJsonless(urlString, headers = {}, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (error) {
      reject(error);
      return;
    }

    const client = parsed.protocol === 'https:' ? httpsModule : httpModule;
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        Connection: 'close',
        ...headers
      }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (raw.length < 2048) raw += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: Number(res.statusCode || 0),
          body: raw
        });
      });
    });

    req.on('timeout', () => req.destroy(new Error('Timeout na conexão HTTP com controladora')));
    req.on('error', reject);
    req.end();
  });
}

async function openDoorViaDozzVehicle(canal, channelId) {
  const vehicleHost = String(canal.vehicleAdd || canal.equipAdd || '').trim();
  const vehiclePort = toPositiveInt(canal.vehiclePort || canal.equipPort, 80);
  const vehicleChannel = toPositiveInt(canal.vehicleChannel || canal.port, 0);
  const holdMs = toPositiveInt(canal.vehicleHoldMs, 1000);
  const source = encodeURIComponent('dozz_plate');

  if (!vehicleHost || vehicleChannel < 1 || vehicleChannel > 4) {
    throw new Error(`Parâmetros inválidos para Dozz Vehicle no canal ${channelId}`);
  }

  const authUser = String(canal.vehicleUser || '').trim();
  const authPass = String(canal.vehiclePass || '').trim();
  const headers = {};
  if (authUser || authPass) {
    headers.Authorization = `Basic ${Buffer.from(`${authUser}:${authPass}`).toString('base64')}`;
  }

  const targetUrl = `http://${vehicleHost}:${vehiclePort}/api/channels/${vehicleChannel}/open?source=${source}&holdMs=${holdMs}`;
  const response = await postJsonless(targetUrl, headers, 3500);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Dozz Vehicle retornou HTTP ${response.statusCode || 0}`);
  }
}

async function startConfiguredGateCooldown(channelId, reason = 'command_open') {
  const settings = await getInterlockSettings();
  return startPhysicalDoorCooldownForChannel(channelId, settings.gateCommandCooldownMs, reason);
}

// Função para abrir porta (adaptar conforme necessidade)
async function openDoor(channelId) {
  return enqueueGateDecision(async () => {
    try {
      console.log('Opening Door');

      const cooldown = getActiveChannelGateCooldown(channelId);
      if (cooldown) {
        const remainingMs = Math.ceil(cooldown.remainingMs);
        const error = new Error(`Canal em cooldown de abertura por mais ${Math.ceil(remainingMs / 1000)}s.`);
        error.code = 'gate_cooldown';
        error.cooldown = {
          channelId: normalizeChannelId(channelId),
          remainingMs,
          expiresAt: cooldown.expiresAtIso || null,
          reason: cooldown.reason || null,
        };
        console.warn('[gate-cooldown] abertura bloqueada:', error.cooldown);
        throw error;
      }

      const interlock = await evaluateChannelInterlock(channelId);
      if (!interlock.allowed) {
        const error = new Error(`Intertravamento ativo: porta ${interlock.blockingDoorKey || interlock.blockingChannelId} está ${interlock.blockingGateStatus}.`);
        error.code = 'interlock_blocked';
        error.interlock = interlock;
        console.warn('[interlock] abertura bloqueada:', interlock);
        throw error;
      }

      const canal = await findOneAsync(settingsDb, { _id: channelId });
      if (!canal) {
        throw new Error(`Canal com ID ${channelId} não encontrado no settingsDb.`);
      }

      setChannelGateStatus(channelId, 'opening', {
        doorStatus: false,
        controllerOnline: true,
        controllerAddress: canal.equipAdd || canal.vehicleAdd || null,
        apiKey: canal.mg3000ApiKey || canal.apiKey || null,
        receptorAdd: canal.receptorAdd,
        door: canal.port,
        lastEventKey: 'command_open',
      });

      const doorDriver = normalizeDoorDriver(canal.doorDriver);
      if (doorDriver === 'dozz_vehicle') {
        await openDoorViaDozzVehicle(canal, channelId);
        await startConfiguredGateCooldown(channelId, 'command_open:dozz_vehicle');
        console.log(`Comando HTTP enviado para Dozz Vehicle no canal ${channelId}.`);
        return;
      }

      const mg3000Address = canal.equipAdd;
      const receptorAddress = parseInt(canal.receptorAdd, 10);
      const doorAddress = parseInt(canal.port, 10);

      const receptorIsValid = Number.isInteger(receptorAddress) && receptorAddress >= 0 && receptorAddress <= 255;
      const doorIsValid = Number.isInteger(doorAddress) && doorAddress >= 0 && doorAddress <= 255;
      if (!mg3000Address || !receptorIsValid || !doorIsValid) {
        throw new Error(`Parâmetros inválidos para o canal ${channelId}.`);
      }

      const queueKey = `${mg3000Address}:${MG300_TCP_PORT}`;

      console.log(`[mg3000-command] open channel=${channelId} nome="${canal.name || ''}" ctrl=${mg3000Address}:${MG300_TCP_PORT} rec=${receptorAddress} door=${doorAddress}`);
      await enqueueMg300Command(queueKey, async () => {
        await waitForMg300Gap(queueKey);
        try {
          return await openRfDoor(mg3000Address, MG300_TCP_PORT, receptorAddress, doorAddress);
        } finally {
          mg300LastCommandAt.set(queueKey, Date.now());
        }
      });

      await startConfiguredGateCooldown(channelId, 'command_open:mg3000');
      console.log(`Comando enviado para abrir a porta no canal ${channelId}.`);
    } catch (error) {
      console.error(`Erro ao enviar comando de abertura no canal ${channelId}:`, error);
      throw error;
    }
  });
}

// Função platesMatch (igual dozzPlate)
function platesMatch(detectedPlate, dbPlate) {
  if (detectedPlate.length !== dbPlate.length) return false;

  let diffCount = 0;

  for (let i = 0; i < detectedPlate.length; i++) {
    if (detectedPlate[i] !== dbPlate[i]) {
      diffCount++;
      if (diffCount > 1) return false;
    }
  }
  return diffCount <= 1;
}

// Função para eventos do IA (linhas/áreas)
function handleEventFromPython(channelId, eventData) {
  console.log(`Evento recebido do Python para o canal ${channelId}:`, eventData);
  io.to(channelId).emit('actionEvent', { channelId, eventData });
}

function calculateChecksum(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  return sum & 0xff;
}

function isTransientMg300Error(error) {
  const transientCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ECONNABORTED',
    'ECONNREFUSED',
    'MG300_TIMEOUT',
    'MG300_CLOSE_ERROR',
    'MG300_NO_RESPONSE',
  ]);
  return transientCodes.has(error?.code);
}

function openRfDoorOnce(ip, port, rec, door) {
  return new Promise((resolve, reject) => {
    try {
      const command = Buffer.from([0x00, 0x5C, 0x01, rec, door, 0x01, 0x01]);
      const checksum = calculateChecksum(command);
      const commandWithChecksum = Buffer.concat([command, Buffer.from([checksum])]);
      const socket = new net.Socket();
      let settled = false;
      let response = Buffer.alloc(0);

      console.log(`[mg3000-command] tx open ${ip}:${port} rec=${rec} door=${door} hex=${commandWithChecksum.toString('hex')}`);

      const settle = (fn, value, gracefulClose = false) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        if (!socket.destroyed) {
          if (gracefulClose) {
            socket.end();
          } else {
            socket.destroy();
          }
        }
        fn(value);
      };

      socket.setTimeout(MG300_SOCKET_TIMEOUT_MS);
      socket.setNoDelay(true);

      socket.once('connect', () => {
        socket.write(commandWithChecksum, (writeError) => {
          if (writeError) {
            settle(reject, writeError);
          }
        });
      });

      socket.on('data', (data) => {
        response = Buffer.concat([response, data]);
        console.log(`[mg3000-command] rx open ${ip}:${port} len=${response.length} hex=${response.toString('hex')}`);
        settle(resolve, response, true);
      });

      socket.once('timeout', () => {
        const timeoutError = new Error(
          `Timeout aguardando resposta do MG300 (${MG300_SOCKET_TIMEOUT_MS} ms).`
        );
        timeoutError.code = 'MG300_TIMEOUT';
        settle(reject, timeoutError);
      });

      socket.once('error', (err) => {
        console.error('Erro no socket:', err);
        settle(reject, err);
      });

      socket.once('close', (hadError) => {
        if (settled) return;
        if (response.length > 0) {
          settle(resolve, response);
          return;
        }

        const closeError = new Error(
          hadError
            ? 'Conexão com MG300 fechada com erro antes de resposta.'
            : 'Conexão com MG300 fechada sem resposta.'
        );
        closeError.code = hadError ? 'MG300_CLOSE_ERROR' : 'MG300_NO_RESPONSE';
        settle(reject, closeError);
      });

      socket.connect({ host: ip, port });
    } catch (error) {
      reject(error);
    }
  });
}

async function openRfDoor(ip, port, rec, door) {
  let attempt = 0;
  let lastError;

  while (attempt < MG300_MAX_RETRIES) {
    attempt += 1;
    try {
      const response = await openRfDoorOnce(ip, port, rec, door);
      if (attempt > 1) {
        console.warn(
          `[MG300] Comando openRfDoor recuperado na tentativa ${attempt}/${MG300_MAX_RETRIES} para ${ip}:${port}.`
        );
      }
      return response;
    } catch (error) {
      lastError = error;
      const retryable = isTransientMg300Error(error);
      if (!retryable || attempt >= MG300_MAX_RETRIES) {
        throw error;
      }

      const delayMs = Math.min(3000, MG300_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
      console.warn(
        `[MG300] Falha tentativa ${attempt}/${MG300_MAX_RETRIES} (${error?.code || error?.message}). Nova tentativa em ${delayMs}ms.`
      );
      await sleep(delayMs);
    }
  }

  throw lastError || new Error('Falha ao abrir porta no MG300.');
}

// Endpoint para parar o processo de detecção para um canal
app.post('/stop-process/:channelId', (req, res) => {
  const channelId = req.params.channelId;

  channelTimeWindowMs.delete(channelId);
  channelMaxSpeed.delete(channelId);
  channelTolerance.delete(channelId);
  channelDecisionSpeed.delete(channelId);
  clearSpeedSession(channelId);


  settingsDb.findOne({ _id: channelId }, (err, channel) => {
    const radarId = channel?.radarId;

    // limpar vínculo radar->canal
    if (radarId) radarIdToChannel.delete(radarId);

    // SEMPRE desinscrever do MQTT se houver radarId
    if (radarId) {
      const { readSpeed, dozzspeed, settings } = topicsForRadar(radarId);
      mqttClient.unsubscribe([readSpeed, dozzspeed, settings]);
      subscribedRadars.delete(radarId);
    }

    const pythonProcessObj = processes[channelId];
    if (pythonProcessObj?.managedBy === 'plate_batch') {
      unregisterPlateChannelOnSharedWorker(channelId);
      io.emit('process-stopped', { channelId });
      delete processes[channelId];
      return res.send({ success: true, sharedWorker: true });
    }

    if (pythonProcessObj?.process) {
      try {
        pythonProcessObj.process.kill('SIGTERM');
      } catch (error) {
        console.warn(`Falha ao enviar SIGTERM para ${channelId}:`, error?.message || error);
      }

      setTimeout(() => {
        const proc = pythonProcessObj.process;
        if (proc && !proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch (_) {
            // no-op
          }
        }
      }, 1800);

      io.emit('process-stopped', { channelId });
      delete processes[channelId];
      return res.send({ success: true });
    }

    return res.send({ success: false, message: 'Nenhum processo em execução para este canal' });
  });
});

// Endpoint para capturar uma foto do canal
app.get('/capture-photo/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  settingsDb.findOne({ _id: channelId }, (err, channel) => {
    if (err || !channel) {
      res.status(500).send({ success: false, message: 'Canal não encontrado' });
    } else {
      const args = [
        'capture_photo.py',
        '--ip', channel.cameraIp,
        '--user', channel.username,
        '--password', channel.password,
        '--channel_id', channelId,
        '--dvr_channel', channel.dvrChannel.toString()
      ];
      const pythonProcess = spawn(PYTHON_BIN, args);

      pythonProcess.on('close', (code) => {
        if (code === 0) {
          res.send({ success: true, imageUrl: `/captured_frame_${channelId}.jpg` });
        } else {
          res.status(500).send({ success: false, message: 'Erro ao capturar a foto' });
        }
      });
    }
  });
});

// Endpoint para obter ações por canal
app.get('/api/actions/channel/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  actionsDb.find({ channelId }, (err, docs) => {
    if (err) {
      res.status(500).send('Erro ao obter ações');
    } else {
      res.send(docs);
    }
  });
});

// Endpoint para criar uma nova ação
app.post('/api/actions', (req, res) => {
  const action = req.body;
  actionsDb.insert(action, (err, newDoc) => {
    if (err) {
      res.status(500).send('Erro ao criar ação');
    } else {
      res.send(newDoc);
    }
  });
});

// Endpoint para atualizar uma ação existente
app.put('/api/actions/:actionId', (req, res) => {
  const actionId = req.params.actionId;
  const updatedAction = req.body;
  actionsDb.update({ _id: actionId }, updatedAction, {}, (err, numReplaced) => {
    if (err) {
      res.status(500).send('Erro ao atualizar ação');
    } else {
      res.send({ success: true });
    }
  });
});

// Endpoint para excluir uma ação
app.delete('/api/actions/:actionId', (req, res) => {
  const actionId = req.params.actionId;
  actionsDb.remove({ _id: actionId }, {}, (err, numRemoved) => {
    if (err) {
      res.status(500).send('Erro ao excluir ação');
    } else {
      // Remover áreas associadas à ação
      areasDb.remove({ actionId }, { multi: true }, (err) => {
        if (err) {
          console.error('Erro ao remover áreas associadas à ação:', err);
        }
      });
      // Remover direções associadas às áreas da ação
      directionsDb.remove({ actionId }, { multi: true }, (err) => {
        if (err) {
          console.error('Erro ao remover direções associadas à ação:', err);
        }
      });
      res.send({ success: true });
    }
  });
});

// Endpoint para obter áreas por canal
app.get('/api/areas/channel/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  areasDb.find({ channelId }, (err, areas) => {
    if (err) {
      res.status(500).send('Erro ao obter áreas');
    } else {
      res.send(areas);
    }
  });
});

// Endpoint para criar áreas
app.post('/api/areas', (req, res) => {
  const area = req.body;
  areasDb.insert(area, (err, newDoc) => {
    if (err) {
      res.status(500).send('Erro ao criar área');
    } else {
      res.send(newDoc);
    }
  });
});

// Endpoint para atualizar uma área
app.put('/api/areas/:areaId', (req, res) => {
  const areaId = req.params.areaId;
  const updatedArea = req.body;
  areasDb.update({ _id: areaId }, updatedArea, {}, (err, numReplaced) => {
    if (err) {
      res.status(500).send('Erro ao atualizar área');
    } else {
      res.send({ success: true });
    }
  });
});

// Endpoint para excluir uma área
app.delete('/api/areas/:areaId', (req, res) => {
  const areaId = req.params.areaId;
  areasDb.remove({ _id: areaId }, {}, (err, numRemoved) => {
    if (err) {
      res.status(500).send('Erro ao excluir área');
    } else {
      // Remover direções associadas à área
      directionsDb.remove({ areaId }, { multi: true }, (err) => {
        if (err) {
          console.error('Erro ao remover direções associadas à área:', err);
        }
      });
      res.send({ success: true });
    }
  });
});

// Endpoint para obter direções por canal
app.get('/api/directions/channel/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  directionsDb.find({ channelId }, (err, directions) => {
    if (err) {
      res.status(500).send('Erro ao obter direções');
    } else {
      res.send(directions);
    }
  });
});

// Endpoint para criar uma direção
app.post('/api/directions', (req, res) => {
  const direction = req.body;
  directionsDb.insert(direction, (err, newDoc) => {
    if (err) {
      res.status(500).send('Erro ao criar direção');
    } else {
      res.send(newDoc);
    }
  });
});

// Endpoint para atualizar uma direção
app.put('/api/directions/:directionId', (req, res) => {
  const directionId = req.params.directionId;
  const updatedDirection = req.body;
  directionsDb.update({ _id: directionId }, updatedDirection, {}, (err, numReplaced) => {
    if (err) {
      res.status(500).send('Erro ao atualizar direção');
    } else {
      res.send({ success: true });
    }
  });
});

// Endpoint para excluir uma direção
app.delete('/api/directions/:directionId', (req, res) => {
  const directionId = req.params.directionId;
  directionsDb.remove({ _id: directionId }, {}, (err, numRemoved) => {
    if (err) {
      res.status(500).send('Erro ao excluir direção');
    } else {
      res.send({ success: true });
    }
  });
});

// Endpoint para obter áreas por actionId
app.get('/api/areas/action/:actionId', (req, res) => {
  const actionId = req.params.actionId;
  areasDb.find({ actionId }, (err, areas) => {
    if (err) {
      res.status(500).send('Erro ao obter áreas');
    } else {
      res.send(areas);
    }
  });
});

// Endpoint para obter direções por actionId
app.get('/api/directions/action/:actionId', (req, res) => {
  const actionId = req.params.actionId;
  directionsDb.find({ actionId }, (err, directions) => {
    if (err) {
      res.status(500).send('Erro ao obter direções');
    } else {
      res.send(directions);
    }
  });
});

// Endpoint para criar múltiplas áreas
app.post('/api/areas/bulk', (req, res) => {
  const areas = req.body;
  
  areas.forEach(area => {
    delete area._id;
  });

  areasDb.insert(areas, (err, newDocs) => {
    if (err) {
      console.log(err)
      res.status(500).send('Erro ao criar áreas');
    } else {
      res.send(newDocs);
    }
  });
});

// Endpoint para criar múltiplas direções
app.post('/api/directions/bulk', (req, res) => {
  const directions = req.body;
  directionsDb.insert(directions, (err, newDocs) => {
    if (err) {
      res.status(500).send('Erro ao criar direções');
    } else {
      res.send(newDocs);
    }
  });
});

// Endpoint de compatibilidade para receber configurações da CPU Plate via API Redis.
// Atualiza (upsert) canais gerenciados por `chan1..chan4` sem remover campos já existentes.
app.post('/settings', async (req, res) => {
  try {
    const data = req.body;
    if (!Array.isArray(data)) {
      return res.status(400).json({ ok: false, error: 'Formato inválido. Esperado array de canais.' });
    }

    const readOptionValue = (value) => {
      if (value == null) return '';
      if (typeof value === 'object') {
        return String(value.value || value._id || value.id || '').trim();
      }
      return String(value).trim();
    };

    const normalizeChannelId = (value) => {
      const channelId = String(value || '').trim().toLowerCase();
      return /^chan[1-4]$/.test(channelId) ? channelId : '';
    };

    const normalized = data
      .map((item) => {
        const channelId = normalizeChannelId(item?.channelOccupied);
        if (!channelId) return null;

        const channelNumber = toPositiveInt(channelId.replace('chan', ''), 1);
        const areaId = readOptionValue(item?.plateCpuChan);
        const base = {
          _id: channelId,
          name: String(item?.name || '').trim(),
          cameraIp: String(item?.cameraIp || item?.equipAdd || '').trim(),
          username: String(item?.username || item?.equipUser || '').trim(),
          password: String(item?.password || item?.equipPass || '').trim(),
          dvrChannel: toPositiveInt(item?.dvrChannel, channelNumber),
          fps: toPositiveInt(item?.fps, 5),
          channel_type: String(item?.channel_type || 'plate').trim() || 'plate',
          areaId,
          plateCpuId: readOptionValue(item?.plateCpu),
          source: 'dozzapiRedis',
          syncManaged: true,
          syncedAt: Date.now(),
        };

        const optionalFields = [
          'doorDriver',
          'receptorAdd',
          'port',
          'vehicleAdd',
          'vehiclePort',
          'vehicleChannel',
          'vehicleUser',
          'vehiclePass',
          'vehicleHoldMs',
          'apiKey',
          'serverAdd',
          'serverPort',
          'areaLabel',
        ];

        optionalFields.forEach((field) => {
          if (item?.[field] == null) return;
          const value = typeof item[field] === 'string' ? item[field].trim() : item[field];
          if (value === '') return;
          base[field] = value;
        });

        return base;
      })
      .filter(Boolean);

    if (normalized.length === 0) {
      return res.status(400).json({ ok: false, error: 'Nenhum canal válido encontrado no payload.' });
    }

    const channels = await enqueuePlateSyncWrite('settings', async () => {
      const nextChannels = [];
      for (const incomingChannel of normalized) {
        const existingChannel = await findOneAsync(settingsDb, { _id: incomingChannel._id }).catch(() => null);
        const mergedChannel = {
          ...(existingChannel || {}),
          ...incomingChannel,
          _id: incomingChannel._id,
        };
        if (!String(mergedChannel.name || '').trim()) {
          const channelNumber = toPositiveInt(String(incomingChannel._id || '').replace('chan', ''), 1);
          mergedChannel.name = `Canal ${channelNumber}`;
        }

        await updateAsync(
          settingsDb,
          { _id: mergedChannel._id },
          mergedChannel,
          { upsert: true }
        );

        nextChannels.push({
          channelId: mergedChannel._id,
          cameraIp: mergedChannel.cameraIp || '',
          areaId: mergedChannel.areaId || null,
          channel_type: mergedChannel.channel_type || 'plate',
        });
      }

      return nextChannels;
    });

    return res.status(200).json({
      ok: true,
      configuredChannels: channels.length,
      channels,
    });
  } catch (error) {
    console.error('[settings-sync] Falha ao aplicar configurações da CPU Plate:', error);
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Falha ao aplicar configurações da CPU Plate.',
    });
  }
});

// Endpoint to receive POST requests for /sync-plates
app.post('/sync', async (req, res) => {
  try {
    const data = req.body;
    debugLog(`/sync recebido | ip=${req.ip} | payloadType=${Array.isArray(data) ? 'array' : typeof data} | size=${Array.isArray(data) ? data.length : 0}`);

    if (!Array.isArray(data)) {
      return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
    }

    const toSafeString = (value) => String(value ?? '').trim();
    const normalizePlate = (value) => toSafeString(value).toUpperCase();
    const normalizeUserKey = (value) => toSafeString(value).toLowerCase();

    const normalizedPayload = [];
    data.forEach((item) => {
      const rawDevices = Array.isArray(item?.devices) ? item.devices : [];
      const devices = rawDevices
        .map((device) => {
          const plate = normalizePlate(typeof device === 'string' ? device : device?.plate);
          if (!plate) return null;

          if (device && typeof device === 'object') {
            return { ...device, plate };
          }
          return { plate };
        })
        .filter(Boolean);

      if (devices.length === 0) return;

      normalizedPayload.push({
        userName: toSafeString(item?.userName),
        grupo: toSafeString(item?.grupo),
        unid: toSafeString(item?.unid),
        devices,
      });
    });
    debugLog(`/sync normalizado (payload inicial) | users=${normalizedPayload.length}`);

    const mergedByUser = new Map();
    normalizedPayload.forEach((item) => {
      const key = [
        normalizeUserKey(item.userName),
        normalizeUserKey(item.grupo),
        normalizeUserKey(item.unid),
      ].join('::');

      if (!mergedByUser.has(key)) {
        mergedByUser.set(key, { ...item, devices: [] });
      }

      const current = mergedByUser.get(key);
      const existingPlates = new Set(current.devices.map((device) => normalizePlate(device?.plate)));
      item.devices.forEach((device) => {
        const plate = normalizePlate(device?.plate);
        if (!plate || existingPlates.has(plate)) return;
        current.devices.push({ ...device, plate });
        existingPlates.add(plate);
      });
    });

    const normalizedData = Array.from(mergedByUser.values()).filter(
      (item) => Array.isArray(item.devices) && item.devices.length > 0
    );
    debugLog(`/sync deduplicado | users=${normalizedData.length}`);
    if (PLATE_DEBUG_ENABLED && normalizedData.length > 0) {
      const sample = normalizedData.slice(0, 3).map((u) => ({
        userName: u.userName,
        grupo: u.grupo,
        unid: u.unid,
        devices: Array.isArray(u.devices) ? u.devices.length : 0,
      }));
      debugLog('/sync sample:', sample);
    }

    if (normalizedData.length === 0) {
      const existingRecords = await countAsync(platesDb, {});
      return res.status(202).json({
        message: 'Sync payload vazio; base local mantida sem alterações.',
        existingRecords,
      });
    }

    const syncResult = await enqueuePlateSyncWrite('plates', async () => {
      const previousDocs = await findAsync(platesDb, {});
      const numRemoved = await removeAsync(platesDb, {}, { multi: true });
      debugLog(`/sync remove concluído | removed=${numRemoved} | previousSnapshot=${Array.isArray(previousDocs) ? previousDocs.length : 0}`);

      try {
        const inserted = await insertAsync(platesDb, normalizedData);
        const newDocs = Array.isArray(inserted) ? inserted : (inserted ? [inserted] : []);
        return { numRemoved, newDocs };
      } catch (insertErr) {
        console.error('[sync] Error saving data to platesDb:', insertErr);

        if (!Array.isArray(previousDocs) || previousDocs.length === 0) {
          throw insertErr;
        }

        try {
          await removeAsync(platesDb, {}, { multi: true });
          await insertAsync(platesDb, previousDocs);
        } catch (rollbackErr) {
          console.error('[sync] Rollback failed after insert error:', rollbackErr);
        }
        throw insertErr;
      }
    });

    console.log(`[sync] platesDb refreshed. Removed=${syncResult.numRemoved} Saved=${syncResult.newDocs.length}`);
    if (PLATE_DEBUG_ENABLED) {
      const sampleSaved = (syncResult.newDocs || []).slice(0, 3).map((u) => ({
        userName: u.userName,
        grupo: u.grupo,
        unid: u.unid,
        devices: Array.isArray(u.devices) ? u.devices.length : 0,
      }));
      debugLog('/sync persisted sample:', sampleSaved);
    }
    return res.status(200).json({
      message: 'Data saved successfully to plates database.',
      savedRecords: syncResult.newDocs.length,
    });
  } catch (error) {
    console.error('[sync] Error during /sync processing:', error);
    return res.status(500).json({ error: 'Failed to save data to plates database.' });
  }
});

// Endpoint de eventos filtrados
app.get('/filtered-events', (req, res) => {
  const { channelId, plate, speed, dateStart, dateEnd } = req.query;

  const and = [];

  if (channelId) and.push({ channelId });

  // Placa: procurar em event.plate OU customerInfo.plate
  if (plate) {
    const re = new RegExp(plate, 'i');
    and.push({
      $or: [
        { plate: re },
        { 'customerInfo.plate': re },
      ],
    });
  }

  // Velocidade
  if (speed !== undefined && speed !== '') {
    const sp = parseInt(speed, 10);
    if (!isNaN(sp)) and.push({ speed: sp });
  }

  // Data/Hora (timestamp em ms)
  if (dateStart || dateEnd) {
    const ts = {};
    if (dateStart) ts.$gte = new Date(dateStart).getTime();
    if (dateEnd)   ts.$lte = new Date(dateEnd).getTime();
    and.push({ timestamp: ts });
  }

  const query = and.length ? { $and: and } : {};

  eventsDb
    .find(query)
    .sort({ timestamp: -1 })
    .limit(500)
    .exec((err, docs) => {
      if (err) return res.status(500).json({ error: 'Erro ao buscar eventos' });
      res.json(docs);
    });
});

// Endpoint to retrieve all plates
app.get('/plates', (req, res) => {
  platesDb.find({}, (err, docs) => {
    if (err) {
      console.error('Error retrieving data from platesDb:', err);
      return res.status(500).json({ error: 'Failed to retrieve data from plates database.' });
    }
    debugLog(`/plates consultado | ip=${req.ip} | users=${Array.isArray(docs) ? docs.length : 0}`);
    if (PLATE_DEBUG_ENABLED && Array.isArray(docs) && docs.length > 0) {
      const first = docs[0];
      debugLog('/plates sample user:', {
        userName: first?.userName,
        grupo: first?.grupo,
        unid: first?.unid,
        devices: Array.isArray(first?.devices) ? first.devices.length : 0,
      });
    }

    res.status(200).json(docs);
  });
});

// Rota para obter todos os eventos de um canal específico
app.get('/api/events/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  
  // Buscar no eventsDb onde channelId = channelId
  eventsDb.find({ channelId }).sort({ timestamp: -1 }).limit(10).exec((err, docs) => {
    if (err) {
      console.error('Erro ao buscar eventos:', err);
      return res.status(500).send('Erro ao buscar eventos.');
    }

    // Retornar todos ou você pode limitar, ex: .limit(30)
    res.json(docs);
  });
});

app.get('/process-status/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  const procInfo = processes[channelId];
  if (!procInfo) {
    return res.json({ status: 'stopped', errorType: null });
    // ou status 404, se preferir
  }
  // Retornar status e errorType
  res.json({ 
    status: procInfo.status || 'stopped',
    errorType: procInfo.errorType || null
  });
});

app.get('/video', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'video.html'));
});

// -------------------- API: ENVIAR VELOCIDADE MANUAL (DozzSpeed) --------------------
app.post('/api/speed', (req, res) => {
  const sp = Number(req.body?.speed);
  const radarId = req.body?.radarId;

  if (!Number.isInteger(sp) || sp < 0 || sp > 99) {
    return res.status(400).json({ ok: false, error: 'speed precisa ser inteiro de 0 a 99' });
  }

  let finalRadarId = radarId;

  if (!finalRadarId) {
    // Se não vier radarId, tenta deduzir: se só existe 1 radar conhecido, usa ele
    if (subscribedRadars.size === 1) {
      finalRadarId = [...subscribedRadars][0];
    } else {
      return res.status(400).json({ ok: false, error: 'radarId obrigatório quando há múltiplos radares' });
    }
  }

  const { dozzspeed } = topicsForRadar(finalRadarId);

  mqttClient.publish(dozzspeed, String(sp), {}, (err) => {
    if (err) return res.status(500).json({ ok: false, error: 'falha ao publicar' });
    return res.json({ ok: true, topic: dozzspeed, radarId: finalRadarId, speed: sp });
  });
});

// -------------------- API: ENVIAR COMANDOS "settings" --------------------
// Suporta C1, C2, C3, r, etc.
app.post('/api/settings', (req, res) => {
  const cmd = req.body?.cmd?.trim();
  const radarId = req.body?.radarId;

  if (!cmd) return res.status(400).json({ ok: false, error: 'cmd vazio' });

  let finalRadarId = radarId;

  if (!finalRadarId) {
    if (subscribedRadars.size === 1) {
      finalRadarId = [...subscribedRadars][0];
    } else {
      return res.status(400).json({ ok: false, error: 'radarId obrigatório quando há múltiplos radares' });
    }
  }

  const { settings } = topicsForRadar(finalRadarId);

  mqttClient.publish(settings, cmd, {}, (err) => {
    if (err) return res.status(500).json({ ok: false, error: 'falha ao publicar' });
    return res.json({ ok: true, sent: cmd, topic: settings, radarId: finalRadarId });
  });
});

// Endpoint para obter as áreas do condomínio (somente proxy, sem salvar)
app.get('/api/vision/areas', async (req, res) => {
  const condId = process.env.COND_ID;

  if (!condId) {
    return res.status(400).send('condId é obrigatório');
  }

  try {
    const areas = await fetchCondAreas(condId);
    console.log(areas)
    res.json(areas); // [{ label, value }, ...]
  } catch (e) {
    console.error('[AREAS] Erro ao buscar áreas:', e);
    res.status(500).send('Erro ao obter áreas');
  }
});

// ====================================================================
//  ROTA: ÚLTIMA CAPTURA DE PLACA POR AREAID
//  GET /api/plate-capture?areaId=<areaId>
// ====================================================================
app.get('/api/plate-capture', (req, res) => {
  const { areaId } = req.query;

  if (!areaId) {
    return res.status(400).json({ error: 'areaId é obrigatório' });
  }

  // 1) Buscar todos os canais dessa área no settingsDb
  settingsDb.find({ areaId }, (err, channels) => {
    if (err) {
      console.error('[plate-capture] Erro ao buscar canais em settingsDb:', err);
      return res.status(500).json({ error: 'Erro ao buscar canais para a área' });
    }

    if (!channels || channels.length === 0) {
      console.warn('[plate-capture] Nenhum canal encontrado para areaId:', areaId);
      return res.status(404).json({ error: 'Nenhum canal associado a essa área' });
    }

    const channelIds = channels.map((c) => c._id);

    // 2) Montar query de eventos de placa
    // - Eventos "plate" (handlePlateDetection)
    // - Eventos de speed com placa (hasPlate === true)
    const query = {
      channelId: { $in: channelIds },
      $or: [
        { eventType: 'plate' },
        { hasPlate: true }
      ],
    };

    // 3) Buscar o ÚLTIMO evento (timestamp mais recente)
    eventsDb
      .find(query)
      .sort({ timestamp: -1 })
      .limit(1)
      .exec((err2, docs) => {
        if (err2) {
          console.error('[plate-capture] Erro ao buscar eventos em eventsDb:', err2);
          return res.status(500).json({ error: 'Erro ao buscar eventos de placa' });
        }

        if (!docs || docs.length === 0) {
          console.warn('[plate-capture] Nenhum evento de placa encontrado para areaId:', areaId);
          return res.status(404).json({ error: 'Nenhum evento de placa encontrado para essa área' });
        }

        // Retorna o evento mais recente
        return res.json(docs[0]);
      });
  });
});

app.get('/api/live-plate-capture', (req, res) => {
  const { areaId } = req.query;
  console.log('[live-plate-capture] Nova requisição para areaId:', areaId);

  if (!areaId) {
    return res.status(400).json({ ok: false, error: 'areaId é obrigatório' });
  }

  // 1) Buscar canais dessa área
  settingsDb.find({ areaId }, (err, channels) => {
    if (err) {
      console.error('[live-plate-capture] Erro ao buscar canais em settingsDb:', err);
      return res.status(500).json({ ok: false, error: 'Erro ao buscar canais para a área' });
    }

    if (!channels || channels.length === 0) {
      console.warn('[live-plate-capture] Nenhum canal encontrado para areaId:', areaId);
      return res.status(404).json({ ok: false, error: 'Nenhum canal associado a essa área' });
    }

    // Estratégia: prioriza speed, depois plate, depois qualquer
    const channel =
      channels.find((c) => c.channel_type === 'speed') ||
      channels.find((c) => c.channel_type === 'plate') ||
      channels[0];

    const channelId = channel._id;

    // Se já houver uma captura pendente para este canal, recusa a nova
    if (liveCaptureWaits.has(channelId)) {
      return res.status(409).json({
        ok: false,
        error: 'Já existe uma captura ao vivo pendente para este canal',
      });
    }

    const timeoutMs = 7000;

    // Cria janela de 5 segundos aguardando um evento de placa
    const timer = setTimeout(() => {
      if (liveCaptureWaits.has(channelId)) {
        liveCaptureWaits.delete(channelId);

        // avisa o speed.py que não precisa mais do modo "live capture"
        io.to(channelId).emit('live-plate-capture-cancel', {
          channelId,
          areaId,
        });

        return res.status(404).json({
          ok: false,
          error: 'Nenhuma placa detectada na janela de 5 segundos',
        });
      }
    }, timeoutMs);

    liveCaptureWaits.set(channelId, {
      res,
      timer,
      startedAt: Date.now(),
      areaId,
    });

    // avisa o speed.py que este canal entrou em modo "live capture"
    io.to(channelId).emit('live-plate-capture-start', {
      channelId,
      areaId,
      timeoutMs,
    });

    console.log(
      `[live-plate-capture] Aguardando placa no canal ${channelId} por até ${timeoutMs} ms (modo live capture)`
    );
  });
});

// Socket.IO para comunicação em tempo real
io.on('connection', (socket) => {
  console.log('Um cliente conectado');

  socket.on('join', (channelId) => {
    socket.join(channelId);
  });

  socket.on('video-consume-start', (payload) => {
    const channelId = normalizeChannelId(payload?.channelId);
    const transport = String(payload?.transport || '').trim().toLowerCase();
    if (!channelId || transport !== 'socket') return;
    registerSocketVideoConsumer(socket.id, channelId);
  });

  socket.on('video-consume-stop', (payload) => {
    const channelId = normalizeChannelId(payload?.channelId);
    const transport = String(payload?.transport || '').trim().toLowerCase();
    if (!channelId || transport !== 'socket') return;
    unregisterSocketVideoConsumer(socket.id, channelId);
  });

  socket.on('process-started', ({ channelId }) => {
    if (processes[channelId]) {
      processes[channelId].status = 'running';
    }
    io.emit('process-started', { channelId });
  });

  socket.on('frame', (data) => {
    const channelId = normalizeChannelId(data?.channelId);
    const image = data?.image;
    if (!channelId || !image) return;

    const framePayload = { ...data, channelId };
    pushFrameToMpegTs(channelId, image, MPEGTS_DEFAULT_FPS);
    const consumerCount = emitSocketFrameToConsumers(channelId, framePayload);

    if (PLATE_DEBUG_ENABLED) {
      const byteSize =
        Buffer.isBuffer(image) ? image.length
          : typeof image === 'string' ? image.length
          : Number(image?.byteLength || 0);
      const stats = frameTrafficStats.get(channelId) || {
        frames: 0,
        bytes: 0,
        lastConsumerCount: 0,
        lastLogAt: Date.now(),
      };

      stats.frames += 1;
      stats.bytes += byteSize;
      stats.lastConsumerCount = consumerCount;

      const now = Date.now();
      if (now - stats.lastLogAt >= FRAME_DEBUG_INTERVAL_MS) {
        debugLog(
          `frame stats | channel=${channelId} frames=${stats.frames} bytes=${stats.bytes} consumers=${stats.lastConsumerCount}`
        );
        stats.frames = 0;
        stats.bytes = 0;
        stats.lastLogAt = now;
      }

      frameTrafficStats.set(channelId, stats);
    }
  });
  
  socket.on('plate-found', (payload = {}) => {
      const {
        channelId,
        plate,
        direction,
        nm,
        dotp,
        timestamp,
        eventType,
        vectorSenseEnabled,
        motionMode,
        expectedOrientation,
        vehicleOrientation,
        orientationConf,
        orientationCounts,
        orientationScores,
      } = payload;

      console.log('Plate found: ', plate, direction, nm, dotp, vehicleOrientation, expectedOrientation);

       // Se houver um live-capture pendente para este canal, resolve imediatamente
      tryResolveLiveCapture(channelId, {
        plate,
        eventType: 'plate',
        timestamp,
        source: 'plate-reader',
        vectorSenseEnabled,
        motionMode,
        expectedOrientation,
        vehicleOrientation,
        orientationConf,
      });
      
      handlePlateDetection(channelId, plate, direction, timestamp, {
        eventType,
        vectorSenseEnabled,
        motionMode,
        expectedOrientation,
        vehicleOrientation,
        orientationConf,
        orientationCounts,
        orientationScores,
      })
  });

  socket.on('plate-found-speed', async (data) => {
    const channelId = data?.channelId;
    const radarId   = data?.radarId;
    const sessionId = data?.sessionId;

    const plateData = data?.plate ?? data?.plateData;
    const speed     = Number(data?.speed);
    const speedTimestamp = data?.speedTimestamp;
    const timestamp = data?.timestamp;
    const fileName  = data?.fileName;
    const videoFileName = data?.videoFileName || null;

    console.log('[plate-found-speed]', { channelId, radarId, sessionId, plateData, speed, fileName });

    const s = speedSessions.get(channelId);
    if (!s || s.sessionId !== sessionId) {
      console.warn('[plate-found-speed] sessão inválida/expirada, ignorando', { channelId, sessionId });
      return;
    }

    // encerra sessão
    clearTimeout(s.timer);
    if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
    speedSessions.delete(channelId);

    // opcional: avisa python para descartar buffer (se você usa isso)
    io.to(channelId).emit('speed-discard-buffer', { channelId, radarId, sessionId });

    // resolve live-capture, se existir
    tryResolveLiveCapture(channelId, {
      plate: plateData,
      eventType: 'speed_plate',
      radarId,
      fileName,
      timestamp,
      source: 'speed.py',
    });
    
    // salva/filtra/emite (sua função já faz filtro maxSpeed+tolerance)
    await handleSpeedPlateResolved({
      channelId,
      radarId,
      plateData,
      speed,
      speedTimestamp,
      timestamp,
      fileName,
      videoFileName
    });
  });

  socket.on('vehicle-only', async (data) => {
    const channelId = data?.channelId;
    const radarId   = data?.radarId;
    const sessionId = data?.sessionId;

    const speed = Number(data?.speed);
    const speedTimestamp = data?.speedTimestamp;
    const timestamp = data?.timestamp;
    const fileName = data?.fileName;
    const videoFileName = data?.videoFileName || null;

    const vehicleClass = data?.vehicleClass;
    const vehicleConf  = data?.vehicleConf;

    console.log('[vehicle-only]', { channelId, radarId, sessionId, speed, fileName, vehicleClass, vehicleConf });

    const s = speedSessions.get(channelId);
    // vehicle-only pode chegar logo após timeout; ainda deve bater sessionId
    if (!s || s.sessionId !== sessionId) {
      console.warn('[vehicle-only] sessão inválida/expirada, ignorando', { channelId, sessionId });
      return;
    }

    // encerra sessão
    clearTimeout(s.timer);
    if (s.cleanupTimer) clearTimeout(s.cleanupTimer);
    speedSessions.delete(channelId);

    // Se por algum bug o Python emitir vehicle-only sem veículo, não salva nada (regra sua)
    if (!vehicleClass) {
      console.log('[vehicle-only] ignorado: sem vehicleClass (veículo não confirmado)');
      return;
    }

    const eventTimestamp = toMs(timestamp);
    const speedTs = toMs(speedTimestamp ?? timestamp);

    const event = {
      eventType: 'plate_only', // como você já usa hoje; se preferir "speed_only", mude aqui
      channelId,
      radarId,
      speed,
      speedTimestamp: speedTs,
      timestamp: eventTimestamp,
      plate: null,
      hasPlate: false,
      notRegistered: true,
      customerInfo: null,
      fileName,
      videoFileName,
      vehicle: { class: vehicleClass, conf: vehicleConf }
    };

    await annotateCaptureIfExists(fileName, {
      channelId,
      radarId,
      speedKmh: speed,
      plate: "-",
    });

    eventsDb.insert(event, (err) => {
      if (err) console.error('Erro ao salvar plate_only:', err);
    });

    postSpeedEvent(event);
    io.emit('speed-event', event);
  });

  socket.on('speed-only', async ({ channelId, radarId, speed, speedTimestamp, timestamp, fileName }) => {
    console.log('Speed-only event from Python:', channelId, radarId, speed, speedTimestamp, fileName);

    const spNum = Number(speed);
    if (!Number.isFinite(spNum)) {
      console.warn('[speed-only] Velocidade inválida recebida:', speed);
      return;
    }

    let speedTsDate;
    if (speedTimestamp) {
      speedTsDate = new Date(speedTimestamp);
    } else if (timestamp) {
      speedTsDate = new Date(timestamp);
    } else {
      speedTsDate = new Date();
    }

    // Salva no banco e dispara para API/dashboard
    saveSpeedOnlyEvent(channelId, radarId, spNum, speedTsDate, fileName);

      // 2) ANOTA A IMAGEM SALVA (speedOnly: placa = "-")
    await annotateCaptureIfExists(fileName, {
      channelId,
      radarId,
      speedKmh: spNum,
      plate: "-", // speedOnly sem placa
    });
  });

  socket.on('performance-report', (data) => {
    io.emit('performance-report', data);
  });

  socket.on('disconnect', () => {
    clearSocketVideoConsumersForSocket(socket.id);
    console.log('Um cliente desconectou');
  });

});

async function fetchCondAreas(condId) {
  // const url = `https://api.dozz.com.br/plate/getareas/${condId}`;
  const url = `http://localhost:5009/plate/getareas/${condId}`;
  console.log('[AREAS] Buscando áreas em:', url);

  const resp = await fetch(url);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Falha ao buscar áreas: ${resp.status} - ${txt}`);
  }

  const data = await resp.json();
  if (!Array.isArray(data)) {
    throw new Error('Resposta de áreas não é um array');
  }
  // data já está no formato [{ label, value }, ...]
  return data;
}

// Iniciar o servidor
const PORT = process.env.PORT || 4000;
http.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(
    `[VIDEO] mode=${VIDEO_DELIVERY_MODE} socket_fallback=${VIDEO_SOCKET_FALLBACK} ` +
    `mpegts_ws_enabled=${MPEGTS_WS_ENABLED} path_template=${MEDIA_STREAM_PATH_TEMPLATE} ` +
    `mpegts_ws_prefix=${MPEGTS_WS_PREFIX} bitrate_kbps=${MPEGTS_BITRATE_KBPS} ` +
    `default_fps=${MPEGTS_DEFAULT_FPS}`
  );
  logDbRuntimeInfo();
  prewarmSharedPlateBatchWorkerFromSettings();
  startMg3000GatewayServer();
});

process.on('SIGINT', () => {
  stopSharedPlateBatchWorker('sigint');
  setTimeout(() => process.exit(0), 120);
});

process.on('SIGTERM', () => {
  stopSharedPlateBatchWorker('sigterm');
  setTimeout(() => process.exit(0), 120);
});

/**
 * Monta o texto do overlay com base no canal salvo em settingsDb.
 * - endereço: channel.add
 * - geolocalização: channel.location
 * - velocidade máxima: channel.maxSpeed
 * - tolerância: channel.tolerance
 * - mostra velocidade lida e velocidade considerada (lida - tolerância)
 */
function buildOverlayLines({ radarId, channel, speedKmh, plate }) {
  const addr = channel?.add ?? "-";
  const geo = channel?.location ?? "-";

  const maxSpeedNum = Number(channel?.maxSpeed);
  const tolNum = Number(channel?.tolerance);

  const maxSpeedText = Number.isFinite(maxSpeedNum) ? `${maxSpeedNum} km/h` : "-";
  const tolText = Number.isFinite(tolNum) ? `${tolNum} km/h` : "-";

  const speedReadText =
    (speedKmh === null || speedKmh === undefined || !Number.isFinite(Number(speedKmh)))
      ? "-"
      : `${Number(speedKmh)} km/h`;

  let consideredText = "-";
  if (Number.isFinite(Number(speedKmh)) && Number.isFinite(tolNum)) {
    consideredText = `${Number(speedKmh) - tolNum} km/h`;
  }

  const plateText = plate ? String(plate) : "-";
  const rid = radarId || channel?.radarId || "-";

  return [
    `ID do Radar: ${rid}`,
    `Endereço: ${addr}`,
    `Geolocalização: ${geo}`,
    `Velocidade máxima: ${maxSpeedText}`,
    `Tolerância: ${tolText}`,
    `Velocidade lida: ${speedReadText}`,
    `Velocidade considerada: ${consideredText}`,
    `Placa: ${plateText}`,
  ];
}

/**
 * Gera um SVG (com fundo semitransparente) para sobrepor no canto superior direito.
 */
function makeOverlaySvg({ imgW, imgH, lines }) {
  // escala básica conforme resolução
  const scale = Math.max(1, imgW / 1280); // ~1 em 1280px, ~1.5 em 1920px
  const fontSize = Math.round(18 * scale);
  const lineGap = Math.round(8 * scale);
  const pad = Math.round(14 * scale);

  const boxW = Math.round(Math.min(imgW * 0.42, 650 * scale)); // caixa grande porém limitada
  const lineH = fontSize + lineGap;
  const boxH = pad * 2 + (lines.length * lineH);

  const topOffset = Math.round(55 * scale);
  const x = imgW - boxW - pad;
  const y = pad + topOffset;

  const textX = imgW - pad * 2; // alinhado à direita
  const textY0 = y + pad + fontSize;

  const escapeXml = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const textEls = lines.map((ln, i) => {
    const ty = textY0 + i * lineH;
    return `<text x="${textX}" y="${ty}" text-anchor="end" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#fff">${escapeXml(ln)}</text>`;
  }).join("\n");

  return `
  <svg width="${imgW}" height="${imgH}">
    <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${Math.round(10 * scale)}" ry="${Math.round(10 * scale)}"
          fill="rgba(0,0,0,0.55)"/>
    ${textEls}
  </svg>`;
}

/**
 * Anota (escreve overlay) em um JPG já salvo no disco.
 * Regrava o mesmo arquivo (padrão).
 */
async function annotateJpegFile(filePath, { lines }) {
  if (!fs.existsSync(filePath)) return;

  const input = fs.readFileSync(filePath);
  const img = sharp(input);
  const meta = await img.metadata();

  const imgW = meta.width || 1920;
  const imgH = meta.height || 1080;

  const svg = makeOverlaySvg({ imgW, imgH, lines });

  const out = await sharp(input)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  fs.writeFileSync(filePath, out);
}

function getCapturePathFromFileName(fileName) {
  // Ajuste aqui se seu diretório real for outro
  return path.join(__dirname, "public", "captures", fileName);
}

function findChannelById(channelId) {
  return new Promise((resolve) => {
    if (!channelId) return resolve(null);
    settingsDb.findOne({ _id: channelId }, (err, doc) => {
      if (err) {
        console.error("[findChannelById] erro:", err);
        return resolve(null);
      }
      resolve(doc || null);
    });
  });
}

async function annotateCaptureIfExists(fileName, overlayData) {
  if (!fileName) return;

  const filePath = getCapturePathFromFileName(fileName);

  try {
    const channel = await findChannelById(overlayData?.channelId);

    // monta linhas com base no canal do DB
    const lines = buildOverlayLines({
      radarId: overlayData?.radarId,
      channel,
      speedKmh: overlayData?.speedKmh,
      plate: overlayData?.plate,
    });

    // usa seu annotateJpegFile, mas passando as linhas prontas (pequena mudança)
    await annotateJpegFile(filePath, { lines });
  } catch (e) {
    console.error("[annotateCaptureIfExists] erro:", e);
  }
}


async function handleSpeedPlateResolved({ channelId, radarId, plateData, speed, speedTimestamp, timestamp, fileName, videoFileName }) {
  const eventTimestamp = timestamp ? new Date(timestamp) : new Date();
  const speedTs = speedTimestamp ? new Date(speedTimestamp) : eventTimestamp;

  // filtro maxSpeed + tolerance
  settingsDb.findOne({ _id: channelId }, (err, channel) => {
    if (err || !channel) {
      console.error('[SpeedEvent] Canal não encontrado:', err);
      return;
    }

    const maxSpeed = Number(channel.maxSpeed);
    const tolerance = Number(channel.tolerance);
    const decisionSpeed = maxSpeed + tolerance;

    if (Number.isFinite(decisionSpeed) && Number.isFinite(Number(speed))) {
      if (Number(speed) <= decisionSpeed) {
        console.log(`[SpeedEvent] ${speed} <= ${decisionSpeed} – NÃO gerar evento.`);
        return;
      }
    }

    platesDb.find({}, (err2, docs) => {
      if (err2) {
        console.error('Erro ao consultar platesDb:', err2);
        return;
      }

      let plateFound = false;
      let matchedDevice = null;
      let matchedDoc = null;

      for (const doc of docs) {
        for (const device of doc.devices) {
          if (platesMatch(plateData, device.plate)) {
            plateFound = true;
            matchedDevice = device;
            matchedDoc = doc;
            break;
          }
        }
        if (plateFound) break;
      }

      const baseEvent = {
        eventType: 'speed_plate',
        channelId,
        radarId,
        speed: Number(speed),
        speedTimestamp: speedTs.getTime(),
        timestamp: eventTimestamp.getTime(),
        hasPlate: true,
        plate: plateData,
        fileName,
        videoFileName
      };

      // anotar imagem (placa + velocidade)
      annotateCaptureIfExists(fileName, {
        channelId,
        radarId,
        speedKmh: Number(speed),
        plate: plateData
      });

      const event = plateFound && matchedDevice && matchedDoc
        ? {
            ...baseEvent,
            customerInfo: {
              name: matchedDoc.userName,
              unit: matchedDoc.unid,
              group: matchedDoc.grupo,
              make: matchedDevice.make,
              model: matchedDevice.model,
              color: matchedDevice.color,
            },
            notRegistered: false
          }
        : {
            ...baseEvent,
            customerInfo: null,
            notRegistered: true
          };
      
      console.log('ESTAMOS AQUI', event)
      eventsDb.insert(event, (e) => {
        if (e) console.error('Erro ao salvar speed_plate:', e);
      });

      // envia API central
      postSpeedEvent(baseEvent);

      // emite dashboard
      io.emit('speed-event', event);
    });
  });
}

function clearSpeedSession(channelId) {
  const s = speedSessions.get(channelId);
  if (!s) return;

  clearTimeout(s.timer);
  if (s.cleanupTimer) clearTimeout(s.cleanupTimer);

  speedSessions.delete(channelId);
}
