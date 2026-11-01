import { before, after, beforeEach, afterEach, describe, it } from "mocha";
import axios from "axios";
import { expect } from "chai";
import { Cards } from "../src/Cards.js";
import { Sessions } from "../src/Session.js";
import { DraftmancerPort } from "../src/server.js";
import { setCubeFetcher } from "../src/hosted/HostedSessions.js";
import type { HostedSessionSpec } from "../src/hosted/types.js";
import { disableLogs, enableLogs } from "./src/common.js";

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
});
