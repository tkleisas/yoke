// shells.ts
// In-memory registry of background shell jobs (async "!!command" from the UI).
// A job waits for web-UI approval (unless already allowed always), then runs
// with its own timeout and can be stopped at any time.
import { runShellCommand } from "./tools.ts";
import { createApproval, isAlwaysApproved } from "./approvals.ts";

export type ShellJobStatus = "pending" | "running" | "done" | "error" | "denied" | "stopped";

export type ShellJob = {
  id: string;
  command: string;
  requester: string;
  cwd: string;
  status: ShellJobStatus;
  output: string;
  timeoutSeconds: number;
  createdAt: number;
  finishedAt?: number;
};

const MAX_JOBS = 50;
const JOB_TTL_MS = 60 * 60 * 1000;

const jobs = new Map<string, ShellJob>();
const controllers = new Map<string, AbortController>();
let nextId = 1;

function prune(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

export function listShellJobs(): ShellJob[] {
  prune();
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getShellJob(id: string): ShellJob | null {
  prune();
  return jobs.get(id) ?? null;
}

export function startShellJob(
  command: string,
  requester: string,
  cwd: string,
  timeoutSeconds = 15,
): ShellJob {
  prune();
  if (jobs.size >= MAX_JOBS) throw new Error(`Too many shell jobs (max ${MAX_JOBS}).`);
  const job: ShellJob = {
    id: `job-${nextId++}`,
    command,
    requester,
    cwd,
    status: "pending",
    output: "",
    timeoutSeconds,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);

  (async () => {
    if (!isAlwaysApproved(command)) {
      const approved = await createApproval(command, requester);
      if (!approved) {
        job.status = "denied";
        job.finishedAt = Date.now();
        return;
      }
    }
    if (job.status === "stopped") return;
    job.status = "running";
    const controller = new AbortController();
    controllers.set(job.id, controller);
    try {
      job.output = await runShellCommand(command, cwd, timeoutSeconds * 1000, controller.signal);
      job.status = controller.signal.aborted ? "stopped" : "done";
    } catch (err) {
      job.status = controller.signal.aborted ? "stopped" : "error";
      job.output = job.output || (err instanceof Error ? err.message : String(err));
    } finally {
      controllers.delete(job.id);
      job.finishedAt = Date.now();
    }
  })();

  return job;
}

export function stopShellJob(id: string): boolean {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}
