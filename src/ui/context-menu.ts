import {
  SelectionItem,
  SelectionResolution,
  SelectionResolver,
} from "../zotero/selection-resolver";

export const CONTEXT_MENU_ID = "pdf-ocr-for-zotero-create-searchable-pdf";
export const PLUGIN_ID = "pdfocrforzotero@example.com";

export interface MenuManagerLike {
  registerMenu(options: {
    menuID: string;
    pluginID: string;
    target: string;
    menus: Array<{
      menuType: string;
      label?: string;
      l10nID?: string;
      l10nArgs?: string;
      icon?: string;
      onShowing?: (event: unknown, context: { menuElem: any }) => void;
      onCommand?: (
        event: unknown,
        context: { items?: SelectionItem[] },
      ) => Promise<void> | void;
    }>;
  }): string | false;
  unregisterMenu(menuID: string): boolean;
}

export type SelectionCommand = (resolution: SelectionResolution) => Promise<void> | void;
export type SelectionFallback = () => SelectionItem[];

export class ContextMenuController {
  private registeredMenuID: string | null = null;

  constructor(
    private readonly menuManager: MenuManagerLike,
    private readonly resolver: SelectionResolver,
    private readonly command: SelectionCommand,
    private readonly getFallbackSelection: SelectionFallback,
  ) {}

  register(): void {
    if (this.registeredMenuID) return;
    const menuID = this.menuManager.registerMenu({
      menuID: CONTEXT_MENU_ID,
      pluginID: PLUGIN_ID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          // Zotero 10's MenuManager only supports l10nID (no label field).
          // Use onShowing to set the label directly on the XUL element.
          onShowing: (_event, context) => {
            const elem = context.menuElem;
            if (elem) elem.label = "OCR PDF";
          },
          onCommand: (_event, context) => {
            // Start async operation in background — MenuManager requires
            // synchronous callbacks; an async callback breaks the popup
            // menu on first use (known v2 issue).
            (async () => {
              try {
                const items = context.items?.length ? context.items : this.getFallbackSelection();
                const resolution = await this.resolver.resolve(items);
                await this.command(resolution);
              } catch (err) {
                try {
                  const msg = err instanceof Error ? err.message : String(err);
                  Zotero.debug(`PDF OCR: menu command error: ${msg}`);
                } catch {
                  // ignore logging errors too
                }
              }
            })();
          },
        },
      ],
    });
    if (!menuID) {
      throw new Error("PDF OCR For Zotero: MenuManager registration failed");
    }
    this.registeredMenuID = menuID;
  }

  unregister(): void {
    if (!this.registeredMenuID) return;
    this.menuManager.unregisterMenu(this.registeredMenuID);
    this.registeredMenuID = null;
  }
}
