import { configure, isSite, settings } from "../config";
import { Suite, assertEqual, assertFalse, assertThrows, assertTrue } from "./runner";

function withPrefix(codePrefix: string): () => void {
	return () => {
		configure({ ...settings(), codePrefix });
	};
}

export const suite = new Suite("config")
	.test("a prefix is capital letters and a dash", () => {
		assertThrows(withPrefix("sp-"), "bad code prefix", "lowercase");
		assertThrows(withPrefix("SP"), "bad code prefix", "no dash");
		assertThrows(withPrefix("S1-"), "bad code prefix", "digit");
		assertThrows(withPrefix("-"), "bad code prefix", "dash only");
		assertEqual(settings().codePrefix, "SP-", "a refused prefix changes nothing");
	})
	.test("sites are the core ones and the game's", () => {
		assertTrue(isSite("boot"), "boot");
		assertTrue(isSite("net"), "net");
		assertTrue(isSite("uncaught"), "uncaught");
		assertTrue(isSite("purchase"), "the game's own");
		assertFalse(isSite("trade"), "not listed");
		assertFalse(isSite(1), "not a string");
	});
