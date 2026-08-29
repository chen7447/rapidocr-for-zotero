import cv2
import numpy as np
import onnxruntime as ort
from rapidocr_onnxruntime import RapidOCR

# Monkey-patch the rec session's run to print argmax
original_run = ort.InferenceSession.run

def debug_run(self, output_names, input_feed):
    res = original_run(self, output_names, input_feed)
    if len(res) > 0 and len(res[0].shape) == 3 and res[0].shape[2] == 6625:
        probs = res[0]
        for b in range(probs.shape[0]):
            seq = probs[b]
            argmax = [int(seq[t].argmax()) for t in range(seq.shape[0])]
            non_blank = [i for i in argmax if i != 0]
            print(f'  REC batch[{b}] non-blank: {non_blank}', flush=True)
    return res

ort.InferenceSession.run = debug_run

img = cv2.imread('scripts/test_text.jpg')
engine = RapidOCR()
result, _ = engine(img)
with open('scripts/python_engine_text.txt', 'w', encoding='utf-8') as f:
    for i, (box, text, score) in enumerate(result[:6]):
        f.write(f"[{i}] '{text}' score={score:.3f}\n")
print(f'result[1][0] box: {result[0][0]}', flush=True)