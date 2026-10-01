// A small test runner. Each case runs under pcall, so one failure doesn't stop the rest.

export interface SuiteResult {
	readonly total: number;
	readonly failed: ReadonlyArray<string>;
}

interface Case {
	readonly name: string;
	readonly run: () => void;
}

export class Suite {
	private readonly cases = new Array<Case>();

	public constructor(private readonly name: string) {}

	/** Cases run in the order they are added. */
	public test(name: string, run: () => void): this {
		this.cases.push({ name, run });
		return this;
	}

	public run(): SuiteResult {
		const failed = new Array<string>();
		for (const entry of this.cases) {
			const [ok, err] = pcall(entry.run);
			if (ok) continue;
			failed.push(`${this.name}: ${entry.name}`);
			warn(`[spec] ${this.name}: ${entry.name}: ${tostring(err)}`);
		}
		return { total: this.cases.size(), failed };
	}
}

// These raise with level 2, so the error points at the failing case, not at this file.

export function assertEqual<T extends defined>(
	actual: T | undefined,
	expected: T,
	what: string,
): void {
	if (actual !== expected) {
		error(`${what}: expected ${tostring(expected)}, got ${tostring(actual)}`, 2);
	}
}

export function assertNothing(value: unknown, what: string): void {
	if (value !== undefined) error(`${what}: expected nothing, got ${tostring(value)}`, 2);
}

export function assertTrue(value: boolean, what: string): void {
	if (!value) error(`${what}: expected true`, 2);
}

export function assertFalse(value: boolean, what: string): void {
	if (value) error(`${what}: expected false`, 2);
}

/** `run` must throw, with `fragment` somewhere in the message. */
export function assertThrows(run: () => void, fragment: string, what: string): void {
	const [ok, err] = pcall(run);
	if (ok) error(`${what}: expected an error`, 2);
	const message = tostring(err);
	if (message.find(fragment, 1, true)[0] === undefined) {
		error(`${what}: expected an error with "${fragment}", got "${message}"`, 2);
	}
}
