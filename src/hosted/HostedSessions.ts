import axios from "axios";
import { isDeepStrictEqual } from "node:util";
import { Session, Sessions } from "../Session.js";
import { Connection, Connections } from "../Connection.js";
import type { UserID } from "../IDTypes.js";
import type { DraftLog } from "../DraftLog.js";
import { convertCubeCobraList } from "../cubeCobraIntegration.js";
import { isSocketError, MessageError } from "../Message.js";
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

/**
 * Creates the hosted session `spec` describes. `isInactive` tells whether a session that is not live holds the ID
 * (Persistence's InactiveSessions, passed in so this module does not import Persistence, which imports it).
 */
export async function createHostedSession(
	spec: HostedSessionSpec,
	isInactive: (sessionID: string) => boolean,
	fetchCube: CubeFetcher = cubeFetcher
): Promise<"created" | "unchanged" | "conflict"> {
	const existing = Sessions[spec.sessionID];
	if (existing) return sameSession(existing, spec) ? "unchanged" : "conflict";
	// An inactive session would be restored over this one by the first player joining its ID.
	if (isInactive(spec.sessionID)) return "conflict";

	const cube = await fetchCube(spec.cubeCobraID);
	const cardList = convertCubeCobraList({ cubeID: spec.cubeCobraID, matchVersions: true }, cube);
	if (isSocketError(cardList)) throw new Error(cardList.error?.title ?? "Invalid cube.");

	// Another request may have created it while the cube was downloading.
	const raced = Sessions[spec.sessionID];
	if (raced) return sameSession(raced, spec) ? "unchanged" : "conflict";
	if (isInactive(spec.sessionID)) return "conflict";

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
	session.hostedCreatedAt = Date.now();
	session.seats = spec.players.map((name, i) => ({
		name,
		userID: seatUserID(spec.sessionID, i),
		connected: false,
		disconnectedSince: null,
		ready: "unknown",
	}));

	Sessions[spec.sessionID] = session;
	scheduleGatheringEnd(session);
	return "created";
}

export function hostedStatus(id: string): HostedStatus | null {
	const session = Sessions[id];
	if (!session?.hosted) return null;
	return {
		sessionID: id,
		stage: session.drafting
			? "drafting"
			: session.hostedStoppedAt !== null
				? "stopped"
				: session.draftLog
					? "ended"
					: "gathering",
		seats: session.seats,
		pickNumber: null,
	};
}

type HostedSocket = Connection["socket"];

export type SeatBinding = { ok: true; userID: UserID } | { ok: false; reason: "seat-in-use" | "no-such-seat" };

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

/**
 * Binds a connecting socket to the hosted seat named `userName`. The newest device wins: a seat already held is
 * taken from its holder, who is told why and disconnected. A second live tab is most often a stale one -- a phone
 * in a pocket, a frozen browser -- whose player is reloading because it stopped working; making them find and close
 * it first is what locks players out. The disconnect is the server's, so the old tab's socket.io does not
 * reconnect on its own and cannot take the seat back without a deliberate reload.
 * On success the caller must use the returned userID.
 */
