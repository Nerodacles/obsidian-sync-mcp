/**
 * Conflict surfacing in the tool layer, against an in-memory backend. The
 * CouchDB side (a real conflict made with new_edits=false, listed, shown and
 * resolved) is test/conflicts.e2e.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { registerTools } from "./tools.js";
import { makeDeepLink } from "./deeplink.js";
import { readOnlyVault } from "./vault-readonly.js";
// A namespace import, so a tree without these classes fails the tests that use them, not the whole file.
import * as backend from "./vault-backend.js";

const LINK = makeDeepLink("vault", "Notes/plan.md");
const NO_COUCHDB = "Conflicts exist only in CouchDB mode: this vault has no revisions, so a note can't have two live versions.";

function tools(vault: any, { readOnly = false, writeFolders = null as string | null, index = new SearchIndex() } = {}) {
    const registered: any[] = [];
    registerTools({ addTool: (t: any) => registered.push(t) } as any, vault, index, "vault", readOnly, writeFolders === null ? null : parseWriteFolders(writeFolders));
    const call = (name: string, args: any): Promise<string> => {
        const tool = registered.find((t) => t.name === name);
        assert.ok(tool, `${name} registered`);
        return tool.execute(tool.parameters.parse(args), {});
    };
    return { call, names: registered.map((t) => t.name) };
}

interface Leaf { revision: string; content: string | null; mtime: number; size: number; deleted: boolean }
const leaf = (revision: string, content: string | null, extra: Partial<Leaf> = {}): Leaf =>
    ({ revision, content, mtime: Date.UTC(2026, 0, 2, 3, 4, 5), size: content?.length ?? 0, deleted: false, ...extra });

/** In-memory CouchDB-mode backend: one note, a winner and any other live leaves. */
function conflictedVault(winner: Leaf, others: Leaf[] = []) {
    const calls: { resolve: any[] } = { resolve: [] };
    let resolveResult: any = null;
    let resolveError: Error | null = null;
    const vault = {
        calls,
        others,
        setResolve(result: any, error: Error | null = null) { resolveResult = result; resolveError = error; },
        readNote: async () => winner.content,
        readNoteRevision: async () => ({ content: winner.content!, revision: winner.revision, conflicts: others.map((o) => o.revision) }),
        getMetadata: async (path: string) => ({ path, size: 5, ctime: 0, mtime: 0, frontmatter: {}, tags: [], links: [], revision: winner.revision, conflicts: others.map((o) => o.revision) }),
        updateNote: async () => { throw new Error("not used"); },
        listConflicts: async (folder?: string) => ({
            conflicts: others.length && (!folder || "Notes/plan.md".startsWith(folder.replace(/\/?$/, "/"))) ? [{ path: "Notes/plan.md", revision: winner.revision, conflicts: others.map((o) => o.revision) }] : [],
            unreadable: 0,
        }),
        getConflict: async () => ({ path: "Notes/plan.md", winner, others }),
        resolveConflict: async (...args: any[]) => {
            calls.resolve.push(args);
            if (resolveError) throw resolveError;
            return resolveResult;
        },
    };
    return vault;
}

