// Player joins, leaves and hellos. Services subscribe here instead of connecting to Players.
//
// Joins are announced only after boot, so a player who joined while services were still starting
// is announced to all of them. A client's hello is answered with every property value; a hello
// that arrives before its player's join is announced waits for it. Leave handlers run in reverse
// subscription order, so whatever subscribed first (usually analytics) hears the leave last.

import { Players } from "@rbxts/services";

import * as Errors from "./errors";
import * as Wire from "./wire";

type PlayerHandler = (player: Player) => void;

interface Subscription {
	/** The service that subscribed. Its handler only runs while that service is running. */
	readonly service: string;
	readonly handler: PlayerHandler;
}

const joinedSubs = new Array<Subscription>();
const leftSubs = new Array<Subscription>();
const announced = new Set<Player>();
const helloWaiting = new Set<Player>();
const ready = new Set<Player>();
let accepting = false;

function run(sub: Subscription, moment: string, player: Player): void {
	if (!Wire.isRunning(sub.service)) return;
	Wire.guarded(`net:${sub.service}.${moment}`, player, () => {
		sub.handler(player);
	});
}

function markReady(player: Player): void {
	ready.add(player);
	Wire.snapshot(player);
}

function announce(player: Player): void {
	if (announced.has(player)) return;
	announced.add(player);
	for (const sub of joinedSubs) run(sub, "joined", player);
	if (helloWaiting.delete(player)) markReady(player);
}

function leave(player: Player): void {
	helloWaiting.delete(player);
	if (announced.has(player)) {
		for (let i = leftSubs.size() - 1; i >= 0; i--) run(leftSubs[i], "left", player);
	}
	announced.delete(player);
	ready.delete(player);
	Wire.forget(player);
	Errors.forget(player);
}

export function hello(player: Player): void {
	if (!announced.has(player)) {
		helloWaiting.add(player);
		return;
	}
	// A repeated hello only gets the values again.
	if (ready.has(player)) Wire.snapshot(player);
	else markReady(player);
}

// Subscriptions only happen during boot, before anyone is announced.
export function onJoined(service: string, handler: PlayerHandler): void {
	joinedSubs.push({ service, handler });
}

export function onLeft(service: string, handler: PlayerHandler): void {
	leftSubs.push({ service, handler });
}

export function isReady(player: Player): boolean {
	return ready.has(player);
}

export function readyPlayers(): ReadonlySet<Player> {
	return ready;
}

/** Starts listening. Joins wait for `announcePresent`; leaves are handled from the start. */
export function init(): void {
	Players.PlayerAdded.Connect((player) => {
		if (accepting) announce(player);
	});
	Players.PlayerRemoving.Connect(leave);
}

/** Called once boot is done: announces everyone already in, then each new join. */
export function announcePresent(): void {
	accepting = true;
	for (const player of Players.GetPlayers()) announce(player);
}
