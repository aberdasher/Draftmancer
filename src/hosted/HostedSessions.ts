import axios from "axios";
import { isDeepStrictEqual } from "node:util";
import { Session, Sessions } from "../Session.js";
import { convertCubeCobraList } from "../cubeCobraIntegration.js";
import { isSocketError } from "../Message.js";
import { isRecord, isString, isUnknown } from "../TypeChecks.js";
import type { HostedSessionSpec, HostedStatus } from "./types.js";

export type CubeFetcher = (cubeID: string) => Promise<Record<string, unknown>>;

const defaultCubeFetcher: CubeFetcher = async (cubeID) => {
	const response = await axios.get(`https://cubecobra.com/cube/api/cubeJSON/${encodeURIComponent(cubeID)}`, {
		timeout: 5000,
	});
	if (response.status !== 200 || !isRecord(isString, isUnknown)(response.data))
		throw new Error(`Cube Cobra returned an unusable response for cube '${cubeID}'.`);
	return response.data;
};

let cubeFetcher: CubeFetcher = defaultCubeFetcher;

/** Replaces the Cube Cobra fetcher (tests); call with no argument to restore the default. */
export function setCubeFetcher(fetcher?: CubeFetcher) {
	cubeFetcher = fetcher ?? defaultCubeFetcher;
}

export function seatUserID(sessionID: string, index: number) {
	return `hosted-${sessionID}-${index}`;
}

export async function createHostedSession(
	spec: HostedSessionSpec,
	fetchCube: CubeFetcher = cubeFetcher
): Promise<"created" | "unchanged" | "conflict"> {
	const existing = Sessions[spec.sessionID];
	if (existing) return existing.hosted && isDeepStrictEqual(existing.hostedSpec, spec) ? "unchanged" : "conflict";

	const cube = await fetchCube(spec.cubeCobraID);
	const cardList = convertCubeCobraList({ cubeID: spec.cubeCobraID, matchVersions: true }, cube);
	if (isSocketError(cardList)) throw new Error(cardList.error?.title ?? "Invalid cube.");

	// Another request may have created it while the cube was downloading.
	const raced = Sessions[spec.sessionID];
	if (raced) return raced.hosted && isDeepStrictEqual(raced.hostedSpec, spec) ? "unchanged" : "conflict";

	const s = spec.settings;
	const session = new Session(spec.sessionID, undefined, {
		managed: true,
		hosted: true,
		ownerIsPlayer: false,
		colorBalance: false,
		personalLogs: true,
		draftLogRecipients: "delayed",
		draftLogUnlockTimer: s.draftLogUnlockTimer,
		maxTimer: s.pickTimer,
		maxPlayers: s.maxPlayers,
		boostersPerPlayer: s.boostersPerPlayer,
		cardsPerBooster: s.cardsPerBooster,
	});
	session.setTeamDraft(s.teamDraft);
	session.setCustomCardList(cardList);
	// The list may carry its own settings; the requested ones win.
	session.colorBalance = false;
	session.setBoostersPerPlayer(s.boostersPerPlayer);
	session.hostedSpec = structuredClone(spec);
	session.seats = spec.players.map((name, i) => ({
		name,
		userID: seatUserID(spec.sessionID, i),
		connected: false,
		disconnectedSince: null,
	}));

	Sessions[spec.sessionID] = session;
	return "created";
}

export function hostedStatus(id: string): HostedStatus | null {
	const session = Sessions[id];
	if (!session?.hosted) return null;
	return {
		sessionID: id,
		stage: session.drafting ? "drafting" : session.draftLog ? "ended" : "gathering",
		seats: session.seats,
		pickNumber: null,
	};
}
