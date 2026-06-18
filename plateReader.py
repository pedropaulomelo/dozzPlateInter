#!/usr/bin/env python3
import cv2
import base64
import time
import string
import os
import sys
import json
import socketio
import argparse
import traceback
import numpy as np
import psutil
import GPUtil
from datetime import datetime
os.environ.setdefault("MPLCONFIGDIR", "/tmp/dozz-matplotlib")
os.environ.setdefault("XDG_CACHE_HOME", "/tmp/dozz-cache")
from ultralytics import YOLO
from shapely.geometry import Polygon, box
import warnings

warnings.filterwarnings("default")

SERVER_URL = "http://localhost:4000"

dict_char_to_int = {'O': '0', 'I': '1', 'Z': '2', 'J': '3', 'A': '4', 'S': '5', 'G': '6', 'B': '8'}
dict_int_to_char = {'0': 'O', '1': 'I', '2': 'Z', '3': 'J', '4': 'A', '5': 'S', '6': 'G', '8': 'B'}

# Mapeia plate_text -> { 'bbox': {...}, 'last_update': t }
tracked_plates = {}
plate_direction_state = {}
orientation_cache = {
    'vehicles': [],
    'frame_idx': -1,
}
door_command_feedback = {
    'plate': None,
    'accepted': None,
    'timestamp': 0.0,
    'message': None,
}
plate_banner_feedback = {
    'plate': None,
    'direction': None,
    'timestamp': 0.0,
}
fraud_alert_feedback = {
    'reason': None,
    'timestamp': 0.0,
}

DIRECTION_CACHE_TTL_SEC = 2.0
TRACKED_PLATE_TIMEOUT_SEC = 2.0
DIR_MIN_MOVEMENT_PX = 2.5
DIR_MIN_ALIGNMENT_COS = 0.12
DIR_MIN_PROJECTED_PX = 0.9
DIR_CONFIRM_FRAMES = 1
DIR_HISTORY_MAX_POINTS = 8
DIR_HISTORY_MAX_AGE_SEC = 1.2
DIR_MIN_HISTORY_SPAN_SEC = 0.05
DIR_EVENT_COOLDOWN_SEC = 0.45
OCR_MIN_CONF = 0.16
MOTION_DEFAULT_MODE = "aproximando"
MOTION_DEFAULT_SENSITIVITY = 60
MOTION_HISTORY_MAX_POINTS = 12
MOTION_HISTORY_MAX_AGE_SEC = 2.0
MOTION_EVENT_COOLDOWN_SEC = 0.45
MOTION_MIN_DELTA_HARD = 5.0
MOTION_MIN_DELTA_EASY = 0.8
MOTION_RATIO_HARD = 0.82
MOTION_RATIO_EASY = 0.52
DOOR_FEEDBACK_TTL_SEC = 4.0
PLATE_BANNER_TTL_SEC = 4.0
FRAUD_ALERT_TTL_SEC = 4.0
PERF_REPORT_INTERVAL_SEC = 5.0
PLATE_STREAM_MAX_SIDE = max(320, int(os.getenv("PLATE_STREAM_MAX_SIDE", "640")))
SOCKET_PREVIEW_ENABLED = os.getenv("SOCKET_PREVIEW_ENABLED", "true").strip().lower() in ("1", "true", "yes", "on")
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
ORIENTATION_TFLITE_THREADS = read_env_int("ORIENTATION_TFLITE_THREADS", min(12, os.cpu_count() or 1), min_value=1)
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


def expected_orientation_for_mode(mode):
    normalized = str(mode or MOTION_DEFAULT_MODE).strip().lower()
    return "back" if normalized == "afastando" else "front"


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


def letterbox_image(frame, new_shape):
    shape = frame.shape[:2]
    if isinstance(new_shape, int):
        new_shape = (new_shape, new_shape)

    ratio = min(new_shape[0] / shape[0], new_shape[1] / shape[1])
    new_unpad = (int(round(shape[1] * ratio)), int(round(shape[0] * ratio)))
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
    return bordered, ratio, dw, dh


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
        indices = cv2.dnn.NMSBoxes(
            boxes_xywh.tolist(),
            scores.astype(float).tolist(),
            float(conf_threshold),
            float(iou_threshold),
        )
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


PLATE_GUARD_ENABLED = os.getenv("PLATE_GUARD_ENABLED", "true").strip().lower() in ("1", "true", "yes", "on")
PLATE_GUARD_DET_EVERY_N = read_env_int("PLATE_GUARD_DET_EVERY_N", 2, min_value=1)
PLATE_GUARD_VEHICLE_CONF = read_env_float("PLATE_GUARD_VEHICLE_CONF", 0.22)
PLATE_GUARD_FRAUD_CONF = read_env_float("PLATE_GUARD_FRAUD_CONF", 0.22)
PLATE_GUARD_MIN_PLATE_OVERLAP = read_env_float("PLATE_GUARD_MIN_PLATE_OVERLAP", 0.55)
PLATE_GUARD_EXPAND_FACTOR = read_env_float("PLATE_GUARD_EXPAND_FACTOR", 1.8)
VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle", "bicycle", "train"}
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
        if results and results[0] is not None and results[0].boxes is not None:
            names = results[0].names
            for detection_box in results[0].boxes:
                cls_id = int(detection_box.cls[0])
                cls_name = str(names.get(cls_id, ORIENTATION_CLASS_NAMES.get(cls_id, cls_id))).lower()
                orientation = normalize_orientation_label(cls_name)
                parsed_vehicle_cls = normalize_orientation_vehicle_class(cls_name)
                conf = float(detection_box.conf[0])
                if orientation is None or parsed_vehicle_cls not in VEHICLE_CLASSES or conf < ORIENTATION_MODEL_CONF:
                    continue
                x1o, y1o, x2o, y2o = map(float, detection_box.xyxy[0])
                detections.append({
                    "xmin": x1o,
                    "ymin": y1o,
                    "xmax": x2o,
                    "ymax": y2o,
                    "cls": cls_name,
                    "vehicle_cls": parsed_vehicle_cls,
                    "orientation": orientation,
                    "conf": conf,
                })
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
    competing_score = max(value for key, value in scores.items() if key != expected_orientation)

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


