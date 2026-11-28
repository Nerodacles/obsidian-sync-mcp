import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { registerTools } from "./tools.js";
import { unlinkLinks } from "./rename.js";
import type { VaultBackend } from "./vault-backend.js";

const TARGET = "Projects/Garden plan.md";
const NOTES = [TARGET, "Journal/Monday.md", "Other/Notes.md"];
const unlink = (content: string, notes: readonly string[] = NOTES) =>
    unlinkLinks(content, { target: TARGET, notes, source: "Journal/Monday.md" });

describe("unlinkLinks", () => {
    it("turns a short wikilink into the note's name", () => {
        assert.deepEqual(unlink("See [[Garden plan]] today.\n"), { content: "See Garden plan today.\n", unlinked: 1, ambiguous: 0, frontmatterKept: 0 });
    });

    it("keeps the label and drops the heading or block reference", () => {
        assert.equal(unlink("[[Garden plan|the plan]], [[Garden plan#Beds]], [[Projects/Garden plan#^a1b2|that line]]\n").content, "the plan, Garden plan, that line\n");
    });

    it("drops the table escape with the link", () => {
        assert.equal(unlink("| [[Garden plan\\|plan]] | [[Garden plan#Beds\\|beds]] |\n").content, "| plan | beds |\n");
    });

    it("drops the embed's !", () => {
        assert.equal(unlink("![[Garden plan]]\n![[Garden plan|shown]]\n").content, "Garden plan\nshown\n");
    });

    it("turns markdown links into their text, or the name when empty", () => {
        const r = unlink("[the plan](../Projects/Garden%20plan.md#Beds) [](<Projects/Garden plan.md>) [x](https://example.com/Garden%20plan.md)\n");
        assert.equal(r.content, "the plan Garden plan [x](https://example.com/Garden%20plan.md)\n");
        assert.equal(r.unlinked, 2);
    });

    it("leaves links in code, links to other notes and an empty label alone", () => {
        const text = "```\n[[Garden plan]]\n```\n`[[Garden plan]]` [[Notes]] [[Garden plan|]]\n";
        assert.equal(unlink(text).content, "```\n[[Garden plan]]\n```\n`[[Garden plan]]` [[Notes]] Garden plan\n");
    });

    it("leaves a short link several notes share and counts it", () => {
        const r = unlink("[[Garden plan]] [[Projects/Garden plan]]\n", [...NOTES, "Archive/Garden plan.md"]);
        assert.equal(r.content, "[[Garden plan]] Garden plan\n");
        assert.equal(r.ambiguous, 1);
    });

    it("unlinks a frontmatter wikilink and keeps the YAML valid", () => {
        const r = unlink("---\nparent: \"[[Projects/Garden plan|plan]]\"\nlinks:\n  - \"[[Garden plan]]\"\n---\nBody [[Garden plan]]\n");
        assert.equal(r.content, "---\nparent: \"plan\"\nlinks:\n  - \"Garden plan\"\n---\nBody Garden plan\n");
        assert.equal(r.unlinked, 3);
    });

    it("leaves frontmatter links alone when removing them would break the YAML", () => {
        const text = "---\nnote: [[Garden plan|a: b]]\n---\n[[Garden plan]]\n";
        const r = unlink(text);
        assert.equal(r.content, "---\nnote: [[Garden plan|a: b]]\n---\nGarden plan\n");
        assert.deepEqual([r.unlinked, r.frontmatterKept], [1, 1]);
    });
});

