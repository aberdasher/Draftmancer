// Scryfall's exact-name search (!"name") also matches a card by any of its faces, so a search for
// "Swords to Plowshares" returns "Emeritus of Truce // Swords to Plowshares" too. Only accept a printing
// whose front face is the card's own front face.
export function printingWithMTGOID<T extends { name: string; mtgo_id?: number }>(
	cardName: string,
	printings: T[]
): T | undefined {
	const front = (name: string) => name.split(" // ")[0].toLowerCase();
	return printings.find((printing) => printing.mtgo_id && front(printing.name) === front(cardName));
}
