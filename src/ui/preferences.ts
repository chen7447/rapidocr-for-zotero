export const PREFS_PANE_ID = "pdf-ocr-for-zotero-prefs";
export const PREFS_PREFIX = "extensions.zotero.pdfocrforzotero";

export type PreferencePanesLike = {
  register(opts: {
    pluginID: string;
    id: string;
    src: string;
    label: string;
    image: string;
    scripts: string[];
  }): Promise<string>;
  unregister(id: string): boolean;
};

export type PrefDefinition = {
  key: string;
  default: string | number | boolean;
};

export const DEFAULT_PREFS: PrefDefinition[] = [
  { key: "detLimitSideLen", default: 1536 },
  // Firefox pref 无 float 类型，阈值以 0~100 整数百分比存储（30 = 0.3）
  { key: "detThresh", default: 30 },
  { key: "detBoxThresh", default: 40 },
  { key: "ocrWorkers", default: 4 },
  { key: "autoOpenAfterSuccess", default: false },
];

export function prefKey(key: string): string {
  return `${PREFS_PREFIX}.${key}`;
}

export async function registerPrefs(
  panes: PreferencePanesLike,
  pluginID: string,
  rootURI: string,
): Promise<string> {
  // Unregister previous pane to avoid duplicates on update/reinstall
  try {
    panes.unregister(PREFS_PANE_ID);
  } catch {
    // ignore
  }
  const src = `${rootURI.replace(/\/$/, "")}/content/preferences.xhtml`;
  await panes.register({
    pluginID,
    id: PREFS_PANE_ID,
    src,
    label: "PDF OCR",
    image: `${rootURI.replace(/\/$/, "")}/content/icons/pdf-ocr.svg`,
    scripts: [`${rootURI.replace(/\/$/, "")}/content/preferences.js`],
  });
  return PREFS_PANE_ID;
}

export function unregisterPrefs(
  panes: PreferencePanesLike,
  paneID: string = PREFS_PANE_ID,
): void {
  try {
    panes.unregister(paneID);
  } catch {
    // ignore
  }
}