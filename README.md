# RapidOCR for Zotero

把扫描件 / 图片型 PDF 做成**可搜索、可选择、可复制、可翻译**的 PDF。

**开装即用。** 不装 Python，不装 Tesseract，不装 OCRmyPDF，不配环境变量。下载 `.xpi` → 拖进 Zotero → 右键 **OCR PDF**。模型和引擎都打在插件里。

当前版本：`1.6.0b6`（Beta）  
支持：Zotero **9.0 – 10.0.\***

---

## 为什么能开装即用

常见方案（OCRmyPDF + Tesseract）识别文献拉丁文很好，但本机要装一堆依赖，做不到「装上就能用」。

本插件在 Zotero 里直接跑 [RapidOCR](https://github.com/RapidAI/RapidOCR) / PP-OCRv4（onnxruntime-web WASM）：

- 不调用外部程序
- 不访问网络（识别在本地）
- 中英混排、数字、DOI 可复制为正常 ASCII（不是乱码私用区字符）

代价：公式、极小字、纯英文文献，效果通常不如调好的 OCRmyPDF。这是「开装即用」换来的。

---

## 安装

1. 打开 [Releases](https://github.com/chen7447/rapidocr-for-zotero/releases)，下载最新 `.xpi`，例如：

   ```text
   pdf-ocr-for-zotero-1.6.0b6.xpi
   ```

2. Zotero → **工具 → 插件**
3. 把 `.xpi` 拖进去，或齿轮 → **从文件安装插件**
4. 建议重启 Zotero

插件 ID：`pdfocrforzotero@example.com`

---

## 使用手册

### 做一次 OCR

1. 在文献库里选中带 PDF 的条目，或直接选中 PDF 附件  
2. 右键 → **OCR PDF**  
3. 等进度窗口跑完  
4. 同一条目下会出现 `[OCR]` 附件（文件名 `*-ocr.pdf`）  
5. 打开这个附件：可以选中文字、复制、翻译

独立附件（没有父条目）时，插件会问要不要先建一个同名父条目，再挂上 `[OCR]` 兄弟附件。

源 PDF **不会被覆盖**。

### 推荐设置（小字文献）

**编辑 → 设置 → PDF OCR**

| 选项 | 推荐 | 说明 |
|---|---|---|
| 检测分辨率 | **1536** | 越大越能抓住小字、斜体、脚注，越慢 |
| 检测灵敏度 | **0.3** | 越低越容易检出淡字，也可能多框 |
| 文本框过滤 | **0.4** | 越低保留越多框；太低公式页容易碎框叠字 |
| 完成后自动打开 | 按需 | 跑完自动打开 `[OCR]` 附件 |

正文漏字：先把分辨率调到 1536，过滤降到 0.4。  
公式页选中乱跳 / 一串 `8888`：过滤可略调高（0.5–0.6），但小字可能又漏。

「检测分辨率」是检测网络的长边上限，**不是**显示器分辨率。

### 已知限制

- 公式不是 PP-OCRv4 的强项：可能认不准，或分数线变成重复数字。插件会丢掉明显垃圾框，避免两层字叠在一起。
- 拖选一段时，文字层按「先上后下、同行从左到右」书写。若一行被切成多个框，选区可能在行尾断开。
- 中文识别模型对纯拉丁仍会混（例如 `h` / `b`）。DOI、页码、作者名一般可用。
- 一次处理一个 PDF，CPU 上 WASM 单线程，大文件要等。

---

## 从源码打包

```text
npm install
npm run build
```

产物：`build/pdf-ocr-for-zotero-<version>.xpi`

---

## 许可

MPL-2.0。OCR 模型来自 PaddleOCR / RapidOCR；CJK 字体为 Noto Sans SC（OFL）。
