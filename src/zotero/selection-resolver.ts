export interface SelectionItem {
  id: number;
  libraryID: number;
  parentItemID?: number | false;
  attachmentContentType?: string;
  isAttachment(): boolean;
  getAttachments?(): number[];
  getFilePath?(): string | false;
  getFilePathAsync?(): Promise<string | false>;
  getDisplayTitle?(): string;
}

export type SelectionJob = {
  attachment: SelectionItem;
  path: string;
};

export type SelectionIssue = {
  attachment: SelectionItem;
  reason: "FILE_UNAVAILABLE" | "DERIVED_OCR_ATTACHMENT";
};

export type SelectionResolution = {
  jobs: SelectionJob[];
  unavailable: SelectionIssue[];
  skipped: SelectionIssue[];
};

export type SelectionPreview = {
  candidates: SelectionItem[];
  count: number;
};

export type ItemsByID = (ids: number[]) => SelectionItem[];

function isDerivedOCRAttachment(item: SelectionItem): boolean {
  const title = item.getDisplayTitle?.() || "";
  return /(?:\s|^)\[OCR\](?:\s|$)/i.test(title);
}

function isPDF(item: SelectionItem, path: string | false | null): boolean {
  return item.attachmentContentType === "application/pdf"
    || Boolean(path && /\.pdf$/i.test(path));
}

export class SelectionResolver {
  constructor(private readonly getItemsByID: ItemsByID) {}

  private collectCandidates(selectedItems: SelectionItem[]): SelectionItem[] {
    const candidates: SelectionItem[] = [];
    for (const item of selectedItems) {
      if (item.isAttachment()) {
        candidates.push(item);
        continue;
      }
      const ids = item.getAttachments?.() || [];
      if (ids.length) candidates.push(...this.getItemsByID(ids));
    }
    return candidates;
  }

  preview(selectedItems: SelectionItem[]): SelectionPreview {
    const seen = new Set<number>();
    const candidates = this.collectCandidates(selectedItems).filter((attachment) => {
      if (seen.has(attachment.id) || !attachment.isAttachment()) return false;
      seen.add(attachment.id);
      if (isDerivedOCRAttachment(attachment)) return false;
      return isPDF(attachment, attachment.getFilePath?.() || false);
    });
    return { candidates, count: candidates.length };
  }

  async resolve(selectedItems: SelectionItem[]): Promise<SelectionResolution> {
    const candidates = this.collectCandidates(selectedItems);

    const result: SelectionResolution = {
      jobs: [],
      unavailable: [],
      skipped: [],
    };
    const seen = new Set<number>();

    for (const attachment of candidates) {
      if (seen.has(attachment.id) || !attachment.isAttachment()) continue;
      seen.add(attachment.id);

      const path = await attachment.getFilePathAsync?.()
        || attachment.getFilePath?.()
        || false;
      if (!isPDF(attachment, path)) continue;
      if (isDerivedOCRAttachment(attachment)) {
        result.skipped.push({ attachment, reason: "DERIVED_OCR_ATTACHMENT" });
        continue;
      }
      if (!path) {
        result.unavailable.push({ attachment, reason: "FILE_UNAVAILABLE" });
        continue;
      }
      result.jobs.push({ attachment, path });
    }

    return result;
  }
}
