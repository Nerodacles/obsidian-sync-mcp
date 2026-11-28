/**
 * READ_FOLDERS: the parser, the predicate, and every read path of the tools.
 *
 * Each tool test runs the same fixture twice: once with the scope (the hidden
 * note must not show) and once without it (the control: the same call must
 * show the hidden note, so the assertion would fail if the scope did nothing).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { registerTools } from "./tools.js";
import { registerAttachmentTools } from "./attachment-tools.js";
import { guardedVault, PluginWriteError, loadPlugins, trackToolNames } from "./plugins.js";
import { MemoryDocStore } from "./plugin-store.js";
import { copyFile } from "fs/promises";
import { UploadRegistry } from "./uploads.js";
import { memoryAttachments } from "./attachment-test-fixtures.js";
import { SUPPORTED_ATTACHMENT_EXTENSIONS } from "./attachment-path.js";
import { parseReadFolders, readScopeConflicts, readScopedVault, isReadable, visibleLinks, type ReadScope } from "./read-scope.js";
import type { VaultBackend } from "./vault-backend.js";

describe("parseReadFolders", () => {
    it("unset: the whole vault is readable", () => {
        assert.equal(parseReadFolders(undefined), null);
    });

    it("splits, trims and strips slashes", () => {
        assert.deepEqual(parseReadFolders(" Shared/ , /Projects/public,welcome.md "), ["Shared", "Projects/public", "welcome.md"]);
    });

    it("set but empty stops the server instead of showing the vault", () => {
        for (const raw of ["", "  ", ",", " , "]) {
            assert.throws(() => parseReadFolders(raw), /READ_FOLDERS is set but lists nothing/, JSON.stringify(raw));
        }
    });

    it("refuses '/', permissions, backslashes, traversal, duplicates and nested entries", () => {
        assert.throws(() => parseReadFolders("/"), /'\/' is the whole vault\. Unset READ_FOLDERS/);
        assert.throws(() => parseReadFolders("Shared,/"), /is the whole vault/);
        assert.throws(() => parseReadFolders("Shared:create"), /'Shared:create' has a ':'/);
        assert.throws(() => parseReadFolders("Shared\\sub"), /backslash/);
        assert.throws(() => parseReadFolders("Shared/../Private"), /'\.\.' folder segment/);
        assert.throws(() => parseReadFolders("Shared//sub"), /empty, '\.' or '\.\.' folder segment/);
        assert.throws(() => parseReadFolders("./Shared"), /folder segment/);
        assert.throws(() => parseReadFolders("Shared,Shared/"), /'Shared' is listed more than once/);
        assert.throws(() => parseReadFolders("Shared,shared"), /'shared' is listed more than once \(also as 'Shared'/);
        assert.throws(() => parseReadFolders("Shared,Shared/sub"), /'Shared\/sub' is inside 'Shared'/);
    });
});

describe("isReadable", () => {
    const scope = parseReadFolders("Shared,Projects/public,welcome.md");

    it("unset scope: everything", () => {
        assert.equal(isReadable("Private/a.md", null), true);
    });

    it("a folder entry covers its subtree, on folder boundaries", () => {
        assert.equal(isReadable("Shared/a.md", scope), true);
        assert.equal(isReadable("Shared/deep/er/a.md", scope), true);
        assert.equal(isReadable("Shared", scope), true);
        assert.equal(isReadable("Shared/", scope), true);
        assert.equal(isReadable("Shared-private/a.md", scope), false);
        assert.equal(isReadable("Projects/public/a.md", scope), true);
        assert.equal(isReadable("Projects/a.md", scope), false);
    });

    it("root notes are hidden unless listed one by one", () => {
        assert.equal(isReadable("welcome.md", scope), true);
        assert.equal(isReadable("other.md", scope), false);
    });

    it("spellings the backends resolve to the same path are judged as that path", () => {
        assert.equal(isReadable("Shared\\a.md", scope), true);
        assert.equal(isReadable("/Shared//a.md", scope), true);
        assert.equal(isReadable("Shared/./a.md", scope), true);
        assert.equal(isReadable("Shared/../Private/a.md", scope), false, "traversal is never readable");
        assert.equal(isReadable("Shared\\..\\Private\\a.md", scope), false);
    });

    it("a case variant of a listed folder is hidden (the fail-closed side)", () => {
        assert.equal(isReadable("shared/a.md", scope), false);
    });
});

describe("readScopeConflicts", () => {
    const scope = parseReadFolders("Shared,Projects/public");

    it("a WRITE_FOLDERS folder outside the read scope would be named in descriptions: refused", () => {
        assert.deepEqual(readScopeConflicts(scope, parseWriteFolders("Shared:create,Private"), []), [
            "WRITE_FOLDERS: 'Private' is outside READ_FOLDERS, so it can't be written; add it to READ_FOLDERS or remove it.",
        ]);
    });

    it("the root rule and ancestors of a readable folder are fine", () => {
        assert.deepEqual(readScopeConflicts(scope, parseWriteFolders("/,Projects:create,Shared/sub"), []), []);
    });

    it("a SEARCH_DEFAULT_EXCLUDE folder outside the read scope is refused too", () => {
        assert.deepEqual(readScopeConflicts(scope, null, ["Shared/old", "Archive"]), [
            "SEARCH_DEFAULT_EXCLUDE: 'Archive' is outside READ_FOLDERS, so search never sees it; remove it.",
        ]);
    });

    it("unset READ_FOLDERS checks nothing", () => {
        assert.deepEqual(readScopeConflicts(null, parseWriteFolders("Private"), ["Archive"]), []);
    });
});

describe("visibleLinks", () => {
    it("drops path links into hidden folders, existing or not; keeps bare names", () => {
        const scope = parseReadFolders("Shared");
        const links = ["Shared/b", "Private/plan", "Private/missing.md", "plan", "shot.png"];
        assert.deepEqual(visibleLinks(links, scope), ["Shared/b", "plan", "shot.png"]);
        assert.deepEqual(visibleLinks(links, null), links);
    });
});

// --- The tools, against a local vault holding one shared and one private corner ---

const SHARED_A = [
    "---",
    "status: open",
    "tags: [team]",
    "---",
    "Alpha note about the launch codeword.",
    "See [[Private/plan]], [[Shared/b]] and [[plan]].",
    "",
].join("\n");
const SHARED_B = "Bravo. #team\n";
const PRIVATE_PLAN = [
    "---",
    "status: open",
    "aliases: [Masterplan]",
    "tags: [team, secretive]",
    "---",
    "The launch codeword is here. Links [[Shared/a]] and [[Shared/b]].",
    "",
].join("\n");
const WELCOME = "Root welcome, launch codeword.\n";

const NOTES: Record<string, string> = {
    "Shared/a.md": SHARED_A,
    "Shared/b.md": SHARED_B,
    "Private/plan.md": PRIVATE_PLAN,
    "welcome.md": WELCOME,
};
const SCOPE = "Shared";

describe("READ_FOLDERS on every read path", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "read-scope-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /**
     * Wired as main.ts wires it: the backend wrapped, the index restricted,
     * then every note fed to the index from the UNWRAPPED backend, so the
     * index's own gate is what keeps hidden notes out.
     */
    async function setup(readFolders: string | null, writeFolders: string | null = null, { feed = true } = {}) {
        const root = await mkdtemp(join(dir, "v-"));
        const local = new LocalVault(root);
        for (const [path, content] of Object.entries(NOTES)) await local.writeNote(path, content);
        const scope: ReadScope = readFolders === null ? null : parseReadFolders(readFolders);
        const vault: VaultBackend = scope ? readScopedVault(local, scope) : local;
        const searchIndex = new SearchIndex();
        if (scope) searchIndex.restrictTo((p) => isReadable(p, scope));
        let t = 1000;
        if (feed) for (const [path, content] of Object.entries(NOTES)) searchIndex.update(path, content, t++);
        searchIndex.state = "ready";
        const tools: any[] = [];
        registerTools({ addTool: (tool: any) => tools.push(tool) } as any, vault, searchIndex, "vault", false,
            writeFolders === null ? null : parseWriteFolders(writeFolders), undefined, undefined, [], scope);
        const call = (name: string, args: any): Promise<string> => {
            const tool = tools.find((x) => x.name === name);
            assert.ok(tool, `${name} registered`);
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { local, vault, searchIndex, call };
    }

    it("read_note: a hidden note answers exactly like a missing one", async () => {
        const scoped = await setup(SCOPE);
        assert.equal(await scoped.call("read_note", { path: "Private/plan.md" }), "Note not found: Private/plan.md");
        assert.equal(await scoped.call("read_note", { path: "Private/nothing.md" }), "Note not found: Private/nothing.md");
        assert.equal(await scoped.call("read_note", { path: "welcome.md" }), "Note not found: welcome.md");
        assert.match(await scoped.call("read_note", { path: "Shared/a.md" }), /Alpha note/);
        const control = await setup(null);
        assert.match(await control.call("read_note", { path: "Private/plan.md" }), /The launch codeword is here/);
    });

    it("read_note: the 'Did you mean' list never names a hidden note, by file name or alias", async () => {
        const scoped = await setup(SCOPE);
        assert.equal(await scoped.call("read_note", { path: "Other/plan.md" }), "Note not found: Other/plan.md");
        assert.equal(await scoped.call("read_note", { path: "Masterplan.md" }), "Note not found: Masterplan.md");
        const control = await setup(null);
        assert.match(await control.call("read_note", { path: "Other/plan.md" }), /Did you mean:\n- Private\/plan\.md \(same file name\)/);
        assert.match(await control.call("read_note", { path: "Masterplan.md" }), /- Private\/plan\.md \(alias "Masterplan"\)/);
    });

    it("list_notes: hidden folders and root notes are left out, also when asked by folder", async () => {
        const scoped = await setup(SCOPE);
        const all = await scoped.call("list_notes", {});
        assert.match(all, /Shared\/a\.md/);
        assert.doesNotMatch(all, /Private|welcome/);
        const missingFolder = await scoped.call("list_notes", { folder: "Nowhere" });
        assert.equal((await scoped.call("list_notes", { folder: "Private" })).replaceAll("Private", "Nowhere"), missingFolder);
        const control = await setup(null);
        assert.match(await control.call("list_notes", {}), /Private\/plan\.md/);
    });

    it("list_notes and list_folders: the vault fallback (an empty index) is filtered too", async () => {
        const scoped = await setup(SCOPE, null, { feed: false });
        const notes = await scoped.call("list_notes", {});
        assert.match(notes, /Shared\/a\.md/, "answered by the vault, not the empty index");
        assert.doesNotMatch(notes, /Private|welcome/);
        const folders = await scoped.call("list_folders", {});
        assert.match(folders, /Shared/);
        assert.doesNotMatch(folders, /Private|root/);
        const control = await setup(null, null, { feed: false });
        assert.match(await control.call("list_notes", {}), /Private\/plan\.md/);
        assert.match(await control.call("list_folders", {}), /Private/);
    });

    it("list_folders: no hidden folder", async () => {
        const scoped = await setup(SCOPE);
        const folders = await scoped.call("list_folders", {});
        assert.match(folders, /Shared/);
        assert.doesNotMatch(folders, /Private/);
        const control = await setup(null);
        assert.match(await control.call("list_folders", {}), /Private/);
    });

    it("list_tags: counts come from visible notes only, and hidden-only tags vanish", async () => {
        const scoped = await setup(SCOPE);
        const tags = await scoped.call("list_tags", {});
        assert.match(tags, /#team \(2 notes\)/);
        assert.doesNotMatch(tags, /secretive/);
        const control = await setup(null);
        const all = await control.call("list_tags", {});
        assert.match(all, /#team \(3 notes\)/);
        assert.match(all, /secretive/);
    });

    it("search_notes: content hits, name ranking and the status line see visible notes only", async () => {
        const scoped = await setup(SCOPE);
        // Hit lines only: a visible note's snippet may quote its own link to a hidden note.
        const hitLines = (s: string) => s.split("\n").filter((l) => l.startsWith("- ")).join("\n");
        const hits = await scoped.call("search_notes", { terms: ["codeword"] });
        assert.match(hitLines(hits), /Shared\/a\.md/);
        assert.doesNotMatch(hitLines(hits), /Private|welcome/);
        assert.match(hits, /^1 note matches "codeword"/m);
        assert.doesNotMatch(hitLines(await scoped.call("search_notes", { terms: ["plan"] })), /Private\/plan/);
        assert.match(await scoped.call("search_notes", { terms: ["Masterplan"] }), /^No notes match "Masterplan"\./m);
        const status = (s: string) => s.split("\n").find((l) => /notes? indexed|Index/.test(l)) ?? "";
        assert.match(status(hits), /2 of 2 notes with content/, `status line: ${status(hits)}`);
        const control = await setup(null);
        const all = await control.call("search_notes", { terms: ["codeword"] });
        assert.match(hitLines(all), /Private\/plan\.md/);
        assert.match(hitLines(all), /welcome\.md/);
        assert.match(status(all), /4 of 4 notes with content/);
        assert.match(hitLines(await control.call("search_notes", { terms: ["Masterplan"] })), /Private\/plan\.md/);
    });

    it("query_notes: hidden notes are neither returned nor counted", async () => {
        const scoped = await setup(SCOPE);
        const where = [{ field: "status", op: "eq", value: "open" }];
        const res = JSON.parse(await scoped.call("query_notes", { where, format: "json" }));
        assert.deepEqual(res.rows.map((n: any) => n.path), ["Shared/a.md"]);
        assert.equal(res.total, 1);
        const control = await setup(null);
        const all = JSON.parse(await control.call("query_notes", { where, format: "json" }));
        assert.equal(all.total, 2);
    });

    it("get_note_metadata: hidden backlinks and path links are omitted; a hidden note is not found", async () => {
        const scoped = await setup(SCOPE);
        const meta = await scoped.call("get_note_metadata", { path: "Shared/a.md" });
        assert.match(meta, /Outgoing links: Shared\/b, plan$/m);
        assert.doesNotMatch(meta, /Private/);
        assert.doesNotMatch(await scoped.call("get_note_metadata", { path: "Shared/b.md" }), /Backlinks:.*Private/);
        assert.equal(await scoped.call("get_note_metadata", { path: "Private/plan.md" }), "Note not found: Private/plan.md");
        const control = await setup(null);
        assert.match(await control.call("get_note_metadata", { path: "Shared/a.md" }), /Outgoing links: Private\/plan, Shared\/b, plan/);
        assert.match(await control.call("get_note_metadata", { path: "Shared/b.md" }), /Backlinks: .*Private\/plan\.md/);
    });

    it("rename_note: a hidden linker is neither rewritten nor named", async () => {
        const scoped = await setup(SCOPE);
        const answer = await scoped.call("rename_note", { from: "Shared/a.md", to: "Shared/a2.md" });
        assert.match(answer, /Shared\/a2\.md/);
        assert.doesNotMatch(answer, /Private/);
        assert.equal(await scoped.local.readNote("Private/plan.md"), PRIVATE_PLAN);
        const control = await setup(null);
        const all = await control.call("rename_note", { from: "Shared/a.md", to: "Shared/a2.md" });
        assert.match(all, /Private\/plan\.md/);
        assert.match((await control.local.readNote("Private/plan.md"))!, /\[\[Shared\/a2\]\]/);
    });

    it("delete_note: a hidden linker is neither unlinked nor named", async () => {
        const scoped = await setup(SCOPE);
        const answer = await scoped.call("delete_note", { path: "Shared/b.md" });
        assert.doesNotMatch(answer, /Private/);
        assert.match(answer, /Shared\/a\.md/, "the visible linker is still reported");
        assert.equal(await scoped.local.readNote("Private/plan.md"), PRIVATE_PLAN);
        const control = await setup(null);
        assert.match(await control.call("delete_note", { path: "Shared/b.md" }), /Private\/plan\.md/);
        assert.notEqual(await control.local.readNote("Private/plan.md"), PRIVATE_PLAN);
    });

    it("every write tool refuses a hidden path the same way whether or not a note is there", async () => {
        const { call, local } = await setup(SCOPE);
        const refusal = (p: string) => `Write access denied: '${p}' is outside the folders this server can read (Shared).`;
        const cases: Array<[string, (p: string) => any]> = [
            ["write_note", (p) => ({ path: p, content: "x" })],
            ["write_note", (p) => ({ path: p, content: "x", create_only: true })],
            ["edit_note", (p) => ({ path: p, content: "x" })],
            ["set_properties", (p) => ({ path: p, set: { a: "b" } })],
            ["append_to_section", (p) => ({ path: p, heading: "Log", line: "x" })],
            ["delete_note", (p) => ({ path: p })],
            ["move_note", (p) => ({ from: p, to: "Shared/moved.md" })],
            ["rename_note", (p) => ({ from: p, to: "Shared/moved.md" })],
            ["resolve_conflict", (p) => ({ path: p, expected_leaves: "1-a,2-b", keep: "1-a" })],
        ];
        for (const [name, args] of cases) {
            for (const p of ["Private/plan.md", "Private/nothing.md"]) {
                assert.equal(await call(name, args(p)), refusal(p), `${name} ${p}`);
            }
        }
        // A hidden destination, existing or not.
        for (const p of ["Private/plan.md", "Private/nothing.md"]) {
            assert.equal(await call("move_note", { from: "Shared/b.md", to: p }), refusal(p));
            assert.equal(await call("rename_note", { from: "Shared/b.md", to: p }), refusal(p));
        }
        assert.equal(await local.readNote("Private/plan.md"), PRIVATE_PLAN);
        assert.equal(await local.readNote("Private/nothing.md"), null);
        assert.equal(await local.readNote("Shared/b.md"), SHARED_B);
    });

    it("the read refusal comes before WRITE_FOLDERS, so it never names a write rule", async () => {
        const { call } = await setup(SCOPE, "/,Shared:create");
        assert.equal(await call("write_note", { path: "Private/plan.md", content: "x" }),
            "Write access denied: 'Private/plan.md' is outside the folders this server can read (Shared).");
        assert.match(await call("write_note", { path: "Shared/a.md", content: "x" }), /Shared\/ allows only create/);
    });
});

describe("READ_FOLDERS on conflicts (CouchDB-mode backend)", () => {
    const leaf = (revision: string, content: string) => ({ revision, content, mtime: 1, size: content.length, deleted: false });
    const conflicted = new Set(["Shared/a.md", "Private/plan.md"]);
    const fake = {
        readNote: async () => null,
        getMetadata: async () => null,
        listConflicts: async () => ({
            conflicts: [...conflicted].map((path) => ({ path, revision: "2-w", conflicts: ["2-o"] })),
            unreadable: 0,
        }),
        getConflict: async (path: string) => (conflicted.has(path) ? { path, winner: leaf("2-w", "w"), others: [leaf("2-o", "o")] } : null),
    } as unknown as VaultBackend;

    function tools(scope: ReadScope) {
        const registered: any[] = [];
        registerTools({ addTool: (t: any) => registered.push(t) } as any, scope ? readScopedVault(fake, scope) : fake, new SearchIndex(), "vault",
            false, null, undefined, undefined, [], scope);
        return (name: string, args: any): Promise<string> => {
            const tool = registered.find((t) => t.name === name);
            return tool.execute(tool.parameters.parse(args), {});
        };
    }

    it("list_conflicts lists only visible notes", async () => {
        const scoped = await tools(parseReadFolders(SCOPE))("list_conflicts", {});
        assert.match(scoped, /^1 conflicted note:/);
        assert.doesNotMatch(scoped, /Private/);
        assert.match(await tools(null)("list_conflicts", {}), /2 conflicted notes:[\s\S]*Private\/plan\.md/);
    });

    it("get_conflict on a hidden note answers like a missing one", async () => {
        const call = tools(parseReadFolders(SCOPE));
        assert.equal(await call("get_conflict", { path: "Private/plan.md" }), "Note not found: Private/plan.md");
        assert.equal(await call("get_conflict", { path: "Private/nothing.md" }), "Note not found: Private/nothing.md");
        assert.match(await tools(null)("get_conflict", { path: "Private/plan.md" }), /Conflict: Private\/plan\.md has 2 live versions/);
    });
});

describe("readScopedVault: change feed, listings and the write backstop", () => {
    function fakeFeed() {
        const writes: string[] = [];
        const backend = {
            init: async () => {},
            close: async () => {},
            readNote: async () => "text",
            readNoteRevision: async () => ({ content: "text", revision: "1-a" }),
            getMetadata: async (path: string) => ({ path, size: 1, ctime: 0, mtime: 0, frontmatter: {}, tags: [], links: [], aliases: [], properties: {} }),
            listNotes: async () => ["Shared/a.md", "Private/plan.md", "welcome.md"],
            listNotesWithMtime: async () => [{ path: "Shared/a.md", mtime: 1 }, { path: "Private/plan.md", mtime: 1 }],
            getAttachmentInfo: async (path: string) => ({ path, size: 1, ctime: 0, mtime: 0 }),
            listAttachments: async () => [{ path: "Shared/x.png", size: 1, ctime: 0, mtime: 0 }, { path: "Private/y.png", size: 1, ctime: 0, mtime: 0 }],
            catchUp: async (_since: string, cb: any, _onBatch: any, _stats: any, onAtt: any) => {
                cb("Shared/a.md", "a", 1);
                cb("Private/plan.md", "p", 1);
                cb("Private/gone.md", null);
                onAtt?.("Private/y.png", { size: 1, mtime: 1 });
                onAtt?.("Shared/x.png", { size: 1, mtime: 1 });
                return "9";
            },
            watchChanges: (cb: any, onAtt: any) => {
                cb("Private/plan.md", "p", 1, "10");
                cb("Shared/a.md", "a", 1, "11");
                onAtt?.("Private/y.png", null);
            },
            writeNote: async (p: string) => { writes.push(p); return true; },
            deleteNote: async (p: string) => { writes.push(p); return true; },
            moveNote: async (f: string, t: string) => { writes.push(`${f}>${t}`); return true; },
            writeAttachment: async (p: string) => { writes.push(p); return true; },
            deleteAttachment: async (p: string) => { writes.push(p); return true; },
            moveAttachment: async (f: string, t: string) => { writes.push(`${f}>${t}`); return true; },
        } as unknown as VaultBackend;
        return { backend, writes };
    }
    const scope = parseReadFolders(SCOPE)!;

    it("catchUp and watchChanges deliver visible changes only, attachments included", async () => {
        const { backend } = fakeFeed();
        const seen: string[] = [];
        const v = readScopedVault(backend, scope);
        assert.equal(await v.catchUp!("0", (p) => { seen.push(p); }, undefined, undefined, (p) => { seen.push(`att:${p}`); }), "9");
        v.watchChanges!((p, _c, _m, seq) => { seen.push(`${p}@${seq}`); }, (p) => { seen.push(`att:${p}`); });
        assert.deepEqual(seen, ["Shared/a.md", "att:Shared/x.png", "Shared/a.md@11"]);
        const raw: string[] = [];
        await backend.catchUp!("0", (p) => { raw.push(p); });
        assert.ok(raw.includes("Private/plan.md"), "control: the fake feed does carry the hidden note");
    });

    it("reads of hidden paths return null without asking the backend; listings are filtered", async () => {
        const v = readScopedVault(fakeFeed().backend, scope);
        assert.equal(await v.readNote("Private/plan.md"), null);
        assert.equal(await v.readNoteRevision!("Private/plan.md"), null);
        assert.equal(await v.getMetadata("Private/plan.md"), null);
        assert.equal(await v.getAttachmentInfo("Private/y.png"), null);
        assert.equal(await v.readNote("Shared/a.md"), "text");
        assert.deepEqual(await v.listNotes(), ["Shared/a.md"]);
        assert.deepEqual((await v.listNotesWithMtime()).map((n) => n.path), ["Shared/a.md"]);
        assert.deepEqual((await v.listAttachments!()).map((a) => a.path), ["Shared/x.png"]);
    });

    it("every write to a hidden path throws before reaching the backend", async () => {
        const { backend, writes } = fakeFeed();
        const v = readScopedVault(backend, scope);
        await assert.rejects(v.writeNote("Private/a.md", "x"), /outside the folders this server can read/);
        await assert.rejects(v.deleteNote("Private/plan.md"), /outside the folders/);
        await assert.rejects(v.moveNote("Shared/a.md", "Private/a.md"), /outside the folders/);
        await assert.rejects(v.moveNote("Private/plan.md", "Shared/a.md"), /outside the folders/);
        await assert.rejects(v.writeAttachment("Private/z.png", new Uint8Array([1])), /outside the folders/);
        await assert.rejects(v.deleteAttachment("Private/y.png"), /outside the folders/);
        await assert.rejects(v.moveAttachment("Private/y.png", "Shared/y.png"), /outside the folders/);
        assert.deepEqual(writes, []);
        assert.equal(await v.writeNote("Shared/c.md", "x"), true);
        assert.deepEqual(writes, ["Shared/c.md"]);
    });
});

describe("SearchIndex.restrictTo", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "read-scope-index-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("a persisted index from an unscoped run loses its hidden notes and attachments on load", async () => {
        const file = join(dir, "index.json");
        const full = new SearchIndex(file);
        for (const [path, content] of Object.entries(NOTES)) full.update(path, content, 1);
        full.updateAttachment("Private/y.png", 1, 1);
        full.updateAttachment("Shared/x.png", 1, 1);
        await full.saveToDisk();

        const scope = parseReadFolders(SCOPE);
        const scoped = new SearchIndex(file);
        scoped.restrictTo((p) => isReadable(p, scope));
        await scoped.loadFromDisk();
        assert.deepEqual(scoped.listPaths(), ["Shared/a.md", "Shared/b.md"]);
        assert.deepEqual(scoped.getBacklinks("Shared/b.md"), ["Shared/a.md"]);
        assert.deepEqual(scoped.listAttachments().map((a) => a.path), ["Shared/x.png"]);
        assert.equal(scoped.listAllTags().find((t) => t.tag === "secretive"), undefined);
        assert.deepEqual(scoped.suggestByName("Other/plan.md"), []);

        const control = new SearchIndex(file);
        await control.loadFromDisk();
        assert.ok(control.listPaths().includes("Private/plan.md"));
        assert.ok(control.getBacklinks("Shared/b.md").includes("Private/plan.md"));
    });

    it("restricting an index that already holds notes drops them, and later updates are ignored", () => {
        const index = new SearchIndex();
        for (const [path, content] of Object.entries(NOTES)) index.update(path, content, 1);
        const scope = parseReadFolders(SCOPE);
        index.restrictTo((p) => isReadable(p, scope));
        assert.deepEqual(index.listPaths(), ["Shared/a.md", "Shared/b.md"]);
        index.update("Private/new.md", "launch codeword", 2);
        index.updateAttachment("Private/z.png", 1, 1);
        index.replaceAttachments([{ path: "Private/q.png", size: 1, mtime: 1 }]);
        assert.deepEqual(index.listPaths(), ["Shared/a.md", "Shared/b.md"]);
        assert.equal(index.attachmentCount, 0);
        assert.deepEqual(index.search({ terms: ["codeword"] }).hits.map((h) => h.path), ["Shared/a.md"]);
    });
});

