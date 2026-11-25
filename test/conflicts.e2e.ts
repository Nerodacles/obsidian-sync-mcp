/**
 * Conflict harness: makes real CouchDB conflicts (two live revision leaves of
 * one note, as LiveSync replication leaves them when an Obsidian edit races an
 * agent edit) and checks that the server surfaces, lists, shows and resolves
 * them, reading the result back straight from CouchDB.
 *
 * Destructive: drops and recreates its own test databases. Never point it at
 * a real vault.
 *
 * Run: npm run test:conflicts   (builds first, then expects CouchDB on localhost:5985)
 *
 *   docker run -d --name couchdb-conflict-test -p 127.0.0.1:5985:5984 \
 *     -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=test couchdb:3
 *
 * Override with TEST_COUCHDB_URL / TEST_COUCHDB_USER / TEST_COUCHDB_PASSWORD.
 *
 * Every scenario runs twice: on a plain vault and on an E2EE vault with
 * obfuscated paths (where a document's path, size and chunk list are
 * encrypted, so listing has to decrypt). A conflict is made the way
 * replication makes one: an earlier body of the same note is inserted with
 * `new_edits=false` as a sibling of the current revision, so both leaves
 * share a parent and their chunks exist.
 *
 * Scenarios (each prints PASS or FAIL; the run exits 1 on any FAIL):
 *   surfaced      read_note and get_note_metadata start with the CONFLICT line;
 *                 a note without a conflict answers without it.
 *   listed        list_conflicts names the conflicted note with its count, and
 *                 not the clean one; a folder filter excludes it.
 *   shown         get_conflict prints both leaves (as CouchDB has them) and a
 *                 diff with each side's line.
 *   stale         a leaf added after get_conflict makes resolve_conflict refuse;
 *                 every leaf is still there.
 *   content       resolve_conflict with merged text: CouchDB has no _conflicts
 *                 left and the winner is the merged text.
 *   keep-other    keeping the losing leaf: its text becomes the note's text.
 *   keep-winner   keeping the winner: text and revision unchanged, other leaf gone.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COUCH = (process.env.TEST_COUCHDB_URL ?? "http://localhost:5985").replace(/\/+$/, "");
const COUCH_USER = process.env.TEST_COUCHDB_USER ?? "admin";
const COUCH_PASSWORD = process.env.TEST_COUCHDB_PASSWORD ?? "test";
const AUTH = "conflict-test-token";
const PORT = 9891;
const couchAuth = { Authorization: "Basic " + Buffer.from(`${COUCH_USER}:${COUCH_PASSWORD}`).toString("base64") };

const CONFIGS: { label: string; db: string; env: Record<string, string> }[] = [
    { label: "plain", db: "conflictvault", env: {} },
    { label: "e2ee+obfuscated", db: "conflictvault-e2ee", env: { COUCHDB_PASSPHRASE: "conflict-pass-123", COUCHDB_OBFUSCATE_PROPERTIES: "true" } },
];

// --- MCP client ---

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
    private post(body: unknown): Promise<Response> {
        return fetch(`http://localhost:${PORT}/mcp`, {
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
        const resp = await this.post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "conflicts", version: "1.0" } } });
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

interface Server { proc: ChildProcess; logs: string; dataDir: string }

async function startServer(db: string, env: Record<string, string>): Promise<Server> {
    const dataDir = await mkdtemp(join(tmpdir(), "conflict-e2e-"));
    const server: Server = {
        proc: spawn("node", ["dist/main.js"], {
            env: {
                ...process.env,
                PORT: String(PORT),
                HOST: "127.0.0.1",
                MCP_AUTH_TOKEN: AUTH,
                COUCHDB_URL: COUCH,
                COUCHDB_USER: COUCH_USER,
                COUCHDB_PASSWORD: COUCH_PASSWORD,
                COUCHDB_DATABASE: db,
                VAULT_NAME: "ConflictVault",
                DATA_DIR: dataDir,
                ...env,
            },
            stdio: "pipe",
        }),
        logs: "",
        dataDir,
    };
    server.proc.stdout?.on("data", (d) => { server.logs += d.toString(); });
    server.proc.stderr?.on("data", (d) => { server.logs += d.toString(); });
    const start = Date.now();
    while (Date.now() - start < 30000) {
        if (server.proc.exitCode !== null) throw new Error(`server exited:\n${server.logs}`);
        try {
            await new Client().connect();
            return server;
        } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server did not start:\n${server.logs}`);
}

async function stopServer(server: Server): Promise<void> {
    server.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    await rm(server.dataDir, { recursive: true, force: true });
}

// --- Raw CouchDB access, independent of the server under test ---

async function couch(db: string, path: string, init: RequestInit = {}): Promise<any> {
    const resp = await fetch(`${COUCH}/${db}${path}`, { ...init, headers: { ...couchAuth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    return await resp.json();
}

async function noteIds(db: string): Promise<Set<string>> {
    const all = await couch(db, "/_all_docs");
    return new Set(all.rows.map((r: any) => r.id).filter((id: string) => !id.startsWith("h:") && !id.startsWith("_")));
}

/** The note's live leaves as CouchDB has them: winner first. */
async function leavesOf(db: string, id: string): Promise<string[]> {
    const doc = await couch(db, `/${encodeURIComponent(id)}?conflicts=true`);
    return [doc._rev, ...(doc._conflicts ?? [])];
}

