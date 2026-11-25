import { test } from "node:test";
import assert from "node:assert/strict";
import type * as LineDiff from "./line-diff.js";

// Loaded inside each test, so on a tree without the module every test fails on its own.
const lib = (): Promise<typeof LineDiff> => import("./line-diff.js");

test("diffLines aligns an edited line between unchanged ones", async () => {
    const { diffLines } = await lib();
    const ops = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
    assert.deepEqual(ops.map((o) => o.kind + o.text), [" a", "-b", "+B", " c", " d", "+e"]);
});

test("identical texts give no changes, and unifiedDiff prints nothing", async () => {
    const { diffLines, unifiedDiff } = await lib();
    const ops = diffLines("x\ny\n", "x\ny\n");
    assert.ok(ops.every((o) => o.kind === " "));
    assert.deepEqual(unifiedDiff(ops), { lines: [], omitted: 0 });
});

test("unifiedDiff: hunks with 2 lines of context and correct ranges", async () => {
    const { diffLines, unifiedDiff } = await lib();
    const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const neu = old.replace("l5", "L5").replace("l15", "L15");
    const { lines, omitted } = unifiedDiff(diffLines(old, neu));
    assert.equal(omitted, 0);
    assert.deepEqual(lines, [
        "@@ -3,5 +3,5 @@", " l3", " l4", "-l5", "+L5", " l6", " l7",
        "@@ -13,5 +13,5 @@", " l13", " l14", "-l15", "+L15", " l16", " l17",
    ]);
});

test("a table over the cell cap falls back to removed-then-added, still correct", async () => {
    const { diffLines } = await lib();
    const ops = diffLines("p\na\nb\ns", "p\nb\na\ns", 1);
    assert.deepEqual(ops.map((o) => o.kind + o.text), [" p", "-a", "-b", "+b", "+a", " s"]);
});

test("maxChars bounds the output and counts what was left out", async () => {
    const { diffLines, unifiedDiff } = await lib();
    const old = Array.from({ length: 1000 }, (_, i) => `old line ${i}`).join("\n");
    const neu = Array.from({ length: 1000 }, (_, i) => `new line ${i}`).join("\n");
    const { lines, omitted } = unifiedDiff(diffLines(old, neu), { maxChars: 500 });
    assert.ok(lines.join("\n").length <= 500, `${lines.join("\n").length} chars`);
    assert.equal(lines.length + omitted, 2000 + 1, "every diff line is either shown or counted (plus one hunk header)");
});

test("maxLineChars cuts long lines", async () => {
    const { diffLines, unifiedDiff } = await lib();
    const { lines } = unifiedDiff(diffLines("a", "x".repeat(50)), { maxLineChars: 10 });
    assert.deepEqual(lines, ["@@ -1,1 +1,1 @@", "-a", "+" + "x".repeat(10) + "…"]);
});
