import type { NoteMetadata } from "./parse.js";

export interface NoteInfo extends NoteMetadata {
    path: string;
    size: number;
    ctime: number;
    mtime: number;
    /** CouchDB mode: the note's current revision (`_rev`), opaque. Undefined in local mode. */
    revision?: string;
    /** CouchDB mode: revisions of the other live leaves (`_conflicts`), from the same fetch. */
    conflicts?: string[];
}

/** A note read together with the revision it was read at. */
export interface RevisedNote {
    content: string;
    revision: string;
    /** CouchDB mode: revisions of the other live leaves (`_conflicts`), from the same fetch. */
    conflicts?: string[];
}

/** A note that has more than one live revision leaf. */
export interface ConflictSummary {
    path: string;
    /** The revision CouchDB picked as the winner: the one every read shows. */
    revision: string;
    /** The other live leaves. */
    conflicts: string[];
}

export interface ConflictListing {
    conflicts: ConflictSummary[];
    /** Conflicted documents left out because their path could not be decrypted. */
    unreadable: number;
}

/** One live leaf of a conflicted note. */
export interface ConflictLeaf {
    revision: string;
    /** The leaf's text; null when its chunks could not be read. */
    content: string | null;
    mtime: number;
    size: number;
    /** A LiveSync deletion (`deleted: true`), which is still a live leaf in CouchDB. */
    deleted: boolean;
}

export interface ConflictDetail {
    path: string;
    winner: ConflictLeaf;
    /** The other live leaves, in CouchDB's `_conflicts` order. Empty when the note has no conflict. */
    others: ConflictLeaf[];
}

/** How to resolve a conflict: keep one leaf's text, or write merged text. */
export type ConflictResolution = { keep: string } | { content: string };

export interface ConflictResolved {
    /** The note's revision after the resolution. */
    revision: string;
    /** The note's text after the resolution; null when only other leaves were removed and the text did not change. */
    content: string | null;
    /** Leaves removed. */
    removed: string[];
    /** Live leaves other than the winner still present when read back (another writer added or moved one). */
    remaining: string[];
}

/** The leaf to keep can't be kept: it is a deletion, or its text can't be read. */
export class ConflictLeafUnreadableError extends Error {
    constructor(readonly path: string, readonly revision: string, readonly reason: string) {
        super(`Version ${revision} of ${path} can't be kept: ${reason}`);
        this.name = "ConflictLeafUnreadableError";
    }
}

/** The leaves of a conflicted note are not the ones the caller saw. */
export class ConflictChangedError extends Error {
    constructor(readonly path: string, readonly expected: string[], readonly current: string[]) {
        super(`The versions of ${path} changed: expected ${expected.join(",")}, now ${current.join(",") || "(none)"}`);
        this.name = "ConflictChangedError";
    }
}

export interface UpdateOptions {
    /** Apply only to this revision; a mismatch throws RevisionMismatchError instead of retrying. */
    expectedRevision?: string;
    /** Re-reads allowed when another writer changes the note between the read and the write. */
    maxAttempts?: number;
    /**
     * Keep retrying past maxAttempts until this long has passed since the first
     * read (up to 5 x maxAttempts rounds), so a writer outpaced by a burst on
     * another instance waits the burst out instead of giving up.
     */
    minRetryMs?: number;
}

export interface UpdateResult extends RevisedNote {
    /** How many read-apply-write rounds it took (1 when nobody else wrote meanwhile). */
    attempts: number;
}

/** A conditional write found the note at another revision than the one it was based on. */
export class RevisionMismatchError extends Error {
    constructor(readonly path: string, readonly expected: string, readonly current: string) {
        super(`Note ${path} is at revision ${current}, not ${expected}`);
        this.name = "RevisionMismatchError";
    }
}

/** An update kept losing to other writers and gave up without writing. */
export class UpdateRetriesExhaustedError extends Error {
    constructor(readonly path: string, readonly attempts: number) {
        super(`Note ${path} changed during each of ${attempts} attempts; nothing was written`);
        this.name = "UpdateRetriesExhaustedError";
    }
}

export interface NoteListing {
    path: string;
    mtime: number;
}

export interface AttachmentInfo {
    path: string;
    size: number;
    ctime: number;
    mtime: number;
}

/** An attachment appeared or changed (info), or was deleted (null). */
export type AttachmentChangeCallback = (path: string, info: { size: number; mtime: number } | null) => void;

export interface WriteOptions {
    /** Replace an existing file. Default false. */
    overwrite?: boolean;
}

export interface NoteWriteOptions {
    /**
     * "upsert" (default) creates or replaces. "create" refuses an existing note
     * (NoteExistsError) and "update" refuses a missing one (NoteNotFoundError),
     * each checked in the same step as the write.
     */
    mode?: "upsert" | "create" | "update";
    /**
     * CouchDB mode, replacing an existing note: rounds of the revision-checked
     * put, with the same meaning as in UpdateOptions. Ignored in local mode.
     */
    maxAttempts?: number;
    minRetryMs?: number;
}

