// Per-game settings. Call `configure` on both the server and the client before `boot`.

export interface Settings {
	/** Shown at the start of every log line: `[name][scope]`. */
	readonly name: string;
	/** Capital letters and a dash, like `HC-`. Don't change it once the game is live. */
	readonly codePrefix: string;
	/** The line a player sees for an error. It only gets the code and the site. */
	readonly errorLine: (code: string, site: string) => string;
	/** Error sites the game uses besides `boot`, `net` and `uncaught`. */
	readonly sites?: ReadonlyArray<string>;
	/** Extra `key=value` text for the server's error log line, like the round phase. */
	readonly recordContext?: () => string;
}

const CORE_SITES: ReadonlyArray<string> = ["boot", "net", "uncaught"];

let current: Settings = {
	name: "trellis",
	codePrefix: "TR-",
	errorLine: (code) => `Something went wrong (${code}).`,
};
let locked = false;

export function configure(given: Settings): void {
	assert(!locked, "trellis: configure must run before boot");
	assert(
		given.codePrefix.match("^%u+%-$")[0] !== undefined,
		`trellis: bad code prefix "${given.codePrefix}"`,
	);
	current = given;
}

export function settings(): Settings {
	return current;
}

export function lock(): void {
	locked = true;
}

export function isSite(value: unknown): value is string {
	if (!typeIs(value, "string")) return false;
	return CORE_SITES.includes(value) || current.sites?.includes(value) === true;
}
