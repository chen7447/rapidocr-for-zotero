pdfocr-prefs-header = RapidOCR for Zotero 设置
pdfocr-prefs-section-precision = 检测精度
pdfocr-prefs-res-label = 检测分辨率
pdfocr-prefs-res-512 = 512（快）
pdfocr-prefs-res-1536 = 1536（推荐）
pdfocr-prefs-res-1920 = 1920（大版面/扫描件）
pdfocr-prefs-res-hint = 数字越大越清晰，小字（如脚注、斜体）越容易识别，但 OCR 会变慢。超过 1536 仅对 A3/大版面有明显提升。
pdfocr-prefs-thresh-label = 检测灵敏度
pdfocr-prefs-thresh-hint = 数值越低越容易检出微弱、模糊的文字（也可能多出一些多余框）。默认 0.3。
pdfocr-prefs-box-label = 文本框过滤
pdfocr-prefs-box-hint = 数值越低保留越多检测框（包括得分低的），数值越高框越少但更干净。默认 0.4。
pdfocr-prefs-rot-label = 倾斜文字过滤
pdfocr-prefs-rot-hint = 长轴与水平夹角超过此角度的文本框（斜水印/旋转文字/印章）将被忽略、不写入文本层。0=只保留水平，90=不过滤。默认 30。
pdfocr-prefs-crop-label = 识别模式
pdfocr-prefs-crop-0 = 直立正文（AABB 直接裁剪）
pdfocr-prefs-crop-1 = 倾斜正文（旋转矫正）
pdfocr-prefs-crop-2 = 复合方法（推荐）
pdfocr-prefs-crop-hint = 直立正文 = 锋利直接裁剪，适合无倾斜页面；倾斜正文 = 恒旋转矫正，适合倾斜扫描页；复合方法 = 近轴对齐走直接裁剪、真倾斜才拉正（兼顾两者）。
pdfocr-prefs-workers-label = 并行核心数
pdfocr-prefs-workers-hint = 开多少个并行 OCR worker（每个占一个核心，多页时并行加速）。核心越多越快但更吃内存和整机资源，小文档建议 4。默认 4。
pdfocr-prefs-section-autoopen = 完成后自动打开新附件
pdfocr-prefs-autoopen-label = 自动打开 [OCR] 附件
pdfocr-prefs-autoopen-hint = OCR 完成后自动在阅读器中打开生成的 -ocr.pdf 附件。
pdfocr-prefs-reset = 恢复默认设置
pdfocr-prefs-reset-hint = 将上述所有选项恢复为默认值（1536 / 0.3 / 0.4 / 30 / 复合方法 / 并行核心数 4 / 关闭自动打开）。
pdfocr-prefs-section-version = 版本信息
pdfocr-prefs-version-label = 插件版本：
pdfocr-prefs-engine-line = OCR 引擎：RapidOCR（PP-OCRv4, onnxruntime-web WASM）