def load_yolo_with_fallback(base_path, model_name, preferred_path, img_size, device):
    if not preferred_path:
        raise RuntimeError(f"Modelo {model_name} ausente.")

    tried = set()
    current_path = preferred_path
    warmup_size = max(320, min(int(img_size), 640))
    warmup_frame = np.zeros((warmup_size, warmup_size, 3), dtype=np.uint8)

    while current_path and current_path not in tried:
        tried.add(current_path)
        try:
            model = YOLO(current_path, task='detect')
            if current_path.endswith('.pt'):
                try:
                    model.to(device)
                except Exception as move_error:
                    print(
                        f"[plateReader] Aviso: falha ao mover {model_name} para {device}: {move_error}. "
                        "Usando CPU.",
                        file=sys.stderr
                    )
                    model.to('cpu')

            # Força inicialização do backend aqui para capturar erro de metadata cedo.
            model.predict(warmup_frame, imgsz=img_size, verbose=False)
            return model, current_path
        except Exception as model_error:
            if current_path.endswith('.engine'):
                fallback_pt = resolve_pt_model_path(base_path, model_name, img_size)
                if fallback_pt and fallback_pt not in tried:
                    print(
                        f"[plateReader] Falha ao inicializar {model_name} em TensorRT ({current_path}): "
                        f"{model_error}. Fallback para {fallback_pt}.",
                        file=sys.stderr
                    )
                    current_path = fallback_pt
                    continue
            raise RuntimeError(
                f"Falha ao carregar modelo {model_name} ({current_path}): {model_error}"
            ) from model_error

    raise RuntimeError(f"Falha ao carregar modelo {model_name}.")

def custom_warning(message, category, filename, lineno, file=None, line=None):
    sys.stderr.write(warnings.formatwarning(message, category, filename, lineno))
warnings.showwarning = custom_warning

def license_complies_format(text, plate_class):
    if plate_class == 'new':  # Mercosul LLL NLNN
        if len(text) != 7: return False
        mapping = [
            dict_int_to_char, dict_int_to_char, dict_int_to_char,
            dict_char_to_int, dict_int_to_char, dict_char_to_int, dict_char_to_int
        ]
        for i in range(7):
            if i in [0,1,2,4]:
                valid_chars = string.ascii_uppercase + ''.join(mapping[i].keys())
            else:
                valid_chars = '0123456789' + ''.join(mapping[i].keys())
            if text[i] not in valid_chars:
                return False
        return True
    elif plate_class == 'old':  # Antigo LLL NNNN
        if len(text) != 7: return False
        mapping = [
            dict_int_to_char, dict_int_to_char, dict_int_to_char,
            dict_char_to_int, dict_char_to_int, dict_char_to_int, dict_char_to_int
        ]
        for i in range(7):
            if i in [0,1,2]:
                valid_chars = string.ascii_uppercase + ''.join(mapping[i].keys())
            else:
                valid_chars = '0123456789' + ''.join(mapping[i].keys())
            if text[i] not in valid_chars:
                return False
        return True
    else:
        return False

def format_license(text, plate_class):
    if plate_class == 'new':
        mapping = [
            dict_int_to_char, dict_int_to_char, dict_int_to_char,
            dict_char_to_int, dict_int_to_char, dict_char_to_int, dict_char_to_int
        ]
    elif plate_class == 'old':
        mapping = [
            dict_int_to_char, dict_int_to_char, dict_int_to_char,
            dict_char_to_int, dict_char_to_int, dict_char_to_int, dict_char_to_int
        ]
    else:
        return text

    license_plate_formatted = ''
    for i in range(7):
        char = text[i]
        if char in mapping[i]:
            license_plate_formatted += mapping[i][char]
        else:
            license_plate_formatted += char
    return license_plate_formatted

def remove_leading_zero(char):
    if char.startswith('0') and len(char) > 1:
        return char[1:]
    return char

