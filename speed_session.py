#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import cv2
import time
import string
import os
import sys
import argparse
import socketio
import numpy as np
import psutil
import GPUtil
from datetime import datetime
from ultralytics import YOLO
import warnings

warnings.filterwarnings("ignore")

SERVER_URL = "http://localhost:4000"

# ==========================
# CONFIGURAÇÕES
# ==========================
TARGET_FPS_DEFAULT = 3
OCR_MEAN_CONF_THRESHOLD = 0.2
PLATE_MARQUEE_SECONDS = 5.0
GAP_TIMEOUT_S = 0.4
DIFF_NORM_THRESHOLD = 0.5
MIN_SAMPLES_BEFORE_DIFF = 3
LIVE_CAPTURE_MIN_VOTES = 5   # número de leituras para encerrar sessão em modo live
SESSION_MAX_DURATION_S = 3.0  # tempo máximo de coleta de votos

# ==========================
# UTILS / FORMATAÇÃO
# ==========================
def remove_leading_zero(token: str) -> str:
    """
    Remove zero à esquerda de tokens vindos do OCR (ex.: '01' -> '1').
    Isso imita o comportamento original que limpava zeros de tokens numéricos.
    """
    if token.startswith('0') and len(token) > 1:
        return token[1:]
    return token


def license_complies_format(text: str) -> bool:
    """
    Aceita somente:
      - Antiga:   LLLNNNN
      - Mercosul: LLLNLNN
    Sem substituição de caracteres parecidos.
    """
    if len(text) != 7:
        return False

    # Antiga: LLLNNNN
    if text[0:3].isalpha() and text[3:].isdigit():
        return True

    # Mercosul: LLLNLNN
    if text[0:3].isalpha() and text[3].isdigit() and text[4].isalpha() and text[5:].isdigit():
        return True

    return False


def sanitize_filename(filename):
    valid_chars = "-_.() %s%s" % (string.ascii_letters, string.digits)
    return ''.join(c for c in filename if c in valid_chars)


# ==========================
# OCR
# ==========================
def read_license_plate_both(crop, ocr_model, img_size):
    """
    Retorna:
      - raw_text: texto lido (sem mapeamento de caracteres, apenas removendo zeros à esquerda nos tokens)
      - avg_conf: confiança média
      - compliant_text: raw_text se bater com LLLNNNN ou LLLNLNN, senão None
      - line_mode: "single" (1 linha → Carro), "double" (2 linhas → Moto) ou None

    Usa X e Y dos boxes do OCR para tratar placa em 1 linha (carro)
    ou 2 linhas (moto Mercosul).
    """
    try:
        detections = ocr_model.predict(crop, imgsz=img_size, verbose=False)
    except Exception:
        return None, None, None, None

    for detection in detections:
        boxes = detection.boxes
        if boxes is None or len(boxes) == 0:
            continue

        class_ids = boxes.cls
        confs = boxes.conf
        xyxy = boxes.xyxy
        class_names = detection.names

        det_list = []
        for box, cls, conf in zip(xyxy, class_ids, confs):
            x1 = float(box[0])
            y1 = float(box[1])
            x2 = float(box[2])
            y2 = float(box[3])

            x_min = x1
            y_center = (y1 + y2) / 2.0
            height = (y2 - y1)

            ch = class_names[int(cls)]
            ch_clean = remove_leading_zero(ch)

            det_list.append((x_min, y_center, height, ch_clean, float(conf)))

        if not det_list:
            continue

        # ----- decide se é 1 linha ou 2 linhas -----
        ys = [d[1] for d in det_list]
        hs = [d[2] for d in det_list]

        avg_h = sum(hs) / len(hs)
        vertical_span = max(ys) - min(ys)

        SINGLE_LINE_THRESHOLD = 0.6  # fator em relação à altura média

        if vertical_span < SINGLE_LINE_THRESHOLD * avg_h:
            # 1 linha (carro): ordena tudo por X
            line_mode = "single"
            ordered = sorted(det_list, key=lambda d: d[0])
        else:
            # 2 linhas (moto): separa por Y e lê topo depois base
            line_mode = "double"
            mid_y = (max(ys) + min(ys)) / 2.0
            top_line = [d for d in det_list if d[1] <= mid_y]
            bottom_line = [d for d in det_list if d[1] > mid_y]

            top_line.sort(key=lambda d: d[0])
            bottom_line.sort(key=lambda d: d[0])

            ordered = top_line + bottom_line

        # ----- monta texto e confiança média -----
        chars = [d[3] for d in ordered]   # ch_clean
        conf_vals = [d[4] for d in ordered]

        plate_raw = ''.join(chars)
        raw_text = plate_raw.upper().replace(" ", "")

        avg_conf = sum(conf_vals) / len(conf_vals) if conf_vals else 0.0

        compliant = raw_text if license_complies_format(raw_text) else None

        return raw_text, avg_conf, compliant, line_mode

    return None, None, None, None


