import numpy as np
from rapidocr_onnxruntime import RapidOCR
import sys

# Create the same synthetic image as the JS test
iw, ih = 400, 72
px = np.zeros((ih, iw, 3), dtype=np.uint8)
# Text-like: multiple small white blocks (characters) on dark background
chars = [
    [20, 45], [55, 78], [90, 122], [140, 157], [170, 202], [220, 247],
    [260, 282], [300, 322], [340, 362],
]
for y in range(ih):
    for x in range(iw):
        lit = False
        if 14 < y < 58:
            for cs, ce in chars:
                if cs < x < ce:
                    lit = True
                    break
        px[y, x] = [250, 250, 250] if lit else [20, 20, 20]

print(f"Image shape: {px.shape}, dtype: {px.dtype}", flush=True)
print(f"min={px.min()}, max={px.max()}", flush=True)

# Run RapidOCR
engine = RapidOCR()
result, elapse = engine(px)
print(f"\nRapidOCR result: {result}", flush=True)
print(f"Elapse: {elapse}", flush=True)

if result:
    print(f"Boxes: {len(result)}", flush=True)
    for i, (box, text, score) in enumerate(result[:5]):
        print(f"  [{i}] '{text}' score={score:.3f} box={box.tolist()}", flush=True)
else:
    print("No boxes detected", flush=True)