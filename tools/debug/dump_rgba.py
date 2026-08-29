import cv2
import numpy as np
import sys

img = cv2.imread("scripts/test_text.jpg")  # BGR
img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)  # RGB
h, w = img_rgb.shape[:2]
print(f"size {w}x{h}", flush=True)

# RGBA raw
rgba = np.zeros((h, w, 4), dtype=np.uint8)
rgba[:, :, :3] = img_rgb
rgba[:, :, 3] = 255

rgba.tofile("scripts/test_text.rgba")
print(f"wrote {rgba.nbytes} bytes", flush=True)