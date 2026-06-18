#capture_photo.py 

import cv2
import sys
import argparse
import json

def main():
    try:
        parser = argparse.ArgumentParser(description='Processamento de leitura de placas veiculares.')
        parser.add_argument('--ip', required=True, help='Endereço IP da câmera')
        parser.add_argument('--user', required=True, help='Usuário da câmera')
        parser.add_argument('--password', required=True, help='Senha da câmera')
        parser.add_argument('--channel_id', required=True, help='ID do canal')
        parser.add_argument('--dvr_channel', required=True, help='Canal do DVR')
        args = parser.parse_args()
    
        camera_ip = args.ip
        username = args.user
        password = args.password
        channelId = args.channel_id
        dvr_channel = args.dvr_channel

        video_path = f'rtsp://{username}:{password}@{camera_ip}:554/cam/realmonitor?channel={dvr_channel}&subtype=0'
        # video_path = './videos/e1.avi'
        cap = cv2.VideoCapture(video_path)  # 0 for default camera; replace with RTSP URL if necessary

        if not cap.isOpened():
            print('Error: Could not open video stream')
            sys.exit(1)

        ret, frame = cap.read()
        if not ret:
            print('Error: Could not read frame')
            sys.exit(1)

        # Save the frame to a file in the 'public' directory
        cv2.imwrite(f'public/captured_frame_{channelId}.jpg', frame)

        cap.release()
        sys.exit(0)
    except Exception as e:
        print(f'Error: {e}')
        sys.exit(1)

if __name__ == '__main__':
    main()