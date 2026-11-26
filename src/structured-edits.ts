/**
 * Edits that change one part of a note and leave every other byte as it was:
 * set_properties (frontmatter keys) and append_to_section (one line under a
 * heading). Both are pure text functions, so the revision-checked write path
 * can re-apply them to newer text when another writer got in first.
 */
import { isMap, isScalar, parseDocument, stringify, type Document, type Node, type Pair } from "yaml";

/** An edit that can't be applied to the note's current text. */
export class EditRefused extends Error {}

export type PropertyScalar = string | number | boolean;
export type PropertyValue = PropertyScalar | PropertyScalar[];

// "---" first line, the YAML, then a line that is just "---"; CRLF or LF. The
// YAML group is absent for "---\n---".
const FRONTMATTER = /^(---[ \t]*(\r?\n))(?:([\s\S]*?)(\r?\n))?(---[ \t]*(?:\r?\n|$))/;

/** A YAML scalar as one line: the library picks plain or quoted, a value with a line break is double-quoted. */
function scalarText(value: PropertyScalar): string {
    if (typeof value === "string" && /[\r\n]/.test(value)) return JSON.stringify(value);
    return stringify(value, { lineWidth: 0 }).replace(/\n$/, "");
}

/** What follows a key: `: value`, or `:` and a block list; an empty list is `: []`. */
function valueText(value: PropertyValue, indent: string, eol: string): string {
    if (!Array.isArray(value)) return `: ${scalarText(value)}`;
    if (value.length === 0) return ": []";
    return ":" + value.map((item) => `${eol}${indent}  - ${scalarText(item)}`).join("");
}

function parseFrontmatter(yaml: string): Document {
    // Default (core) schema with unique keys: a duplicated key is an error, and
    // values compare with the types Obsidian shows (number, boolean, text).
    const doc = parseDocument(yaml);
    if (doc.errors.length > 0) {
        throw new EditRefused(`The frontmatter isn't valid YAML (${doc.errors[0].message.split("\n")[0].replace(/:$/, "")}). Nothing was changed; fix it first.`);
    }
    return doc;
}

/** The plain-object view used to check the result: keys in order, values as YAML resolves them. */
function asObject(doc: Document): Record<string, unknown> {
    const value = doc.toJS({ maxAliasCount: -1 });
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** A key as the note spells it: a string key by its value, any other scalar key as written (so `1.0:` stays "1.0"). */
function keyName(pair: Pair, yaml: string): string | null {
    const key = pair.key as Node | null;
    if (!isScalar(key)) return null;
    if (typeof key.value === "string") return key.value;
    return key.range ? yaml.slice(key.range[0], key.range[1]) : String(key.value);
}

/** End of a value without the line breaks a block value's range ends with. */
function valueEnd(yaml: string, pair: Pair): number {
    const key = pair.key as Node;
    const value = pair.value as Node | null;
    let end = value?.range ? Math.max(value.range[1], key.range![1]) : key.range![1];
    while (end > key.range![1] && (yaml[end - 1] === "\n" || yaml[end - 1] === "\r")) end--;
    return end;
}

/**
 * Set and remove frontmatter properties. Only the text of the keys named is
 * rewritten; comments, order, quoting and layout of every other key, and the
 * body, stay byte for byte. A changed key keeps its place (and a comment
 * after a scalar value), a new key goes at the end of the frontmatter, a
 * removed key loses its lines. A note without frontmatter gets one.
 */
export function setProperties(content: string, set: Record<string, PropertyValue>, remove: string[] = []): string {
    const keys = [...Object.keys(set), ...remove];
    if (keys.length === 0) throw new EditRefused("Nothing to change: give at least one property in set or remove.");
    for (const key of keys) {
        if (key.trim() === "" || /[\r\n]/.test(key)) throw new EditRefused(`Invalid property name ${JSON.stringify(key)}: it must be non-empty and on one line.`);
    }
    const both = remove.find((key) => Object.hasOwn(set, key));
    if (both !== undefined) throw new EditRefused(`Property ${JSON.stringify(both)} is in both set and remove.`);

    const fm = content.match(FRONTMATTER);
    if (!fm) {
        const additions = Object.entries(set);
        if (additions.length === 0) return content;
        const eol = content.includes("\r\n") ? "\r\n" : "\n";
        return `---${eol}${additions.map(([k, v]) => scalarText(k) + valueText(v, "", eol)).join(eol)}${eol}---${eol}` + content;
    }
    const [whole, open, openEol, yamlGroup, yamlEol, close] = fm;
    const yaml = yamlGroup ?? "";
    const eol = yamlEol ?? openEol;
    const doc = parseFrontmatter(yaml);
    if (doc.contents !== null && (!isMap(doc.contents) || doc.contents.flow)) {
        throw new EditRefused("The frontmatter isn't a block of `key: value` lines. Nothing was changed.");
    }
    const pairs = isMap(doc.contents) ? (doc.contents.items as Pair[]) : [];
    const before = asObject(doc);

    // Splices on the original text, applied from the end so offsets stay valid.
    const splices: { start: number; end: number; text: string }[] = [];
    const additions: string[] = [];
    const indent = pairs.length > 0 ? lineIndent(yaml, (pairs[0].key as Node).range![0]) : "";
    for (const [key, value] of Object.entries(set)) {
        const pair = pairs.find((p) => keyName(p, yaml) === key);
        if (!pair) {
            additions.push(scalarText(key) + valueText(value, indent, eol));
            continue;
        }
        const keyNode = pair.key as Node;
        // After the key, so the key keeps its spelling and quoting.
        splices.push({ start: keyNode.range![1], end: valueEnd(yaml, pair), text: valueText(value, lineIndent(yaml, keyNode.range![0]), eol) });
    }
    for (const key of remove) {
        const pair = pairs.find((p) => keyName(p, yaml) === key);
        if (!pair) continue;
        let start = yaml.lastIndexOf("\n", (pair.key as Node).range![0] - 1) + 1;
        const newline = yaml.indexOf("\n", valueEnd(yaml, pair));
        let end = newline === -1 ? yaml.length : newline + 1;
        // The last line has no line break of its own: take the one before it.
        if (newline === -1 && start > 0) start -= yaml[start - 2] === "\r" ? 2 : 1;
        splices.push({ start, end, text: "" });
    }
    splices.sort((a, b) => b.start - a.start);
    let next = yaml;
    for (const s of splices) next = next.slice(0, s.start) + s.text + next.slice(s.end);
    if (additions.length > 0) next = next + (next === "" ? "" : eol) + additions.join(eol);
    if (next === yaml) return content;

    // The splice must have changed exactly what was asked; anything else
    // (an anchor another key points to, a layout this can't edit in place)
    // is refused rather than written.
    const expected: Record<string, unknown> = { ...before };
    for (const [key, value] of Object.entries(set)) expected[key] = value;
    for (const key of remove) delete expected[key];
    let after: Record<string, unknown> | null = null;
    try {
        const nextDoc = parseDocument(next);
        if (nextDoc.errors.length === 0) after = asObject(nextDoc);
    } catch { /* refused below */ }
    if (after === null || JSON.stringify(after) !== JSON.stringify(expected)) {
        throw new EditRefused("These properties can't be changed without rewriting other parts of the frontmatter (an anchor, alias or unusual layout). Nothing was changed; use write_note.");
    }
    return content.slice(0, open.length) + (next === "" ? "" : next + eol) + close + content.slice(whole.length);
}

function lineIndent(text: string, offset: number): string {
    const start = text.lastIndexOf("\n", offset - 1) + 1;
    return text.slice(start, offset).replace(/[^ \t]/g, " ");
}

// An ATX heading: up to 3 spaces, 1-6 #, then the text (an optional closing run of # is not part of it).
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** `openAfter`: a fenced code block is still open after this line. */
interface Line { start: number; end: number; text: string; heading?: { level: number; text: string }; openAfter: boolean }

/** The body's lines (after any frontmatter), with headings outside fenced code marked. */
function bodyLines(content: string): Line[] {
    const fm = content.match(FRONTMATTER);
    let offset = fm ? fm[0].length : 0;
    const lines: Line[] = [];
    let fence: { char: string; length: number } | null = null;
    while (offset < content.length) {
        const newline = content.indexOf("\n", offset);
        const end = newline === -1 ? content.length : newline + 1;
        const text = content.slice(offset, end).replace(/\r?\n$/, "");
        const line: Line = { start: offset, end, text, openAfter: false };
        const f = text.match(FENCE);
        if (fence) {
            // A closing fence: the same character, at least as long, nothing after it.
            if (f && f[1][0] === fence.char && f[1].length >= fence.length && f[2].trim() === "") fence = null;
        } else if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
            fence = { char: f[1][0], length: f[1].length };
        } else {
            const h = text.match(HEADING);
            if (h) line.heading = { level: h[1].length, text: (h[2] ?? "").trim() };
        }
        line.openAfter = fence !== null;
        lines.push(line);
        offset = end;
    }
    return lines;
}

