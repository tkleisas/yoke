// tests/ssh_resilience_test.ts
// Tests for SSH retry/backoff, connection pooling, eviction, and SFTP
// timeouts against the shared in-process SSH server fixture.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  dropSshConnections,
  sshConnectionCount,
  startSshServer,
  stopSshServer,
  TEST_PASSWORD,
  TEST_USER,
} from "./helpers.ts";
import {
  closeSshPool,
  createHost,
  deleteHost,
  isRetryableSshError,
  sshExec,
  sshRetryDelayMs,
  sshStatus,
  withTimeout,
} from "../hosts.ts";

const { port } = await startSshServer();

function makeHost(name: string, hostPort = port) {
  return createHost(name, "127.0.0.1", hostPort, TEST_USER, "password", "", TEST_PASSWORD, "");
}

// ssh2 uses Node's native crypto ciphers, which Deno's resource/op leak
// sanitizers cannot track — disable them for the SSH integration tests.
function sshTest(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false }, fn);
}

Deno.test("isRetryableSshError classifies transient vs permanent errors", () => {
  assertEquals(isRetryableSshError(new Error("read ECONNRESET")), true);
  assertEquals(isRetryableSshError(new Error("connect ECONNREFUSED 127.0.0.1:22")), true);
  assertEquals(isRetryableSshError(new Error("connect ETIMEDOUT 10.0.0.1:22")), true);
  assertEquals(isRetryableSshError(new Error("Timed out while waiting for handshake")), true);
  assertEquals(isRetryableSshError(new Error("Unable to open channel")), true);
  assertEquals(isRetryableSshError(new Error("SSH connection to 127.0.0.1:22 timed out.")), true);
  assertEquals(isRetryableSshError(new Error("All configured authentication methods failed")), false);
  assertEquals(isRetryableSshError(new Error("Cannot read SSH key '/x': NotFound")), false);
  assertEquals(isRetryableSshError(new Error("Command timed out after 60s.")), false);
  assertEquals(isRetryableSshError(new Error("No such file")), false);
});

Deno.test("sshRetryDelayMs backs off exponentially with jitter and a cap", () => {
  const d0 = sshRetryDelayMs(0, 100);
  assert(d0 >= 50 && d0 <= 100, `d0=${d0}`);
  const d1 = sshRetryDelayMs(1, 100);
  assert(d1 >= 100 && d1 <= 200, `d1=${d1}`);
  const d2 = sshRetryDelayMs(2, 100);
  assert(d2 >= 200 && d2 <= 400, `d2=${d2}`);
  const capped = sshRetryDelayMs(20, 100);
  assert(capped >= 5_000 && capped <= 10_000, `capped=${capped}`);
});

Deno.test("withTimeout rejects a hanging operation", async () => {
  await assertRejects(
    () => withTimeout(new Promise(() => {}), 25, "SFTP read of /x"),
    Error,
    "SFTP read of /x timed out",
  );
});

Deno.test("withTimeout passes through a settled result", async () => {
  assertEquals(await withTimeout(Promise.resolve(42), 1000, "op"), 42);
});

sshTest("sshExec output shape is unchanged with pooling enabled", async () => {
  const host = makeHost("shapebox");
  const result = await sshExec(host, "echo hello-pool");
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim(), "hello-pool");
  assertEquals(result.stderr, "");
  deleteHost(host.id);
});

sshTest("pool reuses one connection across sequential execs", async () => {
  closeSshPool();
  const host = makeHost("poolbox");
  const before = sshConnectionCount();
  await sshExec(host, "echo one");
  await sshExec(host, "echo two");
  assertEquals(sshConnectionCount() - before, 1);
  deleteHost(host.id);
});

sshTest("sshStatus runs its commands over a single pooled connection", async () => {
  closeSshPool();
  const host = makeHost("statuspool");
  const before = sshConnectionCount();
  const status = await sshStatus(host);
  assertEquals(status.includes("host: testbox"), true);
  assertEquals(sshConnectionCount() - before, 1);
  deleteHost(host.id);
});

sshTest("dropped connections are evicted and the next op reconnects", async () => {
  closeSshPool();
  const host = makeHost("evictbox");
  const first = await sshExec(host, "echo first");
  assertEquals(first.stdout.trim(), "first");

  dropSshConnections();
  // Let the client-side 'close' event land so the pool evicts the entry;
  // the next op must acquire a fresh connection.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = sshConnectionCount();
  const second = await sshExec(host, "echo second", 10_000);
  assertEquals(second.stdout.trim(), "second");
  assertEquals(sshConnectionCount() - before, 1);
  deleteHost(host.id);
});

sshTest("reset connections are retried with backoff, then throw", async () => {
  Deno.env.set("SSH_MAX_RETRIES", "2");
  Deno.env.set("SSH_RETRY_BASE_MS", "5");
  try {
    // TCP listener that accepts and immediately closes — every connect fails.
    const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
    let attempts = 0;
    const acceptLoop = (async () => {
      for await (const conn of listener) {
        attempts++;
        try {
          conn.close();
        } catch {
          // already closed
        }
      }
    })();
    const refusePort = (listener.addr as Deno.NetAddr).port;

    const host = makeHost("retrybox", refusePort);
    await assertRejects(() => sshExec(host, "echo nope"), Error, "SSH connection to 127.0.0.1:");
    assertEquals(attempts, 3); // 1 initial attempt + 2 retries
    deleteHost(host.id);

    listener.close();
    await acceptLoop;
  } finally {
    Deno.env.delete("SSH_MAX_RETRIES");
    Deno.env.delete("SSH_RETRY_BASE_MS");
  }
});

sshTest("auth failures are not retried", async () => {
  Deno.env.set("SSH_RETRY_BASE_MS", "5");
  try {
    closeSshPool();
    const host = createHost("authbox", "127.0.0.1", port, TEST_USER, "password", "", "wrong-password", "");
    const before = sshConnectionCount();
    await assertRejects(() => sshExec(host, "echo nope"), Error, "authentication methods failed");
    assertEquals(sshConnectionCount() - before, 1); // exactly one attempt
    deleteHost(host.id);
  } finally {
    Deno.env.delete("SSH_RETRY_BASE_MS");
  }
});

sshTest("teardown: drain pool and stop server", async () => {
  closeSshPool();
  await stopSshServer();
});
