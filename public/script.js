// script.js

// Armazena o socket globalmente
var socket = io();

let plateProcesses = {}; 

// Variável global para armazenar dados de cadastros
let cadastrosData = [];
let cadastrosVehiclesData = [];
let gateStatusByChannel = {};
let interlocksCache = [];
let interlockSettingsCache = { gateCommandCooldownMs: 15000 };
// (Opcional) Um mapeamento de grupo -> set de unidades
let grupoUnidadeMapCadastros = {};
const CADASTROS_DEBUG_ENABLED = (() => {
  try {
    return window.localStorage.getItem('dozzplate_cadastros_debug') === '1';
  } catch (_) {
    return false;
  }
})();

function cadastrosDebug(...args) {
  if (!CADASTROS_DEBUG_ENABLED) return;
  console.log('[CADASTROS_DEBUG]', ...args);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Mapeamento de categorias para português
const categoryLabels = {
  'person': 'Pessoa',
  'car': 'Carro',
  'truck': 'Caminhão',
  'bus': 'Ônibus',
  'motorcycle': 'Moto',
  'bicycle': 'Bicicleta',
  'dog': 'Cachorro',
  'cat': 'Gato',
  'horse': 'Cavalo'
};

  document.addEventListener('DOMContentLoaded', async () => {
    feather.replace();
  
    // Função para alternar a sidebar
    const sidebarToggle = () => {
      const sidebar = document.getElementById('sidebar');
      const content = document.getElementById('content');
      sidebar.classList.toggle('active');
      content.classList.toggle('active');
    };
  
    // Event listener para o botão de alternar a sidebar
    document.getElementById('sidebarCollapse').addEventListener('click', sidebarToggle);
  
    // Event listeners para os links do menu
    // document.getElementById('dashboard-plate-link').addEventListener('click', (e) => {
    //   e.preventDefault();
    //   loadDashboardPlate();
    // });
    
    // document.getElementById('dashboard-ia-link').addEventListener('click', (e) => {
    //   e.preventDefault();
    //   loadDashboardIA();
    // });
  
    document.getElementById('dashboard-speed-link').addEventListener('click', (e) => {
      e.preventDefault();
      loadDashboardSpeed();
    });

    document.getElementById('mosaic-link').addEventListener('click', (e) => {
      e.preventDefault();
      loadMosaic();
    });
  
    document.getElementById('settings-link').addEventListener('click', (e) => {
      e.preventDefault();
      loadSettings();
    });

    const interlocksLink = document.getElementById('interlocks-link');
    if (interlocksLink) {
      interlocksLink.addEventListener('click', (e) => {
        e.preventDefault();
        loadInterlocks();
      });
    }

    document.getElementById('eventos-link').addEventListener('click', (e) => {
      e.preventDefault();
      loadEventos();
    });
  
    const cadastrosLink = document.getElementById('cadastros-link');
    if (cadastrosLink) {
      cadastrosLink.addEventListener('click', (e) => {
        e.preventDefault();
        loadCadastros();
      });
    }

    // Carrega o Dashboard por padrão ao carregar a página
    loadDashboard();

    const options = await loadAreasOptions();

    const addSelect  = document.getElementById('addChannelArea');
    const editSelect = document.getElementById('editChannelArea');

    fillAreaSelect(addSelect, options);
    fillAreaSelect(editSelect, options);
  });
  
  // Variáveis globais
  let processes = {}; // Para rastrear processos em execução e seus estados
  const performanceByChannel = new Map();
  const mosaicLastBlobUrl = new Map();
  const mosaicLastRenderAt = new Map();
  const mosaicSocketChannels = new Set();
  const mosaicVideoConfigCache = new Map();
  const mosaicMpegPlayers = new Map();
  const socketVideoConsumeRefs = new Set();
  let settingsVideoModePollTimer = null;
  const MOSAIC_MAX_RENDER_FPS = 8;

  function toFiniteNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function renderPerformancePanel() {
    const perfFps = document.querySelector('.perf-fps');
    const perfCpu = document.querySelector('.perf-cpu');
    const perfRam = document.querySelector('.perf-ram');
    const perfGpu = document.querySelector('.perf-gpu');
    const perfVram = document.querySelector('.perf-vram');

    if (!perfFps && !perfCpu && !perfRam && !perfGpu && !perfVram) return;

    let totalFps = 0;
    let latest = null;

    performanceByChannel.forEach((data) => {
      totalFps += toFiniteNumber(data?.avg_fps, 0);
      latest = data;
    });

    if (perfFps) perfFps.textContent = totalFps.toFixed(2);
    if (!latest) return;

    if (perfCpu) perfCpu.textContent = toFiniteNumber(latest.cpu_usage, 0).toFixed(1);
    if (perfRam) perfRam.textContent = toFiniteNumber(latest.ram_usage, 0).toFixed(1);
    if (perfGpu) perfGpu.textContent = toFiniteNumber(latest.gpu_usage, 0).toFixed(1);
    if (perfVram) perfVram.textContent = toFiniteNumber(latest.gpu_memory_usage, 0).toFixed(1);
  }

  function clearMosaicFrameCache() {
    stopSettingsVideoModePolling();
    mosaicLastBlobUrl.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {
        // no-op
      }
    });
    mosaicLastBlobUrl.clear();
    mosaicLastRenderAt.clear();
    stopAllMosaicStreams();
  }

  function clearMosaicVideoConfigCache() {
    mosaicVideoConfigCache.clear();
  }

  function stopSettingsVideoModePolling() {
    if (!settingsVideoModePollTimer) return;
    clearInterval(settingsVideoModePollTimer);
    settingsVideoModePollTimer = null;
  }

  function makeSocketVideoConsumeKey(channelId, source) {
    return `${String(source || 'unknown')}:${String(channelId || '')}`;
  }

  function startSocketVideoConsume(channelId, source) {
    const key = makeSocketVideoConsumeKey(channelId, source);
    if (socketVideoConsumeRefs.has(key)) return;
    socketVideoConsumeRefs.add(key);
    socket.emit('video-consume-start', {
      channelId,
      transport: 'socket',
      source,
    });
  }

  function stopSocketVideoConsume(channelId, source) {
    const key = makeSocketVideoConsumeKey(channelId, source);
    if (!socketVideoConsumeRefs.has(key)) return;
    socketVideoConsumeRefs.delete(key);
    socket.emit('video-consume-stop', {
      channelId,
      transport: 'socket',
      source,
    });
  }

  function destroyMosaicMpegPlayer(channelId) {
    const key = `mosaic-canvas-${channelId}`;
    const player = mosaicMpegPlayers.get(key);
    if (!player) return;

    try {
      player.destroy();
    } catch (_) {
      // no-op
    }
    mosaicMpegPlayers.delete(key);
  }

  function stopAllMosaicStreams() {
    mosaicSocketChannels.forEach((channelId) => {
      stopSocketVideoConsume(channelId, 'mosaic');
    });

    mosaicMpegPlayers.forEach((player) => {
      try {
        player.destroy();
      } catch (_) {
        // no-op
      }
    });
    mosaicMpegPlayers.clear();
    mosaicSocketChannels.clear();

    document.querySelectorAll('canvas[id^="mosaic-canvas-"]').forEach((canvas) => {
      canvas.style.display = 'none';
    });
  }

  async function fetchMosaicVideoConfig(channelId, options = {}) {
    const useCache = options?.useCache !== false;
    if (useCache && mosaicVideoConfigCache.has(channelId)) {
      return mosaicVideoConfigCache.get(channelId);
    }

    const response = await fetch(`/api/video-stream/${channelId}`);
    if (!response.ok) {
      throw new Error(`Falha ao obter config de vídeo (${response.status})`);
    }

    const payload = await response.json();
    if (!payload?.ok) {
      throw new Error(payload?.error || 'Config de vídeo inválida');
    }

    mosaicVideoConfigCache.set(channelId, payload);
    return payload;
  }

  function getVideoModePresentation(config) {
    const runtime = config?.runtime || {};
    const wsClients = toFiniteNumber(runtime?.wsClients, 0);
    const socketClients = toFiniteNumber(runtime?.socketClients, 0);

    if (runtime?.activeTransport === 'mpegts') {
      return { label: `Socket Ativo (${wsClients})`, cssClass: 'video-mode-ws' };
    }
    if (runtime?.activeTransport === 'socket') {
      return { label: `Socket Ativo (${socketClients})`, cssClass: 'video-mode-socket' };
    }
    if (runtime?.activeTransport === 'mixed') {
      return { label: `Socket Ativo (${wsClients + socketClients})`, cssClass: 'video-mode-mixed' };
    }

    if (config?.mode === 'mpegts') {
      return { label: 'IDLE', cssClass: 'video-mode-idle' };
    }
    if (config?.mode === 'socket') {
      return { label: 'IDLE', cssClass: 'video-mode-idle' };
    }

    return { label: 'Desconhecido', cssClass: 'video-mode-unknown' };
  }

  async function resolveChannelVideoMode(channelId, options = {}) {
    try {
      const config = await fetchMosaicVideoConfig(channelId, options);
      return getVideoModePresentation(config);
    } catch (_) {
      return { label: 'Desconhecido', cssClass: 'video-mode-unknown' };
    }
  }

  function applyVideoModeToRow(channelId, mode) {
    const row = document.querySelector(`#channels-table tbody tr[data-id="${channelId}"]`);
    if (!row) return;
    const badge = row.querySelector('.video-mode-pill');
    if (!badge) return;
    badge.className = `video-mode-pill ${mode?.cssClass || 'video-mode-unknown'}`;
    badge.textContent = mode?.label || 'Desconhecido';
  }

  async function refreshSettingsVideoModesOnce() {
    const rows = document.querySelectorAll('#channels-table tbody tr[data-id]');
    if (!rows.length) return;

    await Promise.all(Array.from(rows).map(async (row) => {
      const channelId = row.getAttribute('data-id');
      if (!channelId) return;
      const mode = await resolveChannelVideoMode(channelId, { useCache: false });
      applyVideoModeToRow(channelId, mode);
    }));
  }

  function startSettingsVideoModePolling() {
    stopSettingsVideoModePolling();
    refreshSettingsVideoModesOnce().catch(() => undefined);

    settingsVideoModePollTimer = setInterval(() => {
      if (!document.getElementById('channels-table')) {
        stopSettingsVideoModePolling();
        return;
      }
      refreshSettingsVideoModesOnce().catch(() => undefined);
    }, 3000);
  }

  async function enrichChannelsWithVideoMode(channels) {
    if (!Array.isArray(channels) || channels.length === 0) return [];

    const enriched = await Promise.all(channels.map(async (channel) => {
      const mode = await resolveChannelVideoMode(channel._id);
      return {
        ...channel,
        __videoModeLabel: mode.label,
        __videoModeClass: mode.cssClass,
      };
    }));

    return enriched;
  }

  function getMosaicTile(channelId) {
    return document.getElementById(`mosaic-item-${channelId}`);
  }

  function getMosaicImageEl(channelId) {
    return document.getElementById(`mosaic-image-${channelId}`);
  }

  function getMosaicCanvasEl(channelId) {
    return document.getElementById(`mosaic-canvas-${channelId}`);
  }

  function normalizeMpegTsWsUrl(rawUrl) {
    if (!rawUrl) return null;

    try {
      const target = new URL(rawUrl, window.location.origin);
      target.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return target.toString();
    } catch (_) {
      return null;
    }
  }

  function activateMosaicSocketFallback(channelId) {
    const imgEl = getMosaicImageEl(channelId);
    const canvasEl = getMosaicCanvasEl(channelId);
    const wasSocketMode = mosaicSocketChannels.has(channelId);

    destroyMosaicMpegPlayer(channelId);

    if (canvasEl) {
      canvasEl.style.display = 'none';
    }

    if (imgEl) {
      imgEl.style.display = 'block';
    }

    if (!wasSocketMode) {
      startSocketVideoConsume(channelId, 'mosaic');
    }
    mosaicSocketChannels.add(channelId);
  }

  function activateMosaicMpegTsMode(channelId) {
    const imgEl = getMosaicImageEl(channelId);
    const canvasEl = getMosaicCanvasEl(channelId);
    if (imgEl) imgEl.style.display = 'none';
    if (canvasEl) canvasEl.style.display = 'block';

    const blobUrl = mosaicLastBlobUrl.get(channelId);
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch (_) {
        // no-op
      }
      mosaicLastBlobUrl.delete(channelId);
    }
    stopSocketVideoConsume(channelId, 'mosaic');
    mosaicSocketChannels.delete(channelId);
  }

  function attachMosaicMpegTs(channelId, wsUrl) {
    const canvasEl = getMosaicCanvasEl(channelId);
    if (!canvasEl || typeof JSMpeg === 'undefined') return false;

    const normalizedUrl = normalizeMpegTsWsUrl(wsUrl);
    if (!normalizedUrl) return false;

    destroyMosaicMpegPlayer(channelId);

    const key = `mosaic-canvas-${channelId}`;
    try {
      const player = new JSMpeg.Player(normalizedUrl, {
        canvas: canvasEl,
        autoplay: true,
        audio: false,
        disableGl: true,
        preserveDrawingBuffer: false,
      });
      mosaicMpegPlayers.set(key, player);

      const sourceSocket = player?.source?.socket;
      if (sourceSocket && typeof sourceSocket.addEventListener === 'function') {
        sourceSocket.addEventListener('close', () => activateMosaicSocketFallback(channelId), { once: true });
        sourceSocket.addEventListener('error', () => activateMosaicSocketFallback(channelId), { once: true });
      }
      return true;
    } catch (error) {
      console.warn(`Falha ao iniciar JSMpeg para canal ${channelId}:`, error?.message || error);
      return false;
    }
  }

  async function initMosaicChannelDelivery(channel) {
    const channelId = channel?._id;
    if (!channelId) return;

    let config;
    try {
      config = await fetchMosaicVideoConfig(channelId);
    } catch (error) {
      console.warn(`Falha ao obter stream para ${channelId}, fallback Socket.IO:`, error?.message || error);
      activateMosaicSocketFallback(channelId);
      return;
    }

    if (config.mode === 'mpegts' && config.mpegtsWsUrl) {
      const attached = attachMosaicMpegTs(channelId, config.mpegtsWsUrl);
      if (attached) {
        activateMosaicMpegTsMode(channelId);
        return;
      }
    }

    activateMosaicSocketFallback(channelId);
  }

  let statusConfig = {
    'starting': { color: 'yellow', icon: 'loader', title: 'Iniciando...' },
    'running': { color: 'green', icon: 'square', title: 'Parar' },
    'reconnecting': { color: 'orange', icon: 'loader', title: 'Reconectando...' },
    'error': { color: 'red', icon: 'alert-circle', title: 'Erro' },
    'stopped': { color: 'red', icon: 'play', title: 'Iniciar' },
  };

  function gateStatusMeta(status) {
    const normalized = String(status || 'unknown').toLowerCase();
    if (normalized === 'closed') return { label: 'Fechado', className: 'gate-closed' };
    if (normalized === 'open') return { label: 'Aberto', className: 'gate-open' };
    if (normalized === 'opening') return { label: 'Abrindo', className: 'gate-opening' };
    return { label: 'Desconhecido', className: 'gate-unknown' };
  }

  function controllerStatusMeta(online) {
    return online
      ? { label: 'Online', className: 'controller-online' }
      : { label: 'Offline', className: 'controller-offline' };
  }

  function formatDurationMs(ms) {
    const safeMs = Math.max(0, Number(ms || 0));
    if (safeMs < 1000) return '0s';
    return `${Math.ceil(safeMs / 1000)}s`;
  }

  function cooldownStatusMeta(state = {}) {
    const expiresAtMs = state.cooldownExpiresAt ? Date.parse(state.cooldownExpiresAt) : NaN;
    const remainingMs = Number.isFinite(expiresAtMs)
      ? Math.max(0, expiresAtMs - Date.now())
      : Number(state.cooldownRemainingMs || 0);
    const active = state.cooldownActive === true && remainingMs > 0;
    return active
      ? { label: `Cooldown ${formatDurationMs(remainingMs)}`, className: 'cooldown-active' }
      : { label: 'Pronto', className: 'cooldown-ready' };
  }

  function normalizeInterlockSettings(settings = {}) {
    const cooldownMs = Number(settings.gateCommandCooldownMs);
    return {
      gateCommandCooldownMs: Number.isFinite(cooldownMs)
        ? Math.max(1000, Math.round(cooldownMs))
        : 15000,
    };
  }

  function normalizeDoorAddress(value) {
    return String(value || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/g, '')
      .replace(/:\d+$/g, '')
      .replace(/^::ffff:/, '');
  }

  function toDoorInteger(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeDoorDriverValue(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['dozz_vehicle', 'dozzvehicle', 'vehicle'].includes(normalized) ? 'dozz_vehicle' : 'mg3000';
  }

  function getChannelDoorKey(channel = {}) {
    const driver = normalizeDoorDriverValue(channel.doorDriver);
    if (driver === 'dozz_vehicle') {
      const controller = normalizeDoorAddress(channel.vehicleAdd || channel.equipAdd);
      const vehicleChannel = toDoorInteger(channel.vehicleChannel || channel.port);
      if (controller && vehicleChannel !== null) return `dozz_vehicle:${controller}:ch:${vehicleChannel}`;
      return channel._id ? `channel:${channel._id}` : '';
    }

    const controller = normalizeDoorAddress(channel.equipAdd);
    const apiKey = String(channel.mg3000ApiKey || channel.apiKey || '').trim();
    const rec = toDoorInteger(channel.receptorAdd);
    const door = toDoorInteger(channel.port);
    const controllerKey = controller || (apiKey ? `api:${apiKey}` : '');
    if (controllerKey && rec !== null && door !== null) return `mg3000:${controllerKey}:rec:${rec}:door:${door}`;
    return channel._id ? `channel:${channel._id}` : '';
  }

  function getChannelDoorLabel(channel = {}) {
    const driver = normalizeDoorDriverValue(channel.doorDriver);
    if (driver === 'dozz_vehicle') {
      const controller = normalizeDoorAddress(channel.vehicleAdd || channel.equipAdd) || 'sem-controladora';
      const vehicleChannel = toDoorInteger(channel.vehicleChannel || channel.port);
      return `Vehicle ${controller} canal ${vehicleChannel ?? '-'}`;
    }

    const controller = normalizeDoorAddress(channel.equipAdd) || 'sem-controladora';
    const rec = toDoorInteger(channel.receptorAdd);
    const door = toDoorInteger(channel.port);
    return `MG3000 ${controller} rec ${rec ?? '-'} porta ${door ?? '-'}`;
  }

  function buildInterlockDoors(channels = []) {
    const byKey = new Map();
    channels.forEach((channel) => {
      const key = getChannelDoorKey(channel);
      if (!key) return;
      const item = byKey.get(key) || {
        key,
        name: getChannelDoorLabel(channel),
        channelIds: [],
        channels: [],
      };
      item.channelIds.push(channel._id);
      item.channels.push({
        channelId: channel._id,
        name: channel.name || channel._id,
      });
      byKey.set(key, item);
    });
    return Array.from(byKey.values()).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  function getInterlockDoorKeys(interlock = {}, channels = []) {
    if (Array.isArray(interlock.doorKeys) && interlock.doorKeys.length) {
      return interlock.doorKeys.map(String);
    }
    const channelById = new Map(channels.map((channel) => [String(channel._id), channel]));
    return Array.from(new Set((interlock.channelIds || []).map((channelId) => (
      getChannelDoorKey(channelById.get(String(channelId))) || `channel:${channelId}`
    )).filter(Boolean)));
  }

  function applyGatewayStatusPayload(payload = {}) {
    const next = {};
    const channels = Array.isArray(payload.channels)
      ? payload.channels
      : Object.values(payload?.doorStatus?.channelStates || {});

    channels.forEach((channel) => {
      if (!channel?.channelId) return;
      next[channel.channelId] = channel;
    });
    gateStatusByChannel = next;
    updateGateStatusRows();
    updateInterlockRuntimeStatus();
  }

  async function refreshGatewayStatus() {
    try {
      const payload = await fetchJson('/api/gate-status');
      applyGatewayStatusPayload(payload);
      return payload;
    } catch (error) {
      console.warn('Falha ao buscar status do gateway:', error?.message || error);
      return null;
    }
  }

  function updateGateStatusRows() {
    document.querySelectorAll('.gate-status-pill[data-channel-id]').forEach((pill) => {
      const channelId = pill.getAttribute('data-channel-id');
      const state = gateStatusByChannel[channelId] || {};
      const meta = gateStatusMeta(state.gateStatus);
      pill.className = `gate-status-pill ${meta.className}`;
      pill.textContent = meta.label;
      pill.title = state.updatedAt ? `Atualizado em ${state.updatedAt}` : 'Sem evento recebido';
    });

    document.querySelectorAll('.controller-status-pill[data-channel-id]').forEach((pill) => {
      const channelId = pill.getAttribute('data-channel-id');
      const state = gateStatusByChannel[channelId] || {};
      const meta = controllerStatusMeta(state.controllerOnline === true);
      pill.className = `controller-status-pill ${meta.className}`;
      pill.textContent = meta.label;
      pill.title = state.controllerAddress || '';
    });
  }

  function setupGatewayStatusSocket() {
    socket.off('gate-status-updated');
    socket.off('gate-cooldown-updated');
    socket.off('mg3000-status-updated');
    socket.on('gate-status-updated', (state) => {
      if (!state?.channelId) return;
      gateStatusByChannel[state.channelId] = {
        ...(gateStatusByChannel[state.channelId] || {}),
        ...state,
      };
      updateGateStatusRows();
      updateInterlockRuntimeStatus();
    });
    socket.on('gate-cooldown-updated', (state) => {
      if (!state?.channelId) return;
      gateStatusByChannel[state.channelId] = {
        ...(gateStatusByChannel[state.channelId] || {}),
        ...state,
      };
      updateGateStatusRows();
      updateInterlockRuntimeStatus();
    });
    socket.on('mg3000-status-updated', () => {
      refreshGatewayStatus().catch(() => undefined);
    });
  }

  // Função para carregar o Dashboard
  function loadDashboard() {
    const mainContent = document.getElementById('main-content');
    document.getElementById('page-title').innerText = 'Dashboard';
    clearMosaicFrameCache();
  
    // Limpar conteúdo anterior
    mainContent.innerHTML = '';
  
    // Criar o letreiro de status com texto inicial
    const statusMarquee = document.createElement('div');
    statusMarquee.id = 'status-marquee';
    statusMarquee.className = 'status-marquee';
    statusMarquee.style.padding = '10px';
    statusMarquee.style.borderRadius = '5px';
    mainContent.appendChild(statusMarquee);
  
    // Carregar o estado inicial do processo
    loadInitialProcessState();
  
    // Obter os canais ativos
    fetch('/api/active-channels')
      .then(response => response.json())
      .then(channels => {
        // Criar contêiner para as tabelas
        const tablesContainer = document.createElement('div');
        tablesContainer.className = 'tables-container';
  
        channels.forEach(channel => {
          // Criar uma tabela para cada canal
          // const tableWrapper = document.createElement('div');
          // tableWrapper.className = 'table-wrapper';
  
          // const tableTitle = document.createElement('h3');
          // tableTitle.textContent = `Canal ${channel.name}`;
          // tableWrapper.appendChild(tableTitle);
  
          // const table = document.createElement('table');
          // table.className = 'controle-table';
          // table.innerHTML = `
          //   <thead>
          //     <tr>
          //       <th>Evento</th>
          //       <th>Data/Hora</th>
          //     </tr>
          //   </thead>
          //   <tbody id="table-body-${channel._id}">
          //     <!-- Linhas serão adicionadas dinamicamente -->
          //   </tbody>
          // `;
          // tableWrapper.appendChild(table);
          // tablesContainer.appendChild(tableWrapper);
  
          // Buscar os últimos eventos para este canal
          fetch(`/api/events/${channel._id}`)
            .then(response => response.json())
            .then(events => {
              events.forEach(event => {
                updateDashboardTable(event);
              });
            })
            .catch(error => {
              console.error(`Erro ao carregar eventos para o canal ${channel._id}:`, error);
            });
        });
  
        mainContent.appendChild(tablesContainer);
  
        // Configurar os listeners Socket.IO para o Dashboard
        setupDashboardSocket();
      })
      .catch(error => {
        console.error('Erro ao carregar os canais ativos:', error);
        mainContent.innerHTML = '<p>Erro ao carregar o dashboard.</p>';
      });
  }
  
  // Função para atualizar a tabela do dashboard com novos eventos
function updateDashboardTable(data, { prepend = true } = {}) {
  const { channelId, eventData, timestamp } = data;
  const tbody = document.getElementById(`table-body-${channelId}`);

  if (!tbody) {
    console.error(`Tabela para o canal ${channelId} não encontrada.`);
    return;
  }

  const newRow = document.createElement('tr');
  newRow.innerHTML = `
    <td>${eventData}</td>
    <td>${formatTimestamp(timestamp)}</td>
  `;

  if (prepend) {
    tbody.insertBefore(newRow, tbody.firstChild); // realtime (mais novo em cima)
  } else {
    tbody.appendChild(newRow); // batch (mantém a ordem do array)
  }

  const rows = tbody.querySelectorAll('tr');
  while (rows.length > 20) {
    tbody.removeChild(tbody.lastChild);
  }
}

  // Função para configurar os listeners Socket.IO para o dashboard
  function setupDashboardSocket() {
    // Remover event listeners anteriores para evitar múltiplas ligações
    socket.off('actionEvent');
    socket.off('process-started');
    socket.off('process-stopped');
    socket.off('process-error');
    socket.off('process-starting');
    socket.off('process-reconnecting');
    socket.off('performance-report');
    socket.off('plate-found');
    socket.off('plate-found-speed');

    // Escutar o evento 'actionEvent' para atualizações
    socket.on('actionEvent', (data) => {
      // console.log('Evento de ação recebido:', data);
      updateDashboardTable(data);
    });

    // Escutar eventos de processo e atualizar o letreiro de status e círculos de status
    socket.on('process-starting', ({ channelId }) => {
      // console.log('process-starting');
      updateStatusMarquee('Conectando...', 'yellow', 'black');
      updateStatusCircle(channelId, 'starting');
      updatePlateTabStatus(channelId, 'starting');
      showSnackMessage(`Processo em inicialização para o canal ${channelId}.`, 'info');

      // Atualizar o objeto 'processes'
      processes[channelId] = { channelId, status: 'starting' };
    });

    socket.on('process-reconnecting', ({ channelId }) => {
      // console.log('process-reconnecting');
      updateStatusMarquee('Reconectando...', 'orange', 'black');
      updateStatusCircle(channelId, 'reconnecting');
      updatePlateTabStatus(channelId, 'reconnecting');
      showSnackMessage(`Reconectando ao processo para o canal ${channelId}.`, 'info');

      // Atualizar o objeto 'processes'
      processes[channelId] = { channelId, status: 'reconnecting' };
    });

    socket.on('process-started', ({ channelId }) => {
      console.log('process-started', channelId);
      updateStatusMarquee('Processo em execução', 'green', 'white');
      updateStatusCircle(channelId, 'running');
      updatePlateTabStatus(channelId, 'running');

      const button = findButtonByChannelId(channelId);
      if (button) {
        const config = statusConfig['running'];
        button.setAttribute('data-status', 'running');
        button.setAttribute('title', config.title);
        button.innerHTML = `<i data-feather="${config.icon}"></i>`;
        feather.replace();
        button.disabled = false;
        button.style.pointerEvents = 'auto';
        showSnackMessage(`Processo iniciado para o canal ${channelId}.`, 'info');
      }

      // Atualizar o objeto 'processes'
      processes[channelId] = { channelId, status: 'running' };
    });

    socket.on('process-stopped', ({ channelId }) => {
      console.log('process-stopped');
      updateStatusMarquee('Processo parado', 'red', 'white');
      updateStatusCircle(channelId, 'stopped');
      updatePlateTabStatus(channelId, 'stopped');
      performanceByChannel.delete(channelId);
      renderPerformancePanel();

      const button = findButtonByChannelId(channelId);
      if (button) {
        const config = statusConfig['stopped'];
        button.setAttribute('data-status', 'stopped');
        button.setAttribute('title', config.title);
        button.innerHTML = `<i data-feather="${config.icon}"></i>`;
        feather.replace();
        button.disabled = false;
        showSnackMessage(`Processo parado para o canal ${channelId}.`, 'info');
      }

      // Atualizar o objeto 'processes'
      processes[channelId] = { channelId, status: 'stopped' };
    });

    socket.on('process-error', ({ channelId, errorType }) => {
      // console.log('process-error');
      updateStatusMarquee(`Erro: ${errorType}`, 'red', 'white');
      updateStatusCircle(channelId, 'error');
      updatePlateTabStatus(channelId, 'error');
      performanceByChannel.delete(channelId);
      renderPerformancePanel();

      const button = findButtonByChannelId(channelId);
      if (button) {
        const config = statusConfig['error'];
        button.setAttribute('data-status', 'error');
        button.setAttribute('title', config.title);
        button.innerHTML = `<i data-feather="${config.icon}"></i>`;
        feather.replace();
        button.disabled = false;
        showSnackMessage(`Erro no processo para o canal ${channelId}: ${errorType}.`, 'error');
      }

      // Atualizar o objeto 'processes'
      processes[channelId] = { channelId, status: 'error', errorType };
      updatePlateTabStatus(channelId, 'error');
    });

    socket.on('performance-report', ({ channelId, data }) => {
      if (!channelId || !data) return;
      performanceByChannel.set(channelId, data);
      renderPerformancePanel();
    });
    
  }
    
  async function loadInitialProcessState() {
    return fetch('/process-status')
      .then(response => {
        if (!response.ok) {
          throw new Error('Network response was not ok');
        }
        return response.json();
      })
      .then(processStatusResponse => {
        const processesData = processStatusResponse.processes || [];
        // console.log('Process Status Response:', processesData);

        // Atualizar o objeto global 'processes'
        processesData.forEach(process => {
          processes[process.channelId] = process;
          // console.log(`Processo para ${process.channelId}: ${process.status}`);
        });

        const statusMarquee = document.getElementById('status-marquee');

        // Determinar o estado geral
        let overallStatus = 'stopped';
        let statusColor = 'red';
        let statusText = 'Processo parado';
        let textColor = 'white';

        for (const process of processesData) {
          const status = process.status;
          // console.log(`Verificando status do processo para ${process.channelId}: ${status}`);
          if (status === 'running') {
            overallStatus = 'running';
            statusColor = 'green';
            statusText = 'Processo em execução';
            textColor = 'white';
            break;
          } else if (status === 'starting') {
            overallStatus = 'starting';
            statusColor = 'yellow';
            statusText = 'Conectando...';
            textColor = 'black';
          } else if (status === 'reconnecting') {
            overallStatus = 'reconnecting';
            statusColor = 'orange';
            statusText = 'Reconectando...';
            textColor = 'black';
          } else if (status === 'error') {
            overallStatus = 'error';
            statusColor = 'red';
            statusText = 'Erro no processo';
            textColor = 'white';
          }
        }

        // Atualizar o letreiro de status
        if (statusMarquee) {
          statusMarquee.textContent = statusText;
          statusMarquee.style.color = textColor;
          statusMarquee.style.backgroundColor = statusColor;
          // console.log(`Letreiro de status atualizado para: ${statusText}`);
        }

        // Atualizar os círculos de status na tabela de configurações
        processesData.forEach(process => {
          updateStatusCircle(process.channelId, process.status);
          updatePlateTabStatus(process.channelId, process.status);
          // console.log(`Círculo de status atualizado para ${process.channelId}: ${process.status}`);
        });
      })
      .catch(error => {
        console.error('Erro ao carregar o estado inicial do processo:', error);
      });
  }
  
  // Função para atualizar o letreiro de status
  function updateStatusMarquee(text, backgroundColor, textColor) {
    const statusMarquee = document.getElementById('status-marquee');
    if (statusMarquee) {
      statusMarquee.textContent = text;
      statusMarquee.style.backgroundColor = backgroundColor;
      statusMarquee.style.color = textColor;
    }
  }
  
  // Função para atualizar o círculo de status por channelId
  function updateStatusCircle(channelId, status) {
    const rows = document.querySelectorAll('#main-content table tbody tr');
    for (const row of rows) {
      const dataId = row.getAttribute('data-id');
      if (dataId === channelId) {
        const statusCell = row.querySelector('.status-cell');
        const statusCircle = statusCell.querySelector('.status-circle');
        if (statusCircle) {
          statusCircle.classList.remove('green', 'red', 'yellow', 'orange');
          switch (status) {
            case 'running':
              statusCircle.classList.add('green');
              break;
            case 'starting':
              statusCircle.classList.add('yellow');
              break;
            case 'reconnecting':
              statusCircle.classList.add('orange');
              break;
            case 'error':
            case 'stopped':
            default:
              statusCircle.classList.add('red');
              break;
          }
        }
        break;
      }
    }
  }
  
  // Função para encontrar o botão pelo channelId
  function findButtonByChannelId(channelId) {
    const rows = document.querySelectorAll('#main-content table tbody tr');
    for (const row of rows) {
      const dataId = row.getAttribute('data-id');
      if (dataId === channelId) {
        const iconButton = row.querySelector('.start-stop-icon');
        return iconButton;
      }
    }
    return null;
  }
  
  // Função para carregar o Mosaico
  function loadMosaic() {
    const mainContent = document.getElementById('main-content');
    document.getElementById('page-title').innerText = 'Mosaico';
    clearMosaicFrameCache();
    clearMosaicVideoConfigCache();
  
    // Limpar conteúdo anterior
    mainContent.innerHTML = '';
  
    // Criar controles para selecionar o tipo de mosaico
    const controlsHTML = `
      <div class="controls">
        <label for="mosaic-type">Tipo de Mosaico:</label>
        <select id="mosaic-type">
          <option value="1">1</option>
          <option value="2x2" selected>2x2</option>
          <option value="3x3">3x3</option>
          <option value="4x4">4x4</option>
        </select>
      </div>
    `;
  
    mainContent.insertAdjacentHTML('beforeend', controlsHTML);
  
    // Contêiner do mosaico
    const mosaicContainer = document.createElement('div');
    mosaicContainer.id = 'mosaic-container';
    mosaicContainer.className = 'mosaic-container';
    mainContent.appendChild(mosaicContainer);
  
    // Carregar os canais ativos e configurar o mosaico
    fetch('/api/active-channels')
      .then(response => response.json())
      .then(activeChannels => {
        setupMosaic(activeChannels);
        setupMosaicSocket();
      })
      .catch(error => {
        console.error('Erro ao obter canais ativos:', error);
      });
  }
  
  // Função para configurar o mosaico
  function setupMosaic(activeChannels) {
    const mosaicContainer = document.getElementById('mosaic-container');
    const mosaicTypeSelect = document.getElementById('mosaic-type');

    function renderMosaic() {
        const mosaicType = mosaicTypeSelect.value;
        let columns = 1;
        if (mosaicType === '1') {
            columns = 1;
        } else if (mosaicType === '2x2') {
            columns = 2;
        } else if (mosaicType === '3x3') {
            columns = 3;
        } else if (mosaicType === '4x4') {
            columns = 4;
        }

        // Ajustar estilos dos itens do mosaico
        const mosaicItems = document.querySelectorAll('.mosaic-item');
        mosaicItems.forEach(item => {
            item.style.flex = `1 1 calc(${100 / columns}% - 10px)`;
            item.style.minWidth = `calc(${100 / columns}% - 10px)`;
            item.style.maxWidth = `calc(${100 / columns}% - 10px)`;
        });
    }

    mosaicTypeSelect.addEventListener('change', renderMosaic);

    // Limpar o mosaico
    mosaicContainer.innerHTML = '';

    // Adicionar vídeos ao mosaico
    activeChannels.forEach(channel => {
        const mosaicItem = document.createElement('div');
        mosaicItem.id = `mosaic-item-${channel._id}`;
        mosaicItem.classList.add('mosaic-item');

        const mosaicCanvas = document.createElement('canvas');
        mosaicCanvas.id = `mosaic-canvas-${channel._id}`;
        mosaicCanvas.width = 640;
        mosaicCanvas.height = 360;
        mosaicCanvas.style.display = 'none';
        mosaicItem.appendChild(mosaicCanvas);

        const mosaicImage = document.createElement('img');
        mosaicImage.id = `mosaic-image-${channel._id}`;
        mosaicImage.width = 320;
        mosaicImage.height = 180;
        mosaicImage.style.display = 'none';

        mosaicItem.appendChild(mosaicImage);

        const label = document.createElement('div');
        label.classList.add('channel-label');
        label.textContent = channel.name;

        mosaicItem.appendChild(label);

        mosaicContainer.appendChild(mosaicItem);
        initMosaicChannelDelivery(channel);

    });

    renderMosaic();
  }
  
  // Função para configurar o Socket.IO para o mosaico
  function setupMosaicSocket() {
    socket.off('process-starting');
    socket.off('process-reconnecting');
    socket.off('process-started');
    socket.off('process-stopped');
    socket.off('process-error');
    socket.off('frame');

    // Escutar eventos de status dos processos
    socket.on('process-starting', ({ channelId }) => {
        updateMosaicChannelStatus(channelId, 'starting');
    });

    socket.on('process-reconnecting', ({ channelId }) => {
        updateMosaicChannelStatus(channelId, 'reconnecting');
    });

    socket.on('process-started', ({ channelId }) => {
        updateMosaicChannelStatus(channelId, 'running');
    });

    socket.on('process-stopped', ({ channelId }) => {
        updateMosaicChannelStatus(channelId, 'stopped');
    });

    socket.on('process-error', ({ channelId, errorType }) => {
        updateMosaicChannelStatus(channelId, 'error', errorType);
    });

    socket.on('frame', (data) => {
      const { channelId, image } = data;
      if (!mosaicSocketChannels.has(channelId)) return;
      const imgEl = document.getElementById(`mosaic-image-${channelId}`);
      if (!imgEl) return;
      imgEl.style.display = 'block';

      const now = performance.now();
      const minIntervalMs = 1000 / MOSAIC_MAX_RENDER_FPS;
      const lastRender = mosaicLastRenderAt.get(channelId) || 0;
      if (now - lastRender < minIntervalMs) {
        return;
      }
      mosaicLastRenderAt.set(channelId, now);

      const blob = new Blob([image], { type: 'image/jpeg' });
      const imgUrl = URL.createObjectURL(blob);
      const previousUrl = mosaicLastBlobUrl.get(channelId);

      imgEl.src = imgUrl;
      mosaicLastBlobUrl.set(channelId, imgUrl);

      if (previousUrl) {
        try {
          URL.revokeObjectURL(previousUrl);
        } catch (_) {
          // no-op
        }
      }
    });
}

function updateMosaicChannelStatus(channelId, status, errorType = '') {
    // Atualizar indicadores visuais no mosaico
    const tile = getMosaicTile(channelId);
    if (!tile) return;
    const labelElement = tile.querySelector('.channel-label');

    if (labelElement) {
        labelElement.textContent = `${labelElement.textContent.split(' - ')[0]} - ${getStatusText(status, errorType)}`;
        labelElement.style.color = getStatusColor(status);
    }

    // Opcional: pausar ou destacar o player se necessário
}

function getStatusText(status, errorType) {
    switch (status) {
        case 'starting':
            return 'Iniciando...';
        case 'running':
            return 'Em execução';
        case 'reconnecting':
            return 'Reconectando...';
        case 'stopped':
            return 'Parado';
        case 'error':
            return `Erro: ${errorType}`;
        default:
            return '';
    }
}

function getStatusColor(status) {
    switch (status) {
        case 'starting':
            return 'yellow';
        case 'running':
            return 'green';
        case 'reconnecting':
            return 'orange';
        case 'stopped':
            return 'red';
        case 'error':
            return 'red';
        default:
            return 'black';
    }
}
  
  // Função para carregar as Configurações
  function loadSettings() {
    const mainContent = document.getElementById('main-content');
    document.getElementById('page-title').innerText = 'Configurações';
    clearMosaicFrameCache();
    setupDashboardSocket();
  
    // Limpar conteúdo anterior
    mainContent.innerHTML = '';
  
    // Criar um contêiner para o cabeçalho, incluindo o título e o painel de desempenho
    const headerContainer = document.createElement('div');
    headerContainer.classList.add('config-header'); // Classe para estilização
  
    const titleElement = document.createElement('h2');
    titleElement.textContent = 'Configurações';
    titleElement.id = 'page-title';
  
    // Criar o painel de desempenho
    const performancePanel = document.createElement('div');
    performancePanel.id = 'performance-panel';
    performancePanel.innerHTML = `
      <div class="perf-item">FPS: <span class="perf-fps">--</span></div>
      <div class="perf-item">CPU: <span class="perf-cpu">--</span>%</div>
      <div class="perf-item">RAM: <span class="perf-ram">--</span>%</div>
      <div class="perf-item">GPU: <span class="perf-gpu">--</span>%</div>
      <div class="perf-item">VRAM: <span class="perf-vram">--</span>%</div>
    `;
  
    headerContainer.appendChild(titleElement);
    headerContainer.appendChild(performancePanel);
    mainContent.appendChild(headerContainer);
  
    // Criar o contêiner para a tabela de configurações
    const settingsContainer = document.createElement('div');
    settingsContainer.id = 'settings-container';
    mainContent.appendChild(settingsContainer);
  
    // Criar botão para adicionar novo canal
    const addButton = document.createElement('button');
    addButton.id = 'add-channel-button';
    addButton.classList.add('floating-add-button'); // Adicionando classe comum
    addButton.innerHTML = `<i data-feather="plus"></i>`;
    addButton.addEventListener('click', openAddChannelModal);
    settingsContainer.appendChild(addButton);
  
    // Criar contêiner para a tabela de configurações
    const tableContainer = document.createElement('div');
    tableContainer.id = 'settings-table-container';
    settingsContainer.appendChild(tableContainer);
  
    // Carregar o estado inicial do processo e, em seguida, carregar os canais
    loadInitialProcessState().then(() => {
      // Buscar canais após atualizar os processos
      fetch('/api/channels')
        .then(response => response.json())
        .then(async (channels) => {
          try {
            await refreshGatewayStatus();
            const enrichedChannels = await enrichChannelsWithVideoMode(channels);
            renderSettingsTable(enrichedChannels);
            startSettingsVideoModePolling();
          } catch (error) {
            console.warn('Falha ao resolver modo de vídeo dos canais. Exibindo tabela sem enriquecimento.', error);
            renderSettingsTable(channels);
            startSettingsVideoModePolling();
          }
        })
        .catch(error => {
          console.error('Erro ao carregar canais:', error);
        });
    });
  }
  
  // Função para renderizar a tabela de configurações com ícones estilizados
  function renderSettingsTable(channels) {
    const tableContainer = document.getElementById('settings-table-container');
  
    let tableHTML = `
      <table class="styled-table" id="channels-table">
        <thead>
          <tr>
            <th>Nome</th>
            <th>Tipo</th>
            <th>IP</th>
            <th>Canal</th>
            <th>FPS</th>
            <th>Vídeo</th>
            <th>MG3000</th>
            <th>Portão</th>
            <th>Status</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
    `;
  
    channels.forEach(channel => {
      const process = processes[channel._id];
      const status = process && process.status ? process.status : 'stopped';
      const config = statusConfig[status] || statusConfig['stopped'];
      const tipoTexto =
        channel.channel_type === 'plate' ? 'Placa' :
        channel.channel_type === 'speed' ? 'Radar' :
        channel.channel_type === 'ia'    ? 'IA' :
        '-';

      tableHTML += `
        <tr data-id="${channel._id}">
          <td>${channel.name}</td>
          <td>${tipoTexto}</td>
          <td>${channel.cameraIp}</td>
          <td>${channel.dvrChannel}</td>
          <td>${channel.fps}</td>
	          <td>
	            <span class="video-mode-pill ${channel.__videoModeClass || 'video-mode-unknown'}">
	              ${channel.__videoModeLabel || 'Desconhecido'}
	            </span>
	          </td>
          <td><span class="controller-status-pill controller-offline" data-channel-id="${channel._id}">Offline</span></td>
          <td><span class="gate-status-pill gate-unknown" data-channel-id="${channel._id}">Desconhecido</span></td>
	          <td class="status-cell"><span class="status-circle ${config.color}"></span></td>
          <td>
            <span class="icon-button edit-icon" title="Editar Canal" aria-label="Editar Canal" role="button" tabindex="0">
              <i data-feather="edit"></i>
            </span>
            <span class="icon-button delete-icon" title="Excluir Canal" aria-label="Excluir Canal" role="button" tabindex="0">
              <i data-feather="trash-2"></i>
            </span>
            <span class="icon-button start-stop-icon" data-status="${status}" title="${config.title}" aria-label="Iniciar ou Parar Processo" role="button" tabindex="0">
              <i data-feather="${config.icon}"></i>
            </span>
            <span class="icon-button actions-icon" title="Gerenciar Ações" aria-label="Gerenciar Ações" role="button" tabindex="0">
              <i data-feather="sliders"></i>
            </span>
            <span class="icon-button video-icon" title="Visualizar Vídeo" aria-label="Visualizar Vídeo" role="button" tabindex="0">
              <i data-feather="video"></i>
            </span>
          </td>
        </tr>
      `;
    });
  
    tableHTML += `
        </tbody>
      </table>
    `;
  
    tableContainer.innerHTML = tableHTML;
  
    // Event listeners para ícones
    document.querySelectorAll('.edit-icon').forEach(icon => {
      icon.addEventListener('click', handleEditChannel);
      addKeyboardListeners(icon, handleEditChannel);
    });
    document.querySelectorAll('.delete-icon').forEach(icon => {
      icon.addEventListener('click', handleDeleteChannel);
      addKeyboardListeners(icon, handleDeleteChannel);
    });
    document.querySelectorAll('.start-stop-icon').forEach(icon => {
      icon.addEventListener('click', handleStartStopProcess);
      addKeyboardListeners(icon, handleStartStopProcess);
    });
    document.querySelectorAll('.actions-icon').forEach(icon => {
      icon.addEventListener('click', handleChannelActions);
      addKeyboardListeners(icon, handleChannelActions);
    });
    document.querySelectorAll('.video-icon').forEach(icon => {
      icon.addEventListener('click', handleVideoView);
      addKeyboardListeners(icon, handleVideoView);
    });
  
	    feather.replace();
    updateGateStatusRows();
    setupGatewayStatusSocket();
	  }

  async function loadInterlocks() {
    const mainContent = document.getElementById('main-content');
    document.getElementById('page-title').innerText = 'Intertravamentos';
    clearMosaicFrameCache();
    mainContent.innerHTML = '<div class="loading-state">Carregando...</div>';

    try {
      await refreshGatewayStatus();
      const [channels, interlocksPayload] = await Promise.all([
        fetchJson('/api/channels'),
        fetchJson('/api/interlocks'),
      ]);
      interlocksCache = Array.isArray(interlocksPayload.interlocks) ? interlocksPayload.interlocks : [];
      interlockSettingsCache = normalizeInterlockSettings(interlocksPayload.settings || {});
      const safeChannels = Array.isArray(channels) ? channels : [];
      const doors = Array.isArray(interlocksPayload.doors) && interlocksPayload.doors.length
        ? interlocksPayload.doors
        : buildInterlockDoors(safeChannels);
      renderInterlocksScreen(safeChannels, doors);
      setupGatewayStatusSocket();
      feather.replace();
    } catch (error) {
      console.error('Erro ao carregar intertravamentos:', error);
      mainContent.innerHTML = '<div class="empty-state">Erro ao carregar intertravamentos.</div>';
    }
  }

  function renderInterlocksScreen(channels, doors = buildInterlockDoors(channels)) {
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
      <div class="interlocks-layout">
        <section class="interlock-section">
          <div class="interlock-header-row">
            <h2>Configuração global</h2>
          </div>
          <form id="interlock-settings-form" class="interlock-form">
            <label>
              Cooldown após abertura (ms)
              <input type="number" id="interlock-cooldown-ms" value="${escapeHtml(String(interlockSettingsCache.gateCommandCooldownMs || 15000))}" min="1000" max="600000" step="1000">
            </label>
            <div class="interlock-actions-row">
              <button type="submit" class="primary-button">Salvar configuração</button>
            </div>
          </form>
        </section>
        <section class="interlock-section">
          <div class="interlock-header-row">
            <h2>Intertravamentos</h2>
            <button type="button" id="clear-interlock-form" class="secondary-button">Limpar</button>
          </div>
          <form id="interlock-form" class="interlock-form">
            <input type="hidden" id="interlock-id">
            <label>
              Nome
              <input type="text" id="interlock-name" placeholder="Ex: Entrada x Saída" required>
            </label>
            <div class="interlock-options-row">
              <label><input type="checkbox" id="interlock-enabled" checked> Ativo</label>
              <label><input type="checkbox" id="interlock-block-unknown" checked> Bloquear sem status</label>
              <label>
                Validade status (ms)
                <input type="number" id="interlock-stale-ms" value="15000" min="1000" step="1000">
              </label>
            </div>
            <div class="interlock-channel-list">
              ${renderInterlockDoorList(doors)}
            </div>
            <div class="interlock-actions-row">
              <button type="submit" class="primary-button">Salvar</button>
            </div>
          </form>
        </section>
        <section class="interlock-section">
          <h3>Status das portas</h3>
          <div id="interlock-runtime-status" class="interlock-status-grid">
            ${renderInterlockRuntimeStatus(doors)}
          </div>
        </section>
        <section class="interlock-section">
          <h3>Regras salvas</h3>
          <div id="interlock-table-wrap">
            ${renderInterlockTable(channels, doors)}
          </div>
        </section>
      </div>
    `;

    document.getElementById('interlock-settings-form').addEventListener('submit', (event) => {
      event.preventDefault();
      saveInterlockSettings();
    });
    document.getElementById('interlock-form').addEventListener('submit', (event) => {
      event.preventDefault();
      saveInterlockFromForm(channels, doors);
    });
    document.getElementById('clear-interlock-form').addEventListener('click', clearInterlockForm);
    document.querySelectorAll('.interlock-edit').forEach((button) => {
      button.addEventListener('click', () => handleEditInterlock(button.dataset.id, channels));
    });
    document.querySelectorAll('.interlock-delete').forEach((button) => {
      button.addEventListener('click', () => handleDeleteInterlock(button.dataset.id, channels, doors));
    });
    updateInterlockRuntimeStatus();
  }

  function renderInterlockDoorList(doors) {
    if (!doors.length) return '<div class="empty-state">Nenhuma porta configurada.</div>';
    return doors.map((door) => `
      <label class="interlock-channel-option">
        <input type="checkbox" name="interlock-door" value="${escapeHtml(door.key)}">
        <span>
          <strong>${escapeHtml(door.name || door.key)}</strong>
          <small>${(door.channels || []).map((channel) => escapeHtml(channel.name || channel.channelId)).join(', ')}</small>
        </span>
      </label>
    `).join('');
  }

  function getDoorRuntimeState(door = {}) {
    const channelIds = Array.isArray(door.channelIds)
      ? door.channelIds
      : (door.channels || []).map((channel) => channel.channelId).filter(Boolean);
    const states = channelIds.map((channelId) => gateStatusByChannel[channelId] || {});
    const cooldownState = states.find((state) => state.cooldownActive === true);
    if (cooldownState) return cooldownState;
    return states.find((state) => ['open', 'opening'].includes(String(state.gateStatus || '').toLowerCase()))
      || states.find((state) => !state.gateStatus || String(state.gateStatus).toLowerCase() === 'unknown')
      || states[0]
      || {};
  }

  function renderInterlockRuntimeStatus(doors) {
    if (!doors.length) return '<div class="empty-state">Nenhuma porta configurada.</div>';
    return doors.map((door) => {
      const state = getDoorRuntimeState(door);
      const gateMeta = gateStatusMeta(state.gateStatus);
      const controllerMeta = controllerStatusMeta(state.controllerOnline === true);
      const cooldownMeta = cooldownStatusMeta(state);
      return `
        <div class="interlock-status-item" data-door-key="${escapeHtml(door.key)}" data-channel-ids="${escapeHtml((door.channelIds || []).join(','))}">
          <strong>${escapeHtml(door.name || door.key)}</strong>
          <small>${(door.channels || []).map((channel) => escapeHtml(channel.name || channel.channelId)).join(', ')}</small>
          <span class="controller-status-pill ${controllerMeta.className}">${controllerMeta.label}</span>
          <span class="gate-status-pill ${gateMeta.className}">${gateMeta.label}</span>
          <span class="cooldown-status-pill ${cooldownMeta.className}">${cooldownMeta.label}</span>
        </div>
      `;
    }).join('');
  }

  function renderInterlockTable(channels, doors = buildInterlockDoors(channels)) {
    const doorNameByKey = new Map(doors.map((door) => [String(door.key), door.name || door.key]));
    if (!interlocksCache.length) return '<div class="empty-state">Nenhum intertravamento criado.</div>';
    return `
      <table class="styled-table">
        <thead>
          <tr>
            <th>Nome</th>
            <th>Portas</th>
            <th>Ativo</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          ${interlocksCache.map((interlock) => `
            <tr>
              <td>${escapeHtml(interlock.name)}</td>
              <td>${getInterlockDoorKeys(interlock, channels).map((key) => escapeHtml(doorNameByKey.get(String(key)) || key)).join(', ')}</td>
              <td>${interlock.enabled === false ? 'Não' : 'Sim'}</td>
              <td>
                <button type="button" class="icon-button interlock-edit" data-id="${escapeHtml(interlock._id)}" title="Editar">
                  <i data-feather="edit"></i>
                </button>
                <button type="button" class="icon-button interlock-delete" data-id="${escapeHtml(interlock._id)}" title="Excluir">
                  <i data-feather="trash-2"></i>
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function updateInterlockRuntimeStatus() {
    document.querySelectorAll('.interlock-status-item[data-door-key]').forEach((item) => {
      const channelIds = String(item.getAttribute('data-channel-ids') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const state = getDoorRuntimeState({ channelIds });
      const controller = item.querySelector('.controller-status-pill');
      const gate = item.querySelector('.gate-status-pill');
      const cooldown = item.querySelector('.cooldown-status-pill');
      if (controller) {
        const meta = controllerStatusMeta(state.controllerOnline === true);
        controller.className = `controller-status-pill ${meta.className}`;
        controller.textContent = meta.label;
      }
      if (gate) {
        const meta = gateStatusMeta(state.gateStatus);
        gate.className = `gate-status-pill ${meta.className}`;
        gate.textContent = meta.label;
      }
      if (cooldown) {
        const meta = cooldownStatusMeta(state);
        cooldown.className = `cooldown-status-pill ${meta.className}`;
        cooldown.textContent = meta.label;
        cooldown.title = state.cooldownExpiresAt ? `Expira em ${state.cooldownExpiresAt}` : '';
      }
    });
  }

  function clearInterlockForm() {
    document.getElementById('interlock-id').value = '';
    document.getElementById('interlock-name').value = '';
    document.getElementById('interlock-enabled').checked = true;
    document.getElementById('interlock-block-unknown').checked = true;
    document.getElementById('interlock-stale-ms').value = '15000';
    document.querySelectorAll('input[name="interlock-door"]').forEach((input) => {
      input.checked = false;
    });
  }

  function handleEditInterlock(interlockId, channels = []) {
    const interlock = interlocksCache.find((item) => String(item._id) === String(interlockId));
    if (!interlock) return;
    document.getElementById('interlock-id').value = interlock._id;
    document.getElementById('interlock-name').value = interlock.name || '';
    document.getElementById('interlock-enabled').checked = interlock.enabled !== false;
    document.getElementById('interlock-block-unknown').checked = interlock.blockUnknown !== false;
    document.getElementById('interlock-stale-ms').value = String(interlock.staleAfterMs || 15000);
    const selected = new Set(getInterlockDoorKeys(interlock, channels).map(String));
    document.querySelectorAll('input[name="interlock-door"]').forEach((input) => {
      input.checked = selected.has(String(input.value));
    });
  }

  async function handleDeleteInterlock(interlockId, channels, doors) {
    if (!confirm('Excluir este intertravamento?')) return;
    try {
      await fetchJson(`/api/interlocks/${encodeURIComponent(interlockId)}`, { method: 'DELETE' });
      const payload = await fetchJson('/api/interlocks');
      interlocksCache = Array.isArray(payload.interlocks) ? payload.interlocks : [];
      renderInterlocksScreen(channels, doors);
      feather.replace();
      showSnackMessage('Intertravamento excluído.', 'info');
    } catch (error) {
      showSnackMessage(error?.message || 'Erro ao excluir intertravamento.', 'error');
    }
  }

  async function saveInterlockSettings() {
    const payload = {
      gateCommandCooldownMs: Number(document.getElementById('interlock-cooldown-ms').value || 15000),
    };

    try {
      const response = await fetchJson('/api/interlocks/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      interlockSettingsCache = normalizeInterlockSettings(response.settings || payload);
      document.getElementById('interlock-cooldown-ms').value = String(interlockSettingsCache.gateCommandCooldownMs);
      showSnackMessage('Configuração salva.', 'info');
    } catch (error) {
      showSnackMessage(error?.message || 'Erro ao salvar configuração.', 'error');
    }
  }

  async function saveInterlockFromForm(channels, doors = buildInterlockDoors(channels)) {
    const selected = Array.from(document.querySelectorAll('input[name="interlock-door"]:checked'))
      .map((input) => input.value);
    if (selected.length < 2) {
      showSnackMessage('Selecione pelo menos 2 portas.', 'error');
      return;
    }

    const doorByKey = new Map(doors.map((door) => [String(door.key), door]));
    const selectedChannelIds = Array.from(new Set(selected.flatMap((doorKey) => (
      doorByKey.get(String(doorKey))?.channelIds || []
    ))));

    const payload = {
      _id: document.getElementById('interlock-id').value || undefined,
      name: document.getElementById('interlock-name').value,
      enabled: document.getElementById('interlock-enabled').checked,
      blockUnknown: document.getElementById('interlock-block-unknown').checked,
      staleAfterMs: Number(document.getElementById('interlock-stale-ms').value || 15000),
      doorKeys: selected,
      channelIds: selectedChannelIds,
    };

    try {
      await fetchJson('/api/interlocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const interlocksPayload = await fetchJson('/api/interlocks');
      interlocksCache = Array.isArray(interlocksPayload.interlocks) ? interlocksPayload.interlocks : [];
      const nextDoors = Array.isArray(interlocksPayload.doors) && interlocksPayload.doors.length
        ? interlocksPayload.doors
        : doors;
      renderInterlocksScreen(channels, nextDoors);
      feather.replace();
      showSnackMessage('Intertravamento salvo.', 'info');
    } catch (error) {
      showSnackMessage(error?.message || 'Erro ao salvar intertravamento.', 'error');
    }
  }
	  // Função para mostrar o formulário de adicionar canal
	  function showAddChannelForm() {
    const mainContent = document.getElementById('main-content');
  
    mainContent.innerHTML = `
      <h3>Adicionar Canal</h3>
      <form id="add-channel-form">
        <label for="name">Nome do Canal:</label>
        <input type="text" name="name" required><br>
        <label for="cameraIp">IP da Câmera:</label>
        <input type="text" name="cameraIp" required><br>
        <label for="username">Username:</label>
        <input type="text" name="username" required><br>
        <label for="password">Password:</label>
        <input type="password" name="password" required><br>
        <label for="fps">FPS:</label>
        <input type="number" name="fps" value="5" required><br>
        <label for="dvrChannel">Canal DVR:</label>
        <input type="number" name="dvrChannel" value="1" required><br>
        <button type="submit">Salvar</button>
        <button type="button" id="cancel-add-channel">Cancelar</button>
      </form>
    `;
  
    document.getElementById('add-channel-form').addEventListener('submit', handleAddChannel);
    document.getElementById('cancel-add-channel').addEventListener('click', loadSettings);
  }
  
  // Função para lidar com a adição de novo canal
  function handleAddChannel(event) {
    event.preventDefault();
  
    const form = event.target;
    const formData = new FormData(event.target);
    const channelData = Object.fromEntries(formData.entries());
  
    // Pega a área selecionada e salva areaId + areaLabel no canal
    const areaSelect = form.querySelector('#addChannelArea');
    if (areaSelect) {
      channelData.areaId = areaSelect.value || '';
      channelData.areaLabel =
        areaSelect.options[areaSelect.selectedIndex]?.text || '';
    }

    fetch('/api/channels', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(channelData)
    })
      .then(response => response.json())
      .then(data => {
        // console.log('Canal adicionado:', data);
        loadSettings();
      })
      .catch(error => {
        console.error('Erro ao adicionar canal:', error);
      });
  }
  
  // Função para lidar com a atualização de um canal
  function handleUpdateChannel(event) {
    event.preventDefault();
  
    const formData = new FormData(event.target);
    const channelData = Object.fromEntries(formData.entries());
  
    fetch('/api/channels', {
      method: 'POST', // Presumindo que POST é usado para criar e atualizar
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(channelData)
    })
      .then(response => response.json())
      .then(data => {
        // console.log('Canal atualizado:', data);
        loadSettings();
      })
      .catch(error => {
        console.error('Erro ao atualizar canal:', error);
      });
  }
  
  // Função para lidar com a exclusão de um canal
  function handleDeleteChannel(event) {
    const channelId = event.target.closest('tr').dataset.id;
    if (confirm('Deseja realmente excluir este canal?')) {
      fetch(`/api/channels/${channelId}`, {
        method: 'DELETE',
      })
        .then(response => response.json())
        .then(data => {
          // console.log('Canal excluído:', data);
          loadSettings();
        })
        .catch(error => {
          console.error('Erro ao excluir canal:', error);
        });
    }
  }
  
  // Função para lidar com o início ou parada de um processo
function handleStartStopProcess(event) {
  const icon = event.currentTarget;
  const row = icon.closest('tr');
  const channelId = row.getAttribute('data-id');
  const status = icon.getAttribute('data-status');

  // Verificar estados intermediários
  if (status === 'starting' || status === 'reconnecting') {
    // Ignorar cliques durante estados intermediários
    return;
  }

  // Alterar o ícone para o estado de carregamento
  icon.setAttribute('data-status', 'starting');
  icon.setAttribute('title', 'Iniciando...');
  icon.innerHTML = `<i data-feather="loader"></i>`;
  feather.replace();

  // Desabilitar o ícone para prevenir múltiplos cliques (opcional)
  icon.style.pointerEvents = 'none';

  fetch(`/api/channels/${channelId}`)
    .then(response => response.json())
    .then(channel => {
      if (!channel) {
        throw new Error('Canal não encontrado.');
      }

      if (status === 'stopped' || status === 'error') {
        // Iniciar o processo
        fetch(`/start-process/${channelId}`, {
          method: 'POST',
        })
          .then(response => response.json())
          .then(result => {
            if (result.success) {
              // console.log(`Processo iniciado para o canal ${channelId}`);
              // Aguardaremos o evento 'process-started' para atualizar a UI
            } else {
              throw new Error(result.message || 'Erro ao iniciar o processo.');
            }
          })
          .catch(error => {
            console.error(error);
            showSnackMessage('Não foi possível iniciar o processo.', 'error');
            resetStartIcon(icon, 'stopped');
            updateStatusCircle(channelId, 'stopped');
          });
      } else if (status === 'running') {
        // Parar o processo
        fetch(`/stop-process/${channelId}`, {
          method: 'POST',
        })
          .then(response => response.json())
          .then(result => {
            if (result.success) {
              resetStartIcon(icon, 'stopped');
              updateStatusCircle(channelId, 'stopped');
              updatePlateTabStatus(channelId, 'stopped');
              processes[channelId] = { channelId, status: 'stopped' };
              performanceByChannel.delete(channelId);
              renderPerformancePanel();
              showSnackMessage(`Processo parado para o canal ${channelId}.`, 'info');
            } else {
              throw new Error(result.message || 'Erro ao parar o processo.');
            }
          })
          .catch(error => {
            console.error(error);
            showSnackMessage('Não foi possível parar o processo.', 'error');
            resetStartIcon(icon, 'running');
            updateStatusCircle(channelId, 'running');
          });
      }
    })
    .catch(error => {
      console.error('Erro ao buscar canal:', error);
      showSnackMessage('Erro ao buscar canal.', 'error');
      resetStartIcon(icon, 'stopped');
      updateStatusCircle(channelId, 'stopped');
    });
}

// Função para resetar o ícone de iniciar/parar
function resetStartIcon(icon, status) {
  const config = statusConfig[status];
  icon.setAttribute('data-status', status);
  icon.setAttribute('title', config.title);
  icon.innerHTML = `<i data-feather="${config.icon}"></i>`;
  feather.replace();
  icon.style.pointerEvents = 'auto';
}
  
  // Função para formatar timestamp
  function formatTimestamp(timestamp) {
    const date = new Date(Number(timestamp));
    return date.toLocaleString('pt-BR');
  }
  
  // Função para exibir mensagens de snack
  function showSnackMessage(message, type = 'info') {
    // Remover mensagem de snack existente, se houver
    const existingSnack = document.querySelector('.snack-message');
    if (existingSnack) {
      existingSnack.remove();
    }
  
    // Criar mensagem de snack
    const snack = document.createElement('div');
    snack.className = `snack-message ${type}`;
    snack.textContent = message;
  
    document.body.appendChild(snack);
  
    // Remover após 3 segundos
    setTimeout(() => {
      snack.remove();
    }, 3000);
  }

  // Função para lidar com a configuração de ações do canal
function handleChannelActions(event) {
  const channelId = event.target.closest('tr').dataset.id;

  // Chamar a função para carregar as ações do canal
  loadChannelActions(channelId);
}
  
  // Função para carregar as ações do canal
function loadChannelActions(channelId) {
    fetch(`/api/channels/${channelId}`)
      .then(response => response.json())
      .then(channel => {
        if (channel.channel_type === 'speed') {
          // NÃO abre snapshot, só o modal de radar
          openRadarConfigModal(channel);

        } else {

          const mainContent = document.getElementById('main-content');
          document.getElementById('page-title').innerText = `Ações - ${channel.name}`;
    
          // Limpar o conteúdo anterior
          mainContent.innerHTML = '';
    
          // Criar o contêiner principal
          const container = document.createElement('div');
          container.id = 'channel-actions-container';
    
          // Adicionar elementos necessários
          container.innerHTML = `
            <div id="image-container" style="position: relative;">
              <img id="captured-image" src="" alt="Imagem Capturada">
              <canvas id="canvas"></canvas>
            </div>
            <table class="styled-table" id="channels-table">
              <thead>
                <tr>
                  <th>Nome da Ação</th>
                  <th>Tipo de Área</th>
                  <th>Detalhes</th>
                  <th>Categorias</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody id="actionsTbody">
                <!-- Linhas serão adicionadas dinamicamente -->
              </tbody>
            </table>
            <!-- Modais -->
            <div id="actionModal" class="modal">
              <div class="modal-content">
                <span id="closeActionModal" class="close">&times;</span>
                <h2 id="modalTitle"></h2>
                <div id="modalBody"></div>
                <div id="categoriesContainer"></div>
                <div id="lineButtons" style="display: none;">
                  <button id="createLineButton">Criar Linha</button>
                  <button id="createDirectionButton">Criar Direção</button>
                </div>
                <div id="areaButtons" style="display: none;">
                  <button id="createAreaButton">Criar Área</button>
                </div>
                <button id="saveActionButton">Salvar Ação</button>
              </div>
            </div>
            <!-- Outros modais podem ser adicionados aqui -->
          `;
    
          mainContent.appendChild(container);

          // Carregar o script das ações do canal
          loadChannelActionsScript(channelId, channel);
        }
      })
      .catch(error => {
        console.error('Erro ao carregar canal:', error);
      });
  }
  
  // Função para carregar o script das ações do canal
  function loadChannelActionsScript(channelId) {
    // Variáveis e referências aos elementos
    let channel = null;
    let actions = [];
    let areas = [];
    let selectedAction = null;
    
    // Referências aos elementos HTML
    const img = document.getElementById('captured-image');
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const actionsTable = document.getElementById('actionsTable');
    const actionsTbody = document.getElementById('actionsTbody');
    // const addActionButton = document.getElementById('addActionButton');
    const actionModal = document.getElementById('actionModal');
    const closeActionModal = document.getElementById('closeActionModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    const saveActionButton = document.getElementById('saveActionButton');
    const areaTypeSelect = document.getElementById('areaTypeSelect');
    const areaTypeContainer = document.getElementById('areaTypeContainer');
    const lineButtons = document.getElementById('lineButtons');
    const areaButtons = document.getElementById('areaButtons');
    const createLineButton = document.getElementById('createLineButton');
    const createDirectionButton = document.getElementById('createDirectionButton');
    const createAreaButton = document.getElementById('createAreaButton');
    const areaDirectionToggle = document.getElementById('areaDirectionToggle');
  
    // Criar o botão flutuante de adicionar ação
    const floatingAddActionButton = document.createElement('button');
    floatingAddActionButton.id = 'floatingAddActionButton';
    floatingAddActionButton.classList.add('floating-add-button');
    floatingAddActionButton.setAttribute('title', 'Adicionar Nova Ação');
    floatingAddActionButton.setAttribute('aria-label', 'Adicionar Nova Ação');
    floatingAddActionButton.setAttribute('role', 'button');
    floatingAddActionButton.setAttribute('tabindex', '0');
    floatingAddActionButton.innerHTML = `<i data-feather="plus"></i>`;
    floatingAddActionButton.addEventListener('click', () => {
      currentAction = null;
      lines = [];
      directions = [];
      areasList = [];
      openActionModal();
    });

    // Adicionar listeners de teclado para acessibilidade
    floatingAddActionButton.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        floatingAddActionButton.click();
      }
    });

    const container = document.getElementById('channel-actions-container');
    
    if (!container) {
        console.error('Contêiner "channel-actions-container" não encontrado no DOM.');
        return;
    }

    // Adicionar o botão flutuante ao contêiner
    container.appendChild(floatingAddActionButton);

    feather.replace();

    // Elementos dos modais
    // Modais de Linha
    const lineNameModal = document.getElementById('lineNameModal');
    const closeLineNameModal = document.getElementById('closeLineNameModal');
    const lineNameInput = document.getElementById('lineNameInput');
    const lineNameConfirmButton = document.getElementById('lineNameConfirmButton');
  
    const drawLineModal = document.getElementById('drawLineModal');
    const closeDrawLineModal = document.getElementById('closeDrawLineModal');
    const startDrawLineButton = document.getElementById('startDrawLineButton');
  
    const confirmLineModal = document.getElementById('confirmLineModal');
    const closeConfirmLineModal = document.getElementById('closeConfirmLineModal');
    const saveLineButton = document.getElementById('saveLineButton');
    const cancelLineButton = document.getElementById('cancelLineButton');
  
    // Modais de Direção
    const directionModal = document.getElementById('directionModal');
    const closeDirectionModal = document.getElementById('closeDirectionModal');
    const directionNameInput = document.getElementById('directionNameInput');
    const lineSelect = document.getElementById('lineSelect');
    const directionNameConfirmButton = document.getElementById('directionNameConfirmButton');
  
    const drawDirectionModal = document.getElementById('drawDirectionModal');
    const closeDrawDirectionModal = document.getElementById('closeDrawDirectionModal');
    const startDrawDirectionButton = document.getElementById('startDrawDirectionButton');
  
    const confirmDirectionModal = document.getElementById('confirmDirectionModal');
    const closeConfirmDirectionModal = document.getElementById('closeConfirmDirectionModal');
    const saveDirectionButton = document.getElementById('saveDirectionButton');
    const cancelDirectionButton = document.getElementById('cancelDirectionButton');
  
    // Modais de Área
    const areaNameModal = document.getElementById('areaNameModal');
    const closeAreaNameModal = document.getElementById('closeAreaNameModal');
    const areaNameInput = document.getElementById('areaNameInput');
    const areaNameConfirmButton = document.getElementById('areaNameConfirmButton');
  
    const drawAreaModal = document.getElementById('drawAreaModal');
    const closeDrawAreaModal = document.getElementById('closeDrawAreaModal');
    const startDrawAreaButton = document.getElementById('startDrawAreaButton');
  
    const confirmAreaModal = document.getElementById('confirmAreaModal');
    const closeConfirmAreaModal = document.getElementById('closeConfirmAreaModal');
    const saveAreaButton = document.getElementById('saveAreaButton');
    const cancelAreaButton = document.getElementById('cancelAreaButton');
  
    let currentAction = null; // Ação atualmente sendo criada ou editada
  
    // Variáveis de desenho
    let mode = null; // null, 'line', 'direction', 'area'
    let points = [];
    let currentLine = null;
    let currentDirection = null;
    let currentArea = null;
    let lines = []; // Linhas da ação atual
    let directions = []; // Direções da ação atual
    let areasList = []; // Áreas da ação atual
  
    // Carregar dados do canal
    loadChannelData();
  
    function loadChannelData() {
      // Carregar dados do canal
      fetch(`/api/channels/${channelId}`)
        .then(response => response.json())
        .then(data => {
          channel = data;
          // Capturar imagem do canal
          captureImage();
          // Carregar ações
          loadActions();
        })
        .catch(error => {
          console.error('Erro ao carregar dados do canal:', error);
        });
    }
  
    function captureImage() {
      // Buscar a imagem capturada para o canal atual
      fetch(`/capture-photo/${channelId}`)
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            const timestamp = new Date().getTime();
            img.src = data.imageUrl + '?t=' + timestamp;
            img.onload = initializeCanvas;
          } else {
            console.error('Falha ao capturar a foto');
          }
        })
        .catch(error => {
          console.error('Erro:', error);
        });
    }
  
    function initializeCanvas() {
      // Ajustar o tamanho do canvas para corresponder ao da imagem
      canvas.width = img.width;
      canvas.height = img.height;
  
      // Posicionar o canvas sobre a imagem
      const container = document.getElementById('image-container');
      container.style.position = 'relative';
      img.style.display = 'block';
      canvas.style.position = 'absolute';
      canvas.style.top = '0px';
      canvas.style.left = '0px';
    }
  
    function loadActions() {
      fetch(`/api/actions/channel/${channelId}`)
        .then(response => response.json())
        .then(data => {
          actions = data;
          renderActions();
        })
        .catch(error => {
          console.error('Erro ao carregar ações:', error);
        });
    }
  
    function renderActions() {
      actionsTbody.innerHTML = '';
  
      actions.forEach(action => {
        const row = createActionRow(action);
        actionsTbody.appendChild(row);
      });

      feather.replace();
    }
  
    function createActionRow(action) {
      const row = document.createElement('tr');
      row.setAttribute('data-id', action._id); // Assegura que cada linha tenha o data-id
    
      const nameCell = document.createElement('td');
      nameCell.setAttribute('data-label', 'Nome da Ação');
      nameCell.textContent = action.name;
    
      const typeCell = document.createElement('td');
      typeCell.setAttribute('data-label', 'Tipo de Área');
      typeCell.textContent = action.areaType === 'area' ? 'Área' : 'Linha';
    
      const detailsCell = document.createElement('td');
      detailsCell.setAttribute('data-label', 'Detalhes');
      detailsCell.textContent = getActionDetails(action);
    
      const categoriesCell = document.createElement('td');
      categoriesCell.setAttribute('data-label', 'Categorias');
      if (action.categories && action.categories.length > 0) {
        // Traduzir cada categoria usando o mapeamento
        const translatedCategories = action.categories.map(cat => categoryLabels[cat] || cat);
        categoriesCell.textContent = translatedCategories.join(', ');
      } else {
        categoriesCell.textContent = 'Nenhuma';
      }
    
      const actionsCell = document.createElement('td');
      actionsCell.setAttribute('data-label', 'Ações');
    
      // Criar botões de ação com ícones
      const selectIconButton = document.createElement('span');
      selectIconButton.classList.add('icon-button', 'select-icon');
      selectIconButton.setAttribute('title', 'Selecionar Ação');
      selectIconButton.setAttribute('aria-label', 'Selecionar Ação');
      selectIconButton.setAttribute('role', 'button');
      selectIconButton.setAttribute('tabindex', '0');
      selectIconButton.innerHTML = `<i data-feather="eye"></i>`;
      selectIconButton.addEventListener('click', (event) => {
        selectAction(action);
      });
      selectIconButton.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectAction(action);
        }
      });
    
      const editIconButton = document.createElement('span');
      editIconButton.classList.add('icon-button', 'edit-icon');
      editIconButton.setAttribute('title', 'Editar Ação');
      editIconButton.setAttribute('aria-label', 'Editar Ação');
      editIconButton.setAttribute('role', 'button');
      editIconButton.setAttribute('tabindex', '0');
      editIconButton.innerHTML = `<i data-feather="edit"></i>`;
      editIconButton.addEventListener('click', (event) => {
        openActionModal(action);
      });
      editIconButton.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openActionModal(action);
        }
      });
    
      const deleteIconButton = document.createElement('span');
      deleteIconButton.classList.add('icon-button', 'delete-icon');
      deleteIconButton.setAttribute('title', 'Excluir Ação');
      deleteIconButton.setAttribute('aria-label', 'Excluir Ação');
      deleteIconButton.setAttribute('role', 'button');
      deleteIconButton.setAttribute('tabindex', '0');
      deleteIconButton.innerHTML = `<i data-feather="trash-2"></i>`;
      deleteIconButton.addEventListener('click', (event) => {
        if (confirm('Deseja realmente excluir esta ação?')) {
          deleteAction(action._id);
        }
      });
      deleteIconButton.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (confirm('Deseja realmente excluir esta ação?')) {
            deleteAction(action._id);
          }
        }
      });
    
      actionsCell.appendChild(selectIconButton);
      actionsCell.appendChild(editIconButton);
      actionsCell.appendChild(deleteIconButton);
    
      row.appendChild(nameCell);
      row.appendChild(typeCell);
      row.appendChild(detailsCell);
      row.appendChild(categoriesCell);
      row.appendChild(actionsCell);
    
      return row;
    }
  
    function getActionDetails(action) {
      // Montar uma string com os detalhes da ação
      let details = '';
      details += `Horário: ${action.startTime} - ${action.endTime}, `;
      details += `Retardo: ${action.delayTime}s, `;
      // details += `Categorias: ${action.categories.join(', ')}, `;
      details += `Abertura de Porta: ${action.openDoor ? 'Sim' : 'Não'}, `;
      details += `Gerar Evento: ${action.generateEvent ? 'Sim' : 'Não'}`;
      return details;
    }
  
    function selectAction(action) {
      selectedAction = action;
      // Carregar áreas (linhas, direções e áreas poligonais) associadas à ação
      loadAreas(action._id);
    }
  
    function loadAreas(actionId) {
      fetch(`/api/areas/action/${actionId}`)
        .then(response => response.json())
        .then(areaData => {
          areas = areaData;
          return fetch(`/api/directions/action/${actionId}`);
        })
        .then(response => response.json())
        .then(directionData => {
          directions = directionData;
  
          // Mapear direções para suas respectivas áreas
          areas.forEach(area => {
            area.directions = directions.filter(direction => direction.areaId === area._id);
          });
  
          // Separar áreas em linhas e polígonos
          lines = areas.filter(area => area.type === 'line');
          areasList = areas.filter(area => area.type === 'area');
  
          drawAreas();
        })
        .catch(error => {
          console.error('Erro ao carregar áreas e direções:', error);
        });
    }
  
    function drawAreas() {
      // Limpar canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
  
      // Desenhar linhas e suas direções
      lines.forEach(line => {
        drawLine(line, false);
  
        if (line.directions) {
          line.directions.forEach(direction => {
            drawArrow(direction, false);
          });
        }
      });
  
      // Desenhar áreas poligonais e suas direções
      areasList.forEach(area => {
        drawPolygon(area, false);
  
        if (area.directions) {
          area.directions.forEach(direction => {
            drawArrow(direction, false);
          });
        }
      });
    }
  
    closeActionModal.addEventListener('click', () => {
      actionModal.style.display = 'none';
    });
  
    areaTypeSelect.addEventListener('change', () => {
      updateAreaTypeUI();
    });
  
    function updateAreaTypeUI() {
      const areaType = areaTypeSelect.value;
      if (areaType === 'line') {
        lineButtons.style.display = 'block';
        areaButtons.style.display = 'none';
      } else if (areaType === 'area') {
        lineButtons.style.display = 'none';
        areaButtons.style.display = 'block';
      }
    }
  
    createLineButton.addEventListener('click', () => {
      actionModal.style.display = 'none';
      openLineNameModal();
    });
  
    createDirectionButton.addEventListener('click', () => {
      if (lines.length === 0) {
        alert('Nenhuma linha disponível. Por favor, crie uma linha primeiro.');
        return;
      }
      actionModal.style.display = 'none';
      openDirectionModal();
    });
  
    createAreaButton.addEventListener('click', () => {
      actionModal.style.display = 'none';
      openAreaNameModal();
    });
  
    window.onclick = function(event) {
      if (event.target == actionModal) {
        actionModal.style.display = 'none';
      }
      if (event.target == lineNameModal) {
        lineNameModal.style.display = 'none';
      }
      if (event.target == drawLineModal) {
        drawLineModal.style.display = 'none';
      }
      if (event.target == confirmLineModal) {
        confirmLineModal.style.display = 'none';
      }
      if (event.target == directionModal) {
        directionModal.style.display = 'none';
      }
      if (event.target == drawDirectionModal) {
        drawDirectionModal.style.display = 'none';
      }
      if (event.target == confirmDirectionModal) {
        confirmDirectionModal.style.display = 'none';
      }
      if (event.target == areaNameModal) {
        areaNameModal.style.display = 'none';
      }
      if (event.target == drawAreaModal) {
        drawAreaModal.style.display = 'none';
      }
      if (event.target == confirmAreaModal) {
        confirmAreaModal.style.display = 'none';
      }
    };
  
    function openActionModal(action = null) {
      // Obter o canal_type do canal atual
      fetch(`/api/channels/${channelId}`)
      .then(response => response.json())
      .then(channel => {
        const isPlateChannel = (channel.channel_type === 'plate');
        isPlateChannel ? createPlateModal(action) : createIAModal(action);
        // console.log(channel.channel_type)
        // console.log(isPlateChannel)
      })
    }

    function createIAModal(action){
      currentAction = action;
      modalTitle.textContent = action ? 'Editar Ação' : 'Adicionar Ação';
      modalTitle.classList.add('modalTitle');
      
      // Limpar o corpo do modal
      modalBody.innerHTML = '';
    
      // Criar o formulário dinâmico
      const form = document.createElement('div');
    
      // Nome da Ação
      const nameGroup = createFormGroup('Nome da Ação:', 'actionName');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.id = 'actionName';
      nameInput.required = true;
      if (action) {
        nameInput.value = action.name;
      }
      nameGroup.appendChild(nameInput);
      form.appendChild(nameGroup);
    
      // Campos de horário e retardo alinhados na mesma linha
      const scheduleGroup = document.createElement('div');
      scheduleGroup.classList.add('form-row');
    
      // Hora de Início
      const startTimeGroup = createFormGroup('Hora de Início:', 'startTime');
      const startTimeInput = document.createElement('input');
      startTimeInput.type = 'time';
      startTimeInput.id = 'startTime';
      startTimeInput.required = true;
      if (action) {
        startTimeInput.value = action.startTime;
      }
      startTimeGroup.appendChild(startTimeInput);
      scheduleGroup.appendChild(startTimeGroup);
    
      // Hora de Fim
      const endTimeGroup = createFormGroup('Hora de Fim:', 'endTime');
      const endTimeInput = document.createElement('input');
      endTimeInput.type = 'time';
      endTimeInput.id = 'endTime';
      endTimeInput.required = true;
      if (action) {
        endTimeInput.value = action.endTime;
      }
      endTimeGroup.appendChild(endTimeInput);
      scheduleGroup.appendChild(endTimeGroup);
    
      // Tempo de Retardo
      const delayTimeGroup = createFormGroup('Tempo de Retardo (s):', 'delayTime');
      const delayTimeInput = document.createElement('input');
      delayTimeInput.type = 'number';
      delayTimeInput.id = 'delayTime';
      delayTimeInput.min = 0;
      delayTimeInput.required = true;
      if (action) {
        delayTimeInput.value = action.delayTime;
      } else {
        delayTimeInput.value = 0;
      }
      delayTimeGroup.appendChild(delayTimeInput);
      scheduleGroup.appendChild(delayTimeGroup);
    
      form.appendChild(scheduleGroup);
      
      const divider = document.createElement('div');
      divider.classList.add('divider');
      form.appendChild(divider);

      const categoriesButton = document.createElement('button');
      categoriesButton.type = 'button';
      categoriesButton.id = 'categoriesButton';
      categoriesButton.classList.add('action-button', 'categories-button');
      categoriesButton.textContent = 'Categorias';
      categoriesButton.addEventListener('click', openCategoriesModal);
      if (action && action.categories && action.categories.length > 0) {
        categoriesButton.textContent = `Categorias (${action.categories.length})`;
      } else {
        categoriesButton.textContent = 'Categorias';
      }

      const categoriesContainer = document.getElementById('categoriesContainer');
      categoriesContainer.innerHTML = '';
      categoriesContainer.appendChild(categoriesButton);


      const togglesContainer = document.createElement('div');
      togglesContainer.classList.add('togglesContainer');

      // Abertura de Porta
      const openDoorGroup = document.createElement('div');
      openDoorGroup.classList.add('toggle');

      const openDoorLabel = document.createElement('label');
      openDoorLabel.htmlFor = 'openDoor';
      openDoorLabel.textContent = 'Abertura de Porta';
      openDoorGroup.appendChild(openDoorLabel);

      const openDoorCheckbox = document.createElement('input');
      openDoorCheckbox.type = 'checkbox';
      openDoorCheckbox.id = 'openDoor';
      if (action && action.openDoor) {
        openDoorCheckbox.checked = true;
      }
      openDoorGroup.appendChild(openDoorCheckbox);

      // Gerar Evento
      const generateEventGroup = document.createElement('div');
      generateEventGroup.classList.add('toggle');

      const generateEventLabel = document.createElement('label');
      generateEventLabel.htmlFor = 'generateEvent';
      generateEventLabel.textContent = 'Gerar Evento';
      generateEventGroup.appendChild(generateEventLabel);
      
      const generateEventCheckbox = document.createElement('input');
      generateEventCheckbox.type = 'checkbox';
      generateEventCheckbox.id = 'generateEvent';
      if (action && action.generateEvent) {
        generateEventCheckbox.checked = true;
      }
      generateEventGroup.appendChild(generateEventCheckbox);

      togglesContainer.appendChild(openDoorGroup);
      togglesContainer.appendChild(generateEventGroup);
      form.appendChild(togglesContainer);
      modalBody.appendChild(form);
    
      const divider2 = document.createElement('div');
      divider2.classList.add('divider');
      form.appendChild(divider2);

      const areaTypeContainer = document.createElement('div');
      areaTypeContainer.id = 'areaTypeContainer';
    
      const areaTypeLabel = document.createElement('label');
      areaTypeLabel.for = 'areaTypeSelect';
      areaTypeLabel.textContent = 'Tipo de Ação:';
      areaTypeContainer.appendChild(areaTypeLabel);
    
      const areaTypeSelect = document.createElement('select');
      areaTypeSelect.id = 'areaTypeSelect';
      areaTypeSelect.innerHTML = `
        <option value="line">Linha</option>
        <option value="area">Área</option>
      `;
      if (action && action.areaType) {
        areaTypeSelect.value = action.areaType;
      } else {
        areaTypeSelect.value = 'line';
      }
      areaTypeContainer.appendChild(areaTypeSelect);
    
      // Anexar areaTypeContainer ao form se for IA
      form.appendChild(areaTypeContainer);

      updateAreaTypeUI();
    
      actionModal.style.display = 'block';
    }

    function createPlateModal(action) {
      // console.log('Plate modal function')
      currentAction = action;
      modalTitle.textContent = action ? 'Editar Ação' : 'Adicionar Ação';
      modalTitle.classList.add('modalTitle');
      
      // Limpar o corpo do modal
      modalBody.innerHTML = '';
    
      // Criar o formulário dinâmico
      const form = document.createElement('div');
    
      // Nome da Ação
      const nameGroup = createFormGroup('Nome da Ação:', 'actionName');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.id = 'actionName';
      nameInput.required = true;
      if (action) {
        nameInput.value = action.name;
      }
      nameGroup.appendChild(nameInput);
      form.appendChild(nameGroup);
    
      const togglesContainer = document.createElement('div');
      togglesContainer.classList.add('togglesContainer');
    
      // Abertura de Porta
      const openDoorGroup = document.createElement('div');
      openDoorGroup.classList.add('toggle');
    
      const openDoorLabel = document.createElement('label');
      openDoorLabel.htmlFor = 'openDoor';
      openDoorLabel.textContent = 'Abertura de Porta';
      openDoorGroup.appendChild(openDoorLabel);
    
      const openDoorCheckbox = document.createElement('input');
      openDoorCheckbox.type = 'checkbox';
      openDoorCheckbox.id = 'openDoor';
      if (action && action.openDoor) {
        openDoorCheckbox.checked = true;
      }
      openDoorGroup.appendChild(openDoorCheckbox);
    
      // Gerar Evento
      const generateEventGroup = document.createElement('div');
      generateEventGroup.classList.add('toggle');
    
      const generateEventLabel = document.createElement('label');
      generateEventLabel.htmlFor = 'generateEvent';
      generateEventLabel.textContent = 'Gerar Evento';
      generateEventGroup.appendChild(generateEventLabel);
      
      const generateEventCheckbox = document.createElement('input');
      generateEventCheckbox.type = 'checkbox';
      generateEventCheckbox.id = 'generateEvent';
      if (action && action.generateEvent) {
        generateEventCheckbox.checked = true;
      }
      generateEventGroup.appendChild(generateEventCheckbox);
    
      togglesContainer.appendChild(openDoorGroup);
      togglesContainer.appendChild(generateEventGroup);
      form.appendChild(togglesContainer);
      modalBody.appendChild(form);
    
      // Mostrar apenas botões "Criar Linha" e "Criar Direção"
      const lineButtons = document.createElement('div');
      lineButtons.id = 'lineButtons';
      lineButtons.style.display = 'block';
    
      const createLineButton = document.createElement('button');
      createLineButton.id = 'createLineButton';
      createLineButton.textContent = 'Criar Linha';
      lineButtons.appendChild(createLineButton);
    
      const createDirectionButton = document.createElement('button');
      createDirectionButton.id = 'createDirectionButton';
      createDirectionButton.textContent = 'Criar Direção';
      lineButtons.appendChild(createDirectionButton);
    
      // Adicionar event listeners aos botões
      createLineButton.addEventListener('click', () => {
        actionModal.style.display = 'none';
        openLineNameModal();
      });
    
      createDirectionButton.addEventListener('click', () => {
        if (lines.length === 0) {
          alert('Nenhuma linha disponível. Por favor, crie uma linha primeiro.');
          return;
        }
        actionModal.style.display = 'none';
        openDirectionModal();
      });
    
      form.appendChild(lineButtons);
    
      actionModal.style.display = 'block';
    }
    
    // Função para criar o modal de categorias dinamicamente
    function createCategoriesModal() {
      // Verificar se o modal já foi criado para evitar duplicações
      if (document.getElementById('categoriesModal')) {
        return;
      }

      // Criar os elementos do modal
      const categoriesModal = document.createElement('div');
      categoriesModal.id = 'categoriesModal';
      categoriesModal.classList.add('modal');

      const modalContent = document.createElement('div');
      modalContent.classList.add('modal-content');

      const closeSpan = document.createElement('span');
      closeSpan.id = 'closeCategoriesModal';
      closeSpan.classList.add('close');
      closeSpan.innerHTML = '&times;';

      const title = document.createElement('h2');
      title.classList.add('modalTitle')
      title.textContent = 'Categorias de Objetos';

      const form = document.createElement('form');
      form.id = 'categoriesForm';

      // Container para o grid de categorias
      const categoriesGrid = document.createElement('div');
      categoriesGrid.classList.add('categories-grid');

      // Lista de categorias com labels em português
      const categorias = [
        { id: 'category_pessoa', name: 'Pessoa', value: 'person' },
        { id: 'category_carro', name: 'Carro', value: 'car' },
        { id: 'category_caminhao', name: 'Caminhão', value: 'truck' },
        { id: 'category_onibus', name: 'Ônibus', value: 'bus' },
        { id: 'category_moto', name: 'Moto', value: 'motorcycle' },
        { id: 'category_bicicleta', name: 'Bicicleta', value: 'bicycle' },
        { id: 'category_cachorro', name: 'Cachorro', value: 'dog' },
        { id: 'category_gato', name: 'Gato', value: 'cat' },
        { id: 'category_cavalo', name: 'Cavalo', value: 'horse' },
      ];

      categorias.forEach(cat => {
        const formGroup = document.createElement('div');
        formGroup.classList.add('form-group', 'category-item');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = cat.id;
        checkbox.name = 'categories';
        checkbox.value = cat.value;

        const label = document.createElement('label');
        label.htmlFor = cat.id;
        label.textContent = cat.name;

        formGroup.appendChild(label);
        formGroup.appendChild(checkbox);
        categoriesGrid.appendChild(formGroup);
      });

      form.appendChild(categoriesGrid);

      // Botões do formulário
      const buttonsContainer = document.createElement('div');
      buttonsContainer.classList.add('categoriesModalButtons')
      buttonsContainer.style.display = 'flex';
      buttonsContainer.style.justifyContent = 'flex-end';
      buttonsContainer.style.gap = '10px';

      const saveButton = document.createElement('button');
      saveButton.type = 'submit';
      saveButton.textContent = 'Save'; // Mantém "Save" em inglês

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.id = 'cancelCategories';
      cancelButton.textContent = 'Cancelar';

      buttonsContainer.appendChild(saveButton);
      buttonsContainer.appendChild(cancelButton);

      form.appendChild(buttonsContainer);

      // Montar o modal
      modalContent.appendChild(closeSpan);
      modalContent.appendChild(title);
      modalContent.appendChild(form);
      categoriesModal.appendChild(modalContent);

      // Adicionar o modal ao body
      document.body.appendChild(categoriesModal);

      // Adicionar event listeners para fechar o modal
      closeSpan.addEventListener('click', () => {
        categoriesModal.style.display = 'none';
      });

      cancelButton.addEventListener('click', () => {
        categoriesModal.style.display = 'none';
      });

      // Event listener para submissão do formulário de categorias
      form.addEventListener('submit', (event) => {
        event.preventDefault();

        // Coletar as categorias selecionadas
        const selectedCategories = Array.from(form.elements['categories'])
          .filter(checkbox => checkbox.checked)
          .map(checkbox => checkbox.value);

        // Armazenar as categorias selecionadas na ação atual
        if (!currentAction) {
          currentAction = {};
        }
        currentAction.categories = selectedCategories;

        // Atualizar o botão de categorias para refletir as categorias selecionadas
        const categoriesButton = document.getElementById('categoriesButton');
        categoriesButton.textContent = `Categorias (${selectedCategories.length})`;

        // Fechar o modal de categorias
        categoriesModal.style.display = 'none';
      });
    }

    // Função para salvar áreas no backend quando a ação for salva
    saveActionButton.addEventListener('click', () => {
      // console.log('Depois')
      // Salvar a ação primeiro
      const name = document.getElementById('actionName').value;
      const startTime = document.getElementById('startTime')?.value;
      const endTime = document.getElementById('endTime')?.value;
      const delayTime = parseInt(document.getElementById('delayTime')?.value) || 0;

      // Verificar se as categorias foram selecionadas via modal
      const categories = currentAction && currentAction.categories ? currentAction.categories : [];

      const openDoor = document.getElementById('openDoor').checked;
      const generateEvent = document.getElementById('generateEvent').checked;

      const areaType = areaTypeSelect?.value;

      const actionData = {
        channelId,
        name,
        startTime,
        endTime,
        delayTime,
        categories,
        openDoor,
        generateEvent,
        areaType
      };

      if (currentAction) {
        // Atualizar ação existente
        actionData._id = currentAction._id;
        updateAction(actionData);
      } else {
        // Criar nova ação
        createAction(actionData);
      }
    });

    // Função para abrir o modal de categorias
    function openCategoriesModal() {
      // Criar o modal se ainda não existir
      createCategoriesModal();

      // Mostrar o modal
      const categoriesModal = document.getElementById('categoriesModal');
      categoriesModal.style.display = 'block';

      // Pré-selecionar as categorias com base na ação atual
      if (currentAction && currentAction.categories) {
        categoriesModal.querySelectorAll('input[name="categories"]').forEach(checkbox => {
          if (currentAction.categories.includes(checkbox.value)) {
            checkbox.checked = true;
          } else {
            checkbox.checked = false;
          }
        });
      } else {
        // Se nenhuma categoria estiver selecionada, desmarcar todas
        categoriesModal.querySelectorAll('input[name="categories"]').forEach(checkbox => {
          checkbox.checked = false;
        });
      }
    }

    function createFormGroup(labelText, inputId) {
      const group = document.createElement('div');
      group.classList.add('form-group');
      if (labelText) {
        const label = document.createElement('label');
        label.htmlFor = inputId;
        label.textContent = labelText;
        group.appendChild(label);
      }
      return group;
    }
  
    // Fluxo para criação de linha
  
    function openLineNameModal() {
      lineNameInput.value = '';
      lineNameModal.style.display = 'block';
    }
  
    lineNameConfirmButton.addEventListener('click', () => {
      const name = lineNameInput.value.trim();
      if (name) {
        currentLine = { name, _id: generateId(), type: 'line' };
        lineNameModal.style.display = 'none';
        openDrawLineModal();
      } else {
        alert('Por favor, insira um nome para a linha.');
      }
    });
  
    closeLineNameModal.addEventListener('click', () => {
      lineNameModal.style.display = 'none';
      openActionModal(currentAction);
    });
  
    function openDrawLineModal() {
      drawLineModal.style.display = 'block';
      startDrawLineButton.addEventListener('click', startDrawingLine);
    }
  
    closeDrawLineModal.addEventListener('click', () => {
      drawLineModal.style.display = 'none';
      openActionModal(currentAction);
    });
  
    function startDrawingLine() {
      drawLineModal.style.display = 'none';
      mode = 'line';
      points = [];
      setupCanvasEvents();
    }
  
    // Fluxo para criação de direção
  
    function openDirectionModal() {
      directionNameInput.value = '';
      // Preencher o select com as linhas existentes
      lineSelect.innerHTML = '';
      lines.forEach(line => {
        const option = document.createElement('option');
        option.value = line._id;
        option.textContent = line.name;
        lineSelect.appendChild(option);
      });
      directionModal.style.display = 'block';
    }
  
    directionNameConfirmButton.addEventListener('click', () => {
      const name = directionNameInput.value.trim();
      const lineId = lineSelect.value;
      if (name && lineId) {
        currentDirection = {
          name,
          lineId,
          _id: generateId(),
          type: 'direction'
        };
        directionModal.style.display = 'none';
        openDrawDirectionModal();
      } else {
        alert('Por favor, insira o nome da direção e selecione uma linha.');
      }
    });
  
    closeDirectionModal.addEventListener('click', () => {
      directionModal.style.display = 'none';
      openActionModal(currentAction);
    });
  
    function openDrawDirectionModal() {
      drawDirectionModal.style.display = 'block';
      startDrawDirectionButton.addEventListener('click', startDrawingDirection);
    }
  
    closeDrawDirectionModal.addEventListener('click', () => {
      drawDirectionModal.style.display = 'none';
      openActionModal(currentAction);
    });
  
    function startDrawingDirection() {
      drawDirectionModal.style.display = 'none';
      mode = 'direction';
      points = [];
      setupCanvasEvents();
    }
  
    // Fluxo para criação de área
  
    function openAreaNameModal() {
      areaNameInput.value = '';
      areaNameModal.style.display = 'block';
    }
  
    areaNameConfirmButton.addEventListener('click', () => {
      const name = areaNameInput.value.trim();
      // console.log('Salvar area com nome', name)
      if (name) {
        currentArea = { name, _id: generateId(), type: 'area' };
        // currentArea.direction = areaDirectionToggle.value;
        areaNameModal.style.display = 'none';
        openDrawAreaModal();
      } else {
        alert('Por favor, insira um nome para a área.');
      }
    });
  
    closeAreaNameModal.addEventListener('click', () => {
      areaNameModal.style.display = 'none';
      openActionModal(currentAction);
    });
  
    function openDrawAreaModal() {
      drawAreaModal.style.display = 'block';
      startDrawAreaButton.addEventListener('click', startDrawingArea);
    }
  
    closeDrawAreaModal.addEventListener('click', () => {
      drawAreaModal.style.display = 'none';
      openActionModal(currentAction);
    });
  
    function startDrawingArea() {
      drawAreaModal.style.display = 'none';
      mode = 'area';
      points = [];
      setupCanvasEvents();
    }
  
    // Eventos de desenho no canvas
  
    function setupCanvasEvents() {
      canvas.addEventListener('mousedown', canvasMouseDown);
    }
  
    function canvasMouseDown(e) {
      if (mode === 'line' || mode === 'direction' || mode === 'area') {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
  
        if (mode === 'area') {
          // Se o usuário clicar próximo ao primeiro ponto, fechar o polígono
          if (points.length > 2) {
            const firstPoint = points[0];
            const distance = Math.hypot(x - firstPoint.x, y - firstPoint.y);
            if (distance < 10) {
              // Fechar o polígono
              drawPolygon({ points }, false);
              // Remover eventos do canvas
              canvas.removeEventListener('mousedown', canvasMouseDown);
              // Salvar os pontos na área atual
              currentArea.points = [...points];
              // Abrir modal de confirmação
              openConfirmAreaModal();
              // Limpar pontos e resetar modo
              points = [];
              mode = null;
              return;
            }
          }
          points.push({ x, y });
          drawPoint(x, y);
          if (points.length > 1) {
            drawLineSegment(points[points.length - 2], points[points.length - 1]);
          }
        } else {
          points.push({ x, y });
          drawPoint(x, y);
  
          if (points.length === 2) {
            if (mode === 'line') {
              currentLine.x1 = points[0].x;
              currentLine.y1 = points[0].y;
              currentLine.x2 = points[1].x;
              currentLine.y2 = points[1].y;
  
              // Desenhar a linha no canvas
              drawLine(currentLine, false);
  
              // Remover eventos do canvas
              canvas.removeEventListener('mousedown', canvasMouseDown);
  
              // Abrir modal de confirmação
              openConfirmLineModal();
            } else if (mode === 'direction') {
              currentDirection.x1 = points[0].x;
              currentDirection.y1 = points[0].y;
              currentDirection.x2 = points[1].x;
              currentDirection.y2 = points[1].y;
  
              // Desenhar a direção no canvas
              drawArrow(currentDirection, false);
  
              // Remover eventos do canvas
              canvas.removeEventListener('mousedown', canvasMouseDown);
  
              // Abrir modal de confirmação
              openConfirmDirectionModal();
            }
            // Limpar pontos e resetar modo
            points = [];
            mode = null;
          }
        }
      }
    }
  
    function drawPoint(x, y) {
      ctx.fillStyle = 'red';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, 2 * Math.PI);
      ctx.fill();
    }
  
    function drawLineSegment(p1, p2) {
      ctx.strokeStyle = 'blue';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  
    function drawPolygon(area, highlight) {
      const points = area.points;
      if (points.length < 3) return;
  
      ctx.strokeStyle = highlight ? 'white' : 'orange';
      ctx.lineWidth = highlight ? 4 : 2;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      points.forEach(point => {
        ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.stroke();
  
      // Preenchimento opcional
      ctx.fillStyle = 'rgba(255, 165, 0, 0.3)';
      ctx.fill();
    }
  
    // Modais de confirmação de área
  
    function openConfirmAreaModal() {
      confirmAreaModal.style.display = 'block';
    }
  
    saveAreaButton.addEventListener('click', () => {
      const newArea = { ...currentArea, channelId };
      areasList.push(newArea);
      confirmAreaModal.style.display = 'none';
      // Redesenhar as áreas
      drawAreas();
      // Retornar ao modal de ação
      openActionModal(currentAction);
    });
  
    cancelAreaButton.addEventListener('click', () => {
      confirmAreaModal.style.display = 'none';
      // Remover a área desenhada
      drawAreas();
      // Retornar ao modal de ação
      openActionModal(currentAction);
    });
  
    closeConfirmAreaModal.addEventListener('click', () => {
      confirmAreaModal.style.display = 'none';
      // Remover a área desenhada
      drawAreas();
      // Retornar ao modal de ação
      openActionModal(currentAction);
    });
  
    // Modais de confirmação para linha e direção
  
    function openConfirmLineModal() {
      confirmLineModal.style.display = 'block';
    }
  
    saveLineButton.addEventListener('click', () => {
      const newLine = { ...currentLine, channelId };
      lines.push(newLine);
      confirmLineModal.style.display = 'none';
      // Redesenhar as áreas
      drawAreas();
      // Retornar ao modal de ação
      openActionModal(currentAction);
    });
  
    cancelLineButton.addEventListener('click', () => {
      confirmLineModal.style.display = 'none';
      // Remover a linha desenhada
      drawAreas();
      // Retornar ao modal de ação
      openActionModal(currentAction);
    });
  
    closeConfirmLineModal.addEventListener('click', () => {
      confirmLineModal.style.display = 'none';
      // Remover a linha desenhada
      drawAreas();
      // Retornar ao modal de ação
      openActionModal(currentAction);
    });
  
    function openConfirmDirectionModal() {
      confirmDirectionModal.style.display = 'block';
    }
  
    saveDirectionButton.addEventListener('click', () => {
      const newDirection = { ...currentDirection, channelId };
      directions.push(newDirection);
      confirmDirectionModal.style.display = 'none';
      // Redesenhar as áreas
      drawAreas();
      // Retornar ao modal de ação
      openActionModal(currentAction);
    });
  
    cancelDirectionButton.addEventListener('click', () => {
      confirmDirectionModal.style.display = 'none';
      // Remover a direção desenhada
      drawAreas();
      // Retornar ao modal de ação
      openActionModal(currentAction);
    });
  
    closeConfirmDirectionModal.addEventListener('click', () => {
      confirmDirectionModal.style.display = 'none';
      // Remover a direção desenhada
      drawAreas();
      // Retornar ao modal de ação
      openActionModal(currentAction);
    });
  
    // Função para desenhar linha
    function drawLine(line, highlight) {
      ctx.strokeStyle = highlight ? 'white' : 'blue';
      ctx.lineWidth = highlight ? 4 : 2;
      ctx.beginPath();
      ctx.moveTo(line.x1, line.y1);
      ctx.lineTo(line.x2, line.y2);
      ctx.stroke();
    }
  
    // Função para desenhar direção (seta)
    function drawArrow(direction, highlight) {
      const headlen = 10; // Tamanho da cabeça da seta
      const angle = Math.atan2(direction.y2 - direction.y1, direction.x2 - direction.x1);
  
      ctx.strokeStyle = highlight ? 'white' : 'green';
      ctx.fillStyle = highlight ? 'white' : 'green';
      ctx.lineWidth = highlight ? 4 : 2;
      ctx.beginPath();
      ctx.moveTo(direction.x1, direction.y1);
      ctx.lineTo(direction.x2, direction.y2);
      ctx.stroke();
  
      // Desenhar a cabeça da seta
      ctx.beginPath();
      ctx.moveTo(direction.x2, direction.y2);
      ctx.lineTo(
        direction.x2 - headlen * Math.cos(angle - Math.PI / 6),
        direction.y2 - headlen * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        direction.x2 - headlen * Math.cos(angle + Math.PI / 6),
        direction.y2 - headlen * Math.sin(angle + Math.PI / 6)
      );
      ctx.lineTo(direction.x2, direction.y2);
      ctx.lineTo(
        direction.x2 - headlen * Math.cos(angle - Math.PI / 6),
        direction.y2 - headlen * Math.sin(angle - Math.PI / 6)
      );
      ctx.fill();
    }
  
    function createAction(actionData) {
      fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actionData),
      })
      .then(response => response.json())
      .then(data => {
        // console.log('Ação criada:', data);
        actions.push(data);
        renderActions();
        actionModal.style.display = 'none';
  
        // Salvar as áreas associadas
        saveAreas(data._id);
      })
      .catch(error => {
        console.error('Erro ao criar ação:', error);
      });
    }
  
    function updateAction(actionData) {
      fetch(`/api/actions/${actionData._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actionData),
      })
      .then(response => response.json())
      .then(data => {
        // console.log('Ação atualizada:', data);
        const index = actions.findIndex(a => a._id === actionData._id);
        if (index !== -1) {
          actions[index] = actionData;
        }
        renderActions();
        actionModal.style.display = 'none';
  
        // Atualizar as áreas associadas
        saveAreas(actionData._id);
      })
      .catch(error => {
        console.error('Erro ao atualizar ação:', error);
      });
    }
  
    function saveAreas(actionId) {
      const areasToSave = [...lines, ...areasList].map(area => {
        area.actionId = actionId;
        area.channelId = channelId;
        return area;
      });
  
      fetch('/api/areas/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(areasToSave),
      })
      .then(response => response.json())
      .then(savedAreas => {
        // console.log('Áreas salvas:', savedAreas);
        // Atualizar IDs locais se necessário
        // Salvar direções após as áreas para garantir que as referências areaId sejam válidas
        saveDirections(actionId, savedAreas);
      })
      .catch(error => {
        console.error('Erro ao salvar áreas:', error);
      });
    }
  
    function saveDirections(actionId, savedAreas) {
      // Mapear IDs temporários para os IDs salvos
      const areaIdMap = {};
      savedAreas.forEach(area => {
        areaIdMap[area.tempId] = area._id;
      });
  
      const directionsToSave = directions.map(direction => {
        direction.actionId = actionId;
        direction.channelId = channelId;
        // Atualizar areaId se tiver sido alterado
        if (areaIdMap[direction.areaId]) {
          direction.areaId = areaIdMap[direction.areaId];
        }
        return direction;
      });
  
      fetch('/api/directions/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(directionsToSave),
      })
      .then(response => response.json())
      .then(savedDirections => {
        // console.log('Direções salvas:', savedDirections);
        // Limpar áreas e direções locais
        lines = [];
        directions = [];
        areasList = [];
        drawAreas();
      })
      .catch(error => {
        console.error('Erro ao salvar direções:', error);
      });
    }
  
    function deleteAction(actionId) {
      fetch(`/api/actions/${actionId}`, {
        method: 'DELETE',
      })
      .then(response => response.json())
      .then(data => {
        // console.log('Ação excluída:', data);
        actions = actions.filter(a => a._id !== actionId);
        renderActions();
        // Limpar áreas associadas
        lines = [];
        directions = [];
        areasList = [];
        drawAreas();
      })
      .catch(error => {
        console.error('Erro ao excluir ação:', error);
      });
    }
  
    // Função para gerar IDs únicos
    function generateId() {
      return '_' + Math.random().toString(36).substr(2, 9);
    }
  }

