import type { UserID } from "../IDTypes.js";

export type HostedSeat = { name: string; userID: UserID; connected: boolean; disconnectedSince: number | null };

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
	stage: "gathering" | "drafting" | "ended";
	seats: HostedSeat[];
	pickNumber: number | null;
};
