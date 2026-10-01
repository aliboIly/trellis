// The fake engine in scripts/run-specs.luau. It only exists in the spec run.

export interface Sent {
	readonly contract: string;
	readonly member: string;
	/** The player's name. */
	readonly to: string;
	readonly payload: unknown;
}

interface Harness {
	/** The player whose client runs in this process. In the server from the start. */
	readonly me: Player;
	readonly join: (name: string) => Player;
	readonly leave: (player: Player) => void;
	/** Everything the server sent, oldest first. */
	readonly sent: () => ReadonlyArray<Sent>;
	/** Sends straight to the server as `player`, the way an exploit could. */
	readonly fire: (player: Player, contract: string, member: string, payload: unknown) => void;
	readonly invoke: (
		player: Player,
		contract: string,
		member: string,
		payload: unknown,
	) => unknown;
	/** An uncaught error, the way ScriptContext.Error reports one. */
	readonly crash: (message: string) => void;
	/** Waits a few frames, so deferred work and remote traffic finish. */
	readonly settle: () => void;
}

export const harness = (game as unknown as { readonly harness: Harness }).harness;

/** What the server sent one player on one member, oldest first, each payload as text. */
export function sentTo(player: Player, contract: string, member: string): ReadonlyArray<string> {
	return harness
		.sent()
		.filter(
			(each) =>
				each.to === player.Name && each.contract === contract && each.member === member,
		)
		.map((each) => tostring(each.payload));
}
