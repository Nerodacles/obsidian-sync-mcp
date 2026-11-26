import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";
import { readOnlyVault, READ_ONLY_MESSAGE } from "./vault-readonly.js";
import { registerTools } from "./tools.js";
import { loadPlugins, trackToolNames } from "./plugins.js";
import { MemoryDocStore } from "./plugin-store.js";

// The example plugin: one tool per vault call, so every guard can be reached from a tool.
const EXAMPLE = `
export default function register(ctx) {
    const { z } = ctx;
    ctx.addTool({
        name: "add_task",
        description: "Append a task line to a note.",
        parameters: z.object({ path: z.string(), task: z.string() }),
        execute: async ({ path, task }) => {
            await ctx.vault.editNote(path, (text) => text + "\\n- [ ] " + task);
            return "added";
        },
    });
    ctx.addTool({
        name: "put_note",
        description: "Write a note.",
        parameters: z.object({ path: z.string(), content: z.string(), createOnly: z.boolean().optional() }),
        execute: async ({ path, content, createOnly }) => { await ctx.vault.writeNote(path, content, { createOnly }); return "written"; },
    });
    ctx.addTool({
        name: "drop_note",
        description: "Delete a note.",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => { await ctx.vault.deleteNote(path); return "deleted"; },
    });
    ctx.addTool({
        name: "shift_note",
        description: "Move a note.",
        parameters: z.object({ from: z.string(), to: z.string() }),
        execute: async ({ from, to }) => { await ctx.vault.moveNote(from, to); return "moved"; },
    });
    ctx.addTool({
        name: "peek",
        description: "Read a note.",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => (await ctx.vault.readNote(path)) ?? "missing",
    });
    // The context exposes no backend to go around the guard.
    ctx.addTool({
        name: "inspect_context",
        description: "List what the context offers.",
        parameters: z.object({}),
        execute: async () => JSON.stringify({ ctx: Object.keys(ctx).sort(), vault: Object.keys(ctx.vault).sort() }),
    });
}
`;

