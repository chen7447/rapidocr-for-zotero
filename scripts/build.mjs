import esbuild from "esbuild";
import archiver from "archiver";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonRoot = path.join(projectRoot, "addon");
const buildRoot = path.join(projectRoot, "build");
const stageRoot = path.join(buildRoot, "addon");
const manifest = JSON.parse(fs.readFileSync(path.join(addonRoot, "manifest.json"), "utf8"));
const xpiPath = path.join(buildRoot, `pdf-ocr-for-zotero-${manifest.version}.xpi`);

// Remove only the staging directory
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.cpSync(addonRoot, stageRoot, { recursive: true });
fs.mkdirSync(path.join(stageRoot, "content", "scripts"), { recursive: true });

// Copy onnxruntime-web wasm binary (jsep variant, matching the bundled ort.bundle.min.mjs)
const wasmDist = path.join(projectRoot, "node_modules", "onnxruntime-web", "dist");
fs.copyFileSync(
  path.join(wasmDist, "ort-wasm-simd-threaded.jsep.wasm"),
  path.join(stageRoot, "content", "scripts", "ort-wasm-simd-threaded.jsep.wasm"),
);

// Copy pdfjs-dist worker (needed by the bundled pdfjs-dist legacy build)
const pdfjsDist = path.join(projectRoot, "node_modules", "pdfjs-dist", "legacy", "build");
fs.copyFileSync(
  path.join(pdfjsDist, "pdf.worker.mjs"),
  path.join(stageRoot, "content", "scripts", "pdf.worker.mjs"),
);

await esbuild.build({
  entryPoints: [path.join(projectRoot, "src", "index.ts")],
  outfile: path.join(stageRoot, "content", "scripts", "pdf-ocr-for-zotero.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox128",
  charset: "utf8",
  legalComments: "none",
  define: {
    addonID: JSON.stringify(manifest.applications.zotero.id),
    addonVersion: JSON.stringify(manifest.version),
    addonRoot: "addonRoot",
  },
});

// Build OCR worker (separate bundle, loaded via new Worker in chrome context)
await esbuild.build({
  entryPoints: [path.join(projectRoot, "src", "ocr", "ocr-worker.ts")],
  outfile: path.join(stageRoot, "content", "scripts", "ocr-worker.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox128",
  charset: "utf8",
  legalComments: "none",
  // Worker 不需要 addonRoot 等全局（模型字节由主线程传递）
  define: {},
});

// Pack only file entries (no empty directory entries) — matching the layout
// of installable Zotero XPIs. archiver.directory() adds empty-dir entries
// (e.g. "content/", "worker/") which cause Zotero 9 to reject the XPI with
// "incompatible with this version of Zotero". We walk the tree and add each
// file individually instead.
await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(xpiPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
  archive.pipe(output);

  const addDir = (dir, prefix = "") => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const arc = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) {
        addDir(full, arc);
      } else {
        archive.file(full, { name: arc });
      }
    }
  };
  addDir(stageRoot);
  archive.finalize();
});

console.log(`Built ${xpiPath}`);
