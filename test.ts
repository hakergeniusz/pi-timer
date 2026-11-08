/**
 * Smoke test: fake ExtensionAPI, no network. `bun test.ts`.
 * Runs timers against a temp PI_CODING_AGENT_DIR so persistence is exercised.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-timer-test-"));

const { default: activate, parseDelay, parseCron, cronNext, parseAt } = await import("./index.ts");

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
	if (cond) {
		console.log(`ok   ${name}`);
	} else {
		failures++;
		console.error(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

// ---------------------------------------------------------------- parsers

check("delay 90 → 90s", parseDelay("90") === 90_000);
check("delay 5m", parseDelay("5m") === 300_000);
check("delay 1h30m", parseDelay("1h30m") === 5_400_000);
check("delay 2d", parseDelay("2d") === 172_800_000);
check("delay 1w", parseDelay("1w") === 604_800_000);
check("delay 0.1s", parseDelay("0.1s") === 100);
check("delay junk → null", parseDelay("abc") === null);
check("delay 5x → null", parseDelay("5x") === null);
check("delay 0 → null", parseDelay("0s") === null);
check("delay empty → null", parseDelay("") === null);

check("cron */15 ok", parseCron("*/15 * * * *") !== null);
check("cron dow 7 normalizes to sunday", parseCron("0 9 * * 7")?.dows?.has(0) === true);
check("cron 4 fields → null", parseCron("* * * *") === null);
check("cron minute 61 → null", parseCron("61 * * * *") === null);
check("cron month 13 → null", parseCron("* * * 13 *") === null);
check("cron bad step → null", parseCron("*/0 * * * *") === null);

const base = new Date(2026, 10, 8, 10, 0, 30).getTime(); // Sun 2026-11-08 10:00:30
const next15 = cronNext(parseCron("*/15 * * * *")!, base);
check("cronNext */15 → :15", next15 !== null && new Date(next15).getMinutes() === 15, String(next15));
const next9 = cronNext(parseCron("0 9 * * *")!, base);
check("cronNext 0 9 * * * → tomorrow 09:00", next9 !== null && new Date(next9).getDate() === 9 && new Date(next9).getHours() === 9, String(next9));
const nextFeb29 = cronNext(parseCron("0 0 29 2 *")!, base);
check("cronNext feb29 → 2028-02-29", nextFeb29 !== null && new Date(nextFeb29).getFullYear() === 2028, String(nextFeb29));
const nextMon = cronNext(parseCron("0 9 * * 1")!, base); // Sunday base, next Monday
check("cronNext 0 9 * * 1 → Monday", nextMon !== null && new Date(nextMon).getDay() === 1, String(nextMon));

const atTime = parseAt("14:30");
check("at 14:30 → future", atTime !== null && atTime > Date.now());
check("at local datetime", parseAt("2020-01-02 03:04") === new Date(2020, 0, 2, 3, 4).getTime());
check("at junk → null", parseAt("never") === null);

// ------------------------------------------------------- extension (live)

interface Fake {
	pi: ExtensionAPI;
	handlers: Record<string, (...a: any[]) => any>;
	sent: { content: string; options?: unknown }[];
	notifications: string[];
	tool?: { name: string; execute: (id: string, params: unknown, sig: unknown, upd: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> };
	command?: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	sessionId: string;
}

function fakePi(sessionId: string, execImpl?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>): Fake {
	const fake: Fake = { pi: {} as ExtensionAPI, handlers: {}, sent: [], notifications: [], sessionId };
	fake.pi = {
		on: (event: string, handler: never) => {
			fake.handlers[event] = handler as never;
			return () => {};
		},
		registerTool: (tool: never) => {
			fake.tool = tool as never;
		},
		registerCommand: (name: string, opts: never) => {
			fake.command ??= {};
			fake.command[name] = opts as never;
		},
		sendUserMessage: (content: string | unknown[], options?: unknown) => {
			fake.sent.push({ content: typeof content === "string" ? content : JSON.stringify(content), options });
		},
		exec: ((cmd: string, args: string[]) =>
			execImpl?.(cmd, args) ?? Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false })) as never,
	} as unknown as ExtensionAPI;
	return fake;
}