// Função para abrir o modal de Adicionar Canal
function openAddChannelModal() {
  const addChannelModal = document.getElementById('addChannelModal');
  addChannelModal.style.display = 'block';

  const addTypeSelect = document.getElementById('addChannelType');
  if (addTypeSelect) {
    updateChannelTypeFields(addTypeSelect.value, 'add');
  }
}

function parseStoredToggleValue(rawValue, defaultValue = true) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultValue;
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function getVectorSenseCheckbox(context) {
  return document.getElementById(
    context === 'add' ? 'addChannelVectorSenseEnabled' : 'editChannelVectorSenseEnabled'
  );
}

function updateVectorSenseFields(context) {
  const typeSelect = document.getElementById(
    context === 'add' ? 'addChannelType' : 'editChannelType'
  );
  const vectorSenseCheckbox = getVectorSenseCheckbox(context);
  const motionSettings = document.getElementById(
    context === 'add' ? 'addPlateMotionSettings' : 'editPlateMotionSettings'
  );
  if (!motionSettings) return;

  const isPlate = typeSelect?.value === 'plate';
  const vectorSenseEnabled = vectorSenseCheckbox ? vectorSenseCheckbox.checked : true;
  const showMotionSettings = isPlate && vectorSenseEnabled;

  motionSettings.style.display = showMotionSettings ? 'block' : 'none';
  motionSettings.querySelectorAll('input, select, textarea').forEach((field) => {
    field.disabled = !showMotionSettings;
  });

  if (vectorSenseCheckbox) {
    vectorSenseCheckbox.disabled = !isPlate;
  }
}