def read_license_plate(license_plate_crop, plate_class, model, img_size):
    try:
        detections = model.predict(license_plate_crop, imgsz=img_size, verbose=False)
    except Exception:
        return None, None

    for detection in detections:
        boxes = detection.boxes
        class_ids = boxes.cls
        scores = boxes.conf
        xyxy = boxes.xyxy
        class_names = detection.names

        det_list = []
        for box, cls, score in zip(xyxy, class_ids, scores):
            x_min = box[0].item()
            char = class_names[int(cls)]
            conf = score.item()
            det_list.append((x_min, char, conf))

        if not det_list:
            return None, None

        det_list_sorted = sorted(det_list, key=lambda x: x[0])
        plate_number_full = ''.join([remove_leading_zero(ch) for _, ch, _ in det_list_sorted])
        average_conf = sum([c for _, _, c in det_list_sorted]) / len(det_list_sorted)

        text = plate_number_full.upper().replace(' ', '')
        if average_conf >= OCR_MIN_CONF and license_complies_format(text, plate_class):
            final_text = format_license(text, plate_class)
            return final_text, average_conf
    return None, None

def sanitize_filename(filename):
    valid_chars = "-_.() %s%s" % (string.ascii_letters, string.digits)
    return ''.join(c for c in filename if c in valid_chars)

def cleanup_stale_plate_tracking(now_ts):
    stale_plates = [
        plate_text for plate_text, state in tracked_plates.items()
        if now_ts - state.get('last_update', 0.0) > TRACKED_PLATE_TIMEOUT_SEC
    ]
    for plate_text in stale_plates:
        tracked_plates.pop(plate_text, None)
        plate_direction_state.pop(plate_text, None)

def measure_performance(sio, channel_id, stream_fps, img_size):
    cpu_percent = psutil.cpu_percent(interval=None)
    ram_usage = psutil.virtual_memory().percent

    gpus = GPUtil.getGPUs()
    if gpus:
        gpu = gpus[0]
        gpu_load = gpu.load*100
        gpu_memory_usage = gpu.memoryUtil*100
    else:
        gpu_load = 0.0
        gpu_memory_usage = 0.0

    performance_report = {
        "avg_fps": round(stream_fps, 2),
        "cpu_usage": cpu_percent,
        "ram_usage": ram_usage,
        "gpu_usage": round(gpu_load,1),
        "gpu_memory_usage": round(gpu_memory_usage,1),
        "imgsz": img_size,
    }

    sio.emit('performance-report', {
        "channelId": channel_id,
        "data": performance_report
    })

def check_line_crossing(detection, lastDetection, line):
    x1_now, y1_now, x2_now, y2_now = detection['xmin'], detection['ymin'], detection['xmax'], detection['ymax']
    x1_last, y1_last, x2_last, y2_last = lastDetection['xmin'], lastDetection['ymin'], lastDetection['xmax'], lastDetection['ymax']

    box_edges_now = get_box_edges(x1_now, y1_now, x2_now, y2_now)
    box_edges_last = get_box_edges(x1_last, y1_last, x2_last, y2_last)

    line_segment = {'x1': line['x1'], 'y1': line['y1'], 'x2': line['x2'], 'y2': line['y2']}

    crossed = False
    for edge_now in box_edges_now:
        for edge_last in box_edges_last:
            if line_segments_intersect(
                edge_last['x1'], edge_last['y1'], edge_now['x1'], edge_now['y1'],
                line_segment['x1'], line_segment['y1'], line_segment['x2'], line_segment['y2']
            ):
                crossed = True
                break
        if crossed:
            break

    return crossed

def get_box_edges(xmin, ymin, xmax, ymax):
    return [
        {'x1': xmin, 'y1': ymin, 'x2': xmax, 'y2': ymin},  # Top
        {'x1': xmax, 'y1': ymin, 'x2': xmax, 'y2': ymax},  # Right
        {'x1': xmax, 'y1': ymax, 'x2': xmin, 'y2': ymax},  # Bottom
        {'x1': xmin, 'y1': ymax, 'x2': xmin, 'y2': ymin},  # Left
    ]

def line_segments_intersect(x1,y1, x2,y2, x3,y3, x4,y4):
    def ccw(Ax,Ay,Bx,By,Cx,Cy):
        return (Cy - Ay)*(Bx - Ax) > (By - Ay)*(Cx - Ax)
    return (ccw(x1,y1,x3,y3,x4,y4) != ccw(x2,y2,x3,y3,x4,y4)) and \
           (ccw(x1,y1,x2,y2,x3,y3) != ccw(x1,y1,x2,y2,x4,y4))

