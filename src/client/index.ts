// Client side: controllers, and the client end of every contract.
//
// `use(contract)` returns the client end of a contract. Each remote is found and connected once,
// however many controllers use it. `boot` runs each controller's `init` and `start` in
// dependency order, waits until every event and property is connected, then says hello. The
// server answers the hello with every property value, so no value arrives before its listener.
//
// Nothing the client does is trusted. A request is a question the server can refuse, and a
// property is whatever the server last sent.

import { Players, ReplicatedStorage } from "@rbxts/services";

import { describeSplit, toMs } from "../boot";
import type { BootReport } from "../boot";
import { lock } from "../config";
import { membersOf } from "../contract";
import type { ClientEndpoint, Contract, Members } from "../contract";
import { scoped } from "../log";
import { order } from "../order";
import { SessionContract } from "../session";
import * as Reporter from "./errors";

export type { BootReport } from "../boot";

const log = scoped("Client");

const ROOT = "trellis";
// A remote missing for this long is reported, then still waited for. Requests give up here.
const RESOLVE_SECONDS = 30;
// Commands sent before their remote shows up are held and sent once it does, up to this many.
const HELD_MAX = 16;

export interface ControllerDef {
	readonly name: string;
	/** Controllers this one uses. They start before it does. */
	readonly deps?: ReadonlyArray<Controller>;
	/** Set up state and connect to contracts. Don't yield. */
	readonly init?: () => void;
	/** Start acting. */
	readonly start?: () => void;
}

export interface Controller {
	readonly name: string;
	readonly deps: ReadonlyArray<Controller>;
}

const parts = new Map<Controller, ControllerDef>();
let booted = false;

export function controller(def: ControllerDef): Controller {
	const made: Controller = { name: def.name, deps: def.deps ?? [] };
	parts.set(made, def);
	return made;
}

// Events and properties not connected yet. The hello waits for these.
let connecting = 0;

function waitForChild(parent: Instance, name: string, late: () => void): Instance {
	for (;;) {
		const child = parent.WaitForChild(name, RESOLVE_SECONDS);
		if (child !== undefined) return child;
		late();
	}
}

/** Finds a remote on its own thread. If it already exists, `found` runs before this returns. */
function resolve(contractName: string, member: string, found: (remote: Instance) => void): void {
	task.spawn(() => {
		let reported = false;
		const late = (): void => {
			if (reported) return;
			reported = true;
			Reporter.report("net", `${contractName}.${member}`, "the remote did not show up");
		};
		const root = waitForChild(ReplicatedStorage, ROOT, late);
		const folder = waitForChild(root, contractName, late);
		found(waitForChild(folder, member, late));
	});
}

// Only happens if the server and the client were built from different contracts.
function wrongKind(label: string, remote: Instance): void {
	Reporter.report("net", label, `the remote is a ${remote.ClassName}`);
}

type Listener = (value: unknown) => void;

// Listener lists are replaced on every change, never changed in place. Sending needs no copy, and
// a listener that disconnects while being called doesn't make the next one get skipped.
function without(list: ReadonlyArray<Listener>, listener: Listener): ReadonlyArray<Listener> {
	const at = list.indexOf(listener);
	if (at < 0) return list;
	const copy = [...list];
	copy.remove(at);
	return copy;
}

function listen(contractName: string, member: string, deliver: (payload: unknown) => void): void {
	connecting += 1;
	resolve(contractName, member, (remote) => {
		connecting -= 1;
		if (remote.IsA("RemoteEvent")) remote.OnClientEvent.Connect(deliver);
		else wrongKind(`${contractName}.${member}`, remote);
	});
}

function eventHandle(contractName: string, member: string): unknown {
	const label = `${contractName}.${member}`;
	let listeners: ReadonlyArray<Listener> = [];
	listen(contractName, member, (payload) => {
		for (const listener of listeners) Reporter.call("net", label, listener, payload);
	});
	return {
		connect: (listener: Listener) => {
			listeners = [...listeners, listener];
			let connected = true;
			return () => {
				if (!connected) return;
				connected = false;
				listeners = without(listeners, listener);
			};
		},
	};
}

function propertyHandle(contractName: string, member: string): unknown {
	const label = `${contractName}.${member}`;
	let observers: ReadonlyArray<Listener> = [];
	let value: unknown;
	let has = false;
	listen(contractName, member, (payload) => {
		value = payload;
		has = true;
		for (const observer of observers) Reporter.call("net", label, observer, payload);
	});
	return {
		get: () => (has ? value : undefined),
		observe: (observer: Listener) => {
			observers = [...observers, observer];
			if (has) Reporter.call("net", label, observer, value);
			let connected = true;
			return () => {
				if (!connected) return;
				connected = false;
				observers = without(observers, observer);
			};
		},
	};
}

