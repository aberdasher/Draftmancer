import { before, after, beforeEach, afterEach, describe, it } from "mocha";
import axios from "axios";
import { expect } from "chai";
import { Cards } from "../src/Cards.js";
import { Sessions } from "../src/Session.js";
import { DraftmancerPort } from "../src/server.js";
import {
	endedSessionLifetimeMs,
	gatheringSessionLifetimeMs,
	MaxTimeoutMs,
	setCubeFetcher,
	setDeletionPersister,
	setLogPushWait,
	stopHostedSession,
} from "../src/hosted/HostedSessions.js";
import type { HostedSessionSpec } from "../src/hosted/types.js";
import { Connections } from "../src/Connection.js";
import { ReadyState } from "../src/Session/SessionTypes.js";
import { isDraftState } from "../src/DraftState.js";
import { connectClient, disableLogs, enableLogs, getUID } from "./src/common.js";
import {
	dumpIntervalMs,
	dumpToDisk,
	InactiveSessions,
	loadFromDisk,
	restoreHostedSessions,
	setDumpWriter,
	startPeriodicDump,
} from "../src/Persistence.js";
import type { DraftLog } from "../src/DraftLog.js";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";

process.env.DRAFTBOT_API_TOKEN = "test-hosted-token";

const base = `http://localhost:${DraftmancerPort}/api/hosted/sessions`;
const auth = { headers: { Authorization: "Bearer test-hosted-token" }, validateStatus: () => true };

function fakeCube(): Record<string, unknown> {
	const ids = [...Cards.keys()].slice(0, 300);
	return { name: "Fake Cube", cards: { mainboard: ids.map((cardID) => ({ cardID })) } };
}

function makeSpec(sessionID: string): HostedSessionSpec {
	return {
		sessionID,
		players: ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank"],
		cubeCobraID: "fake-cube",
		settings: {
			teamDraft: true,
			pickTimer: 60,
			boostersPerPlayer: 3,
			cardsPerBooster: 15,
			draftLogUnlockTimer: 30,
			maxPlayers: 6,
		},
		logWebhook: null,
	};
}

