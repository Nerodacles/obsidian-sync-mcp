import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SearchIndex } from "./search.js";
import {
    QUERY_MAX_VALUE_CHARS,
    QueryError,
    describeRows,
    describeTotal,
    runQuery,
    showValue,
    toJson,
    type Condition,
    type QueryRequest,
} from "./query.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-03-01T00:00:00Z");

function vault(): SearchIndex {
    const idx = new SearchIndex();
    idx.update("Projects/Garden plan.md", "---\ntitle: Garden plan\ntype: project\nstatus: draft\npriority: 2\nupdated: 2026-03-10\ntags: [garden, spring]\n---\nBeds and #compost", T0 + 1 * DAY);
    idx.update("Projects/Shed.md", "---\ntype: project\nstatus: done\npriority: 10\nupdated: 2026-01-05\n---\nRoof", T0 + 2 * DAY);
    idx.update("Recipes/Bread.md", "---\ntitle: Sourdough bread\ntype: recipe\nstatus: draft\npriority: high\nservings: 4\ntags: [baking]\n---\nFlour", T0 + 3 * DAY);
    idx.update("Recipes/Soup.md", "---\ntype: recipe\nstatus: ready\npriority: 1\nupdated: 2026-02-20T09:30\naliases:\n  - Winter soup\n  - Broth\n---\nLeeks", T0 + 4 * DAY);
    idx.update("Inbox.md", "No frontmatter, a #garden tag in the body.", T0 + 5 * DAY);
    return idx;
}

function paths(q: QueryRequest, idx = vault()): string[] {
    return runQuery(idx.queryRecords(q.folder, q.tag), q).rows.map((r) => r.path);
}

function where(...conditions: Condition[]): string[] {
    return paths({ where: conditions });
}

