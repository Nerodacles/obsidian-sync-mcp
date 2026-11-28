// Unit tests for examples/desk-answer-webhook.mjs and the note change hook it uses.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain JavaScript plugin, no type declarations
import * as plugin from "../examples/desk-answer-webhook.mjs";
import { parseFrontmatterAndLinks } from "./parse.js";
import { MemoryDocStore, scopedStore } from "./plugin-store.js";
import { NoteChangeHub } from "./note-events.js";
import { loadPlugins, trackToolNames } from "./plugins.js";
import { LocalVault } from "./vault-local.js";
import { SearchIndex } from "./search.js";
import { parseWriteFolders } from "./write-scope.js";

const { createDeskWatcher, deskAnswer, isCasePath, readConfig, sign, stateKey, ATTEMPTS } = plugin;
const SECRET = "test-secret-that-is-at-least-32-characters";
const URL_ = "http://receiver.test:8795/desk-answer";
const PATH = "ToDo/items/moo-210.md";

const parseFrontmatter = (content: string) => {
    const { frontmatter, frontmatterError } = parseFrontmatterAndLinks(content);
    return frontmatterError ? { properties: {}, error: frontmatterError } : { properties: frontmatter };
};

function caseNote({ go = "false", answer = '""', ask = '"Approve the plan?"', recommended = '"yes"', body = "Body." } = {}) {
    return `---\nid: moo-210\ntitle: "Watcher D"\nstate: "backlog"\nask: ${ask}\nrecommended: ${recommended}\ngo: ${go}\nanswer: ${answer}\n---\n\n# moo-210\n\n${body}\n`;
}

/** A vault of notes with CouchDB-style revisions: every save bumps the generation. */
function revVault() {
    const notes = new Map<string, { content: string; revision: string }>();
    let counter = 0;
    return {
        notes,
        save(path: string, content: string) {
            const gen = (Number(notes.get(path)?.revision.split("-")[0] ?? 0)) + 1;
            notes.set(path, { content, revision: `${gen}-${(++counter).toString(16).padStart(32, "0")}` });
            return notes.get(path)!.revision;
        },
        readNoteRevision: async (path: string) => notes.get(path) ?? null,
        listNotes: async (folder: string) => [...notes.keys()].filter((p) => p.startsWith(folder + "/")).sort(),
    };
}

/** A receiver stub that records every POST and answers `status`. */
function receiver(statuses: (number | Error)[] = []) {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetch = async (url: string, init: any) => {
        calls.push({ url, headers: init.headers, body: init.body });
        const next = statuses.length ? statuses.shift()! : 202;
        if (next instanceof Error) throw next;
        return { status: next };
    };
    return { calls, fetch };
}

function setup({ docs = new MemoryDocStore(), statuses = [] as (number | Error)[], vault = revVault() } = {}) {
    const store = scopedStore(docs, "desk-answer-webhook.mjs");
    const rx = receiver(statuses);
    const logs: string[] = [];
    const watcher = createDeskWatcher({ vault, store, parseFrontmatter, url: URL_, secret: SECRET, fetch: rx.fetch, sleep: async () => {}, log: (m: string) => logs.push(m) });
    return { watcher, vault, store, docs, rx, logs };
}