const addTypeSelect = document.getElementById('addChannelType');
if (addTypeSelect) {
  addTypeSelect.addEventListener('change', (e) => {
    updateChannelTypeFields(e.target.value, 'add');
  });
}

const editTypeSelect = document.getElementById('editChannelType');
if (editTypeSelect) {
  editTypeSelect.addEventListener('change', (e) => {
    updateChannelTypeFields(e.target.value, 'edit');
  });
}

// Fechar o modal de Adicionar Canal
document.getElementById('closeAddChannelModal').addEventListener('click', () => {
  const addChannelModal = document.getElementById('addChannelModal');
  addChannelModal.style.display = 'none';
});

// Fechar o modal ao clicar em "Cancelar" no Adicionar Canal
document.getElementById('cancelAddChannel').addEventListener('click', () => {
  const addChannelModal = document.getElementById('addChannelModal');
  addChannelModal.style.display = 'none';
});

// Manipular o envio do formulário de Adicionar Canal
document.getElementById('addChannelForm').addEventListener('submit', (event) => {
  event.preventDefault();

  const form = event.target;
  const formData = new FormData(form);
  const channelData = Object.fromEntries(formData.entries());
  const vectorSenseCheckbox = getVectorSenseCheckbox('add');
  channelData.vectorSenseEnabled = vectorSenseCheckbox?.checked ? 'true' : 'false';
  if (channelData.channel_type === 'plate') {
    channelData.movementDirection =
      document.getElementById('addChannelMovementDirection')?.value || 'aproximando';
    channelData.movementSensitivity =
      document.getElementById('addChannelMovementSensitivity')?.value || '60';
  }

  // pega a área selecionada e grava no canal
  const areaSelect = form.querySelector('#addChannelArea');
  if (areaSelect) {
    channelData.areaId = areaSelect.value || '';
    // se quiser guardar também o nome legível da área:
    channelData.areaLabel =
      areaSelect.options[areaSelect.selectedIndex]?.text || '';
  }

  fetch('/api/channels', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(channelData)
  })
  .then(response => response.json())
  .then(data => {
    // console.log('Canal adicionado:', data);
    // Fechar o modal
    const addChannelModal = document.getElementById('addChannelModal');
    addChannelModal.style.display = 'none';
    // Recarregar a tabela de configurações
    loadSettings();
  })
  .catch(error => {
    console.error('Erro ao adicionar canal:', error);
    // Opcional: exibir mensagem de erro no modal
  });
});

