import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

# Use the same image, but this time check the exact rec output
img = cv2.imread("scripts/test_text.jpg")
engine = RapidOCR()
result, elapse = engine(img)

# Compare box heights with Python
for i, (box, text, score) in enumerate(result[:5]):
    pts = np.array(box, dtype=np.float32)
    h = np.linalg.norm(pts[0] - pts[3])  # left side height
    w = np.linalg.norm(pts[0] - pts[1])  # top width
    print(f"[{i}] '{text}' score={score:.3f} h={h:.0f} w={w:.0f} box={box}", flush=True)

# Check the rec preprocessing: crop first box and check its size
from rapidocr_onnxruntime.ch_ppocr_rec.text_recognize import TextRecognizer
import yaml

with open(engine.config_path, 'r', encoding='utf-8') as f:
    config = yaml.safe_load(f)

rec = TextRecognizer(config['Rec'])
# First box
pts = np.array(result[0][0], dtype=np.float32)
# Get rotated crop
def get_rotate_crop_image(img, points):
    img_crop_width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
    img_crop_height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
    pts_std = np.float32([[0, 0], [img_crop_width, 0], [img_crop_width, img_crop_height], [0, img_crop_height]])
    M = cv2.getPerspectiveTransform(points, pts_std)
    dst_img = cv2.warpPerspective(img, M, (img_crop_width, img_crop_height), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
    return dst_img

crop = get_rotate_crop_image(img, pts)
print(f"\nCrop shape: {crop.shape}", flush=True)
print(f"Crop min={crop.min()}, max={crop.max()}", flush=True)

# Now run the rec on this crop
rec_res = rec([crop])
print(f"Rec result: {rec_res}", flush=True)