describe("desk-answer plugin: when it fires", () => {
    it("go false -> true fires once, with only path, id, revision and kind", async () => {
        const { watcher, vault, rx } = setup();
        vault.save(PATH, caseNote());
        assert.equal(await watcher.handle(PATH), "none");
        const rev = vault.save(PATH, caseNote({ go: "true" }));
        assert.equal(await watcher.handle(PATH), "sent");
        // The feed and a catch-up can deliver the same change twice.
        assert.equal(await watcher.handle(PATH), "already");
        assert.equal(rx.calls.length, 1);
        assert.deepEqual(JSON.parse(rx.calls[0].body), { path: PATH, id: "moo-210", revision: rev, kind: "go" });
        assert.deepEqual(Object.keys(JSON.parse(rx.calls[0].body)), ["path", "id", "revision", "kind"]);
    });

    it('answer "" -> "x" fires once, as kind answer', async () => {
        const { watcher, vault, rx } = setup();
        vault.save(PATH, caseNote());
        await watcher.handle(PATH);
        vault.save(PATH, caseNote({ answer: '"x"' }));
        assert.equal(await watcher.handle(PATH), "sent");
        await watcher.handle(PATH);
        assert.equal(rx.calls.length, 1);
        assert.equal(JSON.parse(rx.calls[0].body).kind, "answer");
    });

    it("an edit that changes neither go nor answer fires nothing (new revision, other properties, body)", async () => {
        const { watcher, vault, rx } = setup();
        vault.save(PATH, caseNote());
        await watcher.handle(PATH);
        vault.save(PATH, caseNote({ body: "Edited body." }));
        assert.equal(await watcher.handle(PATH), "none");
        vault.save(PATH, caseNote({ body: "Edited body.", recommended: '"no"' }));
        assert.equal(await watcher.handle(PATH), "none");
        assert.equal(rx.calls.length, 0);
        // And on a case whose answer was already sent: editing around it sends nothing more.
        vault.save(PATH, caseNote({ go: "true" }));
        assert.equal(await watcher.handle(PATH), "sent");
        vault.save(PATH, caseNote({ go: "true", body: "Another edit.", recommended: '"yes"' }));
        assert.equal(await watcher.handle(PATH), "already");
        assert.equal(rx.calls.length, 1);
    });

    it("the same answer saved again fires nothing, though the revision changed", async () => {
        const { watcher, vault, rx } = setup();
        vault.save(PATH, caseNote({ answer: '"ship it"' }));
        assert.equal(await watcher.handle(PATH), "sent");
        vault.save(PATH, caseNote({ answer: '"ship it"', body: "Owner fixed a typo." }));
        assert.equal(await watcher.handle(PATH), "already");
        vault.save(PATH, caseNote({ answer: '"ship it"', go: "true" }));
        assert.equal(await watcher.handle(PATH), "already", "ticking go too changes nothing: the typed answer wins");
        assert.equal(rx.calls.length, 1);
    });

    it("a different answer, or a new ask answered the same way, fires again", async () => {
        const { watcher, vault, rx } = setup();
        vault.save(PATH, caseNote({ answer: '"a"' }));
        await watcher.handle(PATH);
        vault.save(PATH, caseNote({ answer: '"b"' }));
        assert.equal(await watcher.handle(PATH), "sent");
        vault.save(PATH, caseNote({ answer: '"b"', ask: '"Next question?"' }));
        assert.equal(await watcher.handle(PATH), "sent");
        assert.equal(rx.calls.length, 3);
    });

    it("a cleared case is recorded, so the same tick on the same ask fires again after the session cleared it", async () => {
        const { watcher, vault, rx } = setup();
        vault.save(PATH, caseNote({ go: "true" }));
        await watcher.handle(PATH);
        vault.save(PATH, caseNote());
        assert.equal(await watcher.handle(PATH), "reset");
        vault.save(PATH, caseNote({ go: "true" }));
        assert.equal(await watcher.handle(PATH), "sent");
        assert.equal(rx.calls.length, 2);
    });

    it("ignores notes outside ToDo/items, nested ones and the items index", async () => {
        const { watcher, vault, rx } = setup();
        for (const p of ["ToDo/desk.md", "ToDo/items/items.md", "ToDo/items/sub/moo-1.md", "docs/moo-1.md", "ToDo/items/moo-1.txt"]) {
            vault.save(p, caseNote({ go: "true" }));
            assert.equal(await watcher.handle(p), "ignored", p);
        }
        assert.equal(rx.calls.length, 0);
        assert.equal(isCasePath("ToDo/items/moo-001.md"), true);
    });

    it("a deleted note or unreadable frontmatter fires nothing", async () => {
        const { watcher, vault, rx } = setup();
        assert.equal(await watcher.handle(PATH), "gone");
        vault.save(PATH, "---\ngo: true\nbad: : :\n---\n");
        assert.equal(await watcher.handle(PATH), "unreadable");
        assert.equal(rx.calls.length, 0);
    });
});