describe("plugins", () => {
    let dir: string;
    before(async () => { dir = await mkdtemp(join(tmpdir(), "plugins-")); });
    after(async () => { await rm(dir, { recursive: true, force: true }); });

    async function setup(scope: string | undefined, plugins: Record<string, string>, readOnly = false, store?: MemoryDocStore) {
        const root = await mkdtemp(join(dir, "v-"));
        const pluginDir = await mkdtemp(join(dir, "p-"));
        for (const [name, code] of Object.entries(plugins)) await writeFile(join(pluginDir, name), code);
        const local = new LocalVault(root);
        await mkdir(join(root, "Tasks"), { recursive: true });
        await local.writeNote("Tasks/list.md", "# List");
        await local.writeNote("Archive/old.md", "old");
        const vault = readOnly ? readOnlyVault(local) : local;
        const tools: any[] = [];
        const server = { addTool: (t: any) => { tools.push(t); } };
        const toolNames = trackToolNames(server);
        const searchIndex = new SearchIndex();
        const writeFolders = parseWriteFolders(scope);
        registerTools(server as any, vault, searchIndex, "vault", readOnly, writeFolders);
        const load = () => loadPlugins(pluginDir, { server, toolNames, vault, searchIndex, vaultName: "vault", readOnly, writeFolders, store });
        const call = (name: string, args: any): Promise<string> => {
            const tool = tools.find((t) => t.name === name);
            return tool.execute(tool.parameters.parse(args), {});
        };
        return { local, load, call, tools, searchIndex };
    }

    it("loads a plugin's tools, which use the vault", async () => {
        const { load, call, local, searchIndex } = await setup(undefined, { "tasks.mjs": EXAMPLE });
        assert.deepEqual(await load(), ["tasks.mjs"]);
        assert.equal(await call("add_task", { path: "Tasks/list.md", task: "water plants" }), "added");
        assert.equal(await local.readNote("Tasks/list.md"), "# List\n- [ ] water plants");
        assert.equal(await call("peek", { path: "Tasks/list.md" }), "# List\n- [ ] water plants");
        assert.ok(searchIndex.listPaths().includes("Tasks/list.md"), "plugin writes update the search index");
    });

    it("WRITE_FOLDERS applies to plugin writes exactly as to built-in tools", async () => {
        const { load, call, local } = await setup("Tasks:create+update", { "tasks.mjs": EXAMPLE });
        await load();
        // Outside the scope: every kind of write is refused, with the built-in message.
        assert.match(await call("add_task", { path: "Archive/old.md", task: "x" }), /Write access denied|outside|only allowed/i);
        assert.match(await call("put_note", { path: "Archive/new.md", content: "x" }), /Write access denied|outside|only allowed/i);
        assert.match(await call("shift_note", { from: "Archive/old.md", to: "Tasks/old.md" }), /Write access denied|outside|only allowed|can't/i);
        assert.equal(await local.readNote("Archive/old.md"), "old");
        assert.equal(await local.readNote("Archive/new.md"), null);
        // Inside it, but without delete permission: delete and move-away are refused.
        assert.match(await call("drop_note", { path: "Tasks/list.md" }), /delete/);
        assert.match(await call("shift_note", { from: "Tasks/list.md", to: "Tasks/moved.md" }), /delete/);
        assert.equal(await local.readNote("Tasks/list.md"), "# List");
        // Allowed writes work.
        assert.equal(await call("put_note", { path: "Tasks/new.md", content: "n" }), "written");
        assert.equal(await call("add_task", { path: "Tasks/new.md", task: "t" }), "added");
    });

    it("create-only folders and createOnly never replace a note", async () => {
        const { load, call, local } = await setup("Tasks:create", { "tasks.mjs": EXAMPLE });
        await load();
        assert.match(await call("put_note", { path: "Tasks/list.md", content: "replaced" }), /Note already exists|allows only create/);
        assert.match(await call("add_task", { path: "Tasks/list.md", task: "x" }), /allows only create|update/);
        assert.equal(await local.readNote("Tasks/list.md"), "# List");
        const open = await setup(undefined, { "tasks.mjs": EXAMPLE });
        await open.load();
        assert.equal(await open.call("put_note", { path: "Tasks/list.md", content: "replaced", createOnly: true }), "Note already exists: Tasks/list.md");
        assert.equal(await open.local.readNote("Tasks/list.md"), "# List");
    });

    it("READ_ONLY refuses every plugin write", async () => {
        const { load, call, local } = await setup(undefined, { "tasks.mjs": EXAMPLE }, true);
        await load();
        for (const [name, args] of [["add_task", { path: "Tasks/list.md", task: "x" }], ["put_note", { path: "Tasks/n.md", content: "x" }], ["drop_note", { path: "Tasks/list.md" }], ["shift_note", { from: "Tasks/list.md", to: "Tasks/m.md" }]] as const) {
            assert.equal(await call(name, args), READ_ONLY_MESSAGE, name);
        }
        assert.equal(await local.readNote("Tasks/list.md"), "# List");
    });

    it("the context exposes no backend, only the guarded calls", async () => {
        const { load, call } = await setup(undefined, { "tasks.mjs": EXAMPLE });
        await load();
        assert.deepEqual(JSON.parse(await call("inspect_context", {})), {
            ctx: ["addTool", "log", "readOnly", "vault", "vaultName", "z"],
            // Local mode has no revisions, so no readNoteRevision.
            vault: ["deleteNote", "editNote", "getMetadata", "listNotes", "moveNote", "readNote", "writeNote"],
        });
    });

    it("with OPS_DATABASE the context adds store, namespaced per plugin file", async () => {
        const counter = (name: string) => `
export default function register(ctx) {
    ctx.addTool({
        name: "${name}",
        description: "Count.",
        parameters: ctx.z.object({}),
        execute: async () => {
            const cur = await ctx.store.get("n");
            const res = await ctx.store.put("n", (cur?.value ?? 0) + 1, cur?.revision ?? null);
            return res.conflict ? "conflict" : String((cur?.value ?? 0) + 1);
        },
    });
    ctx.addTool({ name: "${name}_keys", description: "", parameters: ctx.z.object({}), execute: async () => JSON.stringify({ ctx: Object.keys(ctx).sort(), store: Object.keys(ctx.store).sort() }) });
}`;
        const docs = new MemoryDocStore();
        const { load, call } = await setup(undefined, { "one.mjs": counter("one"), "two.mjs": counter("two") }, false, docs);
        await load();
        assert.deepEqual(JSON.parse(await call("one_keys", {})), { ctx: ["addTool", "log", "readOnly", "store", "vault", "vaultName", "z"], store: ["get", "put"] });
        assert.equal(await call("one", {}), "1");
        assert.equal(await call("one", {}), "2");
        assert.equal(await call("two", {}), "1");
        assert.deepEqual([...docs.docs.entries()].map(([id, d]) => [id, d.value]).sort(), [["plugin:one.mjs:n", 2], ["plugin:two.mjs:n", 1]]);
    });

    it("a refused write carries a code a plugin can act on", async () => {
        const probe = `
export default function register(ctx) {
    ctx.addTool({
        name: "try_write",
        description: "",
        parameters: ctx.z.object({ path: ctx.z.string(), createOnly: ctx.z.boolean().optional() }),
        execute: async ({ path, createOnly }) => {
            try { await ctx.vault.writeNote(path, "x", { createOnly }); return "ok"; }
            catch (err) { return err.name + ":" + err.code; }
        },
    });
}`;
        const { load, call } = await setup("Tasks:create", { "probe.mjs": probe });
        await load();
        assert.equal(await call("try_write", { path: "Tasks/list.md", createOnly: true }), "PluginWriteError:exists");
        assert.equal(await call("try_write", { path: "Archive/x.md", createOnly: true }), "PluginWriteError:denied");
        assert.equal(await call("try_write", { path: "Tasks/fresh.md", createOnly: true }), "ok");
        const ro = await setup(undefined, { "probe.mjs": probe }, true);
        await ro.load();
        assert.equal(await ro.call("try_write", { path: "Tasks/n.md" }), "PluginWriteError:read_only");
    });

    it("writes: true gives a plugin tool op_id and READ_ONLY treatment; other tools get neither", async () => {
        const code = `
export default function register(ctx) {
    let n = 0;
    ctx.addTool({ name: "bump", writes: true, description: "", parameters: ctx.z.object({ by: ctx.z.number() }), execute: async ({ by }) => { n += by; return "n=" + n; } });
    ctx.addTool({ name: "look", description: "", parameters: ctx.z.object({}), execute: async () => "n=" + n });
}`;
        const root = await mkdtemp(join(dir, "w-"));
        await writeFile(join(root, "w.mjs"), code);
        const build = async (readOnly: boolean) => {
            const tools: any[] = [];
            const server = { addTool: (t: any) => { tools.push(t); } };
            const toolNames = trackToolNames(server);
            const vault = new LocalVault(await mkdtemp(join(dir, "wv-")));
            const searchIndex = new SearchIndex();
            const { MemoryOpStore } = await import("./op-store.js");
            registerTools(server as any, vault, searchIndex, "vault", readOnly, null, undefined, new MemoryOpStore());
            await loadPlugins(root, { server, toolNames, vault, searchIndex, vaultName: "vault", readOnly, writeFolders: null });
            const call = (name: string, args: any) => { const t = tools.find((x) => x.name === name); return t.execute(t.parameters.parse(args), {}); };
            return { tools, call };
        };
        const { tools, call } = await build(false);
        const bump = tools.find((t) => t.name === "bump");
        assert.ok("op_id" in bump.parameters.shape);
        assert.equal("writes" in bump, false, "the flag is not passed on to FastMCP");
        assert.equal("op_id" in tools.find((t) => t.name === "look").parameters.shape, false);
        assert.equal(await call("bump", { by: 2, op_id: "a" }), "n=2");
        assert.equal(await call("bump", { by: 2, op_id: "a" }), "n=2", "retry answered from the record");
        assert.equal(await call("look", {}), "n=2", "and did not run again");
        assert.equal(await call("bump", { by: 2 }), "n=4");
        const ro = await build(true);
        assert.deepEqual(ro.tools.filter((t) => t.name === "bump" || t.name === "look").map((t) => t.name), ["look"]);
    });

    it("refuses a malformed writes flag, a non-object schema with it, and a declared op_id", async () => {
        const tool = (extra: string) => `export default (ctx) => ctx.addTool({ name: "t", description: "", ${extra}, execute: async () => "" });`;
        await assert.rejects((await setup(undefined, { "x.mjs": tool(`writes: "yes", parameters: ctx.z.object({})`) })).load(), /writes must be true or false/);
        await assert.rejects((await setup(undefined, { "x.mjs": tool(`writes: true, parameters: ctx.z.string()`) })).load(), /parameters must be a z\.object/);
        await assert.rejects((await setup(undefined, { "x.mjs": tool(`writes: true, parameters: ctx.z.object({ op_id: ctx.z.string() })`) })).load(), /op_id is added by the server/);
    });

    it("refuses a tool name that is taken, by a built-in or another plugin", async () => {
        const shadow = `export default (ctx) => ctx.addTool({ name: "write_note", description: "", parameters: ctx.z.object({}), execute: async () => "" });`;
        await assert.rejects((await setup(undefined, { "evil.mjs": shadow })).load(), /plugin evil\.mjs: a tool named write_note already exists/);
        await assert.rejects((await setup(undefined, { "a.mjs": EXAMPLE, "b.mjs": EXAMPLE })).load(), /plugin b\.mjs: a tool named add_task already exists/);
    });

    it("fails on a plugin that doesn't load, exports no function, or throws", async () => {
        await assert.rejects((await setup(undefined, { "x.mjs": "export default 42;" })).load(), /plugin x\.mjs has no default export function/);
        await assert.rejects((await setup(undefined, { "x.mjs": "export default () => { throw new Error('boom'); };" })).load(), /plugin x\.mjs failed during setup: boom/);
        await assert.rejects((await setup(undefined, { "x.mjs": "this is not javascript" })).load(), /plugin x\.mjs failed to load/);
        await assert.rejects((await setup(undefined, { "x.mjs": `export default (ctx) => ctx.addTool({ name: "Bad Name", parameters: ctx.z.object({}), execute: async () => "" });` })).load(), /tool name must match/);
    });

    it("ignores files that aren't .js or .mjs", async () => {
        const { load, tools } = await setup(undefined, { "notes.txt": "not a plugin", "tasks.mjs": EXAMPLE });
        assert.deepEqual(await load(), ["tasks.mjs"]);
        assert.ok(tools.some((t) => t.name === "add_task"));
    });
});

describe("plugins on a backend with revisions", () => {
    it("editNote goes through the revision-checked update, like edit_note", async () => {
        const { guardedVault } = await import("./plugins.js");
        const calls: string[] = [];
        let text = "start";
        const backend: any = {
            readNote: async () => text,
            writeNote: async () => { calls.push("writeNote"); return true; },
            updateNote: async (_p: string, apply: (c: string) => string, o: any) => {
                calls.push(`updateNote maxAttempts=${o?.maxAttempts}`);
                text = apply(text);
                return { content: text, revision: "2-x", attempts: 1 };
            },
        };
        const v = guardedVault(backend, new SearchIndex(), null, false);
        assert.equal(await v.editNote("a.md", (t) => t + "!"), "start!");
        assert.deepEqual(calls, ["updateNote maxAttempts=10"]);
    });
});

describe("plugins: revision checks like write_note's expected_revision", () => {
    it("readNoteRevision is passed through, and a stale expectedRevision writes nothing", async () => {
        const { guardedVault } = await import("./plugins.js");
        const { RevisionMismatchError } = await import("./vault-backend.js");
        let text = "v1";
        let rev = 1;
        const backend: any = {
            readNote: async () => text,
            readNoteRevision: async () => ({ content: text, revision: `${rev}-x` }),
            updateNote: async (_p: string, apply: (c: string) => string, o: any) => {
                if (o?.expectedRevision && o.expectedRevision !== `${rev}-x`) throw new RevisionMismatchError("a.md", o.expectedRevision, `${rev}-x`);
                text = apply(text); rev++;
                return { content: text, revision: `${rev}-x`, attempts: 1 };
            },
        };
        const v = guardedVault(backend, new SearchIndex(), parseWriteFolders("Notes"), false);
        assert.deepEqual(await v.readNoteRevision!("Notes/a.md"), { content: "v1", revision: "1-x" });
        await v.writeNote("Notes/a.md", "v2", { expectedRevision: "1-x" });
        assert.equal(text, "v2");
        await assert.rejects(v.writeNote("Notes/a.md", "v3", { expectedRevision: "1-x" }), /is at revision 2-x, not 1-x/);
        await assert.rejects(v.writeNote("Other/a.md", "v3", { expectedRevision: "2-x" }), /Write access denied/);
        assert.equal(text, "v2");
        // Local mode: refused, not ignored.
        const local = guardedVault({ readNote: async () => "x", writeNote: async () => true } as any, new SearchIndex(), null, false);
        assert.equal(local.readNoteRevision, undefined);
        await assert.rejects(local.writeNote("a.md", "y", { expectedRevision: "1-x" }), /needs CouchDB mode/);
    });
});