/**
 * Write `older` then `between` then `current` through the server, then insert
 * the body of `older` again as a sibling of the current revision (a child of
 * the `between` revision), with new_edits=false. Returns the document id.
 */
async function makeConflict(client: Client, db: string, path: string, older: string, between: string, current: string): Promise<string> {
    const before = await noteIds(db);
    await client.tool("write_note", { path, content: older });
    const id = [...(await noteIds(db))].find((x) => !before.has(x));
    if (!id) throw new Error(`no new document for ${path}`);
    const olderBody = await couch(db, `/${encodeURIComponent(id)}`);
    await client.tool("write_note", { path, content: between });
    const parent = (await couch(db, `/${encodeURIComponent(id)}`))._rev as string;
    await client.tool("write_note", { path, content: current });
    await addSibling(db, id, olderBody, parent);
    return id;
}

async function addSibling(db: string, id: string, body: any, parentRev: string): Promise<string> {
    const [gen, hash] = parentRev.split("-");
    const newHash = randomBytes(16).toString("hex");
    const rev = `${Number(gen) + 1}-${newHash}`;
    const { _rev: _ignored, ...rest } = body;
    const res = await couch(db, "/_bulk_docs", {
        method: "POST",
        body: JSON.stringify({ new_edits: false, docs: [{ ...rest, _id: id, _rev: rev, _revisions: { start: Number(gen) + 1, ids: [newHash, hash] }, mtime: Date.now() }] }),
    });
    if (!Array.isArray(res) || res.some((r: any) => r.error)) throw new Error(`bulk_docs: ${JSON.stringify(res)}`);
    return rev;
}

// --- Scenarios ---

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!ok) failures.push(name);
}
const first = (s: string) => JSON.stringify(s.split("\n")[0]);

const AGENT = "# Plan\nshared\nagent edit\nend\n";
const BETWEEN = "# Plan\nshared\nend\n";
const HUMAN = "# Plan\nshared\nhuman edit\nend\n";
const bodyOf = (read: string) => read.slice(read.indexOf("\n\n---\n\n") + 7);

