import cv2
import numpy as np
import onnxruntime as ort
import sys

# Load image
img = cv2.imread("scripts/test_text.jpg")
h, w = img.shape[:2]

# First box from RapidOCR
points = np.float32([[28.0, 37.0], [304.0, 37.0], [304.0, 73.0], [28.0, 73.0]])

# get_rotate_crop_image
img_crop_width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
img_crop_height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
pts_std = np.float32([[0, 0], [img_crop_width, 0], [img_crop_width, img_crop_height], [0, img_crop_height]])
M = cv2.getPerspectiveTransform(points, pts_std)
crop = cv2.warpPerspective(img, M, (img_crop_width, img_crop_height), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
print(f"Python crop: {crop.shape} dtype={crop.dtype} min={crop.min()} max={crop.max()}", flush=True)

# Python rec resize_norm_img
imgH, imgW = 48, 320
ratio = crop.shape[1] / float(crop.shape[0])
resized_w = int(np.ceil(imgH * ratio))
print(f"Python resized_w={resized_w}", flush=True)

resized = cv2.resize(crop, (resized_w, imgH))
print(f"Python resized: {resized.shape} dtype={resized.dtype}, first pixel BGR: {resized[0,0]}", flush=True)

# CHW normalize
resized_f = resized.astype("float32")
resized_chw = resized_f.transpose((2, 0, 1))  # CHW (BGR)
resized_chw /= 255.0
resized_chw -= 0.5
resized_chw /= 0.5

print(f"Python tensor: {resized_chw.shape}, min={resized_chw.min():.4f}, max={resized_chw.max():.4f}", flush=True)
print(f"Python ch0(B) first 3: {resized_chw[0,0,:3]}", flush=True)
print(f"Python ch1(G) first 3: {resized_chw[1,0,:3]}", flush=True)
print(f"Python ch2(R) first 3: {resized_chw[2,0,:3]}", flush=True)

# Save raw tensor
resized_chw.tofile("scripts/python_rec_tensor.raw")
print(f"Saved {4*resized_chw.size} bytes to python_rec_tensor.raw", flush=True)

# Run rec model
sess = ort.InferenceSession("addon/content/models/ch_PP-OCRv4_rec_infer.onnx")
inp = np.expand_dims(resized_chw, axis=0).astype(np.float32)
out = sess.run(None, {sess.get_inputs()[0].name: inp})
print(f"Python rec output: {out[0].shape}", flush=True)

# Decode
import yaml
# Load character dict from RapidOCR config
meta = sess.get_modelmeta()
chars = meta.custom_metadata_map["character"].split("\n")
print(f"Python chars: {len(chars)}", flush=True)

# CTC decode
probs = out[0]  # [1, seq_len, num_classes]
for batch in range(probs.shape[0]):
    seq = probs[batch]
    last = -1
    text = ""
    for t in range(seq.shape[0]):
        max_idx = seq[t].argmax()
        if max_idx != 0 and max_idx != last:
            text += chars[max_idx]
        last = max_idx
    print(f"Python rec text: '{text}'", flush=True)