describe("query_notes operators", () => {
    it("eq matches a property exactly", () => {
        assert.deepEqual(where({ field: "type", op: "eq", value: "recipe" }), ["Recipes/Bread.md", "Recipes/Soup.md"]);
        assert.deepEqual(where({ field: "type", op: "eq", value: "Recipe" }), [], "eq is case-sensitive");
    });

    it("eq with a number compares numerically", () => {
        assert.deepEqual(where({ field: "priority", op: "eq", value: 2 }), ["Projects/Garden plan.md"]);
        assert.deepEqual(where({ field: "servings", op: "eq", value: "4" }), ["Recipes/Bread.md"]);
    });

    it("eq on a list holds when any element equals", () => {
        assert.deepEqual(where({ field: "aliases", op: "eq", value: "Broth" }), ["Recipes/Soup.md"]);
    });

    it("all conditions must hold (AND)", () => {
        assert.deepEqual(where({ field: "type", op: "eq", value: "recipe" }, { field: "status", op: "eq", value: "draft" }), ["Recipes/Bread.md"]);
    });

    it("ne excludes the value and keeps notes without the field", () => {
        assert.deepEqual(where({ field: "status", op: "ne", value: "draft" }), ["Inbox.md", "Projects/Shed.md", "Recipes/Soup.md"]);
    });

    it("in matches any value of the list", () => {
        assert.deepEqual(where({ field: "status", op: "in", value: ["ready", "done"] }), ["Projects/Shed.md", "Recipes/Soup.md"]);
    });

    it("contains looks for an element of a list, case-insensitive", () => {
        assert.deepEqual(where({ field: "aliases", op: "contains", value: "winter soup" }), ["Recipes/Soup.md"]);
        assert.deepEqual(where({ field: "aliases", op: "contains", value: "winter" }), [], "a list element must equal, not contain");
    });

    it("contains looks for a substring of a text, case-insensitive", () => {
        assert.deepEqual(where({ field: "title", op: "contains", value: "BREAD" }), ["Recipes/Bread.md"]);
        assert.deepEqual(where({ field: "path", op: "contains", value: "projects/" }), ["Projects/Garden plan.md", "Projects/Shed.md"]);
    });

    it("exists and missing", () => {
        assert.deepEqual(where({ field: "title", op: "exists" }), ["Projects/Garden plan.md", "Recipes/Bread.md"]);
        assert.deepEqual(where({ field: "type", op: "missing" }), ["Inbox.md"]);
    });

    it("lt and gt compare numbers as numbers, not text", () => {
        assert.deepEqual(where({ field: "priority", op: "lt", value: 3 }), ["Projects/Garden plan.md", "Recipes/Soup.md"]);
        assert.deepEqual(where({ field: "priority", op: "gt", value: "3" }), ["Projects/Shed.md"], "10 > 3 although '10' < '3' as text");
    });

    it("lt and gt never compare a number with text", () => {
        assert.ok(!where({ field: "priority", op: "gt", value: 0 }).includes("Recipes/Bread.md"), "'high' is not above 0");
        assert.ok(!where({ field: "priority", op: "lt", value: 99 }).includes("Recipes/Bread.md"));
        assert.deepEqual(where({ field: "priority", op: "gt", value: "average" }), ["Recipes/Bread.md"], "text against text");
    });

    it("lt and gt compare ISO dates as dates, with or without a time", () => {
        assert.deepEqual(where({ field: "updated", op: "gt", value: "2026-02-01" }), ["Projects/Garden plan.md", "Recipes/Soup.md"]);
        assert.deepEqual(where({ field: "updated", op: "lt", value: "2026-02-20T10:00" }), ["Projects/Shed.md", "Recipes/Soup.md"]);
    });

    it("pseudo-field folder is the parent folder, '' at the root", () => {
        assert.deepEqual(where({ field: "folder", op: "eq", value: "Recipes" }), ["Recipes/Bread.md", "Recipes/Soup.md"]);
        assert.deepEqual(where({ field: "folder", op: "eq", value: "" }), ["Inbox.md"]);
    });

    it("pseudo-field tags holds frontmatter and inline tags; a leading # is ignored", () => {
        assert.deepEqual(where({ field: "tags", op: "contains", value: "#garden" }), ["Inbox.md", "Projects/Garden plan.md"]);
        assert.deepEqual(where({ field: "tags", op: "eq", value: "compost" }), ["Projects/Garden plan.md"]);
    });

    it("a field named like an Object method is just a missing field", () => {
        assert.deepEqual(where({ field: "toString", op: "exists" }), []);
        assert.deepEqual(where({ field: "constructor", op: "missing" }).length, 5);
    });

    it("pseudo-field mtime takes an ISO date or milliseconds", () => {
        assert.deepEqual(where({ field: "mtime", op: "eq", value: "2026-03-02T00:00:00Z" }), ["Projects/Garden plan.md"]);
        assert.deepEqual(where({ field: "mtime", op: "gt", value: "2026-03-04T12:00:00Z" }), ["Inbox.md", "Recipes/Soup.md"]);
        assert.deepEqual(where({ field: "mtime", op: "lt", value: T0 + 2 * DAY }), ["Projects/Garden plan.md"]);
    });

    it("folder and tag parameters narrow the notes before the conditions", () => {
        assert.deepEqual(paths({ folder: "Recipes", where: [{ field: "status", op: "eq", value: "draft" }] }), ["Recipes/Bread.md"]);
        assert.deepEqual(paths({ tag: "garden" }), ["Inbox.md", "Projects/Garden plan.md"]);
    });

    it("refuses a value that doesn't fit the operator, with a message", () => {
        const bad: Condition[] = [
            { field: "status", op: "in", value: "draft" },
            { field: "status", op: "eq", value: ["draft"] },
            { field: "status", op: "eq" },
            { field: "status", op: "exists", value: "x" },
            { field: "mtime", op: "gt", value: "yesterday" },
            { field: "priority", op: "lt", value: true },
        ];
        for (const c of bad) assert.throws(() => paths({ where: [c] }), QueryError, JSON.stringify(c));
    });
});

describe("query_notes sort", () => {
    it("sorts numbers numerically, missing values last, ties by path", () => {
        assert.deepEqual(paths({ sort: { field: "priority" } }), [
            "Recipes/Soup.md", // 1
            "Projects/Garden plan.md", // 2
            "Projects/Shed.md", // 10
            "Recipes/Bread.md", // "high": text after numbers
            "Inbox.md", // missing
        ]);
    });

    it("desc reverses the values but still puts missing values last", () => {
        assert.deepEqual(paths({ sort: { field: "updated", order: "desc" } }), [
            "Projects/Garden plan.md",
            "Recipes/Soup.md",
            "Projects/Shed.md",
            "Inbox.md",
            "Recipes/Bread.md",
        ]);
    });

    it("equal values are ordered by path", () => {
        assert.deepEqual(paths({ sort: { field: "status", order: "desc" }, where: [{ field: "status", op: "exists" }] }), [
            "Recipes/Soup.md", // ready
            "Projects/Garden plan.md", // draft, by path
            "Recipes/Bread.md", // draft
            "Projects/Shed.md", // done
        ]);
    });
});