/** A create-only write or a move found a note already at the path. */
export class NoteExistsError extends Error {
    constructor(readonly path: string) {
        super(`Note already exists: ${path}`);
        this.name = "NoteExistsError";
    }
}

/** An update-only write found no note at the path. */
export class NoteNotFoundError extends Error {
    constructor(readonly path: string) {
        super(`Note not found: ${path}`);
        this.name = "NoteNotFoundError";
    }
}

export interface MoveOptions extends WriteOptions {
    /**
     * Largest file a backend may load into memory to move it. CouchDB mode
     * copies the bytes (read, write, delete); local mode renames and ignores it.
     */
    maxBytes?: number;
}

/** A move would have to load a file larger than `MoveOptions.maxBytes`. */
export class AttachmentTooLargeError extends Error {
    constructor(readonly path: string, readonly size: number, readonly limit: number) {
        super(`Attachment is ${size} bytes, over the ${limit}-byte limit for moving it: ${path}`);
        this.name = "AttachmentTooLargeError";
    }
}

/** A copying move wrote the destination but could not delete the source, so both exist. */
export class AttachmentMoveIncompleteError extends Error {
    constructor(readonly from: string, readonly to: string) {
        super(`Copied ${from} to ${to}, but could not delete ${from}`);
        this.name = "AttachmentMoveIncompleteError";
    }
}

/** A write or move without `overwrite` found a file already at the destination. */
export class AttachmentExistsError extends Error {
    constructor(readonly path: string) {
        super(`Attachment already exists: ${path}`);
        this.name = "AttachmentExistsError";
    }
}

export interface VaultBackend {
    init(): Promise<void>;
    close(): Promise<void>;
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string, options?: NoteWriteOptions): Promise<boolean>;
    deleteNote(path: string): Promise<boolean>;
    /**
     * CouchDB mode only: the note and the revision it was read at, from one
     * fetch. Absent in local mode, which has no revisions.
     */
    readNoteRevision?(path: string): Promise<RevisedNote | null>;
    /**
     * CouchDB mode only: read the note, pass its text to `apply`, and write the
     * result only if the note is still at the revision that was read. When
     * another writer got there first, read again and re-apply, up to
     * `maxAttempts` rounds; `apply` may throw to refuse (its error propagates
     * and nothing is written). Throws NoteNotFoundError when the note is absent.
     * The result's content is the text stored at its revision, which can hold
     * other callers' edits written in the same write.
     */
    updateNote?(path: string, apply: (content: string) => string, options?: UpdateOptions): Promise<UpdateResult>;
    /**
     * CouchDB mode only: notes with more than one live revision leaf, without
     * loading any note body.
     */
    listConflicts?(folder?: string): Promise<ConflictListing>;
    /** CouchDB mode only: the winner and every other live leaf with their text; null when the note is absent. */
    getConflict?(path: string): Promise<ConflictDetail | null>;
    /**
     * CouchDB mode only: settle a conflict. Refuses with ConflictChangedError
     * unless the note's live leaves are exactly `expectedLeaves`. `keep` names
     * the leaf whose text survives; `content` is merged text. Either is written
     * on top of the winner (no write when keeping the winner), then every other
     * leaf is deleted at its own revision.
     */
    resolveConflict?(path: string, expectedLeaves: string[], resolution: ConflictResolution): Promise<ConflictResolved>;
    /** Never replaces a note at `to`: throws NoteExistsError instead, checked in the same step as the move. */
    moveNote(from: string, to: string): Promise<boolean>;
    getMetadata(path: string): Promise<NoteInfo | null>;
    listNotes(folder?: string): Promise<string[]>;
    listNotesWithMtime(folder?: string): Promise<NoteListing[]>;
    /**
     * Binary attachments (see attachment-path.ts). Paths are validated by the backend too.
     * Without `overwrite`, writing or moving onto an existing file throws
     * AttachmentExistsError, checked in the same step as the write.
     */
    writeAttachment(path: string, data: Uint8Array, options?: WriteOptions): Promise<boolean>;
    deleteAttachment(path: string): Promise<boolean>;
    moveAttachment(from: string, to: string, options?: MoveOptions): Promise<boolean>;
    getAttachmentInfo(path: string): Promise<AttachmentInfo | null>;
    /** Every attachment in the vault. Local mode only; CouchDB mode learns them from the change feed. */
    listAttachments?(): Promise<AttachmentInfo[]>;
    /** `onAttachment` also reports attachment changes, from metadata only (no chunks are loaded). */
    watchChanges?(callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void, onAttachment?: AttachmentChangeCallback): void;
    /**
     * Catch up on changes since a sequence. Returns the new sequence. CouchDB only.
     * `stats.unreadable` counts documents that could not be decrypted or loaded
     * and were therefore skipped — the caller reports them so "caught up" never
     * hides a silent miss.
     */
    catchUp?(since: string, callback: (path: string, content: string | null, mtime?: number) => void, onBatch?: (since: string, processed: number) => Promise<void>, stats?: { unreadable: number }, onAttachment?: AttachmentChangeCallback): Promise<string>;
}
