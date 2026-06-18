# Streaming MPEG-TS via WebSocket (porta única) - DozzPlateLast

Este projeto entrega vídeo no mosaico por `MPEG-TS + WebSocket` no mesmo servidor HTTP (`:4000`), sem necessidade de abrir portas adicionais.

## 1) Variáveis de ambiente (`.env`)

```env
# Modo de entrega no frontend (mosaico)
# valores: mpegts | socket
VIDEO_DELIVERY_MODE=mpegts

# Se true, cai para Socket.IO/JPEG quando o MPEG-TS não abrir
VIDEO_SOCKET_FALLBACK=true

# Path lógico por canal (metadado)
MEDIA_STREAM_PATH_TEMPLATE={channelId}

# Liga/desliga endpoint WS de MPEG-TS
MPEGTS_WS_ENABLED=true

# Ajustes de encode MPEG-TS (ffmpeg no Node)
MPEGTS_DEFAULT_FPS=12
MPEGTS_BITRATE_KBPS=1600
MPEGTS_QUALITY=6
MPEGTS_IDLE_STOP_MS=8000
MPEGTS_STDIN_MAX_BUFFER_BYTES=1048576

# Preview socket vindo do Python (fonte do MPEG-TS)
SOCKET_PREVIEW_ENABLED=true
```

## 2) Endpoint de configuração por canal

O frontend consulta:

- `GET /api/video-stream/:channelId`

Resposta inclui `mode`, `mpegtsWsUrl`, `streamPath` e `socketFallback`.

## 3) Fluxo atual

1. `plateReader.py` / `speed.py` enviam frame JPEG anotado para o Node (evento `frame`).
2. O Node injeta esses frames em um `ffmpeg` por canal (`mjpeg -> mpeg1video/mpegts`).
3. O Node publica no WebSocket `ws(s)://<host>:4000/ws/mpegts/:channelId`.
4. O frontend usa `JSMpeg` no mosaico.
5. Se falhar, cai para Socket.IO/JPEG.

## 4) Observações

- Não precisa MediaMTX para este modo.
- Não precisa abrir novas portas além da já usada pelo sistema web.
- Eventos de placa/comando continuam via Socket.IO.
