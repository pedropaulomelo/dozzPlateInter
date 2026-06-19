#!/usr/bin/env python3
import argparse
import json
import os
import queue
import string
import sys
import threading
import time
import traceback
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime

import cv2
import numpy as np
import psutil
import GPUtil
import socketio

os.environ.setdefault("MPLCONFIGDIR", "/tmp/dozz-matplotlib")
os.environ.setdefault("XDG_CACHE_HOME", "/tmp/dozz-cache")
from ultralytics import YOLO

SERVER_URL = "http://localhost:4000"

# OCR / motion defaults (mantidos iguais ao plateReader.py)
OCR_MIN_CONF = 0.16
MOTION_DEFAULT_MODE = "aproximando"
MOTION_DEFAULT_SENSITIVITY = 60
MOTION_EVENT_COOLDOWN_SEC = 0.45
DIRECTION_CACHE_TTL_SEC = 2.0
TRACKED_PLATE_TIMEOUT_SEC = 2.0
PLATE_BANNER_TTL_SEC = 4.0
DOOR_FEEDBACK_TTL_SEC = 4.0
PERF_REPORT_INTERVAL_SEC = 5.0
ORIENTATION_HISTORY_MAX_POINTS = 8
ORIENTATION_HISTORY_MAX_AGE_SEC = 2.5
ORIENTATION_REQUIRED_HITS = 2
ORIENTATION_MIN_SCORE = 0.55
ORIENTATION_MODEL_CONF = 0.08
ORIENTATION_CACHE_REFRESH_EVERY_N = 4
ORIENTATION_PLATE_OVERLAP_MIN = 0.20
ORIENTATION_INFER_SIZE = 640
ORIENTATION_MAX_VEHICLES = 1
ORIENTATION_MIN_BOX_SIDE = 90
ORIENTATION_VEHICLE_EXPAND_FACTOR = 1.12
ORIENTATION_PLATE_FALLBACK_EXPAND_FACTOR = 6.0
ORIENTATION_VEHICLE_CACHE_ENABLED = os.getenv("ORIENTATION_VEHICLE_CACHE_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")
ORIENTATION_HEURISTIC_FAST_CONF = 0.60
ORIENTATION_DISABLE_ON_SLOW = os.getenv("ORIENTATION_DISABLE_ON_SLOW", "true").strip().lower() in ("1", "true", "yes", "on")
ORIENTATION_SLOW_MS = float(os.getenv("ORIENTATION_SLOW_MS", "350"))
ORIENTATION_TFLITE_THREADS = max(
    1,
    min(
        int(os.getenv("ORIENTATION_TFLITE_THREADS", str(min(12, os.cpu_count() or 1)))),
        os.cpu_count() or 1,
    ),
)

VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle", "bicycle", "train"}
DEFAULT_FRAUD_CLASSES = "person,cell phone,book,remote,laptop,tv"
ORIENTATION_CLASS_NAMES = {
    0: "car_back",
    1: "car_side",
    2: "car_front",
    3: "bus_back",
    4: "bus_side",
    5: "bus_front",
    6: "truck_back",
    7: "truck_side",
    8: "truck_front",
    9: "motorcycle_back",
    10: "motorcycle_side",
    11: "motorcycle_front",
    12: "bicycle_back",
    13: "bicycle_side",
    14: "bicycle_front",
}

# Mapeamentos OCR
DICT_CHAR_TO_INT = {'O': '0', 'I': '1', 'Z': '2', 'J': '3', 'A': '4', 'S': '5', 'G': '6', 'B': '8'}
DICT_INT_TO_CHAR = {'0': 'O', '1': 'I', '2': 'Z', '3': 'J', '4': 'A', '5': 'S', '6': 'G', '8': 'B'}


def parse_bool(value, default=True):
    if value is None:
        return bool(default)
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
    return bool(default)


def clamp_int(value, default, min_value=None, max_value=None):
    try:
        out = int(value)
    except (TypeError, ValueError):
        out = int(default)
    if min_value is not None:
        out = max(min_value, out)
    if max_value is not None:
        out = min(max_value, out)
    return out


def clamp_float(value, default, min_value=None, max_value=None):
    try:
        out = float(value)
    except (TypeError, ValueError):
        out = float(default)
    if min_value is not None:
        out = max(min_value, out)
    if max_value is not None:
        out = min(max_value, out)
    return out


def normalize_rtsp_transport(value):
    normalized = str(value or "").strip().lower()
    if normalized in ("tcp", "udp", "udp_multicast", "http", "https"):
        return normalized
    return "tcp"


def default_stream_subtype():
    return clamp_int(os.getenv("PLATE_RTSP_SUBTYPE", "0"), 0, 0, 1)


