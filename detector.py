#!/usr/bin/env python3

import sys
import argparse
import json
import cv2
import time
from ultralytics import YOLO
import numpy as np
import base64
import warnings
from shapely.geometry import box, Polygon
import socketio

# Redirecionar avisos para stderr
def custom_warning(message, category, filename, lineno, file=None, line=None):
    sys.stderr.write(warnings.formatwarning(message, category, filename, lineno))
warnings.showwarning = custom_warning

# Dicionário global para rastrear objetos
tracked_objects = {}

def is_within_action_time(action):
    current_time = time.localtime()
    current_minutes = current_time.tm_hour * 60 + current_time.tm_min

    start_hours, start_minutes = map(int, action['startTime'].split(':'))
    end_hours, end_minutes = map(int, action['endTime'].split(':'))

    start_total_minutes = start_hours * 60 + start_minutes
    end_total_minutes = end_hours * 60 + end_minutes

    if end_total_minutes <= start_total_minutes:
        end_total_minutes += 24 * 60

    adjusted_current_minutes = current_minutes
    if adjusted_current_minutes < start_total_minutes:
        adjusted_current_minutes += 24 * 60

    return start_total_minutes <= adjusted_current_minutes <= end_total_minutes

def check_if_inside_area(detection, area):
    bbox = box(detection['xmin'], detection['ymin'], detection['xmax'], detection['ymax'])
    area_polygon = Polygon([(pt['x'], pt['y']) for pt in area['points']])
    return bbox.intersects(area_polygon)

def process_detection(detection, areas, actions, triggered_areas_lines):
    objectID = detection['objectID']

    if objectID not in tracked_objects:
        # Inicializar o objeto rastreado
        tracked_objects[objectID] = {
            'lastDetection': detection,
            'areas_inside': set(),
            'lines_crossed': set(),  # Rastrear linhas cruzadas por este objeto
        }
        lastDetection = None
    else:
        lastDetection = tracked_objects[objectID]['lastDetection']

    detection_inside_any_area = False

    if lastDetection is not None:
        # Agora podemos processar usando detection e lastDetection
        for action in actions:
            if detection['label'] in action['categories']:
                if is_within_action_time(action):
                    for area in areas:
                        if area['actionId'] == action['_id']:
                            if area['type'] == 'area':
                                if check_if_inside_area(detection, area):
                                    detection_inside_any_area = True

                                    if area['_id'] not in tracked_objects[objectID]['areas_inside']:
                                        tracked_objects[objectID]['areas_inside'].add(area['_id'])
                                        # Evento de entrada
                                        trigger_event(detection, action, area, 'enter')

                                    # Evento contínuo de dentro
                                    trigger_event(detection, action, area, 'inside')

                                    # Adicionar área ao conjunto de áreas acionadas
                                    triggered_areas_lines['areas'].add(area['_id'])
                                else:
                                    if area['_id'] in tracked_objects[objectID]['areas_inside']:
                                        tracked_objects[objectID]['areas_inside'].remove(area['_id'])
                                        # Evento de saída
                                        trigger_event(detection, action, area, 'exit')
                            elif area['type'] == 'line':
                                crossed = check_line_crossing(detection, lastDetection, area)
                                if crossed and area['_id'] not in tracked_objects[objectID]['lines_crossed']:
                                    # Determinar direção
                                    direction_result = determine_direction(detection, lastDetection, area)
                                    trigger_event(detection, action, area, 'line_cross', direction_result)
                                    tracked_objects[objectID]['lines_crossed'].add(area['_id'])

                                    # Adicionar linha ao conjunto de linhas acionadas
                                    triggered_areas_lines['lines'].add(area['_id'])
                                else:
                                    # Verificar se o objeto não está mais intersectando a linha para resetar o status
                                    if not crossed and area['_id'] in tracked_objects[objectID]['lines_crossed']:
                                        tracked_objects[objectID]['lines_crossed'].remove(area['_id'])
    else:
        # Se não houver lastDetection (primeira detecção), podemos optar por não processar
        pass

    # Após o processamento, atualizar lastDetection
    tracked_objects[objectID]['lastDetection'] = detection

    return detection_inside_any_area

def check_line_crossing(detection, lastDetection, line):
    # Obter as coordenadas da caixa delimitadora atual e anterior
    x1_now, y1_now, x2_now, y2_now = detection['xmin'], detection['ymin'], detection['xmax'], detection['ymax']
    x1_last, y1_last, x2_last, y2_last = lastDetection['xmin'], lastDetection['ymin'], lastDetection['xmax'], lastDetection['ymax']

    # Obter as arestas da caixa delimitadora atual e anterior
    box_edges_now = get_box_edges(x1_now, y1_now, x2_now, y2_now)
    box_edges_last = get_box_edges(x1_last, y1_last, x2_last, y2_last)

    # Definir a linha como um segmento
    line_segment = {'x1': line['x1'], 'y1': line['y1'], 'x2': line['x2'], 'y2': line['y2']}

    # Verificar se qualquer aresta da caixa cruzou a linha
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
        {'x1': xmin, 'y1': ymin, 'x2': xmax, 'y2': ymin},  # Topo
        {'x1': xmax, 'y1': ymin, 'x2': xmax, 'y2': ymax},  # Direita
        {'x1': xmax, 'y1': ymax, 'x2': xmin, 'y2': ymax},  # Base
        {'x1': xmin, 'y1': ymax, 'x2': xmin, 'y2': ymin},  # Esquerda
    ]

