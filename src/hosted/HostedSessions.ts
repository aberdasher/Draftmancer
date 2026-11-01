import axios from "axios";
import { isDeepStrictEqual } from "node:util";
import { Session, Sessions } from "../Session.js";
import { Connection, Connections } from "../Connection.js";
import type { UserID } from "../IDTypes.js";
import { convertCubeCobraList } from "../cubeCobraIntegration.js";
import { isSocketError, Message, MessageError, ToastMessage } from "../Message.js";
import { isRecord, isString, isUnknown } from "../TypeChecks.js";
import { ReadyState } from "../Session/SessionTypes.js";
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

/** Once created, the players route owns the player list: a re-sent create is judged on everything else. */
function sameSession(session: Session, spec: HostedSessionSpec): boolean {
	if (!session.hosted || !session.hostedSpec) return false;
	const withoutPlayers = (s: HostedSessionSpec) => ({ ...s, players: [] });
	return isDeepStrictEqual(withoutPlayers(session.hostedSpec), withoutPlayers(spec));
}

export async function createHostedSession(
	spec: HostedSessionSpec,
	fetchCube: CubeFetcher = cubeFetcher
): Promise<"created" | "unchanged" | "conflict"> {
	const existing = Sessions[spec.sessionID];
	if (existing) return sameSession(existing, spec) ? "unchanged" : "conflict";

	const cube = await fetchCube(spec.cubeCobraID);
	const cardList = convertCubeCobraList({ cubeID: spec.cubeCobraID, matchVersions: true }, cube);
	if (isSocketError(cardList)) throw new Error(cardList.error?.title ?? "Invalid cube.");

	// Another request may have created it while the cube was downloading.
	const raced = Sessions[spec.sessionID];
	if (raced) return sameSession(raced, spec) ? "unchanged" : "conflict";

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
		ready: "unknown",
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
	// A leave invalidates the ready check, as it does in Draftmancer's own UI.
	if (!connected) clearReadyCheck(session);
}

/** Names of the seats whose player is not connected, in seat order. */
export function missingSeats(session: Session): string[] {
	return session.seats.filter((seat) => !seat.connected).map((seat) => seat.name);
}

export type HostedRefusal = { status: 400 | 409 | 500; body: Record<string, unknown> };

const notGathering = (session: Session): HostedRefusal | null =>
	session.drafting || session.draftLog ? { status: 409, body: { error: "The draft has already started." } } : null;

const seatsMissing = (session: Session): HostedRefusal | null => {
	const missing = missingSeats(session);
	return missing.length > 0 ? { status: 409, body: { missing } } : null;
};

// Sessions with a ready check whose answers still count.
const pendingReadyChecks = new WeakSet<Session>();

function clearReadyCheck(session: Session) {
	pendingReadyChecks.delete(session);
	for (const seat of session.seats) seat.ready = "unknown";
}

/** Runs Draftmancer's in-app ready check for every seat; players answer with the usual `setReady`. */
export function startHostedReadyCheck(session: Session): HostedRefusal | null {
	const refusal = notGathering(session) ?? seatsMissing(session);
	if (refusal) return refusal;
	clearReadyCheck(session);
	pendingReadyChecks.add(session);
	for (const seat of session.seats) Connections[seat.userID]?.socket.emit("readyCheck");
	return null;
}

/** Records a seat's answer to the pending ready check; answers outside a check are ignored. */
export function recordSeatReady(session: Session, userID: UserID, readyState: ReadyState) {
	if (!pendingReadyChecks.has(session)) return;
	const seat = session.seats.find((s) => s.userID === userID);
	if (!seat) return;
	if (readyState === ReadyState.Ready) seat.ready = "ready";
	else if (readyState === ReadyState.NotReady) seat.ready = "not-ready";
}

const isPermutationOf = (names: string[], of: string[]) =>
	names.length === of.length && new Set(names).size === names.length && names.every((n) => of.includes(n));

/** Orders the seats as `order`, a permutation of the seat names; the draft seats players in this order. */
export function setHostedSeating(session: Session, order: string[]): HostedRefusal | null {
	const refusal = notGathering(session);
	if (refusal) return refusal;
	const names = session.seats.map((seat) => seat.name);
	if (!isPermutationOf(order, names))
		return { status: 400, body: { error: "The order must name every seat exactly once." } };
	session.seats = order.map((name) => session.seats.find((seat) => seat.name === name)!);
	return null;
}

function nextSeatIndex(session: Session): number {
	const prefix = seatUserID(session.id, 0).slice(0, -1);
	const used = session.seats.map((seat) => Number(seat.userID.slice(prefix.length)));
	return used.length === 0 ? 0 : Math.max(...used) + 1;
}

/**
 * Replaces the expected players while the session gathers. Seats whose names remain keep their seat ID and
 * connection; new names get empty seats; a player whose name is gone loses the seat and is sent away.
 */
export function setHostedPlayers(session: Session, players: string[]): HostedRefusal | null {
	const refusal = notGathering(session);
	if (refusal) return refusal;
	const kept = new Map(session.seats.filter((seat) => players.includes(seat.name)).map((seat) => [seat.name, seat]));
	const removed = session.seats.filter((seat) => !players.includes(seat.name));
	let index = nextSeatIndex(session);
	session.seats = players.map(
		(name) =>
			kept.get(name) ?? {
				name,
				userID: seatUserID(session.id, index++),
				connected: false,
				disconnectedSince: null,
				ready: "unknown",
			}
	);
	if (session.hostedSpec) session.hostedSpec.players = [...players];
	clearReadyCheck(session);
	for (const seat of removed) {
		const connection = Connections[seat.userID];
		if (!connection) continue;
		connection.socket.emit("message", new MessageError("Seat removed", "You are no longer listed for this draft."));
		connection.socket.disconnect(true);
	}
	return null;
}

/** Starts the draft with every seat connected, seating players in seat order (never randomised). */
export function startHostedDraft(session: Session): HostedRefusal | null {
	const refusal = notGathering(session) ?? seatsMissing(session);
	if (refusal) return refusal;
	session.setRandomizeSeatingOrder(false);
	if (!session.setSeating(session.seats.map((seat) => seat.userID)))
		return { status: 500, body: { error: "The session holds players without a seat." } };
	const result = session.startDraft();
	if (isSocketError(result)) return { status: 500, body: { error: result.error?.title ?? "Could not start." } };
	return null;
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
