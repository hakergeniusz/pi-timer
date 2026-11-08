/**
 * pi-timer — let the agent arm chat pings.
 *
 * One tool, `timer`, seven actions:
 *   - `in`    one-shot after a delay (`delay`: 90s, 5m, 1h30m, 2d)
 *   - `at`    one-shot at a wall-clock time (`at`: 14:30, 2026-11-09 09:00, ISO)
 *   - `every` recurring interval (`delay`, min 10s)
 *   - `cron`  recurring on a 5-field crontab (`cron`: "0 9 * * 1-5")
 *   - `on`    fire when a shell command exits (`command`, optional
 *             `expect` success|failure|any and `matches` regex on output)
 *   - `cancel` / `list`
 *
 * A fire sends "[timer <id>] <message>" as a user message — a real turn when
 * the agent is idle, a queued follow-up while it is streaming. `on` pings
 * once when the command ends, saying whether the awaited condition held and
 * attaching a tail of its output, so a spawn is never silently dropped.
 *
 * Timers are per-session and persisted under ~/.pi/agent/timers/<session>.json.
 * On session_start future timers re-arm; one-shots that expired while Pi was
 * closed are reported as missed and dropped (a stale ping is worse than none).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const MAX_TIMERS = 64;
const MAX_MESSAGE = 1000;
const MAX_LABEL = 60;
const MIN_RECUR_MS = 10_000;
const ON_TIMEOUT_DEFAULT = 600; // seconds
const ON_TIMEOUT_MAX = 24 * 3600;
const OUTPUT_TAIL = 400;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // Node setTimeout ceiling (~24.8 days)
const PERSIST_TTL_MS = 30 * 86_400_000; // GC persisted files after 30 days

// ---------------------------------------------------------------- parsing

/** "90", "90s", "5m", "1h30m", "2d", "1w" → ms; null when unparseable. Bare numbers are seconds. */
export function parseDelay(spec: string): number | null {
	const s = spec.trim().toLowerCase().replace(/\s+/g, "");
	if (!s) return null;
	const re = /(\d+(?:\.\d+)?)([smhdw]?)/g;
	let total = 0;
	let consumed = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) {
		consumed += m[0].length;
		const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, "": 1000 }[m[2]]!;
		total += parseFloat(m[1]) * mult;
	}
	if (consumed !== s.length || total <= 0) return null;
	return Math.round(total);
}

export interface Cron {
	/** null = unrestricted (`*`) */
	mins: Set<number> | null;
	hours: Set<number> | null;
	doms: Set<number> | null;
	months: Set<number> | null;
	dows: Set<number> | null; // 0 and 7 both mean Sunday
}

/** Returns a set (restricted), null (wildcard `*`), or undefined (invalid). */
function parseCronField(field: string, lo: number, hi: number, dowNormalize: boolean): Set<number> | null | undefined {
	if (field === "*") return null;
	const out = new Set<number>();
	for (const part of field.split(",")) {
		const [range, stepStr] = part.split("/");
		const step = stepStr ? parseInt(stepStr, 10) : 1;
		if (!Number.isInteger(step) || step < 1) return undefined;
		let a = lo;
		let b = hi;
		if (range !== "*") {
			const span = range.match(/^(\d+)-(\d+)$/);
			if (span) {
				a = +span[1];
				b = +span[2];
			} else if (/^\d+$/.test(range) && stepStr) {
				a = +range; // "5/15" = every 15 starting at 5
			} else if (/^\d+$/.test(range)) {
				a = b = +range;
			} else {
				return undefined;
			}
		}
		if (a < lo || b > hi || a > b) return undefined;
		for (let v = a; v <= b; v += step) out.add(dowNormalize && v === 7 ? 0 : v);
	}
	return out;
}

