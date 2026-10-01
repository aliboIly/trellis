import { order } from "../order";
import type { Node } from "../order";
import { Suite, assertEqual, assertThrows } from "./runner";

function node(name: string, deps: ReadonlyArray<Node> = []): Node {
	return { name, deps };
}

function names(nodes: ReadonlyArray<Node>): string {
	return nodes.map((each) => each.name).join(" ");
}

export const suite = new Suite("order")
	.test("keeps the given order when nothing depends on anything", () => {
		const a = node("a");
		const b = node("b");
		const c = node("c");
		assertEqual(names(order([c, a, b])), "c a b", "order");
	})
	.test("puts dependencies first", () => {
		const data = node("data");
		const shop = node("shop", [data]);
		const ui = node("ui", [shop]);
		assertEqual(names(order([ui, shop, data])), "data shop ui", "order");
	})
	.test("moves only what has to move", () => {
		const a = node("a");
		const b = node("b");
		const c = node("c", [a]);
		const d = node("d");
		assertEqual(names(order([c, b, a, d])), "b a c d", "order");
	})
	.test("names the cycle", () => {
		const a: { name: string; deps: Array<Node> } = { name: "a", deps: [] };
		const b = node("b", [a]);
		a.deps.push(b);
		assertThrows(() => order([a, b]), "a -> b -> a", "cycle");
	})
	.test("names a cycle that starts deeper in", () => {
		const a: { name: string; deps: Array<Node> } = { name: "a", deps: [] };
		const b: { name: string; deps: Array<Node> } = { name: "b", deps: [] };
		const entry = node("entry", [a]);
		a.deps.push(b);
		b.deps.push(a);
		assertThrows(() => order([entry, a, b]), "a -> b -> a", "cycle");
	})
	.test("rejects a dependency that isn't listed", () => {
		const missing = node("missing");
		assertThrows(() => order([node("a", [missing])]), `"a" depends on "missing"`, "missing");
	})
	.test("rejects a name listed twice", () => {
		assertThrows(() => order([node("a"), node("a")]), `"a" is listed twice`, "twice");
	});
