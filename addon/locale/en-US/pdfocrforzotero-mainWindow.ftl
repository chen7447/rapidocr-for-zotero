pdfocr-prefs-header = RapidOCR for Zotero Settings
pdfocr-prefs-section-precision = Detection quality
pdfocr-prefs-res-label = Detection resolution
pdfocr-prefs-res-512 = 512 (fast)
pdfocr-prefs-res-1536 = 1536 (recommended)
pdfocr-prefs-res-1920 = 1920 (large/scanned pages)
pdfocr-prefs-res-hint = Higher values resolve small text (footnotes, italics) better but slow OCR down. Above 1536 only A3/large layouts benefit noticeably.
pdfocr-prefs-thresh-label = Detection sensitivity
pdfocr-prefs-thresh-hint = Lower values detect faint, blurry text more easily (possibly adding extra boxes). Default 0.3.
pdfocr-prefs-box-label = Box filter
pdfocr-prefs-box-hint = Lower values keep more detection boxes (including low-score ones); higher values mean fewer, cleaner boxes. Default 0.4.
pdfocr-prefs-rot-label = Tilt filter
pdfocr-prefs-rot-hint = Text boxes whose long axis is tilted more than this angle (diagonal watermarks, rotated text, stamps) are ignored. 0 = horizontal only, 90 = no filtering. Default 30.
pdfocr-prefs-crop-label = Crop mode
pdfocr-prefs-crop-0 = Upright text (direct AABB crop)
pdfocr-prefs-crop-1 = Tilted text (rectified)
pdfocr-prefs-crop-2 = Hybrid (recommended)
pdfocr-prefs-crop-hint = Upright = sharp direct crop for straight pages; Tilted = always rectify, for skewed scans; Hybrid = direct crop for near-axis text, rectify only when truly tilted (best of both).
pdfocr-prefs-workers-label = Parallel workers
pdfocr-prefs-workers-hint = How many parallel OCR workers to run (one core each, pages processed in parallel). More is faster but heavier on memory and CPU; 4 is a good start. Default 4.
pdfocr-prefs-section-autoopen = Auto-open after OCR
pdfocr-prefs-autoopen-label = Auto-open the [OCR] attachment
pdfocr-prefs-autoopen-hint = Automatically open the generated -ocr.pdf attachment in the reader after OCR completes.
pdfocr-prefs-reset = Restore defaults
pdfocr-prefs-reset-hint = Resets every option above to its default (1536 / 0.3 / 0.4 / 30 / hybrid / 4 workers / auto-open off).
pdfocr-prefs-section-version = Version
pdfocr-prefs-version-label = Plugin version:
pdfocr-prefs-engine-line = OCR engine: RapidOCR (PP-OCRv4, onnxruntime-web WASM)
