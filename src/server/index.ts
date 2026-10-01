// Server side: services and the boot.
//
// `boot` sorts the services so dependencies come first and creates every remote. Then it runs
// each service's `init` and `start`, one service at a time. If a service fails, every service
// that depends on it is skipped. Players already in the server are announced last.

import { describeSplit, toMs } from "../boot";
import type { BootReport } from "../boot";
import { lock } from "../config";
import type { Contract, Handlers, Members, ServerEndpoint } from "../contract";
import { scoped } from "../log";
import { order } from "../order";
import { capture, savedTrace } from "../trace";
import * as Errors from "./errors";
import type { ErrorEntry, ErrorRecord } from "./errors";
import * as Lifecycle from "./players";
import * as Wire from "./wire";

export type { BootReport } from "../boot";
export type { ErrorEntry, ErrorRecord, ErrorSide } from "./errors";
export type { SlidingWindow } from "./limiter";
export { RATE_WINDOW_SECONDS, slidingWindow } from "./limiter";

const log = scoped("Server");

// How many of the slowest services the boot line names.
const SLOWEST_SHOWN = 3;

export interface ServiceDef<M extends Members> {
	readonly name: string;
	/** Services this one uses. They start before it does. */
	readonly deps?: ReadonlyArray<Service>;
	readonly contract?: Contract<M>;
	/** One handler for each command and request in the contract. */
	readonly handlers?: Handlers<M>;
	/** Set up state and subscribe to other services. Don't yield. */
	readonly init?: () => void;
	/** Start loops, timers and anything else that acts. */
	readonly start?: () => void;
}

export interface Service<M extends Members = Members> {
	readonly name: string;
	readonly deps: ReadonlyArray<Service>;
	/** The service's events and properties. */
	readonly client: ServerEndpoint<M>;
}

interface ServiceParts {
	readonly contract?: Contract<Members>;
	readonly handlers: { readonly [member: string]: Wire.Handler | undefined };
	readonly init?: () => void;
	readonly start?: () => void;
	readonly endpoint: Wire.Endpoint;
}

const parts = new Map<Service, ServiceParts>();
let booted = false;
// The service whose init or start is running. Player subscriptions belong to it.
let current: string | undefined;

export function service<M extends Members = Record<string, never>>(def: ServiceDef<M>): Service<M> {
	const contract: Contract<Members> | undefined = def.contract;
	const endpoint = Wire.endpoint(contract);
	const made: Service<M> = {
		name: def.name,
		deps: def.deps ?? [],
		client: endpoint.client as ServerEndpoint<M>,
	};
	parts.set(made, {
		contract,
		handlers: def.handlers ?? {},
		init: def.init,
		start: def.start,
		endpoint,
	});
	return made;
}

function owner(): string {
	assert(current !== undefined, "trellis: subscribe to players from a service's init or start");
	return current;
}

/** Runs for every player, including those who joined before the service started. */
export function onJoined(handler: (player: Player) => void): void {
	Lifecycle.onJoined(owner(), handler);
}

/** Runs when a player leaves. The last service to subscribe runs first. */
export function onLeft(handler: (player: Player) => void): void {
	Lifecycle.onLeft(owner(), handler);
}

/** Receives every error record. Records made before the first sink are passed to it later. */
export function onError(sink: (entry: ErrorEntry) => void): void {
	Errors.addSink(sink);
}

/** Called with `contract.member` and the player for every call that passed its check. */
export function onAccepted(hook: (name: string, player: Player) => void): void {
	Wire.onAccepted(hook);
}

/** Called when a player goes over a member's budget. */
export function onDenied(hook: (player: Player, detail: string) => void): void {
	Wire.onDenied(hook);
}

/**
 * Runs code for a player outside a handler (a purchase grant, say) and records it if it throws,
 * the same way a handler is. `site` is `site` or `site:detail`. Returns whether `run` finished.
 */
