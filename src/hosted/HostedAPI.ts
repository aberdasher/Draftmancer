import express from "express";
import { timingSafeEqual } from "node:crypto";
import { Session, Sessions } from "../Session.js";
import {
	createHostedSession,
	HostedRefusal,
	hostedLog,
	hostedStatus,
	pauseHostedDraft,
	releaseHostedLog,
	removeHostedUser,
	replaceSeatWithBot,
	resumeHostedDraft,
	stopHostedSession,
	setHostedPlayers,
	setHostedSeating,
	startHostedDraft,
	startHostedReadyCheck,
} from "./HostedSessions.js";
import type { HostedSessionSpec } from "./types.js";

/** Bearer-token guard; the token is read from the environment on every request. */
export function requireBearer(req: express.Request, res: express.Response, next: express.NextFunction) {
	const token = process.env.DRAFTBOT_API_TOKEN;
	const header = req.headers.authorization ?? "";
	const given = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (token && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token)))
		return next();
	res.sendStatus(401);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseSpec(id: string, body: unknown): HostedSessionSpec | null {
	if (typeof body !== "object" || body === null) return null;
	const b = body as Record<string, unknown>;
	const s = b.settings as Record<string, unknown> | undefined;
	if (b.sessionID !== id) return null;
	if (!Array.isArray(b.players) || !b.players.every((p) => typeof p === "string" && p !== "")) return null;
	if (typeof b.cubeCobraID !== "string" || b.cubeCobraID === "") return null;
	if (b.logWebhook !== null && typeof b.logWebhook !== "string") return null;
	if (typeof s !== "object" || s === null || typeof s.teamDraft !== "boolean") return null;
	for (const k of ["pickTimer", "boostersPerPlayer", "cardsPerBooster", "draftLogUnlockTimer", "maxPlayers"])
		if (!isNum(s[k])) return null;
	return body as HostedSessionSpec;
}

const isNameList = (v: unknown): v is string[] =>
	Array.isArray(v) &&
	v.length > 0 &&
	v.every((p) => typeof p === "string" && p !== "") &&
	new Set(v).size === v.length;

/** Runs `action` on the hosted session named by the route: 404 when there is none, 200 unless it refuses. */
function onSession(action: (session: Session, req: express.Request) => HostedRefusal | null) {
	return (req: express.Request, res: express.Response) => {
		const session = Sessions[String(req.params.id)];
		if (!session?.hosted) return void res.sendStatus(404);
		const refusal = action(session, req);
		if (refusal) return void res.status(refusal.status).json(refusal.body);
		res.status(200).json({ result: "ok" });
	};
}

const invalid = (error: string): HostedRefusal => ({ status: 400, body: { error } });

export function registerHostedRoutes(app: express.Express): void {
	app.put("/api/hosted/sessions/:id", requireBearer, async (req, res) => {
		const spec = parseSpec(String(req.params.id), req.body);
		if (!spec) return void res.status(400).json({ error: "Invalid hosted session spec." });
		try {
			const result = await createHostedSession(spec);
			if (result === "conflict") return void res.status(409).json({ error: "A different session exists." });
			res.status(200).json({ result });
		} catch (e) {
			console.error("Error creating hosted session: ", e);
			res.status(502).json({ error: "Could not import the cube." });
		}
	});

	app.get("/api/hosted/sessions/:id", requireBearer, (req, res) => {
		const status = hostedStatus(String(req.params.id));
		if (!status) return void res.sendStatus(404);
		res.json(status);
	});

	app.put(
		"/api/hosted/sessions/:id/players",
		requireBearer,
		onSession((session, req) =>
			isNameList(req.body?.players)
				? setHostedPlayers(session, req.body.players)
				: invalid("players must be a list of distinct, non-empty names.")
		)
	);

	app.put(
		"/api/hosted/sessions/:id/seating",
		requireBearer,
		onSession((session, req) =>
			isNameList(req.body?.order)
				? setHostedSeating(session, req.body.order)
				: invalid("order must be a list of distinct, non-empty names.")
		)
	);

	app.post("/api/hosted/sessions/:id/ready-check", requireBearer, onSession(startHostedReadyCheck));

	app.post("/api/hosted/sessions/:id/start", requireBearer, onSession(startHostedDraft));

	app.post("/api/hosted/sessions/:id/pause", requireBearer, onSession(pauseHostedDraft));

	app.post("/api/hosted/sessions/:id/resume", requireBearer, onSession(resumeHostedDraft));

	app.post("/api/hosted/sessions/:id/stop", requireBearer, onSession(stopHostedSession));

	app.post("/api/hosted/sessions/:id/release-log", requireBearer, onSession(releaseHostedLog));

	app.post(
		"/api/hosted/sessions/:id/seats/:name/replace-with-bot",
		requireBearer,
		onSession((session, req) => replaceSeatWithBot(session, String(req.params.name)))
	);

	app.delete(
		"/api/hosted/sessions/:id/users/:userID",
		requireBearer,
		onSession((session, req) => removeHostedUser(session, String(req.params.userID)))
	);

	// The full log, even while it is locked for the players; 404 until the draft ends.
	app.get("/api/hosted/sessions/:id/log", requireBearer, (req, res) => {
		const session = Sessions[String(req.params.id)];
		const log = session?.hosted ? hostedLog(session) : undefined;
		if (!log) return void res.sendStatus(404);
		res.json(log);
	});
}
