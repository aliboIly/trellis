// Error codes and the limits on error text, used by both sides.
//
// Every error a player hits gets one code. The player sees the code in a short line, and the
// server keeps the full record under the same code, so a screenshot can be matched to the log.
// Codes skip 0, O, 1 and I so they are easy to read back.

import { isRecord, isStringMax } from "./check";
import type { Check } from "./check";
import { isSite, settings } from "./config";

export const LIMITS = {
	/** Characters after the prefix. Six gives about a billion codes. */
	codeLength: 6,
	messageMax: 200,
	stackMax: 1000,
	/** The detail after a site, like a member name. */
	detailMax: 40,
	/** A whole `site:detail` key. */
	siteMax: 80,
	doingMax: 120,
	/** Reports one client sends per session. */
	reportsPerSession: 5,
	/** Client reports one server records in its lifetime. */
	reportsServerMax: 60,
	/** Calls per window on the report member. The per-session cap is the real limit. */
	reportBudget: 6,
	/** Uncaught server errors one server records in its lifetime. */
	uncaughtCap: 30,
	/** Records kept for an error sink that registers late. */
	bufferMax: 32,
} as const;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** What a client sends when it reports an error it caught. */
export interface ErrorReportPayload {
	readonly code: string;
	/** `site` or `site:detail`. */
	readonly site: string;
	readonly message: string;
	readonly stack: string;
	readonly doing: string;
}

/** What the server sends a client when a handler threw on that client's call. */
export interface ErrorCodeView {
	readonly code: string;
	readonly site: string;
}

// math.random rather than Random, because Random doesn't exist outside the engine.
export function mintCode(prefix: string, length: number): string {
	let body = "";
	for (let i = 0; i < length; i++) {
		const at = math.random(1, CODE_ALPHABET.size());
		body += CODE_ALPHABET.sub(at, at);
	}
	return prefix + body;
}

export function isCode(value: unknown, prefix: string, length: number): value is string {
	if (!typeIs(value, "string") || value.size() !== prefix.size() + length) return false;
	if (value.sub(1, prefix.size()) !== prefix) return false;
	return value.sub(prefix.size() + 1).match(`^[${CODE_ALPHABET}]+$`)[0] !== undefined;
}

export function newErrorCode(): string {
	return mintCode(settings().codePrefix, LIMITS.codeLength);
}

export function isErrorCode(value: unknown): value is string {
	return isCode(value, settings().codePrefix, LIMITS.codeLength);
}

export const isErrorReport: Check<ErrorReportPayload> = isRecord<ErrorReportPayload>({
	code: isErrorCode,
	site: isStringMax(LIMITS.siteMax),
	message: isStringMax(LIMITS.messageMax),
	stack: isStringMax(LIMITS.stackMax),
	doing: isStringMax(LIMITS.doingMax),
});

/**
 * Replaces anything outside printable ASCII with "?". Error text can hold any bytes, and a cut in
 * the middle of a multibyte character makes JSONEncode fail. Uses a byte range instead of `%g`
 * because `%g` matches bytes above 127 in the live engine.
 */
export function plainAscii(text: string): string {
	return text.gsub("[^ -~\n]", "?")[0];
}

export function trimTo(text: string, max: number): string {
	return text.size() <= max ? text : text.sub(1, max);
}

/** `site:detail`, or just `site` when the detail is empty. */
export function siteKey(site: string, detail: string): string {
	const clean = trimTo(plainAscii(detail.gsub("%s+", "_")[0]), LIMITS.detailMax);
	return clean === "" ? site : `${site}:${clean}`;
}

/** The site at the start of a `site:detail` key. Unknown sites read as `net`. */
export function siteOf(key: string): string {
	const head = key.split(":")[0];
	return isSite(head) ? head : "net";
}

/** The line a player sees, worded by the game's `errorLine` setting. */
export function clientLine(code: string, site: string): string {
	return settings().errorLine(code, isSite(site) ? site : "net");
}
