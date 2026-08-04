// tests/tools_test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { runShellCommand } from "../tools.ts";

Deno.test({
  name: "fast commands return output and exit codes unchanged",
  ignore: Deno.build.os === "windows",
  async fn() {
    assertEquals(await runShellCommand("echo hello"), "hello");
    assertEquals(await runShellCommand("false"), "(exit code 1, no output)");
    // Redirects apply to the whole group, so stderr lands in the output.
    assertEquals(
      await runShellCommand("{ echo oops >&2; exit 3; }"),
      "(exit code 3)\noops",
    );
  },
});

Deno.test({
  name: "long output is truncated at 50k chars",
  ignore: Deno.build.os === "windows",
  async fn() {
    const result = await runShellCommand("head -c 60000 /dev/zero | tr '\\0' a");
    assertEquals(result.endsWith("\n...[truncated]"), true);
    assertEquals(result.length, 50_000 + "\n...[truncated]".length);
  },
});

Deno.test({
  name: "abort signal stops the command",
  ignore: Deno.build.os === "windows",
  async fn() {
    const controller = new AbortController();
    const pending = runShellCommand("sleep 30", undefined, 30_000, controller.signal);
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    assertStringIncludes(result, "(stopped)");
  },
});

Deno.test({
  name: "timeout kills the whole process tree",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "yoke-shell-" });
    const marker = `${dir}/marker`;
    try {
      // The background child would write the marker at t=1s if it survived
      // the 400ms timeout; killing only the direct shell PID leaves it alive.
      const result = await runShellCommand(
        `sh -c 'sleep 1; touch "${marker}"' & sleep 30`,
        dir,
        400,
      );
      assertStringIncludes(result, "timed out");

      // Wait past the background child's sleep, then check it never ran.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const markerExists = await Deno.stat(marker).then(() => true, () => false);
      assertEquals(markerExists, false);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
