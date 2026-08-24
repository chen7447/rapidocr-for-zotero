export type OCRAttachmentDeps = {
  attachmentID: number;
  path: string;
  title: string;
  getItems: (ids: number[]) => { id: number; libraryID: number; parentItemID?: number | false; isAttachment: () => boolean }[];
  importFromFile: (opts: {
    file: string;
    libraryID: number;
    parentItemID: number;
    title: string;
  }) => Promise<{ id: number }>;
  indexItems: (ids: number[], opts?: { complete?: boolean; ignoreErrors?: boolean }) => Promise<void>;
};

export type OCRAttachmentResult =
  | { status: "sibling_imported"; attachmentID: number }
  | { status: "item_not_found" }
  | { status: "standalone_attachment" };

export async function createOCRAttachment(deps: OCRAttachmentDeps): Promise<OCRAttachmentResult> {
  const items = deps.getItems([deps.attachmentID]);
  if (!items.length) return { status: "item_not_found" };
  const original = items[0];

  if (!original.parentItemID) return { status: "standalone_attachment" };
  const parentItemID = original.parentItemID;

  const newAttachment = await deps.importFromFile({
    file: deps.path,
    libraryID: original.libraryID,
    parentItemID,
    title: `${deps.title} [OCR]`,
  });

  await deps.indexItems([newAttachment.id], { complete: true, ignoreErrors: false });
  return { status: "sibling_imported", attachmentID: newAttachment.id };
}

export type CreateParentAndAttachDeps = {
  attachmentID: number;
  path: string;
  title: string;
  getItems: (ids: number[]) => { id: number; libraryID: number; parentItemID?: number | false; isAttachment: () => boolean }[];
  createRegularItem: (opts: { libraryID: number; title: string }) => Promise<{ id: number }>;
  setAttachmentParent: (attachmentID: number, parentID: number) => Promise<void>;
  importFromFile: (opts: { file: string; libraryID: number; parentItemID: number; title: string }) => Promise<{ id: number }>;
  indexItems: (ids: number[], opts?: { complete?: boolean; ignoreErrors?: boolean }) => Promise<void>;
};

export type CreateParentResult =
  | { status: "parent_created"; attachmentID: number }
  | { status: "item_not_found" };

export async function createParentAndAttachOCR(deps: CreateParentAndAttachDeps): Promise<CreateParentResult> {
  const items = deps.getItems([deps.attachmentID]);
  if (!items.length) return { status: "item_not_found" };
  const original = items[0];

  const parent = await deps.createRegularItem({
    libraryID: original.libraryID,
    title: deps.title,
  });

  await deps.setAttachmentParent(deps.attachmentID, parent.id);

  const newAttachment = await deps.importFromFile({
    file: deps.path,
    libraryID: original.libraryID,
    parentItemID: parent.id,
    title: `${deps.title} [OCR]`,
  });

  await deps.indexItems([newAttachment.id], { complete: true, ignoreErrors: false });
  return { status: "parent_created", attachmentID: newAttachment.id };
}