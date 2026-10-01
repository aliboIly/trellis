// Records server errors and client error reports.
//
// Each record prints one log line with the code, then the stack, and goes to every sink (a game
// adds one to send errors to its analytics). Records made before the first sink registers are
// kept and handed to it. Nothing in here may throw, since it runs inside other error handlers.

import { ScriptContext } from "@rbxts/services";

import { settings } from "../config";
import { LIMITS, newErrorCode, plainAscii, trimTo } from "../errors";
import type { ErrorReportPayload } from "../errors";
import { scoped } from "../log";

const log = scoped("Error");

export type ErrorSide = "client" | "server" | "boot";

export interface ErrorRecord {
	readonly side: ErrorSide;
	/** `site` or `site:detail`. */
	readonly site: string;
	readonly message: string;
	readonly stack: string;
	/** What the player was doing, as their client noted it. */
	readonly doing?: string;
	readonly player?: Player;
	readonly script?: string;
	/** A code the client already made. A new one is made when this is missing. */
	readonly code?: string;
}

/** A record as sinks receive it: bounded, ASCII only, with its code. */
export interface ErrorEntry {
	readonly code: string;
	readonly side: ErrorSide;
	readonly site: string;
	readonly message: string;
	readonly stack: string;
	readonly doing: string;
	readonly player: Player | undefined;
	readonly script: string;
	/** The game's `recordContext` text, or "". */
	readonly context: string;
}

export type ErrorSink = (entry: ErrorEntry) => void;

const sinks = new Array<ErrorSink>();
const held = new Array<ErrorEntry>();
const seenUncaught = new Set<string>();
const reportsByPlayer = new Map<Player, number>();
let uncaughtCount = 0;
let reportCount = 0;

function quoted(text: string): string {
	return `"${text.gsub('"', "'")[0]}"`;
}

function deliver(sink: ErrorSink, entry: ErrorEntry): void {
	const [ok, err] = pcall(sink, entry);
	if (!ok) log.warn(`an error sink failed on ${entry.code}: ${tostring(err)}`);
}

function readContext(): string {
	const read = settings().recordContext;
	if (read === undefined) return "";
	const [ok, text] = pcall(read);
	return ok && typeIs(text, "string") ? trimTo(plainAscii(text), LIMITS.doingMax) : "";
}

/** Records one error and returns its code. */
export function record(source: ErrorRecord): string {
	const entry: ErrorEntry = {
		code: source.code ?? newErrorCode(),
		side: source.side,
		site: trimTo(plainAscii(source.site), LIMITS.siteMax),
		message: trimTo(plainAscii(source.message).gsub("\n", " ")[0], LIMITS.messageMax),
		stack: trimTo(plainAscii(source.stack), LIMITS.stackMax),
		doing: trimTo(plainAscii(source.doing ?? ""), LIMITS.doingMax),
		player: source.player,
		script: source.script ?? "unknown",
		context: readContext(),
	};
	const user = entry.player?.UserId ?? 0;
	const context = entry.context === "" ? "" : ` ${entry.context}`;
	pcall(() => {
		log.warn(
			`code=${entry.code} side=${entry.side} site=${entry.site} user=${user}${context} ` +
				`place=v${game.PlaceVersion} job=${game.JobId} doing=${quoted(entry.doing)} ` +
				`message=${quoted(entry.message)}\nstack: ${entry.stack}`,
		);
	});
	if (sinks.isEmpty()) {
		if (held.size() < LIMITS.bufferMax) held.push(entry);
	} else {
		for (const sink of sinks) deliver(sink, entry);
	}
	return entry.code;
}

export function addSink(sink: ErrorSink): void {
	sinks.push(sink);
	if (sinks.size() > 1) return;
	for (const entry of held) deliver(sink, entry);
	held.clear();
}

/** A client's report. The wire has already checked its shape and budget. */
export function onReport(player: Player, report: ErrorReportPayload): void {
	const count = reportsByPlayer.get(player) ?? 0;
	if (count >= LIMITS.reportsPerSession || reportCount >= LIMITS.reportsServerMax) return;
	reportsByPlayer.set(player, count + 1);
	reportCount += 1;
	record({
		side: "client",
		code: report.code,
		site: report.site,
		message: report.message,
		stack: report.stack,
		doing: report.doing,
		player,
		script: "client",
	});
}

export function forget(player: Player): void {
	reportsByPlayer.delete(player);
}

/** Records uncaught server errors, each message once, up to a cap. */
export function install(): void {
	ScriptContext.Error.Connect((message, stack, source) => {
		pcall(() => {
			if (uncaughtCount >= LIMITS.uncaughtCap) return;
			const key = trimTo(plainAscii(message), LIMITS.messageMax);
			if (seenUncaught.has(key)) return;
			seenUncaught.add(key);
			uncaughtCount += 1;
			record({
				side: "server",
				site: "uncaught",
				message,
				stack,
				script: source !== undefined ? source.GetFullName() : "unknown",
			});
		});
	});
}