function checkOneLine(what: string, value: string): void {
    if (/[\r\n]/.test(value)) throw new EditRefused(`${what} must be a single line (no line breaks). Nothing was changed.`);
    if (value.trim() === "") throw new EditRefused(`${what} is empty. Nothing was changed.`);
}

/**
 * Append one line at the end of the section under the first heading (any
 * level) whose text is `heading`: after the section's last non-blank line,
 * before the next heading of the same or a higher level, so blank lines
 * before that heading stay. Headings inside fenced code don't count. When no
 * heading matches, refuse, or with createHeading add `## heading` and the line
 * at the end of the note.
 */
export function appendToSection(content: string, heading: string, line: string, createHeading = false): string {
    // "## Log" and "Log" name the same heading.
    const wanted = heading.replace(/^#{1,6}[ \t]+/, "").trim();
    checkOneLine("heading", wanted);
    checkOneLine("line", line);
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = bodyLines(content);
    const at = lines.findIndex((l) => l.heading?.text === wanted);
    if (at === -1) {
        if (!createHeading) throw new EditRefused(`Heading not found: ${JSON.stringify(wanted)}. Nothing was changed; pass create_heading: true to add it at the end of the note.`);
        if (lines.at(-1)?.openAfter) throw new EditRefused("The note ends inside an unclosed code block, so a heading added at the end would be code. Nothing was changed.");
        let head = content;
        if (head !== "" && !head.endsWith("\n")) head += eol;
        const gap = head === "" || /(^|\n)[ \t]*\r?\n$/.test(head) ? "" : eol;
        return `${head}${gap}## ${wanted}${eol}${line}${eol}`;
    }
    const level = lines[at].heading!.level;
    let stop = lines.findIndex((l, i) => i > at && l.heading !== undefined && l.heading.level <= level);
    if (stop === -1) stop = lines.length;
    let last = at;
    for (let i = at + 1; i < stop; i++) if (lines[i].text.trim() !== "") last = i;
    if (lines[last].openAfter) {
        throw new EditRefused("The section ends inside an unclosed code block, so the line would be code. Nothing was changed.");
    }
    const after = lines[last];
    const ending = content.slice(after.start + after.text.length, after.end);
    const insertAt = after.end;
    // The line after which it goes may be the note's last, without a line break.
    const lead = ending === "" ? eol : "";
    return content.slice(0, insertAt) + lead + line + eol + content.slice(insertAt);
}
