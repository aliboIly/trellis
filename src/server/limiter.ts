// Rate limiting for client calls. Each command and request gets its own window when it is bound.
//
// A window allows `max` calls per key inside `windowSeconds`. Each key keeps the times of its last
// `max` allowed calls in a ring, with the oldest at `next`. A call is allowed if fewer than `max`
// calls were ever allowed, or if the oldest of the last `max` is outside the window. That gives
// the same answer as counting calls in the window, without building a table on every call.

/** The window every budget is counted in, in seconds. */
export const RATE_WINDOW_SECONDS = 10;

export interface SlidingWindow<Key> {
	readonly allow: (key: Key, now: number) => boolean;
	readonly forget: (key: Key) => void;
}

interface Ring {
	readonly times: Array<number>;
	next: number;
}

export function slidingWindow<Key>(max: number, windowSeconds: number): SlidingWindow<Key> {
	const rings = new Map<Key, Ring>();
	return {
		allow: (key, now) => {
			let ring = rings.get(key);
			if (ring === undefined) {
				ring = { times: [], next: 0 };
				rings.set(key, ring);
			}
			const times = ring.times;
			if (times.size() < max) {
				times.push(now);
				return true;
			}
			if (now - times[ring.next] < windowSeconds) return false;
			times[ring.next] = now;
			ring.next = (ring.next + 1) % max;
			return true;
		},
		forget: (key) => {
			rings.delete(key);
		},
	};
}
