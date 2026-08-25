# PDF OCR For Zotero v3 — 进展与下一步路线

## 验证 1 结果（已确认）

| 测试项 | 结果 | 说明 |
|--------|------|------|
| `WebAssembly.instantiate` | ✅ **OK** | Zotero chrome 域能跑 wasm |
| `import("onnxruntime-web")` | ✅ **OK** | 542KB 包被 esbuild 正确打包 |
| `ort.InferenceSession.create` | ❌ **no available backend** | 详见下方 |

### 错误根因

```
ORT session error: Error: no available backend found. ERR: [wasm] Error: cannot determine the script source URL.
```

**原因**：onnxruntime-web 需要确定自身脚本的 URL 来推导 wasm 文件路径。它默认用 `new URL("ort-wasm-simd-threaded.jsep.wasm", import.meta.url)`。在 Zotero chrome 域（`loadSubScript` 加载）中，`import.meta.url` 不指向一个可用的文件 URL，所以它算不出 wasm 的路径。

---

## 下一步：修复 wasm 加载（关键）

### 修复方案

两步：
1. 把 wasm 二进制文件打进 XPI
2. 显式设置 `ort.env.wasm.wasmPaths` 告诉 ort 去哪里找 wasm

### 具体操作

#### 1. 复制 wasm 文件

从 `node_modules/onnxruntime-web/dist/` 复制以下文件到 `addon/content/scripts/`：

```
# 最小依赖（~13.5MB）
ort-wasm-simd-threaded.wasm     (13.4 MB)
ort-wasm-simd-threaded.mjs      (24 KB)
```

`ort-wasm-simd-threaded.wasm` 是纯 SIMD 版本（无 WebGPU JSEP、无 JSPI、单线程），适合 Firefox 140 + 非跨域隔离环境。

> 如果 13.4MB 可接受，先用这个。如果体积太大，后续可以压缩或考虑用更小的 wasm 变体（`ort-wasm-simd-threaded.asyncify.wasm` 是 24MB，更大；`ort-wasm-simd-threaded.jspi.wasm` 是 15MB，Firefox 不支持 JSPI 所以没用）。

#### 2. 修改 `src/hooks.ts` 的 `testOrtWasm()`

在 `ort.env.wasm.numThreads = 1` 之后加上：

```ts
if (ort.env?.wasm) {
  ort.env.wasm.numThreads = 1;
  // 告诉 ort wasm 文件在 XPI 里的 resource:// 路径
  ort.env.wasm.wasmPaths = addonRoot + "/content/scripts/";
}
```

`addonRoot` 是 esbuild define 注入的全局变量，值是 `"resource://pdfocrforzotero@example.com"`。

#### 3. 修改 `scripts/build.mjs`

在 `fs.cpSync(addonRoot, stageRoot, ...)` 之后，加一行代码把 wasm 文件考进 XPI：

```js
// 复制 onnxruntime-web wasm 文件
const wasmDir = path.join(projectRoot, "node_modules", "onnxruntime-web", "dist");
fs.copyFileSync(
  path.join(wasmDir, "ort-wasm-simd-threaded.wasm"),
  path.join(stageRoot, "content", "scripts", "ort-wasm-simd-threaded.wasm"),
);
fs.copyFileSync(
  path.join(wasmDir, "ort-wasm-simd-threaded.mjs"),
  path.join(stageRoot, "content", "scripts", "ort-wasm-simd-threaded.mjs"),
);
```

#### 4. 更新 `scripts/verify-xpi.mjs`

在 required entries 列表里加上 wasm 文件：

```js
for (const required of [
  // ... 原有
  "content/scripts/ort-wasm-simd-threaded.wasm",
]) {
```

### 预期效果

修复后重新构建，安装，`ort.InferenceSession.create` 应该能正确初始化 wasm 后端。错误会从"cannot determine script source URL"变为"empty model rejected"（因为传了空数据，这是预期行为）。

---

## 验证 2：模型加载

`InferenceSession.create` 通了之后，需要下载 PP-OCR 模型（ONNX 格式）。

### 需要的模型

RapidOCR（PP-OCRv4）需要两个 ONNX 模型：

| 模型 | 作用 | 体积 |
|------|------|------|
| `ch_PP-OCRv4_det_infer.onnx` | 文字检测（哪里是文字区域） | ~4.5MB |
| `ch_PP-OCRv4_rec_infer.onnx` | 文字识别（图片→文字） | ~10.5MB |

### 决策点

- **模型放哪？** 打进 XPI（XPI 从 132KB → ~15MB，一次安装即可）或首次运行时从网络下载（XPI 保持 132KB，但需要联网）。建议先打进 XPI，用户明确要"开装即用"。
- **中文以外语言？** PP-OCR 有英文模型（`en_PP-OCRv4_det_infer.onnx` + `en_PP-OCRv4_rec_infer.onnx`），体积一样。后续可以按需额外打包。

### 代码结构（后续实现）

```
src/
├── ocr/                  # 新建
│   ├── preprocess.ts     # 图像预处理（resize、normalize）
│   ├── rapidocr.ts       # RapidOCR 推理管线（det→crop→rec）
│   └── models.ts         # 模型加载 + onnx session 管理
├── pdf/                  # 新建
│   ├── render.ts         # 用 pdf.js 将 PDF 页渲染为 canvas
│   └── rebuild.ts        # 用 pdf-lib 重建可搜索 PDF
├── hooks.ts              # 修改 execute 调用新管线
└── ...
```

---

## 完整路线图

```
Phase 1 [当前]：修复 wasm 加载
  → 复制 wasm 文件进 XPI
  → 设置 wasmPaths
  → 验证 InferenceSession.create 成功

Phase 2：模型加载
  → 下载 PP-OCR ONNX 模型
  → 打进 XPI
  → 实现模型加载（createSession 带模型 buffer）

Phase 3：OCR 管线
  → 实现 preprocess（图像→tensor）
  → 实现 det 推理（文字区域检测）
  → 实现 rec 推理（裁剪→识别文字）
  → 输出文字+坐标列表

Phase 4：PDF 重建
  → 用 pdf.js 渲染 PDF 页为 canvas 图片
  → 用 pdf-lib 或手工方式写不可见文字层
  → 输出可搜索 PDF

Phase 5：集成到插件
  → 修改 hooks.ts 的 execute
  → 调用 ocr 管线 → 调用 rebuild
  → 用 attachment-service 创建 [OCR] 兄弟附件
  → 删除旧 ocr-dialog.ts 的"尚未实现"占位
```

---

## 包体积估算

```
JS bundle (ort)               542 KB
wasm 文件                     13.4 MB
mjs 文件                       24 KB
PP-OCRv4 det 模型              4.5 MB
PP-OCRv4 rec 模型             10.5 MB
其他（XPI 框架、locale、图标）   50 KB
─────────────────────────────
总计                          ~28.5 MB
```

Zotero 插件 XPI 通常 10-50MB，28MB 在可接受范围内。如果体积敏感，后续可以对模型做量化（FP16→INT8 可减半）。