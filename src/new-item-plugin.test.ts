// Unit tests for the example plugin examples/new-item.mjs.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
// @ts-expect-error plain JavaScript plugin, no type declarations
import * as plugin from "../examples/new-item.mjs";
import { parseFrontmatterAndLinks } from "./parse.js";
import { PluginWriteError, loadPlugins, trackToolNames } from "./plugins.js";
import { MemoryDocStore, scopedStore } from "./plugin-store.js";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { registerTools } from "./tools.js";

const { formatId, itemPath, highestNumber, renderNote, checkFields, createItem, deepLink, MAX_CREATE_ATTEMPTS } = plugin;

/** A vault where create-only refuses existing paths, like the real one. */
function stubVault(existing: string[] = [], hidden: string[] = []) {
    const notes = new Map<string, string>(existing.map((p) => [p, "x"]));
    // `hidden`: taken paths the listing doesn't show (a note created a moment ago elsewhere).
    const taken = new Set(hidden);
    const writes: string[] = [];
    return {
        notes,
        writes,
        listNotes: async (folder: string) => [...notes.keys()].filter((p) => p.startsWith(folder + "/")),
        writeNote: async (path: string, content: string, o: { createOnly?: boolean }) => {
            assert.equal(o?.createOnly, true, "new_item only ever writes create-only");
            writes.push(path);
            if (notes.has(path) || taken.has(path)) throw new PluginWriteError(`Note already exists: ${path}`, "exists");
            notes.set(path, content);
        },
    };
}

describe("new_item plugin: numbering", () => {
    it("formats ids zero-padded to 3 and grows past 999", () => {
        assert.equal(formatId(1), "moo-001");
        assert.equal(formatId(42), "moo-042");
        assert.equal(formatId(999), "moo-999");
        assert.equal(formatId(1000), "moo-1000");
        assert.equal(itemPath(7), "ToDo/items/moo-007.md");
    });

    it("highest number counts only item notes directly in the folder", () => {
        assert.equal(highestNumber([]), 0);
        assert.equal(highestNumber(["ToDo/items/moo-007.md", "ToDo/items/moo-1002.md", "ToDo/items/moo-0042.md"]), 1002);
        assert.equal(highestNumber(["ToDo/items/moo-9.txt", "ToDo/items/sub/moo-500.md", "ToDo/moo-400.md", "ToDo/items/xmoo-300.md", "ToDo/items/moo-300a.md"]), 0);
    });

    it("starts at 1 and raises the counter", async () => {
        const docs = new MemoryDocStore();
        const store = scopedStore(docs, "new-item.mjs");
        const vault = stubVault();
        const r = await createItem({ store, vault }, (n: number) => `n=${n}`);
        assert.deepEqual(r, { created: true, n: 1, path: "ToDo/items/moo-001.md", skipped: [], counterRaised: true });
        assert.equal((await store.get("counter"))!.value, 1);
        const r2 = await createItem({ store, vault }, (n: number) => `n=${n}`);
        assert.equal(r2.n, 2);
        assert.equal((await store.get("counter"))!.value, 2);
    });

    it("takes max(counter, files) + 1, both ways", async () => {
        // Files ahead (notes made by hand, or a lost counter).
        let store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        await store.put("counter", 5, null);
        let r = await createItem({ store, vault: stubVault(["ToDo/items/moo-009.md"]) }, () => "");
        assert.equal(r.n, 10);
        assert.equal((await store.get("counter"))!.value, 10);
        // Counter ahead (a note was deleted: its number is not reused).
        store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        await store.put("counter", 12, null);
        r = await createItem({ store, vault: stubVault(["ToDo/items/moo-003.md"]) }, () => "");
        assert.equal(r.n, 13);
    });

    it("a taken number is skipped and the next one used; the skip is reported", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault(["ToDo/items/moo-001.md"], ["ToDo/items/moo-002.md", "ToDo/items/moo-003.md"]);
        const r = await createItem({ store, vault }, () => "");
        assert.deepEqual(r, { created: true, n: 4, path: "ToDo/items/moo-004.md", skipped: [2, 3], counterRaised: true });
        assert.deepEqual(vault.writes, ["ToDo/items/moo-002.md", "ToDo/items/moo-003.md", "ToDo/items/moo-004.md"]);
    });

    it("after a refusal it jumps past a counter that others raised meanwhile", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault();
        const write = vault.writeNote;
        let first = true;
        vault.writeNote = async (path, content, o) => {
            if (first) {
                // While we tried moo-001, others created up to moo-020 and raised the counter.
                first = false;
                await store.put("counter", 20, null);
                vault.writes.push(path);
                throw new PluginWriteError(`Note already exists: ${path}`, "exists");
            }
            return write(path, content, o);
        };
        const r = await createItem({ store, vault }, () => "");
        assert.equal(r.n, 21);
        assert.deepEqual(vault.writes, ["ToDo/items/moo-001.md", "ToDo/items/moo-021.md"]);
    });

    it("on exhaustion it refuses and writes nothing", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const taken = Array.from({ length: MAX_CREATE_ATTEMPTS + 5 }, (_, i) => itemPath(i + 1));
        const vault = stubVault([], taken);
        const r = await createItem({ store, vault }, () => "");
        assert.equal(r.created, false);
        assert.equal(r.skipped.length, MAX_CREATE_ATTEMPTS);
        assert.equal(vault.notes.size, 0);
        assert.equal(await store.get("counter"), null, "counter untouched");
    });

    it("never lowers the counter when someone raised it past us", async () => {
        const docs = new MemoryDocStore();
        const store = scopedStore(docs, "new-item.mjs");
        const vault = stubVault();
        const realPut = store.put;
        let raced = false;
        store.put = async (key: string, value: unknown, rev: string | null) => {
            if (!raced) {
                raced = true;
                await realPut(key, 50, null); // another caller got to 50 first
            }
            return realPut(key, value, rev);
        };
        const r = await createItem({ store, vault }, () => "");
        assert.equal(r.n, 1);
        assert.equal(r.counterRaised, true);
        assert.equal((await store.get("counter"))!.value, 50);
    });

    it("a refusal other than 'exists' is not retried", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault();
        vault.writeNote = async () => { throw new PluginWriteError("Write access denied", "denied"); };
        await assert.rejects(createItem({ store, vault }, () => ""), /Write access denied/);
        assert.equal(await store.get("counter"), null);
    });

    it("a counter that fails to rise is a warning, not a lost note", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault();
        store.put = async () => ({ conflict: true, current: null });
        const r = await createItem({ store, vault }, () => "");
        assert.equal(r.created, true);
        assert.equal(r.counterRaised, false);
        assert.ok(vault.notes.has("ToDo/items/moo-001.md"));
    });
});

