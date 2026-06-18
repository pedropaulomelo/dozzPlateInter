#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
speed.py (produção)

Objetivo:
- Manter RTSP aberto e enviar preview para o Dash via Socket.IO (evento "frame").
- Entrar em modo IA (rodar YOLO) SOMENTE quando:
  1) Node enviar "speed-session-start" (chegou leitura de velocidade no server.js), ou
  2) Node enviar "live-plate-capture-start" (captura ao vivo).
- Durante sessão por velocidade:
  - Tentar ler placa (plate.pt + ocr.pt) e encerrar assim que fechar (votos suficientes).
  - Em paralelo, rodar detector.pt (COCO) e manter o "melhor frame de veículo" bufferizado.
  - Se não fechar placa até o deadline: salvar imagem do veículo e emitir "vehicle-only" pro Node.
- Durante sessão live-capture:
  - Tentar fechar placa e emitir "plate-found-speed" (speed=None). Se falhar: apenas encerra.

Eventos Socket.IO emitidos:
- "process-started" / "process-stopped"
- "frame" (preview)
- "plate-found-speed" (quando placa fechou) -> inclui speed/speedTimestamp se existir
- "vehicle-only" (quando não fechou placa na sessão de velocidade, mas achou veículo)

Eventos Socket.IO recebidos:
- "speed-session-start"  (inicia sessão por velocidade)
- "live-plate-capture-start" / "live-plate-capture-cancel"

