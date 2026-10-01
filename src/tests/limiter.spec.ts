import { slidingWindow } from "../server/limiter";
import { Suite, assertEqual, assertFalse, assertTrue } from "./runner";

// The obvious version: keep every allowed time, count the ones inside the window.
function counting(max: number, windowSeconds: number): (now: number) => boolean {
	const allowed = new Array<number>();
	return (now) => {
		const recent = allowed.filter((time) => now - time < windowSeconds).size();
		if (recent >= max) return false;
		allowed.push(now);
		return true;
	};
}

// The same numbers on every run, so a failure can be repeated. Small enough to stay exact.
function numbers(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 16807) % 2147483647;
		return state / 2147483647;
	};
}

export const suite = new Suite("limiter")
	.test("allows up to the budget, then refuses", () => {
		const window = slidingWindow<string>(3, 10);
		assertTrue(window.allow("p", 0), "1");
		assertTrue(window.allow("p", 1), "2");
		assertTrue(window.allow("p", 2), "3");
		assertFalse(window.allow("p", 3), "4");
	})
	.test("allows again once the oldest call leaves the window", () => {
		const window = slidingWindow<string>(2, 10);
		window.allow("p", 0);
		window.allow("p", 5);
		assertFalse(window.allow("p", 9.9), "inside");
		assertTrue(window.allow("p", 10), "first one out");
		assertFalse(window.allow("p", 11), "second one still in");
		assertTrue(window.allow("p", 15), "second one out");
	})
	.test("refused calls don't count", () => {
		const window = slidingWindow<string>(1, 10);
		window.allow("p", 0);
		for (let i = 1; i < 10; i++) window.allow("p", i);
		assertTrue(window.allow("p", 10), "allowed after the first call leaves");
	})
	.test("keeps keys apart", () => {
		const window = slidingWindow<string>(1, 10);
		assertTrue(window.allow("a", 0), "a");
		assertTrue(window.allow("b", 0), "b");
		assertFalse(window.allow("a", 1), "a again");
	})
	.test("forget clears a key", () => {
		const window = slidingWindow<string>(1, 10);
		window.allow("p", 0);
		window.forget("p");
		assertTrue(window.allow("p", 1), "after forget");
	})
	.test("gives the same answers as counting", () => {
		const draw = numbers(7);
		for (const max of [1, 2, 3, 6, 10]) {
			const ring = slidingWindow<string>(max, 10);
			const plain = counting(max, 10);
			let now = 0;
			for (let i = 0; i < 2000; i++) {
				// Whole seconds half the time, so some calls land right on the window's edge.
				now += draw() < 0.5 ? math.floor(draw() * 6) : draw() * 3;
				assertEqual(ring.allow("p", now), plain(now), `max ${max}, call ${i} at ${now}`);
			}
		}
	});
