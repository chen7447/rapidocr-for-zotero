/**
 * Parse a 1-based page spec: "3", "3,5,7-9". Empty → [currentPage] (1-based).
 * Out of range / junk tokens are dropped.
 */
export function parsePageSpec(spec: string, pageCount: number, currentPage = 1): number[] {
  const n = pageCount | 0;
  const raw = spec.trim();
  const tokens = raw ? raw.split(/[,，\s]+/).filter(Boolean) : [String(currentPage)];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const token of tokens) {
    const m = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/.exec(token);
    if (!m) continue;
    let a = parseInt(m[1], 10);
    let b = m[2] ? parseInt(m[2], 10) : a;
    if (a > b) [a, b] = [b, a];
    for (let p = a; p <= b; p++) {
      if (p < 1 || seen.has(p)) continue;
      if (n > 0 && p > n) continue;
      seen.add(p);
      out.push(p);
    }
  }
  out.sort((x, y) => x - y);
  return out;
}

/** 1-based page numbers → 0-based indexes. */
export function toPageIndexes(pages1: number[]): number[] {
  return pages1.map((p) => p - 1);
}
