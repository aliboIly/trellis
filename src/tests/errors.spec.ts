import {
	LIMITS,
	clientLine,
	isCode,
	isErrorCode,
	isErrorReport,
	mintCode,
	newErrorCode,
	plainAscii,
	siteKey,
	siteOf,
	trimTo,
} from "../errors";
import { Suite, assertEqual, assertFalse, assertTrue } from "./runner";

const report = {
	code: "SP-ABCDEF",
	site: "net:shop.buy",
	message: "attempt to index nil",
	stack: "stack",
	doing: "last=shop.buy",
};

export const suite = new Suite("errors")
	.test("codes are the prefix and six readable characters", () => {
		for (let i = 0; i < 50; i++) {
			const code = newErrorCode();
			assertEqual(code.size(), 9, "length");
			assertEqual(code.sub(1, 3), "SP-", "prefix");
			assertTrue(code.sub(4).match("[01IO]")[0] === undefined, `${code} has no 0, 1, I or O`);
			assertTrue(isErrorCode(code), `${code} reads back`);
		}
	})
	.test("codes from other games or other shapes are refused", () => {
		assertFalse(isErrorCode("HC-ABCDEF"), "other prefix");
		assertFalse(isErrorCode("SP-ABCDE"), "short");
		assertFalse(isErrorCode("SP-ABCDEFG"), "long");
		assertFalse(isErrorCode("SP-ABCDE0"), "zero");
		assertFalse(isErrorCode("SP-abcdef"), "lowercase");
		assertFalse(isErrorCode(12), "number");
		assertTrue(isCode(mintCode("X-", 3), "X-", 3), "any shape mints and reads back");
	})
	.test("only printable ASCII survives", () => {
		assertEqual(plainAscii("café"), "caf??", "two bytes, two marks");
		assertEqual(plainAscii("tab\there"), "tab?here", "tab");
		assertEqual(plainAscii("one\ntwo"), "one\ntwo", "newline kept");
	})
	.test("trimTo cuts at the limit", () => {
		assertEqual(trimTo("abcdef", 3), "abc", "cut");
		assertEqual(trimTo("ab", 3), "ab", "short enough");
	})
	.test("site keys", () => {
		assertEqual(siteKey("net", "shop.buy"), "net:shop.buy", "with detail");
		assertEqual(siteKey("boot", ""), "boot", "no detail");
		assertEqual(siteKey("net", "two words\there"), "net:two_words_here", "whitespace folds");
		const long = siteKey("net", "x".rep(100));
		assertEqual(long.size(), "net:".size() + LIMITS.detailMax, "detail bounded");
	})
	.test("siteOf reads the site and calls unknown ones net", () => {
		assertEqual(siteOf("boot:shop"), "boot", "boot");
		assertEqual(siteOf("purchase:vip"), "purchase", "the game's own");
		assertEqual(siteOf("uncaught"), "uncaught", "no detail");
		assertEqual(siteOf("trade:offer"), "net", "unknown");
	})
	.test("the player's line comes from the game's setting", () => {
		assertEqual(clientLine("SP-ABCDEF", "boot"), "boot broke (SP-ABCDEF)", "known site");
		assertEqual(clientLine("SP-ABCDEF", "trade"), "net broke (SP-ABCDEF)", "unknown site");
	})
	.test("client reports are checked whole", () => {
		assertTrue(isErrorReport(report), "good");
		assertFalse(isErrorReport({ ...report, code: "HC-ABCDEF" }), "other game's code");
		assertFalse(isErrorReport({ ...report, message: "x".rep(201) }), "long message");
		assertFalse(isErrorReport({ ...report, extra: true }), "extra key");
		assertFalse(isErrorReport({ ...report, doing: undefined }), "missing key");
	});
