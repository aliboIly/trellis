// The error handler every xpcall in trellis uses. The stack has to be read inside the handler,
// because it is gone once xpcall returns. Keeping it here means a call allocates nothing.

let saved = "";

export function capture(thrown: unknown): unknown {
	saved = debug.traceback(undefined, 2);
	return thrown;
}

/** The stack from the last `capture`. Read it right after the xpcall that failed. */
export function savedTrace(): string {
	return saved;
}