/** 5-field crontab (m h dom mon dow); null when invalid. */
export function parseCron(expr: string): Cron | null {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const mins = parseCronField(fields[0], 0, 59, false);
	const hours = parseCronField(fields[1], 0, 23, false);
	const doms = parseCronField(fields[2], 1, 31, false);
	const months = parseCronField(fields[3], 1, 12, false);
	const dowsRaw = parseCronField(fields[4], 0, 7, true);
	if (mins === undefined || hours === undefined || doms === undefined || months === undefined || dowsRaw === undefined) return null;
	return { mins, hours, doms, months, dows: dowsRaw };
}

/** Next minute matching the cron strictly after `after`; null when none within 4 years. */
export function cronNext(c: Cron, after: number): number | null {
	const d = new Date(after);
	d.setSeconds(0, 0);
	d.setMinutes(d.getMinutes() + 1);
	const limit = 4 * 366 * 24 * 60; // ~4 years of minutes, then give up
	for (let i = 0; i < limit; i++) {
		if (c.months !== null && !c.months.has(d.getMonth() + 1)) {
			d.setMonth(d.getMonth() + 1, 1); // overflows Dec → Jan next year
			d.setHours(0, 0, 0, 0);
			continue;
		}
		const domOk = c.doms === null || c.doms.has(d.getDate());
		const dowOk = c.dows === null || c.dows.has(d.getDay());
		// Vixie cron: when both day fields are restricted, either may match.
		const dayOk = c.doms !== null && c.dows !== null ? domOk || dowOk : domOk && dowOk;
		if (!dayOk) {
			d.setDate(d.getDate() + 1);
			d.setHours(0, 0, 0, 0);
			continue;
		}
		if (c.hours !== null && !c.hours.has(d.getHours())) {
			d.setHours(d.getHours() + 1, 0, 0, 0); // overflows into next day
			continue;
		}
		if (c.mins === null || c.mins.has(d.getMinutes())) return d.getTime();
		d.setMinutes(d.getMinutes() + 1);
	}
	return null;
}

/** "14:30" (next occurrence), "2026-11-09[ T]09:00[:30]", or any Date.parse-able spec → epoch ms. */
export function parseAt(spec: string): number | null {
	const s = spec.trim();
	let m = s.match(/^(\d{1,2}):(\d{2})$/);
	if (m) {
		const d = new Date();
		d.setSeconds(0, 0);
		d.setHours(+m[1], +m[2]);
		if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
		return d.getTime();
	}
	m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
	if (m) {
		const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
		if (isNaN(d.getTime())) return null;
		return d.getTime();
	}
	const t = Date.parse(s);
	return isNaN(t) ? null : t;
}

// ---------------------------------------------------------------- helpers

function fmtDur(ms: number): string {
	if (ms < 0) ms = 0;
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
	const d = Math.floor(h / 24);
	return `${d}d${h % 24}h`;
}

function fmtTime(ms: number): string {
	const d = new Date(ms);
	const today = new Date();
	const sameDay = d.toDateString() === today.toDateString();
	const time = d.toTimeString().slice(0, 5);
	if (sameDay) return time;
	return `${d.toISOString().slice(0, 10)} ${time}`;
}

function tail(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > OUTPUT_TAIL ? `…${flat.slice(-OUTPUT_TAIL)}` : flat;
}

// ---------------------------------------------------------------- state

interface TimerRec {
	id: string;
	kind: "in" | "at" | "every" | "cron" | "on";
	message: string;
	label?: string;
	createdAt: number;
	nextAtMs?: number; // one-shot fire time or recurring next occurrence
	everyMs?: number;
	cron?: string;
	command?: string;
	expect?: "success" | "failure" | "any";
	matches?: string;
	timeoutSec?: number;
	cwd?: string;
}

interface Persisted {
	seq: number;
	timers: TimerRec[];
}