// Função para abrir o modal de Editar Canal
function handleEditChannel(event) {
  const channelId = event.target.closest('tr').dataset.id;

  fetch(`/api/channels/${channelId}`)
    .then(response => response.json())
    .then(async channel => {
      console.log(document.getElementById('editChannelImgSize'))
      // Preencher os campos do formulário de edição
      document.getElementById('editChannelId').value = channel._id;
      document.getElementById('editChannelType').value = channel.channel_type;
      document.getElementById('editChannelName').value = channel.name;
      document.getElementById('editChannelIp').value = channel.cameraIp;
      document.getElementById('editChannelUsername').value = channel.username;
      document.getElementById('editChannelPassword').value = channel.password;
      document.getElementById('editChannelFps').value = channel.fps;
      document.getElementById('editChannelDvr').value = channel.dvrChannel;
      document.getElementById('editChannelImgSize').value = channel.imgSize || '';
      document.getElementById('editChannelDevice').value = channel.device; 
      document.getElementById('editChannelRadarId').value = channel.radarId || '';
      document.getElementById('editChannelMaxSpeed').value = channel.maxSpeed || '';
      document.getElementById('editChannelTolerance').value = channel.tolerance || '';
      document.getElementById('editChannelTimeWindow').value = channel.timeWindow || '';
      document.getElementById('editChannelLocation').value = channel.location || '';
      document.getElementById('editChannelAdd').value = channel.add || '';
      document.getElementById('editChannelEquipAdd').value = channel.equipAdd || '';
      document.getElementById('editChannelReceptorAdd').value = channel.receptorAdd || '';
      document.getElementById('editChannelPort').value = channel.port || '';
      document.getElementById('editDoorDriver').value = channel.doorDriver || 'mg3000';
      document.getElementById('editChannelVehicleAdd').value = channel.vehicleAdd || '';
      document.getElementById('editChannelVehiclePort').value = channel.vehiclePort || '';
      document.getElementById('editChannelVehicleChannel').value = channel.vehicleChannel || '';
      document.getElementById('editChannelApiKey').value = channel.apiKey || '';
      document.getElementById('editChannelVehicleUser').value = channel.vehicleUser || '';
      document.getElementById('editChannelVehiclePass').value = channel.vehiclePass || '';
      document.getElementById('editChannelVectorSenseEnabled').checked =
        parseStoredToggleValue(channel.vectorSenseEnabled, true);
      document.getElementById('editChannelMovementDirection').value = channel.movementDirection || 'aproximando';
      document.getElementById('editChannelMovementSensitivity').value = channel.movementSensitivity || 60;
      document.getElementById('editChannelMovementSensitivityValue').textContent = String(channel.movementSensitivity || 60);
      document.getElementById('editPlateGuardEnabled').value =
        String(channel.plateGuardEnabled ?? 'true').trim().toLowerCase() === 'false' ? 'false' : 'true';
      document.getElementById('editPlateGuardDetEveryN').value = channel.plateGuardDetEveryN || 2;
      document.getElementById('editPlateGuardVehicleConf').value = channel.plateGuardVehicleConf || 0.22;
      document.getElementById('editPlateGuardFraudConf').value = channel.plateGuardFraudConf || 0.22;
      document.getElementById('editPlateGuardMinPlateOverlap').value = channel.plateGuardMinPlateOverlap || 0.55;
      document.getElementById('editPlateGuardExpandFactor').value = channel.plateGuardExpandFactor || 1.8;
      document.getElementById('editPlateGuardFraudClasses').value = channel.plateGuardFraudClasses || 'person,cell phone,book,remote,laptop,tv';
      document.getElementById('editPreviewWebSide').value = channel.previewWebSide || 640;
      document.getElementById('editPreviewWebJpegQuality').value = channel.previewWebJpegQuality || 15;

            // >>>>>>> CARREGAR ÁREAS E PRÉ-SELECIONAR <<<<<<<<<
      const areaSelect = document.getElementById('editChannelArea');
      if (areaSelect) {
        // 1) busca as áreas no backend
        // const options = await loadAreasOptions(); // preenche areaOptions

        // 2) preenche o select com essas opções
        // fillAreaSelect(areaSelect, options);

        // 3) tenta selecionar a área do canal (vinda do banco)
        if (channel.areaId) {
          areaSelect.value = channel.areaId;

          // Se não existir mais essa área na lista (excluída, por ex.)
          if (!areaSelect.value) {
            const opt = document.createElement('option');
            opt.value = channel.areaId;
            opt.textContent = channel.areaLabel || '(Área removida)';
            areaSelect.appendChild(opt);
            areaSelect.value = channel.areaId;
          }
        }
      }
      
      // Abrir o modal de edição
      const editChannelModal = document.getElementById('editChannelModal');
      editChannelModal.style.display = 'block';

      updateChannelTypeFields(channel.channel_type, 'edit');
      updateDoorDriverFields('edit');

    })
    .catch(error => {
      console.error('Erro ao carregar canal:', error);
    });
}

