// tests/helpers.ts
// Shared test infrastructure: a real in-process SSH server (ssh2.Server)
// with exec + SFTP support, used to test Yoke's remote-host operations.
//
// IMPORTANT: this file must be the FIRST import in any test file that uses
// the database, so table truncation runs before other modules load.
/// <reference path="../types/ssh2.d.ts" />
import { Server } from "npm:ssh2@1.16.0";
import SFTPStream from "npm:ssh2@1.16.0/lib/protocol/SFTP.js";
import { Buffer } from "node:buffer";
import { dirname } from "https://deno.land/std@0.224.0/path/mod.ts";
import { db } from "../db.ts";

// Fresh state for every test file.
db.exec(`
  DELETE FROM hosts;
  DELETE FROM projects;
  DELETE FROM users;
  DELETE FROM sessions;
  DELETE FROM messages;
  DELETE FROM usage_log;
  DELETE FROM indexed_files;
  DELETE FROM code_symbols;
`);

export const TEST_USER = "testuser";
export const TEST_PASSWORD = "testpass";
export const TEST_SUDO_PASSWORD = "testpass";

let serverState: { port: number; store: string; server: Server } | null = null;

/** Starts (or reuses) an in-process SSH server listening on 127.0.0.1. */
export async function startSshServer(): Promise<{ port: number }> {
  if (serverState) return { port: serverState.port };

  const store = await Deno.makeTempDir({ prefix: "yoke-sftp-" });
  const hostKey = Deno.readTextFileSync(new URL("./fixtures/test_host_key", import.meta.url));

  const openFiles = new Map<string, Uint8Array>();

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "password" &&
        ctx.username === TEST_USER &&
        ctx.password === TEST_PASSWORD
      ) {
        ctx.accept();
      } else {
        ctx.reject(["password"]);
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          // sudo -S <cmd>: read the password from stdin, verify, run.
          if (info.command.startsWith("sudo -S ")) {
            let pw = "";
            const respond = (msg: string, code: number) => {
              stream.write(msg);
              stream.exit(code);
              stream.end();
            };
            stream.on("data", (d: string | Uint8Array) => {
              pw += d.toString();
              if (pw.includes("\n")) {
                const entered = pw.slice(0, pw.indexOf("\n")).trim();
                const ok = entered === TEST_SUDO_PASSWORD;
                respond(ok ? "sudo-ok\n" : "Sorry, try again\n", ok ? 0 : 1);
              }
            });
            return;
          }
          if (info.command === "pwd") stream.write("/home/testuser\n");
          else if (info.command.startsWith("echo ")) stream.write(info.command.slice(5) + "\n");
          else if (info.command.startsWith("uname -n")) stream.write("testbox\n");
          else if (info.command.startsWith("uptime")) stream.write("up 1 day\n");
          else if (info.command.startsWith("df -h /")) stream.write("/dev/sda1 100G 50G 50G 50% /\n");
          else if (info.command.startsWith("free -m")) stream.write("Mem: 1024 500 524\n");
          else stream.write("unhandled-cmd\n");
          stream.exit(0);
          stream.end();
        });
        session.on("sftp", (acceptSftp) => {
          const sftp: SFTPStream = acceptSftp();
          const resolveStore = (p: string) =>
            p.startsWith("/") ? `${store}${p}` : `${store}/${p}`;
          sftp.on("OPEN", (reqid: number, filename: string) => {
            openFiles.set(String(filename), new Uint8Array());
            sftp.handle(reqid, Buffer.from(String(filename)));
          });
          sftp.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
            const key = handle.toString();
            const cur = openFiles.get(key) ?? new Uint8Array();
            const merged = new Uint8Array(Math.max(cur.length, offset + data.length));
            merged.set(cur);
            merged.set(data, offset);
            openFiles.set(key, merged);
            sftp.status(reqid, SFTPStream.STATUS_CODE.OK);
          });
          sftp.on("CLOSE", (reqid: number, handle: Buffer) => {
            const key = handle.toString();
            const data = openFiles.get(key);
            if (data) {
              try {
                const target = resolveStore(key);
                Deno.mkdirSync(dirname(target), { recursive: true });
                Deno.writeFileSync(target, data);
              } catch {
                // ignore
              }
              openFiles.delete(key);
            }
            sftp.status(reqid, SFTPStream.STATUS_CODE.OK);
          });
          sftp.on("READ", (reqid: number, handle: Buffer, offset: number, length: number) => {
            try {
              const fd = Deno.openSync(resolveStore(handle.toString()), { read: true });
              const buf = new Uint8Array(length);
              fd.seekSync(offset, Deno.SeekMode.Start);
              const n = fd.readSync(buf);
              fd.close();
              if (n === null || n === 0) sftp.status(reqid, SFTPStream.STATUS_CODE.EOF);
              else sftp.data(reqid, Buffer.from(buf.slice(0, n)));
            } catch {
              sftp.status(reqid, SFTPStream.STATUS_CODE.FAILURE);
            }
          });
          sftp.on("MKDIR", (reqid: number, path: string) => {
            try {
              Deno.mkdirSync(resolveStore(String(path)), { recursive: true });
              sftp.status(reqid, SFTPStream.STATUS_CODE.OK);
            } catch { sftp.status(reqid, SFTPStream.STATUS_CODE.FAILURE);
            }
          });
          sftp.on("STAT", (reqid: number, path: string) => {
            try {
              const st = Deno.statSync(resolveStore(String(path)));
              sftp.attrs(reqid, {
                size: st.size,
                mode: 0o644,
                uid: 0,
                gid: 0,
                atime: 0,
                mtime: 0,
              });
            } catch {
              sftp.status(reqid, SFTPStream.STATUS_CODE.NO_SUCH_FILE);
            }
          });
          sftp.on("FSTAT", (reqid: number, handle: Buffer) => {
            try {
              const key = handle.toString();
              const pending = openFiles.get(key);
              const size = pending ? pending.length : Deno.statSync(resolveStore(key)).size;
              sftp.attrs(reqid, {
                size,
                mode: 0o644,
                uid: 0,
                gid: 0,
                atime: 0,
                mtime: 0,
              });
            } catch { sftp.status(reqid, SFTPStream.STATUS_CODE.FAILURE);
            }
          });
          sftp.on("REALPATH", (reqid: number, path: string) => sftp.realpath(reqid, String(path)));
          // Debug: log every request; respond FAILURE for ones without handlers.
          
        });
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as { port: number };
  serverState = { port: address.port, store, server };
  return { port: address.port };
}

/** Stops the shared SSH server and cleans up its SFTP store. */
export async function stopSshServer(): Promise<void> {
  if (!serverState) return;
  await new Promise<void>((resolve) => serverState!.server.close(() => resolve()));
  try {
    await Deno.remove(serverState.store, { recursive: true });
  } catch {
    // ignore
  }
  serverState = null;
}

/** Creates a temp local directory containing a couple of files for deploy tests. */
export async function makeDeploySource(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "yoke-deploy-src-" });
  await Deno.mkdir(`${dir}/sub`, { recursive: true });
  await Deno.writeTextFile(`${dir}/app.js`, "console.log('hi');\n");
  await Deno.writeTextFile(`${dir}/sub/config.json`, '{"port": 8080}\n');
  return dir;
}