describe("new_item plugin: note text", () => {
    const tricky = {
        title: `Fix "quotes": colons, #hash & 'apostrophes' — ünïcode`,
        body: "Some **text**.\n\n- a list\n",
        created: "2026-01-02",
        fields: {
            priority: 2,
            urgent: true,
            looksLikeBool: "true",
            looksLikeNumber: "1.10",
            looksLikeDate: "2026-01-01",
            colon: "a: b",
            multi: "line one\nline two",
            empty: "",
            tags: ["infra", "agents"],
            mixed: [1, "two", false],
            none: [],
        },
    };

    it("round-trips through YAML and the server's own parser", () => {
        const text = renderNote(42, tricky);
        const fm = text.match(/^---\n([\s\S]*?)\n---\n/)![1];
        assert.deepEqual(parseYaml(fm), {
            id: "moo-042",
            title: tricky.title,
            created: "2026-01-02",
            state: "new",
            ...tricky.fields,
        });
        const meta = parseFrontmatterAndLinks(text);
        assert.equal(meta.frontmatterError, undefined);
        assert.equal(meta.frontmatter.id, "moo-042");
        assert.equal(meta.frontmatter.title, tricky.title);
        assert.equal(meta.frontmatter.state, "new");
        assert.equal(meta.frontmatter.looksLikeNumber, "1.10");
        assert.equal(meta.frontmatter.tags, "infra, agents");
        // The title is repeated in the heading, where Obsidian reads " #hash" as a tag; the frontmatter copy is quoted and isn't.
        assert.deepEqual(meta.tags.sort(), ["agents", "hash", "infra"]);
        assert.ok(text.endsWith(`\n# moo-042 ${tricky.title}\n\nSome **text**.\n\n- a list\n`), text);
    });

    it("state from fields replaces the default; no body means just the heading", () => {
        const text = renderNote(1, { title: "T", created: "2026-01-02", fields: { state: "doing" } });
        assert.equal(text, '---\nid: moo-001\ntitle: "T"\ncreated: 2026-01-02\nstate: "doing"\n---\n\n# moo-001 T\n');
    });

    it("refuses reserved, malformed and non-scalar fields", () => {
        assert.match(checkFields({ id: "x" }), /set by new_item/);
        assert.match(checkFields({ created: "x" }), /set by new_item/);
        assert.match(checkFields({ "bad key": 1 }), /not allowed/);
        assert.match(checkFields({ "a:b": 1 }), /not allowed/);
        assert.match(checkFields({ n: Number.NaN }), /only strings/);
        assert.equal(checkFields({ state: "x", ok: [1, "a", true] }), null);
        assert.equal(checkFields(undefined), null);
    });

    it("deep link matches the server's", () => {
        assert.equal(deepLink("My Vault", "ToDo/items/moo-001.md"), "obsidian://open?vault=My%20Vault&file=ToDo%2Fitems%2Fmoo-001");
    });
});

