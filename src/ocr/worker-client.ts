/**
 * WorkerClient — main-thread wrapper around the OCR Web Worker.
 *
 * Handles: worker creation, init handshake (models + wasm bytes transferred
 * zero-copy), page submission, cancellation, error surfacing. All inference
 * happens in the worker thread so the Zotero UI stays responsive.
 */
import type { OCRBox } from "./types";

export interface OCRModelAssets {
  /** ort-wasm-simd-threaded.jsep.wasm bytes */
  wasm: ArrayBuffer;
  det: ArrayBuffer;
  rec: ArrayBuffer;
  dict: string[];
}

/**
 * Submit one rendered page to the worker and get back its OCR boxes.
 * The `rgba` buffer is transferred (zero-copy) and invalidated on the
 * caller side — the caller must not use it after submission.
 */
export class WorkerClient {
  private worker: Worker;
  private pending = new Map<
    number,
    { resolve: (boxes: OCRBox[]) => void; reject: (err: Error) => void }
  >();
  private errorCb: ((message: string) => void) | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((err: Error) => void) | null = null;
  private dead = false;

  /** Spawn the worker immediately so the engine can abort during handshake. */
  static open(workerUrl: string): WorkerClient {
    const worker = new Worker(workerUrl);
    const client = new WorkerClient(worker);
    worker.addEventListener("message", (ev: MessageEvent) => client.onMessage(ev.data));
    worker.addEventListener("error", (ev: ErrorEvent) => {
      const msg = `OCR worker error: ${ev.message}`;
      client.rejectInit(new Error(msg));
      client.errorCb?.(msg);
      client.rejectAll(msg);
    });
    return client;
  }

  private constructor(worker: Worker) {
    this.worker = worker;
  }

  /** Hand model assets to the worker and wait for ready. */
  async init(
    assets: OCRModelAssets,
    detOptions: { detLimitSideLen: number; detThresh: number; detBoxThresh: number },
  ): Promise<void> {
    if (this.dead) throw new Error("OCR cancelled");
    const ready = new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
    this.worker.postMessage(
      {
        type: "init",
        wasm: assets.wasm,
        det: assets.det,
        rec: assets.rec,
        dict: assets.dict,
        detLimitSideLen: detOptions.detLimitSideLen,
        detThresh: detOptions.detThresh,
        detBoxThresh: detOptions.detBoxThresh,
      },
      [assets.wasm, assets.det, assets.rec],
    );
    await ready;
  }

  /** Submit one rendered page; resolves with its OCR boxes. */
  processPage(pageIndex: number, width: number, height: number, rgba: ArrayBuffer): Promise<OCRBox[]> {
    if (this.dead) return Promise.reject(new Error("OCR cancelled"));
    return new Promise<OCRBox[]>((resolve, reject) => {
      this.pending.set(pageIndex, { resolve, reject });
      this.worker.postMessage(
        { type: "page", pageIndex, width, height, rgba },
        [rgba], // transferable — zero-copy
      );
    });
  }

  cancel(): void {
    if (this.dead) return;
    this.dead = true;
    this.rejectInit(new Error("OCR cancelled"));
    this.rejectAll("OCR cancelled");
    this.worker.terminate(); // kills in-flight wasm; cooperative cancel can't
  }

  onError(cb: (message: string) => void): void {
    this.errorCb = cb;
  }

  terminate(): void {
    this.cancel();
  }

  private rejectInit(err: Error): void {
    this.initReject?.(err);
    this.initResolve = null;
    this.initReject = null;
  }

  private rejectAll(message: string): void {
    for (const { reject } of this.pending.values()) {
      reject(new Error(message));
    }
    this.pending.clear();
  }

  private onMessage(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const msg = data as Record<string, unknown>;
    if (msg.type === "ready") {
      this.initResolve?.();
      this.initResolve = null;
      this.initReject = null;
      return;
    }
    if (msg.type === "pageResult") {
      const pi = msg.pageIndex as number;
      const entry = this.pending.get(pi);
      if (entry) {
        this.pending.delete(pi);
        entry.resolve(msg.boxes as OCRBox[]);
      }
      return;
    }
    if (msg.type === "error") {
      const msgText = String(msg.message ?? "unknown");
      this.rejectInit(new Error("OCR worker init failed: " + msgText));
      this.rejectAll(msgText);
      this.errorCb?.(msgText);
    }
  }
}