Requisitos de arquivos:
- models/plate_<imgsz>.engine (preferencial) ou models/plate.pt
- models/ocr_<imgsz>.engine (preferencial) ou models/ocr.pt
- models/detector_<imgsz>.engine (preferencial) ou models/detector.pt
"""

import os
import sys
import cv2
import time
import string
import argparse
import warnings
import numpy as np
import subprocess
from datetime import datetime

import socketio
import psutil
import GPUtil
from ultralytics import YOLO

warnings.filterwarnings("ignore")

SERVER_URL = "http://127.0.0.1:4000"

# ==========================
# CONFIGURAÇÕES GERAIS
# ==========================
TARGET_FPS_DEFAULT = 3
SOCKET_PREVIEW_ENABLED = os.getenv("SOCKET_PREVIEW_ENABLED", "true").strip().lower() in ("1", "true", "yes", "on")
SPEED_STREAM_MAX_SIDE = max(320, int(os.getenv("SPEED_STREAM_MAX_SIDE", "640")))

# Placa/OCR
OCR_MEAN_CONF_THRESHOLD = 0.20
GAP_TIMEOUT_S = 0.40
DIFF_NORM_THRESHOLD = 0.50
MIN_SAMPLES_BEFORE_DIFF = 3

# Encerramento "rápido" por votos (fecha sessão assim que atingir)
MIN_PLATE_VOTES_SPEED = 3     # sessão por velocidade
MIN_PLATE_VOTES_LIVE = 5      # live capture (você já usa 5)

# UI
PLATE_MARQUEE_SECONDS = 5.0

# Detector COCO (veículos)
VEHICLE_CONF_TH = 0.25
VEHICLE_DET_EVERY_N = 2  # roda detector a cada N frames durante sessão (performance)

# Classes esperadas do COCO (ultralytics)
# Ajuste se seu detector.pt tiver nomes diferentes.
VEHICLE_CLASSES = {"car", "motorcycle", "bus", "truck", "bicycle", "train"}
PLATE_GUARD_ENABLED = os.getenv("PLATE_GUARD_ENABLED", "true").strip().lower() in ("1", "true", "yes", "on")


def read_env_int(name, default, min_value=1):
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = int(default)
    return max(min_value, value)


def read_env_float(name, default):
    raw = os.getenv(name, str(default))
    try:
        return float(raw)
    except (TypeError, ValueError):
        return float(default)


def parse_bool(value, default=True):
    if value is None:
        return bool(default)
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return bool(default)


PLATE_GUARD_DET_EVERY_N = read_env_int("PLATE_GUARD_DET_EVERY_N", 2, min_value=1)
PLATE_GUARD_VEHICLE_CONF = read_env_float("PLATE_GUARD_VEHICLE_CONF", 0.22)
PLATE_GUARD_FRAUD_CONF = read_env_float("PLATE_GUARD_FRAUD_CONF", 0.22)
PLATE_GUARD_MIN_PLATE_OVERLAP = read_env_float("PLATE_GUARD_MIN_PLATE_OVERLAP", 0.55)
PLATE_GUARD_EXPAND_FACTOR = read_env_float("PLATE_GUARD_EXPAND_FACTOR", 1.8)
FRAUD_SUSPICIOUS_CLASSES = {
    part.strip().lower()
    for part in os.getenv(
        "PLATE_GUARD_FRAUD_CLASSES",
        "person,cell phone,book,remote,laptop,tv"
    ).split(",")
    if part.strip()
}


def bbox_area(bbox):
    width = max(0.0, float(bbox["xmax"]) - float(bbox["xmin"]))
    height = max(0.0, float(bbox["ymax"]) - float(bbox["ymin"]))
    return width * height


def bbox_intersection_area(a, b):
    x1 = max(float(a["xmin"]), float(b["xmin"]))
    y1 = max(float(a["ymin"]), float(b["ymin"]))
    x2 = min(float(a["xmax"]), float(b["xmax"]))
    y2 = min(float(a["ymax"]), float(b["ymax"]))
    if x2 <= x1 or y2 <= y1:
        return 0.0
    return float(x2 - x1) * float(y2 - y1)


def point_inside_bbox(x, y, bbox):
    return (
        float(bbox["xmin"]) <= float(x) <= float(bbox["xmax"])
        and float(bbox["ymin"]) <= float(y) <= float(bbox["ymax"])
    )


def expand_bbox(bbox, factor):
    cx = (float(bbox["xmin"]) + float(bbox["xmax"])) / 2.0
    cy = (float(bbox["ymin"]) + float(bbox["ymax"])) / 2.0
    width = max(1.0, float(bbox["xmax"]) - float(bbox["xmin"])) * float(factor)
    height = max(1.0, float(bbox["ymax"]) - float(bbox["ymin"])) * float(factor)
    return {
        "xmin": cx - (width / 2.0),
        "ymin": cy - (height / 2.0),
        "xmax": cx + (width / 2.0),
        "ymax": cy + (height / 2.0),
    }


def detect_context_objects(frame, detector_model, img_size):
    vehicle_boxes = []
    fraud_boxes = []
    if detector_model is None:
        return vehicle_boxes, fraud_boxes

    try:
        results = detector_model.predict(frame, imgsz=img_size, verbose=False)
    except Exception:
        return vehicle_boxes, fraud_boxes

    if not results or results[0] is None or results[0].boxes is None:
        return vehicle_boxes, fraud_boxes

    names = results[0].names
    for detection_box in results[0].boxes:
        cls_id = int(detection_box.cls[0])
        cls_name = str(names.get(cls_id, cls_id)).lower()
        conf = float(detection_box.conf[0])
        x1, y1, x2, y2 = map(float, detection_box.xyxy[0])
        bbox = {
            "xmin": x1,
            "ymin": y1,
            "xmax": x2,
            "ymax": y2,
            "cls": cls_name,
            "conf": conf,
        }

        if cls_name in VEHICLE_CLASSES and conf >= PLATE_GUARD_VEHICLE_CONF:
            vehicle_boxes.append(bbox)
        elif cls_name in FRAUD_SUSPICIOUS_CLASSES and conf >= PLATE_GUARD_FRAUD_CONF:
            fraud_boxes.append(bbox)

    return vehicle_boxes, fraud_boxes


def evaluate_plate_guard(plate_bbox, vehicle_boxes, fraud_boxes):
    if not PLATE_GUARD_ENABLED:
        return True, None

    if not vehicle_boxes:
        return False, "no_vehicle"

    plate_area = max(1.0, bbox_area(plate_bbox))
    center_x = (float(plate_bbox["xmin"]) + float(plate_bbox["xmax"])) / 2.0
    center_y = (float(plate_bbox["ymin"]) + float(plate_bbox["ymax"])) / 2.0

    matched_vehicle = None
    for vehicle_bbox in vehicle_boxes:
        overlap = bbox_intersection_area(plate_bbox, vehicle_bbox) / plate_area
        if point_inside_bbox(center_x, center_y, vehicle_bbox) or overlap >= PLATE_GUARD_MIN_PLATE_OVERLAP:
            matched_vehicle = vehicle_bbox
            break

    if matched_vehicle is None:
        return False, "plate_not_on_vehicle"

    expanded_plate = expand_bbox(plate_bbox, PLATE_GUARD_EXPAND_FACTOR)
    for fraud_bbox in fraud_boxes:
        if bbox_intersection_area(expanded_plate, fraud_bbox) <= 0.0:
            continue

        fraud_center_x = (float(fraud_bbox["xmin"]) + float(fraud_bbox["xmax"])) / 2.0
        fraud_center_y = (float(fraud_bbox["ymin"]) + float(fraud_bbox["ymax"])) / 2.0
        tied_to_vehicle = (
            bbox_intersection_area(matched_vehicle, fraud_bbox) > 0.0
            or point_inside_bbox(fraud_center_x, fraud_center_y, matched_vehicle)
        )
        if tied_to_vehicle:
            fraud_label = str(fraud_bbox.get("cls") or "suspicious_object")
            return False, f"fraud_{fraud_label}"

    return True, None


def guard_reason_to_label(reason):
    normalized = str(reason or "").strip().lower()
    if normalized == "no_vehicle":
        return "Placa sem veiculo detectado"
    if normalized == "plate_not_on_vehicle":
        return "Placa fora da area do veiculo"
    if normalized.startswith("fraud_"):
        obj_name = normalized[6:].strip() or "objeto"
        return f"Objeto suspeito proximo: {obj_name}"
    if not normalized:
        return "Motivo nao informado"
    return normalized.replace("_", " ")

# ==========================
# UTILS / FORMATAÇÃO
# ==========================
def remove_leading_zero(token: str) -> str:
    if token.startswith('0') and len(token) > 1:
        return token[1:]
    return token


def license_complies_format(text: str) -> bool:
    """
    Aceita somente:
      - Antiga:   LLLNNNN
      - Mercosul: LLLNLNN
    """
    if len(text) != 7:
        return False

    if text[0:3].isalpha() and text[3:].isdigit():
        return True

    if text[0:3].isalpha() and text[3].isdigit() and text[4].isalpha() and text[5:].isdigit():
        return True

    return False


def sanitize_filename(filename: str) -> str:
    valid_chars = "-_.() %s%s" % (string.ascii_letters, string.digits)
    return ''.join(c for c in filename if c in valid_chars)

def resolve_model_path(base_path: str, model_name: str, img_size: int) -> str:
    model_dir = os.path.join(base_path, "models")
    candidates = [
        os.path.join(model_dir, f"{model_name}_{img_size}.engine"),
        os.path.join(model_dir, f"{model_name}.engine"),
        os.path.join(model_dir, f"{model_name}_{img_size}.pt"),
        os.path.join(model_dir, f"{model_name}.pt"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return ""


def resolve_pt_model_path(base_path: str, model_name: str, img_size: int) -> str:
    model_dir = os.path.join(base_path, "models")
    candidates = [
        os.path.join(model_dir, f"{model_name}_{img_size}.pt"),
        os.path.join(model_dir, f"{model_name}.pt"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return ""


def load_yolo_with_fallback(base_path: str, model_name: str, preferred_path: str, img_size: int, device: str):
    if not preferred_path:
        raise RuntimeError(f"Modelo {model_name} ausente.")

    tried = set()
    current_path = preferred_path
    warmup_size = max(320, min(int(img_size), 640))
    warmup_frame = np.zeros((warmup_size, warmup_size, 3), dtype=np.uint8)

    while current_path and current_path not in tried:
        tried.add(current_path)
        try:
            model = YOLO(current_path)
            if current_path.endswith(".pt"):
                try:
                    model.to(device)
                except Exception as move_error:
                    print(
                        f"[speed.py] Aviso: falha ao mover {model_name} para {device}: {move_error}. Usando CPU.",
                        file=sys.stderr,
                    )
                    model.to("cpu")

            model.predict(warmup_frame, imgsz=img_size, verbose=False)
            return model, current_path
        except Exception as model_error:
            if current_path.endswith(".engine"):
                fallback_pt = resolve_pt_model_path(base_path, model_name, img_size)
                if fallback_pt and fallback_pt not in tried:
                    print(
                        f"[speed.py] Falha ao inicializar {model_name} em TensorRT ({current_path}): "
                        f"{model_error}. Fallback para {fallback_pt}.",
                        file=sys.stderr,
                    )
                    current_path = fallback_pt
                    continue
            raise RuntimeError(
                f"Falha ao carregar modelo {model_name} ({current_path}): {model_error}"
            ) from model_error

    raise RuntimeError(f"Falha ao carregar modelo {model_name}.")


# ==========================
# OCR
# ==========================
def read_license_plate_both(crop, ocr_model, img_size):
    """
    Retorna:
      - raw_text: texto lido (sem mapeamentos, apenas limpeza básica)
      - avg_conf: confiança média
      - compliant_text: raw_text se bater com LLLNNNN ou LLLNLNN, senão None
      - line_mode: "single" (carro), "double" (moto) ou None
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

        ys = [d[1] for d in det_list]
        hs = [d[2] for d in det_list]

        avg_h = sum(hs) / len(hs)
        vertical_span = max(ys) - min(ys)

        SINGLE_LINE_THRESHOLD = 0.6
        if vertical_span < SINGLE_LINE_THRESHOLD * avg_h:
            line_mode = "single"
            ordered = sorted(det_list, key=lambda d: d[0])
        else:
            line_mode = "double"
            mid_y = (max(ys) + min(ys)) / 2.0
            top_line = [d for d in det_list if d[1] <= mid_y]
            bottom_line = [d for d in det_list if d[1] > mid_y]
            top_line.sort(key=lambda d: d[0])
            bottom_line.sort(key=lambda d: d[0])
            ordered = top_line + bottom_line

        chars = [d[3] for d in ordered]
        conf_vals = [d[4] for d in ordered]

        plate_raw = ''.join(chars)
        raw_text = plate_raw.upper().replace(" ", "")
        avg_conf = sum(conf_vals) / len(conf_vals) if conf_vals else 0.0

        compliant = raw_text if license_complies_format(raw_text) else None
        return raw_text, avg_conf, compliant, line_mode

    return None, None, None, None