# ==========================
# AGRUPAMENTO
# ==========================
def levenshtein(a, b):
    if a == b:
        return 0
    if len(a) == 0:
        return len(b)
    if len(b) == 0:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            ins = prev[j] + 1
            dele = cur[j - 1] + 1
            sub = prev[j - 1] + (ca != cb)
            cur.append(min(ins, dele, sub))
        prev = cur
    return prev[-1]


def normalized_distance(a, b):
    if not a and not b:
        return 0.0
    return levenshtein(a, b) / float(max(len(a), len(b), 1))


class PlateSession:
    """
    Guarda:
      - votos por texto
      - soma das confianças
      - melhor crop + melhor frame full (por score área*confiança)
    """
    def __init__(self):
        self.counts = {}
        self.conf_sums = {}
        self.last_read_ts = 0.0
        self.total_reads = 0
        self.start_ts = None
        
        self.best_crop = None
        self.best_full = None
        self.best_score = 0.0

    def add(self, text, conf, crop, full_frame):
        # inicia a janela de tempo apenas uma vez
        if self.start_ts is None:
            self.start_ts = time.time()

        # ---- votos SEMPRE entram ----
        self.counts[text] = self.counts.get(text, 0) + 1
        self.conf_sums[text] = self.conf_sums.get(text, 0.0) + conf
        self.last_read_ts = time.time()
        self.total_reads += 1

        # ---- melhor imagem ----
        if crop is not None and crop.size > 0:
            h, w = crop.shape[:2]
            area = w * h
            score = conf * (area / 5000.0)

            if score > self.best_score:
                self.best_score = score
                self.best_crop = crop.copy()
                self.best_full = full_frame.copy()


    def age_since_start(self):
        if self.start_ts is None:
            return 0.0
        return time.time() - self.start_ts

    def has_data(self):
        return self.total_reads > 0

    def mode(self):
        if not self.has_data():
            return None, 0, 0.0
        best_t, best_cnt, best_avg = None, -1, -1.0
        for t, cnt in self.counts.items():
            avg = self.conf_sums[t] / cnt
            if cnt > best_cnt or (cnt == best_cnt and avg > best_avg):
                best_t, best_cnt, best_avg = t, cnt, avg
        return best_t, best_cnt, best_avg

    def age_since_last(self):
        if self.last_read_ts == 0:
            return 1e9
        return time.time() - self.last_read_ts

    def get_best_images(self):
        return self.best_crop, self.best_full

    def clear(self):
        self.__init__()


