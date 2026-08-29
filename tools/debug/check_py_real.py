import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR
import urllib.request
import sys

# Download a real scene text image
url = "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/release/2.7/doc/imgs/11.jpg"
urllib.request.urlretrieve(url, "scripts/test_text.jpg")
img = cv2.imread("scripts/test_text.jpg")
print(f"Image shape: {img.shape}, dtype: {img.dtype}", flush=True)

engine = RapidOCR()
result, elapse = engine(img)
print(f"\nRapidOCR result: {result}", flush=True)
print(f"Elapse: {elapse}", flush=True)

if result:
    print(f"Boxes: {len(result)}", flush=True)
    for i, (box, text, score) in enumerate(result[:5]):
        print(f"  [{i}] '{text}' score={score:.3f} box={box.tolist()}", flush=True)
else:
    print("No boxes detected", flush=True)