# ==========================
# AGRUPAMENTO (Levenshtein)
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
      - melhor frame full (por score área*confiança) + bboxes do frame
    """
    def __init__(self):
        self.counts = {}
        self.conf_sums = {}
        self.last_read_ts = 0.0
        self.total_reads = 0

        self.best_full_bboxes = None
        self.best_full = None
        self.best_score = 0.0

    def add(self, text, conf, crop, full_frame, bboxes=None):
        self.counts[text] = self.counts.get(text, 0) + 1
        self.conf_sums[text] = self.conf_sums.get(text, 0.0) + conf
        self.last_read_ts = time.time()
        self.total_reads += 1

        if crop is not None and crop.size > 0:
            h, w = crop.shape[:2]
            area = w * h
            score = conf * (area / 5000.0)

            if score > self.best_score:
                self.best_score = score
                self.best_full = full_frame.copy()
                self.best_full_bboxes = list(bboxes) if bboxes else None

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

    def get_best(self):
        return self.best_full, self.best_full_bboxes

    def clear(self):
        self.__init__()


# ==========================
# UI
# ==========================
def draw_plate_marquee(frame, text, last_plate_time, duration, layout_label=None):
    if not text:
        return
    if (time.time() - last_plate_time) > duration:
        return

    h, w = frame.shape[:2]
    base_scale = max(1.0, min(w, h) / 300.0)

    plate_scale = base_scale * 1.3
    label_scale = base_scale * 0.6

    plate_thick = max(2, int(plate_scale * 2))
    label_thick = max(1, int(label_scale * 2))

    font = cv2.FONT_HERSHEY_SIMPLEX

    plate_text = text.upper()
    label_text = layout_label.upper() if layout_label else ""

    (tw_plate, th_plate), base_plate = cv2.getTextSize(plate_text, font, plate_scale, plate_thick)
    if label_text:
        (tw_label, th_label), base_label = cv2.getTextSize(label_text, font, label_scale, label_thick)
    else:
        tw_label, th_label, base_label = 0, 0, 0

    line_spacing = int(8 * base_scale)
    margin_x = int(18 * base_scale)
    margin_y = int(6 * base_scale)

    total_width = max(tw_plate, tw_label)
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

    overlay = frame.copy()
    shadow_offset = int(4 * base_scale)
    cv2.rectangle(
        overlay,
        (rect_left + shadow_offset, rect_top + shadow_offset),
        (rect_right + shadow_offset, rect_bottom + shadow_offset),
        (0, 0, 0),
        -1
    )
    cv2.rectangle(
        overlay,
        (rect_left, rect_top),
        (rect_right, rect_bottom),
        (255, 255, 255),
        -1
    )
    alpha = 0.85
    cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, frame)

    cv2.rectangle(
        frame,
        (rect_left, rect_top),
        (rect_right, rect_bottom),
        (0, 0, 255),
        max(1, int(base_scale * 2))
    )

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

def draw_fraud_alert(frame, feedback, ttl_s=4.0):
    reason = str(feedback.get("reason") or "").strip()
    if not reason:
        return

    timestamp = float(feedback.get("timestamp") or 0.0)
    if timestamp <= 0.0:
        return
    if (time.time() - timestamp) > float(ttl_s):
        return

    h, w = frame.shape[:2]
    base_scale = max(0.9, min(w, h) / 460.0)
    fs1 = 0.95 * base_scale
    th1 = max(2, int(2.4 * base_scale))
    font = cv2.FONT_HERSHEY_SIMPLEX

    line1 = "DETECCAO DE FRAUDE"
    color = (0, 0, 255)

    (w1, h1), b1 = cv2.getTextSize(line1, font, fs1, th1)
    pad = max(10, int(10 * base_scale))

    box_w = min(w - 20, w1 + pad * 2)
    box_h = h1 + b1 + pad * 2
    x1, y1 = 12, 12
    x2 = min(w - 8, x1 + box_w)
    y2 = min(h - 8, y1 + box_h)

    overlay = frame.copy()
    cv2.rectangle(overlay, (x1, y1), (x2, y2), (15, 15, 15), -1)
    cv2.addWeighted(overlay, 0.58, frame, 0.42, 0, frame)
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, max(2, int(2 * base_scale)))

    t1_y = y1 + pad + h1
    cv2.putText(frame, line1, (x1 + pad, t1_y), font, fs1, color, th1, cv2.LINE_AA)

def draw_speed_hud(
    frame,
    speed,
    max_speed,
    tolerance_kmh,
    lock_until,
    last_update,
    ttl_s=2.5
):
    """
    HUD profissional no canto superior esquerdo.

    Regras de cor da BORDA:
      - Verde:   speed <= max_speed
      - Amarela: max_speed < speed <= max_speed + tolerance_kmh
      - Vermelha: speed > max_speed + tolerance_kmh

    Exibição:
      - Se locked (time.time() < lock_until): sempre mostra.
      - Se não locked: mostra por ttl_s segundos após last_update.
    """
    if speed is None:
        return

    now = time.time()
    locked = now < float(lock_until or 0.0)

    if not locked:
        if not last_update or (now - float(last_update)) > float(ttl_s):
            return

    # Normaliza valores
    try:
        sp = float(speed)
    except Exception:
        return

    max_speed = float(max_speed) if max_speed is not None else None
    tol = float(tolerance_kmh) if tolerance_kmh is not None else 0.0

    sp_i = int(round(sp))
    max_i = int(round(max_speed)) if max_speed is not None else None
    tol_i = int(round(tol))

    # Determina status / cor da borda
    if max_speed is None:
        status = "VEL"
        border = (0, 0, 0)  # sem limite -> neutro
    else:
        if sp <= max_speed:
            status = "OK"
            border = (0, 200, 0)     # verde
        elif sp <= (max_speed + tol):
            status = "ATENCAO"
            border = (0, 215, 255)   # amarelo (BGR)
        else:
            status = "VIOLADA"
            border = (0, 0, 255)     # vermelho

    # ---------- Estilo / Tipografia ----------
    # Fontes “mais bonitas” dentro do OpenCV:
    # - COMPLEX / DUPLEX ficam mais “corporate” do que SIMPLEX.
    font_big = cv2.FONT_HERSHEY_COMPLEX
    font_small = cv2.FONT_HERSHEY_DUPLEX

    # Tamanhos (ajuste aqui para ficar maior/menor)
    fs_big = 1.55
    th_big = 3

    fs_small = 0.78
    th_small = 2

    pad_x = 16
    pad_y = 14
    gap = 8

    # Posição (canto superior esquerdo)
    x1 = 18
    y1 = 18

    # Textos (duas linhas)
    line1 = f"{sp_i} km/h"
    if max_i is None:
        line2 = f"{status}"
    else:
        if tol_i > 0:
            line2 = f"{status}  |  LIM {max_i}  TOL +{tol_i}"
        else:
            line2 = f"{status}  |  LIM {max_i}"

    # Mede textos para calcular o retângulo
    (w1, h1), b1 = cv2.getTextSize(line1, font_big, fs_big, th_big)
    (w2, h2), b2 = cv2.getTextSize(line2, font_small, fs_small, th_small)

    box_w = max(w1, w2) + 2 * pad_x
    box_h = (h1 + b1) + gap + (h2 + b2) + 2 * pad_y

    x2 = x1 + box_w
    y2 = y1 + box_h

    # ---------- Sombra discreta ----------
    shadow_dx, shadow_dy = 4, 4
    overlay = frame.copy()
    cv2.rectangle(
        overlay,
        (x1 + shadow_dx, y1 + shadow_dy),
        (x2 + shadow_dx, y2 + shadow_dy),
        (0, 0, 0),
        -1
    )
    cv2.addWeighted(overlay, 0.25, frame, 0.75, 0, frame)

    # ---------- Fundo branco ----------
    cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 255, 255), -1)

    # ---------- Borda espessa (verde/amarela/vermelha) ----------
    border_th = 6
    cv2.rectangle(frame, (x1, y1), (x2, y2), border, border_th)

    # ---------- Texto ----------
    # Linha 1 (grande)
    tx1 = x1 + pad_x
    ty1 = y1 + pad_y + h1
    cv2.putText(frame, line1, (tx1, ty1), font_big, fs_big, (0, 0, 0), th_big, cv2.LINE_AA)

    # Linha 2 (menor)
    tx2 = x1 + pad_x
    ty2 = ty1 + gap + h2 + b2
    cv2.putText(frame, line2, (tx2, ty2), font_small, fs_small, (30, 30, 30), th_small, cv2.LINE_AA)

# ==========================
# PERFORMANCE
# ==========================
def measure_performance(sio, channel_id, img_size, avg_fps=None):
    """
    Medição simples: não roda em cima de arquivo; estima uso de CPU/GPU/RAM
    e envia com "performance-report".
    """
    cpu = psutil.cpu_percent()
    ram = psutil.virtual_memory().percent

    gpus = GPUtil.getGPUs()
    if gpus:
        gpu = gpus[0]
        gpu_load = gpu.load * 100
        gpu_mem = gpu.memoryUtil * 100
    else:
        gpu_load = gpu_mem = 0

    payload = {
        "cpu_usage": cpu,
        "ram_usage": ram,
        "gpu_usage": round(gpu_load, 1),
        "gpu_memory_usage": round(gpu_mem, 1),
        "imgsz": img_size
    }
    if avg_fps is not None:
        try:
            payload["avg_fps"] = round(float(avg_fps), 2)
        except Exception:
            pass

    try:
        sio.emit("performance-report", {
            "channelId": channel_id,
            "data": payload
        })
    except Exception:
        pass

# ==========================
# VEÍCULOS: buffer "melhor frame"
# ==========================
def update_best_vehicle(frame, detector_model, img_size, best_vehicle_dict):
    """
    Atualiza best_vehicle_dict se achar um veículo com score maior (conf*área).
    Guarda frame completo + bboxes.
    """
    try:
        res = detector_model.predict(frame, imgsz=img_size, conf=VEHICLE_CONF_TH, verbose=False)
    except Exception:
        return

    if not res or res[0] is None or res[0].boxes is None or len(res[0].boxes) == 0:
        return

    names = res[0].names
    best_local_score = 0.0
    best_local = None
    local_boxes = []

    for box in res[0].boxes:
        cls_id = int(box.cls[0])
        cls_name = names.get(cls_id, str(cls_id))
        if cls_name not in VEHICLE_CLASSES:
            continue

        conf = float(box.conf[0])
        x1, y1, x2, y2 = map(int, box.xyxy[0])
        area = max(0, (x2 - x1)) * max(0, (y2 - y1))
        score = conf * area

        # bbox azul para veículo
        local_boxes.append((x1, y1, x2, y2, (255, 0, 0), 2))

        if score > best_local_score:
            best_local_score = score
            best_local = (cls_name, conf)

    if best_local is None:
        return

    if best_local_score > float(best_vehicle_dict.get("score", 0.0)):
        best_vehicle_dict["score"] = best_local_score
        best_vehicle_dict["cls"] = best_local[0]
        best_vehicle_dict["conf"] = float(best_local[1])
        best_vehicle_dict["frame"] = frame.copy()
        best_vehicle_dict["bboxes"] = list(local_boxes)

# ==========================
# VIDEO: FFmpeg Writer (H.264)
# ==========================
class FFmpegVideoWriter:
    """
    Escreve MP4 H.264 (avc1) via ffmpeg + libx264 usando pipe rawvideo.
    Entrada: frames BGR (OpenCV) em uint8.
    """
    def __init__(self, out_path, w, h, fps):
        self.out_path = str(out_path)
        self.w = int(w)
        self.h = int(h)
        self.fps = int(fps)
        self.p = None

        cmd = [
            "ffmpeg", "-y",
            "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo",
            "-pix_fmt", "bgr24",
            "-s", f"{self.w}x{self.h}",
            "-r", str(self.fps),
            "-i", "pipe:0",
            "-an",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            self.out_path
        ]

        self.p = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE
        )

    def isOpened(self):
        return self.p is not None and (self.p.poll() is None) and (self.p.stdin is not None)

    def write(self, frame_bgr):
        if not self.isOpened():
            return
        # garante contiguidade
        if not frame_bgr.flags["C_CONTIGUOUS"]:
            frame_bgr = np.ascontiguousarray(frame_bgr)
        try:
            self.p.stdin.write(frame_bgr.tobytes())
        except BrokenPipeError:
            # ffmpeg morreu; mantenha isOpened() falso
            self.release()

    def release(self):
        if self.p is None:
            return

        try:
            if self.p.stdin:
                self.p.stdin.close()
        except Exception:
            pass

        try:
            self.p.wait(timeout=3)
        except Exception:
            try:
                self.p.kill()
            except Exception:
                pass

        # Se quiser debug, descomente:
        # if self.p.stderr:
        #     err = self.p.stderr.read().decode("utf-8", errors="ignore")
        #     if err.strip():
        #         print("[speed.py] ffmpeg stderr:", err, file=sys.stderr)

        self.p = None

# ==========================
# MAIN
# ==========================
def main():
    parser = argparse.ArgumentParser(description="Speed PlateReader (sessões por velocidade / live capture).")
    parser.add_argument("--ip", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--frame_rate", type=int, default=TARGET_FPS_DEFAULT)
    parser.add_argument("--device", type=str, default="cpu")
    parser.add_argument("--channel_id", required=True)
    parser.add_argument("--radarId", required=True)
    parser.add_argument("--dvr_channel", required=True)
    parser.add_argument("--imgsz", type=int, default=480)
    parser.add_argument("--socket_token", type=str, default=None)
    parser.add_argument("--plate_guard_enabled", required=False, default=None)
    parser.add_argument("--plate_guard_det_every_n", required=False, type=int, default=None)
    parser.add_argument("--plate_guard_vehicle_conf", required=False, type=float, default=None)
    parser.add_argument("--plate_guard_fraud_conf", required=False, type=float, default=None)
    parser.add_argument("--plate_guard_min_plate_overlap", required=False, type=float, default=None)
    parser.add_argument("--plate_guard_expand_factor", required=False, type=float, default=None)
    parser.add_argument("--plate_guard_fraud_classes", required=False, default=None)
    parser.add_argument("--stream_preview_side", required=False, type=int, default=None)
    parser.add_argument("--stream_jpeg_quality", required=False, type=int, default=None)
    args = parser.parse_args()

    global PLATE_GUARD_ENABLED
    global PLATE_GUARD_DET_EVERY_N
    global PLATE_GUARD_VEHICLE_CONF
    global PLATE_GUARD_FRAUD_CONF
    global PLATE_GUARD_MIN_PLATE_OVERLAP
    global PLATE_GUARD_EXPAND_FACTOR
    global FRAUD_SUSPICIOUS_CLASSES

    PLATE_GUARD_ENABLED = parse_bool(args.plate_guard_enabled, PLATE_GUARD_ENABLED)
    if args.plate_guard_det_every_n is not None:
        PLATE_GUARD_DET_EVERY_N = max(1, int(args.plate_guard_det_every_n))
    if args.plate_guard_vehicle_conf is not None:
        PLATE_GUARD_VEHICLE_CONF = float(max(0.0, min(1.0, args.plate_guard_vehicle_conf)))
    if args.plate_guard_fraud_conf is not None:
        PLATE_GUARD_FRAUD_CONF = float(max(0.0, min(1.0, args.plate_guard_fraud_conf)))
    if args.plate_guard_min_plate_overlap is not None:
        PLATE_GUARD_MIN_PLATE_OVERLAP = float(max(0.0, min(1.0, args.plate_guard_min_plate_overlap)))
    if args.plate_guard_expand_factor is not None:
        PLATE_GUARD_EXPAND_FACTOR = float(max(1.0, args.plate_guard_expand_factor))
    if args.plate_guard_fraud_classes is not None:
        parsed_classes = {
            part.strip().lower()
            for part in str(args.plate_guard_fraud_classes).split(",")
            if part.strip()
        }
        if parsed_classes:
            FRAUD_SUSPICIOUS_CLASSES = parsed_classes

    # HUD speed
    hud_speed = None
    hud_speed_ts = None
    hud_decision = None
    hud_violates = False
    hud_last_update = 0.0
    hud_speed_limit = None   # LIMITE REAL
    hud_tolerance = 0.0      # TOLERÂNCIA REAL
    hud_lock_until = 0.0
    HUD_TTL_S = 2.5

    img_size = int(args.imgsz)

    current_session_id = None

    # base_path
    if getattr(sys, "frozen", False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.abspath(".")

    device = "cuda" if args.device.lower() in ["cuda", "gpu"] else "cpu"

    plate_model_path = resolve_model_path(base_path, "plate", img_size)
    ocr_model_path = resolve_model_path(base_path, "ocr", img_size)
    detector_model_path = resolve_model_path(base_path, "detector", img_size)

    for p in (plate_model_path, ocr_model_path, detector_model_path):
        if not p or not os.path.exists(p):
            print(f"ERRO: modelo não encontrado: {p}", file=sys.stderr)
            sys.exit(1)
    print(f"[speed.py] Modelo plate: {plate_model_path}")
    print(f"[speed.py] Modelo ocr: {ocr_model_path}")
    print(f"[speed.py] Modelo detector: {detector_model_path}")

    plate_model, loaded_plate_path = load_yolo_with_fallback(
        base_path, "plate", plate_model_path, img_size, device
    )
    ocr_model, loaded_ocr_path = load_yolo_with_fallback(
        base_path, "ocr", ocr_model_path, img_size, device
    )
    detector_model, loaded_detector_path = load_yolo_with_fallback(
        base_path, "detector", detector_model_path, img_size, device
    )

    print(f"[speed.py] Modelo plate carregado: {loaded_plate_path}")
    print(f"[speed.py] Modelo ocr carregado: {loaded_ocr_path}")
    print(f"[speed.py] Modelo detector carregado: {loaded_detector_path}")

    rtsp = f"rtsp://{args.user}:{args.password}@{args.ip}:554/cam/realmonitor?channel={args.dvr_channel}&subtype=0"
    cap = cv2.VideoCapture(rtsp)

    # =========================================================
    # Socket.IO (UM ÚNICO CLIENT)
    # =========================================================
    sio = socketio.Client(
        reconnection=True,
        reconnection_attempts=0,   # infinito
        reconnection_delay=1,
        logger=False,
        engineio_logger=False,
    )

    # --------------------------
    # Estado global (sessões)  <<< TEM QUE VIR ANTES DE CONECTAR
    # --------------------------
    session = PlateSession()

    # exibição (marquee)
    last_final_plate = None
    last_final_ts = 0.0
    last_final_layout_label = None
    session_last_line_mode = None

    # Sessão ativa
    session_active = False         # liga/desliga IA
    session_kind = None            # "speed" ou "live"
    session_deadline_ts = 0.0      # deadline absoluto

    # Metadados da velocidade atual (somente quando kind=="speed")
    current_speed_meta = {
        "radarId": args.radarId,
        "speed": None,
        "speedTimestamp": None
    }

    # Buffer "melhor veículo" (somente kind=="speed")
    best_vehicle = {"frame": None, "bboxes": None, "cls": None, "conf": None, "score": 0.0}
    first_session_frame = None
    session_frame_idx = 0

    # Live capture
    live_capture_pending = False
    live_capture_timeout_ms = 7000

    # Capturas
    captures_dir = os.path.join("public", "captures")
    os.makedirs(captures_dir, exist_ok=True)

    # Vídeos (clips)
    clips_dir = os.path.join("public", "clips")
    os.makedirs(clips_dir, exist_ok=True)

    video_writer = None
    video_file_name = None
    video_deadline_ts = 0.0
    video_active = False
    video_frames_written = 0

    video_target_size = None      # (w, h)
    video_pending_open = False    # abre no 1º frame
    pending_file_name = None

    VIDEO_FPS = max(1, int(args.frame_rate))  # fps do canal

    # FPS / skip frames
    fps_cam = cap.get(cv2.CAP_PROP_FPS)
    if fps_cam <= 0:
        fps_cam = TARGET_FPS_DEFAULT
    skip_frames = int(max(1, round(fps_cam / max(1, args.frame_rate))))
    frame_count = 0
    default_preview_side = int(max(320, min(img_size, SPEED_STREAM_MAX_SIDE)))
    stream_preview_side = default_preview_side
    if args.stream_preview_side is not None:
        stream_preview_side = int(max(320, min(1920, int(args.stream_preview_side))))
    stream_jpeg_quality = 15
    if args.stream_jpeg_quality is not None:
        stream_jpeg_quality = int(max(10, min(100, int(args.stream_jpeg_quality))))
    print(
        f"[speed.py] stream_fps_camera={fps_cam:.2f} target_fps={max(1, args.frame_rate)} "
        f"skip_frames={skip_frames} preview_side={stream_preview_side} "
        f"preview_jpeg_q={stream_jpeg_quality} infer_imgsz={img_size} "
        f"socket_preview_enabled={SOCKET_PREVIEW_ENABLED}"
    )
    print(
        f"[speed.py] plate_guard_enabled={PLATE_GUARD_ENABLED} "
        f"det_every_n={PLATE_GUARD_DET_EVERY_N} "
        f"vehicle_conf={PLATE_GUARD_VEHICLE_CONF:.2f} "
        f"fraud_conf={PLATE_GUARD_FRAUD_CONF:.2f}"
    )

    # Perf
    last_perf = time.time()
    perf_processed_frames = 0
    auth_guard_cache = {
        "vehicles": [],
        "frauds": [],
        "frame_idx": -1,
    }
    last_guard_reject_log_ts = 0.0
    fraud_alert_feedback = {
        "reason": None,
        "timestamp": 0.0,
    }

    # --------------------------
    # Helpers: reset sessão
    # --------------------------
    def reset_session_buffers():
        nonlocal best_vehicle, first_session_frame, session_frame_idx, session_last_line_mode
        best_vehicle = {"frame": None, "bboxes": None, "cls": None, "conf": None, "score": 0.0}
        first_session_frame = None
        session_frame_idx = 0
        session_last_line_mode = None
        session.clear()

    def emit_preview_frame(display_frame):
        if not SOCKET_PREVIEW_ENABLED:
            return
        if display_frame is None or getattr(display_frame, "size", 0) == 0:
            return

        h, w = display_frame.shape[:2]
        preview_side = int(max(1, min(stream_preview_side, max(h, w))))
        if w >= h:
            target_w = preview_side
            target_h = max(1, int((h * target_w) / w))
        else:
            target_h = preview_side
            target_w = max(1, int((w * target_h) / h))

        small = cv2.resize(display_frame, (target_w, target_h))
        ok, enc = cv2.imencode(".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), int(stream_jpeg_quality)])
        if not ok:
            return

        try:
            sio.emit("frame", {
                "channelId": args.channel_id,
                "image": enc.tobytes(),
                "size": len(enc) / 1024.0
            })
        except Exception:
            pass

    def _video_open(file_name, w, h):
        out_path = os.path.join(clips_dir, file_name)

        # Preferência: H.264 via ffmpeg/libx264 (Chrome friendly)
        vw = FFmpegVideoWriter(out_path, w, h, VIDEO_FPS)
        if vw.isOpened():
            print(f"[speed.py] FFmpegVideoWriter aberto (libx264) size={w}x{h} fps={VIDEO_FPS}")
            return vw

        print("[speed.py] ERRO: FFmpegVideoWriter não abriu.", file=sys.stderr)
        try:
            vw.release()
        except Exception:
            pass
        return None


    def stop_video_clip(reason="", delete_file=False):
        nonlocal video_writer, video_active, video_frames_written, video_file_name
        nonlocal video_pending_open, video_target_size

        cur_name = video_file_name

        if video_writer is not None:
            try:
                video_writer.release()
            except Exception:
                pass

        video_writer = None
        video_active = False
        video_pending_open = False
        video_target_size = None

        if cur_name and (delete_file or video_frames_written == 0):
            try:
                os.remove(os.path.join(clips_dir, cur_name))
                print(f"[speed.py] Clip removido: {cur_name} (delete={delete_file}, frames={video_frames_written})")
            except Exception:
                pass

        if reason:
            print(f"[speed.py] VIDEO STOP ({reason}) file={cur_name} frames={video_frames_written}")

        if delete_file:
            video_file_name = None

    def start_video_clip(session_id, kind, duration_ms):
        nonlocal video_writer, video_file_name, video_deadline_ts, video_active, video_frames_written
        nonlocal video_pending_open, video_target_size

        if video_writer is not None or video_active:
            stop_video_clip("restart", delete_file=False)

        video_frames_written = 0

        ts_ms = int(time.time() * 1000)
        safe_sid = sanitize_filename(str(session_id or "nosid"))
        video_file_name = f"clip_{kind}_{safe_sid}_{ts_ms}.mp4"

        video_deadline_ts = time.time() + (int(duration_ms) / 1000.0)
        video_active = True

        video_writer = None
        video_pending_open = True
        video_target_size = None

        print(f"[speed.py] VIDEO ARMED: {video_file_name} dur={duration_ms}ms fps={VIDEO_FPS}")

    def write_video_frame(display_frame):
        nonlocal video_writer, video_active, video_frames_written
        nonlocal video_pending_open, video_target_size, video_file_name

        if not video_active:
            return

        if display_frame is None or getattr(display_frame, "size", 0) == 0:
            return

        h, w = display_frame.shape[:2]
        cur_size = (w, h)

        if video_pending_open:
            vw = _video_open(video_file_name, w, h)
            if vw is None:
                video_writer = None
                video_active = False
                video_pending_open = False
                video_target_size = None
                video_file_name = None
                return

            video_writer = vw
            video_target_size = cur_size
            video_pending_open = False

        if video_target_size != cur_size:
            print(f"[speed.py] AVISO: resolução mudou de {video_target_size} para {cur_size}. Encerrando clip atual.")
            stop_video_clip("size_changed", delete_file=False)
            return

        if video_writer is None:
            return

        try:
            video_writer.write(display_frame)
            video_frames_written += 1
        except Exception as e:
            print("[speed.py] ERRO ao escrever frame no vídeo:", e, file=sys.stderr)

    def start_speed_session(session_id, radar_id, speed, speed_ts_iso, window_ms):
        nonlocal current_session_id
        nonlocal session_active, session_kind, session_deadline_ts, current_speed_meta
        nonlocal live_capture_pending

        current_session_id = session_id

        session_kind = "speed"
        session_active = True

        current_speed_meta = {
            "radarId": radar_id or args.radarId,
            "speed": speed,
            "speedTimestamp": speed_ts_iso
        }

        wms = int(window_ms) if window_ms else 8000
        session_deadline_ts = time.time() + (wms / 1000.0)

        start_video_clip(session_id=session_id, kind="speed", duration_ms=wms)

        live_capture_pending = False

        reset_session_buffers()
        print(f"[speed.py] SPEED SESSION START: {current_speed_meta} windowMs={wms}")

    def start_live_session(timeout_ms):
        nonlocal session_active, session_kind, session_deadline_ts
        nonlocal live_capture_pending, live_capture_timeout_ms

        session_kind = "live"
        session_active = True

        live_capture_pending = True
        live_capture_timeout_ms = int(timeout_ms) if timeout_ms else 7000
        session_deadline_ts = time.time() + (live_capture_timeout_ms / 1000.0)

        current_speed_meta["speed"] = None
        current_speed_meta["speedTimestamp"] = None

        reset_session_buffers()
        print(f"[speed.py] LIVE SESSION START timeoutMs={live_capture_timeout_ms}")

    def stop_live_session():
        nonlocal live_capture_pending, session_active, session_kind
        live_capture_pending = False
        if session_kind == "live":
            session_active = False
            session_kind = None
            stop_video_clip("live_cancel")
            reset_session_buffers()
        print(f"[speed.py] LIVE SESSION STOP")

    def emit_plate_found(final_text, file_name):
        payload = {
            "channelId": args.channel_id,
            "radarId": current_speed_meta.get("radarId") or args.radarId,
            "sessionId": current_session_id,
            "plate": final_text,
            "eventType": "speed_plate",
            "timestamp": datetime.now().isoformat(),
            "fileName": file_name,
            "videoFileName": video_file_name,
            "speed": current_speed_meta.get("speed"),
            "speedTimestamp": current_speed_meta.get("speedTimestamp"),
            "sessionKind": session_kind
        }
        try:
            sio.emit("plate-found-speed", payload)
        except Exception:
            pass

    def emit_vehicle_only(file_name, vehicle_cls, vehicle_conf):
        payload = {
            "channelId": args.channel_id,
            "sessionId": current_session_id,
            "radarId": current_speed_meta.get("radarId") or args.radarId,
            "speed": current_speed_meta.get("speed"),
            "speedTimestamp": current_speed_meta.get("speedTimestamp"),
            "timestamp": datetime.now().isoformat(),
            "fileName": file_name,
            "videoFileName": video_file_name,
            "vehicleClass": vehicle_cls,
            "vehicleConf": vehicle_conf
        }
        try:
            sio.emit("vehicle-only", payload)
        except Exception as e:
            print("[speed.py] Erro ao emitir vehicle-only:", e, file=sys.stderr)

    def finalize_session(reason="normal"):
        nonlocal last_final_plate, last_final_ts, last_final_layout_label
        nonlocal session_active, session_kind, live_capture_pending, session_last_line_mode

        kind = session_kind

        if not session.has_data():
            reset_session_buffers()
            session_active = False
            if kind == "live":
                live_capture_pending = False
            session_kind = None
            return

        final_text, cnt, avg = session.mode()
        if not final_text:
            reset_session_buffers()
            session_active = False
            if kind == "live":
                live_capture_pending = False
            session_kind = None
            return

        if session_last_line_mode == "single":
            final_layout_label = "Carro"
        elif session_last_line_mode == "double":
            final_layout_label = "Moto"
        else:
            final_layout_label = None

        last_final_plate = final_text
        last_final_layout_label = final_layout_label
        last_final_ts = time.time()

        ts_str = datetime.now().strftime('%H%M%S%f')[:-3]
        safe_pred = sanitize_filename(final_text)
        file_name = f"{safe_pred}_{ts_str}.jpg"

        best_full, best_bboxes = session.get_best()
        if best_full is not None:
            try:
                out = best_full.copy()
                if best_bboxes:
                    for x1, y1, x2, y2, color, thick in best_bboxes:
                        cv2.rectangle(out, (x1, y1), (x2, y2), color, thick)
                cv2.imwrite(os.path.join(captures_dir, file_name), out)
            except Exception as e:
                print(f"[speed.py] Erro ao salvar imagem full: {e}", file=sys.stderr)

        emit_plate_found(final_text, file_name)

        if kind == "speed":
            stop_video_clip("plate_end_no_clip", delete_file=True)

        reset_session_buffers()
        session_active = False
        if kind == "live":
            live_capture_pending = False
        session_kind = None

        print(f"[speed.py] SESSION END (plate) reason={reason} plate={final_text}")

    def finalize_no_plate():
        nonlocal session_active, session_kind

        if session_kind != "speed":
            reset_session_buffers()
            session_active = False
            session_kind = None
            return

        radar_id = current_speed_meta.get("radarId") or args.radarId

        chosen = None
        chosen_boxes = None
        vcls = None
        vconf = None

        if best_vehicle.get("frame") is not None:
            chosen = best_vehicle["frame"]
            chosen_boxes = best_vehicle.get("bboxes")
            vcls = best_vehicle.get("cls")
            vconf = best_vehicle.get("conf")
        elif first_session_frame is not None:
            chosen = first_session_frame

        if chosen is None:
            reset_session_buffers()
            session_active = False
            session_kind = None
            return

        out = chosen.copy()
        if chosen_boxes:
            for x1, y1, x2, y2, color, thick in chosen_boxes:
                cv2.rectangle(out, (x1, y1), (x2, y2), color, thick)

        ts_ms = int(time.time() * 1000)
        file_name = f"vehicle_{radar_id}_{ts_ms}.jpg"
        out_path = os.path.join(captures_dir, file_name)

        try:
            cv2.imwrite(out_path, out)
            print("[speed.py] vehicle-only salvo em:", out_path)
        except Exception as e:
            print("[speed.py] Erro ao salvar vehicle-only:", e, file=sys.stderr)
            reset_session_buffers()
            session_active = False
            session_kind = None
            return

        emit_vehicle_only(file_name, vcls, vconf)

        stop_video_clip("no_plate_end")

        reset_session_buffers()
        session_active = False
        session_kind = None
        print(f"[speed.py] SESSION END (no-plate) file={file_name}")

    # =========================================================
    # Socket.IO handlers (AGORA COM ESTADO + HELPERS JÁ EXISTINDO)
    # =========================================================
    @sio.event
    def connect():
        print(f"[speed.py] Socket.IO conectado sid={sio.sid}")
        try:
            sio.emit("join", args.channel_id)
            print(f"[speed.py] join enviado: {args.channel_id}")
        except Exception as e:
            print(f"[speed.py] Falha no join: {e}", file=sys.stderr)

    @sio.event
    def connect_error(data):
        print(f"[speed.py] connect_error: {data}", file=sys.stderr)

    @sio.event
    def disconnect():
        print("[speed.py] Socket.IO desconectado", file=sys.stderr)

    @sio.on("speed-session-start")
    def on_speed_session_start(data):
        nonlocal session_deadline_ts, current_session_id
        nonlocal hud_speed, hud_speed_ts, hud_lock_until, hud_last_update
        nonlocal hud_speed_limit, hud_tolerance
        nonlocal session_active, session_kind

        if not data or data.get("channelId") != args.channel_id:
            return

        try:
            wms = int(data.get("windowMs") or 8000)
        except Exception:
            wms = 8000

        sp = data.get("speed")
        hud_speed = float(sp) if sp is not None else None
        hud_speed_ts = data.get("speedTimestamp")
        hud_lock_until = time.time() + (wms / 1000.0)
        hud_last_update = time.time()

        sl = data.get("speedLimit")
        tl = data.get("tolerance")
        hud_speed_limit = float(sl) if sl is not None else hud_speed_limit
        hud_tolerance   = float(tl) if tl is not None else hud_tolerance

        incoming_sid = data.get("sessionId")

        if session_active and session_kind == "speed":
            if incoming_sid and incoming_sid == current_session_id:
                current_speed_meta["speed"] = data.get("speed")
                current_speed_meta["speedTimestamp"] = data.get("speedTimestamp")
                session_deadline_ts = max(session_deadline_ts, time.time() + (wms / 1000.0))
                return
            return

        start_speed_session(
            session_id=data.get("sessionId"),
            radar_id=data.get("radarId") or args.radarId,
            speed=data.get("speed"),
            speed_ts_iso=data.get("speedTimestamp"),
            window_ms=wms
        )

    @sio.on("live-plate-capture-start")
    def on_live_plate_capture_start(data):
        if not data or data.get("channelId") != args.channel_id:
            return
        start_live_session(timeout_ms=data.get("timeoutMs") or 7000)

    @sio.on("live-plate-capture-cancel")
    def on_live_plate_capture_cancel(data):
        if not data or data.get("channelId") != args.channel_id:
            return
        stop_live_session()

    @sio.on("speed-reading")
    def on_speed_reading(data):
        nonlocal hud_speed, hud_speed_ts, hud_lock_until, hud_last_update
        nonlocal hud_speed_limit, hud_tolerance

        if not data or data.get("channelId") != args.channel_id:
            return

        sp = data.get("speed")
        if sp is None:
            return

        if time.time() < hud_lock_until:
            return

        hud_speed = float(sp)
        hud_speed_ts = data.get("speedTimestamp")
        hud_last_update = time.time()

        sl = data.get("speedLimit")
        tl = data.get("tolerance")
        if sl is not None:
            hud_speed_limit = float(sl)
        if tl is not None:
            hud_tolerance = float(tl)

    def connect_with_retry():
        token = args.socket_token or os.getenv("INTERNAL_SOCKET_TOKEN", "")

        if not token:
            print("[speed.py] ERRO: socket token ausente. Use --socket_token ou INTERNAL_SOCKET_TOKEN.", file=sys.stderr)
            # se quiser fail-hard:
            # sys.exit(2)

        while True:
            try:
                print(f"[speed.py] Conectando em {SERVER_URL} ...")
                sio.connect(
                    SERVER_URL,
                    socketio_path="socket.io",
                    transports=["polling", "websocket"],
                    wait_timeout=10,
                    auth={"token": token},   # <<< AQUI
                )
                return
            except Exception as e:
                print(f"[speed.py] Erro ao conectar Socket.IO: {e}", file=sys.stderr)
                time.sleep(1.0)



    # =========================================================
    # AGORA SIM: conecta e emite status (depois de tudo existir)
    # =========================================================
    connect_with_retry()

    if not cap.isOpened():
        try:
            sio.emit("process-error", {
                "channelId": args.channel_id,
                "errorType": "open_video_error"
            })
        except Exception:
            pass
    else:
        try:
            sio.emit("process-started", {"channelId": args.channel_id})
        except Exception:
            pass

    # --------------------------
    # Loop principal
    # --------------------------
    try:
        consecutive_fail = 0

        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                consecutive_fail += 1
                if consecutive_fail >= 30:
                    try:
                        cap.release()
                    except Exception:
                        pass
                    time.sleep(1.0)
                    cap = cv2.VideoCapture(rtsp)
                    consecutive_fail = 0
                continue
            consecutive_fail = 0

            if frame_count % skip_frames != 0:
                frame_count += 1
                continue
            frame_count += 1

            display = frame.copy()

            # ==========================================
            # IDLE: não roda YOLO (apenas preview)
            # ==========================================
            if (not session_active) and (not live_capture_pending):
                perf_processed_frames += 1

                if last_final_plate:
                    draw_plate_marquee(
                        display,
                        last_final_plate,
                        last_final_ts,
                        PLATE_MARQUEE_SECONDS,
                        last_final_layout_label
                    )

                write_video_frame(display)

                if video_active and time.time() >= video_deadline_ts:
                    stop_video_clip("deadline_idle")

                draw_speed_hud(
                    display,
                    hud_speed,
                    hud_speed_limit,
                    hud_tolerance,
                    hud_lock_until,
                    hud_last_update,
                    ttl_s=HUD_TTL_S
                )

                emit_preview_frame(display)

                elapsed_perf = time.time() - last_perf
                if elapsed_perf >= 5.0:
                    stream_fps = perf_processed_frames / elapsed_perf if elapsed_perf > 0 else 0.0
                    measure_performance(sio, args.channel_id, img_size, avg_fps=stream_fps)
                    last_perf = time.time()
                    perf_processed_frames = 0

                continue

            # ==========================================
            # Sessão ativa: roda IA
            # ==========================================
            if first_session_frame is None:
                first_session_frame = frame.copy()

            session_frame_idx += 1

            if session_kind == "speed" and (session_frame_idx % VEHICLE_DET_EVERY_N == 0):
                update_best_vehicle(frame, detector_model, img_size, best_vehicle)

            try:
                results = plate_model.predict(frame, imgsz=img_size, verbose=False)
            except Exception as e:
                print(f"Erro na predição de placa: {e}", file=sys.stderr)
                results = [None]

            result_boxes = (
                results[0].boxes
                if results and results[0] is not None and results[0].boxes is not None
                else []
            )

            guard_vehicle_boxes = []
            guard_fraud_boxes = []
            if PLATE_GUARD_ENABLED and len(result_boxes) > 0:
                must_refresh_guard = (
                    auth_guard_cache["frame_idx"] < 0
                    or (session_frame_idx % PLATE_GUARD_DET_EVERY_N == 0)
                )
                if must_refresh_guard:
                    vehicles, frauds = detect_context_objects(frame, detector_model, img_size)
                    auth_guard_cache["vehicles"] = vehicles
                    auth_guard_cache["frauds"] = frauds
                    auth_guard_cache["frame_idx"] = session_frame_idx

                guard_vehicle_boxes = auth_guard_cache["vehicles"]
                guard_fraud_boxes = auth_guard_cache["frauds"]

            candidate_reads = []
            bboxes = []

            if len(result_boxes) > 0:
                for box in result_boxes:
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    if x2 <= x1 or y2 <= y1:
                        continue

                    plate_bbox_candidate = {
                        "xmin": x1,
                        "ymin": y1,
                        "xmax": x2,
                        "ymax": y2,
                    }
                    color = (0, 255, 0)

                    if PLATE_GUARD_ENABLED:
                        guard_ok, guard_reason = evaluate_plate_guard(
                            plate_bbox_candidate,
                            guard_vehicle_boxes,
                            guard_fraud_boxes,
                        )
                        if not guard_ok:
                            color = (0, 0, 255)
                            fraud_alert_feedback["reason"] = guard_reason_to_label(guard_reason)
                            fraud_alert_feedback["timestamp"] = time.time()
                            now_ts = time.time()
                            if now_ts - last_guard_reject_log_ts >= 1.2:
                                print(
                                    f"[speed.py] Bloqueado por guard antifraude: "
                                    f"channel={args.channel_id} reason={guard_reason}",
                                    file=sys.stderr,
                                )
                                last_guard_reject_log_ts = now_ts
                            bboxes.append((x1, y1, x2, y2, color, 2))
                            continue

                    crop = frame[y1:y2, x1:x2]

                    raw_text, raw_conf, compliant_text, line_mode = read_license_plate_both(crop, ocr_model, img_size)

                    if compliant_text and raw_conf and raw_conf > OCR_MEAN_CONF_THRESHOLD:
                        candidate_reads.append((compliant_text, raw_conf, crop, line_mode))
                        color = (0, 0, 255)
                    bboxes.append((x1, y1, x2, y2, color, 2))

            for x1, y1, x2, y2, color, thick in bboxes:
                cv2.rectangle(display, (x1, y1), (x2, y2), color, thick)

            new_text = None
            new_conf = None
            new_crop = None
            new_line_mode = None
            if candidate_reads:
                candidate_reads.sort(key=lambda x: x[1], reverse=True)
                new_text, new_conf, new_crop, new_line_mode = candidate_reads[0]

            if new_text:
                if not session.has_data():
                    session.add(new_text, new_conf, new_crop, frame, bboxes=bboxes)
                    if new_line_mode is not None:
                        session_last_line_mode = new_line_mode
                else:
                    mode_text, mode_cnt, mode_avg = session.mode()
                    if session.total_reads >= MIN_SAMPLES_BEFORE_DIFF:
                        dist = normalized_distance(new_text, mode_text)
                        if dist >= DIFF_NORM_THRESHOLD:
                            finalize_session(reason="diff")
                            if session_active:
                                session.add(new_text, new_conf, new_crop, frame, bboxes=bboxes)
                                if new_line_mode is not None:
                                    session_last_line_mode = new_line_mode
                        else:
                            session.add(new_text, new_conf, new_crop, frame, bboxes=bboxes)
                            if new_line_mode is not None:
                                session_last_line_mode = new_line_mode
                    else:
                        session.add(new_text, new_conf, new_crop, frame, bboxes=bboxes)
                        if new_line_mode is not None:
                            session_last_line_mode = new_line_mode

            if session.has_data():
                mode_text, mode_cnt, mode_avg = session.mode()
                if session_kind == "speed" and mode_cnt >= MIN_PLATE_VOTES_SPEED:
                    finalize_session(reason="votes")
                elif session_kind == "live" and mode_cnt >= MIN_PLATE_VOTES_LIVE:
                    finalize_session(reason="live_votes")

            if session_active and session.has_data() and session.age_since_last() >= GAP_TIMEOUT_S:
                finalize_session(reason="gap")

            if session_active and time.time() >= session_deadline_ts:
                if session_kind == "speed":
                    if not session.has_data():
                        finalize_no_plate()
                    else:
                        finalize_session(reason="deadline")
                else:
                    print("[speed.py] LIVE SESSION TIMEOUT (sem placa). Encerrando.")
                    reset_session_buffers()
                    session_active = False
                    live_capture_pending = False
                    session_kind = None

            draw_speed_hud(
                display,
                hud_speed,
                hud_speed_limit,
                hud_tolerance,
                hud_lock_until,
                hud_last_update,
                ttl_s=HUD_TTL_S
            )

            draw_session_badge(display, session)
            if last_final_plate:
                draw_plate_marquee(
                    display,
                    last_final_plate,
                    last_final_ts,
                    PLATE_MARQUEE_SECONDS,
                    last_final_layout_label
                )

            write_video_frame(display)
            if video_active and time.time() >= video_deadline_ts:
                stop_video_clip("deadline_active")

            emit_preview_frame(display)
            perf_processed_frames += 1

            elapsed_perf = time.time() - last_perf
            if elapsed_perf >= 5.0:
                stream_fps = perf_processed_frames / elapsed_perf if elapsed_perf > 0 else 0.0
                measure_performance(sio, args.channel_id, img_size, avg_fps=stream_fps)
                last_perf = time.time()
                perf_processed_frames = 0

    except KeyboardInterrupt:
        pass
    finally:
        try:
            cap.release()
        except Exception:
            pass
        try:
            sio.emit("process-stopped", {"channelId": args.channel_id})
        except Exception:
            pass
        try:
            sio.disconnect()
        except Exception:
            pass

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Erro fatal: {e}", file=sys.stderr)
        sys.exit(1)
