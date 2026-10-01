// trellis's own contract. Both sides bind it; no service serves it.

import { isBoolean } from "./check";
import { command, contract, event } from "./contract";
import { LIMITS, isErrorReport } from "./errors";
import type { ErrorCodeView, ErrorReportPayload } from "./errors";

// A client says hello once per boot. The rest is room for a slow or repeated one.
const HELLO_BUDGET = 6;

export const SessionContract = contract("session", {
	/** Sent once the client's controllers are listening. Answered with every property value. */
	hello: command<boolean>(isBoolean, HELLO_BUDGET),
	/** An error the client caught, under the code it made. */
	report: command<ErrorReportPayload>(isErrorReport, LIMITS.reportBudget),
	/** The code for an error a server handler hit on this client's call. */
	code: event<ErrorCodeView>(),
});
