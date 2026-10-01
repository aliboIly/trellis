// The server and a client booted together, talking through the runner's fake remotes. The cases
// share one boot, so they run in order and each one starts where the last one left off.

import { isIntegerIn, isNothing, isRecord, isStringMax } from "../check";
import * as Client from "../client";
import { configure, settings } from "../config";
import { command, contract, event, playerProperty, request, sharedProperty } from "../contract";
import { isErrorCode, newErrorCode } from "../errors";
import * as Server from "../server";
import type { ErrorEntry } from "../server";
import { harness, sentTo } from "./harness";
import { Suite, assertEqual, assertFalse, assertNothing, assertThrows, assertTrue } from "./runner";

interface Order {
	readonly item: string;
	readonly count: number;
}

interface Receipt {
	readonly ok: boolean;
	readonly total: number;
}

const isOrder = isRecord<Order>({ item: isStringMax(12), count: isIntegerIn(1, 9) });

const Shop = contract("shop", {
	buy: request<Order, Receipt>(isOrder, 30),
	poke: command<undefined>(isNothing, 2),
	jam: command<undefined>(isNothing, 5),
	coins: playerProperty<number>(),
	open: sharedProperty<boolean>(),
	sold: event<string>(),
});

const Stock = contract("stock", {
	count: request<undefined, number>(isNothing, 5),
});

// What the server saw.
const records = new Array<ErrorEntry>();
const denied = new Array<string>();
const accepted = new Array<string>();
const acceptedFrom = new Array<string>();
const joins = new Array<string>();
const leaves = new Array<string>();
let pokes = 0;
let stockCalls = 0;

const analytics = Server.service({
	name: "analytics",
	init: () => {
		Server.onError((entry) => {
			records.push(entry);
		});
		Server.onAccepted((name, player) => {
			accepted.push(name);
			acceptedFrom.push(player.Name);
		});
		Server.onDenied((player, detail) => {
			denied.push(`${player.Name} ${detail}`);
		});
		Server.onLeft((player) => {
			leaves.push(`analytics ${player.Name}`);
		});
	},
});

const shop = Server.service({
	name: "shop",
	deps: [analytics],
	contract: Shop,
	handlers: {
		buy: (_player, order) => ({ ok: order.item === "apple", total: order.count * 2 }),
		poke: () => {
			pokes += 1;
		},
		jam: () => {
			error("the till is stuck");
		},
	},
	init: () => {
		Server.onJoined((player) => {
			joins.push(player.Name);
			shop.client.coins.set(player, 10);
		});
		Server.onLeft((player) => {
			leaves.push(`shop ${player.Name}`);
		});
	},
	start: () => {
		shop.client.open.set(true);
		// Sent while the server boots, before trellis has announced the player who is already in.
		shop.client.sold.fire(harness.me, "early");
	},
});

const broken = Server.service({
	name: "broken",
	init: () => {
		error("no config");
	},
});

const stock = Server.service({
	name: "stock",
	deps: [broken],
	contract: Stock,
	handlers: {
		count: () => {
			stockCalls += 1;
			return 3;
		},
	},
});

// What the client saw.
const seenCoins = new Array<number>();
const seenSold = new Array<string>();
const lines = new Array<string>();

const shopView = Client.controller({
	name: "shopView",
	init: () => {
		const remote = Client.use(Shop);
		remote.coins.observe((value) => {
			seenCoins.push(value);
		});
		remote.sold.connect((item) => {
			seenSold.push(item);
		});
	},
});

const faulty = Client.controller({
	name: "faulty",
	init: () => {
		error("missing part");
	},
});

const afterFaulty = Client.controller({ name: "afterFaulty", deps: [faulty] });

function recordAt(site: string, side: string): ErrorEntry {
	const found = records.find((entry) => entry.site === site && entry.side === side);
	if (found === undefined) error(`no ${side} record at ${site}`, 2);
	return found;
}

function lastLine(): string {
	return lines[lines.size() - 1] ?? "";
}

