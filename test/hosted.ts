import { before, after, beforeEach, afterEach, describe, it } from "mocha";
import axios from "axios";
import { expect } from "chai";
import { Cards } from "../src/Cards.js";
import { Sessions } from "../src/Session.js";
import { DraftmancerPort } from "../src/server.js";
import { setCubeFetcher } from "../src/hosted/HostedSessions.js";
import type { HostedSessionSpec } from "../src/hosted/types.js";
import { Connections } from "../src/Connection.js";
import { ReadyState } from "../src/Session/SessionTypes.js";
import { isDraftState } from "../src/DraftState.js";
import { connectClient, disableLogs, enableLogs, getUID } from "./src/common.js";

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

		async function hostedSession(sessionID: string, players: string[]) {
			const spec = { ...makeSpec(sessionID), players };
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

			async function startedSession(sessionID: string, players: string[]) {
				const session = await hostedSession(sessionID, players);
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
