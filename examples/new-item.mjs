/**
 * new_item: create the next numbered work item, `ToDo/items/moo-NNN.md`.
 *
 * Load it with PLUGIN_DIR (copy this file into that directory). It needs
 * OPS_DATABASE, for `ctx.store`, and write access to the folder, for example
 * WRITE_FOLDERS=ToDo:create+update.
 *
 * Numbering. Numbers are unique when several agents and several server
 * instances call new_item at once, and never handed out twice. The counter
 * (key `counter` in ctx.store) is the last number RESERVED, and a number is
 * reserved before its note is created:
 *
 *  1. read the counter and list the folder once; the candidate is
 *     max(counter, highest `moo-<digits>.md` in the folder) + 1, so notes made
 *     by hand are never overwritten and a lost counter recovers;
 *  2. reserve it: raise the counter to it by compare-and-swap. On a conflict
 *     (another caller reserved first) take max(candidate, their value + 1)
 *     and try again; the counter only ever goes up;
 *  3. create the note create-only at the reserved number. If a note is
 *     already there (made outside new_item since the listing), that number
 *     stays unused and the next one is reserved.
 *
 * Gaps, never reuse: a number is left unused only when it was reserved and
 * then not created (its create was refused, or the server stopped between
 * reserving and creating). A note that is later deleted keeps its number
 * reserved in the counter, even though the server's create-only write would
 * re-create a deleted path. Steps 2-3 together are bounded by MAX_ROUNDS;
 * when they run out nothing is written.
 *
 * op_id: the tool is added with `writes: true`, so the server gives it the
 * same op_id handling as its built-in write tools (with OPS_DATABASE): a retry
 * with the same op_id and arguments returns the first answer and creates
 * nothing, on any instance.
 *
 * `created` is today's date (YYYY-MM-DD) in NEW_ITEM_TIMEZONE, else the
 * server's DISPLAY_TIMEZONE, else UTC. An invalid NEW_ITEM_TIMEZONE stops
 * startup; an invalid DISPLAY_TIMEZONE falls back to UTC, as the server does.
 *
 * Plain JavaScript with no imports: it runs from any directory, against the
 * built server.
 */

export const FOLDER = "ToDo/items";
export const PREFIX = "moo";
/** Reservation conflicts plus refused creates per call. 20 callers racing on one counter need up to 20; this leaves room. */
export const MAX_ROUNDS = 100;
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

