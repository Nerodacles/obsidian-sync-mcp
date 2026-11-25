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

    async function setup(scope: string | undefined, plugins: Record<string, string>, readOnly = false) {
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
        const load = () => loadPlugins(pluginDir, { server, toolNames, vault, searchIndex, vaultName: "vault", readOnly, writeFolders });
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
            vault: ["deleteNote", "editNote", "getMetadata", "listNotes", "moveNote", "readNote", "writeNote"],
        });
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
