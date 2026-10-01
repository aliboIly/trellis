import { RunService } from "@rbxts/services";

import { settings } from "./config";

// Debug lines only print in Studio. Live servers stay quiet unless something is wrong.
const verbose = RunService.IsStudio();

export interface Log {
	readonly debug: (message: string) => void;
	readonly warn: (message: string) => void;
	/** Prints everywhere. Kept for the few lines a live server should always show. */
	readonly always: (message: string) => void;
}

export function scoped(scope: string): Log {
	const line = (message: string): string => `[${settings().name}][${scope}] ${message}`;
	return {
		debug: (message) => {
			if (verbose) print(line(message));
		},
		warn: (message) => {
			warn(line(message));
		},
		always: (message) => {
			print(line(message));
		},
	};
}
