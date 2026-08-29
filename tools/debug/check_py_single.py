import cv2
import numpy as np
import onnxruntime as ort
from rapidocr_onnxruntime import RapidOCR
import os

img = cv2.imread('scripts/test_text.jpg')
engine = RapidOCR()

# Manually crop box[0] with the SAME function the engine uses
points = np.float32([[28.0, 37.0], [304.0, 37.0], [304.0, 73.0], [28.0, 73.0]])
def get_rotate_crop_image(img, points):
    img_crop_width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
    img_crop_height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
    pts_std = np.float32([[0, 0], [img_crop_width, 0], [img_crop_width, img_crop_height], [0, img_crop_height]])
    M = cv2.getPerspectiveTransform(points, pts_std)
    dst_img = cv2.warpPerspective(img, M, (img_crop_width, img_crop_height), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
    return dst_img

crop = get_rotate_crop_image(img, points)
print(f'crop: {crop.shape}', flush=True)

# Use engine's rec module directly on a single crop (batch=1, no max_wh_ratio from batch)
# Monkey-patch to print input shape + argmax
original_run = ort.InferenceSession.run
def debug_run(self, output_names, input_feed):
    res = original_run(self, output_names, input_feed)
    if len(res) > 0 and len(res[0].shape) == 3 and res[0].shape[2] == 6625:
        for k, v in input_feed.items():
            print(f'  input {k}: shape={v.shape}', flush=True)
        probs = res[0]
        for b in range(probs.shape[0]):
            seq = probs[b]
            argmax = [int(seq[t].argmax()) for t in range(seq.shape[0])]
            non_blank = [i for i in argmax if i != 0]
            print(f'  REC batch[{b}] seq_len={seq.shape[0]} non-blank: {non_blank}', flush=True)
    return res
ort.InferenceSession.run = debug_run

# Call engine's rec with 1 crop (no det)
rec_res = engine.rec([crop])
print(f'rec single: {rec_res}', flush=True)

# Now call with the crop repeated (simulating batch effect)
rec_res2 = engine.rec([crop, crop])
print(f'rec twice: {rec_res2}', flush=True)