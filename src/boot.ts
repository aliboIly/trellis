// What `boot` returns on both sides.

export interface BootReport {
	/** True if every service or controller started. */
	readonly ok: boolean;
	readonly totalMs: number;
	/** Milliseconds each one spent in init and start, in boot order. */
	readonly split: ReadonlyArray<readonly [string, number]>;
	/** Threw in bind, init or start. */
	readonly failed: ReadonlyArray<string>;
	/** Never ran, because something it depends on didn't start. */
	readonly skipped: ReadonlyArray<string>;
}

export function toMs(seconds: number): number {
	return math.round(seconds * 1000);
}

/** `name=ms` pairs, for the boot's log lines. */
export function describeSplit(split: ReadonlyArray<readonly [string, number]>): string {
	return split.map(([name, ms]) => `${name}=${ms}`).join(" ");
}
