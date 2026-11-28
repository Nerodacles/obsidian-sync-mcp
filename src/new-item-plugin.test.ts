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
import { MemoryOpStore } from "./op-store.js";

const { formatId, itemPath, highestNumber, renderNote, headingTitle, checkFields, createItem, deepLink, resolveTimeZone, localDate, MAX_ROUNDS } = plugin;

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

    const counterOf = async (store: any) => (await store.get("counter"))?.value;

    it("reserves before it creates: starts at 1, the counter is the last number reserved", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault();
        const seen: number[] = [];
        const write = vault.writeNote;
        vault.writeNote = async (path, content, o) => {
            seen.push(await counterOf(store));
            return write(path, content, o);
        };
        const r = await createItem({ store, vault }, (n: number) => `n=${n}`);
        assert.deepEqual(r, { created: true, n: 1, path: "ToDo/items/moo-001.md", gaps: [], conflicts: 0 });
        const r2 = await createItem({ store, vault }, (n: number) => `n=${n}`);
        assert.equal(r2.n, 2);
        assert.deepEqual(seen, [1, 2], "the counter already held each number when its note was created");
        assert.equal(await counterOf(store), 2);
    });

    it("takes max(counter, files) + 1, both ways", async () => {
        // Files ahead (notes made by hand, or a lost counter).
        let store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        await store.put("counter", 5, null);
        let r = await createItem({ store, vault: stubVault(["ToDo/items/moo-009.md"]) }, () => "");
        assert.equal(r.n, 10);
        assert.equal(await counterOf(store), 10);
        // Counter ahead (a note was deleted: its number is not reused).
        store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        await store.put("counter", 12, null);
        r = await createItem({ store, vault: stubVault(["ToDo/items/moo-003.md"]) }, () => "");
        assert.equal(r.n, 13);
    });

    it("a reserved number whose create is refused stays unused: a gap, and the next number is reserved", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault(["ToDo/items/moo-001.md"], ["ToDo/items/moo-002.md", "ToDo/items/moo-003.md"]);
        const r = await createItem({ store, vault }, () => "");
        assert.deepEqual(r, { created: true, n: 4, path: "ToDo/items/moo-004.md", gaps: [2, 3], conflicts: 0 });
        assert.deepEqual(vault.writes, ["ToDo/items/moo-002.md", "ToDo/items/moo-003.md", "ToDo/items/moo-004.md"]);
        assert.equal(await counterOf(store), 4);
    });

    it("a reservation lost to another caller moves past theirs, and is counted", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault();
        const realPut = store.put;
        let raced = false;
        store.put = async (key: string, value: unknown, rev: string | null) => {
            if (!raced) {
                raced = true;
                await realPut(key, 20, null); // another caller reserved up to 20 meanwhile
            }
            return realPut(key, value, rev);
        };
        const r = await createItem({ store, vault }, () => "");
        assert.deepEqual(r, { created: true, n: 21, path: "ToDo/items/moo-021.md", gaps: [], conflicts: 1 });
        assert.deepEqual(vault.writes, ["ToDo/items/moo-021.md"], "never tried a number someone else reserved");
        assert.equal(await counterOf(store), 21);
    });

    it("the old reuse case: a crash after reserving leaves a gap, never a reused number", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault();
        // Call 1 reserves 1 and creates it; call 2 reserves 2 and the server stops before the create.
        await createItem({ store, vault }, () => "");
        await assert.rejects(createItem({ store, vault: { ...vault, writeNote: async () => { throw new Error("process died"); } } }, () => ""), /process died/);
        // The note of item 1 is deleted later.
        vault.notes.delete("ToDo/items/moo-001.md");
        const r = await createItem({ store, vault }, () => "");
        assert.equal(r.n, 3, "neither the deleted 1 nor the reserved-but-uncreated 2 is handed out");
        assert.deepEqual([...vault.notes.keys()], ["ToDo/items/moo-003.md"]);
    });

    it("on exhaustion it refuses and writes nothing", async () => {
        // Every reserved number already has a note.
        let store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const taken = Array.from({ length: MAX_ROUNDS + 5 }, (_, i) => itemPath(i + 1));
        let vault = stubVault([], taken);
        let r = await createItem({ store, vault }, () => "");
        assert.equal(r.created, false);
        assert.equal(r.gaps.length, MAX_ROUNDS);
        assert.equal(vault.notes.size, 0);
        // Every reservation lost.
        store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        vault = stubVault();
        let other = 0;
        store.put = async () => ({ conflict: true, current: { value: ++other, revision: `${other}-x` } });
        r = await createItem({ store, vault }, () => "");
        assert.deepEqual(r, { created: false, gaps: [], conflicts: MAX_ROUNDS });
        assert.deepEqual(vault.writes, []);
    });

    it("never lowers the counter", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        await store.put("counter", 50, null);
        const r = await createItem({ store, vault: stubVault(["ToDo/items/moo-007.md"]) }, () => "");
        assert.equal(r.n, 51);
        assert.equal(await counterOf(store), 51);
    });

    it("a refusal other than 'exists' is not retried; the reserved number is named", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault();
        vault.writeNote = async () => { throw new PluginWriteError("Write access denied", "denied"); };
        await assert.rejects(createItem({ store, vault }, () => ""), (err: any) => err.code === "denied" && err.reserved === 1);
        assert.equal(await counterOf(store), 1, "the number stays reserved");
    });

    it("a CouchDB error while reserving writes no note", async () => {
        const store = scopedStore(new MemoryDocStore(), "new-item.mjs");
        const vault = stubVault();
        store.put = async () => { throw new Error("plugin store write failed: 503 Service Unavailable"); };
        await assert.rejects(createItem({ store, vault }, () => ""), /503/);
        assert.deepEqual(vault.writes, []);
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
        // The heading drops the title's "#", so no tag comes from it; the frontmatter keeps the exact text.
        assert.deepEqual(meta.tags.sort(), ["agents", "infra"]);
        assert.ok(text.endsWith(`\n# moo-042 Fix "quotes": colons, hash & 'apostrophes' — ünïcode\n\nSome **text**.\n\n- a list\n`), text);
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

    it("the heading strips # from the title, only there", () => {
        assert.equal(headingTitle("Fix #infra ##now c#"), "Fix infra now c");
        const text = renderNote(7, { title: "#tag in # title", created: "2026-01-02" });
        assert.match(text, /\ntitle: "#tag in # title"\n/);
        assert.ok(text.endsWith("\n# moo-007 tag in title\n"), text);
        assert.deepEqual(parseFrontmatterAndLinks(text).tags, []);
        assert.ok(renderNote(8, { title: "###", created: "2026-01-02" }).endsWith("\n# moo-008\n"));
    });

    it("created is the local date in the configured zone", () => {
        const evening = new Date("2026-11-26T03:30:00Z"); // 11:30 PM on the 25th in UTC-4
        assert.equal(localDate(evening, "America/Santo_Domingo"), "2026-11-25");
        assert.equal(localDate(evening, "UTC"), "2026-11-26");
        assert.deepEqual(resolveTimeZone({ NEW_ITEM_TIMEZONE: "America/Santo_Domingo", DISPLAY_TIMEZONE: "Europe/Madrid" }), { zone: "America/Santo_Domingo", source: "NEW_ITEM_TIMEZONE" });
        assert.deepEqual(resolveTimeZone({ DISPLAY_TIMEZONE: "Europe/Madrid" }), { zone: "Europe/Madrid", source: "DISPLAY_TIMEZONE" });
        assert.deepEqual(resolveTimeZone({}), { zone: "UTC", source: "UTC" });
        assert.deepEqual(resolveTimeZone({ DISPLAY_TIMEZONE: "Mars/Base" }), { zone: "UTC", source: "UTC (DISPLAY_TIMEZONE is not valid)" });
        assert.throws(() => resolveTimeZone({ NEW_ITEM_TIMEZONE: "Mars/Base" }), /NEW_ITEM_TIMEZONE "Mars\/Base" is not a valid IANA time zone/);
    });

    it("deep link matches the server's", () => {
        assert.equal(deepLink("My Vault", "ToDo/items/moo-001.md"), "obsidian://open?vault=My%20Vault&file=ToDo%2Fitems%2Fmoo-001");
    });
});

