/**
 * Line diff for showing a conflict leaf against the winner. Small and
 * dependency-free: common prefix and suffix are cut first (a conflict is
 * usually a few edited lines), then an LCS table aligns what is left. The
 * table is capped at LINE_DIFF_MAX_CELLS; past that the middle is shown as
 * removed-then-added, so a huge note can never block the event loop.
 */

/** Largest LCS table (old lines x new lines, after cutting the common prefix and suffix). */
export const LINE_DIFF_MAX_CELLS = 4_000_000;

export type DiffOp = { kind: " " | "-" | "+"; text: string };

export function diffLines(oldText: string, newText: string, maxCells = LINE_DIFF_MAX_CELLS): DiffOp[] {
    const a = oldText.split("\n");
    const b = newText.split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    const ops: DiffOp[] = a.slice(0, start).map((text) => ({ kind: " ", text }));
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const n = midA.length;
    const m = midB.length;
    if (n * m > maxCells) {
        for (const text of midA) ops.push({ kind: "-", text });
        for (const text of midB) ops.push({ kind: "+", text });
    } else if (n > 0 || m > 0) {
        // lcs[i * (m + 1) + j] = LCS length of midA[i..] and midB[j..]
        const w = m + 1;
        const lcs = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && midA[i] === midB[j]) { ops.push({ kind: " ", text: midA[i] }); i++; j++; }
            else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { ops.push({ kind: "-", text: midA[i] }); i++; }
            else { ops.push({ kind: "+", text: midB[j] }); j++; }
        }
    }
    for (const text of a.slice(endA)) ops.push({ kind: " ", text });
    return ops;
}

export interface UnifiedOptions {
    /** Unchanged lines shown around each change. Default 2. */
    context?: number;
    /** Stop once the output would exceed this many characters. */
    maxChars?: number;
    /** Longer lines are cut to this many characters, marked with "…". */
    maxLineChars?: number;
}

export interface UnifiedDiff {
    lines: string[];
    /** Diff lines (changes and context) left out to stay within maxChars. */
    omitted: number;
}

/** Hunks in unified-diff form (`@@ -a,b +c,d @@`), without file headers. */
export function unifiedDiff(ops: DiffOp[], { context = 2, maxChars = Infinity, maxLineChars = Infinity }: UnifiedOptions = {}): UnifiedDiff {
    const changed = ops.map((op) => op.kind !== " ");
    const keep: boolean[] = Array.from({ length: ops.length }, () => false);
    for (let k = 0; k < ops.length; k++) {
        if (!changed[k]) continue;
        for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) keep[c] = true;
    }
    const lines: string[] = [];
    let chars = 0;
    let omitted = 0;
    let full = false;
    const emit = (line: string): void => {
        if (!full && chars + line.length + 1 <= maxChars) { lines.push(line); chars += line.length + 1; }
        else { full = true; omitted++; }
    };
    let oldLine = 1;
    let newLine = 1;
    let k = 0;
    while (k < ops.length) {
        if (!keep[k]) {
            if (ops[k].kind !== "+") oldLine++;
            if (ops[k].kind !== "-") newLine++;
            k++;
            continue;
        }
        let end = k;
        while (end < ops.length && keep[end]) end++;
        const hunk = ops.slice(k, end);
        const oldCount = hunk.filter((op) => op.kind !== "+").length;
        const newCount = hunk.filter((op) => op.kind !== "-").length;
        if (!full) emit(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
        for (const op of hunk) {
            const text = op.text.length > maxLineChars ? op.text.slice(0, maxLineChars) + "…" : op.text;
            emit(op.kind + text);
        }
        oldLine += oldCount;
        newLine += newCount;
        k = end;
    }
    return { lines, omitted };
}