def determine_direction(
    last_bbox,
    current_bbox,
    area_or_line,
    movement_override=None,
    dist_threshold=DIR_MIN_MOVEMENT_PX,
    angle_threshold_cos=DIR_MIN_ALIGNMENT_COS
):
    """
    Retorna:
       True  -> se movimento é na mesma direção da seta
       False -> se movimento é na direção oposta à seta
       None  -> se não foi possível determinar (pouco movimento, ou ângulo indefinido)
    
    Parâmetros extras:
      dist_threshold: valor em pixels para considerar movimento significativo
      angle_threshold_cos: limite do cosseno para definir direção estável
    """

    if not area_or_line.get('directions'):
        return None, None, None, None, None
    
    # Para simplificar, pegamos só a primeira seta configurada
    direction = area_or_line['directions'][0]
    dx_line = direction['x2'] - direction['x1']
    dy_line = direction['y2'] - direction['y1']

    if movement_override is None:
        # Centro do bbox anterior
        lx = (last_bbox['xmin'] + last_bbox['xmax'])/2.0
        ly = (last_bbox['ymin'] + last_bbox['ymax'])/2.0
        # Centro do bbox atual
        cx = (current_bbox['xmin'] + current_bbox['xmax'])/2.0
        cy = (current_bbox['ymin'] + current_bbox['ymax'])/2.0
        # Vetor de movimento
        movement = np.array([cx - lx, cy - ly], dtype=float)
    else:
        movement = np.array(movement_override, dtype=float)
    # Vetor da linha (seta)
    vec_line = np.array([dx_line, dy_line], dtype=float)

    # Norma dos vetores
    nm = np.linalg.norm(movement)
    nl = np.linalg.norm(vec_line)

    # Se um dos vetores é praticamente zero, não faz sentido computar direção
    if nm < dist_threshold or nl < 1e-6:  
        return None, None, None, None, None  # pouco deslocamento ou linha "degenerada"

    # Normalizar (só se forem não-nulos)
    movement_norm = movement / nm
    line_norm = vec_line / nl

    # Produto escalar entre vetor do movimento e vetor da linha
    dotp = np.dot(movement_norm, line_norm)
    projected_along_line_px = float(np.dot(movement, line_norm))

    # Vetor de movimento escalado por 5
    movement_vector_scaled = movement * 15

    # Verificar se está acima de angle_threshold_cos (ou abaixo de -angle_threshold_cos)
    # Exemplo: se dotp > 0.8 => ângulo < ~36°
    #          se dotp < -0.8 => ângulo > ~144° (movimento praticamente oposto)
    if dotp >= angle_threshold_cos:
        return True, nm, dotp, movement_vector_scaled, projected_along_line_px   # mesma direção
    elif dotp <= -angle_threshold_cos:
        return False, nm, dotp, movement_vector_scaled, projected_along_line_px  # direção oposta
    else:
        return None, nm, dotp, movement_vector_scaled, projected_along_line_px   # ângulo muito inclinado => não consideramos "true" nem "false"

def normalize_motion_mode(raw_mode):
    mode = str(raw_mode or MOTION_DEFAULT_MODE).strip().lower()
    return "afastando" if mode == "afastando" else "aproximando"

def clamp_motion_sensitivity(raw_sensitivity):
    try:
        value = float(raw_sensitivity)
    except (TypeError, ValueError):
        value = float(MOTION_DEFAULT_SENSITIVITY)
    return float(max(1.0, min(100.0, value)))

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

def process_plate_detection(
    plate_bbox,
    plate_text,
    sio,
    channel_id,
    triggered_areas_lines,
    vector_sense_enabled,
    motion_mode,
    motion_sensitivity,
    orientation_match=None,
):
    now_ts = time.time()
    last_bbox_data = tracked_plates.get(plate_text)
    if last_bbox_data and (now_ts - last_bbox_data.get('last_update', 0.0) <= TRACKED_PLATE_TIMEOUT_SEC):
        orientation_history = list(last_bbox_data.get('orientation_history', []))
        motion_event_ts = float(last_bbox_data.get('motion_event_ts', 0.0))
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

    tracked_plates[plate_text] = {
        'bbox': plate_bbox,
        'last_update': now_ts,
        'orientation_history': orientation_history,
        'motion_event_ts': motion_event_ts,
    }

    if now_ts - float(motion_event_ts) < MOTION_EVENT_COOLDOWN_SEC:
        return

    if not parse_bool(vector_sense_enabled, True):
        tracked_plates[plate_text]['motion_event_ts'] = now_ts
        plate_direction_state[plate_text] = {
            'direction': True,
            'timestamp': now_ts
        }
        sio.emit('plate-found', {
            "channelId": channel_id,
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
            "timestamp": datetime.now().isoformat()
        })
        return

    normalized_mode = normalize_motion_mode(motion_mode)
    clamped_sensitivity = clamp_motion_sensitivity(motion_sensitivity)
    expected_orientation = expected_orientation_for_mode(normalized_mode)
    matched, stats = evaluate_plate_orientation(orientation_history, expected_orientation)
    if not matched:
        return

    tracked_plates[plate_text]['motion_event_ts'] = now_ts
    plate_direction_state[plate_text] = {
        'direction': True,
        'timestamp': now_ts
    }
    sio.emit('plate-found', {
        "channelId": channel_id,
        "plate": plate_text,
        "direction": True,
        "vectorSenseEnabled": True,
        "motionMode": normalized_mode,
        "sensitivity": clamped_sensitivity,
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
        "timestamp": datetime.now().isoformat()
    })
    return

###########################
# Script principal
###########################

def get_plate_direction_hint(plate_text):
    state = plate_direction_state.get(plate_text)
    if not state:
        return None
    if time.time() - state['timestamp'] > DIRECTION_CACHE_TTL_SEC:
        return None
    return state.get('direction')

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


def update_plate_banner_feedback(plate_text):
    plate_banner_feedback['plate'] = plate_text
    plate_banner_feedback['direction'] = get_plate_direction_hint(plate_text)
    plate_banner_feedback['timestamp'] = time.time()

def update_fraud_alert_feedback(reason):
    fraud_alert_feedback['reason'] = guard_reason_to_label(reason)
    fraud_alert_feedback['timestamp'] = time.time()

def get_ui_scale(frame):
    h, w = frame.shape[:2]
    base = float(max(h, w))
    return max(1.15, min(3.2, base / 760.0))

def draw_plate_top_banner(frame):
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
        cv2.LINE_AA
    )

