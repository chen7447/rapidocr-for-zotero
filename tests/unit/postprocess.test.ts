import assert from "node:assert/strict";
import test from "node:test";
import { frameClaimingLine, frameReadingOrder, isGarbageText, lowDensityLine, nmsBoxes, orderBoxes, readingOrder, scaleBox, stackedOrder, type BoxLike, type DetBox } from "../../src/ocr/postprocess";

function box(id: string, x1: number, y1: number, x2: number, y2: number, score = 0.9): DetBox {
  return {
    points: [x1, y1, x2, y1, x2, y2, x1, y2],
    raw: { x1, y1, x2, y2 },
    score,
  };
}

test("nmsBoxes keeps a line box and drops chips inside it", () => {
  const line = box("line", 0, 0, 200, 20, 0.8);
  const chip = box("chip", 10, 2, 40, 18, 0.9);
  const kept = nmsBoxes([line, chip]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0], line);
});

test("nmsBoxes keeps two formula symbols when the parent is already gone", () => {
  const abn = box("ABn", 10, 5, 50, 25, 0.9);
  const abt = box("ABt", 10, 50, 50, 70, 0.9);
  assert.equal(nmsBoxes([abn, abt]).length, 2);
});

test("nmsBoxes keeps two side-by-side line boxes", () => {
  const a = box("a", 0, 0, 100, 20);
  const b = box("b", 0, 30, 100, 50);
  assert.equal(nmsBoxes([a, b]).length, 2);
});

test("readingOrder is top-to-bottom then left-to-right, not score order", () => {
  const bottom = box("bottom", 0, 80, 100, 100, 0.99);
  const topRight = box("topRight", 80, 0, 160, 20, 0.5);
  const topLeft = box("topLeft", 0, 2, 70, 18, 0.2);
  const ordered = readingOrder([bottom, topRight, topLeft]);
  assert.deepEqual(ordered.map((b) => b.points[0] + "," + b.points[1]), [
    "0,2",
    "80,0",
    "0,80",
  ]);
});

test("isGarbageText catches fraction-bar 8-runs and keeps citations", () => {
  assert.equal(isGarbageText("8888885888"), true);
  assert.equal(isGarbageText("881188 84 4019 1"), false); // mixed digits, no long run
  assert.equal(isGarbageText("9(1):101-123"), false);
  assert.equal(isGarbageText("https://doi.org/10.1007"), false);
  assert.equal(isGarbageText("control."), false);
});

const PAGE = 1200;

function colBoxes(x1: number, x2: number, rows: number, y0 = 120): BoxLike[] {
  const out: BoxLike[] = [];
  for (let r = 0; r < rows; r++) {
    const y = y0 + r * 80;
    out.push(box('c', x1, y, x2, y + 40));
  }
  return out;
}

function interleave(left: BoxLike[], right: BoxLike[]): BoxLike[] {
  const boxes: BoxLike[] = [];
  for (let r =  0; r < left.length; r++) boxes.push(left[r], right[r]);
  return boxes;
}

test("orderBoxes default (twoColumn off) equals readingOrder", () => {
  const boxes = interleave(colBoxes(80,  520,  10), colBoxes(680,  1120,  10));
  const got = orderBoxes(boxes, PAGE)
  const want = readingOrder(boxes);
  assert.deepEqual(got, want);
});
test("orderBoxes twoColumn splits: left column fully, then right", () => {
  const left = colBoxes(80,  520,  10);
  const right = colBoxes(680,  1120,  10);
  const out = orderBoxes(interleave(left, right), PAGE, true);
  assert.equal(out.length,  20);
  for (let i =   0; i <   10; i++) assert.ok(out[i].raw.x1 <   600);
  for (let i =   10; i <   20; i++) assert.ok(out[i].raw.x1 >   600);
});

test("orderBoxes twoColumn keeps a wide table in the left column", () => {
  const table = colBoxes(40,   560,   6,   100);
  const para = colBoxes(640,   1120,   6,   100);
  const out = orderBoxes(interleave(table, para), PAGE, true);
  assert.equal(out.length,   12);
  for (const b of table) assert.ok(out.indexOf(b) <   6);
  for (const b of para) assert.ok(out.indexOf(b) >=   6);
});