describe("desk-answer plugin: restart and instances", () => {
    it("a restart does not re-fire an answer already sent", async () => {
        const docs = new MemoryDocStore();
        const vault = revVault();
        const first = setup({ docs, vault });
        vault.save(PATH, caseNote({ go: "true" }));
        vault.save("ToDo/items/moo-211.md", caseNote({ answer: '"later"' }));
        assert.deepEqual(await first.watcher.sweep(), ["sent", "sent"]);
        // A new process on the same OPS_DATABASE: its startup sweep and a replayed change.
        const second = setup({ docs, vault });
        assert.deepEqual(await second.watcher.sweep(), ["already", "already"]);
        assert.equal(await second.watcher.handle(PATH), "already");
        assert.equal(second.rx.calls.length, 0);
    });

    it("failing form: without the stored record the same restart fires again", async () => {
        const vault = revVault();
        await setup({ vault }).watcher.handle((vault.save(PATH, caseNote({ go: "true" })), PATH));
        const fresh = setup({ vault });
        assert.deepEqual(await fresh.watcher.sweep(), ["sent"]);
        assert.equal(fresh.rx.calls.length, 1);
    });

    it("the startup sweep sends an answer made while the server was down", async () => {
        const docs = new MemoryDocStore();
        const vault = revVault();
        vault.save(PATH, caseNote());
        await setup({ docs, vault }).watcher.sweep();
        vault.save(PATH, caseNote({ answer: '"done offline"' }));
        const after = setup({ docs, vault });
        assert.deepEqual(await after.watcher.sweep(), ["sent"]);
    });

    it("two instances on one store send one event between them", async () => {
        const docs = new MemoryDocStore();
        const vault = revVault();
        vault.save(PATH, caseNote({ go: "true" }));
        // Every read waits a turn, so both instances read the record before either writes.
        const slow = { getDoc: async (id: string) => { const v = await docs.getDoc(id); await new Promise((r) => setTimeout(r, 5)); return v; }, putDoc: (id: string, v: unknown, r: string | null) => docs.putDoc(id, v, r) };
        const a = setup({ docs: slow as unknown as MemoryDocStore, vault });
        const b = setup({ docs: slow as unknown as MemoryDocStore, vault });
        const results = await Promise.all([a.watcher.handle(PATH), b.watcher.handle(PATH), a.watcher.handle(PATH), b.watcher.handle(PATH)]);
        assert.equal(a.rx.calls.length + b.rx.calls.length, 1, JSON.stringify(results));
    });
});

describe("desk-answer plugin: delivery", () => {
    it("signs timestamp.body with HMAC-SHA256, which the receiver can recompute", async () => {
        const { watcher, vault, rx } = setup();
        vault.save(PATH, caseNote({ go: "true" }));
        await watcher.handle(PATH);
        const { headers, body } = rx.calls[0];
        const expected = "sha256=" + createHmac("sha256", SECRET).update(`${headers["x-desk-timestamp"]}.${body}`).digest("hex");
        assert.equal(headers["x-desk-signature"], expected);
        assert.match(headers["x-desk-timestamp"], /^\d{10}$/);
        assert.notEqual(sign("another-secret-that-is-32-characters-long", headers["x-desk-timestamp"], body), expected);
    });

    it("retries a 5xx or a network error, at most ATTEMPTS times, then records failed and never resends", async () => {
        const { watcher, vault, rx, store } = setup({ statuses: [503, new TypeError("fetch failed"), 500] });
        vault.save(PATH, caseNote({ go: "true" }));
        assert.equal(await watcher.handle(PATH), "failed");
        assert.equal(rx.calls.length, ATTEMPTS);
        assert.equal((await store.get(stateKey(PATH)))?.value.delivery, "failed");
        assert.equal(await watcher.handle(PATH), "already");
        assert.equal(rx.calls.length, ATTEMPTS);
    });

    it("does not retry a refusal the receiver means (401, 400)", async () => {
        const { watcher, vault, rx } = setup({ statuses: [401] });
        vault.save(PATH, caseNote({ go: "true" }));
        assert.equal(await watcher.handle(PATH), "failed");
        assert.equal(rx.calls.length, 1);
    });

    it("records delivered after a 2xx", async () => {
        const { watcher, vault, store } = setup({ statuses: [503, 202] });
        vault.save(PATH, caseNote({ go: "true" }));
        assert.equal(await watcher.handle(PATH), "sent");
        assert.equal((await store.get(stateKey(PATH)))?.value.delivery, "delivered");
    });
});