export function guard(site: string, player: Player, run: () => void): boolean {
	return Wire.guarded(site, player, run);
}

/** Records an error the game caught itself. Returns its code. */
export function record(source: ErrorRecord): string {
	return Errors.record(source);
}

export function boot(list: ReadonlyArray<Service>): BootReport {
	assert(!booted, "trellis: the server booted twice");
	booted = true;
	lock();
	const began = os.clock();
	Errors.install();
	Lifecycle.init();
	Wire.setRoster({
		isReady: Lifecycle.isReady,
		isWaiting: Lifecycle.isWaiting,
		ready: Lifecycle.readyPlayers,
		waiting: Lifecycle.waitingPlayers,
	});
	Wire.bindSession(Lifecycle.hello);

	const [sorted, ordered] = pcall(order, list);
	if (!sorted) {
		Errors.record({ side: "boot", site: "boot:order", message: tostring(ordered), stack: "" });
		log.always("boot failed: the service order is broken, nothing started");
		return { ok: false, totalMs: toMs(os.clock() - began), split: [], failed: [], skipped: [] };
	}

	const spent = new Map<Service, number>();
	const failed = new Array<string>();
	const skipped = new Array<string>();

	const step = (target: Service, phase: string, run: (() => void) | undefined): boolean => {
		if (run === undefined) return true;
		current = target.name;
		const stepBegan = os.clock();
		const [ok, err] = xpcall(run, capture);
		const ms = toMs(os.clock() - stepBegan);
		current = undefined;
		spent.set(target, (spent.get(target) ?? 0) + ms);
		if (!ok) {
			failed.push(target.name);
			Errors.record({
				side: "boot",
				site: `boot:${target.name}`,
				message: `${phase}: ${tostring(err)} (after ${ms}ms)`,
				stack: savedTrace(),
				script: "server",
			});
		}
		return ok;
	};

	// Every remote exists before any service starts, so no client waits on a missing one.
	const bound = new Set<Service>();
	for (const target of ordered) {
		const own = parts.get(target);
		if (own === undefined) {
			failed.push(target.name);
			Errors.record({
				side: "boot",
				site: `boot:${target.name}`,
				message: "listed but not made with service()",
				stack: "",
			});
			continue;
		}
		const contract = own.contract;
		const bind =
			contract === undefined
				? undefined
				: () => {
						Wire.bind(target.name, contract, own.handlers, own.endpoint.slots);
					};
		if (step(target, "bind", bind)) bound.add(target);
	}

	const started = new Set<Service>();
	for (const target of ordered) {
		if (!bound.has(target)) continue;
		if (target.deps.some((dep) => !started.has(dep))) {
			skipped.push(target.name);
			continue;
		}
		const own = parts.get(target);
		if (!step(target, "init", own?.init) || !step(target, "start", own?.start)) continue;
		started.add(target);
		Wire.open(target.name);
	}

	Lifecycle.announcePresent();

	const totalMs = toMs(os.clock() - began);
	const split = ordered.map((target) => [target.name, spent.get(target) ?? 0] as const);
	const ok = started.size() === ordered.size();
	if (ok) {
		const slowest = [...split]
			.sort((a, b) => a[1] > b[1])
			.filter((_, index) => index < SLOWEST_SHOWN)
			.map(([name, ms]) => `${name}=${ms}`)
			.join(",");
		log.always(
			`initialized: ${ordered.size()} services ok in ${totalMs}ms, slowest ${slowest}`,
		);
	} else {
		const skippedText = skipped.isEmpty() ? "" : `; skipped: ${skipped.join(", ")}`;
		log.always(
			`initialized with errors: ${started.size()}/${ordered.size()} ok in ${totalMs}ms, ` +
				`failed: ${failed.join(", ")}${skippedText}`,
		);
	}
	log.always(`boot split (ms): ${describeSplit(split)}`);
	return { ok, totalMs, split, failed, skipped };
}
