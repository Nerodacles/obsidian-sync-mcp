// Example plugin: call a webhook once per desk answer.
//
// A "case" is a note directly in ToDo/items/ (items.md excluded) whose
// frontmatter carries `go` (a checkbox), `answer` (text), `ask` and
// `recommended`. The owner answers in Obsidian by ticking `go` (accept
// `recommended`) or typing `answer` (wins over `go`). The edit reaches CouchDB
// through LiveSync, so no tool call sees it: the plugin listens to the
// server's changes feed (ctx.onNoteChange) and POSTs one signed event per
// answer to DESK_WEBHOOK_URL.
//
// Config (environment; the plugin is off unless both are set):
//   DESK_WEBHOOK_URL     http(s) URL the event is POSTed to
//   DESK_WEBHOOK_SECRET  shared HMAC key, at least 32 characters
// It also needs CouchDB mode (ctx.onNoteChange, readNoteRevision) and
// OPS_DATABASE (ctx.store, where it records what it already sent). Missing
// any of these, it logs why and stays off; it never stops the server.
//
// The event: POST, body exactly {"path","id","revision","kind"} as JSON (no
// note text), kind "go" | "answer", revision = the note's revision when the
// answer was seen. Headers: X-Desk-Timestamp (unix seconds) and
// X-Desk-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">.
//
// Once per answer: what is recorded per case is a fingerprint of go and
// answer only (kind plus a hash of the trimmed answer), not the revision and
// no other property. So an edit that changes neither go nor answer fires
// nothing (ask, recommended and the body included), the same answer saved
// again fires nothing, and a restart fires nothing already fired. When the
// case returns to go false and an empty answer, that is recorded too, so the
// next answer fires even if it is the same text. Limit: a clear and a new
// identical answer that both land while this server is down (or within one
// feed delivery) look like no change, and fire nothing; the session-start desk
// query still finds that answer.
//
// Delivery is at most once: the fingerprint is claimed in ctx.store (a
// revision-checked write, so two server instances never both send) BEFORE the
// POST. A POST that still fails after 3 attempts is logged and recorded as
// `failed`, and not retried; the session-start desk query stays the backstop.
//
// Startup: changes the server applied before this plugin subscribed are not
// replayed, so at load it sweeps ToDo/items once in the background; the
// record in ctx.store keeps the sweep from re-firing anything already sent.
import { createHash, createHmac } from "node:crypto";

export const FOLDER = "ToDo/items/";
export const MIN_SECRET_LENGTH = 32;
export const ATTEMPTS = 3;
export const TIMEOUT_MS = 5000;
const MAX_CLAIM_ROUNDS = 5;

/** A case note: directly in ToDo/items/, a .md, not the folder's index. */
export function isCasePath(path) {
    if (typeof path !== "string" || !path.startsWith(FOLDER) || !path.endsWith(".md")) return false;
    const name = path.slice(FOLDER.length);
    return name.length > 3 && !name.includes("/") && name !== "items.md";
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Failsafe YAML gives strings: `answer:`, `null` and `~` all mean "no answer". */
function textValue(value) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    return trimmed === "null" || trimmed === "~" ? "" : trimmed;
}

/**
 * The effective desk answer of a case from its properties, or null when the
 * case carries none. A typed answer wins over go.
 */
export function deskAnswer(properties) {
    const answer = textValue(properties.answer);
    if (answer) return { kind: "answer", fingerprint: sha256(`answer\0${answer}`) };
    if (textValue(properties.go).toLowerCase() === "true") return { kind: "go", fingerprint: sha256("go") };
    return null;
}

/** The store key of a case: paths carry "/", which keys can't. */
export const stateKey = (path) => `case.${sha256(path).slice(0, 40)}`;