function updateChannelTypeFields(type, context) {
  // context = 'add' ou 'edit'
  const mgGroup   = document.getElementById(context === 'add' ? 'addMg300Group'   : 'editMg300Group');
  const radarGroup= document.getElementById(context === 'add' ? 'addRadarIdGroup' : 'editRadarIdGroup');
  const plateMotionGroup = document.getElementById(context === 'add' ? 'addPlateMotionGroup' : 'editPlateMotionGroup');
  const plateGuardGroup = document.getElementById(context === 'add' ? 'addPlateGuardGroup' : 'editPlateGuardGroup');
  const previewStreamGroup = document.getElementById(context === 'add' ? 'addPreviewStreamGroup' : 'editPreviewStreamGroup');

  if (!mgGroup || !radarGroup) return;

  const isSpeed = type === 'speed';
  const isPlate = type === 'plate';
  const supportsPlateRead = isPlate || isSpeed;

  mgGroup.style.display    = isSpeed ? 'none' : 'block';
  radarGroup.style.display = isSpeed ? 'block' : 'none';
  if (plateMotionGroup) {
    plateMotionGroup.style.display = isPlate ? 'block' : 'none';
    plateMotionGroup.querySelectorAll('input, select, textarea').forEach((field) => {
      field.disabled = !isPlate;
    });
    updateVectorSenseFields(context);
  }
  if (plateGuardGroup) {
    plateGuardGroup.style.display = supportsPlateRead ? 'block' : 'none';
    plateGuardGroup.querySelectorAll('input, select, textarea').forEach((field) => {
      field.disabled = !supportsPlateRead;
    });
  }
  if (previewStreamGroup) {
    previewStreamGroup.style.display = supportsPlateRead ? 'block' : 'none';
    previewStreamGroup.querySelectorAll('input, select, textarea').forEach((field) => {
      field.disabled = !supportsPlateRead;
    });
  }

  // Campos de radar ficam obrigatórios somente para canal speed.
  const speedRequiredIds = context === 'add'
    ? ['addChannelTimeWindow', 'addChannelLocation', 'addChannelAdd']
    : ['editChannelTimeWindow', 'editChannelLocation', 'editChannelAdd'];

  speedRequiredIds.forEach((id) => {
    const field = document.getElementById(id);
    if (!field) return;
    field.required = isSpeed;
  });

  // Evita envio de campos do grupo oculto e remove bloqueio de validação do browser.
  mgGroup.querySelectorAll('input, select, textarea').forEach((field) => {
    field.disabled = isSpeed;
  });

  radarGroup.querySelectorAll('input, select, textarea').forEach((field) => {
    field.disabled = !isSpeed;
  });

  if (!isSpeed) {
    updateDoorDriverFields(context);
  }
}

