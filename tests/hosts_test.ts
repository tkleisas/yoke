// tests/hosts_test.ts
// Integration tests for remote-host management against an in-process SSH server.
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { makeDeploySource, startSshServer, stopSshServer, TEST_PASSWORD, TEST_SUDO_PASSWORD, TEST_USER } from "./helpers.ts";
import {
  closeSshPool, createHost, deleteHost, getHost, getHostByName, listHosts, sftpReadFile, sftpUploadDir,
  sftpUploadFile, sshDeploy, sshExec, sshHomeDir, sshStatus, updateHost,
} from "../hosts.ts";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

let port = 22;
let hostId = 0;

// Start the shared in-process SSH server before any test runs.
const { port: sshPort } = await startSshServer();
port = sshPort;

function makeHost(opts: { password?: string; host?: string; port?: number; name?: string; sudoPassword?: string } = {}) {
  return createHost(
    opts.name ?? "testbox",
    opts.host ?? "127.0.0.1",
    opts.port ?? port,
    TEST_USER,
    "password",
    "",
    opts.password ?? TEST_PASSWORD,
    opts.sudoPassword ?? "",
  );
}

Deno.test("host CRUD", async () => {
  const host = makeHost();
  hostId = host.id;

  assertEquals(getHost(hostId)?.name, "testbox");
  assertEquals(getHostByName("testbox")?.user, TEST_USER);
  assertEquals(listHosts().length >= 1, true);

  const updated = updateHost(hostId, { user: "root" });
  assertEquals(updated?.user, "root");

  const renamed = updateHost(hostId, { name: "testbox2" });
  assertEquals(renamed?.name, "testbox2");
  assertEquals(getHostByName("testbox"), null);

  assertEquals(deleteHost(hostId), true);
  assertEquals(getHost(hostId), null);
});

Deno.test("duplicate host names are rejected", () => {
  makeHost({ name: "dupbox" });
  assertThrows(() => makeHost({ name: "dupbox" }), Error, "already exists");
  deleteHost(getHostByName("dupbox")!.id);
});

// ssh2 uses Node's native crypto ciphers, which Deno's resource/op leak
// sanitizers cannot track — disable them for the SSH integration tests.
function sshTest(name: string, fn: () => void | Promise<void>) {
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false }, fn);
}

sshTest("sshExec runs commands and returns output", async () => {
  const host = makeHost({ name: "execbox" });
  const result = await sshExec(host, "echo hello-remote");
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim(), "hello-remote");
  deleteHost(host.id);
});

sshTest("sudo reuses the SSH password with password auth", async () => {
  const host = makeHost({ name: "sudobox" });
  const result = await sshExec(host, "sudo echo privileged");
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim(), "sudo-ok");
  deleteHost(host.id);
});

sshTest("sudo uses an explicit sudo password when set", async () => {
  const host = makeHost({ name: "sudoexplicit", sudoPassword: TEST_SUDO_PASSWORD });
  const result = await sshExec(host, "sudo echo privileged");
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim(), "sudo-ok");
  deleteHost(host.id);
});

sshTest("sudo with a wrong password reports failure", async () => {
  const host = makeHost({ name: "sudobad", sudoPassword: "wrong-password" });
  const result = await sshExec(host, "sudo echo privileged");
  assertEquals(result.code, 1);
  assertEquals(result.stdout.includes("Sorry, try again"), true);
  deleteHost(host.id);
});

sshTest("sudo without any configured password is rejected up front", async () => {
  const host = createHost("sudonopw", "127.0.0.1", port, TEST_USER, "key", "tests/fixtures/test_host_key", "", "");
  await assertRejects(
    () => sshExec(host, "sudo systemctl restart nginx"),
    Error,
    "no sudo password is configured",
  );
  deleteHost(host.id);
});

sshTest("sshHomeDir returns the home directory", async () => {
  const host = makeHost({ name: "homebox" });
  assertEquals(await sshHomeDir(host), "/home/testuser");
  deleteHost(host.id);
});

sshTest("sshStatus reports host details", async () => {
  const host = makeHost({ name: "statusbox" });
  const status = await sshStatus(host);
  assertEquals(status.includes("Status of statusbox"), true);
  assertEquals(status.includes("testuser@127.0.0.1"), true);
  assertEquals(status.includes("host: testbox"), true);
  deleteHost(host.id);
});

sshTest("bad credentials are rejected", async () => {
  const host = makeHost({ name: "badbox", password: "wrong-password" });
  await assertRejects(() => sshExec(host, "echo nope"), Error, "SSH connection to 127.0.0.1:");
  deleteHost(host.id);
});

sshTest("sftp upload + read round-trip", async () => {
  const host = makeHost({ name: "sftpbox" });
  const tmp = await Deno.makeTempFile({ prefix: "yoke-up-", suffix: ".txt" });
  await Deno.writeTextFile(tmp, "payload-123");

  const bytes = await sftpUploadFile(host, tmp, "/home/testuser/payload.txt");
  assertEquals(bytes, 11);

  const content = await sftpReadFile(host, "/home/testuser/payload.txt");
  assertEquals(content.trim(), "payload-123");
  deleteHost(host.id);
  await Deno.remove(tmp);
});

sshTest("sftpUploadDir uploads nested directories", async () => {
  const host = makeHost({ name: "dirbox" });
  const src = await makeDeploySource();

  const { files, bytes } = await sftpUploadDir(host, src, "/srv/deploy-test");
  assertEquals(files, 2);
  assertEquals(bytes > 0, true);

  const config = await sftpReadFile(host, "/srv/deploy-test/sub/config.json");
  assertEquals(config.includes('"port"'), true);
  deleteHost(host.id);
  await Deno.remove(src, { recursive: true });
});

sshTest("sshDeploy uploads a directory and runs post-deploy", async () => {
  const host = makeHost({ name: "deploybox" });
  const src = await makeDeploySource();

  const output = await sshDeploy(host, src, "/srv/app", "echo post-deploy-ran");
  assertEquals(output.includes("Deployed 2 file(s)"), true);
  assertEquals(output.includes("post-deploy-ran"), true);
  assertEquals(output.includes("exit code: 0"), true);

  const app = await sftpReadFile(host, "/srv/app/app.js");
  assertEquals(app.includes("console.log"), true);
  deleteHost(host.id);
  await Deno.remove(src, { recursive: true });
});

sshTest("integration: full lifecycle against live SSH server", async () => {
  const host = makeHost({ name: "livebox" });
  const echo = await sshExec(host, "echo live");
  assertEquals(echo.stdout.trim(), "live");
  assertEquals(host.port, sshPort);

  const src = await makeDeploySource();
  const deployed = await sshDeploy(host, src, `/home/${TEST_USER}/deploy`, "echo done");
  assertEquals(deployed.includes("Deployed 2 file(s)"), true);
  const back = await sftpReadFile(host, `/home/${TEST_USER}/deploy/sub/config.json`);
  assertEquals(back.includes('"port"'), true);
  deleteHost(host.id);
  await Deno.remove(src, { recursive: true });
});

sshTest("teardown: drain pool and stop server", async () => {
  closeSshPool();
  await stopSshServer();
});


