"""Compare RapidOCR engine's rec argmax with manual single-box rec argmax."""
import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

img = cv2.imread("scripts/test_text.jpg")
engine = RapidOCR()
result, _ = engine(img)

# For first box, print engine's recognized text
box0 = result[0][0]
text0 = result[0][1]
score0 = result[0][2]
print(f"Engine box[0]: '{text0}' score={score0:.3f}", flush=True)
print(f"Engine box[0] box: {box0}", flush=True)

# Now manually run rec on the same box with the same preprocessing
# Use the engine's internal rec module
from rapidocr_onnxruntime.ch_ppocr_rec.text_recognize import TextRecognizer
import yaml, os

# Find config
rapidocr_dir = os.path.dirname(RapidOCR.__module__ if hasattr(RapidOCR, '__module__') else '')
config_path = os.path.join(os.path.dirname(inspect.getfile(RapidOCR)), 'config.yaml')
with open(config_path, 'r', encoding='utf-8') as f:
    config = yaml.safe_load(f)

# Patch model path to absolute
model_name = 'ch_PP-OCRv4_rec_infer.onnx'
model_dir = 'addon/content/models'
import sys
sys.path.insert(0, os.path.join(os.path.dirname(inspect.getfile(RapidOCR)), '..'))

# Use the rec module directly
from rapidocr_onnxruntime.utils.infer_engine import OrtInferSession
rec_config = config['Rec'].copy()
rec_config['model_path'] = os.path.abspath(f'addon/content/models/{model_name}')
rec_session = OrtInferSession(rec_config)

# Get character dict from metadata
chars = rec_session.session.get_modelmeta().custom_metadata_map['character'].split('\n')
print(f"chars: {len(chars)}", flush=True)

# Get the crop
points = np.float32(box0)
def get_rotate_crop_image(img, points):
    img_crop_width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
    img_crop_height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
    pts_std = np.float32([[0, 0], [img_crop_width, 0], [img_crop_width, img_crop_height], [0, img_crop_height]])
    M = cv2.getPerspectiveTransform(points, pts_std)
    dst_img = cv2.warpPerspective(img, M, (img_crop_width, img_crop_height), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
    return dst_img

crop = get_rotate_crop_image(img, points)
print(f"crop: {crop.shape}", flush=True)

# Manual rec preprocessing (same as engine's resize_norm_img)
imgH, imgW = 48, 320
h, w = crop.shape[:2]
ratio = w / float(h)
max_wh_ratio = max(imgW/imgH, ratio)  # single box: use its own ratio
img_width = int(imgH * max_wh_ratio)
resized_w = int(np.ceil(imgH * ratio))
if resized_w > img_width:
    resized_w = img_width
print(f"resized_w={resized_w}, img_width={img_width}", flush=True)

resized = cv2.resize(crop, (resized_w, imgH))
resized_f = resized.astype('float32')
resized_chw = resized_f.transpose((2, 0, 1)) / 255.0
resized_chw -= 0.5
resized_chw /= 0.5

# Pad
padding = np.zeros((3, imgH, img_width), dtype=np.float32)
padding[:, :, :resized_w] = resized_chw

# Run rec
inp = np.expand_dims(padding, axis=0).astype(np.float32)
out = rec_session.session.run(None, {rec_session.input_name: inp})
probs = out[0]
seq = probs[0]

# Argmax
argmax_seq = [int(seq[t].argmax()) for t in range(seq.shape[0])]
print(f"Manual argmax ({len(argmax_seq)}): {argmax_seq}", flush=True)
non_blank = [i for i in argmax_seq if i != 0]
print(f"Manual non-blank: {non_blank}", flush=True)

# Decode
last = -1
text = ""
for t in range(seq.shape[0]):
    max_idx = int(seq[t].argmax())
    if max_idx != 0 and max_idx != last:
        text += chars[max_idx]
    last = max_idx
print(f"Manual text: '{text}'", flush=True)

# Now compare with engine's internal argmax for the same box
# We need to access the engine's internal rec module
# Let's monkey-patch to see the argmax
original_run = engine.rec.session.session.run
def debug_run(output_names, input_feed):
    res = original_run(output_names, input_feed)
    # For the first output (rec), print argmax
    if len(res) > 0 and len(res[0].shape) == 3:
        probs = res[0]  # [batch, seq, 6625]
        for b in range(probs.shape[0]):
            seq = probs[b]
            argmax = [int(seq[t].argmax()) for t in range(seq.shape[0])]
            non_blank = [i for i in argmax if i != 0]
            print(f"  Engine batch[{b}] non-blank: {non_blank}", flush=True)
    return res

engine.rec.session.session.run = debug_run
print("\nEngine full run again:", flush=True)
result2, _ = engine(img)
print(f"Engine result[0]: '{result2[0][1]}'", flush=True)

# Restore
engine.rec.session.session.run = original_run