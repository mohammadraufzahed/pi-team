/**
 * pi-team — teammate messaging for multi-agent pi setups.
 *
 * Lets a pi run talk to OTHER agents (souls) through a file mailbox —
 * no markers in chat text, works in every run path:
 *
 *   team_roster   — who's on the team (names, roles, display)
 *   team_ask      — ask a teammate; blocks until their reply arrives
 *   team_handoff  — hand the whole request to a teammate (ends your run)
 *   team_say      — post a message to the chat immediately, mid-run
 *
 * Transport: $PI_TEAM_DIR (default ~/.local/state/telegram-agent/team)
 *   requests/<id>.json  — {id, from, to, kind, text, chat, thread, at}
 *   replies/<id>.json   — {id, text, at}   (written by the dispatcher)
 *
 * Identity comes from env injected by the host bot:
 *   PI_TEAM_FROM (soul name), PI_TEAM_CHAT, PI_TEAM_THREAD
 *
 * The host process watches requests/, runs the target soul, posts via
 * its bot, and drops the reply file — the tool call returns it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";

const TEAM_DIR =
	process.env.PI_TEAM_DIR ??
	join(homedir(), ".local/state/telegram-agent/team");
const REQ_DIR = join(TEAM_DIR, "requests");
const REP_DIR = join(TEAM_DIR, "replies");
const ASK_TIMEOUT_MS = 240_000;
const POLL_MS = 800;

interface Request {
	id: string;
	from: string;
	to: string;
	kind: "ask" | "handoff" | "say";
	text: string;
	chat?: string;
	thread?: string;
	at: number;
}

function teamDir(): void {
	mkdirSync(REQ_DIR, { recursive: true });
	mkdirSync(REP_DIR, { recursive: true });
}

function send(kind: Request["kind"], to: string, text: string): string {
	teamDir();
	const req: Request = {
		id: randomUUID(),
		from: process.env.PI_TEAM_FROM ?? "unknown",
		to,
		kind,
		text,
		chat: process.env.PI_TEAM_CHAT,
		thread: process.env.PI_TEAM_THREAD,
		at: Date.now(),
	};
	writeFileSync(join(REQ_DIR, `${req.id}.json`), JSON.stringify(req));
	return req.id;
}

async function awaitReply(id: string): Promise<string | null> {
	const file = join(REP_DIR, `${id}.json`);
	const deadline = Date.now() + ASK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (existsSync(file)) {
			try {
				const r = JSON.parse(readFileSync(file, "utf-8")) as {
					text?: string;
				};
				return r.text ?? "";
			} catch {
				/* partial write — retry */
			}
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	return null;
}

function soulsDir(): string | null {
	const d = process.env.SOULS_DIR;
	return d && existsSync(d) ? d : null;
}

export default function piTeam(pi: ExtensionAPI) {
	const me = () => process.env.PI_TEAM_FROM ?? "(unset)";

	pi.registerTool({
		name: "team_roster",
		label: "Team Roster",
		description:
			"List the team: each soul's name, role and display name. Use to find the right teammate before team_ask/team_handoff.",
		parameters: Type.Object({}),
		async execute() {
			const d = soulsDir();
			if (!d)
				return {
					content: [
						{ type: "text" as const, text: "SOULS_DIR not set" },
					],
				};
			const out: string[] = [];
			for (const f of readdirSync(d).filter((f) => f.endsWith(".md"))) {
				const src = readFileSync(join(d, f), "utf-8");
				const fm = src.match(/^---\n([\s\S]*?)\n---/);
				const meta: Record<string, string> = {};
				if (fm)
					for (const line of fm[1].split("\n"))
						if (line.includes(":"))
							meta[line.split(":")[0].trim()] = line
								.split(":")
								.slice(1)
								.join(":")
								.trim();
				const name = meta.name ?? f.replace(/\.md$/, "");
				out.push(
					`${name} — role:${meta.role ?? "?"} gh:${meta.gh ?? "none"} ${meta.desc ?? ""}`,
				);
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `You are: ${me()}\n\n${out.join("\n")}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "team_ask",
		label: "Team Ask",
		description:
			"Ask a teammate a question — they run with their own persona/tools and their reply is returned to you AND posted in chat. Use when a teammate's input makes your answer better.",
		promptSnippet: "Ask a teammate a question",
		promptGuidelines: [
			"Prefer team_ask over silently guessing at another role's job.",
			"One ask per run — compose the final user-facing answer yourself.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Teammate name (team_roster)" }),
			question: Type.String(),
		}),
		async execute(_id, params) {
			if (params.to === me())
				return {
					content: [
						{ type: "text" as const, text: "That's you — answer directly." },
					],
				};
			const id = send("ask", params.to, params.question);
			const reply = await awaitReply(id);
			return {
				content: [
					{
						type: "text" as const,
						text:
							reply === null
								? `(no reply from ${params.to} within ${ASK_TIMEOUT_MS / 1000}s — answer without them)`
								: `${params.to} replied:\n${reply}`,
					},
				],
				details: { to: params.to, replied: reply !== null },
			};
		},
	});

	pi.registerTool({
		name: "team_handoff",
		label: "Team Handoff",
		description:
			"Hand the ENTIRE request to a teammate — they answer the user directly and your run should end (output a short Persian handoff line, nothing else).",
		promptSnippet: "Hand this request to a teammate",
		promptGuidelines: [
			"Use when the request is clearly another role's job — don't answer it yourself first.",
		],
		parameters: Type.Object({
			to: Type.String(),
			note: Type.Optional(
				Type.String({ description: "Context for the teammate" }),
			),
		}),
		async execute(_id, params) {
			const id = send("handoff", params.to, params.note ?? "");
			return {
				content: [
					{
						type: "text" as const,
						text: `Handed off to ${params.to} (${id.slice(0, 8)}) — output only a one-line Persian handoff now.`,
					},
				],
				details: { to: params.to },
			};
		},
	});

	pi.registerTool({
		name: "team_say",
		label: "Team Say",
		description:
			"Post a message to the chat immediately, mid-run — a quick ack or a question for the user while you keep working.",
		parameters: Type.Object({ text: Type.String() }),
		async execute(_id, params) {
			send("say", me(), params.text);
			return {
				content: [{ type: "text" as const, text: "posted." }],
			};
		},
	});
}