# ==========================
# UI
# ==========================
def draw_plate_marquee(frame, text, last_plate_time, duration, layout_label=None):
    """
    Mostra um retângulo estilizado no topo:
      - linha menor com CARRO/MOTO (uppercase)
      - linha maior com a placa
    """
    if not text:
        return
    if (time.time() - last_plate_time) > duration:
        return

    h, w = frame.shape[:2]

    # Escala base
    base_scale = max(1.0, min(w, h) / 300.0)

    # Placa grande, label menor
    plate_scale = base_scale * 1.3
    label_scale = base_scale * 0.6

    plate_thick = max(2, int(plate_scale * 2))
    label_thick = max(1, int(label_scale * 2))

    font = cv2.FONT_HERSHEY_SIMPLEX

    plate_text = text.upper()
    label_text = layout_label.upper() if layout_label else ""

    # Tamanhos de texto
    (tw_plate, th_plate), base_plate = cv2.getTextSize(plate_text, font, plate_scale, plate_thick)
    if label_text:
        (tw_label, th_label), base_label = cv2.getTextSize(label_text, font, label_scale, label_thick)
    else:
        tw_label, th_label, base_label = 0, 0, 0

    line_spacing = int(8 * base_scale)
    margin_x = int(18 * base_scale)
    # 🔽 antes era 14 * base_scale, bem grande; agora está mais “justo”
    margin_y = int(6 * base_scale)

    total_width = max(tw_plate, tw_label)
    total_text_height = th_plate + (th_label + line_spacing if label_text else 0)

    # Posição centralizada
    x_left = (w - total_width) // 2
    top_y = int(20 * base_scale)

    if label_text:
        y_label = top_y + th_label
        y_plate = y_label + line_spacing + th_plate
    else:
        y_label = None
        y_plate = top_y + th_plate

    x_plate = x_left + (total_width - tw_plate) // 2
    x_label = x_left + (total_width - tw_label) // 2 if label_text else None

    rect_top = top_y - margin_y
    rect_bottom = (y_plate + base_plate + margin_y)
    rect_left = x_left - margin_x
    rect_right = x_left + total_width + margin_x

    # ---- FUNDO ESTILIZADO (shadow + box) ----
    overlay = frame.copy()

    # Sombra leve
    shadow_offset = int(4 * base_scale)
    cv2.rectangle(
        overlay,
        (rect_left + shadow_offset, rect_top + shadow_offset),
        (rect_right + shadow_offset, rect_bottom + shadow_offset),
        (0, 0, 0),
        -1
    )

    # Caixa principal (branca)
    cv2.rectangle(
        overlay,
        (rect_left, rect_top),
        (rect_right, rect_bottom),
        (255, 255, 255),
        -1
    )

    # Aplica overlay com transparência
    alpha = 0.85
    cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, frame)

    # Borda vermelha fina
    cv2.rectangle(
        frame,
        (rect_left, rect_top),
        (rect_right, rect_bottom),
        (0, 0, 255),
        max(1, int(base_scale * 2))
    )

    # ---- TEXTOS ----
    # Label CARRO/MOTO menor
    if label_text and x_label is not None and y_label is not None:
        cv2.putText(
            frame,
            label_text,
            (x_label, y_label),
            font,
            label_scale,
            (0, 0, 180),
            label_thick,
            cv2.LINE_AA
        )

    # Placa grande
    cv2.putText(
        frame,
        plate_text,
        (x_plate, y_plate),
        font,
        plate_scale,
        (0, 0, 0),
        plate_thick,
        cv2.LINE_AA
    )

def draw_session_badge(frame, session: PlateSession):
    if not session.has_data():
        return
    text, cnt, avg = session.mode()
    badge = f"votos: {cnt} | avg: {avg:.2f}"

    font = cv2.FONT_HERSHEY_SIMPLEX
    fs = 0.8
    th = 2
    size, _ = cv2.getTextSize(badge, font, fs, th)

    x, y = 20, 40
    cv2.rectangle(frame, (x - 10, y - 25), (x + size[0] + 10, y + 10), (255, 255, 255), -1)
    cv2.rectangle(frame, (x - 10, y - 25), (x + size[0] + 10, y + 10), (0, 0, 0), 2)
    cv2.putText(frame, badge, (x, y), font, fs, (0, 0, 0), th, cv2.LINE_AA)


