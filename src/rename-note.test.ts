import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { registerTools } from "./tools.js";

describe("rename_note", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "rename-note-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /** A local vault holding `notes`, indexed, with the tools registered. */
    async function setup(notes: Record<string, string>, writeFolders: string | null = null) {
        const root = await mkdtemp(join(dir, "v-"));
        const vault = new LocalVault(root);
        const searchIndex = new SearchIndex();
        for (const [path, content] of Object.entries(notes)) {
            await vault.writeNote(path, content);
            searchIndex.update(path, content, Date.now());
        }
        searchIndex.state = "ready";
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, searchIndex, "vault", false, writeFolders === null ? null : parseWriteFolders(writeFolders));
        const call = (args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === "rename_note");
            assert.ok(tool, "rename_note registered");
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { vault, searchIndex, call, tools };
    }

    const FROM = "Projects/Garden plan.md";
    const TO = "Projects/Garden/Spring planting.md";
    const NOTE = "# Garden plan\n";

    /** Rename FROM to TO with one linker holding `linker`; returns the linker's new text and the answer. */
    async function renameWith(linker: string, args: Record<string, unknown> = {}) {
        const { vault, call } = await setup({ [FROM]: NOTE, "Journal/Monday.md": linker });
        const answer = await call({ from: FROM, to: TO, ...args });
        return { text: await vault.readNote("Journal/Monday.md"), answer, vault };
    }

    it("rewrites a short wikilink to the new name", async () => {
        const { text, answer } = await renameWith("See [[Garden plan]] today.\n");
        assert.equal(text, "See [[Spring planting]] today.\n");
        assert.match(answer, /^Renamed: Projects\/Garden plan\.md → Projects\/Garden\/Spring planting\.md$/m);
        assert.match(answer, /^- Rewritten: Journal\/Monday\.md \(1 link\)$/m);
        assert.match(answer, /^Links: 1 link rewritten in 1 note; 0 not rewritten; 0 unchanged\.$/m);
    });

    it("keeps a label", async () => {
        const { text } = await renameWith("[[Garden plan|the plan]]\n");
        assert.equal(text, "[[Spring planting|the plan]]\n");
    });

    it("keeps a heading and a block reference", async () => {
        const { text } = await renameWith("[[Garden plan#Beds]] and [[Garden plan#^a1b2c3|that line]]\n");
        assert.equal(text, "[[Spring planting#Beds]] and [[Spring planting#^a1b2c3|that line]]\n");
    });

    it("keeps a full path a full path", async () => {
        const { text } = await renameWith("[[Projects/Garden plan]] and [[Projects/Garden plan.md]]\n");
        assert.equal(text, "[[Projects/Garden/Spring planting]] and [[Projects/Garden/Spring planting.md]]\n");
    });

    it("rewrites an embed", async () => {
        const { text } = await renameWith("![[Garden plan]]\n![[Projects/Garden plan#Beds]]\n");
        assert.equal(text, "![[Spring planting]]\n![[Projects/Garden/Spring planting#Beds]]\n");
    });

    it("keeps the escaped pipe of a link in a table", async () => {
        const { text } = await renameWith("| Plan | Note |\n| --- | --- |\n| [[Projects/Garden plan\\|plan]] | x |\n");
        assert.equal(text, "| Plan | Note |\n| --- | --- |\n| [[Projects/Garden/Spring planting\\|plan]] | x |\n");
    });

    it("rewrites a markdown link, keeping its encoding and fragment", async () => {
        const { text } = await renameWith("[plan](Projects/Garden%20plan.md) and [beds](Projects/Garden%20plan.md#Beds)\n");
        assert.equal(text, "[plan](Projects/Garden/Spring%20planting.md) and [beds](Projects/Garden/Spring%20planting.md#Beds)\n");
    });

    it("rewrites a markdown link in angle brackets", async () => {
        const { text } = await renameWith("[plan](<Projects/Garden plan.md>)\n");
        assert.equal(text, "[plan](<Projects/Garden/Spring planting.md>)\n");
    });

    it("leaves links in fenced and inline code alone", async () => {
        const linker = "Real: [[Garden plan]]\n\n```\n[[Garden plan]] [x](Projects/Garden%20plan.md)\n```\n\nInline `[[Garden plan]]` too.\n";
        const { text } = await renameWith(linker);
        assert.equal(text, "Real: [[Spring planting]]\n\n```\n[[Garden plan]] [x](Projects/Garden%20plan.md)\n```\n\nInline `[[Garden plan]]` too.\n");
    });

    it("adds the old name to aliases by default, creating the frontmatter", async () => {
        const { vault, answer } = await renameWith("[[Garden plan]]\n");
        assert.equal(await vault.readNote(TO), "---\naliases:\n  - Garden plan\n---\n# Garden plan\n");
        assert.match(answer, /^Alias added to Projects\/Garden\/Spring planting\.md: Garden plan$/m);
        assert.equal(await vault.readNote(FROM), null);
    });

    it("appends to existing aliases and keeps the other properties as written", async () => {
        const note = "---\ntitle: \"Garden\"   # kept\naliases:\n  - Beds\ntags: [home]\n---\nBody\n";
        const { vault, call } = await setup({ [FROM]: note });
        await call({ from: FROM, to: TO });
        assert.equal(await vault.readNote(TO), "---\ntitle: \"Garden\"   # kept\naliases:\n  - Beds\n  - Garden plan\ntags: [home]\n---\nBody\n");
    });

    it("keep_alias=false moves the note unchanged", async () => {
        const { vault, answer } = await renameWith("[[Garden plan]]\n", { keep_alias: false });
        assert.equal(await vault.readNote(TO), NOTE);
        assert.doesNotMatch(answer, /Alias/);
    });

    it("update_links=false moves without touching linkers", async () => {
        const { text, answer } = await renameWith("[[Garden plan]]\n", { update_links: false });
        assert.equal(text, "[[Garden plan]]\n");
        assert.match(answer, /^Links: not updated \(update_links=false\)\.$/m);
    });

    it("lists a linker outside WRITE_FOLDERS as not rewritten and leaves it as it was", async () => {
        const { vault, call } = await setup(
            { [FROM]: NOTE, "Journal/Monday.md": "[[Garden plan]]\n", "Projects/Index.md": "[[Garden plan]]\n" },
            "Projects",
        );
        const answer = await call({ from: FROM, to: TO });
        assert.match(answer, /^Renamed: /m);
        assert.equal(await vault.readNote("Journal/Monday.md"), "[[Garden plan]]\n");
        assert.equal(await vault.readNote("Projects/Index.md"), "[[Spring planting]]\n");
        assert.match(answer, /^- Not rewritten: Journal\/Monday\.md \(1 link\), no update permission: Write access denied: 'Journal\/Monday\.md' is outside the writable folders/m);
        assert.match(answer, /^- Rewritten: Projects\/Index\.md \(1 link\)$/m);
        assert.match(answer, /^Links: 1 link rewritten in 1 note; 1 not rewritten; 0 unchanged\.$/m);
    });

    it("lists a linker in a create-only folder as not rewritten", async () => {
        const { vault, call } = await setup({ [FROM]: NOTE, "Raw/clip.md": "[[Garden plan]]\n" }, "Projects,Raw:create");
        const answer = await call({ from: FROM, to: TO });
        assert.equal(await vault.readNote("Raw/clip.md"), "[[Garden plan]]\n");
        assert.match(answer, /^- Not rewritten: Raw\/clip\.md \(1 link\), no update permission: .*Raw\/ allows only create/m);
    });

    it("refuses when a note exists at the destination, and changes nothing", async () => {
        const { vault, call } = await setup({ [FROM]: NOTE, [TO]: "other\n", "Journal/Monday.md": "[[Garden plan]]\n" });
        const answer = await call({ from: FROM, to: TO });
        assert.equal(answer, `A note already exists at ${TO}. Nothing was renamed or rewritten.`);
        assert.equal(await vault.readNote(FROM), NOTE);
        assert.equal(await vault.readNote(TO), "other\n");
        assert.equal(await vault.readNote("Journal/Monday.md"), "[[Garden plan]]\n");
    });

    it("needs delete at the source and create at the destination, like move_note", async () => {
        const { vault, call } = await setup({ [FROM]: NOTE, "Raw/a.md": "a\n" }, "Projects,Raw:create");
        assert.match(await call({ from: "Raw/a.md", to: "Projects/a.md" }), /can't be deleted or moved/);
        assert.match(await call({ from: FROM, to: "Journal/Garden plan.md" }), /outside the writable folders/);
        assert.equal(await vault.readNote(FROM), NOTE);
    });

    it("leaves a short link alone when only the folder changes", async () => {
        const { vault, call } = await setup({ [FROM]: NOTE, "Journal/Monday.md": "[[Garden plan]] [[Projects/Garden plan]]\n" });
        const answer = await call({ from: FROM, to: "Archive/Garden plan.md" });
        assert.equal(await vault.readNote("Journal/Monday.md"), "[[Garden plan]] [[Archive/Garden plan]]\n");
        assert.match(answer, /^- Rewritten: Journal\/Monday\.md \(1 link\)$/m);
        assert.doesNotMatch(answer, /Alias/, "same name: no alias");
    });

    it("leaves a short link that several notes share as written and says so", async () => {
        const { vault, call } = await setup({ [FROM]: NOTE, "Archive/Garden plan.md": "old\n", "Journal/Monday.md": "[[Garden plan]]\n" });
        const answer = await call({ from: FROM, to: TO });
        assert.equal(await vault.readNote("Journal/Monday.md"), "[[Garden plan]]\n");
        assert.match(answer, /^- Unchanged: Journal\/Monday\.md, no link in it needs rewriting; 1 link left as written, since several notes share that name$/m);
    });

    it("updates the index: backlinks follow the new path", async () => {
        const { searchIndex, call } = await setup({ [FROM]: NOTE, "Journal/Monday.md": "[[Garden plan]]\n" });
        await call({ from: FROM, to: TO });
        assert.deepEqual(searchIndex.getBacklinks(TO), ["Journal/Monday.md"]);
        assert.deepEqual(searchIndex.listPaths().filter((p) => p === FROM), []);
        assert.match(searchIndex.getContent(TO) ?? "", /^---\naliases:\n {2}- Garden plan\n---\n/, "the index holds the note with its alias");
    });

    it("is a write tool: hidden in READ_ONLY mode", async () => {
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, {} as any, {} as any, "vault", true);
        assert.equal(tools.find((t) => t.name === "rename_note"), undefined);
        const all: any[] = [];
        registerTools({ addTool: (t: any) => all.push(t) } as any, {} as any, {} as any, "vault");
        assert.match(all.find((t) => t.name === "rename_note")?.description ?? "", /Not atomic/);
    });
});

