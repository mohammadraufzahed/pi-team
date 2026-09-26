/**
 * pi-team — teammate messaging for multi-agent pi setups.
 *
 * Lets a pi run talk to OTHER agents (souls) through a file mailbox —
 * no markers in chat text, works in every run path:
 *
 *   team_roster   — who's on the team (names, roles, display)
 *   team_ask      — ask a teammate (async or wait≤2min — you need the answer)
 *   team_task     — delegate work (fire-and-forget; they own it and report)
 *   team_emit     — emit an event onto the bus (subscribed souls react)
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
	kind: "ask" | "handoff" | "say" | "task" | "event";
	text: string;
	chat?: string;
	thread?: string;
	msg?: string;
	at: number;
	converse?: string; // conversation id — multi-turn exchange
	budget_s?: number; // declared run budget in seconds — liveness loop extends past it only on heartbeats
}

function teamDir(): void {
	mkdirSync(REQ_DIR, { recursive: true });
	mkdirSync(REP_DIR, { recursive: true });
}

function send(
	kind: Request["kind"],
	to: string,
	text: string,
	extra?: Partial<Request>,
): string {
	teamDir();
	const req: Request = {
		id: randomUUID(),
		from: process.env.PI_TEAM_FROM ?? "unknown",
		to,
		kind,
		text,
		chat: process.env.PI_TEAM_CHAT,
		thread: process.env.PI_TEAM_THREAD,
		msg: process.env.PI_TEAM_MSG,
		at: Date.now(),
		...extra,
	};
	writeFileSync(join(REQ_DIR, `${req.id}.json`), JSON.stringify(req));
	return req.id;
}

async function awaitReply(
	id: string,
	budget = ASK_TIMEOUT_MS,
): Promise<string | null> {
	const file = join(REP_DIR, `${id}.json`);
	const deadline = Date.now() + budget;
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

async function statusQuery(): Promise<string> {
	teamDir();
	const id = randomUUID();
	writeFileSync(
		join(REQ_DIR, `${id}.json`),
		JSON.stringify({
			id, from: process.env.PI_TEAM_FROM ?? "?", to: "host",
			kind: "status", text: "", at: Date.now(),
		}),
	);
	const file = join(REP_DIR, `${id}.json`);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (existsSync(file)) {
			try {
				return String(JSON.parse(readFileSync(file, "utf-8")).text ?? "");
			} catch { /* retry */ }
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	return "(status timed out)";
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
			"Ask a teammate. wait=false (default): async — their reply wakes you as a new turn, answer the user now. wait=true: block ~2min for their reply — only when you literally cannot answer without it.",
		promptSnippet: "Ask a teammate a question",
		promptGuidelines: [
			"Prefer team_ask over silently guessing at another role's job. Default to async (wait=false) — waiting stalls you AND the user.",
			"One ask per run — compose the final user-facing answer yourself.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Teammate name (team_roster)" }),
			question: Type.String(),
			wait: Type.Optional(
				Type.Boolean({
					description:
						"true = block up to ~2min for their reply (only when you literally can't answer without it). false/omitted = async: their reply wakes you later. Default false.",
				}),
			),
			budget_min: Type.Optional(
				Type.Number({
					description:
						"Minutes the teammate's run may take (5–30, default 10). Long work also needs heartbeats — see budget rules.",
				}),
			),
		}),
		async execute(_id, params) {
			if (params.to === me())
				return {
					content: [
						{ type: "text" as const, text: "That's you — answer directly." },
					],
				};
			const id = send("ask", params.to, params.question, {
				budget_s: params.budget_min
					? Math.min(Math.max(params.budget_min, 5), 30) * 60
					: undefined,
			});
			if (!params.wait) {
				// Async — their reply arrives as a new turn (kind=reply).
				return {
					content: [
						{
							type: "text" as const,
							text: `sent to ${params.to} — they'll reply asynchronously (you'll be woken when it lands). Answer the user now with what you have.`,
						},
					],
					details: { to: params.to },
				};
			}
			// Sync — capped short so a slow teammate can't eat the run.
			const reply = await awaitReply(id, 120_000);
			return {
				content: [
					{
						type: "text" as const,
						text:
							reply === null
								? `(no reply from ${params.to} in 120s — their answer will still arrive async; answer the user with what you have)`
								: `${params.to} replied:\n${reply}`,
					},
				],
				details: { to: params.to, replied: reply !== null },
			};
		},
	});

	pi.registerTool({
		name: "team_converse",
		label: "Team Converse",
		description:
			"Talk to a teammate mid-session: ask a question and WAIT for their " +
			"reply in this same run, then keep the exchange going. First call " +
			"returns a conversation_id — pass it on follow-ups so they see the " +
			"prior turns. Use for real back-and-forth (design negotiation, " +
			"handing off partial findings, asking clarifications). " +
			"team_ask(wait=true) is one shot; team_converse is a thread.",
		promptSnippet: "Converse with a teammate — multi-turn, waits for each reply",
		parameters: Type.Object({
			to: Type.String({ description: "Teammate name (team_roster)" }),
			question: Type.String({ description: "What to ask this turn" }),
			conversation_id: Type.Optional(
				Type.String({
					description:
						"Returned by the first call — pass it on follow-ups so the " +
						"teammate sees prior turns",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description: "Seconds to wait for this reply (30–600, default 300)",
				}),
			),
		}),
		async execute(_id, params) {
			if (params.to === me())
				return {
					content: [
						{ type: "text" as const, text: "That's you — answer directly." },
					],
				};
			const convId =
				params.conversation_id || `conv-${randomUUID().slice(0, 8)}`;
			const id = send("ask", params.to, params.question, {
				converse: convId,
			});
			const secs = Math.min(Math.max(params.timeout ?? 300, 30), 600);
			const reply = await awaitReply(id, secs * 1000);
			return {
				content: [
					{
						type: "text" as const,
						text:
							reply === null
								? `(conversation ${convId} — no reply in ${secs}s; their answer may still land async. You can retry with the same conversation_id.)`
								: `[conversation ${convId} — pass this id on follow-ups]\n${params.to} replied:\n${reply}`,
					},
				],
				details: { to: params.to, conversation_id: convId, replied: reply !== null },
			};
		},
	});

		pi.registerTool({
		name: "team_task",
		label: "Team Task",
		description:
			"Hand a task to a teammate — fire-and-forget, NO reply expected. They own it: they report progress/results to chat themselves, and for long work they schedule their own cron check-ins. Use for delegated work that may take a while — not for questions.",
		promptSnippet: "Delegate a task to a teammate",
		promptGuidelines: [
			"team_task = delegation (they own it, they report). team_ask = a question (you want an answer back).",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Teammate name (team_roster)" }),
			task: Type.String({ description: "The task, self-contained" }),
			budget_min: Type.Optional(
				Type.Number({
					description:
						"How long this may take (5–120, default 15). The run survives past its budget only while the soul heartbeats — bb_set(key='beat:<ticket-id>') every ~2 min.",
				}),
			),
		}),
		async execute(_id, params) {
			if (params.to === me())
				return {
					content: [
						{ type: "text" as const, text: "That's you — just do it." },
					],
				};
			send("task", params.to, params.task, {
				budget_s: params.budget_min
					? Math.min(Math.max(params.budget_min, 5), 120) * 60
					: undefined,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `task handed to ${params.to} — they'll run it and report to chat themselves`,
					},
				],
				details: { to: params.to },
			};
		},
	});

		pi.registerTool({
		name: "team_emit",
		label: "Team Emit",
		description:
			"Emit an event onto the team bus — subscribed teammates react (or 'all'/'auto'). Use for things teammates should know: bug.found, issue.closed, release.shipped...",
		promptSnippet: "Emit a team event",
		parameters: Type.Object({
			event: Type.String({ description: "dot.name e.g. bug.found" }),
			data: Type.Optional(Type.String({ description: "payload/details" })),
			to: Type.Optional(
				Type.String({ description: "soul | all | auto (default auto — subscribers)" }),
			),
		}),
		async execute(_id, params) {
			send("event", params.to ?? "auto",
				`${params.event}|||${params.data ?? ""}`);
			return {
				content: [
					{ type: "text" as const,
					  text: `event '${params.event}' emitted` },
				],
			};
		},
	});

		pi.registerTool({
		name: "team_status",
		label: "Team Status",
		description:
			"Team board — in-flight asks/tasks, recent failures, each soul's last activity. 'Who's working on what' / 'did my ask land'.",
		promptSnippet: "Check team status",
		parameters: Type.Object({}),
		async execute() {
			const id = send("say", "host", ""); // placeholder replaced below
			void id;
			const rep = await statusQuery();
			return { content: [{ type: "text" as const, text: rep }] };
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
