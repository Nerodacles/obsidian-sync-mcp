/**
 * query_notes: filter, sort and page notes by their frontmatter properties.
 *
 * Pure functions over the records the search index already holds (path,
 * mtime, tags, parsed properties), so a query never reads a note from the
 * vault. Kept free of MCP types so it can be unit-tested.
 */

import { createHash } from "crypto";
import type { QueryRecord } from "./search.js";

export const QUERY_DEFAULT_LIMIT = 50;
export const QUERY_MAX_LIMIT = 500;
export const QUERY_MAX_CONDITIONS = 20;
/** Text output cuts a longer value and says how much was left out. JSON is never cut. */
export const QUERY_MAX_VALUE_CHARS = 200;

export const QUERY_OPS = ["eq", "ne", "in", "contains", "exists", "missing", "lt", "gt"] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

/** Fields that come from the index rather than from frontmatter; they win over a property of the same name. */
export const PSEUDO_FIELDS = ["path", "folder", "tags", "mtime"] as const;

export type Scalar = string | number | boolean;

export interface Condition {
    field: string;
    op: QueryOp;
    value?: Scalar | Scalar[];
}

export interface QuerySort {
    field: string;
    order?: "asc" | "desc";
}

export interface QueryRequest {
    where?: Condition[];
    select?: string[];
    sort?: QuerySort;
    limit?: number;
    cursor?: string;
    folder?: string;
    tag?: string;
}

/** A field's value on one note: absent, one string, or a list of strings. mtime is ms since epoch. */
type Value = undefined | string | string[] | number;

export interface QueryRow {
    path: string;
    /** Selected fields; null when the note doesn't have the field. */
    values: Record<string, string | string[] | null>;
}

export interface QueryResult {
    total: number;
    /** 1-based position of the first row shown; total + 1 when the cursor is past the last match. */
    start: number;
    rows: QueryRow[];
    nextCursor: string | null;
    /** Where-fields no scanned note has, a hint for a typo when nothing matches. */
    unknownFields: string[];
}

export class QueryError extends Error {}

function fieldValue(r: QueryRecord, field: string): Value {
    switch (field) {
        case "path":
            return r.path;
        case "folder": {
            const i = r.path.lastIndexOf("/");
            return i === -1 ? "" : r.path.slice(0, i);
        }
        case "tags":
            return r.tags.length > 0 ? r.tags : undefined;
        case "mtime":
            return r.mtime;
    }
    // Own keys only: a field named "constructor" or "toString" is not a property.
    if (!Object.hasOwn(r.properties, field)) return undefined;
    const v = r.properties[field];
    if (Array.isArray(v) && v.length === 0) return undefined;
    return v;
}

/** The note's frontmatter title, or its file name without `.md` — so select=['title'] always shows something. */
function titleOf(r: QueryRecord): string {
    const t = fieldValue(r, "title");
    if (typeof t === "string" && t.trim()) return t.trim();
    const name = r.path.slice(r.path.lastIndexOf("/") + 1);
    return name.endsWith(".md") ? name.slice(0, -3) : name;
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;
// ISO 8601 date or date-time; a time without a zone is read as UTC so results don't depend on the server's zone.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A comparable key: numbers, then dates, then text. */
type Key = { t: 0 | 1; n: number } | { t: 2; s: string };

function dateMs(s: string): number | null {
    const m = s.match(ISO_DATE);
    if (!m) return null;
    let iso = s.replace(" ", "T");
    if (iso.length > 10 && !m[1]) iso += "Z";
    const ms = Date.parse(iso);
    return isNaN(ms) ? null : ms;
}

function keyOf(v: string | number, field: string): Key {
    if (typeof v === "number") return { t: field === "mtime" ? 1 : 0, n: v };
    if (field === "mtime") {
        const ms = dateMs(v);
        if (ms !== null) return { t: 1, n: ms };
    }
    if (NUMBER.test(v)) return { t: 0, n: Number(v) };
    const ms = dateMs(v);
    if (ms !== null) return { t: 1, n: ms };
    return { t: 2, s: v };
}

/** Strict total order on text: locale order, then code units, so two distinct strings never tie. */
export function compareText(a: string, b: string): number {
    return a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0);
}

function compareKeys(a: Key, b: Key): number {
    if (a.t !== b.t) return a.t - b.t;
    if (a.t === 2) return compareText(a.s, (b as { s: string }).s);
    return a.n - (b as { n: number }).n;
}

function elements(v: Value): Array<string | number> {
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
}

