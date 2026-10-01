// Client errors. An error the player hits gets one code. The player sees a short line with the
// code (in the console, and on screen once the game adds a place to show it), and the client
// sends the message and stack to the server under the same code. The raw message is only printed
// in Studio.
//
// Each site reports once per session, so an error in a loop is one report. The server limits
// reports again on its side.

import { ScriptContext } from "@rbxts/services";

import { isSite } from "../config";
import { LIMITS, clientLine, newErrorCode, plainAscii, siteKey, trimTo } from "../errors";
import type { ErrorReportPayload } from "../errors";
import { scoped } from "../log";
import { capture, savedTrace } from "../trace";

const log = scoped("Error");

type Show = (code: string, site: string) => void;

// Lines said before the game adds a show are kept for it, so a boot error still reaches the screen.
const EARLY_MAX = 5;

const reported = new Map<string, string>();
const early = new Array<readonly [string, string]>();
const shows = new Array<Show>();
let sent = 0;
let last = "boot";
let inCatchAll = false;
let send: ((payload: ErrorReportPayload) => void) | undefined;

export function setSender(sender: (payload: ErrorReportPayload) => void): void {
	send = sender;
}

/** Notes the last thing the client asked the server for. It goes in the next report. */
export function note(doing: string): void {
	last = doing;
}

export function addShow(show: Show): void {
	shows.push(show);
	for (const [code, site] of early) pcall(show, code, site);
}

function say(code: string, site: string): void {
	const shown = isSite(site) ? site : "net";
	log.warn(clientLine(code, shown));
	if (early.size() < EARLY_MAX) early.push([code, shown]);
	for (const show of shows) pcall(show, code, shown);
}

/** Reports an error that was already caught and returns its code. */
export function report(site: string, detail: string, err: unknown, stack?: string): string {
	const key = siteKey(site, detail);
	const message = plainAscii(tostring(err));
	const standing = reported.get(key);
	if (standing !== undefined) {
		log.debug(`${key} failed again under ${standing}: ${message}`);
		return standing;
	}
	const code = newErrorCode();
	reported.set(key, code);
	log.debug(`${code} ${key}: ${message}`);
	say(code, site);
	if (send === undefined || sent >= LIMITS.reportsPerSession) return code;
	sent += 1;
	const payload: ErrorReportPayload = {
		code,
		site: trimTo(key, LIMITS.siteMax),
		message: trimTo(message, LIMITS.messageMax),
		stack: trimTo(plainAscii(stack ?? debug.traceback(undefined, 2)), LIMITS.stackMax),
		doing: trimTo(`last=${last}`, LIMITS.doingMax),
	};
	pcall(send, payload);
	return code;
}

/** Runs `run` and reports it if it throws. Returns whether `run` finished. */
export function guard(site: string, detail: string, run: () => void): boolean {
	const [ok, err] = xpcall(run, capture);
	if (!ok) report(site, detail, err, savedTrace());
	return ok;
}

/** Calls `handler(value)` and reports it if it throws. Builds no closure, for hot paths. */
export function call<T>(site: string, detail: string, handler: (value: T) => void, value: T): void {
	const [ok, err] = xpcall(handler, capture, value);
	if (!ok) report(site, detail, err, savedTrace());
}

/** Shows the line for a code the server made: a server handler threw on this client's call. */
export function announce(code: string, site: string): void {
	say(code, site);
}

/** Reports uncaught client errors too. */
export function install(): void {
	ScriptContext.Error.Connect((message, stack, source) => {
		// An error inside the report itself must not report again.
		if (inCatchAll) return;
		inCatchAll = true;
		pcall(report, "uncaught", source !== undefined ? source.Name : "unknown", message, stack);
		inCatchAll = false;
	});
}