function commandHandle(contractName: string, member: string): unknown {
	const label = `${contractName}.${member}`;
	let remote: RemoteEvent | undefined;
	// Each payload is wrapped in a table, since a nil can't be stored in an array.
	const held = new Array<{ readonly payload: unknown }>();
	resolve(contractName, member, (found) => {
		if (!found.IsA("RemoteEvent")) {
			wrongKind(label, found);
			return;
		}
		remote = found;
		for (const entry of held) found.FireServer(entry.payload);
		held.clear();
	});
	return (payload?: unknown) => {
		Reporter.note(label);
		if (remote !== undefined) remote.FireServer(payload);
		else if (held.size() < HELD_MAX) held.push({ payload });
	};
}

function invoke(remote: RemoteFunction, payload: unknown): unknown {
	return remote.InvokeServer(payload);
}

function requestHandle(contractName: string, member: string): unknown {
	const label = `${contractName}.${member}`;
	let remote: RemoteFunction | undefined;
	resolve(contractName, member, (found) => {
		if (found.IsA("RemoteFunction")) remote = found;
		else wrongKind(label, found);
	});
	return (payload?: unknown): unknown => {
		Reporter.note(label);
		const deadline = os.clock() + RESOLVE_SECONDS;
		while (remote === undefined && os.clock() < deadline) task.wait();
		if (remote === undefined) return undefined;
		const [ok, answer] = pcall(invoke, remote, payload);
		return ok ? answer : undefined;
	};
}

const endpoints = new Map<string, unknown>();

/** The client end of a contract. Every call with the same contract returns the same object. */
export function use<M extends Members>(contract: Contract<M>): ClientEndpoint<M> {
	const cached = endpoints.get(contract.name);
	if (cached !== undefined) return cached as ClientEndpoint<M>;
	const made: { [member: string]: unknown } = {};
	for (const [member, spec] of membersOf(contract.members)) {
		if (spec.kind === "command") made[member] = commandHandle(contract.name, member);
		else if (spec.kind === "request") made[member] = requestHandle(contract.name, member);
		else if (spec.kind === "event") made[member] = eventHandle(contract.name, member);
		else made[member] = propertyHandle(contract.name, member);
	}
	endpoints.set(contract.name, made);
	return made as ClientEndpoint<M>;
}

/** Runs for every player in the server, now and as they join. Each call gets its own thread. */
export function onJoined(handler: (player: Player) => void): void {
	const run = (player: Player): void => {
		task.spawn(() => {
			Reporter.call("net", "players.joined", handler, player);
		});
	};
	for (const player of Players.GetPlayers()) run(player);
	Players.PlayerAdded.Connect(run);
}

/**
 * Shows each error line somewhere besides the console, like a toast. `show` gets the code and
 * the site and writes the words. Lines said before this is called are shown to it first.
 */
export function onErrorLine(show: (code: string, site: string) => void): void {
	Reporter.addShow(show);
}

/** Reports an error the game caught itself. Returns its code. Pass the stack if you have one. */
export function report(site: string, detail: string, err: unknown, stack?: string): string {
	return Reporter.report(site, detail, err, stack);
}

/** Runs `run` and reports it if it throws. Returns whether `run` finished. */
export function guard(site: string, detail: string, run: () => void): boolean {
	return Reporter.guard(site, detail, run);
}

export function boot(list: ReadonlyArray<Controller>): BootReport {
	assert(!booted, "trellis: the client booted twice");
	booted = true;
	lock();
	const began = os.clock();
	Reporter.install();
	const session = use(SessionContract);
	Reporter.setSender(session.report);
	session.code.connect((view) => {
		Reporter.announce(view.code, view.site);
	});

	const [sorted, ordered] = pcall(order, list);
	if (!sorted) {
		Reporter.report("boot", "order", ordered);
		session.hello(true);
		return { ok: false, totalMs: toMs(os.clock() - began), split: [], failed: [], skipped: [] };
	}

	const started = new Set<Controller>();
	const split = new Array<readonly [string, number]>();
	const failed = new Array<string>();
	const skipped = new Array<string>();
	for (const target of ordered) {
		if (target.deps.some((dep) => !started.has(dep))) {
			skipped.push(target.name);
			continue;
		}
		const def = parts.get(target);
		if (def === undefined) {
			Reporter.report("boot", target.name, "listed but not made with controller()");
			failed.push(target.name);
			continue;
		}
		const stepBegan = os.clock();
		const ok =
			(def.init === undefined || Reporter.guard("boot", target.name, def.init)) &&
			(def.start === undefined || Reporter.guard("boot", target.name, def.start));
		split.push([target.name, toMs(os.clock() - stepBegan)]);
		if (ok) started.add(target);
		else failed.push(target.name);
	}

	// Usually nothing to wait for: remotes that already exist connect inside `use`.
	const waitBegan = os.clock();
	while (connecting > 0 && os.clock() - waitBegan < RESOLVE_SECONDS) task.wait();
	session.hello(true);

	const ok = started.size() === ordered.size();
	const totalMs = toMs(os.clock() - began);
	log.debug(`initialized: ${started.size()}/${ordered.size()} controllers in ${totalMs}ms`);
	log.debug(`boot split (ms): ${describeSplit(split)}`);
	return { ok, totalMs, split, failed, skipped };
}