export const suite = new Suite("wire")
	.test("the server boots what it can and skips what depends on a failure", () => {
		const report = Server.boot([analytics, shop, broken, stock]);
		assertFalse(report.ok, "ok");
		assertEqual(report.failed.join(","), "broken", "failed");
		assertEqual(report.skipped.join(","), "stock", "skipped");
		assertEqual(
			report.split.map(([name]) => name).join(","),
			"analytics,shop,broken,stock",
			"split",
		);
		const failure = recordAt("boot:broken", "boot");
		assertTrue(failure.message.find("no config", 1, true)[0] !== undefined, "with its message");
		assertTrue(isErrorCode(failure.code), "under a code");
		assertEqual(failure.context, "phase=spec", "with the game's context");
	})
	.test("a player who was in before the boot is announced once", () => {
		assertEqual(joins.join(","), "me", "joins");
	})
	.test("the client boots, and a failed controller skips its dependents", () => {
		const report = Client.boot([shopView, faulty, afterFaulty]);
		assertFalse(report.ok, "ok");
		assertEqual(report.failed.join(","), "faulty", "failed");
		assertEqual(report.skipped.join(","), "afterFaulty", "skipped");
		harness.settle();
		const sent = recordAt("boot:faulty", "client");
		assertEqual(sent.doing, "last=boot screen=shop", "the client's context rides the report");
		Client.onErrorLine((code, site) => {
			lines.push(`${site} ${code}`);
		});
		assertEqual(
			lines[0],
			`boot ${sent.code}`,
			"a late show still gets the first line, same code",
		);
	})
	.test("the hello brings every property value", () => {
		const remote = Client.use(Shop);
		assertEqual(remote.coins.get(), 10, "coins");
		assertEqual(remote.open.get(), true, "open");
		assertEqual(seenCoins.join(","), "10", "observed once");
		assertEqual(
			seenSold.join(","),
			"early",
			"an event sent during the boot waits for the hello",
		);
	})
	.test("requests get answers", () => {
		const remote = Client.use(Shop);
		const apple = remote.buy({ item: "apple", count: 2 });
		assertEqual(apple?.ok, true, "apple ok");
		assertEqual(apple?.total, 4, "apple total");
		assertEqual(remote.buy({ item: "pear", count: 1 })?.ok, false, "pear");
		assertTrue(accepted.includes("shop.buy"), "counted as accepted");
		assertEqual(acceptedFrom[accepted.indexOf("shop.buy")], "me", "with the player who called");
	})
	.test("payloads that fail the check never reach the handler", () => {
		const before = accepted.size();
		const me = harness.me;
		assertNothing(harness.invoke(me, "shop", "buy", { item: 5, count: 1 }), "number item");
		assertNothing(
			harness.invoke(me, "shop", "buy", { item: "apple", count: 1, x: 1 }),
			"extra key",
		);
		assertNothing(harness.invoke(me, "shop", "buy", { item: "apple", count: 0 }), "zero");
		assertNothing(harness.invoke(me, "shop", "buy", "apple"), "string");
		assertEqual(accepted.size(), before, "none counted");
	})
	.test("calls over the budget are denied", () => {
		const remote = Client.use(Shop);
		remote.poke();
		remote.poke();
		remote.poke();
		harness.settle();
		assertEqual(pokes, 2, "handled");
		assertEqual(denied.join(";"), "me 2 calls in 10s on shop.poke", "denied");
	})
	.test("a handler that throws gives the player a code", () => {
		Client.use(Shop).jam();
		harness.settle();
		const jam = recordAt("net:shop.jam", "server");
		assertTrue(jam.message.find("the till is stuck", 1, true)[0] !== undefined, "message");
		assertEqual(jam.player, harness.me, "player");
		assertTrue(jam.stack !== "", "stack");
		assertEqual(lastLine(), `net ${jam.code}`, "the client shows the same code");
	})
	.test("sets in one frame are sent once, with the last value", () => {
		const me = harness.me;
		const before = sentTo(me, "shop", "coins").size();
		shop.client.coins.set(me, 1);
		shop.client.coins.set(me, 2);
		shop.client.coins.set(me, 3);
		harness.settle();
		const after = sentTo(me, "shop", "coins");
		assertEqual(after.size(), before + 1, "one send");
		assertEqual(after[after.size() - 1], "3", "last value");
		assertEqual(Client.use(Shop).coins.get(), 3, "client value");
		assertEqual(seenCoins.join(","), "10,3", "observed");
	})
	.test("a service that isn't running answers nothing", () => {
		assertNothing(harness.invoke(harness.me, "stock", "count", undefined), "answer");
		assertEqual(stockCalls, 0, "handler never ran");
	})
	.test("events and values wait for a player's hello", () => {
		const guest = harness.join("guest");
		harness.settle();
		assertEqual(joins.join(","), "me,guest", "joined");
		shop.client.sold.fireAll("apple");
		shop.client.sold.fire(guest, "welcome");
		harness.settle();
		assertEqual(sentTo(guest, "shop", "sold").size(), 0, "no event before hello");
		assertEqual(sentTo(guest, "shop", "coins").size(), 0, "no value before hello");
		assertEqual(seenSold.join(","), "early,apple", "me got the event");
		harness.fire(guest, "session", "hello", true);
		harness.settle();
		assertEqual(sentTo(guest, "shop", "coins").join(","), "10", "value after hello");
		assertEqual(sentTo(guest, "shop", "open").join(","), "true", "shared value after hello");
		assertEqual(
			sentTo(guest, "shop", "sold").join(","),
			"apple,welcome",
			"both events, in the order they were sent",
		);
		const order = harness
			.sent()
			.filter((each) => each.to === "guest")
			.map((each) => each.member)
			.join(",");
		assertEqual(order, "coins,open,sold,sold", "the held events come after the values");
	})
	.test("leaves run in reverse order and the player is forgotten", () => {
		const guest = harness.join("leaver");
		harness.settle();
		harness.leave(guest);
		harness.settle();
		assertEqual(leaves.join(","), "shop leaver,analytics leaver", "order");
		assertNothing(shop.client.coins.get(guest), "value dropped");
		shop.client.coins.set(guest, 99);
		assertNothing(shop.client.coins.get(guest), "a set after the leave is ignored");
	})
	.test("an event held for a player who leaves is never sent", () => {
		const ghost = harness.join("ghost");
		harness.settle();
		shop.client.sold.fire(ghost, "lost");
		harness.leave(ghost);
		harness.settle();
		assertEqual(sentTo(ghost, "shop", "sold").size(), 0, "nothing sent");
	})
	.test("guard records with the game's own site", () => {
		const ok = Server.guard("purchase:vip", harness.me, () => {
			error("grant failed");
		});
		assertFalse(ok, "returns false");
		harness.settle();
		const grant = recordAt("purchase:vip", "server");
		assertEqual(lastLine(), `purchase ${grant.code}`, "the client shows the purchase line");
	})
	.test("a code the game recorded itself can be shown to a player", () => {
		const code = Server.record({
			side: "server",
			site: "purchase:trade",
			message: "the swap did not finish",
			stack: "",
			player: harness.me,
		});
		Server.showCode(harness.me, code, "purchase:trade");
		harness.settle();
		assertEqual(lastLine(), `purchase ${code}`, "the client shows the line");
	})
	.test("uncaught server errors are recorded once each", () => {
		harness.crash("lost the floor");
		harness.crash("lost the floor");
		harness.settle();
		const uncaught = records.filter(
			(entry) =>
				entry.side === "server" &&
				entry.site === "uncaught" &&
				entry.message === "lost the floor",
		);
		assertEqual(uncaught.size(), 1, "once");
	})
	.test("forged and extra reports are dropped", () => {
		const before = records.size();
		const forged = { code: "HC-ABCDEF", site: "net", message: "x", stack: "", doing: "" };
		harness.fire(harness.me, "session", "report", forged);
		harness.settle();
		assertEqual(records.size(), before, "other game's code");
		const noisy = harness.join("noisy");
		harness.settle();
		for (let i = 0; i < 6; i++) {
			const report = {
				code: newErrorCode(),
				site: "net",
				message: `${i}`,
				stack: "",
				doing: "",
			};
			harness.fire(noisy, "session", "report", report);
		}
		harness.settle();
		const kept = records.filter((entry) => entry.player === noisy && entry.side === "client");
		assertEqual(kept.size(), 5, "five per player");
	})
	.test("a listener that disconnects while being called doesn't skip the next", () => {
		const remote = Client.use(Shop);
		const calls = new Array<string>();
		const disconnect = remote.sold.connect(() => {
			calls.push("first");
			disconnect();
		});
		remote.sold.connect(() => {
			calls.push("second");
		});
		shop.client.sold.fire(harness.me, "pear");
		harness.settle();
		shop.client.sold.fire(harness.me, "plum");
		harness.settle();
		assertEqual(calls.join(","), "first,second,second", "calls");
	})
	.test("use gives one object per contract", () => {
		assertTrue(Client.use(Shop) === Client.use(Shop), "same object");
	})
	.test("settings, boots and subscriptions are refused at the wrong time", () => {
		assertThrows(
			() => {
				configure({ ...settings() });
			},
			"before boot",
			"configure after boot",
		);
		assertThrows(() => Server.boot([]), "booted twice", "server boot");
		assertThrows(() => Client.boot([]), "booted twice", "client boot");
		assertThrows(
			() => {
				Server.onJoined(() => {});
			},
			"subscribe to players",
			"subscribe outside init",
		);
	});