describe("desk-answer plugin: reading the answer", () => {
    const answerOf = (yaml: string) => deskAnswer(parseFrontmatter(`---\n${yaml}\n---\n`).properties)?.kind ?? null;

    it("reads go and answer as the server's failsafe parser gives them", () => {
        assert.equal(answerOf("go: true"), "go");
        assert.equal(answerOf("go: True"), "go");
        assert.equal(answerOf('go: "true"'), "go");
        assert.equal(answerOf("go: false"), null);
        assert.equal(answerOf("go:"), null);
        assert.equal(answerOf(""), null);
        assert.equal(answerOf('answer: ""'), null);
        assert.equal(answerOf("answer:"), null);
        assert.equal(answerOf("answer: null"), null);
        assert.equal(answerOf("answer: ~"), null);
        assert.equal(answerOf('answer: "   "'), null);
        assert.equal(answerOf("answer: no"), "answer");
        assert.equal(answerOf("answer: |\n  two\n  lines"), "answer");
        assert.equal(answerOf('go: true\nanswer: "mine"'), "answer");
    });

    it("whitespace around the same answer is the same answer", () => {
        const a = deskAnswer({ answer: "ship it", ask: "q" });
        const b = deskAnswer({ answer: "  ship it \n", ask: "q" });
        assert.equal(a.fingerprint, b.fingerprint);
    });
});

describe("desk-answer plugin: config and loading", () => {
    it("is off unless a URL and a long enough secret are both set", () => {
        assert.match(readConfig({}).off, /DESK_WEBHOOK_URL is not set/);
        assert.match(readConfig({ DESK_WEBHOOK_URL: URL_ }).off, /SECRET is not set/);
        assert.match(readConfig({ DESK_WEBHOOK_URL: URL_, DESK_WEBHOOK_SECRET: "short" }).off, /shorter than 32/);
        assert.match(readConfig({ DESK_WEBHOOK_URL: "ftp://x/", DESK_WEBHOOK_SECRET: SECRET }).off, /http or https/);
        assert.match(readConfig({ DESK_WEBHOOK_URL: "not a url", DESK_WEBHOOK_SECRET: SECRET }).off, /not a URL/);
        assert.deepEqual(readConfig({ DESK_WEBHOOK_URL: URL_, DESK_WEBHOOK_SECRET: SECRET }), { url: URL_, secret: SECRET });
    });

    const ctxStub = (over: Record<string, unknown> = {}) => {
        const logs: string[] = [];
        const listeners: ((c: { path: string }) => void)[] = [];
        return {
            logs,
            listeners,
            ctx: {
                log: (m: string) => logs.push(m),
                vault: { readNoteRevision: async () => null, listNotes: async () => [] },
                store: scopedStore(new MemoryDocStore(), "desk-answer-webhook.mjs"),
                onNoteChange: (l: any) => listeners.push(l),
                parseFrontmatter,
                ...over,
            },
        };
    };
    const ENV = { DESK_WEBHOOK_URL: URL_, DESK_WEBHOOK_SECRET: SECRET };

    it("stays off, and says why, without config, without CouchDB mode or without ctx.store", () => {
        for (const [over, env, why] of [
            [{}, {}, /DESK_WEBHOOK_URL is not set/],
            [{ onNoteChange: undefined }, ENV, /needs CouchDB mode/],
            [{ store: undefined }, ENV, /needs OPS_DATABASE/],
        ] as const) {
            const s = ctxStub(over as Record<string, unknown>);
            assert.equal(plugin.default(s.ctx, env), undefined);
            assert.equal(s.listeners.length, 0);
            assert.match(s.logs.join("\n"), why);
        }
    });

    it("never logs the secret", async () => {
        const s = ctxStub();
        plugin.default(s.ctx, ENV);
        await new Promise((r) => setImmediate(r));
        assert.equal(s.listeners.length, 1);
        assert.ok(!s.logs.join("\n").includes(SECRET));
    });
});