function normalizeTag(field: string, s: string): string {
    return field === "tags" ? s.replace(/^#/, "") : s;
}

function scalarEquals(field: string, el: string | number, want: Scalar): boolean {
    if (field === "mtime" && typeof want === "string") return dateMs(want) === el;
    if (typeof want === "number") {
        const k = keyOf(el, field);
        return k.t !== 2 && k.n === want;
    }
    return normalizeTag(field, String(el)) === normalizeTag(field, String(want));
}

/** Does one condition hold for a note? On a list, eq/in/lt/gt hold when any element does, ne when none equals. */
function holds(r: QueryRecord, c: Condition): boolean {
    const v = fieldValue(r, c.field);
    const els = elements(v);
    switch (c.op) {
        case "exists":
            return els.length > 0;
        case "missing":
            return els.length === 0;
        case "eq":
            return els.some((el) => scalarEquals(c.field, el, c.value as Scalar));
        case "ne":
            return !els.some((el) => scalarEquals(c.field, el, c.value as Scalar));
        case "in":
            return els.some((el) => (c.value as Scalar[]).some((w) => scalarEquals(c.field, el, w)));
        case "contains": {
            const want = normalizeTag(c.field, String(c.value)).toLowerCase();
            if (Array.isArray(v)) return v.some((el) => normalizeTag(c.field, el).toLowerCase() === want);
            return els.some((el) => String(el).toLowerCase().includes(want));
        }
        case "lt":
        case "gt": {
            const want = keyOf(c.value as string | number, c.field);
            return els.some((el) => {
                const k = keyOf(el, c.field);
                // A number is never compared with a date or text: "high" is neither below nor above 3.
                if (k.t !== want.t) return false;
                const d = compareKeys(k, want);
                return c.op === "lt" ? d < 0 : d > 0;
            });
        }
    }
}

/** Throws QueryError for a condition whose value doesn't fit its operator. */
export function validateConditions(where: Condition[]): void {
    if (where.length > QUERY_MAX_CONDITIONS) throw new QueryError(`At most ${QUERY_MAX_CONDITIONS} conditions.`);
    for (const c of where) {
        const at = `Condition ${JSON.stringify(c.field)} ${c.op}`;
        if (!c.field) throw new QueryError("Every condition needs a field.");
        if (!(QUERY_OPS as readonly string[]).includes(c.op)) throw new QueryError(`Unknown operator ${JSON.stringify(c.op)}; use one of ${QUERY_OPS.join(", ")}.`);
        if (c.op === "exists" || c.op === "missing") {
            if (c.value !== undefined) throw new QueryError(`${at} takes no value.`);
        } else if (c.op === "in") {
            if (!Array.isArray(c.value) || c.value.length === 0) throw new QueryError(`${at} needs a non-empty list as value.`);
        } else if (c.value === undefined || Array.isArray(c.value)) {
            throw new QueryError(`${at} needs a single value${c.op === "eq" ? " (use `in` for a list)" : ""}.`);
        } else if ((c.op === "lt" || c.op === "gt") && typeof c.value === "boolean") {
            throw new QueryError(`${at} needs a number, a date or text, not a boolean.`);
        } else if (c.field === "mtime" && (c.op === "lt" || c.op === "gt") && typeof c.value === "string" && dateMs(c.value) === null) {
            throw new QueryError(`${at} needs an ISO date such as '2026-03-25' or milliseconds since epoch.`);
        }
    }
}

/** Sort key of a row; null when the field is missing. A list sorts by its first element. */
function sortKey(r: QueryRecord, field: string): Key | null {
    const els = elements(fieldValue(r, field));
    return els.length === 0 ? null : keyOf(els[0], field);
}

/** Missing values last in either direction; ties (and every row without a sort) by path, ascending. */
function compareRows(a: { key: Key | null; path: string }, b: { key: Key | null; path: string }, desc: boolean): number {
    if (a.key && b.key) {
        const d = compareKeys(a.key, b.key);
        if (d !== 0) return desc ? -d : d;
    } else if (a.key || b.key) {
        return a.key ? -1 : 1;
    }
    return compareText(a.path, b.path);
}

/** Identifies the filter and sort a cursor was made for; select and limit may change between pages. */
function fingerprint(q: QueryRequest): string {
    const sort = q.sort ? [q.sort.field, q.sort.order ?? "asc"] : null;
    const basis = JSON.stringify([q.where ?? [], sort, q.folder ?? null, q.tag ?? null]);
    return createHash("sha256").update(basis).digest("base64url").slice(0, 16);
}

interface CursorData {
    q: string;
    k: Key | null;
    p: string;
}

function encodeCursor(c: CursorData): string {
    return Buffer.from(JSON.stringify(c), "utf-8").toString("base64url");
}

function decodeCursor(s: string, q: QueryRequest): CursorData {
    let c: CursorData;
    try {
        c = JSON.parse(Buffer.from(s, "base64url").toString("utf-8"));
    } catch {
        throw new QueryError("Invalid cursor. Pass the `next cursor` of the previous page unchanged, or drop it to start over.");
    }
    const keyOk = c?.k === null || (c?.k?.t === 2 ? typeof c.k.s === "string" : (c?.k?.t === 0 || c?.k?.t === 1) && typeof c.k.n === "number");
    if (!c || typeof c.q !== "string" || typeof c.p !== "string" || !keyOk) {
        throw new QueryError("Invalid cursor. Pass the `next cursor` of the previous page unchanged, or drop it to start over.");
    }
    if (c.q !== fingerprint(q)) {
        throw new QueryError("This cursor belongs to a query with different where, sort, folder or tag. Repeat the same query, or drop the cursor to start over.");
    }
    return c;
}

function selectedValue(r: QueryRecord, field: string): string | string[] | null {
    if (field === "title") return titleOf(r);
    const v = fieldValue(r, field);
    if (v === undefined) return null;
    if (typeof v === "number") return v ? new Date(v).toISOString() : null;
    return v;
}

/**
 * Run a query. The total counts every match; the cursor is a keyset (the
 * last row's sort key and path), so a page starts right after the row the
 * previous page ended on even if notes were added or removed in between.
 */
export function runQuery(records: QueryRecord[], q: QueryRequest): QueryResult {
    const where = q.where ?? [];
    validateConditions(where);
    const limit = q.limit ?? QUERY_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_LIMIT) throw new QueryError(`limit must be a whole number from 1 to ${QUERY_MAX_LIMIT}.`);
    const after = q.cursor ? decodeCursor(q.cursor, q) : null;

    const desc = q.sort?.order === "desc";
    const sortField = q.sort?.field;
    const matches = records
        .filter((r) => where.every((c) => holds(r, c)))
        .map((r) => ({ r, path: r.path, key: sortField ? sortKey(r, sortField) : null }));
    matches.sort((a, b) => compareRows(a, b, desc));

    let first = 0;
    if (after) {
        const cur = { key: after.k, path: after.p };
        first = matches.findIndex((m) => compareRows(m, cur, desc) > 0);
        if (first === -1) first = matches.length;
    }
    const page = matches.slice(first, first + limit);
    const select = q.select && q.select.length > 0 ? q.select : ["title"];
    const rows = page.map(({ r }) => ({
        path: r.path,
        values: Object.fromEntries(select.filter((f) => f !== "path").map((f) => [f, selectedValue(r, f)])),
    }));
    const last = page.at(-1);
    const nextCursor = last && first + page.length < matches.length ? encodeCursor({ q: fingerprint(q), k: last.key, p: last.path }) : null;

    let unknownFields: string[] = [];
    if (matches.length === 0) {
        const known = new Set<string>(PSEUDO_FIELDS);
        for (const r of records) for (const k of Object.keys(r.properties)) known.add(k);
        unknownFields = [...new Set(where.filter((c) => c.op !== "missing" && c.op !== "ne").map((c) => c.field))].filter((f) => !known.has(f));
    }
    return { total: matches.length, start: first + 1, rows, nextCursor, unknownFields };
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "37 notes match; showing 1-37." — always first, so a cut listing can't pass for a complete one. */
export function describeTotal(res: Pick<QueryResult, "total" | "start" | "rows" | "nextCursor">): string {
    const verb = res.total === 1 ? "matches" : "match";
    if (res.total === 0) return `0 notes match.`;
    if (res.rows.length === 0) return `${plural(res.total, "note")} ${verb}; showing none, the cursor is past the last match.`;
    const range = `showing ${res.start}-${res.start + res.rows.length - 1}`;
    return `${plural(res.total, "note")} ${verb}; ${range}` + (res.nextCursor ? `; next cursor: ${res.nextCursor}` : ".");
}

/** One value, compact: lists joined with ", ", whitespace collapsed, long values cut with a marker. */
export function showValue(v: string | string[] | null): string {
    if (v === null) return "(missing)";
    const text = (Array.isArray(v) ? v.join(", ") : v).replace(/\s+/g, " ").trim();
    if (text.length <= QUERY_MAX_VALUE_CHARS) return text;
    return `${text.slice(0, QUERY_MAX_VALUE_CHARS)}… [+${text.length - QUERY_MAX_VALUE_CHARS} chars]`;
}

/** Rows as "- [path](link) · field: value · field: value". */
export function describeRows(rows: QueryRow[], link: (path: string) => string): string[] {
    return rows.map((row) => {
        const fields = Object.entries(row.values).map(([f, v]) => `${f}: ${showValue(v)}`);
        return [`- [${row.path}](${link(row.path)})`, ...fields].join(" · ");
    });
}

/** The JSON answer: values are never cut; a missing field is null. */
export function toJson(res: QueryResult, extra: { index: string; warnings: string[] }): string {
    return JSON.stringify({
        total: res.total,
        shown: res.rows.length,
        start: res.start,
        next_cursor: res.nextCursor,
        index: extra.index,
        warnings: extra.warnings,
        rows: res.rows.map((r) => ({ path: r.path, ...r.values })),
    });
}