def line_segments_intersect(x1, y1, x2, y2, x3, y3, x4, y4):
    def ccw(Ax, Ay, Bx, By, Cx, Cy):
        return (Cy - Ay) * (Bx - Ax) > (By - Ay) * (Cx - Ax)
    return (ccw(x1, y1, x3, y3, x4, y4) != ccw(x2, y2, x3, y3, x4, y4)) and (ccw(x1, y1, x2, y2, x3, y3) != ccw(x1, y1, x2, y2, x4, y4))

def determine_direction(detection, lastDetection, area_or_line):
    # Calcular o vetor de movimento
    movement_vector = {
        'x': detection['x'] - lastDetection['x'],
        'y': detection['y'] - lastDetection['y']
    }

    # Obter o vetor de direção definido
    if 'directions' in area_or_line and area_or_line['directions']:
        # Usar a primeira direção para simplicidade
        direction = area_or_line['directions'][0]
        direction_vector = {
            'x': direction['x2'] - direction['x1'],
            'y': direction['y2'] - direction['y1']
        }
    else:
        # Se nenhuma direção definida, considerar como direta
        return True

    # Normalizar os vetores
    movement_norm = np.array([movement_vector['x'], movement_vector['y']])
    direction_norm = np.array([direction_vector['x'], direction_vector['y']])

    if np.linalg.norm(movement_norm) == 0 or np.linalg.norm(direction_norm) == 0:
        return False

    movement_norm = movement_norm / np.linalg.norm(movement_norm)
    direction_norm = direction_norm / np.linalg.norm(direction_norm)

    # Calcular o produto escalar
    dot_product = np.dot(movement_norm, direction_norm)

    # Se o produto escalar for positivo, movimento está na mesma direção
    if dot_product >= 0:
        return True  # Direta
    else:
        return False  # Inversa

def trigger_event(detection, action, area, event_type, direction_result=None):
    event = {
        'type': 'event',
        'data': {
            'objectID': detection['objectID'],
            'label': detection['label'],
            'actionId': action['_id'],
            'areaId': area['_id'],
            'eventType': event_type,
            'timestamp': time.time(),
            'direction': direction_result  # Pode ser True (direta), False (inversa) ou None
        }
    }
    print(json.dumps(event))
    sys.stdout.flush()

def draw_areas_and_lines(frame, areas, triggered_areas_lines):
    for area in areas:
        if area['type'] == 'line':
            if area['_id'] in triggered_areas_lines['lines']:
                color = (0, 0, 255)  # Vermelho se a linha foi acionada
                thickness = 3
            else:
                color = (255, 0, 0)  # Azul para linhas não acionadas
                thickness = 2
            cv2.line(frame, (int(area['x1']), int(area['y1'])), (int(area['x2']), int(area['y2'])), color, thickness)
            # Desenhar as direções associadas
            for direction in area.get('directions', []):
                cv2.arrowedLine(frame, (int(direction['x1']), int(direction['y1'])), (int(direction['x2']), int(direction['y2'])), (0, 255, 255), 2)
        elif area['type'] == 'area':
            pts = np.array([[pt['x'], pt['y']] for pt in area['points']], np.int32)
            pts = pts.reshape((-1, 1, 2))
            if area['_id'] in triggered_areas_lines['areas']:
                color = (0, 0, 255)  # Vermelho se a área foi acionada
                thickness = 3
            else:
                color = (0, 255, 0)  # Verde para áreas não acionadas
                thickness = 2
            cv2.polylines(frame, [pts], isClosed=True, color=color, thickness=thickness)
            # Desenhar as direções associadas (se houver)
            for direction in area.get('directions', []):
                cv2.arrowedLine(frame, (int(direction['x1']), int(direction['y1'])), (int(direction['x2']), int(direction['y2'])), (0, 255, 255), 2)

