// hosts.ts
// Remote server inventory and SSH operations (exec, status, SFTP transfer,
// deploy). Uses npm:ssh2 — pure JS SSH, works on Windows without OpenSSH.
/// <reference path="./types/ssh2.d.ts" />
import { Client, type ConnectConfig, type SFTPWrapper } from "npm:ssh2@1.16.0";
import { Buffer } from "node:buffer";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { db } from "./db.ts";

export type Host = {
  id: number;
  name: string;
  host: string;
  port: number;
  user: string;
  auth_type: "key" | "password";
  key_path: string;
  password: string;
  sudo_password: string;
  created_at: number;
};

const SSH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 50_000;
const RETRY_DELAY_CAP_MS = 10_000;
const POOL_IDLE_MS = 5 * 60_000;

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Read lazily so tests can inject small values via the environment.
function sshMaxRetries(): number {
  return envInt("SSH_MAX_RETRIES", 3);
}
function sshRetryBaseMs(): number {
  return envInt("SSH_RETRY_BASE_MS", 500);
}
function sftpTimeoutMs(): number {
  return envInt("SFTP_TIMEOUT_MS", 120_000);
}

// Failures that retrying cannot fix: bad credentials, unreadable keys, and
// command-level timeouts (a hung command is not a transport failure).
const NON_RETRYABLE_PATTERNS = [
  /all configured authentication methods failed/i,
  /cannot read ssh key/i,
  /command timed out/i,
];

const RETRYABLE_PATTERNS = [
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN/i,
  /timed out while waiting for handshake/i,
  /\bconnection\b/i,
  /\bchannel\b/i,
  /\bsocket\b/i,
];

/** True for transient transport errors worth retrying; false for auth
 * failures, unreadable keys, and command timeouts. */
export function isRetryableSshError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(msg))) return false;
  return RETRYABLE_PATTERNS.some((re) => re.test(msg));
}

/** Exponential backoff with jitter: base * 2^attempt, capped at 10s. */
export function sshRetryDelayMs(attempt: number, baseMs = sshRetryBaseMs()): number {
  const exp = Math.min(baseMs * 2 ** attempt, RETRY_DELAY_CAP_MS);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects if `op` does not settle within `ms`; the underlying op is not
 * cancelled, so callers drop the connection on timeout. */
export function withTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms);
  });
  return Promise.race([op, timeout]).finally(() => clearTimeout(timer));
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("timed out after");
}

function rowToHost(row: {
  id: number;
  name: string;
  host: string;
  port: number;
  user: string;
  auth_type: string;
  key_path: string;
  password: string;
  sudo_password: string;
  created_at: number;
}): Host {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    user: row.user,
    auth_type: row.auth_type === "password" ? "password" : "key",
    key_path: row.key_path,
    password: row.password,
    sudo_password: row.sudo_password,
    created_at: row.created_at,
  };
}

function publicHost(row: Host) {
  return { ...row, password: row.password ? "•••" : "", sudo_password: row.sudo_password ? "•••" : "" };
}

const HOST_COLUMNS = "id, name, host, port, user, auth_type, key_path, password, sudo_password, created_at";

type HostRow = {
  id: number;
  name: string;
  host: string;
  port: number;
  user: string;
  auth_type: string;
  key_path: string;
  password: string;
  sudo_password: string;
  created_at: number;
};

export function listHosts(): Host[] {
  const rows = db.prepare(`SELECT ${HOST_COLUMNS} FROM hosts ORDER BY name`).all() as HostRow[];
  return rows.map(rowToHost);
}

export function getHost(id: number): Host | null {
  const row = db.prepare(`SELECT ${HOST_COLUMNS} FROM hosts WHERE id = ?`).get(id) as HostRow | undefined;
  return row ? rowToHost(row) : null;
}

export function getHostByName(name: string): Host | null {
  const row = db.prepare(`SELECT ${HOST_COLUMNS} FROM hosts WHERE name = ?`).get(name) as HostRow | undefined;
  return row ? rowToHost(row) : null;
}