describe("note change hook", () => {
    it("a listener that throws or rejects never reaches the caller, and the next listener still runs", async () => {
        const warnings: string[] = [];
        const hub = new NoteChangeHub((m) => warnings.push(m));
        const seen: string[] = [];
        hub.subscribe(() => { throw new Error("sync boom"); }, "a.mjs");
        hub.subscribe(async () => { throw new Error("async boom"); }, "b.mjs");
        hub.subscribe(({ path, content }) => { seen.push(`${path}:${content}`); }, "c.mjs");
        hub.emit("x.md", "text");
        hub.emit("y.md", null);
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(seen, ["x.md:text", "y.md:null"]);
        assert.equal(warnings.length, 4);
        assert.match(warnings[0], /\[a\.mjs\].*sync boom/);
    });

    it("loadPlugins gives ctx.onNoteChange only with a hub, and ctx.parseFrontmatter always", async () => {
        const dir = await mkdtemp(join(tmpdir(), "desk-plugin-"));
        try {
            const pluginDir = join(dir, "plugins");
            const vaultDir = join(dir, "vault");
            await import("node:fs/promises").then((fs) => Promise.all([fs.mkdir(pluginDir), fs.mkdir(vaultDir)]));
            const probe = join(pluginDir, "probe.mjs");
            await import("node:fs/promises").then((fs) => fs.writeFile(probe, `
export const seen = [];
export default function (ctx) {
    globalThis.__probe = { hasHook: typeof ctx.onNoteChange === "function", fm: ctx.parseFrontmatter("---\\ngo: true\\n---\\n"), bad: ctx.parseFrontmatter("---\\na: : :\\n---\\n").error !== undefined };
    ctx.onNoteChange?.((c) => { globalThis.__probe.change = c.path; });
}`));
            const base = { vault: new LocalVault(vaultDir), searchIndex: new SearchIndex(join(dir, "idx.json")), vaultName: "t", readOnly: false, writeFolders: parseWriteFolders(undefined) };
            const server = { addTool() {} };
            const g = globalThis as any;
            await loadPlugins(pluginDir, { ...base, server, toolNames: trackToolNames(server) });
            assert.equal(g.__probe.hasHook, false);
            assert.deepEqual(g.__probe.fm, { properties: { go: "true" } });
            assert.equal(g.__probe.bad, true);
            const hub = new NoteChangeHub();
            // A second load imports the same file URL from the module cache; copy it to a new name.
            await copyFile(probe, join(pluginDir, "probe2.mjs"));
            await rm(probe);
            await loadPlugins(pluginDir, { ...base, server, toolNames: trackToolNames(server), noteEvents: hub });
            assert.equal(g.__probe.hasHook, true);
            hub.emit("ToDo/items/moo-1.md", "x");
            assert.equal(g.__probe.change, "ToDo/items/moo-1.md");
            delete g.__probe;
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
