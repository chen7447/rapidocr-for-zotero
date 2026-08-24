// v3：纯 JS WASM OCR（无外部进程），偏好对应 v3 真实可调参数。
// 注意：Firefox pref 体系没有 float 类型，只有 bool/string/int，
// 因此阈值用 0~100 整数百分比存储（30 = 0.3），避免数值被截断。
pref("extensions.zotero.pdfocrforzotero.detLimitSideLen", 1536);
pref("extensions.zotero.pdfocrforzotero.detThresh", 30);
pref("extensions.zotero.pdfocrforzotero.detBoxThresh", 40);
pref("extensions.zotero.pdfocrforzotero.autoOpenAfterSuccess", false);