export function createHost(
  name: string,
  host: string,
  port: number,
  user: string,
  authType: "key" | "password",
  keyPath: string,
  password: string,
  sudoPassword = "",
): Host {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("Host name is required.");
  if (!host.trim()) throw new Error("Host address is required.");
  if (!user.trim()) throw new Error("SSH user is required.");
  if (db.prepare("SELECT id FROM hosts WHERE name = ?").get(trimmedName)) {
    throw new Error(`A host named '${trimmedName}' already exists.`);
  }
  if (authType === "key" && !keyPath.trim()) {
    throw new Error("Key path is required for key authentication.");
  }
  if (authType === "password" && !password) {
    throw new Error("Password is required for password authentication.");
  }
  const info = db.prepare(
    `INSERT INTO hosts (name, host, port, user, auth_type, key_path, password, sudo_password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trimmedName,
    host.trim(),
    Math.max(1, Math.min(65535, Math.floor(port))),
    user.trim(),
    authType,
    keyPath.trim(),
    password,
    sudoPassword,
    Date.now(),
  );
  return getHost(Number(info.lastInsertRowid))!;
}

export function updateHost(
  id: number,
  fields: {
    name?: string;
    host?: string;
    port?: number;
    user?: string;
    auth_type?: string;
    key_path?: string;
    password?: string;
    sudo_password?: string;
  },
): Host | null {
  const existing = getHost(id);
  if (!existing) return null;
  const name = fields.name !== undefined ? fields.name.trim() : existing.name;
  if (!name) throw new Error("Host name cannot be empty.");
  if (db.prepare("SELECT id FROM hosts WHERE name = ? AND id != ?").get(name, id)) {
    throw new Error(`A host named '${name}' already exists.`);
  }
  const host = fields.host !== undefined ? fields.host.trim() : existing.host;
  if (!host) throw new Error("Host address cannot be empty.");
  const user = fields.user !== undefined ? fields.user.trim() : existing.user;
  if (!user) throw new Error("SSH user cannot be empty.");
  const authType = fields.auth_type !== undefined
    ? (fields.auth_type === "password" ? "password" : "key")
    : existing.auth_type;
  const keyPath = fields.key_path !== undefined ? fields.key_path.trim() : existing.key_path;
  const password = fields.password !== undefined ? fields.password : existing.password;
  const sudoPassword = fields.sudo_password !== undefined ? fields.sudo_password : existing.sudo_password;
  if (authType === "key" && !keyPath) throw new Error("Key path is required for key authentication.");
  if (authType === "password" && !password) throw new Error("Password is required for password authentication.");
  db.prepare(
    "UPDATE hosts SET name = ?, host = ?, user = ?, auth_type = ?, key_path = ?, password = ?, sudo_password = ? WHERE id = ?",
  ).run(name, host, user, authType, keyPath, password, sudoPassword, id);
  return getHost(id);
}

export function deleteHost(id: number): boolean {
  const exists = db.prepare("SELECT id FROM hosts WHERE id = ?").get(id);
  if (!exists) return false;
  db.prepare("DELETE FROM hosts WHERE id = ?").run(id);
  return true;
}

// ===== SSH operations =====

// ----- connection pool -----
// Ready clients are cached by connection config (not host id) so editing a
// host's address/credentials naturally yields a fresh connection. Idle
// entries are dropped by a lazy sweep on acquire — no timers to leak.

type PoolEntry = { client: Client; lastUsed: number };
const sshPool = new Map<string, PoolEntry>();

function poolKey(host: Host): string {
  return [host.host, host.port, host.user, host.auth_type, host.key_path, host.password].join("\n");
}

function evictSshEntry(key: string, client?: Client): void {
  const entry = sshPool.get(key);
  if (!entry) return;
  if (client && entry.client !== client) return;
  sshPool.delete(key);
  try {
    entry.client.end();
  } catch {
    // already closed
  }
}

/** Drains every pooled connection (test teardown, shutdown). */
export function closeSshPool(): void {
  for (const key of [...sshPool.keys()]) evictSshEntry(key);
}

/** Runs `op`, retrying transient transport failures with exponential
 * backoff. The pooled connection is evicted before each retry so the next
 * attempt reconnects. */
async function withSshRetry<T>(host: Host, op: () => Promise<T>): Promise<T> {
  const maxRetries = sshMaxRetries();
  let retries = 0;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      if (retries >= maxRetries || !isRetryableSshError(err)) throw err;
      evictSshEntry(poolKey(host));
      await sleep(sshRetryDelayMs(retries));
      retries++;
    }
  }
}

async function acquireSsh(host: Host): Promise<Client> {
  const now = Date.now();
  // Lazy sweep of connections idle longer than POOL_IDLE_MS.
  for (const [key, entry] of [...sshPool]) {
    if (now - entry.lastUsed > POOL_IDLE_MS) evictSshEntry(key);
  }
  const key = poolKey(host);
  const pooled = sshPool.get(key);
  if (pooled) {
    pooled.lastUsed = now;
    return pooled.client;
  }
  // No retry here — callers wrap acquireSsh in withSshRetry, and nesting
  // two retry loops would multiply the attempt count.
  const client = await connectSsh(host);
  // A concurrent acquire may have pooled a connection meanwhile — reuse it.
  const raced = sshPool.get(key);
  if (raced) {
    raced.lastUsed = Date.now();
    try {
      client.end();
    } catch {
      // ignore
    }
    return raced.client;
  }
  sshPool.set(key, { client, lastUsed: Date.now() });
  // Evict on transport-level death so the next op reconnects.
  const onDead = () => evictSshEntry(key, client);
  client.on("close", onDead);
  client.on("error", onDead);
  return client;
}

function connectSsh(host: Host): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`SSH connection to ${host.host}:${host.port} timed out.`));
    }, 15_000);
    client.on("ready", () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`SSH connection to ${host.host}:${host.port} failed: ${err.message}`));
    });
    const config: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.user,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
      // Avoid AES-GCM: Deno's crypto layer doesn't support setAutoPadding(false)
      // for GCM modes, which breaks the ssh2 handshake.
      algorithms: {
        cipher: ["aes128-ctr", "aes192-ctr", "aes256-ctr", "aes128-cbc", "aes256-cbc"],
      },
    };
    if (host.auth_type === "password" && host.password) {
      config.password = host.password;
    } else {
      try {
        config.privateKey = Deno.readTextFileSync(host.key_path);
      } catch (err) {
        clearTimeout(timer);
        reject(new Error(`Cannot read SSH key '${host.key_path}': ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
    }
    client.connect(config);
  });
}