function ctxOf(fake: Fake) {
	return {
		ui: { notify: (t: string) => fake.notifications.push(t) },
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getSessionId: () => fake.sessionId },
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SESSION = "test-session-1";

async function run(fake: Fake, params: Record<string, unknown>) {
	const res = await fake.tool!.execute("call1", params, {}, {}, ctxOf(fake));
	return res.content.map((c) => c.text).join("\n");
}

// Instance A: spawn timers, let one fire while idle, one while streaming.
const a = fakePi(SESSION, (_cmd, args) =>
	(args[1] ?? "") === "fail" ? Promise.resolve({ stdout: "", stderr: "boom", code: 2, killed: false }) : Promise.resolve({ stdout: "hello\n", stderr: "", code: 0, killed: false }),
);
activate(a.pi);
check("registers timer tool", a.tool?.name === "timer");
check("registers /timers command", !!a.command?.timers);

a.handlers.session_start!({}, ctxOf(a));

const armedIn = await run(a, { action: "in", delay: "0.2s", message: "ping one" });
check("arm in → Armed t1", /Armed t1/.test(armedIn), armedIn);

const armedOn = await run(a, { action: "on", command: "echo hello", message: "build done" });
check("arm on → Armed t2", /Armed t2/.test(armedOn), armedOn);

await sleep(400);
check("idle fire arrives as plain user message", a.sent.some((s) => s.content === "[timer t1] ping one" && s.options === undefined), JSON.stringify(a.sent));
check("on fire includes output tail", a.sent.some((s) => s.content.includes("[timer t2]") && s.content.includes("hello")), JSON.stringify(a.sent));

const armedOnFail = await run(a, { action: "on", command: "fail", expect: "success", message: "should not be this" });
await sleep(50);
check("on unmet still pings with note", a.sent.some((s) => s.content.includes("condition NOT met: exit 2")), JSON.stringify(a.sent));
check("on unmet consumed", !/t3/.test(await run(a, { action: "list" })), await run(a, { action: "list" }));

// Streaming: fire should be queued as followUp.
a.handlers.agent_start!({}, {});
await run(a, { action: "in", delay: "0.1s", message: "queued ping" });
await sleep(250);
check("streaming fire queued as followUp", a.sent.some((s) => s.content === "[timer t4] queued ping" && (s.options as { deliverAs?: string })?.deliverAs === "followUp"), JSON.stringify(a.sent));
a.handlers.agent_end!({}, {});

// Errors.
const errs: string[] = [];
for (const params of [
	{ action: "in", delay: "abc", message: "x" },
	{ action: "at", at: "1999-01-01", message: "x" },
	{ action: "every", delay: "5s", message: "x" },
	{ action: "cron", cron: "* * * *", message: "x" },
	{ action: "on", message: "x" },
	{ action: "in", delay: "5m", message: "" },
	{ action: "bogus" },
]) {
	try {
		await run(a, params);
		errs.push(`no error for ${JSON.stringify(params)}`);
	} catch (e) {
		/* expected */
	}
}
check("spawn errors reject cleanly", errs.length === 0, errs.join("; "));

const armedLive = await run(a, { action: "in", delay: "10m", message: "still live" });
check("arm live timer for cancel", /Armed t5/.test(armedLive), armedLive);
const cancelMsg = await run(a, { action: "cancel", id: "t5" });
check("cancel active timer → Cancelled", /Cancelled t5/.test(cancelMsg), cancelMsg);
let cancelMiss = "";
try {
	await run(a, { action: "cancel", id: "t5" });
} catch (e) {
	cancelMiss = (e as Error).message;
}
check("cancel twice → Unknown", /Unknown timer/.test(cancelMiss), cancelMiss);

// /timers command: list + cancel.
await a.command!.timers.handler("", ctxOf(a));
check("/timers lists", a.notifications.some((n) => n.includes("pi-timer:")), a.notifications.join(" | "));

// Persistence: instance B loads session file from disk and re-arms.
await run(a, { action: "in", delay: "0.5s", message: "survive restart", label: "boot" });
const { default: activateB } = await import("./index.ts?restart=1");
const b = fakePi(SESSION);
activateB(b.pi);
b.handlers.session_start!({}, ctxOf(b));
const listB = await (async () => {
	const res = await b.tool!.execute("call2", { action: "list" }, {}, {}, ctxOf(b));
	return res.content.map((c) => c.text).join("\n");
})();
check("restarted instance re-arms persisted timer", /t6.*boot/.test(listB), listB);
await sleep(700);
check("persisted timer fires after restart", b.sent.some((s) => s.content === "[timer t6] survive restart"), JSON.stringify(b.sent));

// shutdown disarms everything.
b.handlers.session_shutdown!({}, {});
check("shutdown clears timers", (await run(b, { action: "list" })).includes("No active timers"));

// `on` watcher survives restart: still pending in A2's file, re-launched by C.
const never = new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>(() => {});
const a2 = fakePi(SESSION, (_c, args) => ((args[1] ?? "") === "hang" ? never : Promise.resolve({ stdout: "x", stderr: "", code: 0, killed: false })));
activate(a2.pi);
a2.handlers.session_start!({}, ctxOf(a2));
await run(a2, { action: "on", command: "hang", message: "waiting for build" });
const { default: activateC } = await import("./index.ts?restart2");
const c = fakePi(SESSION, () => Promise.resolve({ stdout: "relaunched output\n", stderr: "", code: 0, killed: false }));
activateC(c.pi);
c.handlers.session_start!({}, ctxOf(c));
await sleep(50);
check("on watcher re-launched after restart", c.sent.some((s) => s.content.includes("[timer t1] waiting for build") && s.content.includes("relaunched output")), JSON.stringify(c.sent));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