describe("query_notes paging", () => {
    function many(n: number): SearchIndex {
        const idx = new SearchIndex();
        for (let i = 0; i < n; i++) {
            const rank = i % 7;
            idx.update(`Notes/n${String(i).padStart(3, "0")}.md`, `---\ntype: recipe\nrank: ${rank}\n---\n`, T0 + i);
        }
        return idx;
    }

    function allPages(idx: SearchIndex, q: QueryRequest): { pages: string[][]; lines: string[] } {
        const pages: string[][] = [];
        const lines: string[] = [];
        let cursor: string | undefined;
        do {
            const res = runQuery(idx.queryRecords(), { ...q, cursor });
            pages.push(res.rows.map((r) => r.path));
            lines.push(describeTotal(res));
            cursor = res.nextCursor ?? undefined;
        } while (cursor);
        return { pages, lines };
    }

    it("walks every match exactly once across pages, in sort order", () => {
        const idx = many(23);
        const { pages, lines } = allPages(idx, { sort: { field: "rank", order: "desc" }, limit: 5 });
        assert.equal(pages.length, 5);
        const flat = pages.flat();
        assert.equal(new Set(flat).size, 23);
        const whole = runQuery(idx.queryRecords(), { sort: { field: "rank", order: "desc" }, limit: 500 }).rows.map((r) => r.path);
        assert.deepEqual(flat, whole);
        assert.match(lines[0], /^23 notes match; showing 1-5; next cursor: \S+$/);
        assert.match(lines[1], /^23 notes match; showing 6-10; next cursor: /);
        assert.equal(lines[4], "23 notes match; showing 21-23.");
    });

    it("the same cursor gives the same page", () => {
        const idx = many(12);
        const first = runQuery(idx.queryRecords(), { limit: 4 });
        const a = runQuery(idx.queryRecords(), { limit: 4, cursor: first.nextCursor! });
        const b = runQuery(idx.queryRecords(), { limit: 4, cursor: first.nextCursor! });
        assert.deepEqual(a, b);
        assert.equal(a.start, 5);
    });

    it("select and limit may change between pages; where, sort, folder and tag may not", () => {
        const idx = many(12);
        const q: QueryRequest = { where: [{ field: "type", op: "eq", value: "recipe" }], limit: 4 };
        const first = runQuery(idx.queryRecords(), q);
        const next = runQuery(idx.queryRecords(), { ...q, limit: 8, select: ["rank"], cursor: first.nextCursor! });
        assert.equal(next.rows.length, 8);
        assert.throws(() => runQuery(idx.queryRecords(), { ...q, where: [], cursor: first.nextCursor! }), /different where, sort, folder or tag/);
        assert.throws(() => runQuery(idx.queryRecords(), { ...q, sort: { field: "rank" }, cursor: first.nextCursor! }), QueryError);
        const sorted = runQuery(idx.queryRecords(), { sort: { field: "rank" }, limit: 4 });
        assert.equal(runQuery(idx.queryRecords(), { sort: { field: "rank", order: "asc" }, limit: 4, cursor: sorted.nextCursor! }).start, 5, "an explicit default order is the same query");
    });

    it("refuses a malformed cursor with a message", () => {
        const idx = many(3);
        for (const cursor of ["not-a-cursor", Buffer.from('{"q":1}').toString("base64url"), Buffer.from("[]").toString("base64url")]) {
            assert.throws(() => runQuery(idx.queryRecords(), { cursor }), QueryError, cursor);
        }
    });

    it("a note added or removed between pages neither repeats nor skips the others", () => {
        const idx = many(10);
        const first = runQuery(idx.queryRecords(), { limit: 4 });
        assert.deepEqual(first.rows.map((r) => r.path), ["Notes/n000.md", "Notes/n001.md", "Notes/n002.md", "Notes/n003.md"]);
        idx.remove("Notes/n001.md"); // a row of the first page
        idx.remove("Notes/n003.md"); // the row the cursor points at
        idx.remove("Notes/n005.md"); // a row of the next page
        idx.update("Notes/n004b.md", "---\ntype: recipe\n---\n", T0 + 99); // sorts right after the cursor
        const second = runQuery(idx.queryRecords(), { limit: 4, cursor: first.nextCursor! });
        // An offset cursor ("skip 4") would skip n004 and show n004b, n006, n007, n008.
        assert.deepEqual(second.rows.map((r) => r.path), ["Notes/n004.md", "Notes/n004b.md", "Notes/n006.md", "Notes/n007.md"]);
        assert.equal(second.total, 8, "the total is counted again on every page");
        assert.equal(describeTotal(second).split(";").slice(0, 2).join(";"), "8 notes match; showing 3-6", "the position is recounted too");
    });

    it("a cursor past the last match says so", () => {
        const idx = many(5);
        const first = runQuery(idx.queryRecords(), { limit: 4 });
        idx.remove("Notes/n004.md");
        const second = runQuery(idx.queryRecords(), { limit: 4, cursor: first.nextCursor! });
        assert.equal(second.rows.length, 0);
        assert.equal(second.nextCursor, null);
        assert.equal(describeTotal(second), "4 notes match; showing none, the cursor is past the last match.");
    });

    it("defaults to 50 rows and refuses more than 500", () => {
        const idx = many(60);
        assert.equal(runQuery(idx.queryRecords(), {}).rows.length, 50);
        assert.throws(() => runQuery(idx.queryRecords(), { limit: 501 }), QueryError);
        assert.equal(runQuery(idx.queryRecords(), { limit: 500 }).rows.length, 60);
    });
});

