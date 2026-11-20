import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { chiefHome } from "../paths.ts";
import type { SandboxSpec } from "../workflow/schema.ts";

/**
 * OS sandbox for `script` nodes. There is deliberately no way to run a script without it:
 * when no backend is available the script node type is disabled.
 */
export interface SandboxStatus { available: boolean; backend: "sandbox-exec" | null; reason?: string }

let cached: SandboxStatus | undefined;

export function sandboxStatus(): SandboxStatus {
  // CHIEF_SANDBOX_BACKEND=none simulates a platform without a backend. It can only disable.
  if (process.env.CHIEF_SANDBOX_BACKEND === "none") return { available: false, backend: null, reason: "sandbox backend disabled by CHIEF_SANDBOX_BACKEND" };
  if (cached) return cached;
  if (process.platform !== "darwin") {
    cached = { available: false, backend: null, reason: `no script sandbox backend for ${process.platform} yet (see dev plan §12)` };
  } else if (!existsSync("/usr/bin/sandbox-exec")) {
    cached = { available: false, backend: null, reason: "/usr/bin/sandbox-exec not found" };
  } else {
    const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8" });
    cached = probe.status === 0
      ? { available: true, backend: "sandbox-exec" }
      : { available: false, backend: null, reason: "sandbox-exec probe failed: " + (probe.stderr ?? "").trim() };
  }
  return cached;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const home = () => real(homedir());
const expand = (p: string, base?: string) => {
  if (p === "~") return home();
  if (p.startsWith("~/")) return join(home(), p.slice(2));
  return isAbsolute(p) ? p : resolve(base ?? process.cwd(), p);
};
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Paths a script may never read: credentials and secrets, and chief's own state. */
export function secretPaths(): string[] {
  const h = home();
  return [
    ".ssh", ".aws", ".gnupg", ".netrc", ".npmrc", ".docker", ".kube", ".config/gh", ".config/gcloud",
    ".claude", ".claude.json", ".codex", ".cursor", ".gemini", ".config/opencode", ".local/share/opencode",
    "Library/Keychains", "Library/Cookies", "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Safari",
  ].map((p) => join(h, p)).concat(real(chiefHome()));
}

/** Paths a script may never write, in addition to the secret ones: places that make code run later. */
export function hookPaths(): string[] {
  const h = home();
  return [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".profile", ".gitconfig", ".config/git", "Library/LaunchAgents"].map((p) => join(h, p));
}

export interface ResolvedSandbox { cwd: string; write: string[]; network: boolean; env: string[] }

/** Resolve and check a node's sandbox settings. Returns problems; empty means usable. */
export function resolveSandbox(spec: Partial<SandboxSpec> | undefined, cwd: string): { errors: string[]; resolved: ResolvedSandbox } {
  const errors: string[] = [];
  const h = home();
  const protectedPaths = [...secretPaths(), ...hookPaths()];
  const check = (label: string, raw: string): string => {
    const p = real(expand(raw, cwd));
    if (!inside(p, h)) errors.push(`${label} "${raw}" is outside the home directory`);
    else if (p === h) errors.push(`${label} "${raw}" is the home directory itself; pick a subdirectory`);
    else if (protectedPaths.some((pp) => inside(p, pp) || inside(pp, p))) errors.push(`${label} "${raw}" overlaps a protected path`);
    else if (/(^|\/)\.git(\/|$)/.test(p)) errors.push(`${label} "${raw}" is inside a .git directory`);
    return p;
  };
  const resolvedCwd = check("cwd", cwd);
  const write = (spec?.write ?? []).map((w) => check("sandbox.write", w));
  return { errors, resolved: { cwd: resolvedCwd, write, network: !!spec?.network, env: spec?.env ?? [] } };
}

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Deny-by-default Seatbelt profile. Later rules win, so the denies come after the allows. */
export function macosProfile(sb: ResolvedSandbox, scratch: string): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-shm-read*)",
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center") (global-name "com.apple.system.logger") (global-name "com.apple.logd") (global-name "com.apple.system.DirectoryService.libinfo.v1"))',
    "(allow file-read*)",
    '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))',
    `(allow file-write* ${[sb.cwd, ...sb.write].map((p) => `(subpath ${q(p)})`).join(" ")})`,
    // Protected: never writable, whatever was granted above.
    `(deny file-write* ${[...secretPaths(), ...hookPaths()].map((p) => `(subpath ${q(p)})`).join(" ")})`,
    '(deny file-write* (regex #"/\\.git/hooks(/|$)") (regex #"/\\.git/config$"))',
    `(deny file-read* ${secretPaths().map((p) => `(subpath ${q(p)})`).join(" ")})`,
    // The scratch dir lives under chief's home, so it is re-allowed last.
    `(allow file-read* file-write* (subpath ${q(real(scratch))}))`,
  ];
  if (sb.network) {
    lines.push(
      "(allow network*)",
      "(allow system-socket)",
      '(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.SecurityServer") (global-name "com.apple.networkd"))',
    );
  }
  return lines.join("\n");
}

/** Environment for a sandboxed script: a short allowlist plus what the node asked for. */
export function sandboxEnv(sb: ResolvedSandbox, scratch: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homedir(),
    TMPDIR: real(scratch),
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
  for (const k of sb.env) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return env;
}

/** Wrap a command so it runs inside the sandbox. Throws when no backend is available. */
export function sandboxed(command: string[], sb: ResolvedSandbox, scratch: string): { argv: string[]; env: Record<string, string> } {
  const status = sandboxStatus();
  if (!status.available) throw new Error(`script nodes are disabled: ${status.reason}`);
  return { argv: ["/usr/bin/sandbox-exec", "-p", macosProfile(sb, scratch), ...command], env: sandboxEnv(sb, scratch) };
}

/** A hint for the user when a script fails on something the sandbox denied. */
export function violationHint(stderr: string, sb: ResolvedSandbox): string | null {
  if (!sb.network && /Could not resolve host|getaddrinfo|ENOTFOUND|nodename nor servname|Network is unreachable|URLError|urlopen|socket|ConnectionRefused|ECONNREFUSED|fetch failed|Unable to connect|curl:/i.test(stderr)) {
    return "the sandbox blocks network access. Add `sandbox: { network: true }` to the node to allow it.";
  }
  if (/Operation not permitted|PermissionError|EPERM|Permission denied/i.test(stderr)) {
    return "the sandbox denied a file operation. Scripts may write only in their working directory, their scratch dir ($TMPDIR) and paths listed under `sandbox.write`; protected paths can never be granted.";
  }
  return null;
}