export default function (pi: ExtensionAPI) {
	let timers: TimerRec[] = [];
	let seq = 0;
	let sessionKey: string | null = null;
	let running = false;
	const wakeups = new Map<string, ReturnType<typeof setTimeout>>();
	const aborters = new Map<string, AbortController>();

	// ---------------------------------------------------------- persistence

	function agentDir(): string {
		const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
		return base.endsWith("agent") ? base : join(base, "agent");
	}

	function timersDir(): string {
		return join(agentDir(), "timers");
	}

	function persist(): void {
		if (!sessionKey) return;
		try {
			mkdirSync(timersDir(), { recursive: true });
			const path = join(timersDir(), `${sessionKey}.json`);
			if (timers.length === 0) {
				if (existsSync(path)) unlinkSync(path);
			} else {
				const data: Persisted = { seq, timers };
				writeFileSync(path, JSON.stringify(data, null, "\t"), "utf8");
			}
		} catch {
			/* persistence is best-effort */
		}
	}

	function load(sessionId: string): Persisted | null {
		try {
			const path = join(timersDir(), `${sessionId}.json`);
			if (!existsSync(path)) return null;
			return JSON.parse(readFileSync(path, "utf8")) as Persisted;
		} catch {
			return null;
		}
	}

	function gcStale(): void {
		try {
			const dir = timersDir();
			if (!existsSync(dir)) return;
			const cutoff = Date.now() - PERSIST_TTL_MS;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".json")) continue;
				const p = join(dir, f);
				if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
			}
		} catch {
			/* best-effort */
		}
	}

	// ---------------------------------------------------------- scheduling

	function describe(t: TimerRec): string {
		switch (t.kind) {
			case "in":
				return `once, ${fmtDur((t.nextAtMs ?? 0) - Date.now())} from spawn`;
			case "at":
				return `once, at ${fmtTime(t.nextAtMs ?? 0)}`;
			case "every":
				return `every ${fmtDur(t.everyMs ?? 0)}, next ${fmtTime(t.nextAtMs ?? 0)}`;
			case "cron":
				return `cron '${t.cron}', next ${fmtTime(t.nextAtMs ?? 0)}`;
			case "on":
				return `when '${t.command}' exits (expect ${t.expect ?? "success"}${t.matches ? `, /${t.matches}/` : ""})`;
		}
	}

	function listText(): string {
		if (timers.length === 0) return "No active timers.";
		return timers
			.map((t) => `${t.id}${t.label ? ` (${t.label})` : ""}: ${describe(t)} — ${t.message.slice(0, 80)}`)
			.join("\n");
	}

	function notify(ctx: unknown, text: string): void {
		try {
			const ui = (ctx as { ui?: { notify?: (t: string, level?: string) => void } })?.ui;
			ui?.notify?.(`pi-timer: ${text}`, "info");
		} catch {
			/* non-interactive */
		}
	}

	function disarm(id: string): void {
		const w = wakeups.get(id);
		if (w !== undefined) {
			clearTimeout(w);
			wakeups.delete(id);
		}
	}

	function remove(id: string): void {
		disarm(id);
		const ac = aborters.get(id);
		if (ac) {
			ac.abort();
			aborters.delete(id);
		}
		timers = timers.filter((t) => t.id !== id);
	}

	function fire(t: TimerRec): void {
		const text = `[timer ${t.id}] ${t.message}`;
		if (running) pi.sendUserMessage(text, { deliverAs: "followUp" });
		else pi.sendUserMessage(text);
	}

	/** Schedule the wakeup that runs `onDue` at `t.nextAtMs`; chains past the setTimeout ceiling. */
	function arm(t: TimerRec): void {
		disarm(t.id);
		if (t.kind === "on") {
			void launch(t);
			return;
		}
		if (!t.nextAtMs) return;
		const step = () => {
			const remain = (t.nextAtMs ?? 0) - Date.now();
			if (remain <= 0) {
				wakeups.delete(t.id);
				onDue(t.id);
				return;
			}
			const h = setTimeout(step, Math.min(remain, MAX_TIMEOUT_MS - 60_000));
			wakeups.set(t.id, h);
		};
		step();
	}

	function onDue(id: string): void {
		const t = timers.find((x) => x.id === id);
		if (!t) return;
		fire(t);
		if (t.kind === "in" || t.kind === "at") {
			remove(id);
			persist();
			return;
		}
		if (t.kind === "every") {
			t.nextAtMs = Date.now() + (t.everyMs ?? MIN_RECUR_MS);
			arm(t);
			persist();
			return;
		}
		if (t.kind === "cron") {
			const c = parseCron(t.cron ?? "");
			const next = c ? cronNext(c, Date.now()) : null;
			if (next === null) {
				remove(id);
				persist();
				return;
			}
			t.nextAtMs = next;
			arm(t);
			persist();
		}
	}

	/** Run the watched command for an `on` timer; ping exactly once when it ends. */
	async function launch(t: TimerRec): Promise<void> {
		const ac = new AbortController();
		aborters.set(t.id, ac);
		const timeoutSec = Math.min(Math.max(t.timeoutSec ?? ON_TIMEOUT_DEFAULT, 1), ON_TIMEOUT_MAX);
		try {
			const res = await pi.exec("sh", ["-c", t.command ?? "true"], {
				signal: ac.signal,
				timeout: timeoutSec * 1000,
				cwd: t.cwd,
			});
			if (aborters.get(t.id) !== ac) return; // cancelled while running
			aborters.delete(t.id);
			const out = tail(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
			const ok = res.code === 0 && !res.killed;
			const matched = t.expect === "failure" ? !ok : t.expect === "any" ? true : ok;
			const regexOk =
				!t.matches ||
				(() => {
					try {
						return new RegExp(t.matches!).test(out);
					} catch {
						return true; // a bad regex must not eat the ping
					}
				})();
			let note = "";
			if (res.killed) note = `command was killed (timeout ${timeoutSec}s)`;
			else if (!matched) note = `condition NOT met: exit ${res.code}, expected ${t.expect ?? "success"}`;
			else if (!regexOk) note = `condition NOT met: output did not match /${t.matches}/`;
			const msg = note ? `${t.message} — ${note}${out ? ` | output: ${out}` : ""}` : `${t.message}${out ? ` | ${out}` : ""}`;
			fire({ ...t, message: msg.slice(0, MAX_MESSAGE + OUTPUT_TAIL + 80) });
		} catch (err) {
			if (aborters.get(t.id) === ac) {
				aborters.delete(t.id);
				fire({ ...t, message: `${t.message} — watcher failed: ${(err as Error).message}`.slice(0, MAX_MESSAGE + 80) });
			}
		} finally {
			if (aborters.get(t.id) === ac) aborters.delete(t.id);
			if (timers.some((x) => x.id === t.id)) {
				remove(t.id);
				persist();
			}
		}
	}

	// ---------------------------------------------------------- lifecycle

	pi.on("agent_start", () => {
		running = true;
	});
	pi.on("agent_end", () => {
		running = false;
	});

	pi.on("session_start", (_event, ctx) => {
		const sid = (ctx?.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
		sessionKey = sid || null;
		running = false;
		gcStale();
		if (!sid) return;
		const saved = load(sid);
		if (!saved) return;
		seq = saved.seq ?? 0;
		timers = Array.isArray(saved.timers) ? saved.timers : [];
		const now = Date.now();
		const missed: TimerRec[] = [];
		for (const t of [...timers]) {
			if (t.kind === "on") {
				arm(t); // re-launch the watched command
				continue;
			}
			if (t.nextAtMs && t.nextAtMs <= now) {
				if (t.kind === "every") {
					t.nextAtMs = now + (t.everyMs ?? MIN_RECUR_MS); // skip cycles missed while closed
					arm(t);
				} else if (t.kind === "cron") {
					// empty sets → cronNext month-jumps to its limit and returns null
					const fallback = { mins: new Set<number>(), hours: new Set<number>(), doms: new Set<number>(), months: new Set<number>(), dows: new Set<number>() };
					const next = cronNext(parseCron(t.cron ?? "") ?? fallback, now);
					if (next === null) {
						missed.push(t);
						remove(t.id);
					} else {
						t.nextAtMs = next;
						arm(t);
					}
				} else {
					missed.push(t);
					remove(t.id);
				}
			} else {
				arm(t);
			}
		}
		persist();
		if (ctx?.hasUI) {
			const live = timers.filter((t) => t.kind !== "on").length;
			if (live > 0) notify(ctx, `${live} timer(s) re-armed — /timers lists them`);
			if (missed.length > 0) notify(ctx, `missed while closed: ${missed.map((t) => `${t.id} "${t.message.slice(0, 40)}"`).join(", ")}`);
		}
	});

	pi.on("session_shutdown", () => {
		for (const t of [...timers]) remove(t.id);
		timers = [];
		running = false;
	});

	// ---------------------------------------------------------- tool

	const TimerParams = Type.Object({
		action: StringEnum(["in", "at", "every", "cron", "on", "cancel", "list"] as const),
		message: Type.Optional(
			Type.String({ description: "Ping text; arrives as a user message '[timer <id>] <message>'. Required for spawn actions. Write it self-contained." }),
		),
		delay: Type.Optional(Type.String({ description: "Duration for in/every: 90s, 5m, 1h30m, 2d (bare numbers = seconds; every min 10s)" })),
		at: Type.Optional(Type.String({ description: "Time for at: 14:30 (next occurrence), 2026-11-09 09:00, or ISO 8601" })),
		cron: Type.Optional(Type.String({ description: "5-field crontab for cron, e.g. */15 * * * *" })),
		command: Type.Optional(Type.String({ description: "Shell command for on (run via sh -c)" })),
		expect: Type.Optional(StringEnum(["success", "failure", "any"] as const)),
		matches: Type.Optional(Type.String({ description: "Regex the combined output must match for on" })),
		timeoutSec: Type.Optional(Type.Number({ description: "on: command timeout in seconds, default 600, max 86400" })),
		id: Type.Optional(Type.String({ description: "Timer id for cancel, e.g. t3" })),
		label: Type.Optional(Type.String({ description: "Optional short label shown by list//timers" })),
	});

	pi.registerTool({
		name: "timer",
		label: "Timer",
		description:
			"Arm chat pings. Actions: 'in' one-shot after a delay (delay: 90s, 5m, 1h30m, 2d), 'at' one-shot at a time " +
			"(at: 14:30, 2026-11-09 09:00, ISO 8601), 'every' recurring interval (delay, min 10s), 'cron' recurring on a " +
			"5-field crontab (cron), 'on' fire when a shell command exits (command; optional expect success|failure|any, " +
			"matches regex on output, timeoutSec) — it pings once on completion saying whether the condition held; " +
			"'cancel' by id; 'list'. Every spawn needs a self-contained message: it arrives as '[timer <id>] <message>' " +
			"and you of that moment have no other context. Recurring timers run until cancelled; cancel them when done. " +
			`Max ${MAX_TIMERS} per session.`,
		promptSnippet: "timer — arm chat pings: in/at/every/cron/on-command, cancel, list",
		promptGuidelines: [
			"Use timer whenever the user wants a reminder, follow-up or check-in later or on a schedule; report the returned id and next fire time.",
			"Timer messages must be self-contained — they arrive as a user message with no other context.",
			"Recurring timers fire until cancelled: offer to cancel (timer cancel) once their purpose is served; /timers lists all.",
		],
		parameters: TimerParams,
		async execute(_toolId, params: unknown, _sig, _upd, ctx) {
			const p = (params ?? {}) as Record<string, any>;
			const action = p.action as string;
			const cwd: string | undefined = (ctx as { cwd?: string } | undefined)?.cwd;

			if (action === "list") return text(listText());

			if (action === "cancel") {
				const id = String(p.id ?? "").trim();
				if (!id) throw new Error("cancel needs id (see timer list)");
				const t = timers.find((x) => x.id === id || x.label === id);
				if (!t) throw new Error(`Unknown timer '${id}'. Active:\n${listText()}`);
				remove(t.id);
				persist();
				return text(`Cancelled ${t.id}: ${t.message.slice(0, 80)}`);
			}

			// spawn actions
			const message = String(p.message ?? "").trim();
			if (!message) throw new Error(`'${action}' needs message — it is the ping text`);
			if (timers.length >= MAX_TIMERS) throw new Error(`Timer cap reached (${MAX_TIMERS}). Cancel some first: timer list`);

			const t: TimerRec = {
				id: "", // assigned after validation — failed spawns must not burn ids
				kind: action as TimerRec["kind"],
				message: message.slice(0, MAX_MESSAGE),
				createdAt: Date.now(),
				cwd,
			};
			const label = String(p.label ?? "").trim();
			if (label) t.label = label.slice(0, MAX_LABEL);

			if (action === "in" || action === "every") {
				const ms = parseDelay(String(p.delay ?? ""));
				if (ms === null) throw new Error(`Bad delay '${p.delay}'. Use 90s, 5m, 1h30m, 2d…`);
				if (action === "every" && ms < MIN_RECUR_MS) throw new Error(`Recurring minimum is ${fmtDur(MIN_RECUR_MS)} — use 'in' for one-shots`);
				if (action === "in") t.nextAtMs = Date.now() + ms;
				else {
					t.everyMs = ms;
					t.nextAtMs = Date.now() + ms;
				}
			} else if (action === "at") {
				const ms = parseAt(String(p.at ?? ""));
				if (ms === null) throw new Error(`Bad time '${p.at}'. Use 14:30, 2026-11-09 09:00, or ISO 8601`);
				if (ms <= Date.now()) throw new Error(`'${p.at}' is in the past (parsed ${fmtTime(ms)})`);
				t.nextAtMs = ms;
			} else if (action === "cron") {
				const expr = String(p.cron ?? "").trim();
				const c = parseCron(expr);
				if (!c) throw new Error(`Bad cron '${expr}'. Need 5 fields (m h dom mon dow), e.g. */15 * * * *`);
				const next = cronNext(c, Date.now());
				if (next === null) throw new Error(`Cron '${expr}' never fires`);
				t.cron = expr;
				t.nextAtMs = next;
			} else if (action === "on") {
				const command = String(p.command ?? "").trim();
				if (!command) throw new Error("'on' needs command");
				t.command = command;
				t.expect = p.expect ?? "success";
				if (p.matches) t.matches = String(p.matches);
				if (p.timeoutSec !== undefined) t.timeoutSec = Number(p.timeoutSec);
			} else {
				throw new Error(`Unknown action '${action}'`);
			}

			t.id = `t${++seq}`;
			timers.push(t);
			arm(t);
			persist();
			return text(`Armed ${t.id}${t.label ? ` (${t.label})` : ""}: ${describe(t)}. Ping: "${t.message}"`);
		},
	});

	function text(t: string) {
		return { content: [{ type: "text" as const, text: t }], details: undefined };
	}

	// ---------------------------------------------------------- command

	pi.registerCommand("timers", {
		description: "List active timers, or cancel one: /timers cancel t3",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				notify(ctx, listText());
				return;
			}
			const m = arg.match(/^(?:cancel|rm|drop)\s+(\S+)$/);
			if (m) {
				const t = timers.find((x) => x.id === m[1] || x.label === m[1]);
				if (!t) {
					notify(ctx, `Unknown timer '${m[1]}'`);
					return;
				}
				remove(t.id);
				persist();
				notify(ctx, `Cancelled ${t.id}`);
				return;
			}
			notify(ctx, `Usage: /timers [cancel <id>]`);
		},
	});
}
