import { configure } from "../config";
import * as Check from "./check.spec";
import * as Config from "./config.spec";
import * as Contract from "./contract.spec";
import * as Errors from "./errors.spec";
import * as Limiter from "./limiter.spec";
import * as Order from "./order.spec";
import type { Suite } from "./runner";
import * as Wire from "./wire.spec";

/** Runs every suite and returns how many cases failed. */
export function run(): number {
	configure({
		name: "spec",
		codePrefix: "SP-",
		errorLine: (code, site) => `${site} broke (${code})`,
		sites: ["purchase"],
		recordContext: () => "phase=spec",
		reportContext: () => "screen=shop",
	});
	// The wire suite boots trellis, which locks the settings, so it goes last.
	const suites: ReadonlyArray<Suite> = [
		Config.suite,
		Order.suite,
		Check.suite,
		Contract.suite,
		Errors.suite,
		Limiter.suite,
		Wire.suite,
	];
	let total = 0;
	const failed = new Array<string>();
	for (const suite of suites) {
		const result = suite.run();
		total += result.total;
		for (const name of result.failed) failed.push(name);
	}
	print(`[spec] ${total - failed.size()}/${total} passed`);
	return failed.size();
}