describe("query_notes output", () => {
    it("the first line states the total and the rows shown", () => {
        const all = runQuery(vault().queryRecords(), {});
        assert.equal(describeTotal(all), "5 notes match; showing 1-5.");
        const one = runQuery(vault().queryRecords(), { where: [{ field: "type", op: "missing" }] });
        assert.equal(describeTotal(one), "1 note matches; showing 1-1.");
        const none = runQuery(vault().queryRecords(), { where: [{ field: "type", op: "eq", value: "poem" }] });
        assert.equal(describeTotal(none), "0 notes match.");
    });

    it("names a where-field that no note has when nothing matches", () => {
        const res = runQuery(vault().queryRecords(), { where: [{ field: "stauts", op: "eq", value: "draft" }] });
        assert.deepEqual(res.unknownFields, ["stauts"]);
    });

    it("selects title (frontmatter or file name) by default, and any field on request", () => {
        const res = runQuery(vault().queryRecords(), { where: [{ field: "folder", op: "eq", value: "Recipes" }] });
        assert.deepEqual(res.rows[0].values, { title: "Sourdough bread" });
        assert.deepEqual(res.rows[1].values, { title: "Soup" });
        const sel = runQuery(vault().queryRecords(), { select: ["status", "tags", "aliases", "mtime", "path"], where: [{ field: "path", op: "eq", value: "Recipes/Soup.md" }] });
        assert.deepEqual(sel.rows[0], {
            path: "Recipes/Soup.md",
            values: { status: "ready", tags: null, aliases: ["Winter soup", "Broth"], mtime: new Date(T0 + 4 * DAY).toISOString() },
        });
    });

    it("text rows are compact and cut long values with a marker", () => {
        const rows = describeRows([{ path: "a.md", values: { title: "A", aliases: ["x", "y"], status: null } }], (p) => `link:${p}`);
        assert.deepEqual(rows, ["- [a.md](link:a.md) · title: A · aliases: x, y · status: (missing)"]);
        const long = "word ".repeat(100);
        const shown = showValue(long);
        assert.equal(shown, long.trim().slice(0, QUERY_MAX_VALUE_CHARS) + `… [+${long.trim().length - QUERY_MAX_VALUE_CHARS} chars]`);
        assert.equal(showValue("two\n  lines"), "two lines");
    });

    it("format json carries total, shown, next_cursor and uncut rows", () => {
        const idx = vault();
        const long = "z".repeat(QUERY_MAX_VALUE_CHARS + 50);
        idx.update("Recipes/Long.md", `---\ntype: recipe\nsummary: ${long}\n---\n`, T0);
        const res = runQuery(idx.queryRecords(), { where: [{ field: "type", op: "eq", value: "recipe" }], select: ["summary", "status"], limit: 2 });
        const json = JSON.parse(toJson(res, { index: "ready", warnings: [] }));
        assert.equal(json.total, 3);
        assert.equal(json.shown, 2);
        assert.equal(json.start, 1);
        assert.equal(typeof json.next_cursor, "string");
        assert.deepEqual(json.rows[0], { path: "Recipes/Bread.md", summary: null, status: "draft" });
        assert.equal(json.rows[1].summary, long, "JSON values are never cut");
        const rest = JSON.parse(toJson(runQuery(idx.queryRecords(), { where: [{ field: "type", op: "eq", value: "recipe" }], select: ["summary"], limit: 2, cursor: json.next_cursor }), { index: "ready", warnings: [] }));
        assert.equal(rest.next_cursor, null);
        assert.equal(rest.start, 3);
        assert.deepEqual(rest.rows, [{ path: "Recipes/Soup.md", summary: null }]);
    });
});
