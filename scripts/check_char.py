import onnxruntime as ort
import sys

sess = ort.InferenceSession("addon/content/models/ch_PP-OCRv4_rec_infer.onnx")
meta = sess.get_modelmeta()
custom = meta.custom_metadata_map
print("keys:", list(custom.keys()), flush=True)

if "character" in custom:
    chars = custom["character"].splitlines()
    print(f"metadata character count: {len(chars)}", flush=True)
    print("first 5:", chars[:5], flush=True)
    print("last 5:", chars[-5:], flush=True)

# Read ppocr_keys_v1.txt
with open("addon/content/models/ppocr_keys_v1.txt", "r", encoding="utf-8") as f:
    file_chars = f.read().split("\n")
print(f"\nfile ppocr_keys_v1.txt count: {len(file_chars)}", flush=True)
print("file first 5:", file_chars[:5], flush=True)
print("file last 5:", file_chars[-5:], flush=True)

# Compare
if "character" in custom:
    meta_chars = custom["character"].split("\n")
    print(f"\nmetadata len={len(meta_chars)}, file len={len(file_chars)}", flush=True)
    diff = 0
    for i, (a, b) in enumerate(zip(meta_chars, file_chars)):
        if a != b:
            diff += 1
            if diff <= 10:
                print(f"  diff at {i}: meta={a!r} file={b!r}", flush=True)
    print(f"total diffs: {diff}", flush=True)