export type ExecResult = { code: number; stdout: string; stderr: string };

const SUDO_RE = /^\s*sudo(?:\s+|$)/;

function sudoPasswordFor(host: Host): string {
  return host.sudo_password || (host.auth_type === "password" ? host.password : "");
}

function execOnClient(
  client: Client,
  execCommand: string,
  sudoPassword: string | undefined,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }
    }, timeoutMs);
    try {
      client.exec(execCommand, (err, stream) => {
        if (err) {
          if (!settled) { settled = true; clearTimeout(timer); reject(err); }
          return;
        }
        if (sudoPassword !== undefined) stream.write(`${sudoPassword}\n`);
        let stdout = "";
        let stderr = "";
        stream.on("close", (code: number | undefined) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout, stderr });
          }
        });
        stream.on("data", (d: string | Uint8Array) => { stdout += d.toString(); });
        stream.stderr.on("data", (d: string | Uint8Array) => { stderr += d.toString(); });
      });
    } catch (err) {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    }
  });
}

export async function sshExec(host: Host, command: string, timeoutMs = SSH_TIMEOUT_MS): Promise<ExecResult> {
  // sudo handling: run "sudo -S <cmd>" and feed the password via stdin so it
  // never appears in the command string, process list, or approval cards.
  // Validate before connecting so missing credentials fail fast.
  let execCommand = command;
  let sudoPassword: string | undefined;
  if (SUDO_RE.test(command)) {
    const inner = command.replace(/^\s*sudo\s*/, "");
    if (!inner) throw new Error("Empty sudo command.");
    sudoPassword = sudoPasswordFor(host);
    if (!sudoPassword) {
      throw new Error(
        `This command needs sudo, but no sudo password is configured for host '${host.name}'. ` +
        "Set a sudo password on the host (or configure passwordless sudo).",
      );
    }
    execCommand = `sudo -S ${inner}`;
  }

  try {
    return await withSshRetry(host, async () => {
      const client = await acquireSsh(host);
      return await execOnClient(client, execCommand, sudoPassword, timeoutMs);
    });
  } catch (err) {
    // A timed-out command may leave a wedged channel; drop the connection.
    if (isTimeoutError(err)) evictSshEntry(poolKey(host));
    throw err;
  }
}