function updateDoorDriverFields(context) {
  const driverSelect = document.getElementById(context === 'add' ? 'addDoorDriver' : 'editDoorDriver');
  const mgFields = document.getElementById(context === 'add' ? 'addMg300Fields' : 'editMg300Fields');
  const vehicleFields = document.getElementById(context === 'add' ? 'addVehicleFields' : 'editVehicleFields');
  if (!driverSelect || !mgFields || !vehicleFields) return;

  const useVehicle = String(driverSelect.value || '').toLowerCase() === 'dozz_vehicle';
  mgFields.style.display = useVehicle ? 'none' : 'block';
  vehicleFields.style.display = useVehicle ? 'block' : 'none';

  mgFields.querySelectorAll('input, select, textarea').forEach((field) => {
    field.disabled = useVehicle;
  });
  vehicleFields.querySelectorAll('input, select, textarea').forEach((field) => {
    field.disabled = !useVehicle;
  });
}

if (addTypeSelect) {
  updateChannelTypeFields(addTypeSelect.value, 'add');
}
if (editTypeSelect) {
  updateChannelTypeFields(editTypeSelect.value, 'edit');
}

const addDoorDriverSelect = document.getElementById('addDoorDriver');
if (addDoorDriverSelect) {
  addDoorDriverSelect.addEventListener('change', () => updateDoorDriverFields('add'));
  updateDoorDriverFields('add');
}

const editDoorDriverSelect = document.getElementById('editDoorDriver');
if (editDoorDriverSelect) {
  editDoorDriverSelect.addEventListener('change', () => updateDoorDriverFields('edit'));
  updateDoorDriverFields('edit');
}

// Fechar o modal de Editar Canal
document.getElementById('closeEditChannelModal').addEventListener('click', () => {
  const editChannelModal = document.getElementById('editChannelModal');
  editChannelModal.style.display = 'none';
});

const addMovementSensitivity = document.getElementById('addChannelMovementSensitivity');
const addMovementSensitivityValue = document.getElementById('addChannelMovementSensitivityValue');
if (addMovementSensitivity && addMovementSensitivityValue) {
  addMovementSensitivity.addEventListener('input', () => {
    addMovementSensitivityValue.textContent = addMovementSensitivity.value;
  });
}

const editMovementSensitivity = document.getElementById('editChannelMovementSensitivity');
const editMovementSensitivityValue = document.getElementById('editChannelMovementSensitivityValue');
if (editMovementSensitivity && editMovementSensitivityValue) {
  editMovementSensitivity.addEventListener('input', () => {
    editMovementSensitivityValue.textContent = editMovementSensitivity.value;
  });
}

const addVectorSenseCheckbox = getVectorSenseCheckbox('add');
if (addVectorSenseCheckbox) {
  addVectorSenseCheckbox.addEventListener('change', () => {
    updateVectorSenseFields('add');
  });
}

const editVectorSenseCheckbox = getVectorSenseCheckbox('edit');
if (editVectorSenseCheckbox) {
  editVectorSenseCheckbox.addEventListener('change', () => {
    updateVectorSenseFields('edit');
  });
}

// Fechar o modal ao clicar em "Cancelar" no Editar Canal
document.getElementById('cancelEditChannelModalButton').addEventListener('click', () => {
  const editChannelModal = document.getElementById('editChannelModal');
  editChannelModal.style.display = 'none';
});

// Manipular o envio do formulário de Editar Canal
document.getElementById('editChannelForm').addEventListener('submit', (event) => {
  event.preventDefault();

  const form = event.target;
  const formData = new FormData(form);
  const channelData = Object.fromEntries(formData.entries());
  const vectorSenseCheckbox = getVectorSenseCheckbox('edit');
  channelData.vectorSenseEnabled = vectorSenseCheckbox?.checked ? 'true' : 'false';
  if (channelData.channel_type === 'plate') {
    channelData.movementDirection =
      document.getElementById('editChannelMovementDirection')?.value || 'aproximando';
    channelData.movementSensitivity =
      document.getElementById('editChannelMovementSensitivity')?.value || '60';
  }

  // pega a área selecionada para esse canal
  const areaSelect = form.querySelector('#editChannelArea');
  if (areaSelect) {
    channelData.areaId = areaSelect.value || '';
    channelData.areaLabel =
      areaSelect.options[areaSelect.selectedIndex]?.text || '';
  }

  fetch('/api/channels', {
    method: 'POST', // Presumindo que POST com _id atualiza
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(channelData)
  })
  .then(response => response.json())
  .then(data => {
    // console.log('Canal atualizado:', data);
    // Fechar o modal
    const editChannelModal = document.getElementById('editChannelModal');
    editChannelModal.style.display = 'none';
    // Recarregar a tabela de configurações
    loadSettings();
  })
  .catch(error => {
    console.error('Erro ao atualizar canal:', error);
    // Opcional: exibir mensagem de erro no modal
  });
});

function handleVideoView(event) {
  const channelId = event.target.closest('tr').dataset.id;

  socket.emit('join', channelId);

  fetch(`/api/channels/${channelId}`)
    .then(response => response.json())
    .then(channel => {
      const videoFrameImage = document.getElementById('videoFrameImage');
      const videoModal = document.getElementById('videoModal');

      // Limpar a fonte anterior
      videoFrameImage.src = '';

      // Abrir o modal
      videoModal.style.display = 'block';
      startSocketVideoConsume(channelId, 'modal');

      // Configurar o Socket.IO para receber frames específicos do canal
      const videoFrameListener = (data) => {
        if (data.channelId === channelId) {
          if (typeof data.image === 'string') {
            videoFrameImage.src = 'data:image/jpeg;base64,' + data.image;
            return;
          }

          const blob = new Blob([data.image], { type: 'image/jpeg' });
          const imgUrl = URL.createObjectURL(blob);
          const prevUrl = videoFrameImage.dataset.blobUrl;
          videoFrameImage.src = imgUrl;
          videoFrameImage.dataset.blobUrl = imgUrl;
          if (prevUrl) {
            try {
              URL.revokeObjectURL(prevUrl);
            } catch (_) {
              // no-op
            }
          }
        }
      };

      // Adicionar o listener
      socket.on('frame', videoFrameListener);

      const closeModalButton = document.getElementById('closeVideoModal');
      let released = false;

      const releaseVideoModal = () => {
        if (released) return;
        released = true;

        videoModal.style.display = 'none';
        socket.off('frame', videoFrameListener);
        stopSocketVideoConsume(channelId, 'modal');

        const prevUrl = videoFrameImage.dataset.blobUrl;
        if (prevUrl) {
          try {
            URL.revokeObjectURL(prevUrl);
          } catch (_) {
            // no-op
          }
          delete videoFrameImage.dataset.blobUrl;
        }

        if (closeModalButton) {
          closeModalButton.removeEventListener('click', handleCloseModalClick);
        }
        window.removeEventListener('click', handleWindowModalClick);
      };

      const handleCloseModalClick = () => {
        releaseVideoModal();
      };

      const handleWindowModalClick = (windowEvent) => {
        if (windowEvent.target === videoModal) {
          releaseVideoModal();
        }
      };

      if (closeModalButton) {
        closeModalButton.addEventListener('click', handleCloseModalClick);
      }
      window.addEventListener('click', handleWindowModalClick);
    })
    .catch(error => {
      console.error('Erro ao carregar canal:', error);
    });
}

// Função para adicionar listeners de teclado (Enter e Espaço)
function addKeyboardListeners(element, callback) {
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callback(event);
    }
  });
}

function loadDashboardPlate() {
  const mainContent = document.getElementById('main-content');
  document.getElementById('page-title').innerText = 'Dashboard - Plate';
  clearMosaicFrameCache();

  // Limpar conteúdo anterior
  mainContent.innerHTML = '';

  // Cria um letreiro de status (caso use a lógica do seu dashboard)
  const statusMarquee = document.createElement('div');
  statusMarquee.id = 'status-marquee';
  statusMarquee.className = 'status-marquee';
  statusMarquee.style.padding = '10px';
  statusMarquee.style.borderRadius = '5px';
  mainContent.appendChild(statusMarquee);

  // Div que conterá as abas
  const tabsContainer = document.createElement('div');
  tabsContainer.classList.add('tabs-container');

  // Lista (ul) para as abas
  const tabsList = document.createElement('ul');
  tabsList.classList.add('tabs-list');

  // Div para o conteúdo das abas
  const tabsContent = document.createElement('div');
  tabsContent.classList.add('tabs-content');

  // Obter todos os canais de placa (ou “canais ativos” e filtrar) – 
  // caso prefira apenas canais ativos, use `/api/active-channels` e filtre `channel_type = 'plate'`
  fetch('/api/channels')
    .then(response => response.json())
    .then(allChannels => {
      // Filtrar canais de tipo 'plate'
      const plateChannels = allChannels.filter(ch => ch.channel_type === 'plate');
      if (plateChannels.length === 0) {
        mainContent.innerHTML += '<p>Nenhum canal de placas encontrado.</p>';
        return;
      }

      // Ordenar da forma que preferir (ex: por ordem de cadastro) se necessário.
      // Supondo que eles já venham na ordem de cadastro.
      
      // Criar uma aba e um painel de conteúdo para cada canal
      plateChannels.forEach((channel, index) => {
        // Criar a <li> da aba
        const tabLi = document.createElement('li');
        tabLi.classList.add('tab-item');
        // tabLi.textContent = channel.name;
        tabLi.setAttribute('data-channel-id', channel._id);

        // Criar o statusIndicator e inserir antes do nome do canal
        const statusIndicator = document.createElement('span');
        statusIndicator.classList.add('status-indicator'); 
        // Por padrão, deixamos sem cor ou com "red" se quiser
        statusIndicator.classList.add('red');

        // Criar um <span> ou textNode para o nome do canal
        const channelNameSpan = document.createElement('span');
        channelNameSpan.textContent = channel.name;

        // Inserir no `tabLi`
        tabLi.appendChild(statusIndicator);
        tabLi.appendChild(channelNameSpan);

        // Função de clique na aba
        tabLi.addEventListener('click', () => {
          // Ativar esta aba e desativar as demais
          activatePlateTab(channel._id);
        });

        tabsList.appendChild(tabLi);

        // Criar o conteúdo para esta aba
        const tabPane = document.createElement('div');
        tabPane.id = `tab-pane-${channel._id}`;
        tabPane.classList.add('tab-pane');

        // Aqui dentro colocamos a tabela de eventos
        // Pode estar inicialmente vazia e preenchida no momento do clique
        // Ou podemos preencher de imediato para o primeiro canal
        tabPane.innerHTML = `
          <table class="controle-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Grupo</th>
                <th>Unidade</th>
                <th>Marca</th>
                <th>Modelo</th>
                <th>Cor</th>
                <th>Placa</th>
                <th>Data/Hora</th>
              </tr>
            </thead>
            <tbody id="plate-tbody-${channel._id}">
              <!-- Eventos carregados dinamicamente -->
            </tbody>
          </table>
        `;
        tabsContent.appendChild(tabPane);

        // Se for a primeira aba (index === 0), já ativá-la ao entrar
        if (index === 0) {
          tabLi.classList.add('active');        // Aba ativa
          tabPane.classList.add('active-pane'); // Conteúdo ativo
          // Carregar os 10 últimos eventos ao entrar
          loadLastPlateEvents(channel._id);
        } else {
          // Demais abas ficam inativas, e só carregamos quando clicarem
        }
      });

      // Inserir no DOM
      tabsContainer.appendChild(tabsList);
      tabsContainer.appendChild(tabsContent);
      mainContent.appendChild(tabsContainer);

      // Setup Socket etc...
      setupDashboardPlateSocket();
      loadInitialProcessState();
    })
    .catch(error => {
      console.error('Erro ao carregar canais:', error);
      mainContent.innerHTML = '<p>Erro ao carregar o dashboard de placa.</p>';
    });
}

function loadDashboardSpeed() {
  const mainContent = document.getElementById('main-content');
  document.getElementById('page-title').innerText = 'Dashboard - Speed';
  clearMosaicFrameCache();

  // Limpar conteúdo anterior
  mainContent.innerHTML = '';

  // Letreiro de status
  const statusMarquee = document.createElement('div');
  statusMarquee.id = 'status-marquee';
  statusMarquee.className = 'status-marquee';
  statusMarquee.style.padding = '10px';
  statusMarquee.style.borderRadius = '5px';
  mainContent.appendChild(statusMarquee);

  const tabsContainer = document.createElement('div');
  tabsContainer.classList.add('tabs-container');

  const tabsList = document.createElement('ul');
  tabsList.classList.add('tabs-list');

  const tabsContent = document.createElement('div');
  tabsContent.classList.add('tabs-content');

  fetch('/api/channels')
    .then(response => response.json())
    .then(allChannels => {
      const speedChannels = allChannels.filter(ch => ch.channel_type === 'speed');

      if (speedChannels.length === 0) {
        mainContent.innerHTML += '<p>Nenhum canal de velocidade encontrado.</p>';
        return;
      }

      speedChannels.forEach((channel, index) => {
        // Aba
        const tabLi = document.createElement('li');
        tabLi.classList.add('tab-item');
        tabLi.setAttribute('data-channel-id', channel._id);

        const statusIndicator = document.createElement('span');
        statusIndicator.classList.add('status-indicator', 'red');

        const channelNameSpan = document.createElement('span');
        channelNameSpan.textContent = channel.name;

        tabLi.appendChild(statusIndicator);
        tabLi.appendChild(channelNameSpan);

        tabLi.addEventListener('click', () => {
          activateSpeedTab(channel._id);
        });

        tabsList.appendChild(tabLi);

        // Conteúdo da aba
        const tabPane = document.createElement('div');
        tabPane.id = `tab-pane-${channel._id}`;
        tabPane.classList.add('tab-pane');

        tabPane.innerHTML = `
          <table class="controle-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Grupo</th>
                <th>Unidade</th>
                <th>Marca</th>
                <th>Modelo</th>
                <th>Cor</th>
                <th>Placa</th>
                <th>Velocidade</th>
                <th>Data/Hora</th>
                <th>Imagem</th>
              </tr>
            </thead>
            <tbody id="speed-tbody-${channel._id}">
            </tbody>
          </table>
        `;

        tabsContent.appendChild(tabPane);

        // Ativar automaticamente o primeiro canal
        if (index === 0) {
          tabLi.classList.add('active');
          tabPane.classList.add('active-pane');
          loadLastSpeedEvents(channel._id);
        }
      });

      tabsContainer.appendChild(tabsList);
      tabsContainer.appendChild(tabsContent);
      mainContent.appendChild(tabsContainer);

      // Socket para eventos em tempo real
      setupDashboardSpeedSocket();
      // Atualiza status de processo e bolinhas das tabs
      loadInitialProcessState();
    })
    .catch(error => {
      console.error('Erro ao carregar canais de velocidade:', error);
      mainContent.innerHTML += '<p>Erro ao carregar o dashboard de velocidade.</p>';
    });
}

// Função para ativar uma aba de placa
function activatePlateTab(channelId) {
  // 1) Desativar todas as abas, ativar a atual
  const allTabs = document.querySelectorAll('.tab-item');
  allTabs.forEach(tab => tab.classList.remove('active'));
  const currentTab = document.querySelector(`.tab-item[data-channel-id="${channelId}"]`);
  if (currentTab) {
    currentTab.classList.add('active');
  }
  
  // 2) Desativar todos os pane, ativar o pane do canal
  const allPanes = document.querySelectorAll('.tab-pane');
  allPanes.forEach(p => p.classList.remove('active-pane'));
  const currentPane = document.getElementById(`tab-pane-${channelId}`);
  if (currentPane) {
    currentPane.classList.add('active-pane');
  }

  // 3) Carregar eventos do canal, se quiser (como já faz)
  loadLastPlateEvents(channelId);

  // 4) Agora buscar o status do canal e atualizar o marquee
  fetch(`/process-status/${channelId}`)
    .then(r => r.json())
    .then(data => {
      // data = { status: 'running'|'starting'|'error'|'stopped', errorType }
      updatePlateMarquee(data);
    })
    .catch(e => {
      console.error('Erro ao buscar status do canal', channelId, e);
      // Se quiser, setar o marquee para 'desconhecido'...
      updatePlateMarquee({ status: 'unknown' });
    });
}

