import { isNothing } from "../check";
import {
	command,
	contract,
	event,
	membersOf,
	playerProperty,
	request,
	sharedProperty,
} from "../contract";
import { Suite, assertEqual, assertThrows } from "./runner";

export const suite = new Suite("contract")
	.test("commands and requests need a budget", () => {
		assertThrows(() => command<undefined>(isNothing, 0), "budget above zero", "command");
		assertThrows(
			() => request<undefined, number>(isNothing, -1),
			"budget above zero",
			"request",
		);
	})
	.test("members keep their kinds", () => {
		const shop = contract("shop", {
			buy: request<undefined, number>(isNothing, 1),
			poke: command<undefined>(isNothing, 1),
			sold: event<string>(),
			coins: playerProperty<number>(),
			open: sharedProperty<boolean>(),
		});
		const kinds = membersOf(shop.members);
		assertEqual(kinds.size(), 5, "count");
		assertEqual(kinds.get("buy")?.kind, "request", "buy");
		assertEqual(kinds.get("poke")?.kind, "command", "poke");
		assertEqual(kinds.get("sold")?.kind, "event", "sold");
		assertEqual(kinds.get("coins")?.kind, "playerProperty", "coins");
		assertEqual(kinds.get("open")?.kind, "sharedProperty", "open");
	});