/** The title as the heading shows it: without `#`, so Obsidian reads no tag there. */
export function headingTitle(title) {
    return title.replace(/#/g, "").replace(/\s+/g, " ").trim();
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
    const shown = headingTitle(title);
    lines.push("---", "", shown ? `# ${id} ${shown}` : `# ${id}`, "");
    let text = lines.join("\n");
    const extra = (body ?? "").replace(/\r\n/g, "\n").replace(/^\n+|\s+$/g, "");
    if (extra) text += "\n" + extra + "\n";
    return text;
}

function validZone(zone) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** The zone for `created`: { zone, source }. Throws on an invalid NEW_ITEM_TIMEZONE. */
export function resolveTimeZone(env) {
    const own = env.NEW_ITEM_TIMEZONE?.trim();
    if (own) {
        if (!validZone(own)) throw new Error(`NEW_ITEM_TIMEZONE ${JSON.stringify(own)} is not a valid IANA time zone.`);
        return { zone: own, source: "NEW_ITEM_TIMEZONE" };
    }
    const display = env.DISPLAY_TIMEZONE?.trim();
    if (display && validZone(display)) return { zone: display, source: "DISPLAY_TIMEZONE" };
    return { zone: "UTC", source: display ? "UTC (DISPLAY_TIMEZONE is not valid)" : "UTC" };
}

/** `date` as YYYY-MM-DD in `zone`. */
export function localDate(date, zone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(date).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function deepLink(vaultName, path) {
    return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
}

const isTaken = (err) => err?.name === "PluginWriteError" && err.code === "exists";

/**
 * Reserve a number, then create the note at it. Returns
 *   { created: true, n, path, gaps, conflicts }  or
 *   { created: false, gaps, conflicts }  (rounds exhausted; nothing written),
 * where `gaps` are numbers reserved and left unused because a note was
 * already there, and `conflicts` the reservations lost to other callers.
 * Any other write refusal is thrown with `reserved` set to the number it
 * left unused.
 */
export async function createItem({ store, vault }, render) {
    let counter = await store.get(COUNTER_KEY);
    let next = Math.max(counterValue(counter), highestNumber(await vault.listNotes(FOLDER))) + 1;
    const gaps = [];
    let conflicts = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
        const n = Math.max(next, counterValue(counter) + 1);
        const res = await store.put(COUNTER_KEY, n, counter?.revision ?? null);
        if (res.conflict) {
            conflicts++;
            counter = res.current;
            continue;
        }
        counter = { value: n, revision: res.revision };
        try {
            await vault.writeNote(itemPath(n), render(n), { createOnly: true });
        } catch (err) {
            if (!isTaken(err)) {
                if (err && typeof err === "object") err.reserved = n;
                throw err;
            }
            gaps.push(n);
            next = n + 1;
            continue;
        }
        return { created: true, n, path: itemPath(n), gaps, conflicts };
    }
    return { created: false, gaps, conflicts };
}

export default function register(ctx) {
    const { z } = ctx;
    const { zone, source } = resolveTimeZone(process.env);
    ctx.log(`new_item: created dates in ${zone} (${source}).`);
    const value = z.union([z.string(), z.number(), z.boolean()]);
    ctx.addTool({
        name: "new_item",
        writes: true,
        description:
            `Create the next numbered work item, ${FOLDER}/${PREFIX}-NNN.md, with a fresh number that no other caller gets and that is never reused. ` +
            `Frontmatter: id, title, created (today's date in ${zone}), state (new unless given in fields) and any fields you pass. ` +
            "The body starts with a heading '# <id> <title>' (without # characters from the title), then your body text. Returns the id and path. " +
            "Pass an op_id to make a retry safe: the same op_id returns the first answer and creates nothing.",
        parameters: z.object({
            title: z.string().trim().min(1).max(200).describe("One line."),
            body: z.string().max(100_000).optional().describe("Markdown placed after the heading."),
            fields: z.record(z.string(), z.union([value, z.array(value)])).optional()
                .describe("Extra frontmatter: strings, numbers, booleans, or lists of them. id, title and created are set by the tool."),
        }),
        execute: async ({ title, body, fields }) => {
            if (!ctx.store) return "new_item needs OPS_DATABASE (CouchDB mode) for its counter. Nothing was written.";
            if (/[\r\n]/.test(title)) return "title must be one line. Nothing was written.";
            const bad = checkFields(fields);
            if (bad) return `${bad} Nothing was written.`;
            const created = localDate(new Date(), zone);
            let result;
            try {
                result = await createItem(ctx, (n) => renderNote(n, { title, body, fields, created }));
            } catch (err) {
                if (err?.name !== "PluginWriteError") throw err;
                return `${err.message}\nNothing was written; ${formatId(err.reserved)} was reserved and stays unused.`;
            }
            const unused = result.gaps.length ? `Reserved but already taken, left unused: ${result.gaps.map(formatId).join(", ")}.` : null;
            if (!result.created) {
                return `Could not allocate an item number in ${MAX_ROUNDS} rounds (${result.conflicts} reservations lost to other callers). ` +
                    `Nothing was written; try again.${unused ? "\n" + unused : ""}`;
            }
            const lines = [`Created ${formatId(result.n)}: ${result.path}`, `[Open in Obsidian](${deepLink(ctx.vaultName, result.path)})`];
            if (unused) lines.push(unused);
            return lines.join("\n");
        },
    });
}