export async function bindHostedSeat(session: Session, userName: string, socket: HostedSocket): Promise<SeatBinding> {
	const seat = findSeat(session.seats, userName);
	if (!seat) return { ok: false, reason: "no-such-seat" };
	if (bindingSeats.has(seat.userID)) return { ok: false, reason: "seat-in-use" };

	bindingSeats.add(seat.userID);
	try {
		const holder = Connections[seat.userID];
		if (holder) {
			holder.socket.emit("message", new MessageError(...SeatRefusals["opened-elsewhere"]));
			holder.socket.disconnect(true);
			// Let the disconnect handler release the seat and delete the previous Connection.
			await new Promise((resolve) => process.nextTick(resolve));
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

export type HostedRefusal = { status: 400 | 404 | 409 | 500; body: Record<string, unknown> };

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
	// A started session is no longer idle; its lifetime starts again when the draft ends.
	clearEndOfLife(session);
	return null;
}

const notDrafting = (session: Session): HostedRefusal | null =>
	session.drafting ? null : { status: 409, body: { error: "No draft is running." } };

const conflict = (error: string): HostedRefusal => ({ status: 409, body: { error } });

export function pauseHostedDraft(session: Session): HostedRefusal | null {
	const refusal = notDrafting(session);
	if (refusal) return refusal;
	if (!session.draftPaused) session.pauseDraft();
	return null;
}

export function resumeHostedDraft(session: Session): HostedRefusal | null {
	const refusal = notDrafting(session);
	if (refusal) return refusal;
	session.resumeDraft();
	return null;
}

/**
 * Stops the session: a running draft ends at once and is marked stopped (its log is neither pushed nor served);
 * a session whose draft never started is deleted, and anyone waiting in it is sent away.
 */
export function stopHostedSession(session: Session): HostedRefusal | null {
	// The draft only ends on the next tick: a second stop meanwhile must not end it again.
	if (session.hostedStoppedAt !== null) return conflict("The draft was already stopped.");
	if (session.drafting) {
		// Persisted, so a scrapped draft is never mistaken for a finished one, even after a restart.
		session.hostedStoppedAt = Date.now();
		session.stopDraft();
		return null;
	}
	if (session.draftLog) return conflict("The draft has already ended.");
	cancelGatheringSession(session);
	return null;
}

/** Deletes a session whose draft never started and sends away anyone waiting in it. */
function cancelGatheringSession(session: Session) {
	deleteHostedSession(session);
	for (const seat of session.seats) {
		const connection = Connections[seat.userID];
		if (connection?.sessionID !== session.id) continue;
		connection.socket.emit("message", new MessageError("Draft cancelled", "This draft was cancelled."));
		connection.socket.disconnect(true);
	}
}

const draftEnded = (session: Session) => !session.drafting && session.draftLog !== undefined;

/** Unlocks the delayed log for the players, as the owner's `shareDraftLog` does. */
export function releaseHostedLog(session: Session): HostedRefusal | null {
	if (!draftEnded(session)) return conflict("The draft has not ended.");
	session.unlockLogs(session.draftLog!.time);
	return null;
}

/** Hands a seat whose player left mid-draft to a bot (an admin decision; never automatic). */
export function replaceSeatWithBot(session: Session, name: string): HostedRefusal | null {
	const seat = session.seats.find((s) => s.name === name);
	if (!seat) return { status: 404, body: { error: "No such seat." } };
	const left = session.disconnectedUsers[seat.userID];
	if (!session.drafting || !left || left.replaced)
		return conflict("Only a seat whose player left the running draft can be given to a bot.");
	session.replaceDisconnectedPlayer(seat.userID);
	return null;
}

/** Sends away a user connected to this session; a seat holder's seat is freed for its rightful player. */
export function removeHostedUser(session: Session, userID: UserID): HostedRefusal | null {
	const connection = Connections[userID];
	if (connection?.sessionID !== session.id) return { status: 404, body: { error: "No such user." } };
	if (session.spectators.has(userID)) session.removeSpectator(userID);
	connection.socket.emit("message", new MessageError("Removed from the draft", "The organizer removed you."));
	connection.socket.disconnect(true);
	return null;
}

/** The full log, even while it is locked for the players, with each user's seat; undefined until the draft ends. */
export function hostedLog(session: Session): DraftLog | undefined {
	if (!draftEnded(session)) return undefined;
	const log = session.draftLog!;
	// Users are recorded in seating order; DraftBot matches them to its sign-ups by seatNum.
	const users = Object.fromEntries(
		Object.entries(log.users).map(([id, user], seatNum) => [id, { ...user, seatNum }])
	);
	return { ...log, users };
}

/** The longest delay setTimeout honours; a longer one fires at once. */
export const MaxTimeoutMs = 2 ** 31 - 1;

/** `env[name]` when it is a positive number of milliseconds, 24 hours otherwise; never more than MaxTimeoutMs. */
function lifetimeMs(env: NodeJS.ProcessEnv, name: string): number {
	const raw = env[name];
	const ms = Number(raw);
	return Math.min(raw && Number.isFinite(ms) && ms > 0 ? ms : 24 * 60 * 60 * 1000, MaxTimeoutMs);
}

/** How long an ended session is kept, from the end of its draft: HOSTED_ENDED_LIFETIME_MS, 24 hours by default. */
export function endedSessionLifetimeMs(env: NodeJS.ProcessEnv = process.env): number {
	return lifetimeMs(env, "HOSTED_ENDED_LIFETIME_MS");
}

/** How long a session whose draft never starts is kept, from its creation: HOSTED_GATHERING_LIFETIME_MS, 24 h by default. */
export function gatheringSessionLifetimeMs(env: NodeJS.ProcessEnv = process.env): number {
	return lifetimeMs(env, "HOSTED_GATHERING_LIFETIME_MS");
}

let persistDeletion: () => void = () => {};

/** Makes deletions durable at once (persistence installs a dump), so a crash cannot bring a deleted session back. */
export function setDeletionPersister(persist?: () => void) {
	persistDeletion = persist ?? (() => {});
}

const endOfLifeTimers = new WeakMap<Session, NodeJS.Timeout>();

function clearEndOfLife(session: Session) {
	clearTimeout(endOfLifeTimers.get(session));
	endOfLifeTimers.delete(session);
}

/** Runs `end` once `since + lifetime` is reached (at once if it is past), replacing the session's previous timer. */
function scheduleEndOfLifeAt(session: Session, since: number, lifetime: number, end: () => void) {
	clearEndOfLife(session);
	const remaining = Math.min(Math.max(0, since + lifetime - Date.now()), MaxTimeoutMs);
	const timer = setTimeout(end, remaining);
	timer.unref();
	endOfLifeTimers.set(session, timer);
}

export function deleteHostedSession(session: Session) {
	clearEndOfLife(session);
	if (Sessions[session.id] !== session) return;
	session.beforeDelete();
	delete Sessions[session.id];
	try {
		persistDeletion();
	} catch (e) {
		console.error(`Error persisting the deletion of hosted session ${session.id}:`, e);
	}
}

/** Deletes an ended session once its lifetime, counted from the end of the draft, is over. */
function scheduleEndOfLife(session: Session) {
	scheduleEndOfLifeAt(session, session.hostedEndedAt ?? Date.now(), endedSessionLifetimeMs(), () =>
		deleteHostedSession(session)
	);
}

const gathering = (session: Session) => !session.drafting && !session.draftLog;

/** Cancels a session whose draft has not started once its lifetime, counted from its creation, is over. */
function scheduleGatheringEnd(session: Session) {
	scheduleEndOfLifeAt(session, session.hostedCreatedAt ?? Date.now(), gatheringSessionLifetimeMs(), () => {
		if (gathering(session)) cancelGatheringSession(session);
	});
}

/**
 * A restored session keeps the lifetime it had: an ended one counted from the end of its draft (the reconciler can
 * still pull its log), a gathering one from its creation.
 */
export function onHostedSessionRestored(session: Session) {
	if (draftEnded(session)) {
		session.hostedEndedAt ??= Date.now();
		scheduleEndOfLife(session);
	} else if (gathering(session)) {
		session.hostedCreatedAt ??= Date.now();
		scheduleGatheringEnd(session);
	}
}

export type Wait = (ms: number) => Promise<void>;
const realWait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let wait: Wait = realWait;

/** Replaces the wait between push attempts (tests); call with no argument to restore the default. */
export function setLogPushWait(w?: Wait) {
	wait = w ?? realWait;
}

export const LogPushBackoffMs = [2000, 4000, 8000, 16000];

/** POSTs `{sessionID, log}` to `url`, retrying with back-off; resolves to whether it was delivered, never rejects. */
export async function pushHostedLog(url: string, sessionID: string, log: DraftLog): Promise<boolean> {
	const attempts = LogPushBackoffMs.length + 1;
	for (let attempt = 1; attempt <= attempts; ++attempt) {
		if (attempt > 1) await wait(LogPushBackoffMs[attempt - 2]);
		try {
			const token = process.env.DRAFTBOT_API_TOKEN;
			if (!token) console.error(`Pushing the log of hosted session ${sessionID} without DRAFTBOT_API_TOKEN.`);
			await axios.post(
				url,
				{ sessionID, log },
				{
					headers: token ? { Authorization: `Bearer ${token}` } : {},
					timeout: 30000,
					maxBodyLength: Infinity,
					maxContentLength: Infinity,
				}
			);
			return true;
		} catch (e) {
			const reason = axios.isAxiosError(e) ? (e.response?.status ?? e.code ?? e.message) : e;
			console.error(
				`Pushing the log of hosted session ${sessionID} failed (attempt ${attempt}/${attempts}):`,
				reason
			);
		}
	}
	return false;
}

/**
 * Called by Session.endDraft once the draft has ended: starts the session's lifetime and pushes the full log to the
 * session's webhook, unless the draft was stopped. Delivery does not end the session: players keep building and
 * exporting decks in it, so only its lifetime does.
 */
export function onHostedDraftEnded(session: Session): void {
	session.hostedEndedAt = Date.now();
	scheduleEndOfLife(session);
	const url = session.hostedSpec?.logWebhook;
	const log = hostedLog(session);
	if (!url || !log || session.hostedStoppedAt !== null) return;
	void pushHostedLog(url, session.id, log);
}

export const SeatRefusals: Record<"seat-in-use" | "no-such-seat" | "opened-elsewhere", [title: string, text: string]> =
	{
		"seat-in-use": [
			"Seat in use",
			"Your seat is being opened on another device or tab at this very moment. Reload this page to take it here.",
		],
		"no-such-seat": [
			"No seat for this name",
			"This draft has no seat for your name. Open the link you were given for this draft without changing your name.",
		],
		"opened-elsewhere": [
			"Opened elsewhere",
			"This draft was opened on another device or tab, so it moved there. Reload this page to bring it back here.",
		],
	};