describe("new_item plugin: loaded by the server", () => {
    let dir: string;
    before(async () => { dir = await mkdtemp(join(tmpdir(), "new-item-")); });
    after(async () => { await rm(dir, { recursive: true, force: true }); });

    async function setup(scope: string | undefined, withStore = true) {
        const root = await mkdtemp(join(dir, "v-"));
        const pluginDir = await mkdtemp(join(dir, "p-"));
        await copyFile(new URL("../examples/new-item.mjs", import.meta.url), join(pluginDir, "new-item.mjs"));
        const vault = new LocalVault(root);
        const tools: any[] = [];
        const server = { addTool: (t: any) => { tools.push(t); } };
        const toolNames = trackToolNames(server);
        const searchIndex = new SearchIndex();
        const writeFolders = parseWriteFolders(scope);
        registerTools(server as any, vault, searchIndex, "Work Vault", false, writeFolders);
        const docs = new MemoryDocStore();
        await loadPlugins(pluginDir, { server, toolNames, vault, searchIndex, vaultName: "Work Vault", readOnly: false, writeFolders, store: withStore ? docs : undefined });
        const call = (args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === "new_item");
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { vault, call, docs };
    }

    it("creates the note and answers with id, path and deep link", async () => {
        const { vault, call, docs } = await setup("ToDo:create+update");
        const answer = await call({ title: "Rotate the backup key", body: "Details.", fields: { owner: "ops" } });
        assert.equal(answer, "Created moo-001: ToDo/items/moo-001.md\n[Open in Obsidian](obsidian://open?vault=Work%20Vault&file=ToDo%2Fitems%2Fmoo-001)");
        const text = (await vault.readNote("ToDo/items/moo-001.md"))!;
        assert.match(text, /^---\nid: moo-001\ntitle: "Rotate the backup key"\ncreated: \d{4}-\d{2}-\d{2}\nstate: new\nowner: "ops"\n---\n\n# moo-001 Rotate the backup key\n\nDetails\.\n$/);
        assert.match(await call({ title: "Second" }), /^Created moo-002:/);
        assert.equal(docs.docs.get("plugin:new-item.mjs:counter")!.value, 2);
    });

    it("refuses op_id, a missing store, reserved fields and multi-line titles, writing nothing", async () => {
        const { vault, call } = await setup("ToDo:create+update");
        assert.match(await call({ title: "x", op_id: "retry-1" }), /does not support op_id[\s\S]*Nothing was written/);
        assert.match(await call({ title: "x", fields: { id: "moo-999" } }), /set by new_item[\s\S]*Nothing was written/);
        assert.match(await call({ title: "one\ntwo" }), /one line/);
        assert.deepEqual(await vault.listNotes("ToDo"), []);
        const noStore = await setup("ToDo:create+update", false);
        assert.match(await noStore.call({ title: "x" }), /needs OPS_DATABASE[\s\S]*Nothing was written/);
        assert.deepEqual(await noStore.vault.listNotes("ToDo"), []);
    });

    it("WRITE_FOLDERS applies: outside the scope it is refused with the server's message", async () => {
        const { vault, call, docs } = await setup("Inbox:create");
        assert.match(await call({ title: "x" }), /Write access denied|outside|only allowed/i);
        assert.deepEqual(await vault.listNotes("ToDo"), []);
        assert.equal(docs.docs.size, 0, "counter untouched");
    });
});
