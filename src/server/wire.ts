// The only place the server creates remotes, listens to clients, and sends to them.
//
// Each contract gets a folder under `ReplicatedStorage.trellis`, with a RemoteEvent for each
// command, event and property, and a RemoteFunction for each request. Every client call goes
// through the same steps: the service must be running, the payload must pass its check, the call
// is counted, the member's window must allow it, and then the handler runs. If the handler
// throws, the error is recorded and the player gets its code.
//
// Property values live on the server. A player gets every value when their client says hello,
// then each change, at most once per frame. Events only go to clients that have said hello. An
// event fired before that is dropped, since a missed moment isn't state to catch up on.

import { ReplicatedStorage } from "@rbxts/services";

import { membersOf } from "../contract";
import type {
	CommandSpec,
	Contract,
	Members,
	RequestSpec,
	ServerEvent,
	ServerPlayerProperty,
	ServerSharedProperty,
} from "../contract";
import { siteOf } from "../errors";
import { scoped } from "../log";
import { SessionContract } from "../session";
import { capture, savedTrace } from "../trace";
import * as Errors from "./errors";
import { RATE_WINDOW_SECONDS, slidingWindow } from "./limiter";
import type { SlidingWindow } from "./limiter";

const log = scoped("Wire");

const ROOT = "trellis";

/** Who can be sent to. Set by the player lifecycle at boot. */
export interface Roster {
	readonly isReady: (player: Player) => boolean;
	readonly ready: () => ReadonlySet<Player>;
}

const NOBODY: ReadonlySet<Player> = new Set();

let roster: Roster = { isReady: () => false, ready: () => NOBODY };
let acceptedHook: (name: string) => void = () => {};
let deniedHook: (player: Player, detail: string) => void = (player, detail) => {
	log.debug(`denied ${player.Name}: ${detail}`);
};

export function setRoster(value: Roster): void {
	roster = value;
}

export function onAccepted(hook: (name: string) => void): void {
	acceptedHook = hook;
}

export function onDenied(hook: (player: Player, detail: string) => void): void {
	deniedHook = hook;
}

// What a service sends: an event's remote, or a property's remote and values.

interface EventSlot {
	readonly kind: "event";
	remote?: RemoteEvent;
}

interface PlayerSlot {
	readonly kind: "playerProperty";
	remote?: RemoteEvent;
	readonly values: Map<Player, unknown>;
	readonly pending: Set<Player>;
}

interface SharedSlot {
	readonly kind: "sharedProperty";
	remote?: RemoteEvent;
	value: unknown;
	has: boolean;
	pending: boolean;
}

type Slot = EventSlot | PlayerSlot | SharedSlot;

/** A service's sending side: the `client` object its code uses, and the slots `bind` fills. */
export interface Endpoint {
	readonly client: unknown;
	readonly slots: ReadonlyMap<string, Slot>;
}

const propertySlots = new Array<PlayerSlot | SharedSlot>();

function flushPlayer(slot: PlayerSlot, player: Player): void {
	slot.pending.delete(player);
	if (slot.remote === undefined || !roster.isReady(player) || !slot.values.has(player)) return;
	slot.remote.FireClient(player, slot.values.get(player));
}

function flushShared(slot: SharedSlot): void {
	slot.pending = false;
	const remote = slot.remote;
	if (remote === undefined || !slot.has) return;
	for (const player of roster.ready()) remote.FireClient(player, slot.value);
}

function makeEvent(slot: EventSlot, name: string): ServerEvent<unknown> {
	return {
		fire: (player, payload) => {
			if (slot.remote === undefined) {
				log.warn(`${name} was fired before boot`);
				return;
			}
			if (roster.isReady(player)) slot.remote.FireClient(player, payload);
		},
		fireAll: (payload) => {
			const remote = slot.remote;
			if (remote === undefined) {
				log.warn(`${name} was fired before boot`);
				return;
			}
			for (const player of roster.ready()) remote.FireClient(player, payload);
		},
	};
}

