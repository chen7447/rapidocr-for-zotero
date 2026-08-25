/**
 * Open a Zotero attachment in the user's configured PDF handler (Reader or external).
 */
export async function openAttachment(itemID: number, pageIndex?: number): Promise<void> {
  const item = Zotero.Items.get(itemID);
  if (!item) throw new Error(`Attachment ${itemID} not found`);
  const location = pageIndex == null ? undefined : { pageIndex };

  const handlers = (Zotero as unknown as {
    FileHandlers?: { open: (item: unknown, params?: unknown) => Promise<unknown> };
  }).FileHandlers;
  if (typeof handlers?.open === "function") {
    await handlers.open(item, location ? { location } : undefined);
    return;
  }

  const reader = (Zotero as unknown as {
    Reader?: { open: (id: number, loc?: { pageIndex: number }) => Promise<unknown> };
  }).Reader;
  if (typeof reader?.open === "function") {
    await reader.open(itemID, location);
    return;
  }

  throw new Error("No available API to open attachment");
}
