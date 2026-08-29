import cv2
import numpy as np
from rapidocr_onnxruntime.ch_ppocr_rec.text_recognize import TextRecognizer
import yaml

# Load config
import os
from rapidocr_onnxruntime import RapidOCR
config_path = os.path.join(os.path.dirname(RapidOCR.__module__), 'config.yaml')

# Actually let's find the config
import inspect
rapidocr_init = inspect.getfile(RapidOCR)
config_dir = os.path.dirname(rapidocr_init)
config_path = os.path.join(config_dir, 'config.yaml')
print(f"config: {config_path}", flush=True)

with open(config_path, 'r', encoding='utf-8') as f:
    config = yaml.safe_load(f)

# Create TextRecognizer
rec = TextRecognizer(config['Rec'])

# Load image and crop box[0]
img = cv2.imread("scripts/test_text.jpg")
points = np.float32([[28.0, 37.0], [304.0, 37.0], [304.0, 73.0], [28.0, 73.0]])

def get_rotate_crop_image(img, points):
    img_crop_width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
    img_crop_height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
    pts_std = np.float32([[0, 0], [img_crop_width, 0], [img_crop_width, img_crop_height], [0, img_crop_height]])
    M = cv2.getPerspectiveTransform(points, pts_std)
    dst_img = cv2.warpPerspective(img, M, (img_crop_width, img_crop_height), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
    return dst_img

crop = get_rotate_crop_image(img, points)
print(f"crop: {crop.shape}", flush=True)

# Run rec on single crop (batch=1)
result = rec([crop])
print(f"rec result: {result}", flush=True)

# Also try: what if we use the same preprocess as my JS?
# Simulate JS preprocess: RGBA -> RGB -> BGR
# Actually let's just check: does the rec module use get_rotate_crop_image internally?
# Let's look at the source
import inspect as i
print("\nrec.__call__ source:", flush=True)
print(i.getsource(rec.__call__)[:2000], flush=True)