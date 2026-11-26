/**
 * new_item: create the next numbered work item, `ToDo/items/moo-NNN.md`.
 *
 * Load it with PLUGIN_DIR (copy this file into that directory). It needs
 * OPS_DATABASE, for `ctx.store`, and write access to the folder, for example
 * WRITE_FOLDERS=ToDo:create+update.
 *
 * Numbering. Numbers are never reused and must stay unique when several
 * agents and several server instances call new_item at once. The next number
 * is max(counter, highest number among the notes in the folder) + 1:
 *
 *  1. read the counter (key `counter` in ctx.store, the last number handed out);
 *  2. list the folder once and take the highest `moo-<digits>.md` in it, so
 *     notes made by hand are never overwritten and a lost counter recovers;
 *  3. create the note create-only; if that number is taken (another caller got
 *     there first), re-read the counter and try the next free candidate, up to
 *     MAX_CREATE_ATTEMPTS times; nothing is written when every attempt is refused;
 *  4. raise the counter to the number used, by compare-and-swap, never lowering
 *     it. If that fails the note still exists and the answer says so: the next
 *     call finds the note in step 2.
 *
 * Gaps: a number is skipped only when a create at it was refused.
 *
 * Limits (stated, not hidden):
 *  - The note is created before the counter is raised. A note that is deleted
 *    after a crash between those two steps leaves its number unknown to both
 *    the counter and the folder listing, and the server's create-only write
 *    re-creates a path whose note was deleted, so that number can be handed
 *    out again. Without that crash, the counter remembers every number.
 *  - op_id: the server's op_id records cover its built-in write tools only,
 *    not plugin tools. new_item therefore refuses a call that carries op_id
 *    rather than silently ignoring it: a retry after a timeout would create a
 *    second item. List the folder before retrying.
 *
 * Plain JavaScript with no imports: it runs from any directory, against the
 * built server.
 */

export const FOLDER = "ToDo/items";
export const PREFIX = "moo";
/** 20 callers racing from one snapshot need up to 20 attempts; this leaves room. */
export const MAX_CREATE_ATTEMPTS = 64;
export const MAX_RAISE_ATTEMPTS = 64;
export const COUNTER_KEY = "counter";

const RESERVED_FIELDS = new Set(["id", "title", "created"]);
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const ITEM_FILE = new RegExp(`^${FOLDER}/${PREFIX}-(\\d+)\\.md$`);

export function formatId(n) {
    return `${PREFIX}-${String(n).padStart(3, "0")}`;
}

export function itemPath(n) {
    return `${FOLDER}/${formatId(n)}.md`;
}

/** Highest item number among `paths` (0 when there is none). Any digit count counts, so moo-0042 is 42. */
export function highestNumber(paths) {
    let max = 0;
    for (const p of paths) {
        const m = ITEM_FILE.exec(p);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
}

function counterValue(stored) {
    const v = stored?.value;
    return Number.isSafeInteger(v) && v > 0 ? v : 0;
}

// YAML scalars: strings are always double-quoted JSON strings (valid YAML), so
// "true", "1.10", "2026-01-01" or "a: b" stay strings; numbers and booleans
// are written plain so Obsidian shows them as numbers and checkboxes.
function scalar(value, name) {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    throw new TypeError(`field ${name}: only strings, finite numbers, booleans and lists of them`);
}

/** Check `fields`; returns an error message, or null when they are fine. */
export function checkFields(fields) {
    for (const [name, value] of Object.entries(fields ?? {})) {
        if (!FIELD_NAME.test(name)) return `Field name ${JSON.stringify(name)} is not allowed: letters, digits, _ and -, starting with a letter or _.`;
        if (RESERVED_FIELDS.has(name)) return `Field ${name} is set by new_item and can't be given.`;
        try {
            for (const v of Array.isArray(value) ? value : [value]) scalar(v, name);
        } catch {
            return `Field ${name}: only strings, finite numbers, booleans and lists of them.`;
        }
    }
    return null;
}

/** The note's text. `title` is one line; `fields` passed checkFields. */
export function renderNote(n, { title, body, fields = {}, created }) {
    const id = formatId(n);
    const lines = ["---", `id: ${id}`, `title: ${JSON.stringify(title)}`, `created: ${created}`];
    if (!("state" in fields)) lines.push("state: new");
    for (const [name, value] of Object.entries(fields)) {
        if (!Array.isArray(value)) lines.push(`${name}: ${scalar(value, name)}`);
        else if (value.length === 0) lines.push(`${name}: []`);
        else lines.push(`${name}:`, ...value.map((v) => `  - ${scalar(v, name)}`));
    }
    lines.push("---", "", `# ${id} ${title}`, "");
    let text = lines.join("\n");
    const extra = (body ?? "").replace(/\r\n/g, "\n").replace(/^\n+|\s+$/g, "");
    if (extra) text += "\n" + extra + "\n";
    return text;
}

export function deepLink(vaultName, path) {
    return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
}

const isTaken = (err) => err?.name === "PluginWriteError" && err.code === "exists";

/**
 * Allocate a number and create the note. Returns
 *   { created: true, n, path, skipped, counterRaised }  or
 *   { created: false, skipped }  (every attempt refused; nothing written).
 * Any other write refusal (WRITE_FOLDERS, read-only, CouchDB failure) is thrown.
 */
export async function createItem({ store, vault }, render) {
    let counter = await store.get(COUNTER_KEY);
    const fromFiles = highestNumber(await vault.listNotes(FOLDER));
    let n = Math.max(counterValue(counter), fromFiles) + 1;
    const skipped = [];
    let created = false;
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
        try {
            await vault.writeNote(itemPath(n), render(n), { createOnly: true });
            created = true;
            break;
        } catch (err) {
            if (!isTaken(err)) throw err;
            skipped.push(n);
            // Someone else took n; others may have moved the counter further on.
            counter = await store.get(COUNTER_KEY);
            n = Math.max(n, counterValue(counter)) + 1;
        }
    }
    if (!created) return { created: false, skipped };

    // Raise the counter to n, never lowering it.
    let counterRaised = false;
    for (let attempt = 0; attempt < MAX_RAISE_ATTEMPTS; attempt++) {
        if (counterValue(counter) >= n) {
            counterRaised = true;
            break;
        }
        const res = await store.put(COUNTER_KEY, n, counter?.revision ?? null);
        if (!res.conflict) {
            counterRaised = true;
            break;
        }
        counter = res.current;
    }
    return { created: true, n, path: itemPath(n), skipped, counterRaised };
}

