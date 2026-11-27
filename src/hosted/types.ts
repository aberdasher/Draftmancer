import type { UserID } from "../IDTypes.js";

export type SeatReadiness = "unknown" | "ready" | "not-ready";

export type HostedSeat = {
	name: string;
	userID: UserID;
	connected: boolean;
	disconnectedSince: number | null; // Epoch ms; null while connected or never connected.
	ready: SeatReadiness; // The seat's answer to the current in-app ready check.
};

export type HostedSessionSpec = {
	sessionID: string;
	players: string[];
	cubeCobraID: string;
	settings: {
		teamDraft: boolean;
		pickTimer: number;
		boostersPerPlayer: number;
		cardsPerBooster: number;
		draftLogUnlockTimer: number;
		maxPlayers: number;
	};
	logWebhook: string | null;
};

export type HostedStatus = {
	sessionID: string;
	stage: "gathering" | "drafting" | "ended" | "stopped";
	seats: HostedSeat[];
	pickNumber: number | null;
};