def draw_door_feedback(frame):
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

def draw_fraud_alert(frame):
    reason = fraud_alert_feedback.get('reason')
    if not reason:
        return
    dt = time.time() - fraud_alert_feedback.get('timestamp', 0.0)
    if dt > FRAUD_ALERT_TTL_SEC:
        return

    line1 = "DETECCAO DE FRAUDE"
    color = (0, 0, 255)

    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = get_ui_scale(frame)
    fs1 = 1.0 * scale
    th1 = max(2, int(round(2.6 * scale)))

    (w1, h1), b1 = cv2.getTextSize(line1, font, fs1, th1)
    pad = max(12, int(round(12 * scale)))

    box_w = w1 + pad * 2
    box_h = h1 + b1 + pad * 2

    x1 = max(10, int(round(18 * scale)))
    y1 = max(10, int(round(18 * scale)))
    x2 = min(frame.shape[1] - 1, x1 + box_w)
    y2 = min(frame.shape[0] - 1, y1 + box_h)

    overlay = frame.copy()
    cv2.rectangle(overlay, (x1, y1), (x2, y2), (10, 10, 10), -1)
    cv2.addWeighted(overlay, 0.56, frame, 0.44, 0, frame)
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, max(2, int(round(2 * scale))))

    t1_y = y1 + pad + h1
    cv2.putText(frame, line1, (x1 + pad, t1_y), font, fs1, color, th1, cv2.LINE_AA)

def draw_areas_and_lines(frame, areas, triggered_areas_lines):
    # Remover triggers antigos (mais de 1s, por ex)
    current_time = time.time()
    removal_list = []
    for line_id, trig_data in triggered_areas_lines['lines'].items():
        dt = current_time - trig_data['timestamp']
        if dt>1.0:  # passou 1s, remover o trigger
            removal_list.append(line_id)

    for rid in removal_list:
        del triggered_areas_lines['lines'][rid]

    for area in areas:
        if area['type']=='line':
            line_id = area['_id']
            # Aumentar espessura
            base_thickness = 10  
            base_color = (255, 0, 0)  # azul por padrao

            # Se estiver no triggered_areas_lines, pode ficar vermelho se direction=True
            if line_id in triggered_areas_lines['lines']:
                direction_bool = triggered_areas_lines['lines'][line_id]['direction']
                if direction_bool is True:
                    color = (0,0,255)  # vermelho
                    thickness = int(base_thickness * 1.25) 
                else:
                    # se direction=False, mantemos a cor base
                    color = base_color
                    thickness = base_thickness
            else:
                color = base_color
                thickness = base_thickness

            cv2.line(frame, (int(area['x1']),int(area['y1'])),
                     (int(area['x2']),int(area['y2'])),
                     color, thickness)

            # Desenhar direcao
            directions = area.get('directions', [])
            for d in directions:
                # Se direction=True e triggered => seta vermelha
                # Se direction=False => seta permanece amarela
                if line_id in triggered_areas_lines['lines']:
                    dir_bool = triggered_areas_lines['lines'][line_id]['direction']
                    if dir_bool is True:
                        arrow_color = (0,0,255)  # vermelho
                    else:
                        arrow_color = (0,255,255) # amarelo
                else:
                    arrow_color = (0,255,255)  # amarelo padrao

                cv2.arrowedLine(frame,
                    (int(d['x1']), int(d['y1'])),
                    (int(d['x2']), int(d['y2'])),
                    arrow_color, thickness)
        elif area['type']=='area':
            # se quiser uma area mais espessa
            base_thickness=5
            pts = np.array([[pt['x'], pt['y']] for pt in area['points']], np.int32)
            pts = pts.reshape((-1,1,2))
            cv2.polylines(frame, [pts], True, (0,255,0), base_thickness)