/** `sha256=<hex>` over "<timestamp>.<body>". */
export function sign(secret, timestamp, body) {
    return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

/** The plugin's config from the environment: { url, secret } or { off: reason }. */
export function readConfig(env) {
    const url = env.DESK_WEBHOOK_URL?.trim();
    const secret = env.DESK_WEBHOOK_SECRET?.trim();
    if (!url) return { off: "DESK_WEBHOOK_URL is not set" };
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return { off: "DESK_WEBHOOK_URL is not a URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { off: "DESK_WEBHOOK_URL must be http or https" };
    if (!secret) return { off: "DESK_WEBHOOK_SECRET is not set (an unsigned webhook is never sent)" };
    if (secret.length < MIN_SECRET_LENGTH) return { off: `DESK_WEBHOOK_SECRET is shorter than ${MIN_SECRET_LENGTH} characters` };
    return { url, secret };
}

/**
 * The watcher, with its dependencies passed in so tests can drive it:
 * vault.readNoteRevision / vault.listNotes, a ctx.store, parseFrontmatter,
 * fetch, sleep and now.
 */
export function createDeskWatcher({ vault, store, parseFrontmatter, url, secret, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), random = Math.random, log = () => {} }) {
    const chains = new Map();
    const stats = { fired: 0, delivered: 0, failed: 0, skipped: 0 };

    async function deliver(payload) {
        const body = JSON.stringify(payload);
        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
            const timestamp = String(Math.floor(now() / 1000));
            let status = 0;
            let reason;
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-desk-timestamp": timestamp, "x-desk-signature": sign(secret, timestamp, body) },
                    body,
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
                status = res.status;
                if (status >= 200 && status < 300) return { ok: true, status, attempts: attempt };
                reason = `HTTP ${status}`;
            } catch (err) {
                reason = err?.cause?.code || err?.name || "error";
            }
            // A refusal the receiver means (bad signature, bad payload) won't change on a retry.
            if (status >= 400 && status < 500 && status !== 408 && status !== 429) return { ok: false, status, attempts: attempt, reason };
            if (attempt < ATTEMPTS) await sleep(1000 * 4 ** (attempt - 1) + Math.floor(random() * 250));
            else return { ok: false, status, attempts: attempt, reason };
        }
    }

    async function check(path) {
        const note = await vault.readNoteRevision(path);
        if (!note) return "gone";
        const { properties, error } = parseFrontmatter(note.content);
        if (error) return "unreadable";
        const current = deskAnswer(properties);
        const key = stateKey(path);
        for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
            const record = await store.get(key);
            const fired = record?.value?.fingerprint ?? null;
            if (current === null) {
                if (fired === null) return "none";
                // The case was cleared: remember it, so the next answer fires even if it repeats this one.
                const reset = await store.put(key, { fingerprint: null, path, revision: note.revision, at: new Date(now()).toISOString() }, record.revision);
                if ("conflict" in reset) continue;
                return "reset";
            }
            if (fired === current.fingerprint) return "already";
            const value = { fingerprint: current.fingerprint, kind: current.kind, path, revision: note.revision, at: new Date(now()).toISOString(), delivery: "pending" };
            const claim = await store.put(key, value, record?.revision ?? null);
            if ("conflict" in claim) continue; // another instance moved first: decide again on what it wrote
            stats.fired++;
            const id = textValue(properties.id) || path.slice(FOLDER.length, -3);
            const result = await deliver({ path, id, revision: note.revision, kind: current.kind });
            if (result.ok) stats.delivered++;
            else stats.failed++;
            log(`${result.ok ? "sent" : "NOT sent"} ${current.kind} for ${path} at ${note.revision} (${result.ok ? `HTTP ${result.status}` : result.reason}, ${result.attempts} attempt${result.attempts === 1 ? "" : "s"})`);
            // Best effort: the claim above is what prevents a second send; this only records how it went.
            await store.put(key, { ...value, delivery: result.ok ? "delivered" : "failed" }, claim.revision).catch(() => undefined);
            return result.ok ? "sent" : "failed";
        }
        stats.skipped++;
        log(`gave up on ${path}: its record kept changing`);
        return "contended";
    }

    /** Check a case, one check per path at a time. Never rejects. */
    function handle(path) {
        if (!isCasePath(path)) return Promise.resolve("ignored");
        const previous = chains.get(path) ?? Promise.resolve();
        const run = previous.then(() => check(path)).catch((err) => {
            log(`check of ${path} failed: ${err?.message ?? err}`);
            return "error";
        });
        chains.set(path, run);
        run.then(() => {
            if (chains.get(path) === run) chains.delete(path);
        });
        return run;
    }

    /** Check every case once (startup). Never rejects. */
    async function sweep() {
        let paths;
        try {
            paths = await vault.listNotes(FOLDER.slice(0, -1));
        } catch (err) {
            log(`startup sweep could not list ${FOLDER}: ${err?.message ?? err}`);
            return [];
        }
        const results = [];
        for (const path of paths.filter(isCasePath)) results.push(await handle(path));
        return results;
    }

    return { handle, sweep, stats };
}

export default function deskAnswerWebhook(ctx, env = process.env) {
    const config = readConfig(env);
    const off = (reason) => {
        ctx.log(`off: ${reason}.`);
    };
    if ("off" in config) return off(config.off);
    if (!ctx.onNoteChange || !ctx.vault.readNoteRevision) return off("needs CouchDB mode (the changes feed and note revisions)");
    if (!ctx.store) return off("needs OPS_DATABASE (ctx.store records what was already sent; without it a restart would send again)");
    const watcher = createDeskWatcher({
        vault: ctx.vault,
        store: ctx.store,
        parseFrontmatter: ctx.parseFrontmatter,
        url: config.url,
        secret: config.secret,
        log: ctx.log,
    });
    ctx.onNoteChange(({ path }) => {
        if (isCasePath(path)) void watcher.handle(path);
    });
    ctx.log(`on: answers in ${FOLDER} are sent to ${new URL(config.url).origin}.`);
    void watcher.sweep().then((results) => {
        const sent = results.filter((r) => r === "sent" || r === "failed").length;
        ctx.log(`startup sweep: ${results.length} cases checked, ${sent} new answers.`);
    });
    return watcher;
}