def draw_debug_reads(frame, debug_lines, max_lines=8):
    """
    Mantido para debug futuro, mas não está mais sendo desenhado na tela
    (a chamada foi removida).
    """
    if not debug_lines:
        return

    font = cv2.FONT_HERSHEY_SIMPLEX
    fs = 0.5
    th = 1
    x = 20
    y_start = 70
    line_height = 18

    lines = debug_lines[-max_lines:]
    for i, line in enumerate(lines):
        y = y_start + i * line_height
        cv2.putText(frame, line, (x, y), font, fs, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(frame, line, (x, y), font, fs, (0, 0, 0), th, cv2.LINE_AA)


# ==========================
# PERFORMANCE
# ==========================
def measure_performance(plate_model, ocr_model, sio, channel_id, base_path, img_size):
    img_path = os.path.join(base_path, "perf", "img.jpg")
    img = cv2.imread(img_path)
    if img is None:
        return

    start = time.time()
    results = plate_model.predict(img, imgsz=img_size, verbose=False)
    for box in results[0].boxes:
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        crop = img[y1:y2, x1:x2]
        # chamada apenas para medir, ignorando retornos
        read_license_plate_both(crop, ocr_model, img_size)
    end = time.time()

    t = end - start
    fps = 1 / t if t > 0 else 0

    cpu = psutil.cpu_percent()
    ram = psutil.virtual_memory().percent

    gpus = GPUtil.getGPUs()
    if gpus:
        gpu = gpus[0]
        gpu_load = gpu.load * 100
        gpu_mem = gpu.memoryUtil * 100
    else:
        gpu_load = gpu_mem = 0

    try:
        sio.emit("performance-report", {
            "channelId": channel_id,
            "data": {
                "avg_fps": round(fps, 2),
                "cpu_usage": cpu,
                "ram_usage": ram,
                "gpu_usage": round(gpu_load, 1),
                "gpu_memory_usage": round(gpu_mem, 1)
            }
        })
    except Exception:
        pass


# ==========================
# MAIN
# ==========================
def main():
    parser = argparse.ArgumentParser(description="Speed PlateReader simples com Socket.IO.")
    parser.add_argument("--ip", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--frame_rate", type=int, default=TARGET_FPS_DEFAULT)
    parser.add_argument("--device", type=str, default="cpu")
    parser.add_argument("--channel_id", required=True)
    parser.add_argument("--radarId", required=True)
    parser.add_argument("--dvr_channel", required=True)
    parser.add_argument("--actions", required=False)
    parser.add_argument("--areas", required=False)
    parser.add_argument("--imgsz", type=int, default=480)

    args = parser.parse_args()

    img_size = args.imgsz

    # base_path
    if getattr(sys, "frozen", False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.abspath(".")

    device = "cuda" if args.device.lower() in ["cuda", "gpu"] else "cpu"

    plate_model_path = os.path.join(base_path, "models", "plate.pt")
    ocr_model_path = os.path.join(base_path, "models", "ocr.pt")

    if not os.path.exists(plate_model_path) or not os.path.exists(ocr_model_path):
        print("ERRO: modelos não encontrados.", file=sys.stderr)
        sys.exit(1)

    try:
        plate_model = YOLO(plate_model_path)
        ocr_model = YOLO(ocr_model_path)
        plate_model.to(device)
        ocr_model.to(device)
    except Exception as e:
        print(f"Aviso ao mover modelos para {device}: {e}", file=sys.stderr)
        device = "cpu"

    rtsp = f"rtsp://{args.user}:{args.password}@{args.ip}:554/cam/realmonitor?channel={args.dvr_channel}&subtype=0"
    cap = cv2.VideoCapture(rtsp)

    sio = socketio.Client()

    @sio.event
    def connect():
        sio.emit("join", args.channel_id)

    try:
        sio.connect(SERVER_URL)
    except Exception as e:
        print(f"Erro ao conectar Socket.IO: {e}", file=sys.stderr)
        sys.exit(1)

    if not cap.isOpened():
        try:
            sio.emit("process-error", {"channelId": args.channel_id, "errorType": "open_video_error"})
        except Exception:
            pass
    else:
        try:
            sio.emit("process-started", {"channelId": args.channel_id})
        except Exception:
            pass

    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        fps = TARGET_FPS_DEFAULT
    skip_frames = int(max(1, round(fps / max(1, args.frame_rate))))

    session = PlateSession()
    last_final_plate = None
    last_final_ts = 0.0
    last_final_layout_label = None  # "Carro" ou "Moto"
    session_last_line_mode = None   # "single" ou "double"

    # pasta final das capturas
    plates_dir = os.path.join("public", "captures")
    os.makedirs(plates_dir, exist_ok=True)

    frame_count = 0
    last_perf = time.time()

    # buffer de debug das leituras individuais (não desenhado na tela)
    debug_lines = []

    # ==========================
    # BUFFER DE FRAME PARA LEITURA DE VELOCIDADE (SEM PLACA)
    # ==========================
    speed_frame_buffer = {}      # {"frame": np.ndarray, "meta": {...}}
    pending_capture_meta = {}    # {"radarId": ..., "speed": ..., "speedTimestamp": ...}

    # ==========================
    # MODO LIVE CAPTURE (5 VOTOS)
    # ==========================
    live_capture_pending = False

    @sio.on("live-plate-capture-start")
    def on_live_plate_capture_start(data):
        nonlocal live_capture_pending
        if data.get("channelId") != args.channel_id:
            return
        live_capture_pending = True
        print(f"[speed.py] Live capture START para canal {args.channel_id}")

    @sio.on("live-plate-capture-cancel")
    def on_live_plate_capture_cancel(data):
        nonlocal live_capture_pending
        if data.get("channelId") != args.channel_id:
            return
        live_capture_pending = False
        print(f"[speed.py] Live capture CANCEL para canal {args.channel_id}")

    @sio.on("speed-buffer-frame")
    def on_speed_buffer_frame(data):
        """
        Node avisa: "acabei de receber uma leitura de velocidade,
        capture o PRÓXIMO frame e guarda em memória".
        """
        if data.get("channelId") != args.channel_id:
            return

        pending_capture_meta.clear()
        pending_capture_meta.update({
            "radarId": data.get("radarId"),
            "speed": data.get("speed"),
            "speedTimestamp": data.get("speedTimestamp"),
        })
        print(f"[speed.py] speed-buffer-frame recebido para canal {args.channel_id}: {pending_capture_meta}")

    @sio.on("speed-save-buffer")
    def on_speed_save_buffer(data):
        """
        Node diz: "a janela fechou e não teve placa → salva o frame
        bufferizado em disco e me devolve um evento speed-only".
        """
        if data.get("channelId") != args.channel_id:
            return

        if "frame" not in speed_frame_buffer:
            print(f"[speed.py] Nenhum frame buffered para salvar no canal {args.channel_id}")
            return

        frame = speed_frame_buffer["frame"]
        meta = speed_frame_buffer.get("meta", {})

        radar_id = data.get("radarId") or meta.get("radarId") or args.radarId
        speed = data.get("speed") or meta.get("speed")
        speed_ts = data.get("speedTimestamp") or meta.get("speedTimestamp")

        ts_ms = int(time.time() * 1000)
        file_name = f"speed_{radar_id}_{ts_ms}.jpg"

        out_dir = os.path.join("public", "captures")
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, file_name)

        try:
            cv2.imwrite(out_path, frame)
            print("[speed.py] Frame speed-only salvo em:", out_path)
        except Exception as e:
            print("[speed.py] Erro ao salvar frame speed-only:", e)
            return

        # devolve para o Node os dados para ele registrar o evento
        try:
            sio.emit("speed-only", {
                "channelId": args.channel_id,
                "radarId": radar_id,
                "speed": speed,
                "speedTimestamp": speed_ts,
                "timestamp": datetime.utcnow().isoformat(),
                "fileName": file_name,
            })
        except Exception as e:
            print("[speed.py] Erro ao emitir speed-only:", e)

        speed_frame_buffer.clear()

    @sio.on("speed-discard-buffer")
    def on_speed_discard_buffer(data):
        """
        Node diz: "essa leitura de velocidade casou com placa → descarta o frame antigo".
        """
        if data.get("channelId") != args.channel_id:
            return

        speed_frame_buffer.clear()
        pending_capture_meta.clear()
        print(f"[speed.py] Buffer de speed descartado para canal {args.channel_id}")

    # def finalize_session(reason="normal"):
    #     nonlocal last_final_plate, last_final_ts, last_final_layout_label, session_last_line_mode, live_capture_pending

    #     if not session.has_data():
    #         session.clear()
    #         session_last_line_mode = None
    #         return

    #     final_text, _, _ = session.mode()
    #     if not final_text:
    #         session.clear()
    #         session_last_line_mode = None
    #         return

    #     now = time.time()
    #     last_final_plate = final_text
    #     last_final_ts = now

    #     if session_last_line_mode == "single":
    #         final_layout_label = "Carro"
    #     elif session_last_line_mode == "double":
    #         final_layout_label = "Moto"
    #     else:
    #         final_layout_label = None

    #     last_final_layout_label = final_layout_label

    #     ts_str = datetime.now().strftime('%H%M%S%f')[:-3]
    #     safe_pred = sanitize_filename(final_text)
    #     full_name = f"{safe_pred}_{ts_str}.jpg"

    #     # Notifica o Node que terminou a sessão (plate-found-speed)
    #     try:
    #         sio.emit("plate-found-speed", {
    #             "channelId": args.channel_id,
    #             "radarId": args.radarId,
    #             "plate": final_text,
    #             "eventType": "speed_plate",
    #             "timestamp": datetime.now().isoformat(),
    #             "fileName": full_name
    #         })
    #     except Exception:
    #         pass

    #     # Salva apenas UMA imagem (melhor FULL)
    #     _, best_full = session.get_best_images()
    #     if best_full is not None:
    #         try:
    #             cv2.imwrite(os.path.join(plates_dir, full_name), best_full)
    #         except Exception as e:
    #             print(f"Erro ao salvar imagem full: {e}", file=sys.stderr)

    #     # se foi fechamento para live-capture, desliga o modo
    #     if reason == "live_capture":
    #         live_capture_pending = False

    #     session.clear()
    #     session_last_line_mode = None
    def finalize_session(reason="normal"):
        nonlocal last_final_plate, last_final_ts, last_final_layout_label, session_last_line_mode, live_capture_pending

        if not session.has_data():
            session.clear()
            session_last_line_mode = None
            return

        final_text, _, _ = session.mode()
        if not final_text:
            session.clear()
            session_last_line_mode = None
            return

        now = time.time()
        last_final_plate = final_text
        last_final_ts = now

        if session_last_line_mode == "single":
            final_layout_label = "Carro"
        elif session_last_line_mode == "double":
            final_layout_label = "Moto"
        else:
            final_layout_label = None

        last_final_layout_label = final_layout_label

        ts_str = datetime.now().strftime('%H%M%S%f')[:-3]
        safe_pred = sanitize_filename(final_text)
        full_name = f"{safe_pred}_{ts_str}.jpg"

        # Notifica o Node que terminou a sessão (plate-found-speed)
        try:
            sio.emit("plate-found-speed", {
                "channelId": args.channel_id,
                "radarId": args.radarId,
                "plate": final_text,
                "eventType": "speed_plate",
                "timestamp": datetime.now().isoformat(),
                "fileName": full_name
            })
        except Exception:
            pass

        # Salva apenas UMA imagem (melhor FULL)
        _, best_full = session.get_best_images()
        if best_full is not None:
            try:
                cv2.imwrite(os.path.join(plates_dir, full_name), best_full)
            except Exception as e:
                print(f"Erro ao salvar imagem full: {e}", file=sys.stderr)

        # Se for fechamento por live-capture, desliga o modo
        if reason == "live_capture":
            live_capture_pending = False

        session.clear()
        session_last_line_mode = None

    try:
        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                break

            if frame_count % skip_frames != 0:
                frame_count += 1
                continue
            frame_count += 1

            display = frame.copy()

            # -------- BUFFER DE FRAME PARA EVENTOS "SÓ VELOCIDADE" --------
            if pending_capture_meta:
                # Guarda o frame atual como referência para essa leitura de velocidade
                speed_frame_buffer.clear()
                speed_frame_buffer["frame"] = frame.copy()
                speed_frame_buffer["meta"] = dict(pending_capture_meta)
                print(f"[speed.py] Frame bufferizado para speed-only no canal {args.channel_id}: {speed_frame_buffer['meta']}")
                pending_capture_meta.clear()

            # -------- DETECÇÃO DE PLACAS --------
            try:
                results = plate_model.predict(frame, imgsz=img_size, verbose=False)
            except Exception as e:
                print(f"Erro na predição de placa: {e}", file=sys.stderr)
                results = [None]

            candidate_reads = []   # (text, conf, crop, line_mode)
            bboxes = []

            if results and results[0] is not None and len(results[0].boxes) > 0:
                for box in results[0].boxes:
                    x1, y1, x2, y2 = map(int, box.xyxy[0])

                    crop = frame[y1:y2, x1:x2]
                    plate_text = None
                    conf = None

                    raw_text, raw_conf, compliant_text, line_mode = read_license_plate_both(crop, ocr_model, img_size)

                    # Debug das leituras individuais (não é desenhado)
                    if raw_text is not None and raw_conf is not None:
                        status = "OK" if compliant_text else "X"
                        dbg = f"{raw_text} | {status} | {raw_conf:.2f}"
                        debug_lines.append(dbg)
                        if len(debug_lines) > 50:
                            debug_lines.pop(0)

                    if compliant_text and raw_conf and raw_conf > OCR_MEAN_CONF_THRESHOLD:
                        plate_text = compliant_text
                        conf = raw_conf
                        candidate_reads.append((plate_text, conf, crop, line_mode))

                    color = (0, 255, 0)
                    if plate_text:
                        color = (0, 0, 255)
                    thick = 2
                    bboxes.append((x1, y1, x2, y2, color, thick))

            # melhor leitura do frame
            new_text = None
            new_conf = None
            new_crop = None
            new_line_mode = None
            if candidate_reads:
                candidate_reads.sort(key=lambda x: x[1], reverse=True)
                new_text, new_conf, new_crop, new_line_mode = candidate_reads[0]

            # desenhar bboxes
            for x1, y1, x2, y2, color, thick in bboxes:
                cv2.rectangle(display, (x1, y1), (x2, y2), color, thick)

            now = time.time()
            # -------- AGRUPAMENTO (SESSÃO) --------
            if new_text:
                if not session.has_data():
                    session.add(new_text, new_conf, new_crop, frame)
                    if new_line_mode is not None:
                        session_last_line_mode = new_line_mode
                else:
                    mode_text, mode_cnt, mode_avg = session.mode()
                    if session.total_reads >= MIN_SAMPLES_BEFORE_DIFF:
                        dist = normalized_distance(new_text, mode_text)
                        if dist >= DIFF_NORM_THRESHOLD:
                            # encerra sessão atual (placa anterior)
                            finalize_session(reason="normal")

                            # inicia nova sessão para a nova placa
                            session.add(new_text, new_conf, new_crop, frame)
                            if new_line_mode is not None:
                                session_last_line_mode = new_line_mode
                        else:
                            session.add(new_text, new_conf, new_crop, frame)
                            if new_line_mode is not None:
                                session_last_line_mode = new_line_mode
                    else:
                        session.add(new_text, new_conf, new_crop, frame)
                        if new_line_mode is not None:
                            session_last_line_mode = new_line_mode

            # -------- FECHAMENTO ANTECIPADO PARA LIVE CAPTURE (5 VOTOS) --------
            if live_capture_pending and session.has_data() and session.total_reads >= LIVE_CAPTURE_MIN_VOTES:
                print(f"[speed.py] Live capture atingiu {session.total_reads} leituras. Encerrando sessão antecipadamente.")
                finalize_session(reason="live_capture")

            # -------- FECHAMENTO POR TEMPO FIXO (3s) --------
            if session.has_data() and session.age_since_start() >= SESSION_MAX_DURATION_S:
                finalize_session(reason="timeout")


            # -------- FECHAMENTO POR TEMPO (GAP) --------
            if session.has_data() and session.age_since_last() >= GAP_TIMEOUT_S:
                finalize_session(reason="gap")


            # -------- OVERLAYS --------
            draw_session_badge(display, session)
            # NÃO desenhamos mais as leituras parciais:
            # draw_debug_reads(display, debug_lines)
            if last_final_plate:
                draw_plate_marquee(display, last_final_plate, last_final_ts,
                                   PLATE_MARQUEE_SECONDS, last_final_layout_label)

            # -------- ENVIO DE FRAME PARA DASH --------
            small = cv2.resize(display, (640, 480))
            ok, enc = cv2.imencode(".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), 15])
            if ok:
                try:
                    sio.emit("frame", {
                        "channelId": args.channel_id,
                        "image": enc.tobytes(),
                        "size": len(enc) / 1024.0
                    })
                except Exception:
                    pass

            # -------- PERFORMANCE --------
            if time.time() - last_perf >= 5.0:
                measure_performance(plate_model, ocr_model, sio, args.channel_id, base_path, img_size)
                last_perf = time.time()

        cap.release()
        try:
            sio.emit("process-stopped", {"channelId": args.channel_id})
        except Exception:
            pass
        sio.disconnect()

    except KeyboardInterrupt:
        cap.release()
        try:
            sio.emit("process-stopped", {"channelId": args.channel_id})
        except Exception:
            pass
        sio.disconnect()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Erro fatal: {e}", file=sys.stderr)
        sys.exit(1)
