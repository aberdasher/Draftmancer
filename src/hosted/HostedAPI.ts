import express from "express";
import { timingSafeEqual } from "node:crypto";
import { createHostedSession, hostedStatus } from "./HostedSessions.js";
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
}