def main():
    parser = argparse.ArgumentParser(description='Processamento de leitura de placas (PlateReader) com Socket.IO.')
    parser.add_argument('--ip', required=True)
    parser.add_argument('--user', required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--frame_rate', type=int, default=3)
    parser.add_argument('--device', type=str, default='cpu')
    parser.add_argument('--channel_id', required=True)
    parser.add_argument('--dvr_channel', required=True, help='Canal do DVR')
    parser.add_argument('--actions', required=False)
    parser.add_argument('--areas', required=False)
    parser.add_argument('--imgsz', type=int, default=640)
    parser.add_argument('--socket_token', required=False, default=None)
    parser.add_argument('--vector_sense_enabled', required=False, default='true')
    parser.add_argument('--motion_mode', required=False, default=MOTION_DEFAULT_MODE)
    parser.add_argument('--motion_sensitivity', required=False, type=float, default=MOTION_DEFAULT_SENSITIVITY)
    parser.add_argument('--plate_guard_enabled', required=False, default=None)
    parser.add_argument('--plate_guard_det_every_n', required=False, type=int, default=None)
    parser.add_argument('--plate_guard_vehicle_conf', required=False, type=float, default=None)
    parser.add_argument('--plate_guard_fraud_conf', required=False, type=float, default=None)
    parser.add_argument('--plate_guard_min_plate_overlap', required=False, type=float, default=None)
    parser.add_argument('--plate_guard_expand_factor', required=False, type=float, default=None)
    parser.add_argument('--plate_guard_fraud_classes', required=False, default=None)
    parser.add_argument('--stream_preview_side', required=False, type=int, default=None)
    parser.add_argument('--stream_jpeg_quality', required=False, type=int, default=None)
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

    if getattr(sys, 'frozen', False):
        base_path = sys._MEIPASS
    else:
        base_path = os.path.abspath(".")

    device = 'cuda' if args.device.startswith('gpu') else 'cpu'
    img_size = max(320, int(args.imgsz))

    plate_model_path = resolve_model_path(base_path, 'plate', img_size)
    ocr_model_path = resolve_model_path(base_path, 'ocr', img_size)
    orientation_model_path = resolve_model_path(base_path, 'orientation', img_size)
    detector_model_path = resolve_model_path(base_path, 'detector', img_size)
    if not plate_model_path or not ocr_model_path or not orientation_model_path or not detector_model_path:
        print(
            "[plateReader] ERRO: modelo ausente "
            f"(plate={plate_model_path}, ocr={ocr_model_path}, orientation={orientation_model_path}, detector={detector_model_path}, imgsz={img_size})",
            file=sys.stderr
        )
        sys.exit(1)

    plate_model, loaded_plate_path = load_yolo_with_fallback(
        base_path, 'plate', plate_model_path, img_size, device
    )
    ocr_model, loaded_ocr_path = load_yolo_with_fallback(
        base_path, 'ocr', ocr_model_path, img_size, device
    )
    if str(orientation_model_path).lower().endswith('.tflite'):
        orientation_model = OrientationTFLiteModel(orientation_model_path)
        loaded_orientation_path = orientation_model_path
    else:
        orientation_model, loaded_orientation_path = load_yolo_with_fallback(
            base_path, 'orientation', orientation_model_path, img_size, device
        )
    detector_model, loaded_detector_path = load_yolo_with_fallback(
        base_path, 'detector', detector_model_path, img_size, device
    )

    print(f"[plateReader] Modelo plate: {loaded_plate_path}")
    print(f"[plateReader] Modelo ocr: {loaded_ocr_path}")
    print(f"[plateReader] Modelo orientation: {loaded_orientation_path}")
    if str(loaded_orientation_path).lower().endswith('.tflite'):
        print(f"[plateReader] orientation_tflite_threads={ORIENTATION_TFLITE_THREADS}")
    if loaded_detector_path:
        print(f"[plateReader] Modelo detector: {loaded_detector_path}")

    actions, areas = [], []
    if args.actions:
        import base64
        try:
            actions_json = base64.b64decode(args.actions).decode('utf-8')
            actions = json.loads(actions_json)
        except:
            pass
    if args.areas:
        try:
            areas_json = base64.b64decode(args.areas).decode('utf-8')
            areas = json.loads(areas_json)
        except:
            pass

    motion_mode = normalize_motion_mode(args.motion_mode)
    motion_sensitivity = clamp_motion_sensitivity(args.motion_sensitivity)
    vector_sense_enabled = parse_bool(args.vector_sense_enabled, True)

    video_path = f'rtsp://{args.user}:{args.password}@{args.ip}:554/cam/realmonitor?channel={args.dvr_channel}&subtype=0'
    # video_path = './videos/e1.avi'
    cap = cv2.VideoCapture(video_path)

    sio = socketio.Client()

    @sio.event
    def connect():
        # print("Conectado ao servidor Socket.IO")
        sio.emit('join', args.channel_id)

    @sio.event
    def connect_error(data):
        print(f"[plateReader] connect_error: {data}", file=sys.stderr)

    @sio.event
    def disconnect():
        a = 0
        # print("Desconectado do servidor Socket.IO")

    @sio.on('door-command-result')
    def on_door_command_result(data):
        if not data:
            return
        if data.get("channelId") != args.channel_id:
            return

        door_command_feedback['plate'] = data.get('plate')
        door_command_feedback['accepted'] = bool(data.get('accepted'))
        door_command_feedback['message'] = data.get('message')
        door_command_feedback['timestamp'] = time.time()

    token = args.socket_token or os.getenv("INTERNAL_SOCKET_TOKEN", "")
    connect_kwargs = {
        "socketio_path": "socket.io",
        "transports": ["polling", "websocket"],
        "wait_timeout": 10,
    }
    if token:
        connect_kwargs["auth"] = {"token": token}
    else:
        print(
            "[plateReader] Aviso: socket token ausente. Se o servidor exigir token interno, a conexão falhará.",
            file=sys.stderr
        )

    try:
        sio.connect(SERVER_URL, **connect_kwargs)
    except Exception as e:
        print(f"[plateReader] Erro ao conectar no servidor Socket.IO: {e}", file=sys.stderr)
        sys.exit(1)

    if not cap.isOpened():
        print(f"[plateReader] Erro ao abrir stream RTSP: {video_path}", file=sys.stderr)
        sio.emit('process-error', {"channelId": args.channel_id, "errorType":"open_video_error"})
        sio.disconnect()
        sys.exit(1)
    else:
        sio.emit('process-started', {"channelId": args.channel_id})

    fps = cap.get(cv2.CAP_PROP_FPS)
    target_fps = max(1, int(args.frame_rate))
    skip_frames = int(max(1, round(fps / target_fps))) if fps > 0 else 1
    default_preview_side = int(max(320, min(img_size, PLATE_STREAM_MAX_SIDE)))
    stream_preview_side = default_preview_side
    if args.stream_preview_side is not None:
        stream_preview_side = int(max(320, min(1920, int(args.stream_preview_side))))
    stream_jpeg_quality = 15
    if args.stream_jpeg_quality is not None:
        stream_jpeg_quality = int(max(10, min(100, int(args.stream_jpeg_quality))))
    print(
        f"[plateReader] stream_fps_camera={fps:.2f} target_fps={target_fps} "
        f"skip_frames={skip_frames} preview_side={stream_preview_side} "
        f"preview_jpeg_q={stream_jpeg_quality} infer_imgsz={img_size}"
    )
    print(f"[plateReader] socket_preview_enabled={SOCKET_PREVIEW_ENABLED}")
    print(
        f"[plateReader] plate_guard_enabled={PLATE_GUARD_ENABLED} "
        f"det_every_n={PLATE_GUARD_DET_EVERY_N} "
        f"vehicle_conf={PLATE_GUARD_VEHICLE_CONF:.2f} "
        f"fraud_conf={PLATE_GUARD_FRAUD_CONF:.2f}"
    )
    print(f"[plateReader] vector_sense_enabled={vector_sense_enabled}")
    print(f"[plateReader] orientation_vehicle_cache_enabled={ORIENTATION_VEHICLE_CACHE_ENABLED}")

    # triggered_areas_lines agora guardará dict para cada line_id -> {timestamp, direction}
    triggered_areas_lines = {
        'areas': {},
        'lines': {}
    }

    frame_count=0
    last_perf_measurement_time=time.time()
    perf_frames_sent = 0
    perf_processed_frames = 0
    guard_cache = {
        "vehicles": [],
        "frauds": [],
        "frame_idx": -1,
    }
    orientation_cache["vehicles"] = []
    orientation_cache["frame_idx"] = -1
    last_guard_reject_log_ts = 0.0

    base_plates_dir=os.path.join(base_path, 'plates')
    os.makedirs(base_plates_dir, exist_ok=True)

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break

            # Controlar FPS
            if frame_count%skip_frames !=0:
                frame_count+=1
                continue

            cleanup_stale_plate_tracking(time.time())

            results = plate_model.predict(frame, imgsz=img_size, device=device, verbose=False)
            result_boxes = (
                results[0].boxes
                if results and results[0] is not None and results[0].boxes is not None
                else []
            )
            has_plate_candidates = len(result_boxes) > 0

            scene_vehicle_boxes = []
            scene_fraud_boxes = []
            must_refresh_orientation = (
                vector_sense_enabled
                and
                ORIENTATION_VEHICLE_CACHE_ENABLED
                and has_plate_candidates
                and (
                    orientation_cache["frame_idx"] < 0
                    or (frame_count % ORIENTATION_CACHE_REFRESH_EVERY_N == 0)
                )
            )
            must_refresh_guard = (
                PLATE_GUARD_ENABLED
                and
                has_plate_candidates
                and (
                    guard_cache["frame_idx"] < 0
                    or (frame_count % PLATE_GUARD_DET_EVERY_N == 0)
                )
            )
            if must_refresh_orientation or must_refresh_guard:
                vehicles, frauds = detect_context_objects(frame, detector_model, img_size)
                guard_cache["vehicles"] = vehicles
                guard_cache["frauds"] = frauds
                guard_cache["frame_idx"] = frame_count

                if must_refresh_orientation:
                    orientation_timings = []
                    orientation_cache["vehicles"] = build_orientation_boxes_from_vehicle_boxes(
                        frame,
                        vehicles,
                        orientation_model,
                        timing_sink=orientation_timings,
                    )
                    orientation_cache["frame_idx"] = frame_count
                    if orientation_timings:
                        total_ms = sum(float(item.get("elapsed_ms", 0.0) or 0.0) for item in orientation_timings)
                        print(
                            f"[plateReader] orientation channel={args.channel_id} frame={frame_count} "
                            f"source=vehicle_cache calls={len(orientation_timings)} total_ms={total_ms:.1f}"
                        )
            elif not ORIENTATION_VEHICLE_CACHE_ENABLED:
                orientation_cache["vehicles"] = []
                orientation_cache["frame_idx"] = frame_count

            if vector_sense_enabled:
                draw_orientation_boxes(frame, orientation_cache["vehicles"], motion_mode)

            if PLATE_GUARD_ENABLED and len(result_boxes) > 0:
                scene_vehicle_boxes = guard_cache["vehicles"]
                scene_fraud_boxes = guard_cache["frauds"]

            plate_detected=False
            plate_bbox=None
            detected_plate_text=None
            matched_orientation=None
            for box in result_boxes:
                x1,y1,x2,y2=map(int, box.xyxy[0])
                if x2 <= x1 or y2 <= y1:
                    continue
                plate_class_index=int(box.cls[0])
                if plate_class_index==0:
                    plate_class='new'
                elif plate_class_index==1:
                    plate_class='old'
                else:
                    plate_class='unknown'

                plate_bbox_candidate = {
                    'xmin': x1,
                    'ymin': y1,
                    'xmax': x2,
                    'ymax': y2
                }
                color=(0,255,255)
                thick=max(2, frame.shape[0]//180)
                orientation_match = None
                if vector_sense_enabled:
                    orientation_match = match_plate_to_orientation_box(
                        plate_bbox_candidate,
                        orientation_cache["vehicles"],
                    )

                if PLATE_GUARD_ENABLED:
                    guard_ok, guard_reason = evaluate_plate_guard(
                        plate_bbox_candidate,
                        scene_vehicle_boxes,
                        scene_fraud_boxes,
                    )
                    if not guard_ok:
                        color = (0, 0, 255)
                        update_fraud_alert_feedback(guard_reason)
                        now_ts = time.time()
                        if now_ts - last_guard_reject_log_ts >= 1.2:
                            print(
                                f"[plateReader] Bloqueado por guard antifraude: "
                                f"channel={args.channel_id} reason={guard_reason}",
                                file=sys.stderr
                            )
                            last_guard_reject_log_ts = now_ts
                        cv2.rectangle(frame,(x1,y1),(x2,y2), color, thick)
                        continue

                crop=frame[y1:y2, x1:x2]
                plate_text, conf=read_license_plate(crop, plate_class, ocr_model, img_size)
                if plate_text and conf >= OCR_MIN_CONF:
                    plate_detected=True
                    detected_plate_text=plate_text
                    plate_bbox=plate_bbox_candidate
                    if vector_sense_enabled and orientation_match is None:
                        orientation_timing = {}
                        orientation_match = classify_orientation_from_bbox(
                            frame,
                            plate_bbox_candidate,
                            orientation_model,
                            expand_factor=ORIENTATION_PLATE_FALLBACK_EXPAND_FACTOR,
                            infer_size=ORIENTATION_INFER_SIZE,
                            vehicle_cls='plate_proxy',
                            source='plate',
                            prefer_heuristic=True,
                            timing_info=orientation_timing,
                        )
                        if orientation_timing.get("used_model"):
                            elapsed_ms = float(orientation_timing.get("elapsed_ms", 0.0) or 0.0)
                            engine = orientation_timing.get("engine", "unknown")
                            print(
                                f"[plateReader] orientation channel={args.channel_id} frame={frame_count} "
                                f"source=plate_fallback engine={engine} ms={elapsed_ms:.1f}"
                            )
                    matched_orientation=orientation_match
                    ts=datetime.now().strftime('%Y%m%d_%H%M%S%f')[:-3]
                    fname=f"{sanitize_filename(plate_text)}_{ts}.jpg"
                    cv2.imwrite(os.path.join(base_plates_dir,fname), crop)
                    direction_hint = get_plate_direction_hint(plate_text)
                    color, _direction_label = choose_bbox_style(direction_hint)

                cv2.rectangle(frame,(x1,y1),(x2,y2), color, thick)

            if plate_detected and detected_plate_text:
                process_plate_detection(
                    plate_bbox,
                    detected_plate_text,
                    sio,
                    args.channel_id,
                    triggered_areas_lines,
                    vector_sense_enabled,
                    motion_mode,
                    motion_sensitivity,
                    matched_orientation,
                )
                update_plate_banner_feedback(detected_plate_text)
                if vector_sense_enabled and matched_orientation and matched_orientation.get("source") == "plate":
                    draw_orientation_boxes(frame, [matched_orientation], motion_mode)

            # Desenhar áreas e linhas (espessas e revertendo cor após 1s)
            draw_areas_and_lines(frame, areas, triggered_areas_lines)
            draw_plate_top_banner(frame)
            perf_processed_frames += 1

            if SOCKET_PREVIEW_ENABLED:
                # Converter frame e enviar
                h, w = frame.shape[:2]
                preview_side = int(max(1, min(stream_preview_side, max(h, w))))
                if w >= h:
                    target_w = preview_side
                    target_h = max(1, int((h * target_w) / w))
                else:
                    target_h = preview_side
                    target_w = max(1, int((w * target_h) / h))
                frame_resized = cv2.resize(frame, (target_w, target_h))

                success, encoded = cv2.imencode(
                    '.jpg',
                    frame_resized,
                    [int(cv2.IMWRITE_JPEG_QUALITY), int(stream_jpeg_quality)]
                )
                frame_size_kb = len(encoded.tobytes()) / 1024

                if success:
                    sio.emit('frame', {
                        "channelId": args.channel_id,
                        "image": encoded.tobytes(),
                        "size": frame_size_kb
                    })
                    perf_frames_sent += 1

            now = time.time()
            elapsed_perf = now - last_perf_measurement_time
            if elapsed_perf >= PERF_REPORT_INTERVAL_SEC:
                stream_fps = perf_processed_frames / elapsed_perf if elapsed_perf > 0 else 0.0
                measure_performance(sio, args.channel_id, stream_fps, img_size)
                last_perf_measurement_time = now
                perf_frames_sent = 0
                perf_processed_frames = 0

            frame_count+=1
    except KeyboardInterrupt:
        print(f"[plateReader] Interrompido por sinal no canal {args.channel_id}", file=sys.stderr)
    finally:
        cap.release()
        try:
            sio.emit('process-stopped', {"channelId": args.channel_id})
        except Exception:
            pass
        try:
            sio.disconnect()
        except Exception:
            pass

if __name__=='__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("[plateReader] Encerrado por KeyboardInterrupt", file=sys.stderr)
        sys.exit(0)
    except Exception as e:
        print(f"[plateReader] Erro fatal: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