describe("READ_FOLDERS for plugins and attachments", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "read-scope-plugin-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("ctx.vault reads see visible notes only, and writes to hidden paths are denied", async () => {
        const local = new LocalVault(await mkdtemp(join(dir, "v-")));
        for (const [path, content] of Object.entries(NOTES)) await local.writeNote(path, content);
        const scope = parseReadFolders(SCOPE);
        const index = new SearchIndex();
        index.restrictTo((p) => isReadable(p, scope));
        const ctxVault = guardedVault(readScopedVault(local, scope!), index, null, false, scope);
        assert.equal(await ctxVault.readNote("Private/plan.md"), null);
        assert.equal(await ctxVault.getMetadata("Private/plan.md"), null);
        assert.deepEqual((await ctxVault.listNotes()).sort(), ["Shared/a.md", "Shared/b.md"]);
        for (const p of ["Private/plan.md", "Private/new.md"]) {
            await assert.rejects(ctxVault.writeNote(p, "x", { createOnly: true }),
                (err: unknown) => err instanceof PluginWriteError && err.code === "denied" && /outside the folders this server can read/.test(err.message));
        }
        assert.equal(await local.readNote("Private/new.md"), null);

        const control = guardedVault(local, new SearchIndex(), null, false);
        assert.match((await control.readNote("Private/plan.md"))!, /codeword/);
    });

    it("the example new_item plugin: a hidden item folder refuses the create with the read-scope answer", async () => {
        const run = async (readFolders: string | null) => {
            const local = new LocalVault(await mkdtemp(join(dir, "v-")));
            await local.writeNote("Shared/a.md", SHARED_A);
            const pluginDir = await mkdtemp(join(dir, "p-"));
            await copyFile(new URL("../examples/new-item.mjs", import.meta.url), join(pluginDir, "new-item.mjs"));
            const scope = readFolders === null ? null : parseReadFolders(readFolders);
            const vault = scope ? readScopedVault(local, scope) : local;
            const index = new SearchIndex();
            if (scope) index.restrictTo((p) => isReadable(p, scope));
            const tools: any[] = [];
            const server = { addTool: (t: any) => { tools.push(t); } };
            const toolNames = trackToolNames(server);
            registerTools(server as any, vault, index, "V", false, null, undefined, undefined, [], scope);
            const docs = new MemoryDocStore();
            const log = console.log;
            console.log = () => {};
            try {
                await loadPlugins(pluginDir, { server, toolNames, vault, searchIndex: index, vaultName: "V", readOnly: false, writeFolders: null, readFolders: scope, store: docs });
            } finally {
                console.log = log;
            }
            const tool = tools.find((t) => t.name === "new_item");
            const answer: string = await tool.execute(tool.parameters.parse({ title: "x" }), {});
            const all = await local.listNotes();
            return { answer, created: all.filter((p) => p !== "Shared/a.md"), counter: docs.docs.get("plugin:new-item.mjs:counter")?.value };
        };
        const scoped = await run(SCOPE);
        assert.match(scoped.answer, /^Write access denied: '[^']+' is outside the folders this server can read \(Shared\)\./);
        assert.deepEqual(scoped.created, []);
        // Measured, not a design choice of this change: the plugin reserves its number before
        // the create, so each refused call on a scoped server still uses one number.
        assert.match(scoped.answer, /was reserved and stays unused\.$/);
        assert.equal(scoped.counter, 1);
        const control = await run(null);
        assert.match(control.answer, /^Created /);
        assert.equal(control.created.length, 1);
    });

    it("get_attachment_metadata on a hidden attachment answers like a missing one; uploads there are refused", async () => {
        const run = async (scope: ReadScope) => {
            const { vault, files } = memoryAttachments();
            files.set("Private/y.png", { data: new Uint8Array(3), ctime: 1, mtime: 2 });
            const tools: any[] = [];
            registerAttachmentTools({ addTool: (t: any) => tools.push(t) } as any, {
                vault: scope ? readScopedVault(vault as VaultBackend, scope) : vault,
                searchIndex: new SearchIndex(),
                vaultName: "V",
                readOnly: false,
                writeFolders: null,
                readFolders: scope,
                allowedExtensions: new Set(SUPPORTED_ATTACHMENT_EXTENSIONS),
                maxBytes: 1000,
                base64MaxBytes: 10,
                registry: new UploadRegistry(),
                baseUrl: "https://mcp.example.com/",
            });
            return (name: string, args: any): Promise<string> => {
                const tool = tools.find((t) => t.name === name);
                return tool.execute(tool.parameters.parse(args));
            };
        };
        const scoped = await run(parseReadFolders(SCOPE));
        assert.equal(await scoped("get_attachment_metadata", { path: "Private/y.png" }), await scoped("get_attachment_metadata", { path: "Private/n.png" }).then((s) => s.replace("n.png", "y.png")));
        assert.match(await scoped("create_attachment_upload", { path: "Private/n.png" }), /outside the folders this server can read/);
        const control = await run(null);
        assert.match(await control("get_attachment_metadata", { path: "Private/y.png" }), /3 B|3 bytes/);
    });
});
