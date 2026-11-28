/**
 * READ_FOLDERS against a real CouchDB: two servers on one database, an owner
 * without a read scope and a reader with READ_FOLDERS=Shared.
 *
 * Run: npm run test:read-scope   (builds first, then expects CouchDB on localhost:5985)
 *
 *   docker run -d --name couchdb-conc-test -p 127.0.0.1:5985:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD.
 * Uses (drops, recreates, and drops again at the end) the database
 * TEST_COUCHDB_DATABASE, default `readscopevault`.
 *
 * Scenarios (each prints PASS or FAIL; the run exits 1 on any FAIL):
 *   startup   a set-but-empty READ_FOLDERS, '/' and a WRITE_FOLDERS folder
 *             outside it each stop the server with a message.
 *   control   the reader started WITHOUT a scope sees the private note; its
 *             index is saved to disk on shutdown.
 *   persisted the reader restarted with the scope on that same data directory
 *             never lists the private note, even before its rebuild finishes.
 *   reads     read, suggestion, list, folders, tags, search, query, metadata,
 *             conflicts: the private note is absent through the reader and
 *             present through the owner.
 *   live      a private note the owner writes after the reader started (change
 *             feed and pre-search catch-up) stays hidden; a shared one shows.
 *   writes    every write to a private path is refused, existing or not, and
 *             CouchDB still holds the private note unchanged.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUCH = (process.env.TEST_COUCHDB_URL ?? "http://localhost:5985").replace(/\/+$/, "");
const COUCH_USER = process.env.TEST_COUCHDB_USER ?? "admin";
const COUCH_PASSWORD = process.env.TEST_COUCHDB_PASSWORD ?? "test";
const DB = process.env.TEST_COUCHDB_DATABASE ?? "readscopevault";
const AUTH = "read-scope-test-token";
const OWNER_PORT = 9893;
const READER_PORT = 9894;
const couchAuth = { Authorization: "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASSWORD}`).toString("base64") };

function parseSSE(raw: string): any {
    for (const line of raw.split("\n")) {
        if (line.startsWith("data: ")) {
            try { return JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
    }
    return JSON.parse(raw);
}

class Client {
    private session = "";
    constructor(private port: number) {}

    private async post(body: unknown): Promise<Response> {
        return await fetch(`http://localhost:${this.port}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": `Bearer ${AUTH}`,
                ...(this.session ? { "mcp-session-id": this.session } : {}),
            },
            body: JSON.stringify(body),
        });
    }

    async connect(): Promise<this> {
        const resp = await this.post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "read-scope", version: "1.0" } } });
        if (!resp.ok) throw new Error(`initialize: ${resp.status}`);
        this.session = resp.headers.get("mcp-session-id") ?? "";
        await resp.text();
        return this;
    }

    async tool(name: string, args: Record<string, unknown>): Promise<string> {
        const resp = parseSSE(await (await this.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).text());
        const text = resp?.result?.content?.[0]?.text;
        if (typeof text !== "string") throw new Error(`${name}: no text in ${JSON.stringify(resp).slice(0, 300)}`);
        return text;
    }
}

interface Server { proc: ChildProcess; logs: () => string; client: Client }

function launch(port: number, dataDir: string, extra: Record<string, string>): { proc: ChildProcess; logs: () => string } {
    let logs = "";
    const proc = spawn("node", ["dist/main.js"], {
        env: {
            ...process.env,
            PORT: String(port),
            HOST: "127.0.0.1",
            MCP_AUTH_TOKEN: AUTH,
            COUCHDB_URL: COUCH,
            COUCHDB_USER: COUCH_USER,
            COUCHDB_PASSWORD: COUCH_PASSWORD,
            COUCHDB_DATABASE: DB,
            VAULT_NAME: "ReadScopeVault",
            DATA_DIR: dataDir,
            ...extra,
        },
        stdio: "pipe",
    });
    proc.stdout?.on("data", (d) => { logs += d.toString(); });
    proc.stderr?.on("data", (d) => { logs += d.toString(); });
    return { proc, logs: () => logs };
}

async function start(port: number, dataDir: string, extra: Record<string, string> = {}): Promise<Server> {
    const { proc, logs } = launch(port, dataDir, extra);
    const begun = Date.now();
    for (;;) {
        if (proc.exitCode !== null) throw new Error(`server exited:\n${logs()}`);
        try { return { proc, logs, client: await new Client(port).connect() }; } catch { /* not ready */ }
        if (Date.now() - begun > 30000) throw new Error(`server did not start:\n${logs()}`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

async function stop(server: Server): Promise<void> {
    if (server.proc.exitCode !== null) return;
    const exited = new Promise((r) => server.proc.once("exit", r));
    server.proc.kill("SIGTERM");
    await exited;
}

/** Start a server that must refuse to start; returns its exit code and output. */
async function refused(extra: Record<string, string>): Promise<{ code: number | null; logs: string }> {
    const dir = await mkdtemp(join(tmpdir(), "read-scope-refused-"));
    const { proc, logs } = launch(READER_PORT, dir, extra);
    const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(null); }, 15000);
        proc.once("exit", (c) => { clearTimeout(timer); resolve(c); });
    });
    await rm(dir, { recursive: true, force: true });
    return { code, logs: logs() };
}

