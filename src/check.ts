// Checks for values that come from outside the server, mostly client payloads.
// A check never converts a value. It only says yes or no.

export type Check<T> = (value: unknown) => value is T;

export const isString: Check<string> = (value): value is string => typeIs(value, "string");

export const isBoolean: Check<boolean> = (value): value is boolean => typeIs(value, "boolean");

/** For members that carry no payload. */
export const isNothing: Check<undefined> = (value): value is undefined => value === undefined;

/** A real number. NaN and infinity fail. */
export const isNumber: Check<number> = (value): value is number =>
	typeIs(value, "number") && value === value && math.abs(value) !== math.huge;

export function isIntegerIn(low: number, high: number): Check<number> {
	return (value): value is number =>
		isNumber(value) && value % 1 === 0 && value >= low && value <= high;
}

export function isStringMax(max: number): Check<string> {
	return (value): value is string => typeIs(value, "string") && value.size() <= max;
}

export function isOneOf<T extends string>(values: ReadonlyArray<T>): Check<T> {
	return (value): value is T =>
		typeIs(value, "string") && (values as ReadonlyArray<string>).includes(value);
}

/** A table with exactly these keys. Extra keys fail, since a client sending more is probing. */
export function isRecord<T extends object>(shape: {
	readonly [K in keyof T]-?: Check<T[K]>;
}): Check<T> {
	const checks = shape as unknown as Record<string, Check<unknown>>;
	return (value): value is T => {
		if (!typeIs(value, "table")) return false;
		const record = value as Record<string, unknown>;
		for (const [key] of pairs(record)) {
			if (!typeIs(key, "string") || checks[key] === undefined) return false;
		}
		for (const [key, check] of pairs(checks)) {
			if (!check(record[key])) return false;
		}
		return true;
	};
}

/** An array of at most `max` items, each passing `item`. Tables with holes or other keys fail. */
export function isArrayOf<T>(item: Check<T>, max: number): Check<ReadonlyArray<T>> {
	return (value): value is ReadonlyArray<T> => {
		if (!typeIs(value, "table")) return false;
		let size = 0;
		for (const [key] of pairs(value)) {
			if (!typeIs(key, "number")) return false;
			size += 1;
			if (size > max) return false;
		}
		// With `size` keys in total, finding 1 to `size` all filled means there is nothing else.
		const list = value as ReadonlyArray<unknown>;
		for (let i = 0; i < size; i++) {
			const element = list[i];
			if (element === undefined || !item(element)) return false;
		}
		return true;
	};
}
