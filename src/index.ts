import { Addon } from "./addon";
import hooks from "./hooks";

const addon = new Addon(
  {
    addonID,
    addonVersion,
    addonRoot,
  },
  hooks,
);

const zotero = Zotero as typeof Zotero & { PDFOCRForZotero?: Addon };
zotero.PDFOCRForZotero = addon;
_globalThis.addon = addon;
