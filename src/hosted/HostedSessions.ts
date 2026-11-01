import axios from "axios";
import { isDeepStrictEqual } from "node:util";
import { Session, Sessions } from "../Session.js";
import { Connection, Connections } from "../Connection.js";
import type { UserID } from "../IDTypes.js";
import { convertCubeCobraList } from "../cubeCobraIntegration.js";
import { isSocketError, Message, ToastMessage } from "../Message.js";
import { isRecord, isString, isUnknown } from "../TypeChecks.js";
import type { HostedSeat, HostedSessionSpec, HostedStatus } from "./types.js";

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

const SeatUserIDPrefix = "hosted-";

export function seatUserID(sessionID: string, index: number) {
	return `${SeatUserIDPrefix}${sessionID}-${index}`;
}

/** Seat IDs are reserved: only bindHostedSeat may hand one to a connection. */
export function isSeatUserID(userID: string) {
	return userID.startsWith(SeatUserIDPrefix);
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

type HostedSocket = Connection["socket"];

export type SeatBinding = { ok: true; userID: UserID } | { ok: false; reason: "seat-in-use" | "no-such-seat" };

/** How long a seat holder has to answer `stillAlive` before the seat is given to a newcomer (as upstream). */
export const StillAliveTimeoutMs = 3000;

// Seats with a bind in flight, so two newcomers cannot both win the same seat.
const bindingSeats = new Set<UserID>();
// Sockets that won a seat, and the session they won it in.
const boundSockets = new WeakMap<HostedSocket, string>();

/**
 * Finds the seat for a display name: an exact match first, then ignoring surrounding spaces, then ignoring case too.
 * The first rule matching exactly one seat wins; a rule matching several seats is ambiguous and matches none.
 */
export function findSeat(seats: HostedSeat[], userName: string): HostedSeat | undefined {
	const rules = [(n: string) => n, (n: string) => n.trim(), (n: string) => n.trim().toLowerCase()];
	for (const normalize of rules) {
		const wanted = normalize(userName);
		const hits = seats.filter((seat) => normalize(seat.name) === wanted);
		if (hits.length === 1) return hits[0];
		if (hits.length > 1) return undefined;
	}
	return undefined;
}

function answersStillAlive(socket: HostedSocket): Promise<boolean> {
	if (!socket.connected) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve(false), StillAliveTimeoutMs);
		socket.emit("stillAlive", () => {
			clearTimeout(timeout);
			resolve(true);
		});
	});
}

/**
 * Binds a connecting socket to the hosted seat named `userName`. A seat whose holder answers `stillAlive` is in use;
 * a holder that stays silent is disconnected and loses the seat. On success the caller must use the returned userID.
 */
export async function bindHostedSeat(session: Session, userName: string, socket: HostedSocket): Promise<SeatBinding> {
	const seat = findSeat(session.seats, userName);
	if (!seat) return { ok: false, reason: "no-such-seat" };
	if (bindingSeats.has(seat.userID)) return { ok: false, reason: "seat-in-use" };

	bindingSeats.add(seat.userID);
	try {
		const holder = Connections[seat.userID];
		if (holder) {
			const msg = new Message("Connecting...");
			msg.allowOutsideClick = false;
			socket.emit("message", msg);
			if (await answersStillAlive(holder.socket)) return { ok: false, reason: "seat-in-use" };
			holder.socket.disconnect(true);
			// Let the disconnect handler release the seat and delete the previous Connection.
			await new Promise((resolve) => process.nextTick(resolve));
			socket.emit("message", new ToastMessage("Connected"));
		}
		if (Connections[seat.userID]) return { ok: false, reason: "seat-in-use" };
		if (Sessions[session.id] !== session) return { ok: false, reason: "no-such-seat" };
		boundSockets.set(socket, session.id);
		return { ok: true, userID: seat.userID };
	} finally {
		bindingSeats.delete(seat.userID);
	}
}

/** True when `userID` holds one of this session's seats through a socket that bindHostedSeat accepted. */
export function holdsSeat(session: Session, userID: UserID): boolean {
	const connection = Connections[userID];
	return (
		connection !== undefined &&
		boundSockets.get(connection.socket) === session.id &&
		session.seats.some((seat) => seat.userID === userID)
	);
}

export function setSeatConnected(session: Session, userID: UserID, connected: boolean) {
	const seat = session.seats.find((s) => s.userID === userID);
	if (!seat) return;
	seat.connected = connected;
	seat.disconnectedSince = connected ? null : Date.now();
}

export const SeatRefusals: Record<"seat-in-use" | "no-such-seat", [title: string, text: string]> = {
	"seat-in-use": [
		"Seat in use",
		"Your seat is already connected on another device or tab. Close it there first, or ask the organizer for help.",
	],
	"no-such-seat": [
		"No seat for this name",
		"This draft has no seat for your name. Open the link you were given for this draft without changing your name.",
	],
};
