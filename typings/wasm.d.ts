// Minimal WebAssembly typings (Zotero chrome context, no DOM lib)
declare namespace WebAssembly {
  interface Instance {}
  interface Module {}
  interface ResultObject {
    module: Module;
    instance: Instance;
  }
  function instantiate(
    bufferSource: Uint8Array | ArrayBuffer,
    importObject?: Record<string, unknown>,
  ): Promise<ResultObject>;
}