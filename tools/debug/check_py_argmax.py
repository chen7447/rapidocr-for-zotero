import cv2
import numpy as np
import onnxruntime as ort
import sys

img = cv2.imread("scripts/test_text.jpg")
points = np.float32([[28.0, 37.0], [304.0, 37.0], [304.0, 73.0], [28.0, 73.0]])

# get_rotate_crop_image
img_crop_width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
img_crop_height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
pts_std = np.float32([[0, 0], [img_crop_width, 0], [img_crop_width, img_crop_height], [0, img_crop_height]])
M = cv2.getPerspectiveTransform(points, pts_std)
crop = cv2.warpPerspective(img, M, (img_crop_width, img_crop_height), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)

# rec resize_norm_img
imgH, imgW = 48, 320
ratio = crop.shape[1] / float(crop.shape[0])
resized_w = int(np.ceil(imgH * ratio))
resized = cv2.resize(crop, (resized_w, imgH))
resized_f = resized.astype("float32")
resized_chw = resized_f.transpose((2, 0, 1))
resized_chw /= 255.0
resized_chw -= 0.5
resized_chw /= 0.5

# Run rec
sess = ort.InferenceSession("addon/content/models/ch_PP-OCRv4_rec_infer.onnx")
inp = np.expand_dims(resized_chw, axis=0).astype(np.float32)
out = sess.run(None, {sess.get_inputs()[0].name: inp})
probs = out[0]  # [1, seq_len, 6625]
print(f"Rec output shape: {probs.shape}", flush=True)

# Decode and print argmax sequence
meta = sess.get_modelmeta()
chars = meta.custom_metadata_map["character"].split("\n")
print(f"chars count: {len(chars)}", flush=True)

seq = probs[0]
argmax_seq = [int(seq[t].argmax()) for t in range(seq.shape[0])]
print(f"argmax seq ({len(argmax_seq)}): {argmax_seq}", flush=True)
print(f"non-blank: {[i for i in argmax_seq if i != 0]}", flush=True)

# Decode text
last = -1
text = ""
for t in range(seq.shape[0]):
    max_idx = int(seq[t].argmax())
    if max_idx != 0 and max_idx != last:
        text += chars[max_idx]
    last = max_idx
print(f"rec text: '{text}'", flush=True)

# Write to file to avoid terminal encoding issues
with open("scripts/python_rec_text.txt", "w", encoding="utf-8") as f:
    f.write(text)
print("Written to python_rec_text.txt", flush=True)