describe("new_item plugin: loaded by the server", () => {
    let dir: string;
    before(async () => { dir = await mkdtemp(join(tmpdir(), "new-item-")); });
    after(async () => { await rm(dir, { recursive: true, force: true }); });

    async function setup(scope: string | undefined, { withStore = true, readOnly = false, withOps = true, env = {} as Record<string, string | undefined> } = {}) {
        const root = await mkdtemp(join(dir, "v-"));
        const pluginDir = await mkdtemp(join(dir, "p-"));
        await copyFile(new URL("../examples/new-item.mjs", import.meta.url), join(pluginDir, "new-item.mjs"));
        const vault = new LocalVault(root);
        const tools: any[] = [];
        const logs: string[] = [];
        const server = { addTool: (t: any) => { tools.push(t); } };
        const toolNames = trackToolNames(server);
        const searchIndex = new SearchIndex();
        const writeFolders = parseWriteFolders(scope);
        const opStore = withOps ? new MemoryOpStore() : undefined;
        registerTools(server as any, vault, searchIndex, "Work Vault", readOnly, writeFolders, undefined, opStore);
        const docs = new MemoryDocStore();
        const saved = { NEW_ITEM_TIMEZONE: process.env.NEW_ITEM_TIMEZONE, DISPLAY_TIMEZONE: process.env.DISPLAY_TIMEZONE };
        const log = console.log;
        console.log = (m: string) => { logs.push(String(m)); };
        try {
            for (const [k, v] of Object.entries({ NEW_ITEM_TIMEZONE: undefined, DISPLAY_TIMEZONE: undefined, ...env })) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
            await loadPlugins(pluginDir, { server, toolNames, vault, searchIndex, vaultName: "Work Vault", readOnly, writeFolders, store: withStore ? docs : undefined });
        } finally {
            console.log = log;
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
        }
        const tool = () => tools.find((t) => t.name === "new_item");
        const call = (args: any): Promise<string> => tool().execute(tool().parameters.parse(args), {});
        return { vault, call, docs, tools, tool, logs, opStore };
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

    it("op_id comes from the server's wrapper: the same op_id returns the first answer and creates nothing", async () => {
        const { vault, call, tool, opStore } = await setup("ToDo:create+update");
        assert.ok("op_id" in tool().parameters.shape, "the server added op_id");
        const first = await call({ title: "Once", op_id: "item-1" });
        assert.match(first, /^Created moo-001:/);
        assert.equal(await call({ title: "Once", op_id: "item-1" }), first);
        assert.match(await call({ title: "Other", op_id: "item-1" }), /already used for a different call/);
        assert.deepEqual(await vault.listNotes("ToDo/items"), ["ToDo/items/moo-001.md"]);
        assert.equal(opStore!.records.size, 1);
        // Without op_id every call creates.
        assert.match(await call({ title: "Once" }), /^Created moo-002:/);
    });

    it("op_id without OPS_DATABASE is refused like the built-in tools'", async () => {
        const { vault, call } = await setup("ToDo:create+update", { withOps: false });
        assert.match(await call({ title: "x", op_id: "item-1" }), /op_id needs OPS_DATABASE/);
        assert.deepEqual(await vault.listNotes("ToDo"), []);
    });

    it("READ_ONLY leaves the write tool out", async () => {
        const { tools, logs } = await setup(undefined, { readOnly: true, withStore: false });
        assert.equal(tools.find((t) => t.name === "new_item"), undefined);
        assert.ok(logs.some((l) => /READ_ONLY: write tool new_item not registered/.test(l)), logs.join("\n"));
    });

    it("created follows NEW_ITEM_TIMEZONE, else DISPLAY_TIMEZONE; an invalid NEW_ITEM_TIMEZONE stops loading", async () => {
        const zoned = await setup("ToDo:create+update", { env: { NEW_ITEM_TIMEZONE: "Pacific/Kiritimati", DISPLAY_TIMEZONE: "Pacific/Pago_Pago" } });
        assert.ok(zoned.logs.some((l) => l.includes("created dates in Pacific/Kiritimati (NEW_ITEM_TIMEZONE)")), zoned.logs.join("\n"));
        await zoned.call({ title: "x" });
        // UTC+14: computed after the call, so a midnight crossing during the test can't flake it unnoticed.
        assert.match((await zoned.vault.readNote("ToDo/items/moo-001.md"))!, new RegExp(`\ncreated: ${localDate(new Date(), "Pacific/Kiritimati")}\n`));
        const display = await setup("ToDo:create+update", { env: { DISPLAY_TIMEZONE: "Pacific/Pago_Pago" } });
        assert.ok(display.logs.some((l) => l.includes("created dates in Pacific/Pago_Pago (DISPLAY_TIMEZONE)")));
        await display.call({ title: "x" });
        // UTC-11 and UTC+14 are never both on the UTC date, so a plugin that ignored the zone fails one of the two at any hour.
        assert.match((await display.vault.readNote("ToDo/items/moo-001.md"))!, new RegExp(`\ncreated: ${localDate(new Date(), "Pacific/Pago_Pago")}\n`));
        await assert.rejects(setup("ToDo:create+update", { env: { NEW_ITEM_TIMEZONE: "Mars/Base" } }), /new-item\.mjs failed during setup: NEW_ITEM_TIMEZONE "Mars\/Base"/);
    });

    it("refuses a missing store, reserved fields and multi-line titles, writing nothing", async () => {
        const { vault, call, docs } = await setup("ToDo:create+update");
        assert.match(await call({ title: "x", fields: { id: "moo-999" } }), /set by new_item[\s\S]*Nothing was written/);
        assert.match(await call({ title: "one\ntwo" }), /one line/);
        assert.deepEqual(await vault.listNotes("ToDo"), []);
        assert.equal(docs.docs.size, 0, "nothing reserved");
        const noStore = await setup("ToDo:create+update", { withStore: false });
        assert.match(await noStore.call({ title: "x" }), /needs OPS_DATABASE[\s\S]*Nothing was written/);
        assert.deepEqual(await noStore.vault.listNotes("ToDo"), []);
    });

    it("WRITE_FOLDERS applies: refused with the server's message, and the reserved number is named", async () => {
        const { vault, call, docs } = await setup("Inbox:create");
        const answer = await call({ title: "x" });
        assert.match(answer, /Write access denied|outside|only allowed/i);
        assert.match(answer, /Nothing was written; moo-001 was reserved and stays unused\.$/);
        assert.deepEqual(await vault.listNotes("ToDo"), []);
        assert.equal(docs.docs.get("plugin:new-item.mjs:counter")!.value, 1);
    });
});
