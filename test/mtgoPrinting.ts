import { describe, it } from "mocha";
import { expect } from "chai";
import { printingWithMTGOID } from "../client/src/mtgoPrinting.js";

describe("MTGO export printing choice", function () {
	// Scryfall's exact-name search for "Swords to Plowshares", in the order it returns them: the newest
	// printing is the back face of Emeritus of Truce, which has its own MTGO id.
	const swordsSearch = [
		{ name: "Emeritus of Truce // Swords to Plowshares", mtgo_id: 149525 },
		{ name: "Swords to Plowshares", mtgo_id: undefined },
		{ name: "Swords to Plowshares", mtgo_id: 157076 },
		{ name: "Swords to Plowshares", mtgo_id: 156470 },
	];

	it("skips a printing that only shares the card's name on another face", function () {
		expect(printingWithMTGOID("Swords to Plowshares", swordsSearch)?.mtgo_id).to.equal(157076);
	});

	it("still finds the double-faced card when that is the card exported", function () {
		expect(printingWithMTGOID("Emeritus of Truce // Swords to Plowshares", swordsSearch)?.mtgo_id).to.equal(149525);
		expect(printingWithMTGOID("Emeritus of Truce", swordsSearch)?.mtgo_id).to.equal(149525);
	});

	it("finds nothing when no printing of the card is on MTGO", function () {
		expect(printingWithMTGOID("Swords to Plowshares", swordsSearch.slice(0, 2))).to.be.undefined;
	});
});