describe("delete_note", () => {
    let dir: string;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "delete-note-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function setup(notes: Record<string, string>, writeFolders: string | null = null, wrap?: (v: VaultBackend) => VaultBackend) {
        const root = await mkdtemp(join(dir, "v-"));
        const local = new LocalVault(root);
        const searchIndex = new SearchIndex();
        for (const [path, content] of Object.entries(notes)) {
            await local.writeNote(path, content);
            searchIndex.update(path, content, Date.now());
        }
        searchIndex.state = "ready";
        const vault = wrap ? wrap(local) : local;
        const tools: any[] = [];
        registerTools({ addTool: (t: any) => tools.push(t) } as any, vault, searchIndex, "vault", false, writeFolders === null ? null : parseWriteFolders(writeFolders));
        const call = (args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === "delete_note");
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { vault: local, searchIndex, call };
    }

    const LABELLED = "# Monday\n\nRead [[Garden plan|the plan]] before planting.\nTrailing line  \n";
    const TABLE = "| Plan | Note |\n| --- | --- |\n| [[Projects/Garden plan\\|plan]] | ok |\n";
    const EMBED = "---\ntags: [a]\n---\nIntro\n\n![[Garden plan]]\n\n```md\n[[Garden plan]]\n```\n";
    const THREE = { [TARGET]: "# Garden plan\n", "Journal/Monday.md": LABELLED, "Tables/Index.md": TABLE, "Embeds/Show.md": EMBED };

    it("deletes a note linked from three others and turns only the links into plain text", async () => {
        const { vault, call, searchIndex } = await setup(THREE);
        const answer = await call({ path: TARGET });
        assert.equal(await vault.readNote(TARGET), null);
        assert.equal(await vault.readNote("Journal/Monday.md"), "# Monday\n\nRead the plan before planting.\nTrailing line  \n");
        assert.equal(await vault.readNote("Tables/Index.md"), "| Plan | Note |\n| --- | --- |\n| plan | ok |\n");
        // The link in the code fence stays.
        assert.equal(await vault.readNote("Embeds/Show.md"), "---\ntags: [a]\n---\nIntro\n\nGarden plan\n\n```md\n[[Garden plan]]\n```\n");
        assert.match(answer, /^Deleted: Projects\/Garden plan\.md$/m);
        assert.match(answer, /^Links: 3 links turned into plain text in 3 notes; 0 not unlinked; 0 unchanged\.$/m);
        for (const p of ["Embeds/Show.md", "Journal/Monday.md", "Tables/Index.md"]) assert.match(answer, new RegExp(`^- Unlinked: ${p.replace(/[./]/g, "\\$&")} \\(1 link\\)$`, "m"));
        assert.deepEqual(searchIndex.getBacklinks(TARGET), []);
    });

    it("finds and unlinks a partial-path link, and leaves one that resolves to another note", async () => {
        const deep = "Work/Projects/Garden plan.md";
        const { vault, call } = await setup({
            [deep]: "x\n",
            "A/partial.md": "[[Projects/Garden plan|p]] [q](Projects/Garden%20plan.md)\n",
            "Other/Projects/Garden plan.md": "y\n",
            "B/exact.md": "[[Other/Projects/Garden plan]]\n",
        });
        const answer = await call({ path: deep });
        // Two notes end with Projects/Garden plan: the partial link is ambiguous and stays.
        assert.equal(await vault.readNote("A/partial.md"), "[[Projects/Garden plan|p]] [q](Projects/Garden%20plan.md)\n");
        assert.match(answer, /^- Unchanged: A\/partial\.md, no link in it needs removing; 2 links left as written, since several notes share that name$/m);
        assert.equal(await vault.readNote("B/exact.md"), "[[Other/Projects/Garden plan]]\n");
        const solo = await setup({ [deep]: "x\n", "A/partial.md": "[[Projects/Garden plan|p]] [q](Projects/Garden%20plan.md)\n" });
        await solo.call({ path: deep });
        assert.equal(await solo.vault.readNote("A/partial.md"), "p q\n");
    });

    it("unlink=false deletes the note and leaves every link", async () => {
        const { vault, call } = await setup(THREE);
        assert.equal(await call({ path: TARGET, unlink: false }), `Deleted: ${TARGET}`);
        assert.equal(await vault.readNote(TARGET), null);
        assert.equal(await vault.readNote("Journal/Monday.md"), LABELLED);
        assert.equal(await vault.readNote("Tables/Index.md"), TABLE);
        assert.equal(await vault.readNote("Embeds/Show.md"), EMBED);
    });

    it("answers exactly 'Deleted' when nothing links to the note", async () => {
        const { call } = await setup({ [TARGET]: "x\n", "Other/Notes.md": "[[Notes]]\n" });
        assert.equal(await call({ path: TARGET }), `Deleted: ${TARGET}`);
    });

    it("lists a linking note it may not update, leaves it as is and still deletes", async () => {
        const { vault, call } = await setup(THREE, "Projects,Journal,Embeds,Tables:create");
        const answer = await call({ path: TARGET });
        assert.equal(await vault.readNote(TARGET), null);
        assert.equal(await vault.readNote("Tables/Index.md"), TABLE);
        assert.match(answer, /^- Not unlinked: Tables\/Index\.md \(1 link\), no update permission: /m);
        assert.match(answer, /^Links: 2 links turned into plain text in 2 notes; 1 not unlinked; 0 unchanged\.$/m);
    });

    it("touches no linking note when the delete itself is refused", async () => {
        const { vault, call } = await setup(THREE, "Projects:create,Journal,Embeds,Tables");
        assert.match(await call({ path: TARGET }), /can't be deleted or moved/);
        assert.equal(await vault.readNote("Journal/Monday.md"), LABELLED);
        assert.notEqual(await vault.readNote(TARGET), null);
    });

    it("re-applies the unlink to the newer text when another writer got in first (updateNote path)", async () => {
        const seen: string[] = [];
        const { vault, call } = await setup({ [TARGET]: "x\n", "Journal/Monday.md": "[[Garden plan]] first\n" }, null, (local) => {
            const v = Object.create(local) as VaultBackend;
            // A fake revision-checked update: the first attempt loses to a
            // concurrent edit, so apply runs again on the edited text.
            v.updateNote = async (path, apply) => {
                seen.push(apply((await local.readNote(path))!));
                const concurrent = "[[Garden plan]] first\nA line someone else added\n";
                await local.writeNote(path, concurrent, { mode: "update" });
                const content = apply(concurrent);
                seen.push(content);
                await local.writeNote(path, content, { mode: "update" });
                return { content, revision: "2-ab", attempts: 2 };
            };
            return v;
        });
        const answer = await call({ path: TARGET });
        assert.deepEqual(seen, ["Garden plan first\n", "Garden plan first\nA line someone else added\n"]);
        assert.equal(await vault.readNote("Journal/Monday.md"), "Garden plan first\nA line someone else added\n");
        assert.match(answer, /^- Unlinked: Journal\/Monday\.md \(1 link\)$/m);
    });

    it("writes nothing when the newer text has no link left (updateNote path)", async () => {
        let applied = 0;
        const { vault, call } = await setup({ [TARGET]: "x\n", "Journal/Monday.md": "[[Garden plan]]\n" }, null, (local) => {
            const v = Object.create(local) as VaultBackend;
            v.updateNote = async (_path, apply) => {
                applied++;
                apply("no link any more\n");
                throw new Error("apply should have refused");
            };
            return v;
        });
        const answer = await call({ path: TARGET });
        assert.equal(applied, 1);
        assert.equal(await vault.readNote("Journal/Monday.md"), "[[Garden plan]]\n");
        assert.match(answer, /^- Unchanged: Journal\/Monday\.md, its links were removed by another writer$/m);
    });

    it("says the links are already gone when the delete fails afterwards", async () => {
        const { call } = await setup({ [TARGET]: "x\n", "Journal/Monday.md": "[[Garden plan]]\n" }, null, (local) => {
            const v = Object.create(local) as VaultBackend;
            v.deleteNote = async () => false;
            return v;
        });
        const answer = await call({ path: TARGET });
        assert.match(answer, /^Failed to delete: Projects\/Garden plan\.md$/m);
        assert.match(answer, /^The note is still there, but the links to it in Journal\/Monday\.md are already plain text\.$/m);
    });
});