function makePlayerProperty(slot: PlayerSlot): ServerPlayerProperty<unknown> {
	return {
		set: (player, value) => {
			slot.values.set(player, value);
			if (slot.pending.has(player) || !roster.isReady(player)) return;
			slot.pending.add(player);
			task.defer(flushPlayer, slot, player);
		},
		get: (player) => slot.values.get(player),
	};
}

function makeSharedProperty(slot: SharedSlot): ServerSharedProperty<unknown> {
	return {
		set: (value) => {
			slot.value = value;
			slot.has = true;
			if (slot.pending) return;
			slot.pending = true;
			task.defer(flushShared, slot);
		},
		get: () => (slot.has ? slot.value : undefined),
	};
}

/** Builds a service's sending side. It works right away; `bind` adds the remotes at boot. */
export function endpoint(contract: Contract<Members> | undefined): Endpoint {
	const client: { [member: string]: unknown } = {};
	const slots = new Map<string, Slot>();
	if (contract === undefined) return { client, slots };
	for (const [member, spec] of membersOf(contract.members)) {
		const name = `${contract.name}.${member}`;
		if (spec.kind === "event") {
			const slot: EventSlot = { kind: "event" };
			slots.set(member, slot);
			client[member] = makeEvent(slot, name);
		} else if (spec.kind === "playerProperty") {
			const slot: PlayerSlot = {
				kind: "playerProperty",
				values: new Map(),
				pending: new Set(),
			};
			slots.set(member, slot);
			client[member] = makePlayerProperty(slot);
		} else if (spec.kind === "sharedProperty") {
			const slot: SharedSlot = {
				kind: "sharedProperty",
				value: undefined,
				has: false,
				pending: false,
			};
			slots.set(member, slot);
			client[member] = makeSharedProperty(slot);
		}
	}
	return { client, slots };
}

const windows = new Array<SlidingWindow<Player>>();
const running = new Set<string>();

function folder(parent: Instance, name: string): Folder {
	const existing = parent.FindFirstChild(name);
	if (existing !== undefined && existing.IsA("Folder")) return existing;
	const created = new Instance("Folder");
	created.Name = name;
	created.Parent = parent;
	return created;
}

function contractFolder(name: string): Folder {
	return folder(folder(ReplicatedStorage, ROOT), name);
}

function remote<C extends "RemoteEvent" | "RemoteFunction">(
	className: C,
	parent: Folder,
	member: string,
): CreatableInstances[C] {
	assert(
		parent.FindFirstChild(member) === undefined,
		`trellis: ${parent.Name}.${member} is bound twice`,
	);
	const created = new Instance(className);
	created.Name = member;
	created.Parent = parent;
	return created;
}

let codeRemote: RemoteEvent | undefined;

// Records a throw on a player's behalf. The client gets the code and the site, never the record.
function fail(site: string, player: Player, err: unknown): void {
	const code = Errors.record({
		side: "server",
		site,
		message: tostring(err),
		stack: savedTrace(),
		player,
		script: "server",
	});
	if (codeRemote !== undefined && roster.isReady(player)) {
		codeRemote.FireClient(player, { code, site: siteOf(site) });
	}
}

/** Runs `run` for one player and records it if it throws. Returns whether `run` finished. */
export function guarded(site: string, player: Player, run: () => void): boolean {
	const [ok, err] = xpcall(run, capture);
	if (!ok) fail(site, player, err);
	return ok;
}

function admit<P>(
	service: string,
	name: string,
	spec: CommandSpec<P> | RequestSpec<P, unknown>,
	window: SlidingWindow<Player>,
	player: Player,
	payload: unknown,
): payload is P {
	if (!running.has(service) || !spec.check(payload)) return false;
	acceptedHook(name);
	if (window.allow(player, os.clock())) return true;
	deniedHook(player, `${spec.budget} calls in ${RATE_WINDOW_SECONDS}s on ${name}`);
	return false;
}