export default function register(ctx) {
    const { z } = ctx;
    const value = z.union([z.string(), z.number(), z.boolean()]);
    ctx.addTool({
        name: "new_item",
        description:
            `Create the next numbered work item, ${FOLDER}/${PREFIX}-NNN.md, with a fresh number that no other caller gets and that is never reused. ` +
            "Frontmatter: id, title, created (today, UTC date), state (new unless given in fields) and any fields you pass. " +
            "The body starts with a heading '# <id> <title>', then your body text. Returns the id and path. " +
            "op_id is not supported for this tool: a call with op_id is refused, so after a timeout list the folder before calling again.",
        parameters: z.object({
            title: z.string().trim().min(1).max(200).describe("One line."),
            body: z.string().max(100_000).optional().describe("Markdown placed after the heading."),
            fields: z.record(z.string(), z.union([value, z.array(value)])).optional()
                .describe("Extra frontmatter: strings, numbers, booleans, or lists of them. id, title and created are set by the tool."),
            op_id: z.string().optional().describe("Not supported: a call with op_id is refused without writing."),
        }),
        execute: async ({ title, body, fields, op_id }) => {
            if (op_id !== undefined) {
                return "new_item does not support op_id: the server's op_id records cover only its built-in write tools, so a retry could not be recognised. " +
                    `Nothing was written. Call again without op_id; after a timeout, list ${FOLDER} first to see whether the item was created.`;
            }
            if (!ctx.store) return "new_item needs OPS_DATABASE (CouchDB mode) for its counter. Nothing was written.";
            if (/[\r\n]/.test(title)) return "title must be one line. Nothing was written.";
            const bad = checkFields(fields);
            if (bad) return `${bad} Nothing was written.`;
            const created = new Date().toISOString().slice(0, 10);
            const result = await createItem(ctx, (n) => renderNote(n, { title, body, fields, created }));
            if (!result.created) {
                return `Could not allocate an item number: ${MAX_CREATE_ATTEMPTS} numbers in a row were taken by other callers ` +
                    `(${formatId(result.skipped[0])} to ${formatId(result.skipped.at(-1))}). Nothing was written; try again.`;
            }
            const id = formatId(result.n);
            const lines = [`Created ${id}: ${result.path}`, `[Open in Obsidian](${deepLink(ctx.vaultName, result.path)})`];
            if (result.skipped.length) lines.push(`Taken by other callers first: ${result.skipped.map(formatId).join(", ")}.`);
            if (!result.counterRaised) lines.push(`Warning: the counter could not be raised to ${result.n}; the note exists, and the next call still sees it in ${FOLDER}.`);
            return lines.join("\n");
        },
    });
}
