#!/usr/bin/env node
/**
 * Record a 20-25s product demo video of chief's local Web UI using Playwright + ffmpeg.
 *
 * Uses the stand-in fake Claude CLI and an isolated temporary state directory so the
 * recording is fast, deterministic, and touches no real user data.
 *
 * Outputs:
 *   - ../chief-site/assets/chief-demo.mp4        (H.264, yuv420p, faststart, no audio, < 2.5 MB)
 *   - ../chief-site/assets/chief-demo-poster.png (crisp PNG frame of the DAG + Gate state)
 *   - docs/screenshots/chief-demo.gif            (2-pass palette GIF, 12 fps, 960px wide)
 *
 * Run from the chief repository root:
 *   node scripts/record-demo.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin" && process.arch === "arm64" && !process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) {
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "mac15-arm64";
}

const { chromium } = await import("@playwright/test");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteAssetsDir = resolve(root, "../chief-site/assets");
const readmeAssetsDir = join(root, "docs/screenshots");
const videoTmpDir = join(root, "tmp/demo-video");

const outMp4 = join(siteAssetsDir, "chief-demo.mp4");
const outPoster = join(siteAssetsDir, "chief-demo-poster.png");
const outGif = join(readmeAssetsDir, "chief-demo.gif");

function checkCommand(cmd) {
  const res = spawnSync(cmd, ["-version"], { stdio: "ignore" });
  if (res.error || res.status !== 0) {
    throw new Error(`${cmd} is required but was not found on PATH.`);
  }
}

function runFfmpeg(args) {
  const res = spawnSync("ffmpeg", args, { stdio: "pipe", encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`ffmpeg failed (exit ${res.status}):\n${res.stderr}`);
  }
}

function probeDuration(filePath) {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return null;
  const secs = Number(res.stdout.trim());
  return Number.isFinite(secs) ? secs : null;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

checkCommand("ffmpeg");
checkCommand("ffprobe");

for (const dir of [siteAssetsDir, readmeAssetsDir]) {
  mkdirSync(dir, { recursive: true });
}
rmSync(videoTmpDir, { recursive: true, force: true });
mkdirSync(videoTmpDir, { recursive: true });

const workDir = mkdtempSync(join(tmpdir(), "chief-demo-state-"));
const stateDir = join(workDir, "home");
const fakeStateDir = join(workDir, "fake-state");
mkdirSync(stateDir, { recursive: true });
mkdirSync(fakeStateDir, { recursive: true });

const DEMO_PROMPT =
  "Every morning at 9am, summarize unread Slack threads, pause for me to pick which ones to reply to, then draft responses.";

const BUILT_WORKFLOW = {
  name: "morning-slack-triage",
  nodes: [
    {
      id: "summarize",
      type: "agent",
      prompt: "Summarize unread Slack threads from the last 24 hours and highlight the ones that need a reply.",
    },
    {
      id: "pick-threads",
      type: "gate",
      kind: "ask",
      prompt: "Show the summarized Slack threads and let me pick which ones to reply to.",
    },
    {
      id: "draft-replies",
      type: "agent",
      prompt: "Draft concise, helpful replies for the selected Slack threads:\n{{nodes.pick-threads.output}}",
    },
  ],
  edges: [
    { from: "summarize", to: "pick-threads" },
    { from: "pick-threads", to: "draft-replies" },
  ],
  inputs: {},
};

const rulesPath = join(workDir, "rules.json");
const block = (tag, value) => "```" + tag + "\n" + JSON.stringify(value, null, 2) + "\n```";

writeFileSync(
  rulesPath,
  JSON.stringify([
    {
      match: "summarize unread Slack threads",
      turns: [
        {
          sleep_ms: 900,
          text:
            "Built **morning-slack-triage** with 3 steps: summarize unread threads, pause at a Human-in-the-Loop Gate so you pick which ones matter, then draft replies.\n\n" +
            block("chief-workflow", BUILT_WORKFLOW),
          cost: 0.02,
          tokens: { in: 3800, out: 540 },
        },
      ],
    },
    {
      match: "Summarize unread Slack threads from the last 24 hours",
      turns: [
        {
          sleep_ms: 1400,
          text:
            "Found 3 unread Slack threads needing attention this morning.\n\n```json\n" +
            JSON.stringify(
              {
                summary: "3 unread threads need a decision or reply: release rollout timing, landing page demo placement, and local Web UI setup.",
                threads: [
                  { channel: "#engineering", author: "Dana", topic: "Release v0.4.2 rollout question", age: "18m ago" },
                  { channel: "#design", author: "Alex", topic: "Landing page demo video placement", age: "42m ago" },
                  { channel: "#support", author: "Sam", topic: "Node 22.18+ local Web UI port tip", age: "1h ago" },
                ],
                side_effects: [],
              },
              null,
              2,
            ) +
            "\n```",
          cost: 0.04,
          tokens: { in: 6400, out: 480 },
        },
      ],
    },
    {
      match: "Show the summarized Slack threads",
      turns: [
        {
          sleep_ms: 600,
          output: {
            title: "Which Slack threads should I draft replies for?",
            description: "3 unread threads from this morning's scan need your input.",
            submit_label: "Draft selected replies",
            fields: [
              {
                id: "selected",
                type: "choose-many",
                label: "Select threads to reply to",
                required: true,
                options: [
                  {
                    label: "#engineering — Release v0.4.2 rollout question",
                    detail: "From Dana · 18m ago · asks whether to cut the tag today",
                    value: { channel: "#engineering", author: "Dana", topic: "Release v0.4.2 rollout" },
                  },
                  {
                    label: "#design — Landing page demo video placement",
                    detail: "From Alex · 42m ago · asks for feedback on the demo section",
                    value: { channel: "#design", author: "Alex", topic: "Landing page demo video" },
                  },
                  {
                    label: "#support — Node 22.18+ local Web UI port tip",
                    detail: "From Sam · 1h ago · asks about configuring the local port",
                    value: { channel: "#support", author: "Sam", topic: "Local Web UI setup" },
                  },
                ],
              },
            ],
          },
          cost: 0.01,
          tokens: { in: 2100, out: 310 },
        },
      ],
    },
    {
      match: "Draft concise, helpful replies",
      turns: [
        {
          sleep_ms: 1600,
          output: {
            drafts: [
              {
                channel: "#engineering",
                reply: "Go ahead and cut v0.4.2 once CI is green — changelog and release notes are ready.",
              },
              {
                channel: "#design",
                reply: "Let's place the auto-looping demo right at the top of the Have a look section with the Gate poster frame.",
              },
            ],
            status: "Ready to review — nothing was posted to Slack.",
          },
          cost: 0.03,
          tokens: { in: 4100, out: 390 },
        },
      ],
    },
  ]),
);

const serverEnv = {
  ...process.env,
  CHIEF_HOME: stateDir,
  CHIEF_CLAUDE_BIN: join(root, "e2e/fixtures/fake-claude.ts"),
  CHIEF_CODEX_BIN: "/nonexistent/codex",
  CHIEF_CURSOR_BIN: "/nonexistent/cursor-agent",
  CHIEF_ANTIGRAVITY_BIN: "/nonexistent/agy",
  CHIEF_OPENCODE_BIN: "/nonexistent/opencode",
  CHIEF_HERMES_BIN: "/nonexistent/hermes",
  FAKE_CLAUDE_STATE: fakeStateDir,
  FAKE_CLAUDE_RULES: rulesPath,
  CHIEF_MCP_POLL_MS: "40",
  CHIEF_NO_SEED: "1",
  CHIEF_NO_UPDATE_CHECK: "1",
};

const cliPath = join(root, "packages/chief/src/cli.ts");
const server = spawn(process.execPath, [cliPath, "serve", "--port", "8080", "--no-open"], {
  cwd: root,
  env: serverEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });

async function waitUntil(fn, timeoutMs = 20_000) {
  const start = Date.now();
  for (;;) {
    const val = await fn();
    if (val) return val;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms.\nServer output:\n${serverLog}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function stopServer() {
  if (server.exitCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      server.kill("SIGKILL");
      resolveStop();
    }, 5000);
    server.once("close", () => {
      clearTimeout(timer);
      resolveStop();
    });
    server.kill("SIGTERM");
  });
}

let rawWebmPath = null;

try {
  const baseUrl = await waitUntil(() => {
    if (server.exitCode !== null) throw new Error(`chief serve exited early (${server.exitCode}):\n${serverLog}`);
    return serverLog.match(/http:\/\/127\.0\.0\.1:8080/)?.[0] ?? null;
  });

  console.log(`Local Web UI ready at ${baseUrl}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: videoTmpDir,
      size: { width: 1280, height: 800 },
    },
  });

  const page = await context.newPage();
  const video = page.video();

  // 1. Open http://127.0.0.1:8080 and wait for full UI hydration on the Designer view.
  await page.goto(`${baseUrl}/#/designer`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="palette"][data-ready="true"]').waitFor({ timeout: 15_000 });
  await page.locator('[data-testid="nav-assistant"]').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1100);

  // 2. Open chief bot and type a plain-English prompt at human pace.
  await page.locator('[data-testid="nav-assistant"]').click();
  const input = page.locator('[data-testid="assistant-question"]');
  await input.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await input.click();
  await input.pressSequentially(DEMO_PROMPT, { delay: 35 });
  await page.waitForTimeout(450);

  // 3. Submit and wait until chief bot draws the DAG workflow on the canvas. Hold 1500ms+.
  await page.locator('[data-testid="assistant-send"]').click();
  await page.locator('[data-testid="flow-node-draft-replies"]').waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="designer-status"][data-state="saved"]').waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1800);

  // Close chief bot so the canvas and subsequent Run + Gate view have full breathing room.
  await page.locator('[data-testid="assistant-close"]').click();
  await page.waitForTimeout(500);

  // 4. Click Run and let execution progress until it pauses at the Human-in-the-Loop Gate.
  await page.locator('[data-testid="btn-run"]').click();
  const firstOption = page.locator('[data-testid="gate-field-selected-0"]');
  await firstOption.waitFor({ timeout: 20_000 });
  await page.locator('[data-testid="gate-ask-submit"]').scrollIntoViewIfNeeded();
  await page.mouse.move(10, 10);
  await page.waitForTimeout(400);

  // Capture crisp PNG poster frame of the DAG + Gate state.
  await page.screenshot({ path: outPoster });
  console.log(`Captured poster frame: ${outPoster}`);

  // Hold 2000ms so the Human-in-the-Loop Gate form is unmistakable.
  await page.waitForTimeout(2000);

  // 5. Select options, approve/submit the Gate, let the final step finish, and hold on completed run.
  await firstOption.click();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="gate-field-selected-1"]').click();
  await page.waitForTimeout(650);
  await page.locator('[data-testid="gate-ask-submit"]').click();

  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="run-status"]');
      return el && /completed/i.test(el.textContent ?? "");
    },
    { timeout: 20_000 },
  );
  await page.waitForTimeout(2200);

  await context.close();
  rawWebmPath = await video.path();
  await browser.close();
} finally {
  await stopServer();
  rmSync(workDir, { recursive: true, force: true });
}

if (!rawWebmPath || !existsSync(rawWebmPath)) {
  throw new Error("Playwright did not produce a recorded .webm file.");
}

// 3. Post-process with ffmpeg: trim initial loading frames (-ss 1) and export MP4 + 2-pass GIF.
console.log("Encoding MP4...");
runFfmpeg([
  "-ss", "1",
  "-i", rawWebmPath,
  "-c:v", "libx264",
  "-pix_fmt", "yuv420p",
  "-crf", "22",
  "-movflags", "+faststart",
  "-an",
  "-y",
  outMp4,
]);

const palettePath = join(videoTmpDir, "palette.png");
const gifFilter = "fps=12,scale=960:-1:flags=lanczos";

console.log("Encoding 2-pass GIF...");
runFfmpeg([
  "-ss", "1",
  "-i", rawWebmPath,
  "-vf", `${gifFilter},palettegen=stats_mode=diff`,
  "-y",
  palettePath,
]);
runFfmpeg([
  "-ss", "1",
  "-i", rawWebmPath,
  "-i", palettePath,
  "-lavfi", `${gifFilter} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`,
  "-y",
  outGif,
]);

// Remove temporary .webm and palette files.
rmSync(videoTmpDir, { recursive: true, force: true });
const tmpParent = join(root, "tmp");
try {
  // Remove chief/tmp only if empty.
  rmSync(tmpParent, { recursive: false });
} catch {
  // Non-empty or already removed.
}

console.log("\nDemo assets generated:");
for (const file of [outMp4, outPoster, outGif]) {
  const size = statSync(file).size;
  const dur = file.endsWith(".png") ? null : probeDuration(file);
  const durStr = dur != null ? `${dur.toFixed(1)}s` : "still image";
  console.log(`  - ${file} (${durStr}, ${formatBytes(size)})`);
}

const mp4Size = statSync(outMp4).size;
if (mp4Size > 2.5 * 1024 * 1024) {
  throw new Error(`MP4 exceeded 2.5 MB target (${formatBytes(mp4Size)}).`);
}
