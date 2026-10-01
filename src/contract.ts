// A contract lists everything one service and its clients send each other. Both sides import the
// same contract, so a payload type that changes on one side breaks the build on the other.
//
//   command          client to server, no answer
//   request          client to server, waits for an answer
//   event            server to one client or all of them
//   playerProperty   a value per player, kept in sync with that player's client
//   sharedProperty   one value, kept in sync with every client
//
// Commands and requests can't exist without a check and a budget (calls per player per window).

import type { Check } from "./check";

export interface CommandSpec<P> {
	readonly kind: "command";
	readonly check: Check<P>;
	readonly budget: number;
}

export interface RequestSpec<P, A> {
	readonly kind: "request";
	readonly check: Check<P>;
	readonly budget: number;
	/** Type only. */
	readonly answer?: A;
}

export interface EventSpec<P> {
	readonly kind: "event";
	/** Type only. */
	readonly payload?: P;
}

export interface PlayerPropertySpec<V> {
	readonly kind: "playerProperty";
	/** Type only. */
	readonly value?: V;
}

export interface SharedPropertySpec<V> {
	readonly kind: "sharedProperty";
	/** Type only. */
	readonly value?: V;
}

export type MemberSpec =
	| CommandSpec<unknown>
	| RequestSpec<unknown, unknown>
	| EventSpec<unknown>
	| PlayerPropertySpec<unknown>
	| SharedPropertySpec<unknown>;

export type Members = { readonly [member: string]: MemberSpec };

export interface Contract<M extends Members> {
	/** The folder name under `ReplicatedStorage.trellis`. Renaming it changes the wire. */
	readonly name: string;
	readonly members: M;
}

export function contract<M extends Members>(name: string, members: M): Contract<M> {
	return { name, members };
}

export function command<P>(check: Check<P>, budget: number): CommandSpec<P> {
	assert(budget > 0, "trellis: a command needs a budget above zero");
	return { kind: "command", check, budget };
}

/** Name both types: `request<Payload, Answer>(check, budget)`. */
export function request<P, A>(check: Check<P>, budget: number): RequestSpec<P, A> {
	assert(budget > 0, "trellis: a request needs a budget above zero");
	return { kind: "request", check, budget };
}

export function event<P>(): EventSpec<P> {
	return { kind: "event" };
}

export function playerProperty<V>(): PlayerPropertySpec<V> {
	return { kind: "playerProperty" };
}

export function sharedProperty<V>(): SharedPropertySpec<V> {
	return { kind: "sharedProperty" };
}

/** The members as a map, for code that walks them. */
export function membersOf(members: Members): ReadonlyMap<string, MemberSpec> {
	const map = new Map<string, MemberSpec>();
	for (const [name, spec] of pairs(members)) map.set(name as string, spec);
	return map;
}

// Server side types.

type HandlerOf<S> =
	S extends RequestSpec<infer P, infer A>
		? (player: Player, payload: P) => A
		: S extends CommandSpec<infer P>
			? (player: Player, payload: P) => void
			: never;

type InboundKeys<M extends Members> = {
	[K in keyof M]: M[K] extends CommandSpec<unknown> | RequestSpec<unknown, unknown> ? K : never;
}[keyof M];

/** Exactly one handler for each command and request. */
export type Handlers<M extends Members> = { readonly [K in InboundKeys<M>]: HandlerOf<M[K]> };

export interface ServerEvent<P> {
	/** Sends to one player. If their client is still loading, it waits until it has said hello. */
	readonly fire: (player: Player, payload: P) => void;
	/** Sends to every player. Clients still loading get it after their hello, in order. */
	readonly fireAll: (payload: P) => void;
}

export interface ServerPlayerProperty<V> {
	/** Stores the value and sends it. Several sets in one frame are sent once. */
	readonly set: (player: Player, value: V) => void;
	readonly get: (player: Player) => V | undefined;
}

export interface ServerSharedProperty<V> {
	readonly set: (value: V) => void;
	readonly get: () => V | undefined;
}

type OutboundOf<S> =
	S extends EventSpec<infer P>
		? ServerEvent<P>
		: S extends PlayerPropertySpec<infer V>
			? ServerPlayerProperty<V>
			: S extends SharedPropertySpec<infer V>
				? ServerSharedProperty<V>
				: never;

type OutboundKeys<M extends Members> = {
	[K in keyof M]: M[K] extends
		EventSpec<unknown> | PlayerPropertySpec<unknown> | SharedPropertySpec<unknown>
		? K
		: never;
}[keyof M];

/** What a service uses to talk to clients: its events and properties. */
export type ServerEndpoint<M extends Members> = {
	readonly [K in OutboundKeys<M>]: OutboundOf<M[K]>;
};

// Client side types.

export interface ClientEvent<P> {
	/** Returns a function that disconnects. */
	readonly connect: (handler: (payload: P) => void) => () => void;
}

export interface ClientProperty<V> {
	/** The last value the server sent, or undefined before the first one. */
	readonly get: () => V | undefined;
	/** Calls `handler` now if there is a value, then on every change. Returns a disconnect. */
	readonly observe: (handler: (value: V) => void) => () => void;
}

type ClientMemberOf<S> =
	S extends RequestSpec<infer P, infer A>
		? [P] extends [undefined]
			? () => A | undefined
			: (payload: P) => A | undefined
		: S extends CommandSpec<infer P>
			? [P] extends [undefined]
				? () => void
				: (payload: P) => void
			: S extends EventSpec<infer P>
				? ClientEvent<P>
				: S extends PlayerPropertySpec<infer V>
					? ClientProperty<V>
					: S extends SharedPropertySpec<infer V>
						? ClientProperty<V>
						: never;

/**
 * What a controller gets from `use`. A request yields and returns undefined if the server dropped
 * it (bad payload, over budget, service down, handler threw). A command returns right away.
 */
export type ClientEndpoint<M extends Members> = { readonly [K in keyof M]: ClientMemberOf<M[K]> };
