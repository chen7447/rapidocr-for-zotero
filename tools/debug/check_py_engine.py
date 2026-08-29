import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

img = cv2.imread("scripts/test_text.jpg")
engine = RapidOCR()
result, _ = engine(img)

with open("scripts/python_engine_text.txt", "w", encoding="utf-8") as f:
    for i, (box, text, score) in enumerate(result[:6]):
        f.write(f"[{i}] '{text}' score={score:.3f} box={box}\n")
print("Wrote python_engine_text.txt", flush=True)