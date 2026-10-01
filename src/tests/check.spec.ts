import {
	isArrayOf,
	isBoolean,
	isIntegerIn,
	isNothing,
	isNumber,
	isOneOf,
	isRecord,
	isString,
	isStringMax,
} from "../check";
import { Suite, assertFalse, assertTrue } from "./runner";

interface Order {
	readonly item: string;
	readonly count: number;
}

const isOrder = isRecord<Order>({ item: isStringMax(8), count: isIntegerIn(1, 5) });

// A table with whatever keys are given, the way an exploit can build one.
function rawTable(entries: ReadonlyArray<readonly [unknown, unknown]>): unknown {
	const made = new Map<unknown, unknown>();
	for (const [key, value] of entries) made.set(key, value);
	return made;
}

export const suite = new Suite("check")
	.test("plain types", () => {
		assertTrue(isString("a"), "string");
		assertFalse(isString(1), "number as string");
		assertTrue(isBoolean(false), "boolean");
		assertFalse(isBoolean(undefined), "nil as boolean");
		assertTrue(isNothing(undefined), "nothing");
		assertFalse(isNothing(0), "zero as nothing");
	})
	.test("numbers must be real", () => {
		assertTrue(isNumber(1.5), "1.5");
		assertFalse(isNumber(0 / 0), "nan");
		assertFalse(isNumber(math.huge), "inf");
		assertFalse(isNumber(-math.huge), "-inf");
		assertFalse(isNumber("1"), "string");
	})
	.test("integers in a range", () => {
		const check = isIntegerIn(1, 3);
		assertTrue(check(1), "low end");
		assertTrue(check(3), "high end");
		assertFalse(check(0), "below");
		assertFalse(check(4), "above");
		assertFalse(check(1.5), "fraction");
		assertFalse(check(0 / 0), "nan");
	})
	.test("strings up to a length", () => {
		const check = isStringMax(3);
		assertTrue(check(""), "empty");
		assertTrue(check("abc"), "at the limit");
		assertFalse(check("abcd"), "over");
	})
	.test("one of a list", () => {
		const check = isOneOf(["red", "blue"]);
		assertTrue(check("red"), "red");
		assertFalse(check("green"), "green");
		assertFalse(check(1), "number");
	})
	.test("records need exactly their keys", () => {
		assertTrue(isOrder({ item: "apple", count: 2 }), "good");
		assertFalse(isOrder({ item: "apple" }), "missing key");
		assertFalse(isOrder({ item: "apple", count: 2, price: 0 }), "extra key");
		assertFalse(isOrder({ item: "apple", count: 9 }), "bad value");
		assertFalse(isOrder(rawTable([[1, "apple"]])), "number key");
		assertFalse(isOrder("apple"), "not a table");
	})
	.test("arrays", () => {
		const check = isArrayOf(isString, 3);
		assertTrue(check([]), "empty");
		assertTrue(check(["a", "b", "c"]), "full");
		assertFalse(check(["a", "b", "c", "d"]), "over the max");
		assertFalse(check(["a", 1]), "bad item");
		assertFalse(
			check(
				rawTable([
					[1, "a"],
					[3, "c"],
				]),
			),
			"hole",
		);
		assertFalse(
			check(
				rawTable([
					[0, "a"],
					[2, "b"],
				]),
			),
			"starts at zero",
		);
		assertFalse(
			check(
				rawTable([
					[1, "a"],
					["x", "b"],
				]),
			),
			"string key",
		);
		assertFalse(
			check(
				rawTable([
					[1, "a"],
					[1.5, "b"],
				]),
			),
			"fraction key",
		);
	});