def configure_opencv_rtsp_transport(transport=None):
    safe_transport = normalize_rtsp_transport(transport or os.getenv("PLATE_RTSP_TRANSPORT", "tcp"))
    existing = str(os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS") or "").strip()
    if "rtsp_transport" in existing:
        return existing

    options = f"rtsp_transport;{safe_transport}"
    if existing:
        options = f"{existing}|{options}"
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = options
    return options


DEFAULT_RTSP_TRANSPORT = normalize_rtsp_transport(os.getenv("PLATE_RTSP_TRANSPORT", "tcp"))
configure_opencv_rtsp_transport(DEFAULT_RTSP_TRANSPORT)


def normalize_motion_mode(raw_mode):
    mode = str(raw_mode or MOTION_DEFAULT_MODE).strip().lower()
    return "afastando" if mode == "afastando" else "aproximando"


def clamp_motion_sensitivity(raw_sensitivity):
    return clamp_float(raw_sensitivity, MOTION_DEFAULT_SENSITIVITY, 1.0, 100.0)


def expected_orientation_for_mode(mode):
    return "back" if normalize_motion_mode(mode) == "afastando" else "front"


def normalize_orientation_label(raw_label):
    text = str(raw_label or "").strip().lower()
    if text in ("front", "back", "side"):
        return text
    if text.endswith("_front"):
        return "front"
    if text.endswith("_back"):
        return "back"
    if text.endswith("_side"):
        return "side"
    return None


def normalize_orientation_vehicle_class(raw_label):
    text = str(raw_label or "").strip().lower()
    if "_" not in text:
        return None
    vehicle_class = text.rsplit("_", 1)[0]
    if vehicle_class == "cycle":
        vehicle_class = "bicycle"
    return vehicle_class


def get_result_names_map(result, fallback=None):
    names = getattr(result, "names", None)
    if isinstance(names, dict):
        return names
    if isinstance(names, list):
        return {idx: value for idx, value in enumerate(names)}
    return dict(fallback or {})


def sanitize_filename(filename):
    valid_chars = "-_.() %s%s" % (string.ascii_letters, string.digits)
    return ''.join(c for c in str(filename) if c in valid_chars)


def license_complies_format(text, plate_class):
    if plate_class == 'new':
        if len(text) != 7:
            return False
        mapping = [
            DICT_INT_TO_CHAR, DICT_INT_TO_CHAR, DICT_INT_TO_CHAR,
            DICT_CHAR_TO_INT, DICT_INT_TO_CHAR, DICT_CHAR_TO_INT, DICT_CHAR_TO_INT
        ]
        for i in range(7):
            if i in [0, 1, 2, 4]:
                valid_chars = string.ascii_uppercase + ''.join(mapping[i].keys())
            else:
                valid_chars = '0123456789' + ''.join(mapping[i].keys())
            if text[i] not in valid_chars:
                return False
        return True

    if plate_class == 'old':
        if len(text) != 7:
            return False
        mapping = [
            DICT_INT_TO_CHAR, DICT_INT_TO_CHAR, DICT_INT_TO_CHAR,
            DICT_CHAR_TO_INT, DICT_CHAR_TO_INT, DICT_CHAR_TO_INT, DICT_CHAR_TO_INT
        ]
        for i in range(7):
            if i in [0, 1, 2]:
                valid_chars = string.ascii_uppercase + ''.join(mapping[i].keys())
            else:
                valid_chars = '0123456789' + ''.join(mapping[i].keys())
            if text[i] not in valid_chars:
                return False
        return True

    return False


def format_license(text, plate_class):
    if plate_class == 'new':
        mapping = [
            DICT_INT_TO_CHAR, DICT_INT_TO_CHAR, DICT_INT_TO_CHAR,
            DICT_CHAR_TO_INT, DICT_INT_TO_CHAR, DICT_CHAR_TO_INT, DICT_CHAR_TO_INT
        ]
    elif plate_class == 'old':
        mapping = [
            DICT_INT_TO_CHAR, DICT_INT_TO_CHAR, DICT_INT_TO_CHAR,
            DICT_CHAR_TO_INT, DICT_CHAR_TO_INT, DICT_CHAR_TO_INT, DICT_CHAR_TO_INT
        ]
    else:
        return text

    out = ''
    for i in range(7):
        c = text[i]
        out += mapping[i].get(c, c)
    return out


def remove_leading_zero(token):
    token = str(token)
    if token.startswith('0') and len(token) > 1:
        return token[1:]
    return token


def read_license_plate(license_plate_crop, plate_class, model, img_size):
    if license_plate_crop is None or license_plate_crop.size == 0:
        return None, None

    try:
        detections = model.predict(license_plate_crop, imgsz=img_size, verbose=False)
    except Exception:
        return None, None

    for detection in detections:
        boxes = detection.boxes
        if boxes is None:
            continue
        class_ids = boxes.cls
        scores = boxes.conf
        xyxy = boxes.xyxy
        class_names = detection.names

        det_list = []
        for box, cls, score in zip(xyxy, class_ids, scores):
            x_min = float(box[0].item())
            char = class_names[int(cls)]
            conf = float(score.item())
            det_list.append((x_min, char, conf))

        if not det_list:
            continue

        det_list_sorted = sorted(det_list, key=lambda x: x[0])
        plate_full = ''.join([remove_leading_zero(ch) for _, ch, _ in det_list_sorted])
        average_conf = sum([c for _, _, c in det_list_sorted]) / len(det_list_sorted)
        text = plate_full.upper().replace(' ', '')

        if average_conf >= OCR_MIN_CONF and license_complies_format(text, plate_class):
            return format_license(text, plate_class), average_conf

    return None, None


def resolve_model_path(base_path, model_name, img_size):
    model_dir = os.path.join(base_path, 'models')
    candidates = [
        os.path.join(model_dir, f'{model_name}_{img_size}.engine'),
        os.path.join(model_dir, f'{model_name}.engine'),
        os.path.join(model_dir, f'{model_name}_{img_size}.tflite'),
        os.path.join(model_dir, f'{model_name}.tflite'),
        os.path.join(model_dir, f'{model_name}_{img_size}.onnx'),
        os.path.join(model_dir, f'{model_name}.onnx'),
        os.path.join(model_dir, f'{model_name}_{img_size}.pt'),
        os.path.join(model_dir, f'{model_name}.pt'),
    ]
    if model_name == 'orientation':
        candidates.extend([
            os.path.join(model_dir, 'orientation_640.tflite'),
            os.path.join(model_dir, 'orientation_640.onnx'),
            os.path.join(model_dir, 'orientation_640.pt'),
        ])
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return None


def resolve_pt_model_path(base_path, model_name, img_size):
    model_dir = os.path.join(base_path, 'models')
    candidates = [
        os.path.join(model_dir, f'{model_name}_{img_size}.pt'),
        os.path.join(model_dir, f'{model_name}.pt'),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return None


def load_yolo_with_fallback(base_path, model_name, preferred_path, img_size, device, task="detect"):
    errors = []

    if preferred_path:
        try:
            model = YOLO(preferred_path, task=task)
            if str(preferred_path).lower().endswith(".pt"):
                model.to(device)
            return model, preferred_path
        except Exception as exc:
            errors.append(f"{preferred_path}: {exc}")

    pt_path = resolve_pt_model_path(base_path, model_name, img_size)
    if pt_path and pt_path != preferred_path:
        try:
            model = YOLO(pt_path, task=task)
            model.to(device)
            return model, pt_path
        except Exception as exc:
            errors.append(f"{pt_path}: {exc}")

    detail = '; '.join(errors) if errors else 'modelo nao encontrado'
    raise RuntimeError(f"Falha ao carregar modelo {model_name} ({img_size}) no device {device}: {detail}")


def predict_batch_safe(model, frames, img_size, device=None, conf=None):
    if not frames:
        return []

    kwargs = {
        "imgsz": img_size,
        "verbose": False,
    }
    if device is not None:
        kwargs["device"] = device
    if conf is not None:
        kwargs["conf"] = conf

    try:
        results = model.predict(frames, **kwargs)
        if isinstance(results, list) and len(results) == len(frames):
            return results
    except Exception:
        pass

    out = []
    for frame in frames:
        try:
            single = model.predict(frame, **kwargs)
            out.append(single[0] if single else None)
        except Exception:
            out.append(None)
    return out


def letterbox_image(frame, new_shape):
    shape = frame.shape[:2]  # h, w
    if isinstance(new_shape, int):
        new_shape = (new_shape, new_shape)

    r = min(new_shape[0] / shape[0], new_shape[1] / shape[1])
    new_unpad = (int(round(shape[1] * r)), int(round(shape[0] * r)))
    dw = float(new_shape[1] - new_unpad[0]) / 2.0
    dh = float(new_shape[0] - new_unpad[1]) / 2.0

    if shape[::-1] != new_unpad:
        frame = cv2.resize(frame, new_unpad, interpolation=cv2.INTER_LINEAR)

    top = int(round(dh - 0.1))
    bottom = int(round(dh + 0.1))
    left = int(round(dw - 0.1))
    right = int(round(dw + 0.1))
    bordered = cv2.copyMakeBorder(
        frame, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(114, 114, 114)
    )
    return bordered, r, dw, dh


class OrientationTFLiteModel:
    def __init__(self, model_path):
        import tensorflow as tf

        self.model_path = model_path
        self.num_threads = ORIENTATION_TFLITE_THREADS
        self.interpreter = tf.lite.Interpreter(model_path=model_path, num_threads=self.num_threads)
        self.interpreter.allocate_tensors()
        self.input_details = self.interpreter.get_input_details()[0]
        self.output_details = self.interpreter.get_output_details()[0]
        self.input_size = int(self.input_details['shape'][1])

    def predict(self, frame, conf_threshold=ORIENTATION_MODEL_CONF, iou_threshold=0.45):
        if frame is None or frame.size == 0:
            return []

        resized, ratio, dw, dh = letterbox_image(frame, self.input_size)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        batch = np.expand_dims(rgb, axis=0)

        self.interpreter.set_tensor(self.input_details['index'], batch)
        self.interpreter.invoke()
        raw = self.interpreter.get_tensor(self.output_details['index'])
        preds = raw[0]
        if preds.ndim != 2 or preds.shape[1] < 20:
            return []

        object_conf = preds[:, 4]
        class_scores = preds[:, 5:20]
        class_ids = np.argmax(class_scores, axis=1)
        class_conf = class_scores[np.arange(class_scores.shape[0]), class_ids]
        scores = object_conf * class_conf
        keep = scores >= float(conf_threshold)
        if not np.any(keep):
            return []

        preds = preds[keep]
        class_ids = class_ids[keep]
        scores = scores[keep]

        boxes_xywh = preds[:, :4]
        nms_boxes = boxes_xywh.tolist()
        score_list = scores.astype(float).tolist()
        indices = cv2.dnn.NMSBoxes(nms_boxes, score_list, float(conf_threshold), float(iou_threshold))
        if indices is None or len(indices) == 0:
            return []

        selected = []
        for idx in np.array(indices).reshape(-1):
            cx, cy, w, h = boxes_xywh[idx]
            x1 = max(0.0, (float(cx) - float(w) / 2.0 - dw) / max(ratio, 1e-6))
            y1 = max(0.0, (float(cy) - float(h) / 2.0 - dh) / max(ratio, 1e-6))
            x2 = min(float(frame.shape[1]), (float(cx) + float(w) / 2.0 - dw) / max(ratio, 1e-6))
            y2 = min(float(frame.shape[0]), (float(cy) + float(h) / 2.0 - dh) / max(ratio, 1e-6))
            if x2 <= x1 or y2 <= y1:
                continue

            cls_id = int(class_ids[idx])
            cls_name = ORIENTATION_CLASS_NAMES.get(cls_id, str(cls_id))
            selected.append({
                "xmin": x1,
                "ymin": y1,
                "xmax": x2,
                "ymax": y2,
                "cls": cls_name,
                "vehicle_cls": normalize_orientation_vehicle_class(cls_name),
                "orientation": normalize_orientation_label(cls_name),
                "conf": float(scores[idx]),
            })

        return selected


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


def clip_bbox_to_frame(bbox, frame_shape):
    height, width = frame_shape[:2]
    x1 = max(0, min(width - 1, int(round(float(bbox["xmin"])))))
    y1 = max(0, min(height - 1, int(round(float(bbox["ymin"])))))
    x2 = max(0, min(width, int(round(float(bbox["xmax"])))))
    y2 = max(0, min(height, int(round(float(bbox["ymax"])))))
    return {
        "xmin": x1,
        "ymin": y1,
        "xmax": x2,
        "ymax": y2,
    }


def crop_frame_from_bbox(frame, bbox, expand_factor=1.0):
    target_bbox = expand_bbox(bbox, expand_factor) if float(expand_factor) != 1.0 else dict(bbox)
    clipped = clip_bbox_to_frame(target_bbox, frame.shape)
    if clipped["xmax"] <= clipped["xmin"] or clipped["ymax"] <= clipped["ymin"]:
        return None, None
    crop = frame[clipped["ymin"]:clipped["ymax"], clipped["xmin"]:clipped["xmax"]]
    if crop is None or crop.size == 0:
        return None, None
    return crop, clipped


def choose_best_orientation_candidate(candidates):
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda item: (float(item.get("conf", 0.0) or 0.0), bbox_area(item))
    )


def infer_orientation_from_lights(crop):
    if crop is None or crop.size == 0:
        return None

    crop_h, crop_w = crop.shape[:2]
    if min(crop_h, crop_w) < 48:
        return None

    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    focus = hsv[int(crop_h * 0.12):int(crop_h * 0.95), :]
    if focus.size == 0:
        focus = hsv

    red_mask = cv2.bitwise_or(
        cv2.inRange(focus, (0, 90, 70), (12, 255, 255)),
        cv2.inRange(focus, (168, 90, 70), (180, 255, 255)),
    )
    white_mask = cv2.inRange(focus, (0, 0, 180), (180, 70, 255))

    def _mask_stats(mask):
        mask_bool = mask > 0
        if mask_bool.size == 0:
            return 0.0, 0.0, 0.0, 0.0
        _, width = mask_bool.shape
        if width < 2:
            ratio = float(mask_bool.mean())
            return ratio, ratio, 1.0 if ratio > 0 else 0.0, ratio
        left = mask_bool[:, :width // 2]
        right = mask_bool[:, width // 2:]
        left_ratio = float(left.mean()) if left.size else 0.0
        right_ratio = float(right.mean()) if right.size else 0.0
        dominant = max(left_ratio, right_ratio)
        symmetry = (min(left_ratio, right_ratio) / dominant) if dominant > 1e-6 else 0.0
        total = float(mask_bool.mean())
        return left_ratio, right_ratio, symmetry, total

    red_left, red_right, red_symmetry, red_total = _mask_stats(red_mask)
    white_left, white_right, white_symmetry, white_total = _mask_stats(white_mask)

    rear_score = (red_total * 2.3) + (red_symmetry * 0.4) - (white_total * 0.6)
    front_score = (white_total * 1.8) + (white_symmetry * 0.35) - (red_total * 0.35)

    if (
        rear_score >= 0.24
        and rear_score > (front_score * 1.25)
        and min(red_left, red_right) >= 0.03
    ):
        return {
            "orientation": "back",
            "conf": min(0.92, 0.35 + rear_score),
            "cls": "heuristic_back",
            "method": "lights",
        }

    if (
        front_score >= 0.18
        and front_score > (rear_score * 1.20)
        and min(white_left, white_right) >= 0.02
    ):
        return {
            "orientation": "front",
            "conf": min(0.92, 0.35 + front_score),
            "cls": "heuristic_front",
            "method": "lights",
        }

    return None


def classify_orientation_from_bbox(
    frame,
    bbox,
    orientation_model,
    expand_factor=1.0,
    infer_size=ORIENTATION_INFER_SIZE,
    vehicle_cls=None,
    source="vehicle",
    prefer_heuristic=False,
    timing_info=None,
):
    crop, _ = crop_frame_from_bbox(frame, bbox, expand_factor=expand_factor)
    if crop is None:
        return None

    heuristic = infer_orientation_from_lights(crop)
    heuristic_payload = None
    if heuristic:
        heuristic_payload = {
            "xmin": float(bbox["xmin"]),
            "ymin": float(bbox["ymin"]),
            "xmax": float(bbox["xmax"]),
            "ymax": float(bbox["ymax"]),
            "cls": heuristic.get("cls"),
            "vehicle_cls": vehicle_cls or bbox.get("cls"),
            "orientation": heuristic.get("orientation"),
            "conf": float(heuristic.get("conf", 0.0) or 0.0),
            "method": heuristic.get("method", "lights"),
            "source": source,
        }
        if prefer_heuristic or heuristic_payload["conf"] >= ORIENTATION_HEURISTIC_FAST_CONF:
            return heuristic_payload

    detections = []
    if orientation_model is None:
        detections = []
    elif isinstance(orientation_model, OrientationTFLiteModel):
        started_at = time.perf_counter()
        detections = orientation_model.predict(crop, conf_threshold=ORIENTATION_MODEL_CONF)
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        if timing_info is not None:
            timing_info.update({
                "used_model": True,
                "engine": "tflite",
                "elapsed_ms": elapsed_ms,
                "detections": len(detections),
            })
    else:
        started_at = time.perf_counter()
        try:
            results = orientation_model.predict(
                crop,
                imgsz=infer_size,
                device='cpu',
                conf=ORIENTATION_MODEL_CONF,
                verbose=False,
            )
        except Exception:
            results = []
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        result = results[0] if results else None
        detections = detect_orientation_objects_from_result(result, ORIENTATION_MODEL_CONF)
        if timing_info is not None:
            timing_info.update({
                "used_model": True,
                "engine": "yolo",
                "elapsed_ms": elapsed_ms,
                "detections": len(detections),
            })

    best = choose_best_orientation_candidate(detections)
    if best:
        return {
            "xmin": float(bbox["xmin"]),
            "ymin": float(bbox["ymin"]),
            "xmax": float(bbox["xmax"]),
            "ymax": float(bbox["ymax"]),
            "cls": best.get("cls"),
            "vehicle_cls": vehicle_cls or best.get("vehicle_cls"),
            "orientation": best.get("orientation"),
            "conf": float(best.get("conf", 0.0) or 0.0),
            "method": "model",
            "source": source,
        }

    return heuristic_payload


def build_orientation_boxes_from_vehicle_boxes(frame, vehicle_boxes, orientation_model, timing_sink=None):
    if not vehicle_boxes:
        return []

    ranked_boxes = sorted(vehicle_boxes, key=bbox_area, reverse=True)
    output = []
    for vehicle_bbox in ranked_boxes:
        width = max(0.0, float(vehicle_bbox["xmax"]) - float(vehicle_bbox["xmin"]))
        height = max(0.0, float(vehicle_bbox["ymax"]) - float(vehicle_bbox["ymin"]))
        if min(width, height) < ORIENTATION_MIN_BOX_SIDE:
            continue

        timing_info = {}
        classified = classify_orientation_from_bbox(
            frame,
            vehicle_bbox,
            orientation_model,
            expand_factor=ORIENTATION_VEHICLE_EXPAND_FACTOR,
            infer_size=ORIENTATION_INFER_SIZE,
            vehicle_cls=vehicle_bbox.get("cls"),
            source="vehicle",
            timing_info=timing_info,
        )
        if timing_sink is not None and timing_info.get("used_model"):
            timing_sink.append(timing_info)
        if classified:
            output.append(classified)
        if len(output) >= ORIENTATION_MAX_VEHICLES:
            break

    return output


def detect_context_objects_from_result(result, vehicle_conf, fraud_conf, fraud_classes):
    vehicle_boxes = []
    fraud_boxes = []
    if result is None or result.boxes is None:
        return vehicle_boxes, fraud_boxes

    names = result.names
    for detection_box in result.boxes:
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

        if cls_name in VEHICLE_CLASSES and conf >= vehicle_conf:
            vehicle_boxes.append(bbox)
        if cls_name in fraud_classes and conf >= fraud_conf:
            fraud_boxes.append(bbox)

    return vehicle_boxes, fraud_boxes


def detect_orientation_objects_from_result(result, conf_threshold):
    orientation_boxes = []
    if result is None or result.boxes is None:
        return orientation_boxes

    names = get_result_names_map(result, ORIENTATION_CLASS_NAMES)
    for detection_box in result.boxes:
        cls_id = int(detection_box.cls[0])
        cls_name = str(names.get(cls_id, cls_id)).lower()
        orientation = normalize_orientation_label(cls_name)
        vehicle_class = normalize_orientation_vehicle_class(cls_name)
        conf = float(detection_box.conf[0])
        if orientation is None or vehicle_class not in VEHICLE_CLASSES or conf < conf_threshold:
            continue

        x1, y1, x2, y2 = map(float, detection_box.xyxy[0])
        orientation_boxes.append({
            "xmin": x1,
            "ymin": y1,
            "xmax": x2,
            "ymax": y2,
            "cls": cls_name,
            "vehicle_cls": vehicle_class,
            "orientation": orientation,
            "conf": conf,
        })

    return orientation_boxes


def evaluate_plate_guard(plate_bbox, vehicle_boxes, fraud_boxes, min_plate_overlap, expand_factor):
    if not vehicle_boxes:
        return False, "no_vehicle"

    plate_area = max(1.0, bbox_area(plate_bbox))
    matched_vehicle = None
    best_overlap = 0.0
    for vehicle_bbox in vehicle_boxes:
        overlap = bbox_intersection_area(plate_bbox, vehicle_bbox) / plate_area
        if overlap > best_overlap:
            best_overlap = overlap
            matched_vehicle = vehicle_bbox

    if matched_vehicle is None or best_overlap < min_plate_overlap:
        return False, "plate_not_on_vehicle"

    expanded_plate = expand_bbox(plate_bbox, expand_factor)
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


def match_plate_to_orientation_box(plate_bbox, orientation_boxes, min_overlap=ORIENTATION_PLATE_OVERLAP_MIN):
    if not orientation_boxes:
        return None

    plate_area = max(1.0, bbox_area(plate_bbox))
    matched_box = None
    best_overlap = 0.0
    best_score = 0.0

    for vehicle_bbox in orientation_boxes:
        overlap = bbox_intersection_area(plate_bbox, vehicle_bbox) / plate_area
        if overlap <= 0.0:
            continue
        score = overlap + (float(vehicle_bbox.get("conf", 0.0)) * 0.1)
        if score > best_score:
            best_score = score
            best_overlap = overlap
            matched_box = vehicle_bbox

    if matched_box is None or best_overlap < min_overlap:
        return None

    out = dict(matched_box)
    out["plate_overlap"] = best_overlap
    return out


def evaluate_plate_orientation(orientation_history, expected_orientation):
    if not orientation_history:
        return False, None

    recent = []
    now_ts = float(orientation_history[-1].get("t", 0.0))
    for item in orientation_history:
        if now_ts - float(item.get("t", 0.0)) <= ORIENTATION_HISTORY_MAX_AGE_SEC:
            recent.append(item)
    if not recent:
        return False, None

    counts = {"front": 0, "back": 0, "side": 0}
    scores = {"front": 0.0, "back": 0.0, "side": 0.0}
    max_conf = {"front": 0.0, "back": 0.0, "side": 0.0}

    for sample in recent:
        orientation = sample.get("orientation")
        if orientation not in counts:
            continue
        conf = float(sample.get("conf", 0.0) or 0.0)
        counts[orientation] += 1
        scores[orientation] += conf
        max_conf[orientation] = max(max_conf[orientation], conf)

    dominant_orientation = max(scores, key=lambda key: (scores[key], counts[key]))
    expected_hits = counts.get(expected_orientation, 0)
    expected_score = scores.get(expected_orientation, 0.0)
    competing_score = max(
        value for key, value in scores.items()
        if key != expected_orientation
    )

    matched = (
        expected_hits >= ORIENTATION_REQUIRED_HITS
        and dominant_orientation == expected_orientation
        and expected_score >= ORIENTATION_MIN_SCORE
        and expected_score > competing_score
    )

    return matched, {
        "dominant_orientation": dominant_orientation,
        "expected_orientation": expected_orientation,
        "counts": counts,
        "scores": scores,
        "max_conf": max_conf,
        "history_size": len(recent),
    }


def get_ui_scale(frame):
    h, w = frame.shape[:2]
    base = float(max(h, w))
    return max(1.15, min(3.2, base / 760.0))


def choose_bbox_style(direction_hint):
    if direction_hint is True:
        return (0, 255, 0), "IDA"
    if direction_hint is False:
        return (0, 255, 255), "N/A"
    return (0, 255, 255), "N/A"


def orientation_to_display_label(orientation):
    normalized = normalize_orientation_label(orientation)
    if normalized == "front":
        return "FRONT"
    if normalized == "back":
        return "REAR"
    if normalized == "side":
        return "SIDE"
    return "UNK"


def orientation_to_overlay_color(orientation, expected_orientation):
    normalized = normalize_orientation_label(orientation)
    if normalized == expected_orientation:
        return (0, 215, 0)
    if normalized == "side":
        return (0, 255, 255)
    if normalized == "front":
        return (255, 180, 0)
    if normalized == "back":
        return (0, 165, 255)
    return (160, 160, 160)


def draw_orientation_boxes(frame, orientation_boxes, motion_mode):
    if frame is None or frame.size == 0 or not orientation_boxes:
        return

    expected_orientation = expected_orientation_for_mode(motion_mode)
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = get_ui_scale(frame)
    fs = 0.46 * scale
    th = max(2, int(round(1.6 * scale)))
    pad_x = max(6, int(round(6 * scale)))
    pad_y = max(5, int(round(5 * scale)))
    box_thickness = max(2, int(round(2.0 * scale)))

    for item in orientation_boxes:
        orientation = item.get("orientation")
        if orientation not in ("front", "back", "side"):
            continue

        x1 = max(0, int(round(float(item.get("xmin", 0.0)))))
        y1 = max(0, int(round(float(item.get("ymin", 0.0)))))
        x2 = min(frame.shape[1] - 1, int(round(float(item.get("xmax", 0.0)))))
        y2 = min(frame.shape[0] - 1, int(round(float(item.get("ymax", 0.0)))))
        if x2 <= x1 or y2 <= y1:
            continue

        color = orientation_to_overlay_color(orientation, expected_orientation)
        conf = float(item.get("conf", 0.0) or 0.0)
        label = f"{orientation_to_display_label(orientation)} {conf:.2f}"
        (tw, th_text), base = cv2.getTextSize(label, font, fs, th)

        label_left = x1
        label_top = max(0, y1 - th_text - base - pad_y * 2 - 2)
        label_bottom = min(frame.shape[0] - 1, label_top + th_text + base + pad_y * 2)
        label_right = min(frame.shape[1] - 1, label_left + tw + pad_x * 2)
        if label_right <= label_left or label_bottom <= label_top:
            continue

        overlay = frame.copy()
        cv2.rectangle(overlay, (label_left, label_top), (label_right, label_bottom), (16, 16, 16), -1)
        cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)

        cv2.rectangle(frame, (x1, y1), (x2, y2), color, box_thickness)
        cv2.rectangle(frame, (label_left, label_top), (label_right, label_bottom), color, max(1, box_thickness - 1))
        cv2.putText(
            frame,
            label,
            (label_left + pad_x, label_bottom - base - pad_y),
            font,
            fs,
            (245, 245, 245),
            th,
            cv2.LINE_AA,
        )


def draw_areas_and_lines(frame, areas, triggered_areas_lines):
    current_time = time.time()
    removal_list = []
    for line_id, trig_data in triggered_areas_lines['lines'].items():
        dt = current_time - trig_data['timestamp']
        if dt > 1.0:
            removal_list.append(line_id)

    for rid in removal_list:
        del triggered_areas_lines['lines'][rid]

    for area in areas:
        if area.get('type') == 'line':
            line_id = area.get('_id')
            base_thickness = 10
            base_color = (255, 0, 0)

            if line_id in triggered_areas_lines['lines']:
                direction_bool = triggered_areas_lines['lines'][line_id]['direction']
                if direction_bool is True:
                    color = (0, 0, 255)
                    thickness = int(base_thickness * 1.25)
                else:
                    color = base_color
                    thickness = base_thickness
            else:
                color = base_color
                thickness = base_thickness

            cv2.line(
                frame,
                (int(area.get('x1', 0)), int(area.get('y1', 0))),
                (int(area.get('x2', 0)), int(area.get('y2', 0))),
                color,
                thickness,
            )

            for d in area.get('directions', []) or []:
                if line_id in triggered_areas_lines['lines']:
                    dir_bool = triggered_areas_lines['lines'][line_id]['direction']
                    arrow_color = (0, 0, 255) if dir_bool is True else (0, 255, 255)
                else:
                    arrow_color = (0, 255, 255)

                cv2.arrowedLine(
                    frame,
                    (int(d.get('x1', 0)), int(d.get('y1', 0))),
                    (int(d.get('x2', 0)), int(d.get('y2', 0))),
                    arrow_color,
                    thickness,
                )

        elif area.get('type') == 'area':
            pts_raw = area.get('points') or []
            if not pts_raw:
                continue
            pts = np.array([[pt['x'], pt['y']] for pt in pts_raw], np.int32).reshape((-1, 1, 2))
            cv2.polylines(frame, [pts], True, (0, 255, 0), 5)


def draw_plate_top_banner(frame, plate_banner_feedback):
    plate = plate_banner_feedback.get('plate')
    if not plate:
        return
    dt = time.time() - plate_banner_feedback.get('timestamp', 0.0)
    if dt > PLATE_BANNER_TTL_SEC:
        return

    direction_hint = plate_banner_feedback.get('direction')
    color, direction_label = choose_bbox_style(direction_hint)
    label = f"PLACA {plate}  |  {direction_label}"

    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = get_ui_scale(frame)
    fs = 1.35 * scale
    th = max(3, int(round(2.9 * scale)))
    pad = max(16, int(round(16 * scale)))

    (tw, th_text), base = cv2.getTextSize(label, font, fs, th)
    max_width = max(50, frame.shape[1] - 24)
    while tw + pad * 2 > max_width and fs > 0.9:
        fs -= 0.08
        (tw, th_text), base = cv2.getTextSize(label, font, fs, th)

    top = max(10, int(round(20 * scale)))
    bottom = top + th_text + base + pad * 2
    left = max(0, (frame.shape[1] - (tw + pad * 2)) // 2)
    right = min(frame.shape[1] - 1, left + tw + pad * 2)

    overlay = frame.copy()
    cv2.rectangle(overlay, (left, top), (right, bottom), (18, 18, 18), -1)
    cv2.addWeighted(overlay, 0.58, frame, 0.42, 0, frame)
    cv2.rectangle(frame, (left, top), (right, bottom), color, max(3, int(round(3 * scale))))
    cv2.putText(
        frame,
        label,
        (left + pad, bottom - base - pad),
        font,
        fs,
        (245, 245, 245),
        th,
        cv2.LINE_AA,
    )


def draw_door_feedback(frame, door_command_feedback):
    if door_command_feedback['accepted'] is None:
        return
    dt = time.time() - door_command_feedback.get('timestamp', 0.0)
    if dt > DOOR_FEEDBACK_TTL_SEC:
        return

    accepted = bool(door_command_feedback['accepted'])
    plate = door_command_feedback.get('plate') or "-"
    status_line = "COMANDO ACEITO" if accepted else "COMANDO FALHOU"
    color = (0, 180, 0) if accepted else (0, 0, 200)

    line1 = f"Placa: {plate}"
    line2 = status_line

    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = get_ui_scale(frame)
    fs1, fs2 = 1.08 * scale, 1.32 * scale
    th1, th2 = max(3, int(round(2.5 * scale))), max(3, int(round(2.9 * scale)))

    (w1, h1), b1 = cv2.getTextSize(line1, font, fs1, th1)
    (w2, h2), b2 = cv2.getTextSize(line2, font, fs2, th2)

    pad = max(16, int(round(16 * scale)))
    gap = max(10, int(round(11 * scale)))
    box_w = max(w1, w2) + pad * 2
    box_h = h1 + h2 + b1 + b2 + pad * 2 + gap

    x2 = frame.shape[1] - max(10, int(round(20 * scale)))
    y1 = max(10, int(round(20 * scale)))
    x1 = max(0, x2 - box_w)
    y2 = y1 + box_h

    overlay = frame.copy()
    cv2.rectangle(overlay, (x1, y1), (x2, y2), (15, 15, 15), -1)
    cv2.addWeighted(overlay, 0.58, frame, 0.42, 0, frame)
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, max(2, int(round(2 * scale))))

    t1_y = y1 + pad + h1
    t2_y = t1_y + gap + h2 + b1
    cv2.putText(frame, line1, (x1 + pad, t1_y), font, fs1, (240, 240, 240), th1, cv2.LINE_AA)
    cv2.putText(frame, line2, (x1 + pad, t2_y), font, fs2, color, th2, cv2.LINE_AA)


def get_bbox_motion_size(bbox):
    w = max(1.0, float(bbox['xmax']) - float(bbox['xmin']))
    h = max(1.0, float(bbox['ymax']) - float(bbox['ymin']))
    return float(np.sqrt(w * h))


def evaluate_plate_motion(size_history, mode, sensitivity):
    if len(size_history) < 3:
        return False, None

    newest = size_history[-1]
    oldest = size_history[0]
    span_sec = float(newest['t']) - float(oldest['t'])
    if span_sec <= 0.0:
        return False, None

    diffs = []
    for i in range(1, len(size_history)):
        prev = float(size_history[i - 1]['s'])
        curr = float(size_history[i]['s'])
        diffs.append(curr - prev)

    if not diffs:
        return False, None

    up_steps = sum(1 for d in diffs if d > 0)
    down_steps = sum(1 for d in diffs if d < 0)
    steps = len(diffs)

    sensitivity_clamped = clamp_motion_sensitivity(sensitivity)
    required_delta = float(np.interp(sensitivity_clamped, [1.0, 100.0], [MOTION_MIN_DELTA_HARD, MOTION_MIN_DELTA_EASY]))
    required_ratio = float(np.interp(sensitivity_clamped, [1.0, 100.0], [MOTION_RATIO_HARD, MOTION_RATIO_EASY]))
    net_delta = float(newest['s']) - float(oldest['s'])
    up_ratio = up_steps / float(steps)
    down_ratio = down_steps / float(steps)

    if mode == "aproximando":
        matched = (net_delta >= required_delta) and (up_ratio >= required_ratio)
    else:
        matched = (net_delta <= -required_delta) and (down_ratio >= required_ratio)

    return matched, {
        'net_delta': net_delta,
        'required_delta': required_delta,
        'ratio': up_ratio if mode == "aproximando" else down_ratio,
        'required_ratio': required_ratio,
        'span_sec': span_sec,
    }


def measure_performance_payload(stream_fps, img_size):
    cpu_percent = psutil.cpu_percent(interval=None)
    ram_usage = psutil.virtual_memory().percent

    gpus = GPUtil.getGPUs()
    if gpus:
        gpu = gpus[0]
        gpu_load = gpu.load * 100
        gpu_memory_usage = gpu.memoryUtil * 100
    else:
        gpu_load = 0.0
        gpu_memory_usage = 0.0

    return {
        "avg_fps": round(stream_fps, 2),
        "cpu_usage": cpu_percent,
        "ram_usage": ram_usage,
        "gpu_usage": round(gpu_load, 1),
        "gpu_memory_usage": round(gpu_memory_usage, 1),
        "imgsz": img_size,
    }


class FrameGrabber(threading.Thread):
    def __init__(self, rtsp_url, rtsp_transport=DEFAULT_RTSP_TRANSPORT):
        super().__init__(daemon=True)
        self.rtsp_url = rtsp_url
        self.rtsp_transport = normalize_rtsp_transport(rtsp_transport)
        self._lock = threading.Lock()
        self._frame = None
        self._seq = 0
        self._stop_event = threading.Event()

    def stop(self):
        self._stop_event.set()

    def get_latest_after(self, last_seq):
        with self._lock:
            if self._seq <= last_seq or self._frame is None:
                return last_seq, None
            return self._seq, self._frame.copy()

    def run(self):
        cap = None
        while not self._stop_event.is_set():
            if cap is None:
                configure_opencv_rtsp_transport(self.rtsp_transport)
                cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                if not cap.isOpened():
                    cap.release()
                    cap = cv2.VideoCapture(self.rtsp_url)
                try:
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                except Exception:
                    pass

            ok, frame = cap.read()
            if not ok or frame is None:
                try:
                    cap.release()
                except Exception:
                    pass
                cap = None
                time.sleep(0.35)
                continue

            with self._lock:
                self._frame = frame
                self._seq += 1

        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass


@dataclass
class ChannelState:
    channel_id: str
    ip: str
    user: str
    password: str
    dvr_channel: int
    stream_subtype: int
    rtsp_transport: str
    frame_rate: int
    img_size: int
    device: str
    preview_side: int
    preview_jpeg_quality: int
    vector_sense_enabled: bool
    motion_mode: str
    motion_sensitivity: float
    plate_guard_enabled: bool
    plate_guard_det_every_n: int
    plate_guard_vehicle_conf: float
    plate_guard_fraud_conf: float
    plate_guard_min_plate_overlap: float
    plate_guard_expand_factor: float
    fraud_classes: set
    actions: list = field(default_factory=list)
    areas: list = field(default_factory=list)

    capture: FrameGrabber = None
    last_seq_processed: int = 0
    next_process_ts: float = 0.0
    frame_idx: int = 0
    started_emitted: bool = False

    tracked_plates: dict = field(default_factory=dict)
    plate_direction_state: dict = field(default_factory=dict)
    triggered_areas_lines: dict = field(default_factory=lambda: {'areas': {}, 'lines': {}})

    door_command_feedback: dict = field(default_factory=lambda: {
        'plate': None,
        'accepted': None,
        'timestamp': 0.0,
        'message': None,
    })
    plate_banner_feedback: dict = field(default_factory=lambda: {
        'plate': None,
        'direction': None,
        'timestamp': 0.0,
    })

    guard_cache: dict = field(default_factory=lambda: {
        'vehicles': [],
        'frauds': [],
        'frame_idx': -1,
    })
    orientation_cache: dict = field(default_factory=lambda: {
        'vehicles': [],
        'frame_idx': -1,
    })
    last_guard_reject_log_ts: float = 0.0

    perf_last_report_ts: float = field(default_factory=time.time)
    perf_processed_frames: int = 0

    def rtsp_url(self):
        return (
            f"rtsp://{self.user}:{self.password}@{self.ip}:554/"
            f"cam/realmonitor?channel={self.dvr_channel}&subtype={self.stream_subtype}"
        )

    def min_interval(self):
        return 1.0 / float(max(1, self.frame_rate))


class ModelBundle:
    def __init__(self, base_path, img_size, device):
        self.base_path = base_path
        self.img_size = img_size
        self.device = device

        plate_path = resolve_model_path(base_path, 'plate', img_size)
        ocr_path = resolve_model_path(base_path, 'ocr', img_size)
        if not plate_path or not ocr_path:
            raise RuntimeError(
                f"Modelo ausente para imgsz={img_size} (plate={plate_path}, ocr={ocr_path})"
            )

        self.plate_model, self.plate_path = load_yolo_with_fallback(
            base_path, 'plate', plate_path, img_size, device
        )
        self.ocr_model, self.ocr_path = load_yolo_with_fallback(
            base_path, 'ocr', ocr_path, img_size, device
        )
        self.detector_model = None
        self.detector_path = None
        self.orientation_model = None
        self.orientation_path = None
        self.orientation_disabled = False
        self.orientation_disabled_reason = None

    def ensure_detector(self):
        if self.detector_model is not None:
            return self.detector_model

        detector_path = resolve_model_path(self.base_path, 'detector', self.img_size)
        if not detector_path:
            raise RuntimeError(f"Modelo detector ausente para imgsz={self.img_size}")

        self.detector_model, self.detector_path = load_yolo_with_fallback(
            self.base_path, 'detector', detector_path, self.img_size, self.device
        )
        return self.detector_model

    def ensure_orientation(self):
        if self.orientation_disabled:
            return None
        if self.orientation_model is not None:
            return self.orientation_model

        orientation_path = resolve_model_path(self.base_path, 'orientation', self.img_size)
        if not orientation_path:
            raise RuntimeError(f"Modelo orientation ausente para imgsz={self.img_size}")

        started_at = time.perf_counter()
        if str(orientation_path).lower().endswith(".tflite"):
            self.orientation_model = OrientationTFLiteModel(orientation_path)
            self.orientation_path = orientation_path
            load_ms = (time.perf_counter() - started_at) * 1000.0
            print(
                f"[plate-batch] orientation model loaded imgsz={self.img_size} "
                f"device={self.device} engine=tflite threads={ORIENTATION_TFLITE_THREADS} load_ms={load_ms:.1f}",
                flush=True,
            )
            return self.orientation_model

        self.orientation_model, self.orientation_path = load_yolo_with_fallback(
            self.base_path, 'orientation', orientation_path, self.img_size, self.device
        )
        load_ms = (time.perf_counter() - started_at) * 1000.0
        print(
            f"[plate-batch] orientation model loaded imgsz={self.img_size} "
            f"device={self.device} engine=yolo load_ms={load_ms:.1f}",
            flush=True,
        )
        return self.orientation_model

    def disable_orientation(self, reason):
        self.orientation_disabled = True
        self.orientation_disabled_reason = str(reason or "disabled")
        self.orientation_model = None


class PlateBatchWorker:
    def __init__(self, socket_token=None):
        self.socket_token = socket_token
        self.base_path = os.path.abspath('.')
        self.plates_dir = os.path.join(self.base_path, 'plates')
        os.makedirs(self.plates_dir, exist_ok=True)

        self.channels = {}
        self.channels_lock = threading.Lock()
        self.bundles = {}

        self.stop_event = threading.Event()
        self.cmd_queue = queue.Queue()

        self.sio = socketio.Client(reconnection=True, reconnection_attempts=0, logger=False, engineio_logger=False)
        self._bind_socket_handlers()

    def _log(self, msg):
        print(f"[plate-batch] {msg}", flush=True)

    def _bind_socket_handlers(self):
        @self.sio.event
        def connect():
            self._log("Socket.IO conectado")
            with self.channels_lock:
                ids = list(self.channels.keys())
            for channel_id in ids:
                try:
                    self.sio.emit('join', channel_id)
                except Exception:
                    pass

        @self.sio.event
        def disconnect():
            self._log("Socket.IO desconectado")

        @self.sio.on('door-command-result')
        def on_door_command_result(data):
            if not data:
                return
            channel_id = data.get('channelId')
            if not channel_id:
                return
            with self.channels_lock:
                state = self.channels.get(channel_id)
            if not state:
                return

            state.door_command_feedback['plate'] = data.get('plate')
            state.door_command_feedback['accepted'] = bool(data.get('accepted'))
            state.door_command_feedback['message'] = data.get('message')
            state.door_command_feedback['timestamp'] = time.time()

    def _connect_socket(self):
        token = self.socket_token or os.getenv("INTERNAL_SOCKET_TOKEN", "")
        kwargs = {
            "socketio_path": "socket.io",
            "transports": ["polling", "websocket"],
            "wait_timeout": 10,
        }
        if token:
            kwargs["auth"] = {"token": token}

        try:
            self.sio.connect(SERVER_URL, **kwargs)
        except Exception as exc:
            self._log(f"ERRO ao conectar Socket.IO: {exc}")
            raise

    def _bundle_key(self, state):
        return (state.img_size, state.device)

    def _get_bundle(self, state):
        key = self._bundle_key(state)
        bundle = self.bundles.get(key)
        if bundle is None:
            bundle = ModelBundle(self.base_path, state.img_size, state.device)
            self.bundles[key] = bundle
            self._log(
                f"bundle carregado imgsz={state.img_size} device={state.device} "
                f"plate={bundle.plate_path} ocr={bundle.ocr_path}"
            )
        return bundle

    def preload_bundle(self, img_size, device, with_detector=False):
        tmp = type("BundleCfg", (), {})()
        tmp.img_size = clamp_int(img_size, 640, 320, 1920)
        raw_device = str(device or 'cpu').strip().lower()
        tmp.device = 'cuda' if raw_device.startswith('gpu') or raw_device == 'cuda' else 'cpu'
        bundle = self._get_bundle(tmp)
        if parse_bool(with_detector, False):
            try:
                bundle.ensure_detector()
            except Exception as exc:
                self._log(
                    f"falha preload detector imgsz={tmp.img_size} device={tmp.device}: {exc}"
                )

    def _build_channel_state(self, cfg):
        channel_id = str(cfg.get('channelId') or '').strip()
        if not channel_id:
            raise ValueError("channelId ausente")

        device_raw = str(cfg.get('device') or 'cpu').strip().lower()
        device = 'cuda' if device_raw.startswith('gpu') else 'cpu'
        img_size = clamp_int(cfg.get('imgSize'), 640, 320, 1920)
        fraud_classes_raw = str(cfg.get('plateGuardFraudClasses') or DEFAULT_FRAUD_CLASSES)

        state = ChannelState(
            channel_id=channel_id,
            ip=str(cfg.get('ip') or '').strip(),
            user=str(cfg.get('user') or '').strip(),
            password=str(cfg.get('password') or '').strip(),
            dvr_channel=clamp_int(cfg.get('dvrChannel'), 1, 1, 32),
            stream_subtype=clamp_int(cfg.get('streamSubtype'), default_stream_subtype(), 0, 1),
            rtsp_transport=normalize_rtsp_transport(cfg.get('rtspTransport') or DEFAULT_RTSP_TRANSPORT),
            frame_rate=clamp_int(cfg.get('frameRate'), 5, 1, 60),
            img_size=img_size,
            device=device,
            preview_side=clamp_int(cfg.get('previewWebSide'), min(img_size, 640), 320, 1920),
            preview_jpeg_quality=clamp_int(cfg.get('previewWebJpegQuality'), 15, 10, 100),
            vector_sense_enabled=parse_bool(cfg.get('vectorSenseEnabled'), True),
            motion_mode=normalize_motion_mode(cfg.get('motionMode')),
            motion_sensitivity=clamp_motion_sensitivity(cfg.get('motionSensitivity')),
            plate_guard_enabled=parse_bool(cfg.get('plateGuardEnabled'), True),
            plate_guard_det_every_n=clamp_int(cfg.get('plateGuardDetEveryN'), 2, 1, 120),
            plate_guard_vehicle_conf=clamp_float(cfg.get('plateGuardVehicleConf'), 0.22, 0.0, 1.0),
            plate_guard_fraud_conf=clamp_float(cfg.get('plateGuardFraudConf'), 0.22, 0.0, 1.0),
            plate_guard_min_plate_overlap=clamp_float(cfg.get('plateGuardMinPlateOverlap'), 0.55, 0.0, 1.0),
            plate_guard_expand_factor=clamp_float(cfg.get('plateGuardExpandFactor'), 1.8, 1.0, 8.0),
            fraud_classes={
                part.strip().lower()
                for part in fraud_classes_raw.split(',')
                if part.strip()
            },
            actions=list(cfg.get('actions') or []),
            areas=list(cfg.get('areas') or []),
        )

        if not state.fraud_classes:
            state.fraud_classes = {
                part.strip().lower() for part in DEFAULT_FRAUD_CLASSES.split(',') if part.strip()
            }

        for area in state.areas:
            area.setdefault('directions', [])

        return state

    def add_channel(self, cfg):
        state = self._build_channel_state(cfg)

        with self.channels_lock:
            old = self.channels.get(state.channel_id)
            if old:
                try:
                    old.capture.stop()
                except Exception:
                    pass

            self._get_bundle(state)
            state.capture = FrameGrabber(state.rtsp_url(), state.rtsp_transport)
            state.capture.start()
            self.channels[state.channel_id] = state

        try:
            if self.sio.connected:
                self.sio.emit('join', state.channel_id)
        except Exception:
            pass

        self._log(
            f"canal adicionado id={state.channel_id} ip={state.ip} dvr={state.dvr_channel} "
            f"subtype={state.stream_subtype} rtsp_transport={state.rtsp_transport} "
            f"fps={state.frame_rate} imgsz={state.img_size} device={state.device}"
        )

    def remove_channel(self, channel_id, emit_stop=True):
        with self.channels_lock:
            state = self.channels.pop(channel_id, None)

        if not state:
            return

        try:
            if state.capture:
                state.capture.stop()
        except Exception:
            pass

        if emit_stop:
            try:
                if self.sio.connected:
                    self.sio.emit('process-stopped', {"channelId": channel_id})
            except Exception:
                pass

        self._log(f"canal removido id={channel_id}")

    def _get_plate_direction_hint(self, state, plate_text):
        info = state.plate_direction_state.get(plate_text)
        if not info:
            return None
        if time.time() - info.get('timestamp', 0.0) > DIRECTION_CACHE_TTL_SEC:
            return None
        return info.get('direction')

    def _update_plate_banner_feedback(self, state, plate_text):
        state.plate_banner_feedback['plate'] = plate_text
        state.plate_banner_feedback['direction'] = self._get_plate_direction_hint(state, plate_text)
        state.plate_banner_feedback['timestamp'] = time.time()

    def _cleanup_stale_tracking(self, state, now_ts):
        stale = [
            plate
            for plate, entry in state.tracked_plates.items()
            if now_ts - float(entry.get('last_update', 0.0)) > TRACKED_PLATE_TIMEOUT_SEC
        ]
        for plate in stale:
            state.tracked_plates.pop(plate, None)
            state.plate_direction_state.pop(plate, None)

    def _emit_plate_detection(self, state, plate_bbox, plate_text, orientation_match=None):
        now_ts = time.time()
        last_data = state.tracked_plates.get(plate_text)
        if last_data and (now_ts - last_data.get('last_update', 0.0) <= TRACKED_PLATE_TIMEOUT_SEC):
            orientation_history = list(last_data.get('orientation_history', []))
            motion_event_ts = float(last_data.get('motion_event_ts', 0.0))
        else:
            orientation_history = []
            motion_event_ts = 0.0

        if orientation_match and orientation_match.get('orientation'):
            orientation_history.append({
                't': now_ts,
                'orientation': orientation_match.get('orientation'),
                'conf': float(orientation_match.get('conf', 0.0) or 0.0),
                'label': orientation_match.get('cls'),
                'plate_overlap': float(orientation_match.get('plate_overlap', 0.0) or 0.0),
            })
        orientation_history = [
            item for item in orientation_history
            if now_ts - float(item.get('t', 0.0)) <= ORIENTATION_HISTORY_MAX_AGE_SEC
        ]
        if len(orientation_history) > ORIENTATION_HISTORY_MAX_POINTS:
            orientation_history = orientation_history[-ORIENTATION_HISTORY_MAX_POINTS:]

        state.tracked_plates[plate_text] = {
            'bbox': plate_bbox,
            'last_update': now_ts,
            'orientation_history': orientation_history,
            'motion_event_ts': motion_event_ts,
        }

        if now_ts - float(motion_event_ts) < MOTION_EVENT_COOLDOWN_SEC:
            return

        if not state.vector_sense_enabled:
            state.tracked_plates[plate_text]['motion_event_ts'] = now_ts
            state.plate_direction_state[plate_text] = {'direction': True, 'timestamp': now_ts}

            payload = {
                "channelId": state.channel_id,
                "plate": plate_text,
                "direction": True,
                "vectorSenseEnabled": False,
                "motionMode": None,
                "sensitivity": None,
                "expectedOrientation": None,
                "vehicleOrientation": None,
                "orientationCounts": None,
                "orientationScores": None,
                "orientationConf": None,
                "eventType": "plate_read",
                "timestamp": datetime.now().isoformat(),
            }
            try:
                self.sio.emit('plate-found', payload)
            except Exception:
                pass
            return

        expected_orientation = expected_orientation_for_mode(state.motion_mode)
        matched, stats = evaluate_plate_orientation(orientation_history, expected_orientation)
        if not matched:
            return

        state.tracked_plates[plate_text]['motion_event_ts'] = now_ts
        state.plate_direction_state[plate_text] = {'direction': True, 'timestamp': now_ts}

        payload = {
            "channelId": state.channel_id,
            "plate": plate_text,
            "direction": True,
            "vectorSenseEnabled": True,
            "motionMode": normalize_motion_mode(state.motion_mode),
            "sensitivity": clamp_motion_sensitivity(state.motion_sensitivity),
            "expectedOrientation": expected_orientation,
            "vehicleOrientation": stats['dominant_orientation'] if stats else None,
            "orientationCounts": stats['counts'] if stats else None,
            "orientationScores": stats['scores'] if stats else None,
            "orientationConf": (
                stats['max_conf'].get(stats['dominant_orientation'])
                if stats and stats.get('dominant_orientation')
                else None
            ),
            "eventType": "plate_orientation",
            "timestamp": datetime.now().isoformat(),
        }
        try:
            self.sio.emit('plate-found', payload)
        except Exception:
            pass

    def _emit_preview_frame(self, state, frame):
        if frame is None or frame.size == 0:
            return

        h, w = frame.shape[:2]
        preview_side = int(max(1, min(state.preview_side, max(h, w))))
        if w >= h:
            target_w = preview_side
            target_h = max(1, int((h * target_w) / w))
        else:
            target_h = preview_side
            target_w = max(1, int((w * target_h) / h))

        small = cv2.resize(frame, (target_w, target_h))
        ok, enc = cv2.imencode('.jpg', small, [int(cv2.IMWRITE_JPEG_QUALITY), int(state.preview_jpeg_quality)])
        if not ok:
            return

        try:
            self.sio.emit('frame', {
                "channelId": state.channel_id,
                "image": enc.tobytes(),
                "size": len(enc) / 1024.0,
            })
        except Exception:
            pass

    def _process_single_channel_frame(self, state, frame, plate_result, bundle):
        now_ts = time.time()
        self._cleanup_stale_tracking(state, now_ts)

        if not state.started_emitted:
            try:
                if self.sio.connected:
                    self.sio.emit('process-started', {"channelId": state.channel_id})
            except Exception:
                pass
            state.started_emitted = True

        display = frame.copy()
        if state.vector_sense_enabled:
            draw_orientation_boxes(display, state.orientation_cache['vehicles'], state.motion_mode)

        result_boxes = []
        if plate_result is not None and getattr(plate_result, 'boxes', None) is not None:
            result_boxes = plate_result.boxes

        plate_detected = False
        plate_bbox = None
        detected_plate_text = None
        matched_orientation = None
        orientation_model = None

        for box in result_boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            if x2 <= x1 or y2 <= y1:
                continue

            plate_class_index = int(box.cls[0])
            if plate_class_index == 0:
                plate_class = 'new'
            elif plate_class_index == 1:
                plate_class = 'old'
            else:
                plate_class = 'unknown'

            bbox_candidate = {'xmin': x1, 'ymin': y1, 'xmax': x2, 'ymax': y2}
            color = (0, 255, 255)
            thick = max(2, display.shape[0] // 180)
            orientation_match = None
            if state.vector_sense_enabled:
                orientation_match = match_plate_to_orientation_box(
                    bbox_candidate,
                    state.orientation_cache['vehicles'],
                )

            if state.plate_guard_enabled:
                guard_ok, guard_reason = evaluate_plate_guard(
                    bbox_candidate,
                    state.guard_cache['vehicles'],
                    state.guard_cache['frauds'],
                    state.plate_guard_min_plate_overlap,
                    state.plate_guard_expand_factor,
                )
                if not guard_ok:
                    color = (0, 0, 255)
                    now_log = time.time()
                    if now_log - state.last_guard_reject_log_ts >= 1.2:
                        self._log(
                            f"guard bloqueou channel={state.channel_id} reason={guard_reason}"
                        )
                        state.last_guard_reject_log_ts = now_log
                    cv2.rectangle(display, (x1, y1), (x2, y2), color, thick)
                    continue

            crop = frame[y1:y2, x1:x2]
            plate_text, conf = read_license_plate(crop, plate_class, bundle.ocr_model, state.img_size)
            if plate_text and conf is not None and conf >= OCR_MIN_CONF:
                plate_detected = True
                detected_plate_text = plate_text
                plate_bbox = bbox_candidate
                if state.vector_sense_enabled and orientation_match is None:
                    orientation_timing = {}
                    orientation_match = classify_orientation_from_bbox(
                        frame,
                        bbox_candidate,
                        None,
                        expand_factor=ORIENTATION_PLATE_FALLBACK_EXPAND_FACTOR,
                        infer_size=ORIENTATION_INFER_SIZE,
                        vehicle_cls='plate_proxy',
                        source='plate',
                        prefer_heuristic=True,
                        timing_info=orientation_timing,
                    )
                    if orientation_match is None and not bundle.orientation_disabled:
                        try:
                            if orientation_model is None:
                                orientation_model = bundle.ensure_orientation()
                            orientation_match = classify_orientation_from_bbox(
                                frame,
                                bbox_candidate,
                                orientation_model,
                                expand_factor=ORIENTATION_PLATE_FALLBACK_EXPAND_FACTOR,
                                infer_size=ORIENTATION_INFER_SIZE,
                                vehicle_cls='plate_proxy',
                                source='plate',
                                prefer_heuristic=False,
                                timing_info=orientation_timing,
                            )
                        except Exception:
                            orientation_match = None
                    if orientation_timing.get("used_model"):
                        elapsed_ms = float(orientation_timing.get("elapsed_ms", 0.0) or 0.0)
                        engine = orientation_timing.get("engine", "unknown")
                        self._log(
                            f"orientation channel={state.channel_id} frame={state.frame_idx} "
                            f"source=plate_fallback engine={engine} ms={elapsed_ms:.1f}"
                        )
                        if ORIENTATION_DISABLE_ON_SLOW and elapsed_ms >= ORIENTATION_SLOW_MS:
                            bundle.disable_orientation(f"slow_{elapsed_ms:.1f}ms")
                            self._log(
                                f"orientation disabled imgsz={bundle.img_size} device={bundle.device} "
                                f"reason=slow_inference threshold_ms={ORIENTATION_SLOW_MS:.1f} "
                                f"measured_ms={elapsed_ms:.1f}"
                            )
                matched_orientation = orientation_match
                ts = datetime.now().strftime('%Y%m%d_%H%M%S%f')[:-3]
                fname = f"{sanitize_filename(plate_text)}_{ts}.jpg"
                try:
                    cv2.imwrite(os.path.join(self.plates_dir, fname), crop)
                except Exception:
                    pass

                direction_hint = self._get_plate_direction_hint(state, plate_text)
                color, _ = choose_bbox_style(direction_hint)

            cv2.rectangle(display, (x1, y1), (x2, y2), color, thick)

        if plate_detected and detected_plate_text:
            self._emit_plate_detection(state, plate_bbox, detected_plate_text, matched_orientation)
            self._update_plate_banner_feedback(state, detected_plate_text)
            if state.vector_sense_enabled and matched_orientation and matched_orientation.get('source') == 'plate':
                draw_orientation_boxes(display, [matched_orientation], state.motion_mode)

        draw_areas_and_lines(display, state.areas, state.triggered_areas_lines)
        draw_plate_top_banner(display, state.plate_banner_feedback)
        self._emit_preview_frame(state, display)

        state.perf_processed_frames += 1
        elapsed_perf = now_ts - state.perf_last_report_ts
        if elapsed_perf >= PERF_REPORT_INTERVAL_SEC:
            avg_fps = state.perf_processed_frames / elapsed_perf if elapsed_perf > 0 else 0.0
            payload = measure_performance_payload(avg_fps, state.img_size)
            try:
                self.sio.emit('performance-report', {
                    "channelId": state.channel_id,
                    "data": payload,
                })
            except Exception:
                pass
            state.perf_last_report_ts = now_ts
            state.perf_processed_frames = 0

    def _process_bundle_batch(self, bundle, items):
        if not items:
            return

        frames = [frame for (_state, frame) in items]
        plate_results = predict_batch_safe(bundle.plate_model, frames, bundle.img_size, device=bundle.device)

        detector_requests = []
        orientation_due = {}
        for idx, (state, frame) in enumerate(items):
            result = plate_results[idx] if idx < len(plate_results) else None
            result_boxes = []
            if result is not None and getattr(result, 'boxes', None) is not None:
                result_boxes = result.boxes

            has_plate_candidates = len(result_boxes) > 0
            must_refresh_orientation = (
                state.vector_sense_enabled
                and
                ORIENTATION_VEHICLE_CACHE_ENABLED
                and has_plate_candidates
                and (
                    state.orientation_cache['frame_idx'] < 0
                    or (state.frame_idx % ORIENTATION_CACHE_REFRESH_EVERY_N == 0)
                )
            )
            orientation_due[state.channel_id] = must_refresh_orientation

            must_refresh_guard = False
            if state.plate_guard_enabled and has_plate_candidates:
                must_refresh_guard = (
                    state.guard_cache['frame_idx'] < 0
                    or (state.frame_idx % state.plate_guard_det_every_n == 0)
                )
            if must_refresh_orientation or must_refresh_guard:
                detector_requests.append((state, frame))
            elif not ORIENTATION_VEHICLE_CACHE_ENABLED:
                state.orientation_cache['vehicles'] = []
                state.orientation_cache['frame_idx'] = state.frame_idx

        if detector_requests:
            try:
                detector_model = bundle.ensure_detector()
                det_frames = [f for (_state, f) in detector_requests]
                det_results = predict_batch_safe(detector_model, det_frames, bundle.img_size, device=bundle.device)
            except Exception as exc:
                self._log(f"erro no detector batch imgsz={bundle.img_size}: {exc}")
                det_results = [None] * len(detector_requests)

            orientation_model = None
            if any(orientation_due.get(state.channel_id) for (state, _frame) in detector_requests):
                try:
                    orientation_model = bundle.ensure_orientation()
                except Exception as exc:
                    self._log(f"erro no orientation batch imgsz={bundle.img_size}: {exc}")

            for idx, (state, _frame) in enumerate(detector_requests):
                det_result = det_results[idx] if idx < len(det_results) else None
                vehicles, frauds = detect_context_objects_from_result(
                    det_result,
                    state.plate_guard_vehicle_conf,
                    state.plate_guard_fraud_conf,
                    state.fraud_classes,
                )
                state.guard_cache['vehicles'] = vehicles
                state.guard_cache['frauds'] = frauds
                state.guard_cache['frame_idx'] = state.frame_idx

                if orientation_due.get(state.channel_id):
                    orientation_boxes = []
                    orientation_timings = []
                    if orientation_model is not None:
                        orientation_boxes = build_orientation_boxes_from_vehicle_boxes(
                            _frame,
                            vehicles,
                            orientation_model,
                            timing_sink=orientation_timings,
                        )
                    state.orientation_cache['vehicles'] = orientation_boxes
                    state.orientation_cache['frame_idx'] = state.frame_idx
                    if orientation_timings:
                        total_ms = sum(float(item.get("elapsed_ms", 0.0) or 0.0) for item in orientation_timings)
                        self._log(
                            f"orientation channel={state.channel_id} frame={state.frame_idx} "
                            f"source=vehicle_cache calls={len(orientation_timings)} total_ms={total_ms:.1f}"
                        )

        for idx, (state, frame) in enumerate(items):
            result = plate_results[idx] if idx < len(plate_results) else None
            self._process_single_channel_frame(state, frame, result, bundle)

    def _process_ready_frames(self):
        now_ts = time.time()
        grouped = defaultdict(list)

        with self.channels_lock:
            states = list(self.channels.values())

        for state in states:
            if now_ts < state.next_process_ts:
                continue

            seq, frame = state.capture.get_latest_after(state.last_seq_processed)
            if frame is None:
                continue

            state.last_seq_processed = seq
            state.next_process_ts = now_ts + state.min_interval()
            state.frame_idx += 1

            key = self._bundle_key(state)
            grouped[key].append((state, frame))

        for key, items in grouped.items():
            bundle = self.bundles.get(key)
            if bundle is None:
                if not items:
                    continue
                bundle = self._get_bundle(items[0][0])
            self._process_bundle_batch(bundle, items)

    def _stdin_reader_loop(self):
        while not self.stop_event.is_set():
            line = sys.stdin.readline()
            if line == '':
                # EOF -> servidor encerrou stdin
                self.stop_event.set()
                return
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
                self.cmd_queue.put(cmd)
            except Exception as exc:
                self._log(f"comando invalido: {exc}")

    def _handle_command(self, cmd):
        action = str((cmd or {}).get('action') or '').strip().lower()

        if action == 'add_channel':
            cfg = (cmd or {}).get('config') or {}
            self.add_channel(cfg)
            return

        if action == 'remove_channel':
            channel_id = str((cmd or {}).get('channelId') or '').strip()
            if channel_id:
                self.remove_channel(channel_id, emit_stop=True)
            return

        if action == 'shutdown':
            self.stop_event.set()
            return

        if action == 'preload_bundle':
            self.preload_bundle(
                (cmd or {}).get('imgSize'),
                (cmd or {}).get('device'),
                with_detector=(cmd or {}).get('withDetector', False),
            )
            return

    def run(self):
        try:
            self._connect_socket()
        except Exception:
            return 1

        stdin_thread = threading.Thread(target=self._stdin_reader_loop, daemon=True)
        stdin_thread.start()

        try:
            while not self.stop_event.is_set():
                while True:
                    try:
                        cmd = self.cmd_queue.get_nowait()
                    except queue.Empty:
                        break
                    self._handle_command(cmd)

                self._process_ready_frames()
                time.sleep(0.002)
        except KeyboardInterrupt:
            pass
        except Exception as exc:
            self._log(f"erro fatal no loop principal: {exc}")
            traceback.print_exc(file=sys.stderr)
        finally:
            with self.channels_lock:
                channel_ids = list(self.channels.keys())
            for channel_id in channel_ids:
                self.remove_channel(channel_id, emit_stop=True)

            try:
                if self.sio.connected:
                    self.sio.disconnect()
            except Exception:
                pass

        return 0


def main():
    parser = argparse.ArgumentParser(description='Worker compartilhado de leitura de placas (batch multi-canal).')
    parser.add_argument('--socket_token', required=False, default=None)
    args = parser.parse_args()

    worker = PlateBatchWorker(socket_token=args.socket_token)
    code = worker.run()
    sys.exit(int(code))


if __name__ == '__main__':
    main()
