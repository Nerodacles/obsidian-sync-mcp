/**
 * Link rewriting and alias insertion for rename_note. Pure text functions:
 * the tool in tools.ts reads and writes the notes.
 */

import { posix } from "path";
import MarkdownIt from "markdown-it";
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, type Node as YamlNode } from "yaml";

// The frontmatter block, as parse.ts reads it, but on text that may still use CRLF.
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

// Group 1 is the target, group 2 the rest: #heading, #^block, |label or, in a
// table, \|label (the backslash then ends group 1). Same target shape as the
// index's WIKILINK in parse.ts, so both agree on what a wikilink is.
const WIKILINK = /\[\[([^[\]|#\n]+)([^[\]\n]*)\]\]/g;

// [text](href "title") and ![alt](href). Group 1 is everything up to the
// href, group 2 the href (bare or <angle-bracketed>), group 3 the rest.
const MDLINK = /(!?\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\(\s*)(<[^<>\n]*>|[^\s()<>]+)((?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\))/g;

const markdown = new MarkdownIt({ html: true, linkify: false });

const lower = (s: string) => s.toLowerCase();
const stripMd = (p: string) => (lower(p).endsWith(".md") ? p.slice(0, -3) : p);
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** The note name Obsidian shows for a path: the file name without `.md`. */
export function noteName(path: string): string {
    return stripMd(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * Where a link target written in `source` points among `notes`, the way
 * Obsidian resolves it: `./` and `../` paths relative to the source's folder;
 * otherwise the vault path, then the path relative to the source's folder,
 * then the one note whose path ends with the target. Case-insensitive, like
 * LiveSync. "ambiguous" when several notes end with the target.
 */
export function resolveLink(target: string, source: string, notes: readonly string[]): string | "ambiguous" | null {
    const byLower = new Map(notes.map((n) => [lower(n), n]));
    const withMd = lower(target).endsWith(".md") ? target : target + ".md";
    const find = (p: string) => byLower.get(lower(p)) ?? null;
    if (/^\.\.?\//.test(withMd)) return find(posix.normalize(posix.join(dirOf(source), withMd)).replace(/^\/+/, ""));
    const plain = withMd.replace(/^\/+/, "");
    const exact = find(plain) ?? find(posix.join(dirOf(source), plain));
    if (exact) return exact;
    const suffix = "/" + lower(plain);
    const hits = notes.filter((n) => lower(n) === lower(plain) || lower(n).endsWith(suffix));
    if (hits.length === 1) return hits[0];
    return hits.length > 1 ? "ambiguous" : null;
}

/**
 * Byte ranges [start, end) of fenced code blocks and inline code spans,
 * where Obsidian doesn't link and nothing is rewritten. Indented code is not
 * among them: the index reads it as text (footnote continuations are
 * indented), so the rewriter does too.
 */
export function codeRanges(content: string, bodyStart: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const body = content.slice(bodyStart);
    const lineStarts = [0];
    for (let i = 0; i < body.length; i++) if (body[i] === "\n") lineStarts.push(i + 1);
    const lineOffset = (line: number) => bodyStart + (line < lineStarts.length ? lineStarts[line] : body.length);
    for (const token of markdown.parse(body, {})) {
        if (token.type === "fence" && token.map) ranges.push([lineOffset(token.map[0]), lineOffset(token.map[1])]);
    }
    const fences = [...ranges];
    const inFence = (i: number) => fences.some(([s, e]) => i >= s && i < e);
    // A run of N backticks opens a span closed by the next run of exactly N,
    // within one paragraph (no blank line between) and outside fences.
    let i = bodyStart;
    while (i < content.length) {
        if (content[i] !== "`" || inFence(i)) { i++; continue; }
        let escapes = 0;
        for (let j = i - 1; j >= bodyStart && content[j] === "\\"; j--) escapes++;
        let n = 0;
        while (content[i + n] === "`") n++;
        if (escapes % 2 === 1) { i += n; continue; }
        let close = -1;
        for (let j = i + n; j < content.length; ) {
            if (inFence(j) || /^\n[ \t]*\r?\n/.test(content.slice(j, j + 64))) break;
            if (content[j] !== "`") { j++; continue; }
            let m = 0;
            while (content[j + m] === "`") m++;
            if (m === n) { close = j + m; break; }
            j += m;
        }
        if (close === -1) { i += n; continue; }
        ranges.push([i, close]);
        i = close;
    }
    return ranges.sort((a, b) => a[0] - b[0]);
}

export interface RewriteResult {
    content: string;
    /** Links changed to point at the new path. */
    rewritten: number;
    /** Links whose target several notes share; left as they were. */
    ambiguous: number;
}

export interface RenameContext {
    from: string;
    to: string;
    /** Every note path before the rename. */
    notesBefore: readonly string[];
    /** Where the linking note is before and after the rename (they differ only for the renamed note itself). */
    sourceBefore: string;
    sourceAfter: string;
}

/**
 * Rewrite the wikilinks, embeds and markdown links in `content` that resolve
 * to `ctx.from` so they resolve to `ctx.to`. Each link keeps its label,
 * heading, block reference, table escape and style: a name stays a name (or
 * becomes the full path when the new name is taken), a vault path stays a
 * vault path, a `./` or `../` path stays relative, `.md` stays or stays off,
 * and a markdown link stays %-encoded or <bracketed>. Links in code are
 * left alone; markdown links in the frontmatter are not links.
 */
export function rewriteLinks(content: string, ctx: RenameContext): RewriteResult {
    const notesAfter = ctx.notesBefore.filter((n) => lower(n) !== lower(ctx.from)).concat(ctx.to);
    const fm = content.match(FRONTMATTER);
    const bodyStart = fm ? fm[0].length : 0;
    const code = codeRanges(content, bodyStart);
    const inCode = (i: number) => code.some(([s, e]) => i >= s && i < e);
    let rewritten = 0;
    let ambiguous = 0;

    const retarget = (target: string, markdownLink: boolean): string | null => {
        const before = resolveLink(target, ctx.sourceBefore, ctx.notesBefore);
        if (before === "ambiguous") {
            if (resolveLink(target, ctx.sourceBefore, [ctx.from]) === ctx.from) ambiguous++;
            return null;
        }
        if (before === null || lower(before) !== lower(ctx.from)) return null;
        // Already right after the move (a short link when only the folder changed).
        const after = resolveLink(target, ctx.sourceAfter, notesAfter);
        if (after !== "ambiguous" && after !== null && after === ctx.to) return null;
        const md = lower(target).endsWith(".md") ? ".md" : "";
        const full = stripMd(ctx.to);
        const forms: string[] = [];
        if (/^\.\.?\//.test(target)) {
            let rel = posix.relative(dirOf(ctx.sourceAfter), full);
            if (target.startsWith("./") && !rel.startsWith("..")) rel = "./" + rel;
            forms.push(rel);
        } else if (!target.replace(/^\/+/, "").includes("/")) {
            // A bare file name in a markdown link may be meant relative to the
            // note's folder (as other Markdown tools read it): keep it so.
            const besideSource = posix.join(dirOf(ctx.sourceBefore), lower(target).endsWith(".md") ? target : target + ".md");
            if (markdownLink && lower(besideSource) === lower(ctx.from)) forms.push(posix.relative(dirOf(ctx.sourceAfter), full));
            forms.push(noteName(ctx.to));
        } else if (target.startsWith("/")) {
            forms.push("/" + full);
        }
        forms.push(full);
        const pick = forms.map((f) => f + md).find((f) => resolveLink(f, ctx.sourceAfter, notesAfter) === ctx.to);
        if (pick === undefined) return null;
        rewritten++;
        return pick;
    };

    // Both patterns run over the original text, so the code ranges and the
    // frontmatter boundary hold; the edits are applied at the end.
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const m of content.matchAll(WIKILINK)) {
        const [whole, rawTarget, rest] = m;
        if (inCode(m.index)) continue;
        // In a table the pipe is escaped: [[note\|label]].
        const escaped = rawTarget.endsWith("\\") && rest.startsWith("|");
        const next = retarget(escaped ? rawTarget.slice(0, -1) : rawTarget, false);
        if (next !== null) edits.push({ start: m.index, end: m.index + whole.length, text: `[[${next}${escaped ? "\\" : ""}${rest}]]` });
    }
    for (const m of content.matchAll(MDLINK)) {
        const [whole, head, rawHref, tail] = m;
        const start = m.index;
        const end = start + whole.length;
        if (start < bodyStart || inCode(start) || inCode(start + head.length)) continue;
        if (edits.some((e) => start < e.end && e.start < end)) continue;
        const angled = rawHref.startsWith("<");
        const href = angled ? rawHref.slice(1, -1) : rawHref;
        const hash = href.indexOf("#");
        const rawPath = hash === -1 ? href : href.slice(0, hash);
        const fragment = hash === -1 ? "" : href.slice(hash);
        if (!rawPath || /^[a-z][a-z0-9+.-]*:/i.test(rawPath)) continue;
        let path: string;
        try { path = decodeURIComponent(rawPath); } catch { continue; }
        if (!lower(path).endsWith(".md")) continue;
        const next = retarget(path, true);
        if (next === null) continue;
        const needsEncoding = !angled && (rawPath.includes("%") || /[\s()<>#%]/.test(next));
        const written = needsEncoding ? encodePath(next) : next;
        edits.push({ start, end, text: head + (angled ? `<${written}${fragment}>` : written + fragment) + tail });
    }
    let out = content;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return { content: out, rewritten, ambiguous };
}

/** %-encode a path for a markdown link, segment by segment, parentheses too. */
function encodePath(path: string): string {
    return path.split("/").map((s) => encodeURIComponent(s).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");
}

export type AliasResult =
    | { status: "added"; content: string }
    | { status: "present" }
    | { status: "invalid"; reason: string };

/**
 * Add `alias` to the note's frontmatter `aliases`, creating the property (or
 * the frontmatter) when missing. Only the inserted text changes; every other
 * byte of the YAML stays as written. A block list gets one more `- item`, a
 * flow list one more entry, a single value becomes a flow list. Frontmatter
 * that isn't valid YAML, or isn't a map, is left alone.
 */
export function addAlias(content: string, alias: string): AliasResult {
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const item = yamlScalar(alias);
    const fm = content.match(FRONTMATTER);
    if (!fm) return { status: "added", content: `---${eol}aliases:${eol}  - ${item}${eol}---${eol}${content}` };
    const yaml = fm[1] ?? "";
    const yamlStart = fm[0].indexOf("\n") + 1;
    const insertAt = (at: number, text: string) => content.slice(0, yamlStart + at) + text + content.slice(yamlStart + at);
    const doc = parseDocument(yaml, { schema: "failsafe", uniqueKeys: false });
    if (doc.errors.length > 0) return { status: "invalid", reason: doc.errors[0].message.split("\n")[0].replace(/:$/, "") };
    if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null) || yaml.trim() === "" || /^(\s*#.*)*\s*$/.test(yaml)) {
        // Empty frontmatter: the property goes on a new last line.
        const block = `aliases:${eol}  - ${item}`;
        return { status: "added", content: insertAt(yaml.length, yaml.length > 0 ? eol + block : block + eol) };
    }
    if (!isMap(doc.contents)) return { status: "invalid", reason: "the frontmatter is not a list of properties" };
    const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === "aliases");
    if (!pair) return { status: "added", content: insertAt(yaml.length, `${eol}aliases:${eol}  - ${item}`) };
    const value = pair.value as YamlNode | null;
    const keyNode = pair.key as YamlNode;
    if (isSeq(value)) {
        const items = value.items.filter(isScalar).map((s) => String(s.value ?? ""));
        if (items.some((a) => lower(a) === lower(alias))) return { status: "present" };
        if (value.flow) {
            const end = value.range![1];
            const close = yaml.lastIndexOf("]", end);
            const sep = value.items.length > 0 ? ", " : "";
            return { status: "added", content: insertAt(close, sep + item) };
        }
        const last = value.items[value.items.length - 1] as YamlNode;
        const firstLineStart = yaml.lastIndexOf("\n", (value.items[0] as YamlNode).range![0]) + 1;
        const indent = yaml.slice(firstLineStart).match(/^[ \t]*/)![0];
        const lineEnd = lineEndAt(yaml, last.range![1]);
        return { status: "added", content: insertAt(lineEnd, `${eol}${indent}- ${item}`) };
    }
    if (isScalar(value) && value.value !== null && String(value.value) !== "") {
        if (lower(String(value.value)) === lower(alias)) return { status: "present" };
        const [s, e] = value.range!;
        return { status: "added", content: content.slice(0, yamlStart + s) + `[${yaml.slice(s, e)}, ${item}]` + content.slice(yamlStart + e) };
    }
    if (value === null || (isScalar(value) && (value.value === null || value.value === ""))) {
        // `aliases:` with no value: the list goes on the lines below.
        const lineEnd = lineEndAt(yaml, keyNode.range![1]);
        return { status: "added", content: insertAt(lineEnd, `${eol}  - ${item}`) };
    }
    return { status: "invalid", reason: "aliases is neither a list nor a single value" };
}

/** Offset of the end of the line holding `at` (before its \r\n or \n). */
function lineEndAt(text: string, at: number): number {
    const nl = text.indexOf("\n", at);
    if (nl === -1) return text.length;
    return text[nl - 1] === "\r" ? nl - 1 : nl;
}

/** `value` as a YAML scalar: plain when that reads back as the same string in block and flow context, else double-quoted. */
function yamlScalar(value: string): string {
    const plain = !/[:#,[\]{}&*!|>'"%@`\\\r\n]/.test(value) && !/^[\s\-?]/.test(value) && !/\s$/.test(value) && value !== "";
    if (plain) {
        try {
            if (parseYaml(value) === value) return value;
        } catch { /* quote it */ }
    }
    return JSON.stringify(value);
}