async function scenarios(label: string, db: string, client: Client): Promise<void> {
    const name = (s: string) => `${label} ${s}`;
    await client.tool("write_note", { path: "Plans/clean.md", content: "no conflict here\n" });
    const id = await makeConflict(client, db, "Plans/roadmap.md", AGENT, BETWEEN, HUMAN);
    const leaves = await leavesOf(db, id);
    if (leaves.length !== 2) throw new Error(`setup: expected 2 leaves, CouchDB has ${JSON.stringify(leaves)}`);

    // surfaced
    const read = await client.tool("read_note", { path: "Plans/roadmap.md" });
    const meta = await client.tool("get_note_metadata", { path: "Plans/roadmap.md" });
    const clean = await client.tool("read_note", { path: "Plans/clean.md" });
    const line = "CONFLICT: 1 other live version of this note; see get_conflict.";
    check(name("surfaced"), read.startsWith(line + "\n[Open in Obsidian]") && meta.startsWith(line + "\n**Plans/roadmap.md**") && clean.startsWith("[Open in Obsidian]"),
        `read_note ${first(read)}, get_note_metadata ${first(meta)}, clean note ${first(clean)}`);

    // listed
    const listed = await client.tool("list_conflicts", {});
    const elsewhere = await client.tool("list_conflicts", { folder: "Elsewhere" });
    check(name("listed"), listed.startsWith("1 conflicted note:\n- [Plans/roadmap.md](") && listed.includes(`: 1 other live version, winner ${leaves[0]}`) && !listed.includes("clean.md") && elsewhere === "No conflicted notes in Elsewhere/.",
        `${JSON.stringify(listed)}; folder Elsewhere: ${JSON.stringify(elsewhere)}`);

    // shown
    const shown = await client.tool("get_conflict", { path: "Plans/roadmap.md" });
    const leavesLine = shown.match(/^Leaves: (\S+)$/m)?.[1] ?? "";
    const winnerHuman = bodyOf(read) === HUMAN;
    const sides = winnerHuman ? ["-human edit", "+agent edit"] : ["-agent edit", "+human edit"];
    check(name("shown"), leavesLine === leaves.join(",") && sides.every((s) => shown.includes(`\n${s}\n`)),
        `Leaves: ${leavesLine} (CouchDB: ${leaves.join(",")}), diff has ${sides.filter((s) => shown.includes(`\n${s}\n`)).join(" and ")}`);

    // stale: a third leaf arrives after get_conflict
    const thirdBody = await couch(db, `/${encodeURIComponent(id)}?rev=${leaves[0]}`);
    const parentOfWinner = (await couch(db, `/${encodeURIComponent(id)}?rev=${leaves[0]}&revs=true`))._revisions;
    await addSibling(db, id, thirdBody, `${parentOfWinner.start - 1}-${parentOfWinner.ids[1]}`);
    const stale = await client.tool("resolve_conflict", { path: "Plans/roadmap.md", expected_leaves: leavesLine, content: "merged\n" });
    const afterStale = await leavesOf(db, id);
    check(name("stale"), stale.includes("changed since get_conflict") && stale.includes("Nothing was written") && afterStale.length === 3 && afterStale.includes(leaves[0]) && afterStale.includes(leaves[1]),
        `${first(stale)}; CouchDB leaves now ${afterStale.length}`);

    // content: resolve all three with merged text
    const again = (await client.tool("get_conflict", { path: "Plans/roadmap.md" })).match(/^Leaves: (\S+)$/m)?.[1] ?? "";
    const MERGED = "# Plan\nshared\nhuman edit\nagent edit\nend\n";
    const resolved = await client.tool("resolve_conflict", { path: "Plans/roadmap.md", expected_leaves: again, content: MERGED });
    const afterResolve = await leavesOf(db, id);
    const readBack = await client.tool("read_note", { path: "Plans/roadmap.md" });
    const listedAfter = await client.tool("list_conflicts", {});
    check(name("content"), resolved.startsWith("Conflict resolved: Plans/roadmap.md\n") && resolved.includes("Removed 2 other versions") && afterResolve.length === 1 && bodyOf(readBack) === MERGED && readBack.startsWith("[Open in Obsidian]") && listedAfter === "No conflicted notes.",
        `${first(resolved)}; CouchDB leaves ${afterResolve.length}, _conflicts empty: ${afterResolve.length === 1}; body merged: ${bodyOf(readBack) === MERGED}; list_conflicts ${JSON.stringify(listedAfter)}`);

    // keep-other
    const id2 = await makeConflict(client, db, "Plans/keep-other.md", AGENT, BETWEEN, HUMAN);
    const leaves2 = await leavesOf(db, id2);
    const winnerText2 = bodyOf(await client.tool("read_note", { path: "Plans/keep-other.md" }));
    const otherText2 = winnerText2 === HUMAN ? AGENT : HUMAN;
    const kept = await client.tool("resolve_conflict", { path: "Plans/keep-other.md", expected_leaves: leaves2.join(","), keep: leaves2[1] });
    const after2 = await leavesOf(db, id2);
    const read2 = await client.tool("read_note", { path: "Plans/keep-other.md" });
    check(name("keep-other"), kept.startsWith("Conflict resolved") && after2.length === 1 && bodyOf(read2) === otherText2,
        `${first(kept)}; CouchDB leaves ${after2.length}; text is the other leaf's: ${bodyOf(read2) === otherText2}`);

    // keep-winner
    const id3 = await makeConflict(client, db, "Plans/keep-winner.md", AGENT, BETWEEN, HUMAN);
    const leaves3 = await leavesOf(db, id3);
    const before3 = bodyOf(await client.tool("read_note", { path: "Plans/keep-winner.md" }));
    const keptWinner = await client.tool("resolve_conflict", { path: "Plans/keep-winner.md", expected_leaves: leaves3.join(","), keep: leaves3[0] });
    const after3 = await leavesOf(db, id3);
    const read3 = await client.tool("read_note", { path: "Plans/keep-winner.md" });
    check(name("keep-winner"), keptWinner.startsWith("Conflict resolved") && keptWinner.includes(`\nRevision: ${leaves3[0]}\n`) && after3.length === 1 && after3[0] === leaves3[0] && bodyOf(read3) === before3,
        `${first(keptWinner)}; CouchDB leaves ${JSON.stringify(after3)}, winner kept: ${after3[0] === leaves3[0]}`);
}

// --- Main ---

for (const { label, db, env } of CONFIGS) {
    await fetch(`${COUCH}/${db}`, { method: "DELETE", headers: couchAuth });
    const created = await fetch(`${COUCH}/${db}`, { method: "PUT", headers: couchAuth });
    if (!created.ok) throw new Error(`could not create ${db}: ${created.status}`);
    const server = await startServer(db, env);
    try {
        await scenarios(label, db, await new Client().connect());
    } catch (err) {
        check(`${label} setup`, false, err instanceof Error ? err.message : String(err));
        if (process.env.CONFLICT_SERVER_LOGS) console.log(server.logs);
    } finally {
        await stopServer(server);
        await fetch(`${COUCH}/${db}`, { method: "DELETE", headers: couchAuth });
    }
}

if (failures.length) {
    console.log(`\n${failures.length} scenario(s) failed: ${failures.join(", ")}`);
    process.exit(1);
}
console.log("\nAll conflict scenarios passed.");
process.exit(0);