test("frameClaimingLine: 按被圈盖住的长度判定,相邻两圈的中缝不再吃掉整行", () => {
  const rects = [{ x1: 65, y1: 82, x2: 594, y2: 693 }, { x1: 613, y1: 133, x2: 1146, y2: 694 }]; // F4 | F5
  // b50 实测 det#1 458,152~763,160:F4 盖 136px + F5 盖 150px = 整行 94%,而中心 610 掉进 19px 中缝
  assert.equal(frameClaimingLine(box("head", 458, 152, 763, 160), rects), 1); // 归盖得最多的 F5
  assert.equal(frameClaimingLine(box("title", 95, 363, 903, 375), rects), 0); // F4 盖 499 > F5 盖 290
  // det#0 457,98~758,108 在 F5 顶边(133)之上,只有 F4 盖 46% → 仍不写(纵向没被两个圈同时盖住)
  assert.equal(frameClaimingLine(box("top", 457, 98, 758, 108), rects), -1);
  // 真没圈到的横缝(b48 det#26 420,716~1125,726:697~732 之间没有圈)→ 不写
  assert.equal(frameClaimingLine(box("seam", 420, 716, 1125, 726), rects), -1);
  assert.equal(frameClaimingLine(box("outside", 1160, 300, 1300, 312), rects), -1);
  // b41 语义保留:端点出血无所谓,中心出圈但只盖住 33% 的行不写(b47 半行高纵向容差也在)
  const one = [{ x1: 0, y1: 0, x2: 1000, y2: 2200 }];
  assert.equal(frameClaimingLine(box("out-sticking", 200, 100, 1150, 160), one), 0);
  assert.equal(frameClaimingLine(box("mostly-out", 850, 100, 1300, 160), one), -1);
  assert.equal(frameClaimingLine(box("below", 700, 700, 900, 712), rects), -1);
  const f3 = [{ x1: 388, y1: 734, x2: 1133, y2: 1043 }];
  assert.equal(frameClaimingLine(box("last-line", 630, 1039, 1124, 1048), f3), 0);
  assert.equal(frameClaimingLine(box("one-line-below", 630, 1050, 1124, 1059), f3), -1);
});

test("twoColumn Elsevier first page: full-width header, then left column, then right", () => {
  // 版面实测(j.lwt.2013.11.010 首页):标题/作者/单位/摘要/版权通栏,正文双栏
  const title = box("z1", 120, 80, 1080, 280);
  const authors = box("z2", 120, 300, 1080, 380);
  const affil = box("z3", 120, 400, 1080, 480);
  const absLabel = box("z4a", 120, 500, 300, 540);
  const abs1 = box("z4b", 120, 560, 1080, 760);
  const abs2 = box("z4c", 120, 770, 1080, 800);
  const cop = box("z5", 420, 810, 780, 840);
  const left = colBoxes(60, 552, 4, 900);
  const right = colBoxes(648, 1140, 4, 900);
  const out = orderBoxes([cop, ...interleave(left, right), abs2, title, abs1, affil, authors, absLabel], PAGE, true);
  const key = (b: BoxLike): number => b.raw.y1 * 1000 + b.raw.x1;
  assert.deepEqual(out.map(key), [title, authors, affil, absLabel, abs1, abs2, cop, ...left, ...right].map(key));
});

test("twoColumn keeps an asymmetric 37/63 abstract block as two columns, not interleaved", () => {
  // 摘要区左子栏 10%~37%、右子栏 37%~90%:右栏横跨页中线但不是通栏,不得逐行与左栏交错
  const left = [box("l1", 120, 500, 420, 540), box("l2", 120, 550, 440, 590)];
  const right = [box("r1", 460, 500, 1080, 540), box("r2", 460, 550, 1060, 590), box("r3", 460, 600, 1080, 640)];
  const out = orderBoxes([...right, ...left], PAGE, true);
  const key = (b: BoxLike): number => b.raw.y1 * 1000 + b.raw.x1;
  assert.deepEqual(out.map(key), [...left, ...right].map(key));
});

test("frameReadingOrder: 圈按版面 y→x 排,不按画框先后", () => {
  // b36 实测的 5 个圈(px):页眉 F3 / 左摘要 F2 / 右摘要 F4(从封面拉到摘要) / 左栏 F0 / 右栏 F1
  const rects = [
    { x1: 79, y1: 768, x2: 369, y2: 1048 }, // F0 左栏
    { x1: 392, y1: 742, x2: 1139, y2: 1041 }, // F1 右栏
    { x1: 53, y1: 228, x2: 602, y2: 705 }, // F2 左摘要
    { x1: 57, y1: 79, x2: 603, y2: 211 }, // F3 页眉
    { x1: 618, y1: 135, x2: 1154, y2: 694 }, // F4 右摘要+封面
  ];
  assert.deepEqual(frameReadingOrder(rects), [3, 2, 4, 0, 1]); // 页眉 → 左摘要 → 右摘要 → 左栏 → 右栏
  // 先画右栏再画左栏,也得左栏在前
  assert.deepEqual(
    frameReadingOrder([{ x1: 392, y1: 742, x2: 1139, y2: 1041 }, { x1: 79, y1: 768, x2: 369, y2: 1048 }]),
    [1, 0],
  );
});