function activateSpeedTab(channelId) {
  // Aba ativa
  const allTabs = document.querySelectorAll('.tab-item');
  allTabs.forEach(tab => tab.classList.remove('active'));
  const currentTab = document.querySelector(`.tab-item[data-channel-id="${channelId}"]`);
  if (currentTab) currentTab.classList.add('active');

  // Conteúdo ativo
  const allPanes = document.querySelectorAll('.tab-pane');
  allPanes.forEach(p => p.classList.remove('active-pane'));
  const currentPane = document.getElementById(`tab-pane-${channelId}`);
  if (currentPane) currentPane.classList.add('active-pane');

  // Carregar últimos eventos de speed daquele canal
  loadLastSpeedEvents(channelId);

  // Atualizar marquee com status do processo
  fetch(`/process-status/${channelId}`)
    .then(r => r.json())
    .then(data => {
      updatePlateMarquee(data); // Reaproveitando
    })
    .catch(e => {
      console.error('Erro ao buscar status do canal speed', channelId, e);
      updatePlateMarquee({ status: 'unknown' });
    });
}

function updatePlateMarquee({ status, errorType }) {
  const statusMarquee = document.getElementById('status-marquee');
  if (!statusMarquee) return;

  switch (status) {
    case 'starting':
      statusMarquee.textContent = 'Conectando...';
      statusMarquee.style.backgroundColor = 'yellow';
      statusMarquee.style.color = 'black';
      break;
    case 'running':
      statusMarquee.textContent = 'Processo em execução';
      statusMarquee.style.backgroundColor = 'green';
      statusMarquee.style.color = 'white';
      break;
    case 'error':
      statusMarquee.textContent = `Erro: ${errorType || ''}`;
      statusMarquee.style.backgroundColor = 'red';
      statusMarquee.style.color = 'white';
      break;
    case 'reconnecting':
      // se usar reconect
      statusMarquee.textContent = 'Reconectando...';
      statusMarquee.style.backgroundColor = 'orange';
      statusMarquee.style.color = 'black';
      break;
    case 'stopped':
    default:
      statusMarquee.textContent = 'Processo parado';
      statusMarquee.style.backgroundColor = 'red';
      statusMarquee.style.color = 'white';
      break;
  }
}

// Carregar os 10 últimos eventos do canal "channelId"
function loadLastPlateEvents(channelId) {
  // Exemplo: /api/events/:channelId ou outro endpoint
  // Lembrando que você pode ter /api/events/<channelId> para pegar todos, 
  // e então slice(0,10). Ajuste conforme sua rota.
  fetch(`/api/events/${channelId}`)
    .then(r => r.json())
    .then(events => {
      const last10 = events.slice(0, 10);
      // Limpar a tabela
      const tbody = document.getElementById(`plate-tbody-${channelId}`);
      if (!tbody) return;
      tbody.innerHTML = '';
      last10.forEach(event => {
        updateDashboardPlateTable(event);
      });
    })
    .catch(error => {
      console.error(`Erro ao buscar eventos do canal ${channelId}:`, error);
    });
}

function loadLastSpeedEvents(channelId) {
  fetch(`/api/events/${channelId}`)
    .then(r => r.json())
    .then(events => {
      const tbody = document.getElementById(`speed-tbody-${channelId}`);
      if (!tbody) return;

      tbody.innerHTML = '';

      // pega os 10 mais recentes e desenha do mais antigo -> mais novo
      const last10 = events.slice(0, 10).reverse();
      last10.forEach(evt => {
        updateDashboardSpeedTable(evt, { append: true });
      });
    })
    .catch(error => {
      console.error(`Erro ao buscar eventos de velocidade do canal ${channelId}:`, error);
    });
}

// Essa função insere uma linha no <tbody> do canal
function updateDashboardPlateTable(data) {
  const { channelId, customerInfo, timestamp } = data;
  const tbody = document.getElementById(`plate-tbody-${channelId}`);
  if (!tbody) return;

  const plateSVG = generatePlateSVG(customerInfo.plate);

  const newRow = document.createElement('tr');
  newRow.innerHTML = `
    <td>${customerInfo.name || 'Desconhecido'}</td>
    <td>${customerInfo.group || ''}</td>
    <td>${customerInfo.unit || ''}</td>
    <td>${customerInfo.make || ''}</td>
    <td>${customerInfo.model || ''}</td>
    <td>${customerInfo.color || ''}</td>
    <td>
      <div class="plate-svg-container">${plateSVG}</div>
    </td>
    <td>${formatTimestamp(timestamp)}</td>
  `;
  // Inserir no topo
  tbody.insertBefore(newRow, tbody.firstChild);

  // Se quiser manter só 10 linhas exibidas:
  const rows = tbody.querySelectorAll('tr');
  if (rows.length > 10) {
    rows[rows.length - 1].remove();
  }
}

function updateDashboardSpeedTable(data) {
  const { channelId, timestamp } = data;
  // console.log(data)
  const tbody = document.getElementById(`speed-tbody-${channelId}`);
  if (!tbody) {
    console.error(`Tabela Speed para o canal ${channelId} não encontrada.`);
    return;
  }

  const customerInfo = data.customerInfo || {};

  // Fallbacks:
  const plate  = customerInfo.plate || data.plate || '';
  const name   = customerInfo.name  || '';
  const group  = customerInfo.group || '';
  const unit   = customerInfo.unit  || '';
  const make   = customerInfo.make  || '';
  const model  = customerInfo.model || '';
  const color  = customerInfo.color || '';

  const speedValue = (typeof data.speed !== 'undefined' && data.speed !== null)
    ? `${data.speed} km/h`
    : '';

  const plateSVG = plate ? generatePlateSVG(plate) : '';

  const newRow = document.createElement('tr');

  const eventType = data.eventType || '';
  const fileName = data.fileName || '';
  const videoFileName = data.videoFileName || '';

  // Regra fixa:
  // speed_plate -> imagem (fileName) em /captures
  // plate_only  -> vídeo (videoFileName) em /clips
  let mediaButtonHtml = '';
  if (eventType === 'speed_plate' && fileName) {
    mediaButtonHtml = `
      <button class="btn-open-image"
        data-plate="${plate}"
        data-timestamp="${timestamp}"
        data-fileName="${fileName}">
        Ver
      </button>
    `;
  } else if (eventType === 'plate_only' && videoFileName) {
    mediaButtonHtml = `
      <button class="btn-open-video"
        data-plate="${plate}"
        data-timestamp="${timestamp}"
        data-videoFileName="${videoFileName}">
        Ver
      </button>
    `;
  }

  newRow.innerHTML = `
    <td>${name}</td>
    <td>${group}</td>
    <td>${unit}</td>
    <td>${make}</td>
    <td>${model}</td>
    <td>${color}</td>
    <td>
      ${plate ? `<div class="plate-svg-container">${plateSVG}</div>` : ''}
    </td>
    <td>${speedValue}</td>
    <td id="${timestamp}">${formatTimestamp(timestamp)}</td>
    <td>${mediaButtonHtml}</td>
  `;

  // Listener IMAGEM (speed_plate)
  const btnImg = newRow.querySelector('.btn-open-image');
  if (btnImg) {
    btnImg.addEventListener('click', () => {
      const btnPlate = btnImg.getAttribute('data-plate');
      const btnTimestamp = btnImg.getAttribute('data-timestamp');
      const btnFileName = btnImg.getAttribute('data-fileName');
      openSpeedCaptureModal(btnPlate, btnTimestamp, btnFileName); // usa /captures
    });
  }

  // Listener VÍDEO (plate_only)
  const btnVid = newRow.querySelector('.btn-open-video');
  if (btnVid) {
    btnVid.addEventListener('click', () => {
      const btnPlate = btnVid.getAttribute('data-plate');
      const btnTimestamp = btnVid.getAttribute('data-timestamp');
      const btnVideoFileName = btnVid.getAttribute('data-videoFileName');
      openSpeedClipModal(btnPlate, btnTimestamp, btnVideoFileName); // usa /clips
    });
  }


  // Listener do botão de imagem
  const btn = newRow.querySelector('.btn-open-capture');
  if (btn) {
    btn.addEventListener('click', () => {
      const btnPlate = btn.getAttribute('data-plate');
      const btnTimestamp = btn.getAttribute('data-timestamp');
      const fileName = btn.getAttribute('data-fileName');
      openSpeedCaptureModal(btnPlate, btnTimestamp, fileName);
    });
  }

  tbody.insertBefore(newRow, tbody.firstChild);

  const rows = tbody.querySelectorAll('tr');
  if (rows.length > 20) {
    tbody.removeChild(tbody.lastChild);
  }
}

// Gerar o SVG da placa (igual ao outro app)
function generatePlateSVG(plateNumber) {
  const normalized = String(plateNumber || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 7);

  if (!normalized) return '';

  const plateWidth = 210;
  const plateHeight = 43;
  const safeText = normalized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // SVG autônomo (sem assets externos), para não quebrar em produção.
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${plateWidth}" height="${plateHeight}" viewBox="0 0 ${plateWidth} ${plateHeight}" role="img" aria-label="Placa ${safeText}">
      <rect x="0.5" y="0.5" width="${plateWidth - 1}" height="${plateHeight - 1}" rx="5" ry="5" fill="#f7f8fb" stroke="#0f1f4d" stroke-width="1"/>
      <rect x="0.5" y="0.5" width="${plateWidth - 1}" height="9" rx="5" ry="5" fill="#1c3faa"/>
      <text x="${plateWidth / 2}" y="30" text-anchor="middle" font-size="22" font-weight="700" font-family="Arial, sans-serif" letter-spacing="2" fill="#101010">${safeText}</text>
    </svg>
  `;
}

function updatePlateTabStatus(channelId, newStatus) {
  // Localizar a <li> da aba
  console.log(channelId, newStatus)
  const tabLi = document.querySelector(`.tab-item[data-channel-id="${channelId}"]`);
  if (!tabLi) {
    console.warn(`Aba para canal ${channelId} não encontrada!`);
    return;
  }

  // Localizar o <span class="status-indicator"> dentro da aba
  const indicator = tabLi.querySelector('.status-indicator');
  if (!indicator) {
    console.warn(`status-indicator não encontrado dentro da aba de canal ${channelId}`);
    return;
  }

  // Remover cores antigas
  indicator.classList.remove('green','red','yellow','orange');

  // Baseado no `newStatus`, adicionar a cor
  switch (newStatus) {
    case 'running':
      indicator.classList.add('green');
      break;
    case 'starting':
    case 'connecting':
      indicator.classList.add('yellow');
      break;
    case 'reconnecting':
      indicator.classList.add('orange');
      break;
    case 'error':
      indicator.classList.add('red');
      break;
    default:
      indicator.classList.add('red');
      break;
  }
}

function setupDashboardPlateSocket() {
  // Remover event listeners anteriores se necessário
  socket.off('plate-found');
  // Outros off se precisar...

  // Ao receber plate-found, atualizar a tabela
  socket.on('plate-found', (data) => {
    console.log('Plate found event:', data);
    updateDashboardPlateTable(data);
  });

  // Você pode também escutar process-starting, process-stopped, process-error
  // e atualizar o statusMarquee se quiser. Caso contrário, remova se não precisar.
}

function setupDashboardSpeedSocket() {
  socket.off('plate-found-speed');

  socket.on('plate-found-speed', (data) => {
    console.log('Speed plate event:', data);
    updateDashboardSpeedTable(data);
  });
}

// Função para formatação de Data/Hora (reutilizada)
// function formatTimestamp(timestamp) {
//   const date = new Date(timestamp);
//   return date.toLocaleString('pt-BR');
// }

function loadDashboardIA() {
  const mainContent = document.getElementById('main-content');
  document.getElementById('page-title').innerText = 'Dashboard - IA';

  mainContent.innerHTML = '';
  const statusMarquee = document.createElement('div');
  statusMarquee.id = 'status-marquee';
  statusMarquee.className = 'status-marquee';
  mainContent.appendChild(statusMarquee);

  const tabsContainer = document.createElement('div');
  tabsContainer.classList.add('tabs-container');

  const tabsList = document.createElement('ul');
  tabsList.classList.add('tabs-list');

  const tabsContent = document.createElement('div');
  tabsContent.classList.add('tabs-content');

  fetch('/api/channels')
    .then(r => r.json())
    .then(allChannels => {
      const iaChannels = allChannels.filter(ch => ch.channel_type === 'ia');
      if (iaChannels.length === 0) {
        mainContent.innerHTML += '<p>Nenhum canal IA encontrado.</p>';
        return;
      }

      iaChannels.forEach((channel, index) => {
        const tabLi = document.createElement('li');
        tabLi.classList.add('tab-item');
        tabLi.textContent = channel.name;
        tabLi.setAttribute('data-channel-id', channel._id);
        tabLi.addEventListener('click', () => {
          activateIATab(channel._id);
        });
        tabsList.appendChild(tabLi);

        const tabPane = document.createElement('div');
        tabPane.id = `tab-pane-${channel._id}`;
        tabPane.classList.add('tab-pane');
        tabPane.innerHTML = `
          <table class="controle-table">
            <thead>
              <tr>
                <th>Evento</th>
                <th>Data/Hora</th>
              </tr>
            </thead>
            <tbody id="ia-tbody-${channel._id}">
            </tbody>
          </table>
        `;
        tabsContent.appendChild(tabPane);

        // Se for o primeiro, já ativar e carregar
        if (index === 0) {
          tabLi.classList.add('active');
          tabPane.classList.add('active-pane');
          loadLastIAEvents(channel._id);
        }
      });

      tabsContainer.appendChild(tabsList);
      tabsContainer.appendChild(tabsContent);
      mainContent.appendChild(tabsContainer);

      setupDashboardIASocket();
      loadInitialProcessState();
    })
    .catch(error => {
      console.error('Erro ao carregar canais IA:', error);
    });
}

function activateIATab(channelId) {
  const allTabs = document.querySelectorAll('.tab-item');
  const allPanes = document.querySelectorAll('.tab-pane');
  allTabs.forEach(tab => tab.classList.remove('active'));
  allPanes.forEach(pane => pane.classList.remove('active-pane'));

  const currentTab = document.querySelector(`.tab-item[data-channel-id="${channelId}"]`);
  if (currentTab) currentTab.classList.add('active');
  const currentPane = document.getElementById(`tab-pane-${channelId}`);
  if (currentPane) currentPane.classList.add('active-pane');

  loadLastIAEvents(channelId);
}

function loadLastIAEvents(channelId) {
  fetch(`/api/events/${channelId}`)
    .then(r => r.json())
    .then(events => {
      const last10 = events.slice(0, 10);
      const tbody = document.getElementById(`ia-tbody-${channelId}`);
      if (!tbody) return;
      tbody.innerHTML = '';

      last10.forEach(event => {
        updateDashboardIATable(event);
      });
    })
    .catch(error => console.error(`Erro ao buscar eventos do canal IA ${channelId}`, error));
}

function updateDashboardIATable(data) {
  // data: { channelId, eventData, timestamp, etc. }
  const { channelId, eventData, timestamp } = data;
  const tbody = document.getElementById(`ia-tbody-${channelId}`);
  if (!tbody) return;

  const newRow = document.createElement('tr');
  newRow.innerHTML = `
    <td>${eventData}</td>
    <td>${formatTimestamp(timestamp)}</td>
  `;
  tbody.insertBefore(newRow, tbody.firstChild);

  const rows = tbody.querySelectorAll('tr');
  if (rows.length > 10) {
    rows[rows.length - 1].remove();
  }
}

function setupDashboardIASocket() {
  // Remover events antigos se preciso
  socket.off('actionEvent');

  // Ao receber actionEvent (exemplo de evento IA), atualizar a tabela
  socket.on('actionEvent', (data) => {
    console.log('Evento de IA recebido:', data);
    updateDashboardIATable(data);
  });
}

let channelNameById = {}; // cache: channelId -> name

async function loadEventos() {
  const mainContent = document.getElementById('main-content');
  document.getElementById('page-title').innerText = 'Eventos';
  clearMosaicFrameCache();
  mainContent.innerHTML = '';

  // carregar canais p/ filtro (leve)
  try {
    const chResp = await fetch('/api/channels');
    const channels = await chResp.json();
    channelNameById = {};
    channels.forEach(ch => { channelNameById[ch._id] = ch.name; });
  } catch (e) {
    console.error('Erro ao carregar canais:', e);
    channelNameById = {};
  }

  const channelOptionsHtml = Object.entries(channelNameById)
    .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'pt-BR'))
    .map(([id, name]) => `<option value="${id}">${name}</option>`)
    .join('');

  const filtersHTML = `
    <div class="filter-container">
      <div class="filter-row">
        <select id="filter-canal-evento">
          <option value="">Selecione um Canal</option>
          ${channelOptionsHtml}
        </select>

        <input type="text" id="filter-placa-evento" placeholder="Placa (ex: ABC1D23)">
        <input type="number" id="filter-velocidade-evento" placeholder="Velocidade (km/h)" min="0" step="1">

        <input type="datetime-local" id="filter-data-inicial-evento">
        <input type="datetime-local" id="filter-data-final-evento">

        <button id="btn-buscar-eventos">Buscar</button>
        <button id="filter-clear-evento">Limpar</button>
      </div>
      <div class="filter-row">
        <small id="eventos-hint" style="opacity:.8">
          Defina ao menos um filtro e clique em “Buscar”.
        </small>
      </div>
    </div>
  `;

  const tableHTML = `
    <table id="eventos-table" class="styled-table">
      <thead>
        <tr>
          <th>Canal</th>
          <th>Placa</th>
          <th>Velocidade</th>
          <th>Data/Hora</th>
          <th>Imagem</th>
        </tr>
      </thead>
      <tbody>
        <tr><td colspan="5">Aguardando filtros…</td></tr>
      </tbody>
    </table>
  `;

  mainContent.innerHTML = filtersHTML + tableHTML;

  // Buscar apenas por ação explícita
  document.getElementById('btn-buscar-eventos').addEventListener('click', applyEventoFilters);

  // Enter dispara busca (opcional)
  ['filter-placa-evento','filter-velocidade-evento','filter-data-inicial-evento','filter-data-final-evento']
    .forEach(id => {
      const el = document.getElementById(id);
      el?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          applyEventoFilters();
        }
      });
    });

  document.getElementById('filter-clear-evento').addEventListener('click', clearEventoFilters);
}

function handleGrupoChangeEvento() {
  const grupoSelect = document.getElementById('filter-grupo-evento');
  const unidadeSelect = document.getElementById('filter-unidade-evento');
  const selectedGrupo = grupoSelect.value;

  unidadeSelect.innerHTML = '';

  if (selectedGrupo === '') {
    unidadeSelect.disabled = true;
    unidadeSelect.innerHTML = '<option value="">Selecione uma Unidade</option>';
  } else {
    unidadeSelect.disabled = false;
    const unidades = Array.from(window.grupoUnidadeMap[selectedGrupo]).sort();
    unidadeSelect.innerHTML = `<option value="">Todas as Unidades</option>${unidades.map(u => `<option value="${u}">${u}</option>`).join('')}`;
  }

  applyEventoFilters();
}

function applyEventoFilters() {
  const channelId = document.getElementById('filter-canal-evento').value;
  const plate = document.getElementById('filter-placa-evento').value.trim().toUpperCase();
  const speedStr = document.getElementById('filter-velocidade-evento').value.trim();
  const dateStart = document.getElementById('filter-data-inicial-evento').value;
  const dateEnd = document.getElementById('filter-data-final-evento').value;

  const hasAnyFilter = !!(channelId || plate || speedStr || dateStart || dateEnd);

  if (!hasAnyFilter) {
    const tbody = document.querySelector('#eventos-table tbody');
    tbody.innerHTML = '<tr><td colspan="5">Defina ao menos um filtro e clique em “Buscar”.</td></tr>';
    return;
  }

  const params = new URLSearchParams();
  if (channelId) params.append('channelId', channelId);
  if (plate) params.append('plate', plate);
  if (speedStr) params.append('speed', speedStr);
  if (dateStart) params.append('dateStart', dateStart);
  if (dateEnd) params.append('dateEnd', dateEnd);

  fetch('/filtered-events?' + params.toString())
    .then(r => r.json())
    .then(eventos => renderEventosTable(eventos))
    .catch(err => {
      console.error('Erro ao buscar eventos filtrados:', err);
      const tbody = document.querySelector('#eventos-table tbody');
      tbody.innerHTML = '<tr><td colspan="5">Erro ao buscar eventos.</td></tr>';
      showSnackMessage?.('Erro ao buscar eventos filtrados.', 'error');
    });
}

function clearEventoFilters() {
  document.getElementById('filter-canal-evento').value = '';
  document.getElementById('filter-placa-evento').value = '';
  document.getElementById('filter-velocidade-evento').value = '';
  document.getElementById('filter-data-inicial-evento').value = '';
  document.getElementById('filter-data-final-evento').value = '';

  const tbody = document.querySelector('#eventos-table tbody');
  tbody.innerHTML = '<tr><td colspan="5">Aguardando filtros…</td></tr>';
}

function renderEventosTable(eventos) {
  const tbody = document.querySelector('#eventos-table tbody');
  tbody.innerHTML = '';

  if (!Array.isArray(eventos) || eventos.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5">Nenhum evento encontrado.</td></tr>';
    return;
  }

  eventos.forEach(evt => {
    const channelId = evt.channelId || evt.channel_id || '';
    const channelName = channelNameById[channelId] || evt.channelName || channelId || '—';

    const customerInfo = evt.customerInfo || {};
    const plate = (customerInfo.plate || evt.plate || '').toUpperCase();

    // velocidade pode vir como evt.speed (number) ou evt.speedKmh
    const speedVal = (evt.speed ?? evt.speedKmh ?? evt.speedKmhValue);
    const speedText = (speedVal !== undefined && speedVal !== null && speedVal !== '')
      ? `${speedVal} km/h`
      : '';

    const ts = evt.timestamp || evt.ts || '';
    const dtText = ts ? formatTimestamp(ts) : '';

    const eventType = evt.eventType || '';
    const fileName = evt.fileName || '';
    const videoFileName = evt.videoFileName || '';


    // opcional: placa com SVG (igual dashboard)
    const plateHtml = plate ? `<div class="plate-svg-container">${generatePlateSVG(plate)}</div>` : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${channelName}</td>
      <td>${plateHtml || plate}</td>
      <td>${speedText}</td>
      <td>${dtText}</td>
      <td>
        ${
          (eventType === 'speed_plate' && fileName)
            ? `<button class="btn-open-image"
                data-plate="${plate}"
                data-timestamp="${ts}"
                data-fileName="${fileName}">
                Ver
              </button>`
            : (eventType === 'plate_only' && videoFileName)
              ? `<button class="btn-open-video"
                  data-plate="${plate}"
                  data-timestamp="${ts}"
                  data-videoFileName="${videoFileName}">
                  Ver
                </button>`
              : ''
        }
      </td>

    `;

    const btnImg = tr.querySelector('.btn-open-image');
    if (btnImg) {
      btnImg.addEventListener('click', () => {
        const btnPlate = btnImg.getAttribute('data-plate');
        const btnTimestamp = btnImg.getAttribute('data-timestamp');
        const btnFileName = btnImg.getAttribute('data-fileName');
        openSpeedCaptureModal(btnPlate, btnTimestamp, btnFileName); // /captures
      });
    }

    const btnVid = tr.querySelector('.btn-open-video');
    if (btnVid) {
      btnVid.addEventListener('click', () => {
        const btnPlate = btnVid.getAttribute('data-plate');
        const btnTimestamp = btnVid.getAttribute('data-timestamp');
        const btnVideoFileName = btnVid.getAttribute('data-videoFileName');
        openSpeedClipModal(btnPlate, btnTimestamp, btnVideoFileName); // /clips (vídeo)
      });
    }

    tbody.appendChild(tr);

  });
}