describe("rename_note with a revision-checked backend", () => {
    it("rewrites a linker through updateNote, so another writer's change made meanwhile is kept", async () => {
        const root = await mkdtemp(join(tmpdir(), "rename-rev-"));
        try {
            const vault: any = new LocalVault(root);
            const searchIndex = new SearchIndex();
            const notes: Record<string, string> = {
                "Projects/Garden plan.md": "# Garden plan\n",
                "Journal/Monday.md": "See [[Garden plan]] today.\n",
            };
            for (const [path, content] of Object.entries(notes)) {
                await vault.writeNote(path, content);
                searchIndex.update(path, content, Date.now());
            }
            searchIndex.state = "ready";
            let updateCalls = 0;
            vault.updateNote = async (path: string, apply: (c: string) => string) => {
                updateCalls++;
                const current = (await vault.readNote(path)) + "Another writer's line.\n";
                const next = apply(current);
                await vault.writeNote(path, next, { mode: "update" });
                return { content: next, revision: "2-x", attempts: 2 };
            };
            const tools: any[] = [];
            registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, searchIndex, "vault", false, null);
            const tool = tools.find((t) => t.name === "rename_note");
            const answer: string = await tool.execute(tool.parameters.parse({ from: "Projects/Garden plan.md", to: "Projects/Spring planting.md" }), {});
            const monday = await vault.readNote("Journal/Monday.md");
            assert.equal(updateCalls, 1, "the linker went through updateNote");
            assert.match(monday, /\[\[Spring planting\]\]/);
            assert.match(monday, /Another writer's line\./, "the concurrent change survived");
            assert.match(answer, /- Rewritten: Journal\/Monday\.md \(1 link\)/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