async function couch(path: string, init: RequestInit = {}): Promise<any> {
    const resp = await fetch(`${COUCH}/${DB}${path}`, { ...init, headers: { ...couchAuth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    return await resp.json();
}

async function noteIds(): Promise<Set<string>> {
    const all = await couch("/_all_docs");
    return new Set(all.rows.map((r: any) => r.id).filter((id: string) => !id.startsWith("h:") && !id.startsWith("_")));
}

/** A second live leaf on the note at `path` (see test/conflicts.e2e.ts). */
async function makeConflict(client: Client, path: string, older: string, between: string, current: string): Promise<void> {
    const before = await noteIds();
    await client.tool("write_note", { path, content: older });
    const id = [...(await noteIds())].find((x) => !before.has(x));
    if (!id) throw new Error(`no new document for ${path}`);
    const olderBody = await couch(`/${encodeURIComponent(id)}`);
    await client.tool("write_note", { path, content: between });
    const parent = (await couch(`/${encodeURIComponent(id)}`))._rev as string;
    await client.tool("write_note", { path, content: current });
    const [gen, hash] = parent.split("-");
    const newHash = randomBytes(16).toString("hex");
    const { _rev: _ignored, ...rest } = olderBody;
    const res = await couch("/_bulk_docs", {
        method: "POST",
        body: JSON.stringify({ new_edits: false, docs: [{ ...rest, _id: id, _rev: `${Number(gen) + 1}-${newHash}`, _revisions: { start: Number(gen) + 1, ids: [newHash, hash] }, mtime: Date.now() }] }),
    });
    if (!Array.isArray(res) || res.some((r: any) => r.error)) throw new Error(`bulk_docs: ${JSON.stringify(res)}`);
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!ok) failures.push(name);
}
const hides = (text: string) => !/Private|welcome|secretive|Masterplan/.test(text);
const hitLines = (s: string) => s.split("\n").filter((l) => l.startsWith("- ")).join("\n");

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 15000): Promise<void> {
    const begun = Date.now();
    while (!(await probe())) {
        if (Date.now() - begun > ms) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 200));
    }
}

const PRIVATE = "---\nstatus: open\naliases: [Masterplan]\ntags: [team, secretive]\n---\nThe launch codeword is here. [[Shared/a]] [[Shared/b]]\n";

await fetch(`${COUCH}/${DB}`, { method: "DELETE", headers: couchAuth });
const created = await fetch(`${COUCH}/${DB}`, { method: "PUT", headers: couchAuth });
if (!created.ok) throw new Error(`could not create ${DB}: ${created.status}`);

