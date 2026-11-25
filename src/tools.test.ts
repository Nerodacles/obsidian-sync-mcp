import { test, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { registerTools, READ_NOTE_MAX_RESULT_SIZE_CHARS, SEARCH_MAX_TERMS, SEARCH_MAX_TERM_LENGTH, cleanSearchTerms, EDIT_MAX_ATTEMPTS, NO_REVISIONS_MESSAGE, NO_OP_STORE_MESSAGE } from "./tools.js";
import { MemoryOpStore, fingerprint } from "./op-store.js";
import { RevisionMismatchError, UpdateRetriesExhaustedError } from "./vault-backend.js";

function captureTools(): { name: string; _meta?: Record<string, unknown> }[] {
    const tools: { name: string; _meta?: Record<string, unknown> }[] = [];
    const server = { addTool: (tool: { name: string; _meta?: Record<string, unknown> }) => tools.push(tool) };
    registerTools(server as any, {} as any, {} as any, "vault");
    return tools;
}

test("read_note declares anthropic/maxResultSizeChars so Claude Code returns whole notes inline", () => {
    const readNote = captureTools().find((t) => t.name === "read_note");
    assert.ok(readNote, "read_note registered");
    assert.equal(readNote._meta?.["anthropic/maxResultSizeChars"], READ_NOTE_MAX_RESULT_SIZE_CHARS);
    assert.ok(READ_NOTE_MAX_RESULT_SIZE_CHARS > 50_000 && READ_NOTE_MAX_RESULT_SIZE_CHARS <= 500_000);
});

test("no other tool carries the annotation", () => {
    for (const tool of captureTools().filter((t) => t.name !== "read_note")) {
        assert.equal(tool._meta, undefined, `${tool.name} should not declare _meta`);
    }
});

test("search_notes is registered with a whole first sentence under 75 characters", () => {
    const tool = captureTools().find((t) => t.name === "search_notes") as any;
    assert.ok(tool, "search_notes registered");
    const firstLine = String(tool.description).split("\n")[0];
    assert.ok(firstLine.length < 75, `first line is ${firstLine.length} chars`);
    assert.ok(firstLine.endsWith("."), "first line ends with a period");
    assert.equal(tool._meta, undefined);
});

test("search_notes rejects more than SEARCH_MAX_TERMS terms at the schema", () => {
    const tool = captureTools().find((t) => t.name === "search_notes") as any;
    const terms = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    assert.equal(tool.parameters.safeParse({ terms: terms(SEARCH_MAX_TERMS) }).success, true);
    assert.equal(tool.parameters.safeParse({ terms: terms(SEARCH_MAX_TERMS + 1) }).success, false);
});

test("search_notes rejects a term longer than SEARCH_MAX_TERM_LENGTH at the schema", () => {
    const tool = captureTools().find((t) => t.name === "search_notes") as any;
    const term = (n: number) => "x".repeat(n);
    assert.equal(tool.parameters.safeParse({ terms: [term(SEARCH_MAX_TERM_LENGTH)] }).success, true);
    assert.equal(tool.parameters.safeParse({ terms: ["ok", term(SEARCH_MAX_TERM_LENGTH + 1)] }).success, false);
    assert.equal(tool.parameters.safeParse({ terms: [term(10_000)] }).success, false);
});

test("cleanSearchTerms cuts each term to SEARCH_MAX_TERM_LENGTH", () => {
    const clean = cleanSearchTerms([" " + "y".repeat(5_000_000) + " ", "short"]);
    assert.equal(clean.length, 2);
    assert.equal(clean[0].length, SEARCH_MAX_TERM_LENGTH);
    assert.equal(clean[1], "short");
});

test("cleanSearchTerms trims, drops empty terms and clamps to SEARCH_MAX_TERMS", () => {
    assert.deepEqual(cleanSearchTerms(undefined), []);
    assert.deepEqual(cleanSearchTerms([" a ", "", "  ", "b"]), ["a", "b"]);
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const clean = cleanSearchTerms(["", ...many]);
    assert.equal(clean.length, SEARCH_MAX_TERMS);
    assert.equal(clean[0], "t0", "empty terms are dropped before clamping");
});

describe("WRITE_FOLDERS permissions on note tools", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "tools-scope-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function setup(writeFolders: string) {
        const root = await mkdtemp(join(dir, "v-"));
        const vault = new LocalVault(root);
        const searchIndex = new SearchIndex();
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, searchIndex, "vault", false, parseWriteFolders(writeFolders));
        const call = (name: string, args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === name);
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { vault, call, tools };
    }

    it("create-only: write_note creates new notes but never overwrites", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        assert.match(await call("write_note", { path: "Raw/a.md", content: "v1" }), /Note saved: Raw\/a.md/);
        const again = await call("write_note", { path: "Raw/a.md", content: "v2" });
        assert.match(again, /Raw\/ allows only create, so 'Raw\/a.md' can't be changed\. The note already exists; choose a new path\./);
        assert.equal(await vault.readNote("Raw/a.md"), "v1");
    });

    it("create-only: edit, delete and move out are refused, before checking the note exists", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        await vault.writeNote("Raw/a.md", "v1");
        assert.match(await call("edit_note", { path: "Raw/a.md", content: "more" }), /can't be changed/);
        assert.match(await call("edit_note", { path: "Raw/missing.md", content: "more" }), /can't be changed/);
        assert.match(await call("delete_note", { path: "Raw/a.md" }), /can't be deleted or moved/);
        assert.match(await call("move_note", { from: "Raw/a.md", to: "MCP/a.md" }), /can't be deleted or moved/);
        assert.match(await call("move_note", { from: "Raw/a.md", to: "Raw/b.md" }), /can't be deleted or moved/);
        assert.equal(await vault.readNote("Raw/a.md"), "v1");
    });

    it("create-only: moving a note in is allowed, onto an existing note is not", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        await vault.writeNote("Raw/a.md", "raw");
        await vault.writeNote("MCP/a.md", "mcp");
        await vault.writeNote("MCP/b.md", "b");
        assert.match(await call("move_note", { from: "MCP/a.md", to: "Raw/a.md" }), /A note already exists at Raw\/a.md/);
        assert.equal(await vault.readNote("Raw/a.md"), "raw");
        assert.match(await call("move_note", { from: "MCP/b.md", to: "Raw/b.md" }), /Moved: MCP\/b.md → Raw\/b.md/);
        assert.equal(await vault.readNote("Raw/b.md"), "b");
    });

    it("create+update: everything but delete", async () => {
        const { vault, call } = await setup("Notes:create+update");
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v1" }), /Note saved/);
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v2" }), /Note saved/);
        assert.match(await call("edit_note", { path: "Notes/a.md", content: "v3" }), /Note edited/);
        assert.match(await call("delete_note", { path: "Notes/a.md" }), /Notes\/ allows only create\+update, so 'Notes\/a.md' can't be deleted or moved/);
        assert.equal(await vault.readNote("Notes/a.md"), "v2\nv3");
    });

    it("update-only: existing notes can be changed, new ones not created", async () => {
        const { vault, call } = await setup("Notes:update");
        await vault.writeNote("Notes/a.md", "v1");
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v2" }), /Note saved/);
        assert.match(await call("write_note", { path: "Notes/new.md", content: "x" }), /allows only update, so 'Notes\/new.md' can't be created/);
        assert.equal(await vault.readNote("Notes/new.md"), null);
    });

    it("full write: move_note no longer replaces an existing destination", async () => {
        const { vault, call } = await setup("MCP");
        await vault.writeNote("MCP/a.md", "a");
        await vault.writeNote("MCP/b.md", "b");
        assert.match(await call("move_note", { from: "MCP/a.md", to: "MCP/b.md" }), /A note already exists at MCP\/b.md/);
        assert.equal(await vault.readNote("MCP/b.md"), "b");
    });

    it("outside every listed folder: today's message", async () => {
        const { call } = await setup("MCP,Raw:create");
        assert.equal(
            await call("write_note", { path: "daily/a.md", content: "x" }),
            "Write access denied: 'daily/a.md' is outside the writable folders (MCP/, Raw/ (create only)).",
        );
    });

    it("issue #65 config: Raw is write-once but Raw/Ideas allows updates", async () => {
        const { vault, call } = await setup("Wiki,Raw:create,Raw/Ideas:create+update");
        assert.match(await call("write_note", { path: "Raw/Ideas/idea.md", content: "status: new" }), /Note saved/);
        assert.match(await call("write_note", { path: "Raw/Ideas/idea.md", content: "status: done" }), /Note saved/);
        assert.match(await call("edit_note", { path: "Raw/Ideas/idea.md", content: "more" }), /Note edited/);
        assert.match(await call("delete_note", { path: "Raw/Ideas/idea.md" }), /Raw\/Ideas\/ allows only create\+update, so .* can't be deleted or moved/);
        assert.match(await call("write_note", { path: "Raw/Ideas/sub/deeper.md", content: "v1" }), /Note saved/);
        assert.match(await call("write_note", { path: "Raw/Ideas/sub/deeper.md", content: "v2" }), /Note saved/, "applies to subfolders too");
        assert.match(await call("write_note", { path: "Raw/source.md", content: "v1" }), /Note saved/);
        assert.match(await call("write_note", { path: "Raw/source.md", content: "v2" }), /Raw\/ allows only create/);
        assert.match(await call("edit_note", { path: "Raw/source.md", content: "x" }), /Raw\/ allows only create/);
        assert.match(await call("write_note", { path: "Raw/IdeasArchive/x.md", content: "v1" }), /Note saved/);
        assert.match(await call("write_note", { path: "Raw/IdeasArchive/x.md", content: "v2" }), /Raw\/ allows only create/, "folder-boundary aware");
        // Moving between the two needs delete at the source, which neither grants.
        assert.match(await call("move_note", { from: "Raw/source.md", to: "Raw/Ideas/source.md" }), /can't be deleted or moved/);
        assert.match(await call("move_note", { from: "Raw/Ideas/sub/deeper.md", to: "Raw/deeper.md" }), /can't be deleted or moved/);
        assert.equal(await vault.readNote("Raw/source.md"), "v1");
    });

    it("tool descriptions list the permissions", async () => {
        const { tools } = await setup("MCP,Raw:create");
        const desc = tools.find((t) => t.name === "write_note").description;
        assert.match(desc, /Writes are only allowed inside: MCP\/, Raw\/ \(create only\)\. create = add new files/);
    });
});

describe("WRITE_FOLDERS: every note tool under every permission set", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "tools-matrix-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function setup(writeFolders: string | null, readOnly = false) {
        const root = await mkdtemp(join(dir, "v-"));
        const vault = new LocalVault(root);
        const searchIndex = new SearchIndex();
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, searchIndex, "vault", readOnly, writeFolders === null ? null : parseWriteFolders(writeFolders));
        const call = (name: string, args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === name);
            assert.ok(tool, `${name} registered`);
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { vault, call, tools, searchIndex };
    }

    it("unset: every write works as before, and descriptions carry no scope note", async () => {
        const { vault, call, tools } = await setup(null);
        assert.match(await call("write_note", { path: "any/a.md", content: "v1" }), /^Note saved: any\/a.md/);
        assert.match(await call("write_note", { path: "any/a.md", content: "v2" }), /^Note saved/);
        assert.match(await call("edit_note", { path: "any/a.md", content: "v3" }), /^Note edited \(append\)/);
        assert.match(await call("move_note", { from: "any/a.md", to: "other/a.md" }), /^Moved: any\/a.md → other\/a.md/);
        assert.match(await call("delete_note", { path: "other/a.md" }), /^Deleted: other\/a.md$/);
        assert.equal(await vault.readNote("other/a.md"), null);
        for (const t of tools) assert.doesNotMatch(String(t.description), /Writes are only allowed/, t.name);
    });

    it("unset: an empty WRITE_FOLDERS is unrestricted too", async () => {
        const { call } = await setup(" , ");
        assert.match(await call("write_note", { path: "x.md", content: "x" }), /^Note saved/);
    });

    it("READ_ONLY wins over WRITE_FOLDERS: no write tools at all", async () => {
        const { tools } = await setup("MCP", true);
        const names = tools.map((t) => t.name);
        for (const w of ["write_note", "edit_note", "delete_note", "move_note"]) assert.ok(!names.includes(w), w);
    });

    it("create-only: refusals read the same whether or not the note exists", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        await vault.writeNote("Raw/exists.md", "x");
        const pairs: [string, (p: string) => any][] = [
            ["edit_note", (p) => ({ path: p, content: "y" })],
            ["delete_note", (p) => ({ path: p })],
            ["move_note", (p) => ({ from: p, to: "MCP/moved.md" })],
        ];
        for (const [tool, args] of pairs) {
            const a = await call(tool, args("Raw/exists.md"));
            const b = await call(tool, args("Raw/missing.md"));
            assert.equal(a.replace("exists", "X"), b.replace("missing", "X"), tool);
        }
        assert.equal(await vault.readNote("Raw/exists.md"), "x");
    });

    it("create-only: exact refusal messages", async () => {
        const { vault, call } = await setup("MCP,Raw:create");
        await vault.writeNote("Raw/a.md", "a");
        assert.equal(
            await call("write_note", { path: "Raw/a.md", content: "b" }),
            "Write access denied: Raw/ allows only create, so 'Raw/a.md' can't be changed. The note already exists; choose a new path.",
        );
        assert.equal(await call("edit_note", { path: "Raw/a.md", content: "b" }), "Write access denied: Raw/ allows only create, so 'Raw/a.md' can't be changed.");
        assert.equal(await call("delete_note", { path: "Raw/a.md" }), "Write access denied: Raw/ allows only create, so 'Raw/a.md' can't be deleted or moved.");
        assert.equal(await call("move_note", { from: "Raw/a.md", to: "MCP/a.md" }), "Write access denied: Raw/ allows only create, so 'Raw/a.md' can't be deleted or moved.");
    });

    it("create-only: a new note is indexed and gets a deep link", async () => {
        const { call, searchIndex } = await setup("Raw:create");
        const out = await call("write_note", { path: "Raw/new.md", content: "hello zebra" });
        assert.match(out, /^Note saved: Raw\/new.md\n\[Open in Obsidian\]\(obsidian:/);
        assert.equal(searchIndex.getContent("Raw/new.md"), "hello zebra");
    });

    it("create+update: write, overwrite, edit and move in; delete and move out refused", async () => {
        const { vault, call } = await setup("MCP,Notes:create+update");
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v1" }), /^Note saved/);
        assert.match(await call("write_note", { path: "Notes/a.md", content: "v2" }), /^Note saved/);
        assert.match(await call("edit_note", { path: "Notes/a.md", operation: "replace", old_text: "v2", content: "v3" }), /^Note edited \(replace\)/);
        await vault.writeNote("MCP/m.md", "m");
        assert.match(await call("move_note", { from: "MCP/m.md", to: "Notes/m.md" }), /^Moved/);
        assert.match(await call("move_note", { from: "Notes/m.md", to: "MCP/m.md" }), /Notes\/ allows only create\+update, so 'Notes\/m.md' can't be deleted or moved/);
        assert.match(await call("move_note", { from: "Notes/a.md", to: "Notes/b.md" }), /can't be deleted or moved/, "a rename deletes too");
        assert.equal(await vault.readNote("Notes/a.md"), "v3");
    });

    it("update-only: edit and overwrite existing; create, delete and move refused", async () => {
        const { vault, call } = await setup("MCP,Live:update");
        await vault.writeNote("Live/a.md", "v1");
        await vault.writeNote("MCP/m.md", "m");
        assert.match(await call("edit_note", { path: "Live/a.md", content: "v2" }), /^Note edited/);
        assert.match(await call("write_note", { path: "Live/a.md", content: "v3" }), /^Note saved/);
        assert.equal(await call("write_note", { path: "Live/b.md", content: "x" }), "Write access denied: Live/ allows only update, so 'Live/b.md' can't be created.");
        assert.equal(await call("edit_note", { path: "Live/missing.md", content: "x" }), "Note not found: Live/missing.md");
        assert.match(await call("delete_note", { path: "Live/a.md" }), /allows only update, so 'Live\/a.md' can't be deleted or moved/);
        assert.match(await call("move_note", { from: "MCP/m.md", to: "Live/m.md" }), /allows only update, so 'Live\/m.md' can't be created/);
        assert.equal(await vault.readNote("Live/a.md"), "v3");
        assert.equal(await vault.readNote("Live/b.md"), null);
        assert.equal(await vault.readNote("MCP/m.md"), "m");
    });

    it("delete-only: delete and move out work; anything that writes there is refused", async () => {
        const { vault, call } = await setup("MCP,Trash:delete");
        await vault.writeNote("Trash/a.md", "a");
        await vault.writeNote("Trash/b.md", "b");
        await vault.writeNote("MCP/m.md", "m");
        assert.equal(await call("write_note", { path: "Trash/a.md", content: "x" }), "Write access denied: Trash/ allows only delete, so 'Trash/a.md' can't be created.");
        assert.match(await call("edit_note", { path: "Trash/a.md", content: "x" }), /allows only delete, so 'Trash\/a.md' can't be changed/);
        assert.match(await call("move_note", { from: "MCP/m.md", to: "Trash/m.md" }), /can't be created/);
        assert.match(await call("move_note", { from: "Trash/a.md", to: "Trash/c.md" }), /'Trash\/c.md' can't be created/, "a rename within needs create");
        assert.match(await call("move_note", { from: "Trash/a.md", to: "MCP/a.md" }), /^Moved: Trash\/a.md → MCP\/a.md/);
        assert.equal(await call("delete_note", { path: "Trash/b.md" }), "Deleted: Trash/b.md");
        assert.equal(await call("delete_note", { path: "Trash/b.md" }), "Note not found: Trash/b.md");
        assert.equal(await vault.readNote("MCP/a.md"), "a");
    });

    it("root rule '/': covers root-level notes and every unlisted folder", async () => {
        const { vault, call } = await setup("/:create,MCP");
        assert.match(await call("write_note", { path: "root.md", content: "r" }), /^Note saved/);
        assert.match(await call("write_note", { path: "deep/er/x.md", content: "x" }), /^Note saved/);
        assert.equal(
            await call("write_note", { path: "root.md", content: "r2" }),
            "Write access denied: / allows only create, so 'root.md' can't be changed. The note already exists; choose a new path.",
        );
        assert.match(await call("delete_note", { path: "deep/er/x.md" }), /^Write access denied: \/ allows only create/);
        assert.match(await call("move_note", { from: "root.md", to: "MCP/root.md" }), /'root.md' can't be deleted or moved/);
        assert.match(await call("move_note", { from: "MCP/none.md", to: "x.md" }), /^Failed to move/, "MCP → root passes the check");
        assert.equal(await vault.readNote("root.md"), "r");
    });

    it("nested: the most specific folder applies, both ways", async () => {
        const { vault, call } = await setup("Raw:create,Raw/scratch");
        await vault.writeNote("Raw/a.md", "a");
        assert.match(await call("write_note", { path: "Raw/scratch/s.md", content: "1" }), /^Note saved/);
        assert.match(await call("write_note", { path: "Raw/scratch/s.md", content: "2" }), /^Note saved/);
        assert.match(await call("edit_note", { path: "Raw/scratch/s.md", content: "3" }), /^Note edited/);
        assert.match(await call("move_note", { from: "Raw/scratch/s.md", to: "Raw/s.md" }), /^Moved/, "scratch → Raw: delete in scratch, create in Raw");
        assert.match(await call("move_note", { from: "Raw/a.md", to: "Raw/scratch/a.md" }), /Raw\/ allows only create, so 'Raw\/a.md' can't be deleted or moved/);
        assert.match(await call("edit_note", { path: "Raw/s.md", content: "4" }), /Raw\/ allows only create/);
        assert.equal(await vault.readNote("Raw/s.md"), "2\n3");
        assert.match(await call("write_note", { path: "Rawx/a.md", content: "x" }), /outside the writable folders/);
    });

    it("case variants: another spelling of a create-only folder gets create only", async () => {
        const { vault, call } = await setup("/,Raw:create");
        await vault.writeNote("Raw/a.md", "a");
        await vault.writeNote("raw/b.md", "b");
        assert.match(await call("write_note", { path: "raw/new.md", content: "n" }), /^Note saved/);
        assert.match(await call("write_note", { path: "raw/b.md", content: "x" }), /Raw\/ allows only create, so 'raw\/b.md' can't be changed\. The note already exists/);
        assert.match(await call("edit_note", { path: "RAW/a.md", content: "x" }), /Raw\/ allows only create, so 'RAW\/a.md' can't be changed/);
        assert.match(await call("delete_note", { path: "raw/b.md" }), /can't be deleted or moved/);
        assert.match(await call("move_note", { from: "raw/b.md", to: "Other/b.md" }), /can't be deleted or moved/);
        assert.match(await call("move_note", { from: "Raw/a.md", to: "raw/a.md" }), /can't be deleted or moved/, "a case-only rename deletes too");
        assert.equal(await vault.readNote("raw/b.md"), "b");
        assert.equal(await vault.readNote("Raw/a.md"), "a");
    });

    it("move_note: the source is checked before the destination, each named in its refusal", async () => {
        const { call } = await setup("MCP,Raw:create");
        assert.equal(
            await call("move_note", { from: "daily/a.md", to: "elsewhere/a.md" }),
            "Write access denied: 'daily/a.md' is outside the writable folders (MCP/, Raw/ (create only)).",
        );
        assert.equal(
            await call("move_note", { from: "MCP/a.md", to: "daily/a.md" }),
            "Write access denied: 'daily/a.md' is outside the writable folders (MCP/, Raw/ (create only)).",
        );
    });

    it("move_note: within, into and out of a full-write folder; never onto an existing note", async () => {
        const { vault, call, searchIndex } = await setup("MCP,Raw:create");
        await vault.writeNote("MCP/a.md", "alpha kiwi");
        await vault.writeNote("MCP/b.md", "b");
        searchIndex.update("MCP/a.md", "alpha kiwi");
        assert.match(await call("move_note", { from: "MCP/a.md", to: "MCP/sub/a.md" }), /^Moved/);
        assert.equal(await call("move_note", { from: "MCP/sub/a.md", to: "MCP/b.md" }), "A note already exists at MCP/b.md. Choose another path.");
        assert.equal(await vault.readNote("MCP/sub/a.md"), "alpha kiwi", "refused move keeps the source");
        assert.equal(await vault.readNote("MCP/b.md"), "b");
        assert.equal(searchIndex.getContent("MCP/sub/a.md"), "alpha kiwi", "index unchanged by the refusal");
        assert.match(await call("move_note", { from: "MCP/sub/a.md", to: "Raw/a.md" }), /^Moved/);
        assert.deepEqual(searchIndex.listPaths(), ["Raw/a.md"]);
        assert.equal(searchIndex.getContent("MCP/sub/a.md"), null);
        assert.equal(searchIndex.getContent("Raw/a.md"), "alpha kiwi");
    });

    it("edit_note: a note deleted between read and write is not recreated", async () => {
        const { vault, call } = await setup("MCP");
        await vault.writeNote("MCP/a.md", "a");
        const readNote = vault.readNote.bind(vault);
        vault.readNote = async (p: string) => {
            const content = await readNote(p);
            await vault.deleteNote(p);
            return content;
        };
        assert.equal(await call("edit_note", { path: "MCP/a.md", content: "more" }), "Note not found: MCP/a.md");
        vault.readNote = readNote;
        assert.equal(await vault.readNote("MCP/a.md"), null);
    });

    it("write_note: a note created by someone else after the check is not overwritten in a create-only folder", async () => {
        const { vault, call } = await setup("Raw:create");
        const writeNote = vault.writeNote.bind(vault);
        const modes: unknown[] = [];
        vault.writeNote = async (p: string, c: string, o?: any) => {
            modes.push(o?.mode);
            await writeNote(p, "someone else");
            return writeNote(p, c, o);
        };
        assert.match(await call("write_note", { path: "Raw/a.md", content: "mine" }), /The note already exists; choose a new path\./);
        assert.deepEqual(modes, ["create"]);
        vault.writeNote = writeNote;
        assert.equal(await vault.readNote("Raw/a.md"), "someone else");
    });

    it("create_only: write_note refuses an existing note even where updates are allowed", async () => {
        const { vault, call } = await setup("MCP");
        assert.match(await call("write_note", { path: "MCP/a.md", content: "v1", create_only: true }), /^Note saved: MCP\/a.md/);
        assert.equal(await call("write_note", { path: "MCP/a.md", content: "v2", create_only: true }),
            "Note already exists: MCP/a.md. Nothing was written (create_only); choose a new path.");
        assert.equal(await vault.readNote("MCP/a.md"), "v1");
        // Without it, write_note still replaces.
        assert.match(await call("write_note", { path: "MCP/a.md", content: "v3" }), /^Note saved/);
        assert.equal(await vault.readNote("MCP/a.md"), "v3");
    });

    it("create_only passes mode create, and needs create permission", async () => {
        for (const scope of ["MCP", "MCP:create", "MCP:create+update"]) {
            const { vault, call } = await setup(scope);
            const seen: unknown[] = [];
            const writeNote = vault.writeNote.bind(vault);
            vault.writeNote = async (p: string, c: string, o?: any) => { seen.push(o?.mode); return writeNote(p, c, o); };
            await call("write_note", { path: "MCP/n.md", content: "y", create_only: true });
            assert.deepEqual(seen, ["create"], scope);
        }
        const { vault, call } = await setup("MCP:update");
        assert.match(await call("write_note", { path: "MCP/n.md", content: "y", create_only: true }), /can't be created|allows only update/);
        assert.equal(await vault.readNote("MCP/n.md"), null);
    });

    it("write_note passes the mode the folder allows down to the backend", async () => {
        const cases: [string, string | undefined][] = [["MCP", "upsert"], ["MCP:create+update", "upsert"], ["MCP:create", "create"], ["MCP:update", "update"], ["MCP:create+delete", "create"], ["MCP:update+delete", "update"]];
        for (const [scope, mode] of cases) {
            const { vault, call } = await setup(scope);
            await vault.writeNote("MCP/a.md", "x");
            const seen: unknown[] = [];
            const writeNote = vault.writeNote.bind(vault);
            vault.writeNote = async (p: string, c: string, o?: any) => { seen.push(o?.mode); return writeNote(p, c, o); };
            await call("write_note", { path: "MCP/a.md", content: "y" });
            assert.deepEqual(seen, [mode], scope);
        }
        const { vault, call } = await setup(null);
        const seen: unknown[] = [];
        vault.writeNote = async (_p: string, _c: string, o?: any) => { seen.push(o?.mode); return true; };
        await call("write_note", { path: "a.md", content: "y" });
        assert.deepEqual(seen, ["upsert"], "unset scope upserts");
    });

    it("tool descriptions: every write tool carries the scope note and legend", async () => {
        const { tools } = await setup("/,Raw:create");
        for (const name of ["write_note", "edit_note", "delete_note", "move_note"]) {
            const desc = tools.find((t) => t.name === name).description;
            assert.ok(desc.endsWith(" Writes are only allowed inside: /, Raw/ (create only). create = add new files, update = change existing files, delete = delete or move files away; the most specific folder applies."), name);
        }
        assert.match(tools.find((t) => t.name === "move_note").description, /Never replaces an existing note at the destination\./);
    });
});

describe("revisions (expected_revision)", () => {
    function setup(vault: any) {
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, new SearchIndex(), "vault");
        return (name: string, args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === name);
            return tool.execute(tool.parameters.parse(args), {});
        };
    }

    /** An in-memory backend with revisions, which can let "another writer" in before each write. */
    function revisedVault(initial: string) {
        let content = initial;
        let rev = 1;
        const interleave: ((c: string) => string)[] = [];
        return {
            get content() { return content; },
            interleave,
            readNote: async () => content,
            readNoteRevision: async () => ({ content, revision: `${rev}-x` }),
            getMetadata: async () => ({ path: "a.md", size: content.length, ctime: 0, mtime: 0, frontmatter: {}, tags: [], links: [], revision: `${rev}-x` }),
            updateNote: async (_p: string, apply: (c: string) => string, o: any = {}) => {
                const allowed = o.expectedRevision ? 1 : (o.maxAttempts ?? 1);
                for (let attempt = 1; attempt <= allowed; attempt++) {
                    const base = `${rev}-x`;
                    if (o.expectedRevision && o.expectedRevision !== base) throw new RevisionMismatchError("a.md", o.expectedRevision, base);
                    const next = apply(content);
                    const other = interleave.shift();
                    if (other) { content = other(content); rev++; }
                    if (`${rev}-x` === base) { content = next; rev++; return { content, revision: `${rev}-x`, attempts: attempt }; }
                    if (o.expectedRevision) throw new RevisionMismatchError("a.md", o.expectedRevision, `${rev}-x`);
                }
                throw new UpdateRetriesExhaustedError("a.md", allowed);
            },
        };
    }

    it("read_note and get_note_metadata show the revision", async () => {
        const call = setup(revisedVault("hello"));
        assert.match(await call("read_note", { path: "a.md" }), /^\[Open in Obsidian\]\(.*\)\nRevision: 1-x\n\n---\n\nhello$/);
        assert.match(await call("get_note_metadata", { path: "a.md" }), /\nRevision: 1-x\n/);
    });

    it("edit_note re-applies its edit when another writer got in first", async () => {
        const vault = revisedVault("- [ ] one\n- [ ] two\n");
        vault.interleave.push((c) => c.replace("- [ ] two", "- [x] two"));
        const call = setup(vault);
        const answer = await call("edit_note", { path: "a.md", operation: "replace", old_text: "- [ ] one", content: "- [x] one" });
        assert.match(answer, /^Note edited \(replace\): a\.md\nRevision: 3-x\n/);
        assert.equal(vault.content, "- [x] one\n- [x] two\n");
    });

    it("edit_note re-checks old_text on the new text, so a same-line race is refused", async () => {
        const vault = revisedVault("- [ ] one\n");
        vault.interleave.push((c) => c.replace("- [ ] one", "- [x] one (other)"));
        const call = setup(vault);
        assert.equal(await call("edit_note", { path: "a.md", operation: "replace", old_text: "- [ ] one", content: "- [x] one (me)" }), "old_text not found in note.");
        assert.equal(vault.content, "- [x] one (other)\n");
    });

    it("edit_note gives up after EDIT_MAX_ATTEMPTS and writes nothing", async () => {
        const vault = revisedVault("x");
        for (let i = 0; i < EDIT_MAX_ATTEMPTS; i++) vault.interleave.push((c) => c + "o");
        const call = setup(vault);
        const answer = await call("edit_note", { path: "a.md", content: "mine" });
        assert.equal(answer, `Failed to edit note: a.md kept changing during ${EDIT_MAX_ATTEMPTS} attempts. Nothing was written; try again.`);
        assert.ok(!vault.content.includes("mine"));
    });

    it("a stale expected_revision writes nothing and names the current revision", async () => {
        const vault = revisedVault("v1");
        const call = setup(vault);
        assert.match(await call("write_note", { path: "a.md", content: "v2", expected_revision: "1-x" }), /^Note saved: a\.md\nRevision: 2-x\n/);
        assert.equal(await call("write_note", { path: "a.md", content: "v3", expected_revision: "1-x" }),
            "Revision mismatch: a.md is at revision 2-x, not 1-x. Nothing was written; read the note again and reapply your change.");
        assert.equal(await call("edit_note", { path: "a.md", content: "v4", expected_revision: "1-x" }),
            "Revision mismatch: a.md is at revision 2-x, not 1-x. Nothing was written; read the note again and reapply your change.");
        assert.equal(vault.content, "v2");
    });

    it("local mode: no revision is shown, and expected_revision is refused rather than ignored", async () => {
        const root = await mkdtemp(join(tmpdir(), "tools-rev-"));
        try {
            const vault = new LocalVault(root);
            await vault.writeNote("a.md", "v1");
            const call = setup(vault);
            assert.ok(!(await call("read_note", { path: "a.md" })).includes("Revision:"));
            assert.equal(await call("write_note", { path: "a.md", content: "v2", expected_revision: "1-x" }), NO_REVISIONS_MESSAGE);
            assert.equal(await call("edit_note", { path: "a.md", content: "v3", expected_revision: "1-x" }), NO_REVISIONS_MESSAGE);
            assert.equal(await vault.readNote("a.md"), "v1");
            // Without expected_revision, local mode works as before.
            assert.match(await call("edit_note", { path: "a.md", content: "v4" }), /^Note edited \(append\): a\.md\n\[Open/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("write_note with expected_revision needs update permission", async () => {
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, revisedVault("v1") as any, new SearchIndex(), "vault", false, parseWriteFolders("Raw:create"));
        const tool = tools.find((t) => t.name === "write_note");
        assert.match(await tool.execute(tool.parameters.parse({ path: "Raw/a.md", content: "v2", expected_revision: "1-x" }), {}), /allows only create/);
    });
});

describe("op_id (idempotent writes)", () => {
    async function setup(opStore?: MemoryOpStore, readOnly = false) {
        const root = await mkdtemp(join(tmpdir(), "tools-op-"));
        const vault = new LocalVault(root);
        await vault.writeNote("a.md", "start");
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, new SearchIndex(), "vault", readOnly, null, undefined, opStore);
        const call = (name: string, args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === name);
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { vault, call, tools, cleanup: () => rm(root, { recursive: true, force: true }) };
    }

    it("a repeated op_id returns the first answer and writes once", async () => {
        const { vault, call, cleanup } = await setup(new MemoryOpStore());
        try {
            const first = await call("edit_note", { path: "a.md", content: "line", op_id: "op-1" });
            const again = await call("edit_note", { path: "a.md", content: "line", op_id: "op-1" });
            assert.equal(again, first);
            assert.equal(await vault.readNote("a.md"), "start\nline");
            // Without op_id, behaviour is unchanged: each call writes.
            await call("edit_note", { path: "a.md", content: "line" });
            await call("edit_note", { path: "a.md", content: "line" });
            assert.equal(await vault.readNote("a.md"), "start\nline\nline\nline");
        } finally { await cleanup(); }
    });

    it("the same op_id with other arguments is refused", async () => {
        const { vault, call, cleanup } = await setup(new MemoryOpStore());
        try {
            await call("edit_note", { path: "a.md", content: "one", op_id: "op-2" });
            assert.match(await call("edit_note", { path: "a.md", content: "two", op_id: "op-2" }), /^op_id op-2 was already used for a different call/);
            assert.match(await call("write_note", { path: "a.md", content: "one", op_id: "op-2" }), /^op_id op-2 was already used/);
            assert.equal(await vault.readNote("a.md"), "start\none");
        } finally { await cleanup(); }
    });

    it("a claimed but unfinished op_id answers 'outcome unknown' and writes nothing", async () => {
        const store = new MemoryOpStore();
        const { vault, call, cleanup } = await setup(store);
        try {
            await store.claim("op-3", fingerprint("edit_note", { path: "a.md", content: "x" }));
            assert.match(await call("edit_note", { path: "a.md", content: "x", op_id: "op-3" }), /has not finished: .*outcome is unknown/);
            assert.equal(await vault.readNote("a.md"), "start");
        } finally { await cleanup(); }
    });

    it("without OPS_DATABASE an op_id is refused, not ignored", async () => {
        const { vault, call, cleanup } = await setup(undefined);
        try {
            assert.equal(await call("edit_note", { path: "a.md", content: "x", op_id: "op-4" }), NO_OP_STORE_MESSAGE);
            assert.equal(await vault.readNote("a.md"), "start");
        } finally { await cleanup(); }
    });

    it("every write tool takes op_id; read tools don't; a malformed op_id fails the schema", async () => {
        const { tools, cleanup } = await setup(new MemoryOpStore());
        try {
            for (const t of tools) {
                const has = "op_id" in t.parameters.shape;
                assert.equal(has, ["write_note", "edit_note", "delete_note", "move_note", "resolve_conflict"].includes(t.name), t.name);
            }
            const edit = tools.find((t) => t.name === "edit_note");
            assert.equal(edit.parameters.safeParse({ path: "a.md", content: "x", op_id: "has space" }).success, false);
            assert.equal(edit.parameters.safeParse({ path: "a.md", content: "x", op_id: "x".repeat(129) }).success, false);
        } finally { await cleanup(); }
    });
});

describe("search_notes with SEARCH_DEFAULT_EXCLUDE", () => {
    function setup(exclude: string[]) {
        const searchIndex = new SearchIndex();
        searchIndex.update("Archive/old plan.md", "Garden plan from last year.", 1);
        searchIndex.update("Archive/older plan.md", "Another garden plan.", 2);
        searchIndex.update("Projects/Garden plan.md", "Garden plan for this year.", 3);
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, {} as any, searchIndex, "vault", true, null, undefined, undefined, exclude);
        const search = (args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === "search_notes");
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { search, tools };
    }

    it("leaves excluded folders out and says how many matching notes they held on the status line", async () => {
        const out = await setup(["Archive/"]).search({ terms: ["garden"] });
        const [status, header] = out.split("\n");
        assert.match(status, /^Index: local vault, no sequence — .*\. Excluded by default: Archive\/ \(2 matching notes\); pass folder to search there\.$/);
        assert.match(header, /^1 note matches "garden"\./);
        assert.ok(!out.includes("Archive/old plan.md"));
    });

    it("says so even when nothing matched", async () => {
        const out = await setup(["Archive/"]).search({ terms: ["nothing"] });
        assert.match(out.split("\n")[0], /Excluded by default: Archive\/ \(0 matching notes\)/);
        assert.match(out.split("\n")[1], /^No notes match "nothing"\.$/);
    });

    it("a folder inside an excluded one searches it, without the note", async () => {
        const out = await setup(["Archive/"]).search({ terms: ["garden"], folder: "Archive" });
        assert.ok(!out.includes("Excluded by default"));
        assert.match(out.split("\n")[1], /^2 notes match "garden"\./);
    });

    it("unset: the answer is the same as without the parameter", async () => {
        const withEmpty = await setup([]).search({ terms: ["garden"] });
        const tools: any[] = [];
        const idx = new SearchIndex();
        idx.update("Archive/old plan.md", "Garden plan from last year.", 1);
        idx.update("Archive/older plan.md", "Another garden plan.", 2);
        idx.update("Projects/Garden plan.md", "Garden plan for this year.", 3);
        registerTools({ addTool: (t: any) => tools.push(t) } as any, {} as any, idx, "vault", true, null, undefined);
        const tool = tools.find((t) => t.name === "search_notes");
        const without = await tool.execute(tool.parameters.parse({ terms: ["garden"] }), {});
        // Only the server time may differ between the two calls.
        const strip = (s: string) => s.replace(/\d{4}-\d\d-\d\d \d\d:\d\d \S+ \(\d\d:\d\dZ\)/, "<time>");
        assert.equal(strip(withEmpty), strip(without));
        assert.ok(!withEmpty.includes("Excluded"));
        assert.match(withEmpty.split("\n")[1], /^3 notes match "garden"\./);
    });

    it("the tool description names the excluded folders only when set", () => {
        const set = setup(["Archive/"]).tools.find((t) => t.name === "search_notes");
        const unset = setup([]).tools.find((t) => t.name === "search_notes");
        assert.match(set.description, /folders Archive\/ are left out/);
        assert.ok(!unset.description.includes("left out"));
    });

    it("parseSearchExclude normalises folder prefixes", async () => {
        const mod: any = await import("./search.js");
        assert.equal(typeof mod.parseSearchExclude, "function");
        assert.deepEqual(mod.parseSearchExclude(undefined), []);
        assert.deepEqual(mod.parseSearchExclude(""), []);
        assert.deepEqual(mod.parseSearchExclude(" Archive , /Inbox/old/, Archive/,\\Trash\\ ,, "), ["Archive/", "Inbox/old/", "Trash/"]);
    });
});

test("search_notes refuses more than SEARCH_MAX_WORDS distinct words instead of dropping some", async () => {
    const mod: any = await import("./tools.js");
    assert.equal(typeof mod.SEARCH_MAX_WORDS, "number");
    const tools: any[] = [];
    registerTools({ addTool: (t: any) => tools.push(t) } as any, {} as any, new SearchIndex(), "vault", true);
    const tool = tools.find((t) => t.name === "search_notes");
    const words = (from: number, n: number) => Array.from({ length: n }, (_, i) => `w${from + i}`).join(" ");
    const terms = Array.from({ length: Math.ceil((mod.SEARCH_MAX_WORDS + 1) / 10) }, (_, i) => words(i * 10, 10));
    const out = await tool.execute(tool.parameters.parse({ terms }), {});
    assert.match(out, /^Too many words: \d+ distinct words across all terms, at most \d+\./);
});

describe("read_note on a missing path", () => {
    async function setup() {
        const root = await mkdtemp(join(tmpdir(), "tools-read-"));
        const vault = new LocalVault(root);
        const searchIndex = new SearchIndex();
        const notes: Record<string, string> = {
            "Projects/Garden plan.md": "---\naliases: [Veg patch, Allotment]\n---\nBeds.",
            "Archive/Garden plan.md": "Last year.",
            "Projects/Shed.md": "Tools.",
        };
        for (const [p, text] of Object.entries(notes)) {
            await vault.writeNote(p, text);
            searchIndex.update(p, text, 1);
        }
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, searchIndex, "vault", true);
        const read = (path: string): Promise<string> => {
            const tool = tools.find((t) => t.name === "read_note");
            return tool.execute(tool.parameters.parse({ path }), {});
        };
        return { read, root };
    }

    it("suggests the note whose alias matches the requested name", async () => {
        const { read, root } = await setup();
        try {
            assert.equal(await read("Veg patch.md"), 'Note not found: Veg patch.md\nDid you mean:\n- Projects/Garden plan.md (alias "Veg patch")');
            assert.equal(await read("Inbox/VEG-patch.md"), 'Note not found: Inbox/VEG-patch.md\nDid you mean:\n- Projects/Garden plan.md (alias "Veg patch")', "case and hyphen");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("suggests notes with the same file name in other folders", async () => {
        const { read, root } = await setup();
        try {
            assert.equal(
                await read("Garden/garden plan.md"),
                "Note not found: Garden/garden plan.md\nDid you mean:\n- Archive/Garden plan.md (same file name)\n- Projects/Garden plan.md (same file name)",
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("still says only that it was not found when nothing matches", async () => {
        const { read, root } = await setup();
        try {
            assert.equal(await read("Projects/Greenhouse.md"), "Note not found: Projects/Greenhouse.md");
            assert.match(await read("Projects/Shed.md"), /Tools\./, "an existing note is read as before");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