export async function sshStatus(host: Host): Promise<string> {
  const commands: Array<[string, string]> = [
    ["host", "uname -n 2>/dev/null || hostname"],
    ["uptime", "uptime 2>/dev/null || echo n/a"],
    ["disk", "df -h / 2>/dev/null | tail -1"],
    ["mem", "free -m 2>/dev/null | head -2 | tail -1 || echo n/a"],
  ];
  const lines = [`Status of ${host.name} (${host.user}@${host.host}:${host.port}):`];
  for (const [label, cmd] of commands) {
    try {
      const result = await sshExec(host, cmd, 15_000);
      const value = (result.stdout || result.stderr).trim().replace(/\s+/g, " ") || "n/a";
      lines.push(`- ${label}: ${value}`);
    } catch (err) {
      lines.push(`- ${label}: error (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return lines.join("\n");
}

// ===== SFTP =====

function sftpPromise<T>(fn: (callback: (err?: Error | null, result?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) reject(err);
      else resolve(result as T);
    });
  });
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else if (!sftp) reject(new Error("SFTP session was not established."));
      else resolve(sftp);
    });
  });
}

/** Runs an SFTP operation on a pooled connection with retries and a timeout
 * on session init; individual transfers add their own timeouts. */
async function withSftp<T>(host: Host, op: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  try {
    return await withSshRetry(host, async () => {
      const client = await acquireSsh(host);
      const sftp = await withTimeout(getSftp(client), sftpTimeoutMs(), "SFTP session init");
      return await op(sftp);
    });
  } catch (err) {
    // A timed-out transfer can leave a wedged channel; drop the connection.
    if (isTimeoutError(err)) evictSshEntry(poolKey(host));
    throw err;
  }
}

export async function sftpReadFile(host: Host, remotePath: string): Promise<string> {
  return await withSftp(host, (sftp) =>
    withTimeout(
      sftpPromise<string>((cb) => sftp.readFile(remotePath, "utf8", (err, data) => cb(err, String(data ?? "")))),
      sftpTimeoutMs(),
      `SFTP read of ${remotePath}`,
    ));
}

export async function sftpUploadFile(host: Host, localPath: string, remotePath: string): Promise<number> {
  await withSftp(host, (sftp) =>
    withTimeout(
      sftpPromise((cb) => sftp.fastPut(localPath, remotePath, cb)),
      sftpTimeoutMs(),
      `SFTP upload of ${remotePath}`,
    ));
  return Deno.statSync(localPath).size;
}

async function mkdirp(sftp: SFTPWrapper, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let current = path.startsWith("/") ? "" : ".";
  for (const part of parts) {
    current = `${current}/${part}`;
    try {
      await withTimeout(sftpPromise((cb) => sftp.mkdir(current, cb)), sftpTimeoutMs(), `SFTP mkdir ${current}`);
    } catch (err) {
      // directory already exists
      if (isTimeoutError(err)) throw err;
    }
  }
}

export async function sftpUploadDir(
  host: Host,
  localDir: string,
  remoteDir: string,
): Promise<{ files: number; bytes: number }> {
  return await withSftp(host, async (sftp) => {
    await mkdirp(sftp, remoteDir);

    let files = 0;
    let bytes = 0;
    const stack: Array<{ local: string; remote: string }> = [{ local: localDir, remote: remoteDir }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of Deno.readDirSync(current.local)) {
        const localPath = resolve(current.local, entry.name);
        const remotePath = `${current.remote}/${entry.name}`;
        if (entry.isDirectory) {
          await withTimeout(sftpPromise((cb) => sftp.mkdir(remotePath, cb)), sftpTimeoutMs(), `SFTP mkdir ${remotePath}`)
            .catch((err) => {
              // directory may already exist
              if (isTimeoutError(err)) throw err;
            });
          stack.push({ local: localPath, remote: remotePath });
        } else if (entry.isFile) {
          await withTimeout(
            sftpPromise((cb) => sftp.fastPut(localPath, remotePath, cb)),
            sftpTimeoutMs(),
            `SFTP upload of ${remotePath}`,
          );
          const stat = Deno.statSync(localPath);
          bytes += stat.size;
          files++;
        }
      }
    }
    return { files, bytes };
  });
}

export async function sshDeploy(
  host: Host,
  localDir: string,
  remoteDir: string,
  postDeploy?: string,
): Promise<string> {
  const { files, bytes } = await sftpUploadDir(host, localDir, remoteDir);
  const lines = [`Deployed ${files} file(s) (${bytes} bytes) to ${host.name}:${remoteDir}.`];
  if (postDeploy) {
    const result = await sshExec(host, postDeploy);
    lines.push(`Post-deploy command exit code: ${result.code}`);
    if (result.stdout) lines.push(result.stdout.trim());
    if (result.stderr) lines.push(result.stderr.trim());
  }
  return lines.join("\n");
}

/** Home directory of the SSH user (used as a base for default deploy paths). */
export async function sshHomeDir(host: Host): Promise<string> {
  const result = await sshExec(host, "pwd", 15_000);
  const home = result.stdout.trim() || result.stderr.trim();
  if (!home) throw new Error("Could not determine remote home directory.");
  return home;
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + "\n...[truncated]" : text;
}

export function formatExecResult(result: ExecResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout.trim());
  if (result.stderr) parts.push(result.stderr.trim());
  const body = parts.join("\n") || "(no output)";
  return result.code === 0 ? body : `(exit code ${result.code})\n${body}`;
}

export { publicHost, truncate };