// b56: 圈=白名单,双栏=圈间顺序。横贯带(标题)切区,区内先左栏后右栏。
// 圈位取自用户实页形态:右栏摘要圈的上沿高于左栏引言圈 — 老的 y→x 会把摘要抢到引言前。
test("frameReadingOrder twoColumn: 横贯带切区,区内先左栏后右栏", () => {
  const rects = [
    { x1: 58, y1: 294, x2: 1142, y2: 377 }, // 0 标题横贯带(整宽=墙)
    { x1: 645, y1: 133, x2: 867, y2: 694 }, // 1 右栏摘要(从页眉拉下来)
    { x1: 268, y1: 768, x2: 522, y2: 1048 }, // 2 左栏引言
    { x1: 645, y1: 1020, x2: 867, y2: 1330 }, // 3 右栏 2.1
  ];
  // 不勾双栏:老语义 y→x — 标题、摘要(右)、引言(左)、2.1
  assert.deepEqual(frameReadingOrder(rects, 1190, false), [0, 1, 2, 3]);
  // 勾双栏:标题墙 → 区内左(引言) → 右(摘要、2.1)
  assert.deepEqual(frameReadingOrder(rects, 1190, true), [0, 2, 1, 3]);
  // 无横贯带时:纯双栏序,左栏圈全部先于右栏圈
  const noWall = [rects[1], rects[2], rects[3]];
  assert.deepEqual(frameReadingOrder(noWall, 1190, true), [1, 0, 2]);
  // b57: 用户实页 4 圈(px) — 摘要圈 61.5% 宽、标题圈 75% 宽,旧 0.6 宽度判据把
  // 它们误判成墙 → F0>F1>F3>F2。margin 判据下只有刊头带(53~1151)是墙:
  // F0 > F1 > F2(左 ARTICLE INFO) > F3(右 ABSTRACT)。
  const real = [
    { x1: 53, y1: 78, x2: 1151, y2: 311 }, // 刊头带,双margin=真墙
    { x1: 68, y1: 336, x2: 965, y2: 515 }, // 标题+作者(75%宽,非墙)
    { x1: 70, y1: 546, x2: 366, y2: 826 }, // 左栏 ARTICLE INFO
    { x1: 398, y1: 546, x2: 1130, y2: 854 }, // 右栏 ABSTRACT(61.5%宽,非墙)
  ];
  assert.deepEqual(frameReadingOrder(real, 1190, true), [0, 1, 2, 3]);
});

// b59: 抢救通道的坐标缩放。round-trip 整数坐标必须还原。
test("scaleBox: points/raw 同步缩放,1/ratio 还原", () => {
  const b = { points: [10, 20, 30, 20, 30, 28, 10, 28], raw: { x1: 10, y1: 20, x2: 30, y2: 28 }, text: "x" };
  const up = scaleBox(b, 2);
  assert.deepEqual(up.points, [20, 40, 60, 40, 60, 56, 20, 56]);
  assert.deepEqual(up.raw, { x1: 20, y1: 40, x2: 60, y2: 56 });
  const down = scaleBox({ ...up, points: up.points.slice(), raw: { ...up.raw } }, 0.5);
  assert.deepEqual(down.raw, b.raw);
});

test("stackedOrder: 圈内跨栏的两堆先读左堆再读右堆,不再逐行交错", () => {
  const key = (b: BoxLike): string => `${b.raw.x1},${b.raw.y1}`;
  // b45 实测 F3 圈(70,1064~961,1244)横跨两栏:原先出成 左1 右1 左2 右2
  const twoCol = [
    box("l1", 91, 1060, 584, 1069), box("r1", 630, 1060, 1123, 1070),
    box("l2", 91, 1081, 582, 1090), box("r2", 629, 1081, 1123, 1090),
  ];
  assert.deepEqual(stackedOrder(twoCol).map(key), ["91,1060", "91,1081", "630,1060", "629,1081"]);
  // 单栏块(框宽≈块跨度,测不到栏沟)→ 保持 readingOrder 的 y→x
  const oneCol = [
    box("a", 115, 955, 584, 965), box("b", 91, 977, 583, 986),
    box("c", 91, 997, 584, 1006), box("d", 91, 1018, 584, 1028),
  ];
  assert.deepEqual(stackedOrder(oneCol).map((b) => b.raw.y1), [955, 977, 997, 1018]);
  // 37/63 子栏 + 通栏行:通栏行当分隔符先出,然后左子栏整堆、右子栏整堆(b45 F4 实测)
  const mixed = [box("wide", 95, 363, 903, 375), box("info", 89, 562, 274, 570), box("abs", 418, 562, 548, 570), box("affil", 90, 497, 315, 506)];
  assert.deepEqual(stackedOrder(mixed).map(key), ["95,363", "90,497", "89,562", "418,562"]);
});

test("lowDensityLine: 只对「字符数撑不满框宽」的行走 AABB 补读", () => {
  const b = (x1: number, y1: number, x2: number, y2: number, text: string) => ({ raw: { x1, y1, x2, y2 }, text });
  assert.ok(lowDensityLine(b(90, 600, 169, 610, "e:"))); // b48 实测:整页通道只读出 "e:"
  assert.ok(!lowDensityLine(b(90, 600, 169, 610, "Article history:"))); // 补读后的正确文本
  assert.ok(!lowDensityLine(b(91, 913, 207, 922, "1.Introduction"))); // 短而正常的行
  assert.ok(!lowDensityLine(b(629, 1164, 668, 1173, "2010).")));
  assert.ok(!lowDensityLine(b(95, 363, 903, 375, "Purification,preliminarystructuralcharacterizationandinvitro")));
  assert.ok(lowDensityLine(b(113, 1407, 584, 1416, ""))); // rec 交白卷 → 同样走补读捞回
});
