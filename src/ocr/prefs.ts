// src/ocr/prefs.ts
// Pure parsing of raw preference values into the runtime OCR settings.
//
// Firefox's pref system has no float type, so thresholds are stored as
// 0..100 integer percentages (30 = 0.3). Even older builds stored the float
// directly (0 < v < 1) — both encodings are accepted.
//
// CRITICAL semantic rule: 0 is a LEGITIMATE value (e.g. detMaxRotDeg = 0
// disables the tilt filter). "Unset" and "set to 0" must stay distinct —
// a `Number(v) || fallback` read would silently swallow the 0.

export type RawPrefValue = number | boolean | undefined | null;

export type ParsedOcrPrefs = {
  /** ≥1 */
  detLimitSideLen: number;
  /** 0..1 — 0 is legal */
  detThresh: number;
  /** 0..1 — 0 is legal */
  detBoxThresh: number;
  /** 0..90 — 0 is legal (tilt filter off) */
  detMaxRotDeg: number;
  /** 0=直立正文 1=倾斜正文 2=复合方法 */
  cropMode: 0 | 1 | 2;
  /** 1..8 */
  ocrWorkers: number;
  autoOpen: boolean;
};

const DEFAULTS = {
  detLimitSideLen: 1536,
  detThresh: 0.3,
  detBoxThresh: 0.4,
  detMaxRotDeg: 30,
  cropMode: 2,
  ocrWorkers: 4,
} as const;

function finiteOrNull(v: RawPrefValue): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Percent-stored threshold → 0..1. Preserves explicit 0; accepts legacy floats. */
function parseThreshold(v: RawPrefValue, fallback: number): number {
  const n = finiteOrNull(v);
  if (n === null) return fallback;
  if (n >= 1) return n / 100;                    // stored as percent
  if (n > 0) return Math.round(n * 100) / 100;   // legacy float, same rounding as before
  return 0;                                      // explicit zero — preserved
}

export function parseOcrPrefs(raw: {
  detLimitSideLen?: RawPrefValue;
  detThresh?: RawPrefValue;
  detBoxThresh?: RawPrefValue;
  detMaxRotDeg?: RawPrefValue;
  cropMode?: RawPrefValue;
  ocrWorkers?: RawPrefValue;
  autoOpenAfterSuccess?: RawPrefValue;
}): ParsedOcrPrefs {
  const limit = finiteOrNull(raw.detLimitSideLen);
  const maxRot = finiteOrNull(raw.detMaxRotDeg);
  const cm = finiteOrNull(raw.cropMode);
  const workers = finiteOrNull(raw.ocrWorkers);

  return {
    detLimitSideLen:
      limit !== null && limit >= 1 ? Math.round(limit) : DEFAULTS.detLimitSideLen,
    detThresh: parseThreshold(raw.detThresh, DEFAULTS.detThresh),
    detBoxThresh: parseThreshold(raw.detBoxThresh, DEFAULTS.detBoxThresh),
    detMaxRotDeg:
      maxRot === null ? DEFAULTS.detMaxRotDeg : Math.min(90, Math.max(0, Math.round(maxRot))),
    cropMode: cm === 0 || cm === 1 || cm === 2 ? cm : DEFAULTS.cropMode,
    ocrWorkers:
      workers !== null && Number.isInteger(workers) && workers >= 1
        ? Math.min(8, workers)
        : DEFAULTS.ocrWorkers,
    autoOpen: !!raw.autoOpenAfterSuccess,
  };
}
