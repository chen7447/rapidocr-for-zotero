import cv2
import numpy as np

img = cv2.imread("scripts/test_text.jpg")
points = np.float32([[28.0, 37.0], [304.0, 37.0], [304.0, 73.0], [28.0, 73.0]])

# get_rotate_crop_image (same as RapidOCR)
img_crop_width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
img_crop_height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
pts_std = np.float32([[0, 0], [img_crop_width, 0], [img_crop_width, img_crop_height], [0, img_crop_height]])
M = cv2.getPerspectiveTransform(points, pts_std)
crop = cv2.warpPerspective(img, M, (img_crop_width, img_crop_height), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)
print(f"crop shape: {crop.shape} dtype={crop.dtype}", flush=True)

# Save as RGBA (R,G,B from BGR)
h, w = crop.shape[:2]
rgba = np.zeros((h, w, 4), dtype=np.uint8)
rgba[:, :, 0] = crop[:, :, 2]  # R
rgba[:, :, 1] = crop[:, :, 1]  # G
rgba[:, :, 2] = crop[:, :, 0]  # B
rgba[:, :, 3] = 255
rgba.tofile("scripts/python_crop.rgba")
print(f"Saved python_crop.rgba {w}x{h}", flush=True)