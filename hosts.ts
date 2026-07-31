// hosts.ts
// Remote server inventory and SSH operations (exec, status, SFTP transfer,
// deploy). Uses npm:ssh2 — pure JS SSH, works on Windows without OpenSSH.
import { Client } from "npm:ssh2@1.16.0";
import type { Client as SSHClient, ConnectConfig, SFTPWrapper } from "npm:@types/ssh2@1.15.5";
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

function connectSsh(host: Host): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const client: SSHClient = new Client();
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

  const client = await connectSsh(host);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.end();
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }
    }, timeoutMs);
    client.exec(execCommand, (err, stream) => {
      if (err) {
        if (!settled) { settled = true; clearTimeout(timer); client.end(); reject(err); }
        return;
      }
      if (sudoPassword !== undefined) stream.write(`${sudoPassword}\n`);
      let stdout = "";
      let stderr = "";
      stream.on("close", (code: number | undefined) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          client.end();
          resolve({ code: code ?? -1, stdout, stderr });
        }
      });
      stream.on("data", (d: Buffer | string) => { stdout += d.toString(); });
      stream.stderr.on("data", (d: Buffer | string) => { stderr += d.toString(); });
    });
  });
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

function getSftp(client: SSHClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else if (!sftp) reject(new Error("SFTP session was not established."));
      else resolve(sftp);
    });
  });
}

export async function sftpReadFile(host: Host, remotePath: string): Promise<string> {
  const client = await connectSsh(host);
  try {
    const sftp = await getSftp(client);
    return await new Promise<string>((resolve, reject) => {
      sftp.readFile(remotePath, "utf8", (err, data) => {
        if (err) reject(err);
        else resolve(String(data ?? ""));
      });
    });
  } finally {
    client.end();
  }
}

export async function sftpUploadFile(host: Host, localPath: string, remotePath: string): Promise<number> {
  const client = await connectSsh(host);
  try {
    const sftp = await getSftp(client);
    await sftpPromise((cb) => sftp.fastPut(localPath, remotePath, cb));
    return Deno.statSync(localPath).size;
  } finally {
    client.end();
  }
}

async function mkdirp(sftp: SFTPWrapper, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let current = path.startsWith("/") ? "" : ".";
  for (const part of parts) {
    current = `${current}/${part}`;
    try {
      await sftpPromise((cb) => sftp.mkdir(current, cb));
    } catch {
      // directory already exists
    }
  }
}

export async function sftpUploadDir(
  host: Host,
  localDir: string,
  remoteDir: string,
): Promise<{ files: number; bytes: number }> {
  const client = await connectSsh(host);
  try {
    const sftp = await getSftp(client);
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
          await sftpPromise((cb) => sftp.mkdir(remotePath, cb)).catch(() => {
            // directory may already exist
          });
          stack.push({ local: localPath, remote: remotePath });
        } else if (entry.isFile) {
          await sftpPromise((cb) => sftp.fastPut(localPath, remotePath, cb));
          const stat = Deno.statSync(localPath);
          bytes += stat.size;
          files++;
        }
      }
    }
    return { files, bytes };
  } finally {
    client.end();
  }
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