describe("Hosted sessions", function () {
	this.timeout(10000);

	beforeEach(function (done) {
		disableLogs();
		done();
	});
	afterEach(function (done) {
		enableLogs(this.currentTest!.state == "failed");
		done();
	});
	before(function () {
		setCubeFetcher(async () => fakeCube());
	});
	after(function () {
		for (const id of Object.keys(Sessions)) if (Sessions[id].hosted) delete Sessions[id];
		setCubeFetcher();
	});

	it("rejects requests without the bearer token", async function () {
		const none = await axios.get(`${base}/auth-check`, { validateStatus: () => true });
		expect(none.status).to.equal(401);
		const wrong = await axios.get(`${base}/auth-check`, {
			headers: { Authorization: "Bearer nope" },
			validateStatus: () => true,
		});
		expect(wrong.status).to.equal(401);
		const put = await axios.put(`${base}/auth-check`, makeSpec("auth-check"), { validateStatus: () => true });
		expect(put.status).to.equal(401);
	});

	it("creates a hosted session with named seats", async function () {
		const spec = makeSpec("hosted-create");
		const put = await axios.put(`${base}/${spec.sessionID}`, spec, auth);
		expect(put.status).to.equal(200);

		const get = await axios.get(`${base}/${spec.sessionID}`, auth);
		expect(get.status).to.equal(200);
		expect(get.data.stage).to.equal("gathering");
		expect(get.data.seats.map((s: { name: string }) => s.name)).to.deep.equal(spec.players);
		expect(get.data.seats.every((s: { connected: boolean }) => s.connected === false)).to.be.true;

		const session = Sessions[spec.sessionID];
		expect(session.owner).to.be.undefined;
		expect(session.managed).to.be.true;
		expect(session.hosted).to.be.true;
		expect(session.ownerIsPlayer).to.be.false;
		expect(session.colorBalance).to.be.false;
		expect(session.personalLogs).to.be.true;
		expect(session.draftLogRecipients).to.equal("delayed");
		expect(session.teamDraft).to.be.true;
		expect(session.boostersPerPlayer).to.equal(3);
		expect(session.maxTimer).to.equal(60);
		expect(session.draftLogUnlockTimer).to.equal(30);
		expect(session.useCustomCardList).to.be.true;
		expect(session.customCardList.cubeCobraID).to.equal("fake-cube");
	});

	it("returns 404 for an unknown session", async function () {
		const get = await axios.get(`${base}/does-not-exist`, auth);
		expect(get.status).to.equal(404);
	});

	it("an identical PUT is a no-op and a different one is 409", async function () {
		const spec = makeSpec("hosted-idempotent");
		expect((await axios.put(`${base}/${spec.sessionID}`, spec, auth)).status).to.equal(200);
		const session = Sessions[spec.sessionID];
		expect((await axios.put(`${base}/${spec.sessionID}`, spec, auth)).status).to.equal(200);
		expect(Sessions[spec.sessionID]).to.equal(session);

		const different = { ...spec, cubeCobraID: "another-cube" };
		expect((await axios.put(`${base}/${spec.sessionID}`, different, auth)).status).to.equal(409);
	});

	it("refuses a create naming a seat twice; an empty player list is fine", async function () {
		const twice = { ...makeSpec("hosted-name-twice"), players: ["Alice", "Bob", "Alice"] };
		expect((await axios.put(`${base}/${twice.sessionID}`, twice, auth)).status).to.equal(400);
		expect(twice.sessionID in Sessions).to.be.false;
		const empty = { ...makeSpec("hosted-no-players"), players: [] };
		expect((await axios.put(`${base}/${empty.sessionID}`, empty, auth)).status).to.equal(200);
		expect(Sessions[empty.sessionID].seats).to.deep.equal([]);
	});

	it("an ID held by an inactive session is a conflict", async function () {
		const spec = makeSpec("hosted-inactive-held");
		InactiveSessions[spec.sessionID] = { id: spec.sessionID, hosted: false };
		try {
			expect((await axios.put(`${base}/${spec.sessionID}`, spec, auth)).status).to.equal(409);
			expect(spec.sessionID in Sessions).to.be.false;
		} finally {
			delete InactiveSessions[spec.sessionID];
		}
	});

	it("recreates a session that disappeared instead of claiming it is unchanged", async function () {
		const spec = makeSpec("hosted-vanished");
		expect((await axios.put(`${base}/${spec.sessionID}`, spec, auth)).status).to.equal(200);
		delete Sessions[spec.sessionID];
		expect((await axios.get(`${base}/${spec.sessionID}`, auth)).status).to.equal(404);
		const again = await axios.put(`${base}/${spec.sessionID}`, spec, auth);
		expect(again.status).to.equal(200);
		expect(again.data.result).to.equal("created");
		expect((await axios.get(`${base}/${spec.sessionID}`, auth)).status).to.equal(200);
	});

	describe("Seats", function () {
		const clients: ReturnType<typeof connectClient>[] = [];

		async function hostedSession(sessionID: string, players: string[], overrides: Partial<HostedSessionSpec> = {}) {
			const spec = { ...makeSpec(sessionID), players, ...overrides };
			expect((await axios.put(`${base}/${sessionID}`, spec, auth)).status).to.equal(200);
			return Sessions[sessionID];
		}

		async function seatStatus(sessionID: string) {
			const get = await axios.get(`${base}/${sessionID}`, auth);
			expect(get.status).to.equal(200);
			return get.data.seats as {
				name: string;
				userID: string;
				connected: boolean;
				disconnectedSince: number | null;
				ready: "unknown" | "ready" | "not-ready";
			}[];
		}

		async function until(condition: () => boolean, what: string, ms = 5000) {
			const deadline = Date.now() + ms;
			while (!condition()) {
				if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
				await new Promise((r) => setTimeout(r, 10));
			}
		}

		function connect(sessionID: string, userName: string, userID?: string) {
			const c = connectClient({ sessionID, userName, ...(userID ? { userID } : {}) });
			const messages: { title: string; icon: string }[] = [];
			const events = { hostedSeat: [] as string[], alreadyConnected: [] as string[] };
			c.on("message", (m) => messages.push(m));
			c.on("alreadyConnected", (id) => events.alreadyConnected.push(id));
			// The test client adopts its seat ID the way the browser client does.
			c.on("hostedSeat", (id) => {
				events.hostedSeat.push(id);
				(c as unknown as { query: Record<string, unknown> }).query.userID = id;
			});
			clients.push(c);
			return { c, messages, events };
		}

		const userIDOf = (c: ReturnType<typeof connectClient>) => getUID(c) as string;

		afterEach(async function () {
			for (const c of clients.splice(0)) c.disconnect();
			await until(() => Object.keys(Connections).length === 0, "connections to close");
		});

		it("a player connecting with a seat name takes that seat", async function () {
			const session = await hostedSession("hosted-seat-take", ["Alice", "Bob"]);
			const { c } = connect(session.id, "Alice", "alice-browser-id");
			const aliceSeat = session.seats[0];
			await until(() => session.users.has(aliceSeat.userID), "Alice to join");
			await until(() => userIDOf(c) === aliceSeat.userID, "the client to adopt the seat's ID");
			const seats = await seatStatus(session.id);
			expect(seats[0]).to.include({ name: "Alice", connected: true, disconnectedSince: null });
			expect(seats[1].connected).to.be.false;
			expect(session.users.size).to.equal(1);
		});

		it("sends the seat ID on hostedSeat, never alreadyConnected", async function () {
			const session = await hostedSession("hosted-seat-event", ["Alice", "Bob"]);
			const seat = session.seats[0];
			const { events } = connect(session.id, "Alice", "alice-browser-id");
			await until(() => session.users.has(seat.userID), "Alice to join");
			await until(() => events.hostedSeat.length > 0, "the hostedSeat event");
			expect(events.hostedSeat).to.deep.equal([seat.userID]);
			expect(events.alreadyConnected).to.deep.equal([]);
		});

		it("refuses a second connection to a connected seat", async function () {
			const session = await hostedSession("hosted-seat-in-use", ["Alice", "Bob"]);
			const seat = session.seats[0];
			const first = connect(session.id, "Alice", "device-one");
			await until(() => session.users.has(seat.userID), "Alice to join");

			const second = connect(session.id, "Alice", "device-two");
			await until(() => second.messages.some((m) => m.icon === "error"), "a refusal");
			expect(second.messages.find((m) => m.icon === "error")!.title).to.equal("Seat in use");
			await until(() => !second.c.connected, "the newcomer to be disconnected");

			expect(first.c.connected).to.be.true;
			expect(Connections[seat.userID].socket.id).to.equal(first.c.id);
			expect(session.users.size).to.equal(1);
			expect((await seatStatus(session.id))[0].connected).to.be.true;
		});

		it("a silent previous connection loses the seat to the newcomer", async function () {
			const session = await hostedSession("hosted-seat-silent", ["Alice", "Bob"]);
			const seat = session.seats[0];
			const first = connect(session.id, "Alice", "device-one");
			await until(() => session.users.has(seat.userID), "Alice to join");
			first.c.off("stillAlive"); // A dead tab: still connected, never answers.

			const second = connect(session.id, "Alice", "device-two");
			await until(
				() => Connections[seat.userID]?.socket.id === second.c.id,
				"the newcomer to take the seat",
				8000
			);
			await until(() => session.users.has(seat.userID), "the newcomer to join");
			expect(second.messages.some((m) => m.icon === "error")).to.be.false;
			await until(() => !first.c.connected, "the silent connection to be closed");
			expect(session.users.size).to.equal(1);
			expect((await seatStatus(session.id))[0].connected).to.be.true;
		});

		it("a returning player retakes a disconnected seat from a new device", async function () {
			const session = await hostedSession("hosted-seat-return", ["Alice", "Bob"]);
			const seat = session.seats[0];
			const first = connect(session.id, "Alice", "device-one");
			await until(() => session.users.has(seat.userID), "Alice to join");
			first.c.disconnect();
			await until(() => !(seat.userID in Connections), "Alice to leave");

			const left = (await seatStatus(session.id))[0];
			expect(left.connected).to.be.false;
			expect(left.disconnectedSince).to.be.a("number");
			expect(Sessions[session.id]).to.equal(session);

			const second = connect(session.id, "Alice", "device-two");
			await until(() => session.users.has(seat.userID), "Alice to rejoin");
			await until(() => userIDOf(second.c) === seat.userID, "the client to adopt the seat's ID");
			const back = (await seatStatus(session.id))[0];
			expect(back).to.include({ userID: seat.userID, connected: true, disconnectedSince: null });
		});

		it("refuses a name that matches no seat", async function () {
			const session = await hostedSession("hosted-seat-unknown", ["Alice", "Bob"]);
			const { c, messages } = connect(session.id, "Mallory");
			await until(() => messages.some((m) => m.icon === "error"), "a refusal");
			expect(messages.find((m) => m.icon === "error")!.title).to.equal("No seat for this name");
			await until(() => !c.connected, "Mallory to be disconnected");
			expect(session.users.size).to.equal(0);
			expect((await seatStatus(session.id)).every((s) => !s.connected)).to.be.true;
		});

		it("binds names with spaces, slashes and case", async function () {
			const session = await hostedSession("hosted-seat-names", [
				"LeWin / Legend_cay",
				"lewin / legend_cay ",
				"Bob",
			]);
			const [upper, lower, bob] = session.seats;
			connect(session.id, "LeWin / Legend_cay");
			connect(session.id, "lewin / legend_cay ");
			connect(session.id, "  bOB ");
			await until(() => session.users.size === 3, "all three to join");
			expect([...session.users].sort()).to.deep.equal([upper.userID, lower.userID, bob.userID].sort());
			expect((await seatStatus(session.id)).every((s) => s.connected)).to.be.true;
		});

		it("refuses a name that only loosely matches several seats", async function () {
			const session = await hostedSession("hosted-seat-ambiguous", ["LeWin / Legend_cay", "lewin / legend_cay "]);
			const { messages } = connect(session.id, "LEWIN / LEGEND_CAY");
			await until(() => messages.some((m) => m.icon === "error"), "a refusal");
			expect(messages.find((m) => m.icon === "error")!.title).to.equal("No seat for this name");
			expect(session.users.size).to.equal(0);
		});

		it("a seat ID from a deleted hosted session is swapped on hostedSeat, without alreadyConnected", async function () {
			const session = await hostedSession("hosted-seat-stale", ["Alice", "Bob"]);
			const seatID = session.seats[0].userID;
			expect((await axios.post(`${base}/${session.id}/stop`, undefined, auth)).status).to.equal(200);
			expect(session.id in Sessions).to.be.false;
			// A reload of a tab that held the seat: the browser still presents the seat's ID.
			const { c, events } = connect(session.id, "Alice", seatID);
			await until(() => events.hostedSeat.length > 0, "the hostedSeat event");
			await until(() => userIDOf(c) in Connections, "the connection");
			const [fresh] = events.hostedSeat;
			expect(fresh).to.not.equal(seatID);
			expect(fresh.startsWith("hosted-")).to.be.false;
			expect(userIDOf(c)).to.equal(fresh);
			expect(events.alreadyConnected).to.deep.equal([]);
		});

		it("seat IDs only bind through their hosted session", async function () {
			const session = await hostedSession("hosted-seat-forged", ["Alice", "Bob"]);
			const seat = session.seats[0];
			const forged = connect("some-other-session", "Mallory", seat.userID);
			await until(() => userIDOf(forged.c) !== seat.userID, "the client to be given a fresh ID");
			await until(() => Connections[userIDOf(forged.c)]?.sessionID === "some-other-session", "Mallory to land");
			expect(seat.userID in Connections).to.be.false;
			forged.c.emit("setSession", session.id, {});
			await new Promise((r) => setTimeout(r, 100));
			expect(session.users.size).to.equal(0);
		});

		describe("Ready check, seating and start", function () {
			const api = (method: "post" | "put", path: string, data?: unknown) =>
				axios.request({ method, url: `${base}/${path}`, data, ...auth });

			async function seatEveryone(session: (typeof Sessions)[string], names = session.seats.map((s) => s.name)) {
				const joined = names.map((name) => ({ name, ...connect(session.id, name) }));
				await until(() => names.every((n) => session.seats.find((s) => s.name === n)!.connected), "seats");
				return Object.fromEntries(joined.map((j) => [j.name, j]));
			}

			async function startedSession(
				sessionID: string,
				players: string[],
				overrides: Partial<HostedSessionSpec> = {}
			) {
				const session = await hostedSession(sessionID, players, overrides);
				const clients = await seatEveryone(session);
				expect((await api("post", `${sessionID}/start`)).status).to.equal(200);
				await until(() => session.drafting, "the draft to start");
				return { session, clients };
			}

			it("a ready check records each seat's answer", async function () {
				const session = await hostedSession("hosted-ready", ["Alice", "Bob", "Carol"]);
				const { Alice, Bob, Carol } = await seatEveryone(session);
				Alice.c.on("readyCheck", () => Alice.c.emit("setReady", ReadyState.Ready));
				Bob.c.on("readyCheck", () => Bob.c.emit("setReady", ReadyState.NotReady));
				let carolAsked = 0;
				Carol.c.on("readyCheck", () => ++carolAsked);

				expect((await api("post", `${session.id}/ready-check`)).status).to.equal(200);
				await until(() => session.seats[1].ready === "not-ready" && carolAsked === 1, "the answers");
				const seats = await seatStatus(session.id);
				expect(seats.map((s) => s.ready)).to.deep.equal(["ready", "not-ready", "unknown"]);

				// A new ready check forgets earlier answers.
				Alice.c.off("readyCheck");
				Bob.c.off("readyCheck");
				expect((await api("post", `${session.id}/ready-check`)).status).to.equal(200);
				await until(() => carolAsked === 2, "the second prompt");
				expect((await seatStatus(session.id)).map((s) => s.ready)).to.deep.equal([
					"unknown",
					"unknown",
					"unknown",
				]);
			});

			it("a ready check refuses while a seat is disconnected", async function () {
				const session = await hostedSession("hosted-ready-missing", ["Alice", "Bob", "Carol"]);
				await seatEveryone(session, ["Alice"]);
				const r = await api("post", `${session.id}/ready-check`);
				expect(r.status).to.equal(409);
				expect(r.data.missing).to.deep.equal(["Bob", "Carol"]);
			});

			it("a disconnect clears the ready check", async function () {
				const session = await hostedSession("hosted-ready-reset", ["Alice", "Bob"]);
				const joined = await seatEveryone(session);
				for (const { c } of Object.values(joined))
					c.on("readyCheck", () => c.emit("setReady", ReadyState.Ready));
				expect((await api("post", `${session.id}/ready-check`)).status).to.equal(200);
				await until(() => session.seats.every((s) => s.ready === "ready"), "everyone to be ready");

				joined.Bob.c.disconnect();
				await until(() => !session.seats[1].connected, "Bob to leave");
				expect((await seatStatus(session.id)).map((s) => s.ready)).to.deep.equal(["unknown", "unknown"]);
			});

			it("start refuses while a seat is empty", async function () {
				const session = await hostedSession("hosted-start-missing", ["Alice", "Bob", "Carol"]);
				await seatEveryone(session, ["Bob"]);
				const r = await api("post", `${session.id}/start`);
				expect(r.status).to.equal(409);
				expect(r.data.missing).to.deep.equal(["Alice", "Carol"]);
				expect(session.drafting).to.be.false;
			});

			it("start with every seat connected begins the draft in seating order", async function () {
				const players = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank"];
				const order = ["Dave", "Alice", "Frank", "Bob", "Erin", "Carol"];
				const session = await hostedSession("hosted-start", players);
				session.randomizeSeatingOrder = true; // A cube may ask for it; the seating set here still wins.
				const joined = await seatEveryone(session);
				const received: Record<string, string[]> = {};
				for (const [name, { c }] of Object.entries(joined))
					c.once("startDraft", (data) => (received[name] = Object.keys(data)));

				expect((await api("put", `${session.id}/seating`, { order })).status).to.equal(200);
				expect((await api("post", `${session.id}/start`)).status).to.equal(200);
				await until(() => Object.keys(received).length === players.length, "everyone to get startDraft");

				const idOf = (name: string) => session.seats.find((s) => s.name === name)!.userID;
				const expected = order.map(idOf);
				expect(session.drafting).to.be.true;
				expect(session.teamDraft).to.be.true;
				expect(session.getSortedHumanPlayersIDs()).to.deep.equal(expected);
				const draft = session.draftState;
				if (!isDraftState(draft)) throw new Error("Expected a draft");
				expect(Object.keys(draft.players)).to.deep.equal(expected);
				for (const name of players) expect(received[name]).to.deep.equal(expected);
				expect((await seatStatus(session.id)).map((s) => s.name)).to.deep.equal(order);

				const again = await api("post", `${session.id}/start`);
				expect(again.status).to.equal(409);
			});

			it("seating must be a permutation of the seat names", async function () {
				const session = await hostedSession("hosted-seating-invalid", ["Alice", "Bob", "Carol"]);
				for (const order of [
					["Alice", "Bob"],
					["Alice", "Bob", "Bob"],
					["Alice", "Bob", "Mallory"],
					"Alice",
					[],
				])
					expect((await api("put", `${session.id}/seating`, { order })).status).to.equal(400);
				expect((await api("put", `${session.id}/seating`, {})).status).to.equal(400);
				expect(session.seats.map((s) => s.name)).to.deep.equal(["Alice", "Bob", "Carol"]);
				expect((await api("put", `does-not-exist/seating`, { order: [] })).status).to.equal(404);
			});

			it("updating the players keeps the seats whose names remain", async function () {
				const session = await hostedSession("hosted-players", ["Alice", "Bob", "Carol"]);
				const [alice, , carol] = session.seats;
				const joined = await seatEveryone(session, ["Alice", "Bob"]);

				const r = await api("put", `${session.id}/players`, { players: ["Carol", "Alice", "Dave"] });
				expect(r.status).to.equal(200);
				expect(session.seats.map((s) => s.name)).to.deep.equal(["Carol", "Alice", "Dave"]);
				expect(session.seats[0]).to.equal(carol);
				expect(session.seats[1]).to.equal(alice);
				expect(alice.connected).to.be.true;
				const dave = session.seats[2];
				expect(dave).to.include({ connected: false, disconnectedSince: null, ready: "unknown" });
				expect([alice.userID, carol.userID]).to.not.include(dave.userID);

				// Bob no longer has a seat: he is sent away and the session holds only seated players.
				await until(() => !joined.Bob.c.connected, "Bob to be sent away");
				expect([...session.users]).to.deep.equal([alice.userID]);
				expect(joined.Alice.c.connected).to.be.true;

				for (const players of [[], ["Alice", "Alice"], ["Alice", ""], "Alice"])
					expect((await api("put", `${session.id}/players`, { players })).status).to.equal(400);
			});

			it("re-sending the original create after a players update leaves the players alone", async function () {
				const spec = { ...makeSpec("hosted-players-resend"), players: ["Alice", "Bob"] };
				expect((await axios.put(`${base}/${spec.sessionID}`, spec, auth)).status).to.equal(200);
				const session = Sessions[spec.sessionID];
				const alice = session.seats[0];
				expect((await api("put", `${session.id}/players`, { players: ["Alice", "Carol"] })).status).to.equal(
					200
				);

				const again = await axios.put(`${base}/${spec.sessionID}`, spec, auth);
				expect(again.status).to.equal(200);
				expect(again.data.result).to.equal("unchanged");
				expect(Sessions[spec.sessionID]).to.equal(session);
				expect(session.seats.map((s) => s.name)).to.deep.equal(["Alice", "Carol"]);
				expect(session.seats[0]).to.equal(alice);

				const different = { ...spec, settings: { ...spec.settings, pickTimer: 30 } };
				expect((await axios.put(`${base}/${spec.sessionID}`, different, auth)).status).to.equal(409);
			});

			it("players and seating cannot change once the draft has started", async function () {
				const { session } = await startedSession("hosted-locked", ["Alice", "Bob"]);
				expect((await api("put", `${session.id}/players`, { players: ["Alice"] })).status).to.equal(409);
				expect((await api("put", `${session.id}/seating`, { order: ["Bob", "Alice"] })).status).to.equal(409);
				expect((await api("post", `${session.id}/ready-check`)).status).to.equal(409);
				expect(session.seats.map((s) => s.name)).to.deep.equal(["Alice", "Bob"]);
			});

			it("a disconnected player is not replaced by a bot", async function () {
				const { session, clients } = await startedSession("hosted-no-bot", ["Alice", "Bob"]);
				const bob = session.seats[1].userID;
				// Fast-forward only Session's 30 s replace-with-bot timer: run it on the next tick instead.
				const realSetTimeout = globalThis.setTimeout;
				let fastForwarded = 0;
				globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
					if (ms === 30 * 1000 && /[\\/]Session\.[jt]s/.test(new Error().stack ?? "")) {
						++fastForwarded;
						return realSetTimeout(fn, 0, ...args);
					}
					return realSetTimeout(fn, ms, ...args);
				}) as typeof setTimeout;
				try {
					clients.Bob.c.disconnect();
					await until(() => bob in session.disconnectedUsers, "Bob to be marked disconnected");
					await new Promise((r) => realSetTimeout(r, 100));
				} finally {
					globalThis.setTimeout = realSetTimeout;
				}
				const draft = session.draftState;
				if (!isDraftState(draft)) throw new Error("Expected a draft");
				expect(session.disconnectedUsers[bob].replaced).to.not.equal(true);
				expect(draft.players[bob].botPickInFlight).to.not.equal(true);
				expect(draft.players[bob].countdownInterval).to.be.null;
				expect(session.drafting).to.be.true;
				const seat = (await seatStatus(session.id))[1];
				expect(seat.connected).to.be.false;
				expect(seat.disconnectedSince).to.be.a("number");
				expect(fastForwarded).to.equal(0); // No replace-with-bot timer was even scheduled.
			});

			it("a returning player rejoins the draft in their seat", async function () {
				const { session, clients } = await startedSession("hosted-rejoin", ["Alice", "Bob"]);
				const bob = session.seats[1].userID;
				clients.Bob.c.disconnect();
				await until(() => bob in session.disconnectedUsers, "Bob to be marked disconnected");

				const back = connect(session.id, "Bob", "bobs-other-device");
				let rejoined = false;
				back.c.once("rejoinDraft", () => (rejoined = true));
				await until(() => rejoined, "rejoinDraft");
				expect(session.users.has(bob)).to.be.true;
				expect(bob in session.disconnectedUsers).to.be.false;
				expect((await seatStatus(session.id))[1]).to.include({ connected: true, disconnectedSince: null });
			});

			describe("Restart", function () {
				let dir: string;
				beforeEach(function () {
					dir = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-persistence-"));
				});
				afterEach(function () {
					fs.rmSync(dir, { recursive: true, force: true });
				});

				// A crash: the state on disk is all that survives; every socket is gone.
				async function crashAndRestart(sessionID: string) {
					dumpToDisk({ dir });
					delete Sessions[sessionID];
					for (const c of clients.splice(0)) c.disconnect();
					await until(() => Object.keys(Connections).length === 0, "connections to close");
					await loadFromDisk(dir);
					restoreHostedSessions();
				}

				it("a gathering hosted session survives restart", async function () {
					const session = await hostedSession("hosted-restart-gathering", ["Alice", "Bob", "Carol"]);
					await seatEveryone(session, ["Alice", "Bob"]);
					const before = await seatStatus(session.id);

					await crashAndRestart(session.id);

					const restored = Sessions[session.id];
					expect(restored).to.exist.and.not.equal(session);
					expect(restored.hosted).to.be.true;
					expect(restored.hostedSpec).to.deep.equal(session.hostedSpec);
					const r = await axios.get(`${base}/${session.id}`, auth);
					expect(r.status).to.equal(200);
					expect(r.data.stage).to.equal("gathering");
					const seats = r.data.seats as typeof before;
					expect(seats.map((s) => [s.name, s.userID])).to.deep.equal(before.map((s) => [s.name, s.userID]));
					for (const seat of seats) expect(seat).to.include({ connected: false, ready: "unknown" });
					expect(seats[0].disconnectedSince).to.be.a("number");
					expect(seats[2].disconnectedSince).to.be.null;

					await seatEveryone(restored);
					expect((await api("post", `${session.id}/start`)).status).to.equal(200);
					expect(restored.getSortedHumanPlayersIDs()).to.deep.equal(seats.map((s) => s.userID));
				});

				it("a drafting hosted session restores and a player rejoins their seat", async function () {
					const { session } = await startedSession("hosted-restart-drafting", ["Alice", "Bob"]);
					const bob = session.seats[1].userID;

					await crashAndRestart(session.id);

					const status = await axios.get(`${base}/${session.id}`, auth);
					expect(status.status).to.equal(200);
					expect(status.data.stage).to.equal("drafting");
					expect(status.data.seats.every((s: { connected: boolean }) => !s.connected)).to.be.true;

					const back = connect(session.id, "Bob", "bobs-other-device");
					let rejoined = false;
					back.c.once("rejoinDraft", () => (rejoined = true));
					await until(() => rejoined, "rejoinDraft");
					const restored = Sessions[session.id];
					expect(restored.drafting).to.be.true;
					expect(restored.users.has(bob)).to.be.true;
					expect((await seatStatus(session.id))[1]).to.include({ connected: true, disconnectedSince: null });
				});

				it("a hosted session waiting to send its logs still persists", async function () {
					const session = await hostedSession("hosted-restart-logs", ["Alice"]);
					session.initStableLogTimeout();
					try {
						await crashAndRestart(session.id);
					} finally {
						clearTimeout(session.stableLogTimeout);
					}
					expect((await axios.get(`${base}/${session.id}`, auth)).status).to.equal(200);
				});

				it("the periodic dump saves without disturbing the live draft", async function () {
					const { session } = await startedSession("hosted-periodic", ["Alice", "Bob"]);
					const draft = session.draftState;
					if (!isDraftState(draft)) throw new Error("Expected a draft");
					const players = Object.values(draft.players);
					const live = players.map((p) => [p.botInstance, p.countdownInterval]);
					const file = path.join(dir, "tmp", "sessions.json");
					const timer = startPeriodicDump(20, dir);
					try {
						await until(() => fs.existsSync(file), "the first dump");
						await new Promise((r) => setTimeout(r, 60));
					} finally {
						clearInterval(timer);
					}
					expect(live.every(([, countdown]) => countdown !== null)).to.be.true;
					players.forEach((p, i) => {
						expect(p.botInstance).to.equal(live[i][0]);
						expect(p.countdownInterval).to.equal(live[i][1]);
						expect(p.botPickInFlight).to.be.false;
					});
					expect(session.disconnectedUsers).to.deep.equal({});
					expect(session.seats.every((s) => s.connected)).to.be.true;
					const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { id: string; seats: unknown }[];
					expect(saved.find((s) => s.id === session.id)?.seats).to.deep.equal(session.seats);
				});

				it("an ended session restored after a crash is still deleted after its lifetime", async function () {
					const { session } = await startedSession("hosted-restart-ended", ["Alice", "Bob"]);
					session.endDraft();
					await until(() => !session.drafting, "the draft to end");
					const endedAt = session.hostedEndedAt;
					expect(endedAt).to.be.a("number");

					await crashAndRestart(session.id);
					const restored = Sessions[session.id];
					expect(restored).to.exist.and.not.equal(session);
					expect(restored.hostedEndedAt).to.equal(endedAt);
					expect((await axios.get(`${base}/${session.id}/log`, auth)).status).to.equal(200);

					// The lifetime counts from the end of the draft, not from the restart.
					process.env.HOSTED_ENDED_LIFETIME_MS = String(Date.now() - endedAt! + 300);
					try {
						await crashAndRestart(session.id);
						await until(() => !(session.id in Sessions), "the restored session to be deleted");
					} finally {
						delete process.env.HOSTED_ENDED_LIFETIME_MS;
					}
				});

				it("a stopped draft stays stopped after a restart", async function () {
					const { session } = await startedSession("hosted-restart-stopped", ["Alice", "Bob"]);
					expect((await api("post", `${session.id}/stop`)).status).to.equal(200);
					await until(() => !session.drafting, "the draft to stop");

					await crashAndRestart(session.id);
					const restored = Sessions[session.id];
					expect(restored).to.exist.and.not.equal(session);
					expect(restored.hostedStoppedAt).to.equal(session.hostedStoppedAt);
					expect((await axios.get(`${base}/${session.id}`, auth)).data.stage).to.equal("stopped");
					expect((await axios.get(`${base}/${session.id}/log`, auth)).status).to.equal(410);
				});

				it("a deleted session does not come back on restart", async function () {
					const session = await hostedSession("hosted-restart-deleted", ["Alice", "Bob"]);
					dumpToDisk({ dir });
					setDeletionPersister(() => dumpToDisk({ dir }));
					try {
						expect((await api("post", `${session.id}/stop`)).status).to.equal(200);
					} finally {
						setDeletionPersister();
					}
					await loadFromDisk(dir);
					restoreHostedSessions();
					expect(session.id in Sessions).to.be.false;
				});

				it("a failed dump keeps the last good copy and closes its files", async function () {
					const session = await hostedSession("hosted-dump-fails", ["Alice", "Bob"]);
					const file = path.join(dir, "tmp", "sessions.json");
					dumpToDisk({ dir });
					const good = fs.readFileSync(file, "utf8");
					expect(good).to.include(session.id);
					const openFiles = () => fs.readdirSync("/proc/self/fd").length;
					const before = openFiles();
					delete Sessions[session.id];
					setDumpWriter(() => {
						throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
					});
					try {
						for (let i = 0; i < 20; ++i) expect(() => dumpToDisk({ dir })).to.throw(/ENOSPC/);
					} finally {
						setDumpWriter();
					}
					expect(openFiles()).to.be.at.most(before);
					expect(fs.readFileSync(file, "utf8")).to.equal(good);
					// The disk recovers: the next dump goes through.
					dumpToDisk({ dir });
					expect(fs.readFileSync(file, "utf8")).to.not.include(session.id);
				});

				it("a session restore that fails leaves the others restored and its saved copy in place", async function () {
					const ok = await hostedSession("hosted-restore-ok", ["Alice"]);
					await hostedSession("hosted-restore-broken", ["Bob"]);
					// A saved copy whose restore throws (seats is not iterable).
					Sessions["hosted-restore-broken"].seats = 42 as unknown as [];
					dumpToDisk({ dir });
					delete Sessions["hosted-restore-broken"];
					delete Sessions[ok.id];
					await loadFromDisk(dir);
					try {
						restoreHostedSessions();
						expect(Sessions[ok.id]?.hosted).to.be.true;
						expect("hosted-restore-broken" in Sessions).to.be.false;
						expect("hosted-restore-broken" in InactiveSessions).to.be.true;
						expect(ok.id in InactiveSessions).to.be.false;
					} finally {
						delete InactiveSessions["hosted-restore-broken"];
					}
				});

				it("a gathering session restored after a crash keeps the idle lifetime it had", async function () {
					const session = await hostedSession("hosted-restart-idle", ["Alice", "Bob"]);
					const createdAt = session.hostedCreatedAt;
					expect(createdAt).to.be.a("number");
					await seatEveryone(session, ["Alice"]);

					await crashAndRestart(session.id);
					const restored = Sessions[session.id];
					expect(restored).to.exist.and.not.equal(session);
					expect(restored.hostedCreatedAt).to.equal(createdAt);

					// The lifetime counts from the creation of the session, not from the restart.
					process.env.HOSTED_GATHERING_LIFETIME_MS = String(Date.now() - createdAt! + 300);
					try {
						await crashAndRestart(session.id);
						expect(session.id in Sessions).to.be.true;
						await until(() => !(session.id in Sessions), "the restored session to be deleted");
					} finally {
						delete process.env.HOSTED_GATHERING_LIFETIME_MS;
					}
				});

				it("the dump interval comes from HOSTED_DUMP_INTERVAL_MS, 30 s by default", function () {
					expect(dumpIntervalMs({})).to.equal(30000);
					expect(dumpIntervalMs({ HOSTED_DUMP_INTERVAL_MS: "5000" })).to.equal(5000);
					for (const bad of ["", "0", "-1", "soon"])
						expect(dumpIntervalMs({ HOSTED_DUMP_INTERVAL_MS: bad })).to.equal(30000);
				});
			});

			describe("Draft controls and the finished log", function () {
				type Push = { authorization: string | undefined; body: { sessionID: string; log: DraftLog } };
				const pushes: Push[] = [];
				const waits: number[] = [];
				let failuresLeft = 0;
				let hook: Server;
				let hookURL: string;

				before(async function () {
					const app = express();
					app.use(express.json({ limit: "100mb" }));
					app.post("/draft-log", (req, res) => {
						pushes.push({ authorization: req.headers.authorization, body: req.body });
						if (failuresLeft > 0) {
							--failuresLeft;
							return void res.sendStatus(500);
						}
						res.sendStatus(200);
					});
					await new Promise<void>((resolve) => (hook = app.listen(0, "127.0.0.1", () => resolve())));
					hookURL = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/draft-log`;
					setLogPushWait(async (ms) => void waits.push(ms));
				});
				after(function () {
					hook.close();
					setLogPushWait();
				});
				beforeEach(function () {
					pushes.length = 0;
					waits.length = 0;
					failuresLeft = 0;
				});
				afterEach(function () {
					delete process.env.HOSTED_ENDED_LIFETIME_MS;
					delete process.env.HOSTED_GATHERING_LIFETIME_MS;
				});

				const getLog = (sessionID: string) => axios.get(`${base}/${sessionID}/log`, auth);
				const settle = () => new Promise((r) => setTimeout(r, 100));
				// Tests unlock delayed logs after 1 ms; without a timer the log stays locked until released.
				const keepLogLocked = (session: (typeof Sessions)[string]) => (session.draftLogUnlockTimer = 0);

				it("the finished log is pushed to the webhook", async function () {
					const { session } = await startedSession("hosted-push", ["Alice", "Bob", "Carol"], {
						logWebhook: hookURL,
					});
					const seatIDs = session.seats.map((s) => s.userID);
					keepLogLocked(session);
					session.endDraft();
					await until(() => pushes.length > 0, "the push");
					await settle();

					expect(pushes).to.have.length(1);
					const [{ authorization, body }] = pushes;
					expect(authorization).to.equal("Bearer test-hosted-token");
					expect(body.sessionID).to.equal(session.id);
					expect(body.log.sessionID).to.equal(session.id);
					expect(body.log.time).to.be.a("number");
					expect(body.log.delayed).to.be.true; // Still locked for the players, yet sent in full.
					expect(Object.keys(body.log.users)).to.deep.equal(seatIDs);
					expect(seatIDs.map((id) => (body.log.users[id] as { seatNum?: number }).seatNum)).to.deep.equal([
						0, 1, 2,
					]);
					for (const id of seatIDs) expect(body.log.users[id].picks).to.be.an("array");
					expect(body.log.boosters.length).to.be.above(0);
					expect(waits).to.deep.equal([]);

					// Delivered, yet players keep building and exporting decks in the session.
					await settle();
					expect(Sessions[session.id]).to.equal(session);
					expect((await getLog(session.id)).status).to.equal(200);
				});

				it("the push retries when the webhook fails", async function () {
					failuresLeft = 2;
					const { session } = await startedSession("hosted-push-retry", ["Alice", "Bob"], {
						logWebhook: hookURL,
					});
					session.endDraft();
					await until(() => pushes.length === 3, "three attempts");
					await settle();
					expect(pushes).to.have.length(3);
					expect(waits).to.deep.equal([2000, 4000]);
					expect(new Set(pushes.map((p) => JSON.stringify(p.body))).size).to.equal(1);
					expect(Sessions[session.id]).to.equal(session);
					expect((await getLog(session.id)).status).to.equal(200);
				});

				it("the push gives up after five attempts and keeps the log fetchable", async function () {
					failuresLeft = 100;
					const { session } = await startedSession("hosted-push-gives-up", ["Alice", "Bob"], {
						logWebhook: hookURL,
					});
					session.endDraft();
					await until(() => pushes.length === 5, "five attempts");
					await settle();
					expect(pushes).to.have.length(5);
					expect(waits).to.deep.equal([2000, 4000, 8000, 16000]);
					expect(Sessions[session.id]).to.equal(session);
					expect((await getLog(session.id)).status).to.equal(200);
				});

				it("GET log returns the full log while it is delayed for the public", async function () {
					const session = await hostedSession("hosted-get-log", ["Alice", "Bob"]);
					const { Alice } = await seatEveryone(session);
					let picked = false;
					Alice.c.on("draftState", (state) => {
						if (picked || !state.booster?.length) return;
						picked = true;
						Alice.c.emit("pickCard", { pickedCards: [0], burnedCards: [] }, () => {});
					});
					expect((await getLog(session.id)).status).to.equal(404);
					expect((await api("post", `${session.id}/start`)).status).to.equal(200);
					const alice = session.seats[0].userID;
					await until(() => (session.draftLog?.users[alice]?.picks.length ?? 0) === 1, "Alice's pick");
					expect((await getLog(session.id)).status).to.equal(404); // Not until the draft ends.

					keepLogLocked(session);
					session.endDraft();
					await until(() => !session.drafting, "the draft to end");
					expect(session.draftLog!.delayed).to.be.true;
					const r = await getLog(session.id);
					expect(r.status).to.equal(200);
					const log = r.data as DraftLog;
					expect(log.delayed).to.be.true;
					expect(log.users[alice].picks).to.have.length(1);
					expect(log.boosters).to.deep.equal(session.draftLog!.boosters);
					expect(Object.keys(log.carddata)).to.have.length(Object.keys(session.draftLog!.carddata).length);
					// What players see is stripped of everyone else's picks.
					expect(session.getStrippedLog(session.seats[1].userID)!.users[alice].picks).to.deep.equal([]);

					expect((await axios.get(`${base}/does-not-exist/log`, auth)).status).to.equal(404);
					expect(
						(await axios.get(`${base}/${session.id}/log`, { validateStatus: () => true })).status
					).to.equal(401);
				});

				it("release-log unlocks the log for everyone", async function () {
					const { session } = await startedSession("hosted-release", ["Alice", "Bob"]);
					expect((await api("post", `${session.id}/release-log`)).status).to.equal(409);
					keepLogLocked(session);
					session.endDraft();
					await until(() => !session.drafting, "the draft to end");
					expect(session.draftLog!.delayed).to.be.true;
					expect((await api("post", `${session.id}/release-log`)).status).to.equal(200);
					expect(session.draftLog!.delayed).to.be.false;
					expect((await api("post", `${session.id}/release-log`)).status).to.equal(200);
				});

				it("replace-with-bot puts a bot in that seat only", async function () {
					const gathering = await hostedSession("hosted-bot-gathering", ["Alice", "Bob"]);
					expect((await api("post", `${gathering.id}/seats/Bob/replace-with-bot`)).status).to.equal(409);

					const players = ["Alice", "Bob Smith", "Carol"];
					const { session, clients } = await startedSession("hosted-bot", players);
					const [alice, bob, carol] = session.seats.map((s) => s.userID);
					const replace = (name: string) =>
						api("post", `${session.id}/seats/${encodeURIComponent(name)}/replace-with-bot`);

					expect((await replace("Bob Smith")).status).to.equal(409); // Still connected.
					expect((await replace("Mallory")).status).to.equal(404);
					clients["Bob Smith"].c.disconnect();
					await until(() => bob in session.disconnectedUsers, "Bob to be marked disconnected");

					expect((await replace("Alice")).status).to.equal(409);
					expect((await replace("Bob Smith")).status).to.equal(200);
					await until(() => session.draftLog!.users[bob].picks.length > 0, "the bot to pick for Bob");
					await settle();
					expect(session.disconnectedUsers[bob].replaced).to.be.true;
					for (const other of [alice, carol]) {
						expect(other in session.disconnectedUsers).to.be.false;
						expect(session.draftLog!.users[other].picks).to.deep.equal([]);
					}
					expect((await replace("Bob Smith")).status).to.equal(409); // Already a bot.
				});

				it("pause and resume stop and restart the pick timer", async function () {
					const gathering = await hostedSession("hosted-pause-gathering", ["Alice"]);
					expect((await api("post", `${gathering.id}/pause`)).status).to.equal(409);
					expect((await api("post", `${gathering.id}/resume`)).status).to.equal(409);

					const { session } = await startedSession("hosted-pause", ["Alice", "Bob"]);
					const draft = session.draftState;
					if (!isDraftState(draft)) throw new Error("Expected a draft");
					const timers = () => Object.values(draft.players).map((p) => p.countdownInterval);
					expect(timers().every((t) => t !== null)).to.be.true;

					expect((await api("post", `${session.id}/pause`)).status).to.equal(200);
					expect(session.draftPaused).to.be.true;
					expect(timers().every((t) => t === null)).to.be.true;

					expect((await api("post", `${session.id}/resume`)).status).to.equal(200);
					expect(session.draftPaused).to.be.false;
					expect(timers().every((t) => t !== null)).to.be.true;
				});

				it("stop ends the draft", async function () {
					const { session } = await startedSession("hosted-stop", ["Alice", "Bob"], {
						logWebhook: hookURL,
					});
					expect((await api("post", `${session.id}/stop`)).status).to.equal(200);
					await until(() => !session.drafting, "the draft to stop");
					await settle();
					const status = await axios.get(`${base}/${session.id}`, auth);
					expect(status.data.stage).to.equal("stopped");
					expect((await getLog(session.id)).status).to.equal(410);
					expect(session.hostedStoppedAt).to.be.a("number");
					// A stopped draft is not a finished one: DraftBot is not sent its log.
					expect(pushes).to.deep.equal([]);
					expect((await api("post", `${session.id}/stop`)).status).to.equal(409);
				});

				it("a second stop before the draft has ended is refused", async function () {
					const { session } = await startedSession("hosted-stop-twice", ["Alice", "Bob"], {
						logWebhook: hookURL,
					});
					let ended = 0;
					const endDraft = session.endDraft.bind(session);
					session.endDraft = () => {
						++ended;
						endDraft();
					};
					expect(stopHostedSession(session)).to.be.null;
					expect(session.drafting).to.be.true; // The draft only ends on the next tick.
					expect(stopHostedSession(session)?.status).to.equal(409);
					await until(() => !session.drafting, "the draft to stop");
					await settle();
					expect(ended).to.equal(1);
					expect((await api("post", `${session.id}/stop`)).status).to.equal(409);
				});

				it("stop before the draft starts deletes the session", async function () {
					const session = await hostedSession("hosted-stop-gathering", ["Alice", "Bob"]);
					const { Alice } = await seatEveryone(session, ["Alice"]);
					expect((await api("post", `${session.id}/stop`)).status).to.equal(200);
					expect(session.id in Sessions).to.be.false;
					expect((await axios.get(`${base}/${session.id}`, auth)).status).to.equal(404);
					await until(() => !Alice.c.connected, "Alice to be sent away");
					expect(Alice.messages.some((m) => m.title === "Draft cancelled")).to.be.true;
					expect((await api("post", `${session.id}/stop`)).status).to.equal(404);
				});

				it("an ended session without a delivered log is deleted after its lifetime", async function () {
					process.env.HOSTED_ENDED_LIFETIME_MS = "200";
					const { session } = await startedSession("hosted-lifetime", ["Alice", "Bob"]);
					session.endDraft();
					await until(() => !session.drafting, "the draft to end");
					expect((await getLog(session.id)).status).to.equal(200);
					await until(() => !(session.id in Sessions), "the session to be deleted");
				});

				it("the lifetime comes from HOSTED_ENDED_LIFETIME_MS, 24 h by default", function () {
					const day = 24 * 60 * 60 * 1000;
					expect(endedSessionLifetimeMs({})).to.equal(day);
					expect(endedSessionLifetimeMs({ HOSTED_ENDED_LIFETIME_MS: "5000" })).to.equal(5000);
					for (const bad of ["", "0", "-1", "later"])
						expect(endedSessionLifetimeMs({ HOSTED_ENDED_LIFETIME_MS: bad })).to.equal(day);
					// setTimeout fires at once beyond 2^31-1 ms.
					expect(MaxTimeoutMs).to.equal(2 ** 31 - 1);
					expect(endedSessionLifetimeMs({ HOSTED_ENDED_LIFETIME_MS: "1e12" })).to.equal(MaxTimeoutMs);
				});

				it("the idle lifetime comes from HOSTED_GATHERING_LIFETIME_MS, 24 h by default", function () {
					const day = 24 * 60 * 60 * 1000;
					expect(gatheringSessionLifetimeMs({})).to.equal(day);
					expect(gatheringSessionLifetimeMs({ HOSTED_GATHERING_LIFETIME_MS: "5000" })).to.equal(5000);
					for (const bad of ["", "0", "-1", "later"])
						expect(gatheringSessionLifetimeMs({ HOSTED_GATHERING_LIFETIME_MS: bad })).to.equal(day);
					expect(gatheringSessionLifetimeMs({ HOSTED_GATHERING_LIFETIME_MS: "1e12" })).to.equal(MaxTimeoutMs);
				});

				it("a session whose draft never starts is deleted after its idle lifetime", async function () {
					process.env.HOSTED_GATHERING_LIFETIME_MS = "300";
					const session = await hostedSession("hosted-idle", ["Alice", "Bob"]);
					const { Alice } = await seatEveryone(session, ["Alice"]);
					await until(() => !(session.id in Sessions), "the idle session to be deleted");
					expect((await axios.get(`${base}/${session.id}`, auth)).status).to.equal(404);
					await until(() => !Alice.c.connected, "Alice to be sent away");
					expect(Alice.messages.some((m) => m.title === "Draft cancelled")).to.be.true;
				});

				it("a started draft outlives the idle lifetime", async function () {
					process.env.HOSTED_GATHERING_LIFETIME_MS = "1500";
					const { session } = await startedSession("hosted-idle-started", ["Alice", "Bob"]);
					await new Promise((r) => setTimeout(r, session.hostedCreatedAt! + 1700 - Date.now()));
					expect(Sessions[session.id]).to.equal(session);
					expect(session.drafting).to.be.true;
				});

				it("removes an unexpected user", async function () {
					const session = await hostedSession("hosted-remove-user", ["Alice", "Bob"]);
					const { Alice, Bob } = await seatEveryone(session);
					const alice = session.seats[0].userID;
					const remove = (userID: string) =>
						axios.delete(`${base}/${session.id}/users/${encodeURIComponent(userID)}`, auth);
					expect((await remove(alice)).status).to.equal(200);
					await until(() => !Alice.c.connected, "Alice to be sent away");
					await until(() => !session.seats[0].connected, "Alice's seat to free up");
					expect(Alice.messages.some((m) => m.title === "Removed from the draft")).to.be.true;
					expect(Bob.c.connected).to.be.true;
					expect((await remove("nobody")).status).to.equal(404);
				});
			});

			it("nobody becomes owner when players leave", async function () {
				const session = await hostedSession("hosted-no-owner", ["Alice", "Bob", "Carol"]);
				const joined = await seatEveryone(session);
				joined.Alice.c.disconnect();
				await until(() => !session.seats[0].connected, "Alice to leave");
				expect(session.owner).to.be.undefined;

				expect((await api("post", `${session.id}/start`)).status).to.equal(409);
				const alice = connect(session.id, "Alice");
				await until(() => session.seats[0].connected, "Alice to return");
				expect((await api("post", `${session.id}/start`)).status).to.equal(200);
				joined.Bob.c.disconnect();
				alice.c.disconnect();
				await until(() => !session.seats[0].connected && !session.seats[1].connected, "players to leave");
				expect(session.owner).to.be.undefined;
			});
		});
	});
});