def main():
    try:
        parser = argparse.ArgumentParser(description='Processamento de detecção de veículos.')
        parser.add_argument('--ip', required=True, help='Endereço IP da câmera')
        parser.add_argument('--user', required=True, help='Usuário da câmera')
        parser.add_argument('--password', required=True, help='Senha da câmera')
        parser.add_argument('--frame_rate', required=True, help='FPS')
        parser.add_argument('--dvr_channel', required=True, help='Canal do DVR')
        parser.add_argument('--channel_id', required=True, help='ID do Canal')
        parser.add_argument('--actions', required=True, help='Dados das ações em base64')
        parser.add_argument('--areas', required=True, help='Dados das áreas em base64')
        args = parser.parse_args()

        # Extrair configurações
        camera_ip = args.ip
        username = args.user
        password = args.password
        fps = float(args.frame_rate)
        dvr_channel = args.dvr_channel
        channel_id = args.channel_id

        # Obter ações e áreas a partir dos argumentos
        actions_base64 = args.actions
        areas_base64 = args.areas

        actions_json = base64.b64decode(actions_base64).decode('utf-8')
        areas_json = base64.b64decode(areas_base64).decode('utf-8')

        actions = json.loads(actions_json)
        areas = json.loads(areas_json)

        # Mapear direções às áreas correspondentes
        for area in areas:
            area['directions'] = area.get('directions', [])

        video_path = f'rtsp://{username}:{password}@{camera_ip}:554/cam/realmonitor?channel={dvr_channel}&subtype=0'
        cap = cv2.VideoCapture(video_path)
        # cap = cv2.VideoCapture('./test.mp4')  # Use um vídeo local para testes, se necessário

        if not cap.isOpened():
            raise Exception("Não foi possível abrir o stream de vídeo")

        # Inicializar o modelo YOLO
        model = YOLO('./models/detector.pt')

        # Obter dimensões do vídeo
        ret, frame = cap.read()
        if not ret:
            raise Exception("Não foi possível ler o frame inicial")
        height_original, width_original = frame.shape[:2]

        # Enviar dimensões do vídeo ao servidor
        print(json.dumps({
            "type": "video_dimensions",
            "data": {
                "width": width_original,
                "height": height_original
            }
        }))
        sys.stdout.flush()

        # Configurar Socket.IO
        sio = socketio.Client()
        sio.connect('http://localhost:3000')

        @sio.event
        def connect():
            print("Conectado ao servidor")
            sio.emit('join', channel_id)

        @sio.event
        def disconnect():
            print("Desconectado do servidor")

        # Processamento de frames
        prev_time = 0
        while cap.isOpened():
            frame_start_time = time.time()
            ret, frame = cap.read()
            if not ret:
                break

            # Controlar FPS
            current_time = time.time()
            if (current_time - prev_time) < 1.0 / fps:
                continue
            prev_time = current_time

            # Dicionário para áreas e linhas acionadas neste frame
            triggered_areas_lines = {'areas': set(), 'lines': set()}

            # Processar frame com YOLO e rastreamento
            # results = model.track(frame, persist=True, verbose=False)
            results = model.track(frame, persist=True, verbose=False, imgsz=480)

            monitored_labels = ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'dog', 'cat', 'horse']  # Adicione categorias conforme necessário

            # Extrair detecções
            for result in results:
                for box in result.boxes:
                    if box.id is not None:
                        x1, y1, x2, y2 = map(int, box.xyxy[0])
                        cls = int(box.cls[0])
                        label = model.names[cls]
                        if label in monitored_labels:
                            objectID = int(box.id[0])
                            detection = {
                                'objectID': objectID,
                                'x': (x1 + x2) // 2,
                                'y': (y1 + y2) // 2,
                                'xmin': x1,
                                'ymin': y1,
                                'xmax': x2,
                                'ymax': y2,
                                'label': label,
                            }

                            # Processar detecção
                            detection_inside_any_area = process_detection(detection, areas, actions, triggered_areas_lines)

                            # Desenhar a caixa delimitadora
                            if detection_inside_any_area:
                                color = (0, 0, 255)  # Vermelho se estiver dentro de alguma área
                            else:
                                color = (0, 255, 0)  # Verde se estiver fora das áreas

                            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                            cv2.putText(frame, f"{label} ID:{objectID}", (x1, y1 - 10),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

            # Desenhar áreas e linhas na imagem
            draw_areas_and_lines(frame, areas, triggered_areas_lines)

            # Redimensionar frame para enviar
            frame_resized = cv2.resize(frame, (640, 480))

            # Codificar frame como JPEG
            _, buffer = cv2.imencode('.jpg', frame_resized, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            jpg_as_text = base64.b64encode(buffer).decode('utf-8')

            # Emitir o frame para o servidor
            sio.emit('frame', {'image': jpg_as_text, 'channelId': channel_id})

            # Verificar se a tecla 'q' foi pressionada para sair
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

        cap.release()
        sio.disconnect()
        cv2.destroyAllWindows()

    except Exception as e:
        error_message = json.dumps({'type': 'error', 'data': str(e)})
        print(error_message)
        sys.stdout.flush()

if __name__ == '__main__':
    main()