const ownerDir = await mkdtemp(join(tmpdir(), "read-scope-owner-"));
const readerDir = await mkdtemp(join(tmpdir(), "read-scope-reader-"));
const servers: Server[] = [];
try {
    // --- startup ---
    for (const [label, extra, want] of [
        ["empty", { READ_FOLDERS: "" }, /READ_FOLDERS is set but lists nothing/],
        ["root", { READ_FOLDERS: "/" }, /is the whole vault/],
        ["write outside", { READ_FOLDERS: "Shared", WRITE_FOLDERS: "Shared,Private" }, /WRITE_FOLDERS: 'Private' is outside READ_FOLDERS/],
    ] as const) {
        const r = await refused(extra);
        check(`startup ${label}`, r.code === 1 && want.test(r.logs), `exit ${r.code}; ${r.logs.trim().split("\n").pop()}`);
    }

    // --- seed through the owner ---
    const owner = await start(OWNER_PORT, ownerDir);
    servers.push(owner);
    const own = owner.client;
    await own.tool("write_note", { path: "Shared/a.md", content: "---\nstatus: open\ntags: [team]\n---\nAlpha, launch codeword. [[Private/plan]] [[Shared/b]] [[plan]]\n" });
    await own.tool("write_note", { path: "Shared/b.md", content: "Bravo. #team\n" });
    await own.tool("write_note", { path: "welcome.md", content: "Root, launch codeword.\n" });
    await makeConflict(own, "Private/plan.md", PRIVATE, PRIVATE + "between\n", PRIVATE);
    await makeConflict(own, "Shared/c.md", "c1\n", "c2\n", "c3\n");

    // --- control: the reader without a scope, on its own data directory ---
    let reader = await start(READER_PORT, readerDir);
    await waitFor("the unscoped reader's index", async () => /Private\/plan\.md/.test(await reader.client.tool("list_notes", {})));
    check("control list", true, "the unscoped reader lists Private/plan.md");
    check("control read", /launch codeword is here/.test(await reader.client.tool("read_note", { path: "Private/plan.md" })), "the unscoped reader reads it");
    await stop(reader);

    // --- persisted: same data directory, now scoped ---
    reader = await start(READER_PORT, readerDir, { READ_FOLDERS: "Shared", WRITE_FOLDERS: "Shared" });
    servers.push(reader);
    const rd = reader.client;
    const early = await rd.tool("list_notes", {});
    check("persisted", hides(early), `first list_notes after restart: ${JSON.stringify(early.split("\n").slice(0, 6))}`);
    await waitFor("the scoped reader's index", async () => /Shared\/c\.md/.test(await rd.tool("list_notes", {})));

    // --- reads ---
    const notFound = await rd.tool("read_note", { path: "Private/plan.md" });
    check("read_note", notFound === "Note not found: Private/plan.md", JSON.stringify(notFound));
    const missing = await rd.tool("read_note", { path: "Private/nothing.md" });
    check("read_note missing", missing === "Note not found: Private/nothing.md", JSON.stringify(missing));
    const suggest = await rd.tool("read_note", { path: "Other/plan.md" });
    check("suggestion", suggest === "Note not found: Other/plan.md", JSON.stringify(suggest));
    check("suggestion control", /Private\/plan\.md/.test(await own.tool("read_note", { path: "Other/plan.md" })), "the owner is offered Private/plan.md");
    for (const [name, args] of [
        ["list_notes", {}],
        ["list_folders", {}],
        ["list_tags", {}],
        ["query_notes", { where: [{ field: "status", op: "eq", value: "open" }] }],
        ["list_conflicts", {}],
    ] as const) {
        const scoped = await rd.tool(name, args);
        const control = await own.tool(name, args);
        check(name, hides(scoped) && !hides(control), `reader: ${JSON.stringify(scoped.split("\n").slice(0, 4))}`);
    }
    const search = await rd.tool("search_notes", { terms: ["codeword"] });
    const searchOwner = await own.tool("search_notes", { terms: ["codeword"] });
    check("search_notes", hides(hitLines(search)) && /^1 note matches/m.test(search) && !hides(hitLines(searchOwner)),
        `reader: ${JSON.stringify(search.split("\n").filter((l) => !l.startsWith("  ")))}`);
    check("search status", /; 3 of 3 notes with content\.$/.test(search.split("\n")[0]) && /; 5 of 5 notes with content\.$/.test(searchOwner.split("\n")[0]),
        `reader: ${search.split("\n")[0]} | owner: ${searchOwner.split("\n")[0]}`);
    const meta = await rd.tool("get_note_metadata", { path: "Shared/b.md" });
    const metaA = await rd.tool("get_note_metadata", { path: "Shared/a.md" });
    check("get_note_metadata", hides(meta) && hides(metaA) && /Backlinks: Shared\/a\.md$/m.test(meta), `${meta.match(/^Backlinks.*$/m)?.[0]}; ${metaA.match(/^Outgoing.*$/m)?.[0]}`);
    check("get_note_metadata control", /Private\/plan\.md/.test(await own.tool("get_note_metadata", { path: "Shared/b.md" })), "the owner sees the private backlink");
    const conflict = await rd.tool("get_conflict", { path: "Private/plan.md" });
    check("get_conflict", conflict === "Note not found: Private/plan.md", JSON.stringify(conflict));
    check("get_conflict visible", /^Conflict: Shared\/c\.md has 2 live versions/.test(await rd.tool("get_conflict", { path: "Shared/c.md" })), "a shared conflict still shows");

    // --- live: change feed and pre-search catch-up ---
    await own.tool("write_note", { path: "Private/later.md", content: "zulu codeword\n" });
    await own.tool("write_note", { path: "Shared/later.md", content: "zulu codeword\n" });
    await waitFor("the shared note to reach the reader", async () => /Shared\/later\.md/.test(await rd.tool("list_notes", {})));
    const live = await rd.tool("search_notes", { terms: ["zulu"] });
    check("live", !/Private/.test(hitLines(live)) && /Shared\/later\.md/.test(live) && hides(await rd.tool("list_notes", {})),
        JSON.stringify(live.split("\n").filter((l) => l.startsWith("- ") || /match/.test(l))));

    // --- writes ---
    const before = await own.tool("read_note", { path: "Private/plan.md" });
    const writes: Array<[string, (p: string) => Record<string, unknown>]> = [
        ["write_note", (p) => ({ path: p, content: "x" })],
        ["edit_note", (p) => ({ path: p, content: "x" })],
        ["set_properties", (p) => ({ path: p, set: { a: "b" } })],
        ["append_to_section", (p) => ({ path: p, heading: "Log", line: "x", create_heading: true })],
        ["delete_note", (p) => ({ path: p })],
        ["move_note", (p) => ({ from: p, to: "Shared/moved.md" })],
        ["rename_note", (p) => ({ from: p, to: "Shared/moved.md" })],
        ["resolve_conflict", (p) => ({ path: p, expected_leaves: "1-a,2-b", keep: "1-a" })],
    ];
    let same = 0;
    const odd: string[] = [];
    for (const [name, args] of writes) {
        const a = await rd.tool(name, args("Private/plan.md"));
        const b = await rd.tool(name, args("Private/nothing.md"));
        const want = (p: string) => `Write access denied: '${p}' is outside the folders this server can read (Shared).`;
        if (a === want("Private/plan.md") && b === want("Private/nothing.md")) same++;
        else odd.push(`${name}: ${a} | ${b}`);
    }
    check("writes", same === writes.length, odd.length ? odd.join("; ") : `${same} write tools refuse both paths with the same answer`);
    check("writes untouched", (await own.tool("read_note", { path: "Private/plan.md" })) === before && /^Note not found/.test(await own.tool("read_note", { path: "Private/nothing.md" })),
        "the owner reads the private note unchanged and no new note");
} finally {
    for (const s of servers) await stop(s).catch(() => undefined);
    await rm(ownerDir, { recursive: true, force: true });
    await rm(readerDir, { recursive: true, force: true });
    await fetch(`${COUCH}/${DB}`, { method: "DELETE", headers: couchAuth });
}

if (failures.length) {
    console.log(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nAll READ_FOLDERS checks passed.");
process.exit(0);
