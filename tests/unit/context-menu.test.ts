import assert from "node:assert/strict";
import test from "node:test";

import { CONTEXT_MENU_ID, CONTEXT_MENU_ICON, MenuManagerLike, ContextMenuController } from "../../src/ui/context-menu";
import { SelectionItem, SelectionResolver } from "../../src/zotero/selection-resolver";

class FakeItem implements SelectionItem {
  public asyncPathCalls = 0;
  constructor(
    public id: number,
    private attachment: boolean,
    public attachmentContentType = "",
    private path: string | null = null,
    private children: FakeItem[] = [],
    public libraryID = 1,
    public parentItemID: number | false = false,
  ) {}
  isAttachment(): boolean { return this.attachment; }
  getAttachments(): number[] { return this.children.map((item) => item.id); }
  getFilePath(): string | false { return this.path || false; }
  async getFilePathAsync(): Promise<string | false> {
    this.asyncPathCalls += 1;
    return this.path || false;
  }
  getDisplayTitle(): string { return `Item ${this.id}`; }
}

type RegisteredMenu = Parameters<MenuManagerLike["registerMenu"]>[0];

class FakeMenuManager {
  public registered: RegisteredMenu[] = [];
  public unregistered: string[] = [];

  registerMenu(options: RegisteredMenu): string {
    this.registered.push(options);
    return options.menuID;
  }

  unregisterMenu(menuID: string): boolean {
    this.unregistered.push(menuID);
    this.registered = this.registered.filter((menu) => menu.menuID !== menuID);
    return true;
  }

  async fireCommand(menuID: string, items: SelectionItem[] | undefined): Promise<void> {
    const registration = this.registered.find((entry) => entry.menuID === menuID);
    assert.ok(registration);
    const callback = registration.menus[0].onCommand;
    assert.ok(callback);
    await callback({}, { items });
  }
}

function makeController(
  selected: SelectionItem[],
  command: (jobCount: number) => Promise<void> | void = async () => {},
) {
  const menuManager = new FakeMenuManager();
  const resolver = new SelectionResolver(() => []);
  const controller = new ContextMenuController(
    menuManager,
    resolver,
    async (resolution) => command(resolution.jobs.length),
    () => selected,
  );
  return { controller, menuManager };
}

test("register sets the menu label via onShowing (Zotero 10 MenuManager)", () => {
  const { controller, menuManager } = makeController([]);
  controller.register();
  const registration = menuManager.registered[0];
  assert.equal(registration.menus[0].l10nID, undefined);
  const elem = { label: "" };
  registration.menus[0].onShowing({}, { menuElem: elem });
  assert.equal(elem.label, "OCR PDF");
});

test("register uses the 16x16 context-fill menu icon", () => {
  const { controller, menuManager } = makeController([]);
  controller.register();
  assert.equal(menuManager.registered[0].menus[0].icon, CONTEXT_MENU_ICON);
});

test("command prefers context.items when Zotero supplies them", async () => {
  const pdf = new FakeItem(1, true, "application/pdf", "C:\\paper.pdf");
  let jobs = -1;
  const { controller, menuManager } = makeController([pdf], async (count) => { jobs = count; });
  controller.register();
  await menuManager.fireCommand(CONTEXT_MENU_ID, [pdf]);
  assert.equal(jobs, 1);
});

test("command falls back to the current Zotero Pane selection when context.items is absent", async () => {
  const pdf = new FakeItem(2, true, "application/pdf", "C:\\paper.pdf");
  let jobs = -1;
  const { controller, menuManager } = makeController([pdf], async (count) => { jobs = count; });
  controller.register();
  await menuManager.fireCommand(CONTEXT_MENU_ID, undefined);
  assert.equal(jobs, 1);
});

test("unregister is safe and removes the menu", () => {
  const { controller, menuManager } = makeController([]);
  controller.register();
  controller.unregister();
  assert.deepEqual(menuManager.unregistered, [CONTEXT_MENU_ID]);
  controller.unregister();
  assert.deepEqual(menuManager.unregistered, [CONTEXT_MENU_ID]);
});