function extractPlatesFromDevices(devices) {
  if (!Array.isArray(devices)) return [];
  const seen = new Set();
  const plates = [];

  devices.forEach((device) => {
    const rawPlate = typeof device === 'string' ? device : device?.plate;
    const plate = String(rawPlate || '').trim().toUpperCase();
    if (!plate || seen.has(plate)) return;
    seen.add(plate);
    plates.push(plate);
  });

  return plates;
}

function normalizeCadastroUser(user) {
  return {
    userName: String(user?.userName || '').trim(),
    grupo: String(user?.grupo || '').trim(),
    unid: String(user?.unid || '').trim(),
    devices: Array.isArray(user?.devices) ? user.devices : [],
  };
}

function loadCadastros() {
  const mainContent = document.getElementById('main-content');
  document.getElementById('page-title').innerText = 'Cadastros';
  mainContent.innerHTML = '';
  cadastrosDebug('loadCadastros() iniciado');

  fetch('/plates')
    .then((response) => {
      if (!response.ok) {
        throw new Error('Erro ao buscar dados de cadastros.');
      }
      return response.json();
    })
    .then((data) => {
      cadastrosData = (Array.isArray(data) ? data : []).map(normalizeCadastroUser);
      cadastrosVehiclesData = [];
      grupoUnidadeMapCadastros = {};
      cadastrosDebug('payload /plates recebido', {
        users: cadastrosData.length,
      });

      cadastrosData.forEach((user) => {
        const grupo = user.grupo || 'Sem grupo';
        const unid = user.unid || 'Sem unidade';
        const userName = user.userName || 'Sem nome';
        const plates = extractPlatesFromDevices(user.devices);

        if (!grupoUnidadeMapCadastros[grupo]) {
          grupoUnidadeMapCadastros[grupo] = new Set();
        }
        grupoUnidadeMapCadastros[grupo].add(unid);

        plates.forEach((plate) => {
          cadastrosVehiclesData.push({
            userName,
            grupo,
            unid,
            plate,
          });
        });
      });

      cadastrosVehiclesData.sort((a, b) => {
        const byGroup = a.grupo.localeCompare(b.grupo, 'pt-BR', { sensitivity: 'base' });
        if (byGroup !== 0) return byGroup;

        const byUnid = a.unid.localeCompare(b.unid, 'pt-BR', { numeric: true, sensitivity: 'base' });
        if (byUnid !== 0) return byUnid;

        const byName = a.userName.localeCompare(b.userName, 'pt-BR', { sensitivity: 'base' });
        if (byName !== 0) return byName;

        return a.plate.localeCompare(b.plate, 'pt-BR', { sensitivity: 'base' });
      });
      cadastrosDebug('dados processados', {
        groups: Object.keys(grupoUnidadeMapCadastros).length,
        vehicles: cadastrosVehiclesData.length,
      });

      const filtersHTML = `
        <div class="filter-container">
          <div class="filter-row">
            <input type="text" id="filter-nome-cadastros" placeholder="Filtrar por Nome">
            <select id="filter-grupo-cadastros">
              <option value="">Todos os Grupos</option>
              ${
                Object.keys(grupoUnidadeMapCadastros)
                  .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }))
                  .map((g) => `<option value="${g}">${g}</option>`)
                  .join('')
              }
            </select>
            <select id="filter-unidade-cadastros" disabled>
              <option value="">Todas as Unidades</option>
            </select>
            <input type="text" id="filter-placa-cadastros" placeholder="Filtrar por Placa">
          </div>
          <div class="filter-row">
            <button id="filter-clear-cadastros">Limpar Filtros</button>
          </div>
        </div>
      `;

      const tableHTML = `
        <table class="styled-table" id="cadastros-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Grupo</th>
              <th>Unidade</th>
              <th>Placa</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      `;

      mainContent.innerHTML = filtersHTML + tableHTML;

      document.getElementById('filter-grupo-cadastros').addEventListener('change', handleGrupoChangeCadastros);
      document.getElementById('filter-unidade-cadastros').addEventListener('change', applyCadastrosFilters);
      document.getElementById('filter-nome-cadastros').addEventListener('input', applyCadastrosFilters);
      document.getElementById('filter-placa-cadastros').addEventListener('input', applyCadastrosFilters);
      document.getElementById('filter-clear-cadastros').addEventListener('click', clearCadastrosFilters);

      applyCadastrosFilters();
    })
    .catch((error) => {
      console.error(error);
      cadastrosDebug('erro loadCadastros()', error?.message || error);
      mainContent.innerHTML = '<p>Erro ao carregar cadastros. Tente novamente mais tarde.</p>';
    });
}

function handleGrupoChangeCadastros() {
  const grupoSelect = document.getElementById('filter-grupo-cadastros');
  const unidadeSelect = document.getElementById('filter-unidade-cadastros');
  const selectedGrupo = grupoSelect.value;
  cadastrosDebug('handleGrupoChangeCadastros()', { grupo: selectedGrupo || '(todos)' });

  if (!selectedGrupo) {
    unidadeSelect.disabled = true;
    unidadeSelect.innerHTML = '<option value="">Todas as Unidades</option>';
    applyCadastrosFilters();
    return;
  }

  const unidades = Array.from(grupoUnidadeMapCadastros[selectedGrupo] || []).sort((a, b) =>
    a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' })
  );

  unidadeSelect.disabled = false;
  unidadeSelect.innerHTML = `
    <option value="">Todas as Unidades</option>
    ${unidades.map((u) => `<option value="${u}">${u}</option>`).join('')}
  `;

  applyCadastrosFilters();
}

function applyCadastrosFilters() {
  const nomeValue = document.getElementById('filter-nome-cadastros').value.trim().toLowerCase();
  const grupoValue = document.getElementById('filter-grupo-cadastros').value;
  const unidadeSelect = document.getElementById('filter-unidade-cadastros');
  const unidadeValue = unidadeSelect.disabled ? '' : unidadeSelect.value;
  const placaValue = document.getElementById('filter-placa-cadastros').value.trim().toLowerCase();

  const filtered = cadastrosVehiclesData.filter((vehicle) => {
    const nomeMatch = vehicle.userName.toLowerCase().includes(nomeValue);
    const grupoMatch = grupoValue === '' || vehicle.grupo === grupoValue;
    const unidadeMatch = unidadeValue === '' || vehicle.unid === unidadeValue;
    const placaMatch = placaValue === '' || vehicle.plate.toLowerCase().includes(placaValue);
    return nomeMatch && grupoMatch && unidadeMatch && placaMatch;
  });
  cadastrosDebug('applyCadastrosFilters()', {
    nome: nomeValue,
    grupo: grupoValue || '(todos)',
    unidade: unidadeValue || '(todas)',
    placa: placaValue,
    total: cadastrosVehiclesData.length,
    filtered: filtered.length,
  });

  renderCadastrosTable(filtered);
}

function clearCadastrosFilters() {
  document.getElementById('filter-nome-cadastros').value = '';
  document.getElementById('filter-grupo-cadastros').value = '';
  document.getElementById('filter-unidade-cadastros').disabled = true;
  document.getElementById('filter-unidade-cadastros').innerHTML = '<option value="">Todas as Unidades</option>';
  document.getElementById('filter-placa-cadastros').value = '';
  applyCadastrosFilters();
}

function renderCadastrosTable(data) {
  const tbody = document.querySelector('#cadastros-table tbody');
  tbody.innerHTML = '';
  cadastrosDebug('renderCadastrosTable()', { rows: Array.isArray(data) ? data.length : 0 });

  if (!Array.isArray(data) || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4">Nenhum cadastro encontrado.</td></tr>';
    return;
  }

  data.forEach((vehicle) => {
    const rowHTML = `
      <tr>
        <td>${vehicle.userName}</td>
        <td>${vehicle.grupo}</td>
        <td>${vehicle.unid}</td>
        <td>${vehicle.plate}</td>
      </tr>
    `;
    tbody.insertAdjacentHTML('beforeend', rowHTML);
  });
}

// ------------------------ R A D A R   S P E E D ------------------------

const paramsStatusEl = document.getElementById('paramsStatus');
const paramEls = {
  X1: document.getElementById('pX1'),
  X2: document.getElementById('pX2'),
  X3: document.getElementById('pX3'),
  X4: document.getElementById('pX4'),
  X5: document.getElementById('pX5'),
  X6: document.getElementById('pX6'),
};

function clamp(v, min, max){
  if (isNaN(v)) v = min;
  if (v < min) v = min;
  if (v > max) v = max;
  return v;
}

function toHex2(v){
  return v.toString(16).toUpperCase().padStart(2,'0');
}

function describeDir(v){
  if (v === 0) return 'Ambos';
  if (v === 1) return 'Aproximando';
  if (v === 2) return 'Afastando';
  return String(v);
}

function describeUnit(v){
  if (v === 0) return 'km/h';
  if (v === 1) return 'mph';
  if (v === 2) return 'm/s';
  return String(v);
}

function markParamsLoaded(){
  if (paramsStatusEl) {
    paramsStatusEl.textContent = 'Parâmetros recebidos do radar (X1..X6).';
  }
}

// envia comandos pro tópico "settings" (via /api/settings)
async function sendRadarSettings(cmd){
  try {
    await fetch('/api/settings', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ cmd })
    });
    console.log('→ settings:', cmd);
  } catch (err) {
    console.error('Erro ao enviar settings:', err);
  }
}

// parseia a linha "X1:.." vinda do tópico settings
function parseRadarConfigLine(line){
  if (!line || !line.includes('X1:')) return;

  const re = /X([0-9]):([0-9A-Fa-f]{2})/g;
  let m;
  const vals = {};
  while ((m = re.exec(line)) !== null) {
    const key = 'X' + m[1];
    vals[key] = parseInt(m[2], 16);
  }

  if (vals.X1 != null) paramEls.X1.textContent = `${vals.X1} km/h (0x${toHex2(vals.X1)})`;
  if (vals.X2 != null) paramEls.X2.textContent = `${vals.X2}° (0x${toHex2(vals.X2)})`;
  if (vals.X3 != null) paramEls.X3.textContent = `${vals.X3} (0x${toHex2(vals.X3)})`;
  if (vals.X4 != null) paramEls.X4.textContent = `${describeDir(vals.X4)} (0x${toHex2(vals.X4)})`;
  if (vals.X5 != null) paramEls.X5.textContent = `${vals.X5} (0x${toHex2(vals.X5)})`;
  if (vals.X6 != null) paramEls.X6.textContent = `${describeUnit(vals.X6)} (0x${toHex2(vals.X6)})`;

  markParamsLoaded();
}

// ouvir mensagens MQTT vindas do backend
socket.on('mqtt', (data) => {
  // { type:'mqtt', topic, payload, ts }
  if (data.topic === 'settings') {
    parseRadarConfigLine(data.payload);
  }
  // se quiser, aqui você também captura velocidades de readSpeed, etc.
  // if (data.topic === 'readSpeed') { ... }
});

// helper pra esconder todos os blocos de config dentro do modal
function hideAllRadarCfgBlocks(){
  ['cfg1Block','cfg2Block','cfg3Block','cfg4Block'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

// abrir modal de radar
function openRadarConfigModal(channel) {
  const modal = document.getElementById('radarConfigModal');
  if (!modal) return;

  // opcional: mostra o nome do canal ali no título
  const chNameEl = document.getElementById('radarChannelName');
  if (chNameEl && channel && channel.name) {
    chNameEl.textContent = `– ${channel.name}`;
  }

  hideAllRadarCfgBlocks();
  modal.style.display = 'block';

  // quando abrir, pede pro radar enviar os parâmetros atuais
  sendRadarSettings('r');
}

// fechar modal (X)
document.getElementById('closeRadarConfigModal')?.addEventListener('click', () => {
  const modal = document.getElementById('radarConfigModal');
  if (modal) modal.style.display = 'none';
  hideAllRadarCfgBlocks();
});

// fechar clicando fora
window.addEventListener('click', (ev) => {
  const modal = document.getElementById('radarConfigModal');
  if (ev.target === modal) {
    modal.style.display = 'none';
    hideAllRadarCfgBlocks();
  }
});

// botão "Ler parâmetros (r)"
document.getElementById('btnReadParams')?.addEventListener('click', () => {
  sendRadarSettings('r');
});

// abrir bloco Config 1
document.getElementById('btnCfg1')?.addEventListener('click', () => {
  hideAllRadarCfgBlocks();
  const b = document.getElementById('cfg1Block');
  if (b) b.style.display = 'block';
});

// abrir bloco Config 2
document.getElementById('btnCfg2')?.addEventListener('click', () => {
  hideAllRadarCfgBlocks();
  const b = document.getElementById('cfg2Block');
  if (b) b.style.display = 'block';
});

// abrir bloco Config 3
document.getElementById('btnCfg3')?.addEventListener('click', () => {
  hideAllRadarCfgBlocks();
  const b = document.getElementById('cfg3Block');
  if (b) b.style.display = 'block';
});

// abrir bloco Config 4
document.getElementById('btnCfg4')?.addEventListener('click', () => {
  hideAllRadarCfgBlocks();
  const b = document.getElementById('cfg4Block');
  if (b) b.style.display = 'block';
});

// --------- AÇÕES DOS BOTÕES DENTRO DOS BLOCOS ---------

// Config 1 (X1,X2,X3 -> C1 XX YY ZZ)
document.getElementById('cfg1_send')?.addEventListener('click', async () => {
  let x1 = clamp(parseInt(document.getElementById('cfg1_x1').value, 10), 0, 255);
  let x2 = clamp(parseInt(document.getElementById('cfg1_x2').value, 10), 0, 45);
  let x3 = clamp(parseInt(document.getElementById('cfg1_x3').value, 10), 1, 15);

  document.getElementById('cfg1_x1').value = x1;
  document.getElementById('cfg1_x2').value = x2;
  document.getElementById('cfg1_x3').value = x3;

  const cmd = `C1 ${toHex2(x1)} ${toHex2(x2)} ${toHex2(x3)}`;
  await sendRadarSettings(cmd);
  hideAllRadarCfgBlocks();
});

document.getElementById('cfg1_cancel')?.addEventListener('click', hideAllRadarCfgBlocks);

// Config 2 (X4,X5,X6 -> C2 XX YY ZZ)
document.getElementById('cfg2_send')?.addEventListener('click', async () => {
  let x4 = clamp(parseInt(document.getElementById('cfg2_x4').value, 10), 0, 2);
  let x5 = clamp(parseInt(document.getElementById('cfg2_x5').value, 10), 0, 255);
  let x6 = clamp(parseInt(document.getElementById('cfg2_x6').value, 10), 0, 2);

  document.getElementById('cfg2_x4').value = x4;
  document.getElementById('cfg2_x5').value = x5;
  document.getElementById('cfg2_x6').value = x6;

  const cmd = `C2 ${toHex2(x4)} ${toHex2(x5)} ${toHex2(x6)}`;
  await sendRadarSettings(cmd);
  hideAllRadarCfgBlocks();
});

document.getElementById('cfg2_cancel')?.addEventListener('click', hideAllRadarCfgBlocks);

// Config 3 (HOLD -> C3 NNNN)
document.getElementById('cfg3_send')?.addEventListener('click', async () => {
  let ms = clamp(parseInt(document.getElementById('cfg3_hold').value, 10), 200, 15000);
  document.getElementById('cfg3_hold').value = ms;
  const cmd = `C3 ${ms}`;
  await sendRadarSettings(cmd);
  hideAllRadarCfgBlocks();
});

document.getElementById('cfg3_cancel')?.addEventListener('click', hideAllRadarCfgBlocks);

// Config 4 (distância inicial -> C4 NNN)
document.getElementById('cfg4_send')?.addEventListener('click', async () => {
  let m = clamp(parseInt(document.getElementById('cfg4_dist').value, 10), 1, 200);
  document.getElementById('cfg4_dist').value = m;
  const cmd = `C4 ${m}`;
  await sendRadarSettings(cmd);
  hideAllRadarCfgBlocks();
});

document.getElementById('cfg4_cancel')?.addEventListener('click', hideAllRadarCfgBlocks);




function ensureSpeedImageModal() {
  let modal = document.getElementById('speedImageModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'speedImageModal';
    modal.className = 'modal speed-image-modal';

    modal.innerHTML = `
      <div class="modal-content speed-image-modal-content">
        <span class="close" id="closeSpeedImageModal">&times;</span>
        <img id="speedCaptureImage" style="max-width: 100%; max-height: 80vh; display: block; margin: 0 auto;" />
        <div id="speedImageCaption" style="margin-top: 8px; text-align: center;"></div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = document.getElementById('closeSpeedImageModal');
    const imgEl = document.getElementById('speedCaptureImage');

    closeBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      imgEl.src = '';
    });

    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) {
        modal.style.display = 'none';
        imgEl.src = '';
      }
    });
  }
  return modal;
}

function isVideoFile(fileName) {
  if (!fileName) return false;
  const clean = String(fileName).split('?')[0].toLowerCase();
  return clean.endsWith('.mp4') || clean.endsWith('.webm') || clean.endsWith('.ogg');
}

function buildMediaUrl(fileName) {
  // Se o backend já mandar com pasta (/captures/xxx.mp4), respeita.
  if (String(fileName).startsWith('/')) return String(fileName);
  // Caso contrário, mantém o padrão que você já usa para imagens:
  return `/captures/${fileName}`;
}

function ensureSpeedVideoModal() {
  // Se o modal já existe no HTML, ele deve ter estes IDs:
  // speedVideoModal, closeSpeedVideoModal, speedCaptureVideo, speedVideoCaption
  let modal = document.getElementById('speedVideoModal');

  if (!modal) {
    // Fallback: se não existir no HTML, criamos um (não quebra nada).
    modal = document.createElement('div');
    modal.id = 'speedVideoModal';
    modal.className = 'modal speed-video-modal';

    modal.innerHTML = `
      <div class="modal-content speed-video-modal-content">
        <span class="close" id="closeSpeedVideoModal">&times;</span>

        <video id="speedCaptureVideo" controls
               style="max-width: 100%; max-height: 80vh; display:block; margin: 0 auto;">
        </video>

        <div id="speedVideoCaption" style="margin-top: 8px; text-align: center;"></div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  const closeBtn = document.getElementById('closeSpeedVideoModal');
  const videoEl  = document.getElementById('speedCaptureVideo');

  // Evita múltiplos listeners duplicados
  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', () => {
      modal.style.display = 'none';
      if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
      }
    });
  }

  if (modal && !modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) {
        modal.style.display = 'none';
        if (videoEl) {
          videoEl.pause();
          videoEl.removeAttribute('src');
          videoEl.load();
        }
      }
    });
  }

  return modal;
}

function openSpeedCaptureModal(plate, timestamp, fileName) {
  if (!fileName) {
    console.warn('Sem fileName para abrir mídia (imagem/vídeo).');
    return;
  }

  const url = buildMediaUrl(fileName);
  const captionText = `${plate} – ${formatTimestamp(timestamp)}`;

  // Senão -> imagem (mantém seu comportamento atual)
  const modal = ensureSpeedImageModal();
  const imgEl = document.getElementById('speedCaptureImage');
  const captionEl = document.getElementById('speedImageCaption');

  imgEl.src = url;
  captionEl.textContent = captionText;

  imgEl.onerror = () => {
    captionEl.textContent = `Imagem não encontrada em: ${url}`;
  };

  modal.style.display = 'block';
}

function getLastVideoModal() {
  const modals = document.querySelectorAll('#videoModal');
  if (!modals || modals.length === 0) return null;
  return modals[modals.length - 1]; // <-- pega o ÚLTIMO (o que tem <video id="videoPlayer">)
}

function openSpeedClipModal(plate, timestamp, videoFileName) {
  if (!videoFileName) {
    console.warn('Sem videoFileName para abrir clip.');
    return;
  }

  // pega o ÚLTIMO #videoModal do HTML (você tem dois IDs duplicados no arquivo)
  const modals = document.querySelectorAll('#videoModal');
  const modal = (modals && modals.length) ? modals[modals.length - 1] : null;
  if (!modal) {
    console.error('Nenhum #videoModal encontrado no HTML.');
    return;
  }

  const videoEl = modal.querySelector('#videoPlayer') || modal.querySelector('video');
  if (!videoEl) {
    console.error('Modal encontrado, mas nenhum <video> dentro dele.');
    return;
  }

  const errEl = modal.querySelector('#videoError');
  const modalContent = videoEl.closest('.modal-content');

  // 1) Layout: modal fixo 640x480 (CSS controla pela classe)
  if (modalContent) {
    modalContent.classList.add('video-640');

    // garantir: sem scroll/padding (caso CSS não carregue por algum motivo)
    modalContent.style.overflow = 'hidden';
    modalContent.style.padding = '0';
    modalContent.style.width = '640px';
    modalContent.style.height = '480px';
    modalContent.style.maxWidth = '640px';
    modalContent.style.maxHeight = '480px';

    // sem título
    const h2 = modalContent.querySelector('h2');
    if (h2) h2.style.display = 'none';
  }

  // 2) Autoplay (browsers exigem muted)
  videoEl.autoplay = true;
  videoEl.muted = true;
  videoEl.playsInline = true;

  // 3) Bind fechar (uma vez)
  if (modal.dataset.clipBound !== '1') {
    modal.dataset.clipBound = '1';

    const closeBtn = modal.querySelector('#closeVideoModal') || modal.querySelector('.close');

    const close = () => {
      modal.style.display = 'none';
      try { videoEl.pause(); } catch (_) {}
      videoEl.removeAttribute('src');
      videoEl.load();
      if (errEl) errEl.style.display = 'none';
    };

    closeBtn?.addEventListener('click', close);

    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) close();
    });
  }

  // 4) Carregar vídeo
  const url = `/clips/${videoFileName}`;
  if (errEl) errEl.style.display = 'none';

  videoEl.onerror = () => {
    if (errEl) errEl.style.display = 'block';
    console.log(errEl)
    console.error('Erro ao carregar vídeo:', url);
  };

  // opcional: limpa antes de setar novo src
  try { videoEl.pause(); } catch (_) {}
  videoEl.removeAttribute('src');
  videoEl.load();

  videoEl.src = url;
  videoEl.load();

  modal.style.display = 'block';

  // tenta autoplay (fallback)
  const p = videoEl.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      // Se bloquear, o modal abre e o usuário dá play.
    });
  }
}

let areaOptions = [];

async function loadAreasOptions() {

  areaOptions = [];

  try {
    // const resp = await fetch(`/api/vision/areas/${condId}`);
    const resp = await fetch(`/api/plate/areas`); 
    if (!resp.ok) {
      console.error('Falha ao obter áreas do servidor');
      return [];
    }
    areaOptions = await resp.json(); // [{label, value}, ...]
    return areaOptions;
  } catch (e) {
    console.error('Erro em loadAreasOptions:', e);
    areaOptions = [];
    return [];
  }
}

function fillAreaSelect(selectElement, options) {
  if (!selectElement) return;

  // limpa
  selectElement.innerHTML = '<option value="">Selecione uma área</option>';

  options.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value;      // id da área
    o.textContent = opt.label;
    selectElement.appendChild(o);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  // Se já vier com hash, respeita; se não, abre no dashboard
  if (!location.hash) {
    location.hash = '#dashboard-speed';
  }

  // Carrega a tela inicial do dashboard
  loadDashboardSpeed(); // ou loadDashboardSpeed()
});
