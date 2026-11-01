import { before, after, beforeEach, afterEach, describe, it } from "mocha";
import axios from "axios";
import { expect } from "chai";
import { Cards } from "../src/Cards.js";
import { Sessions } from "../src/Session.js";
import { DraftmancerPort } from "../src/server.js";
import { setCubeFetcher } from "../src/hosted/HostedSessions.js";
import type { HostedSessionSpec } from "../src/hosted/types.js";
import { Connections } from "../src/Connection.js";
import { connectClient, disableLogs, enableLogs, getUID } from "./src/common.js";

process.env.DRAFTBOT_API_TOKEN = "test-hosted-token";

const base = `http://localhost:${DraftmancerPort}/api/hosted/sessions`;
const auth = { headers: { Authorization: "Bearer test-hosted-token" }, validateStatus: () => true };

function fakeCube(): Record<string, unknown> {
	const ids = [...Cards.keys()].slice(0, 20);
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

		const different = { ...spec, players: [...spec.players].reverse() };
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
	});
});