export type Handler = (player: Player, payload: unknown) => unknown;

/** Creates a service's remotes and connects each command and request to its handler. */
export function bind(
	service: string,
	contract: Contract<Members>,
	handlers: { readonly [member: string]: Handler | undefined },
	slots: ReadonlyMap<string, Slot>,
): void {
	const parent = contractFolder(contract.name);
	for (const [member, spec] of membersOf(contract.members)) {
		const name = `${contract.name}.${member}`;
		if (spec.kind === "command" || spec.kind === "request") {
			const handler = handlers[member];
			assert(handler !== undefined, `trellis: ${service} has no handler for ${name}`);
			const window = slidingWindow<Player>(spec.budget, RATE_WINDOW_SECONDS);
			windows.push(window);
			const site = `net:${name}`;
			// The handler goes straight to xpcall, so a call builds no closure.
			if (spec.kind === "command") {
				remote("RemoteEvent", parent, member).OnServerEvent.Connect((player, payload) => {
					if (!admit(service, name, spec, window, player, payload)) return;
					const [ok, err] = xpcall(handler, capture, player, payload);
					if (!ok) fail(site, player, err);
				});
			} else {
				remote("RemoteFunction", parent, member).OnServerInvoke = (player, payload) => {
					if (!admit(service, name, spec, window, player, payload)) return undefined;
					const [ok, answer] = xpcall(handler, capture, player, payload);
					if (ok) return answer;
					fail(site, player, answer);
					return undefined;
				};
			}
		} else {
			const slot = slots.get(member);
			assert(slot !== undefined, `trellis: ${name} has no slot`);
			slot.remote = remote("RemoteEvent", parent, member);
			if (slot.kind !== "event") propertySlots.push(slot);
		}
	}
}

/** Binds trellis's own contract: the hello, client error reports, and codes sent down. */
export function bindSession(hello: (player: Player) => void): void {
	const name = SessionContract.name;
	const members = SessionContract.members;
	const parent = contractFolder(name);
	const helloWindow = slidingWindow<Player>(members.hello.budget, RATE_WINDOW_SECONDS);
	const reportWindow = slidingWindow<Player>(members.report.budget, RATE_WINDOW_SECONDS);
	windows.push(helloWindow, reportWindow);
	running.add(name);
	remote("RemoteEvent", parent, "hello").OnServerEvent.Connect((player, payload) => {
		if (!admit(name, `${name}.hello`, members.hello, helloWindow, player, payload)) return;
		const [ok, err] = xpcall(hello, capture, player);
		if (!ok) fail(`net:${name}.hello`, player, err);
	});
	remote("RemoteEvent", parent, "report").OnServerEvent.Connect((player, payload) => {
		if (!admit(name, `${name}.report`, members.report, reportWindow, player, payload)) return;
		Errors.onReport(player, payload);
	});
	codeRemote = remote("RemoteEvent", parent, "code");
}

/** From now on the service's handlers run. Calls before this are dropped. */
export function open(service: string): void {
	running.add(service);
}

export function isRunning(service: string): boolean {
	return running.has(service);
}

/** Sends a player every property value they should have. The answer to their hello. */
export function snapshot(player: Player): void {
	for (const slot of propertySlots) {
		if (slot.remote === undefined) continue;
		if (slot.kind === "playerProperty") {
			if (slot.values.has(player)) slot.remote.FireClient(player, slot.values.get(player));
		} else if (slot.has) {
			slot.remote.FireClient(player, slot.value);
		}
	}
}

/** Drops everything kept for a player who left. */
export function forget(player: Player): void {
	for (const slot of propertySlots) {
		if (slot.kind !== "playerProperty") continue;
		slot.values.delete(player);
		slot.pending.delete(player);
	}
	for (const window of windows) window.forget(player);
}