describe("CONFLICT line on read_note and get_note_metadata", () => {
    it("no conflict: today's answers byte for byte; a conflict adds exactly one leading line", async () => {
        const clean = tools(conflictedVault(leaf("3-b", "hello"))).call;
        const readClean = `[Open in Obsidian](${LINK})\nRevision: 3-b\n\n---\n\nhello`;
        const metaClean = `**Notes/plan.md**\nSize: 5 bytes\nCreated: 1970-01-01T00:00:00.000Z\nModified: 1970-01-01T00:00:00.000Z\nRevision: 3-b\n\n[Open in Obsidian](${LINK})`;
        assert.equal(await clean("read_note", { path: "Notes/plan.md" }), readClean);
        assert.equal(await clean("get_note_metadata", { path: "Notes/plan.md" }), metaClean);

        const one = tools(conflictedVault(leaf("3-b", "hello"), [leaf("3-a", "hi")])).call;
        assert.equal(await one("read_note", { path: "Notes/plan.md" }), `CONFLICT: 1 other live version of this note; see get_conflict.\n${readClean}`);
        assert.equal(await one("get_note_metadata", { path: "Notes/plan.md" }), `CONFLICT: 1 other live version of this note; see get_conflict.\n${metaClean}`);

        const two = tools(conflictedVault(leaf("3-b", "hello"), [leaf("3-a", "hi"), leaf("3-c", "hey")])).call;
        assert.equal(await two("read_note", { path: "Notes/plan.md" }), `CONFLICT: 2 other live versions of this note; see get_conflict.\n${readClean}`);
    });

    it("local mode: reads carry no CONFLICT line and the conflict tools say they need CouchDB", async () => {
        const root = await mkdtemp(join(tmpdir(), "conflicts-local-"));
        try {
            const vault = new LocalVault(root);
            await vault.writeNote("Notes/plan.md", "hello");
            const { call } = tools(vault);
            assert.equal(await call("read_note", { path: "Notes/plan.md" }), `[Open in Obsidian](${LINK})\n\n---\n\nhello`);
            assert.ok(!(await call("get_note_metadata", { path: "Notes/plan.md" })).includes("CONFLICT"));
            assert.equal(await call("list_conflicts", {}), NO_COUCHDB);
            assert.equal(await call("get_conflict", { path: "Notes/plan.md" }), NO_COUCHDB);
            assert.equal(await call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: "1-a,1-b", keep: "1-a" }), NO_COUCHDB);
            assert.equal(await vault.readNote("Notes/plan.md"), "hello");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("list_conflicts", () => {
    it("lists conflicted notes with counts and the winner, scoped by folder", async () => {
        const { call } = tools(conflictedVault(leaf("3-b", "x"), [leaf("3-a", "y"), leaf("3-c", "z")]));
        assert.equal(await call("list_conflicts", {}), `1 conflicted note:\n- [Notes/plan.md](${LINK}): 2 other live versions, winner 3-b`);
        assert.equal(await call("list_conflicts", { folder: "Notes" }), `1 conflicted note in Notes/:\n- [Notes/plan.md](${LINK}): 2 other live versions, winner 3-b`);
        assert.equal(await call("list_conflicts", { folder: "Other/" }), "No conflicted notes in Other/.");
    });

    it("says so when nothing is conflicted, and counts documents it could not read", async () => {
        const vault: any = conflictedVault(leaf("3-b", "x"));
        assert.equal(await tools(vault).call("list_conflicts", {}), "No conflicted notes.");
        vault.listConflicts = async () => ({ conflicts: [], unreadable: 2 });
        assert.equal(await tools(vault).call("list_conflicts", {}), "No conflicted notes.\n2 conflicted documents could not be read (path not decryptable) and are not listed.");
    });
});

describe("get_conflict", () => {
    it("shows the leaves line, the winner and a diff of each other version against it", async () => {
        const { call } = tools(conflictedVault(leaf("3-b", "# Plan\nshared\nhuman edit\nend\n"), [leaf("3-a", "# Plan\nshared\nagent edit\nend\n")]));
        assert.equal(await call("get_conflict", { path: "Notes/plan.md" }), [
            "Conflict: Notes/plan.md has 2 live versions.",
            "Leaves: 3-b,3-a",
            "Winner (what read_note shows): 3-b, modified 2026-01-02T03:04:05.000Z, 29 bytes",
            "",
            "Other version: 3-a, modified 2026-01-02T03:04:05.000Z, 29 bytes",
            "```diff",
            "--- 3-b (winner)",
            "+++ 3-a",
            "@@ -1,5 +1,5 @@",
            " # Plan",
            " shared",
            "-human edit",
            "+agent edit",
            " end",
            " ",
            "```",
            "",
            'To resolve: resolve_conflict with expected_leaves="3-b,3-a" and either keep="<revision>" (that version\'s text, unchanged) or content="<merged text>". Every other version is then deleted.',
            `[Open in Obsidian](${LINK})`,
        ].join("\n"));
    });

    it("marks deletions and unreadable versions instead of failing", async () => {
        const { call } = tools(conflictedVault(leaf("3-b", "x"), [leaf("3-a", "x", { deleted: true }), leaf("3-c", null)]));
        const answer = await call("get_conflict", { path: "Notes/plan.md" });
        assert.match(answer, /\nOther version: 3-a, modified [^\n]*; a deletion \(LiveSync marked the note deleted in this version\)\nSame text as the winner\.\n/);
        assert.match(answer, /\nOther version: 3-c, modified [^\n]*; its text could not be read\nNo diff: a version's text could not be read\.\n/);
    });

    it("bounds the diffs and offers the full text of one version", async () => {
        const big = (tag: string) => Array.from({ length: 5000 }, (_, i) => `${tag} line ${i}`).join("\n");
        const { call } = tools(conflictedVault(leaf("3-b", big("winner")), [leaf("3-a", big("other")), leaf("3-c", big("third"))]));
        const answer = await call("get_conflict", { path: "Notes/plan.md" });
        assert.ok(answer.length < 32_000, `${answer.length} chars`);
        assert.match(answer, /\n\d+ more diff lines not shown; get_conflict with revision="3-a" prints this version in full\.\n/);
        assert.match(answer, /\n\d+ more diff lines not shown; get_conflict with revision="3-c" prints this version in full\.\n/);
        const full = await call("get_conflict", { path: "Notes/plan.md", revision: "3-a" });
        assert.equal(full, `Version 3-a, modified 2026-01-02T03:04:05.000Z, ${big("other").length} bytes\n\n---\n\n${big("other")}`);
        assert.equal(await call("get_conflict", { path: "Notes/plan.md", revision: "9-z" }), "Notes/plan.md has no live version 9-z. Live versions: 3-b,3-a,3-c");
    });

    it("fences a diff whose text contains backticks with a longer fence", async () => {
        const { call } = tools(conflictedVault(leaf("3-b", "a\n```js\n"), [leaf("3-a", "b\n```js\n")]));
        assert.match(await call("get_conflict", { path: "Notes/plan.md" }), /\n````diff\n[\s\S]*\n````\n/);
    });

    it("no conflict and missing note", async () => {
        const vault: any = conflictedVault(leaf("3-b", "x"));
        assert.equal(await tools(vault).call("get_conflict", { path: "Notes/plan.md" }), "No conflict: Notes/plan.md has one live version (revision 3-b).");
        vault.getConflict = async () => null;
        assert.equal(await tools(vault).call("get_conflict", { path: "Notes/gone.md" }), "Note not found: Notes/gone.md");
    });
});

describe("resolve_conflict", () => {
    it("passes keep or content with the expected leaves, and reports the result", async () => {
        const vault = conflictedVault(leaf("3-b", "w"), [leaf("3-a", "o")]);
        const index = new SearchIndex();
        const { call } = tools(vault, { index });
        vault.setResolve({ revision: "4-n", content: "o", removed: ["3-a"], remaining: [] });
        assert.equal(await call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: " 3-b, 3-a ", keep: "3-a" }),
            `Conflict resolved: Notes/plan.md\nRevision: 4-n\nRemoved 1 other version: 3-a\n[Open in Obsidian](${LINK})`);
        assert.deepEqual(vault.calls.resolve[0], ["Notes/plan.md", ["3-b", "3-a"], { keep: "3-a" }]);
        assert.ok(index.listPaths().includes("Notes/plan.md"), "the surviving text is indexed");

        vault.setResolve({ revision: "4-m", content: "merged", removed: ["3-a"], remaining: [] });
        await call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: "3-b,3-a", content: "merged" });
        assert.deepEqual(vault.calls.resolve[1], ["Notes/plan.md", ["3-b", "3-a"], { content: "merged" }]);
    });

    it("refuses without calling the backend: both or neither of keep/content, keep outside the leaves", async () => {
        const vault = conflictedVault(leaf("3-b", "w"), [leaf("3-a", "o")]);
        const { call } = tools(vault);
        assert.equal(await call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: "3-b,3-a" }), "Give exactly one of keep or content. Nothing was written.");
        assert.equal(await call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: "3-b,3-a", keep: "3-a", content: "x" }), "Give exactly one of keep or content. Nothing was written.");
        assert.equal(await call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: "3-b,3-a", keep: "2-q" }), "keep must be one of the revisions in expected_leaves (3-b,3-a). Nothing was written.");
        assert.equal(vault.calls.resolve.length, 0);
    });

    it("leaves that changed since get_conflict: refused, nothing written", async () => {
        const vault = conflictedVault(leaf("3-b", "w"), [leaf("3-a", "o")]);
        vault.setResolve(null, new backend.ConflictChangedError("Notes/plan.md", ["3-b", "3-a"], ["3-b", "3-a", "3-c"]));
        assert.equal(await tools(vault).call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: "3-b,3-a", keep: "3-b" }),
            "The versions of Notes/plan.md changed since get_conflict: live now 3-b,3-a,3-c, not 3-b,3-a. Nothing was written; call get_conflict again.");
        vault.setResolve(null, new backend.ConflictLeafUnreadableError("Notes/plan.md", "3-a", "it is a deletion"));
        assert.equal(await tools(vault).call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: "3-b,3-a", keep: "3-a" }),
            "Version 3-a of Notes/plan.md can't be kept: it is a deletion. Nothing was written.");
    });

    it("a leaf that moved while resolving is reported as still live", async () => {
        const vault = conflictedVault(leaf("3-b", "w"), [leaf("3-a", "o"), leaf("3-c", "p")]);
        vault.setResolve({ revision: "3-b", content: null, removed: ["3-a"], remaining: ["4-c"] });
        assert.equal(await tools(vault).call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: "3-b,3-a,3-c", keep: "3-b" }),
            `Conflict partly resolved: Notes/plan.md\nRevision: 3-b\nRemoved 1 other version: 3-a\nStill live: 4-c (changed while resolving); call get_conflict again.\n[Open in Obsidian](${LINK})`);
    });

    it("needs update permission under WRITE_FOLDERS, checked before anything else", async () => {
        const vault = conflictedVault(leaf("3-b", "w"), [leaf("3-a", "o")]);
        const { call } = tools(vault, { writeFolders: "Notes:create" });
        assert.match(await call("resolve_conflict", { path: "Notes/plan.md", expected_leaves: "3-b,3-a", keep: "3-a" }), /allows only create, so 'Notes\/plan\.md' can't be changed/);
        assert.equal(vault.calls.resolve.length, 0);
    });

    it("READ_ONLY: resolve_conflict is not registered and the backend refuses it; list and get stay", async () => {
        const vault = conflictedVault(leaf("3-b", "w"), [leaf("3-a", "o")]);
        const wrapped = readOnlyVault(vault as any);
        const { names, call } = tools(wrapped, { readOnly: true });
        assert.ok(!names.includes("resolve_conflict"));
        assert.ok(names.includes("list_conflicts") && names.includes("get_conflict"));
        assert.match(await call("list_conflicts", {}), /^1 conflicted note:/);
        await assert.rejects(wrapped.resolveConflict!("Notes/plan.md", ["3-b", "3-a"], { keep: "3-a" }), /READ_ONLY/);
        assert.equal(vault.calls.resolve.length, 0);
    });
});
