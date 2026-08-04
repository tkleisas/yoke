// subagents.ts
// In-process registry of background subagents. Each subagent runs its own
// isolated agent loop (runAgent) with a fresh conversation.
import { DEFAULT_SUBAGENT_MAX_ITERATIONS, runAgent, SYSTEM_PROMPT, type AgentEvent, type AgentUsage, type ChatMessage } from "./agent.ts";
import { getThinkingEffortForUser } from "./models.ts";
import { getEffectiveModel } from "./projects.ts";

export type SubagentStatus = "running" | "done" | "error";

export type SubagentRecord = {
  id: string;
  name: string;
  task: string;
  status: SubagentStatus;
  steps: number;
  result?: string;
  error?: string;
  usage?: AgentUsage;
  createdAt: number;
  finishedAt?: number;
};

const MAX_CONCURRENT = 10;

const subagents = new Map<string, SubagentRecord>();
const waiters = new Map<string, Array<{ resolve: (r: SubagentRecord) => void; timer: ReturnType<typeof setTimeout> }>>();
let nextId = 1;

function makeId(): string {
  return `sub-${nextId++}`;
}

export function listSubagents(): SubagentRecord[] {
  return [...subagents.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getSubagent(id: string): SubagentRecord | null {
  return subagents.get(id) ?? null;
}

function statusOf(record: SubagentRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    steps: record.steps,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    created_at: record.createdAt,
    ...(record.finishedAt !== undefined ? { finished_at: record.finishedAt } : {}),
  };
}

function notifyDone(id: string): void {
  const list = waiters.get(id) ?? [];
  waiters.delete(id);
  const record = subagents.get(id)!;
  for (const entry of list) {
    clearTimeout(entry.timer);
    entry.resolve(record);
  }
}

/**
 * Model and thinking effort a subagent inherits from the parent's context:
 * the user's effective model (project pin overrides user choice) and their
 * reasoning effort. Without a user there is nothing to inherit and the
 * subagent falls back to runAgent's defaults.
 */
export function subagentInheritedOptions(userId?: number): { model?: string; thinkingEffort?: string } {
  if (userId == null) return {};
  return { model: getEffectiveModel(userId), thinkingEffort: getThinkingEffortForUser(userId) };
}

export function spawnSubagent(
  task: string,
  name = "subagent",
  maxIterations: number = DEFAULT_SUBAGENT_MAX_ITERATIONS,
  workspace?: string,
  userId?: number,
  signal?: AbortSignal,
): SubagentRecord {
  if (subagents.size >= MAX_CONCURRENT) {
    throw new Error(`Too many running subagents (max ${MAX_CONCURRENT}).`);
  }
  if (!task.trim()) throw new Error("Subagent task must not be empty.");

  const record: SubagentRecord = {
    id: makeId(),
    name,
    task,
    status: "running",
    steps: 0,
    createdAt: Date.now(),
  };
  subagents.set(record.id, record);

  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  runAgent(messages, task, (event: AgentEvent) => {
    if (event.type === "step") record.steps++;
    else if (event.type === "finish") record.result = event.finalAnswer;
    else if (event.type === "error" && !record.error) record.error = event.error;
  }, { maxIterations, workspace, userId, signal, ...subagentInheritedOptions(userId) }).then(({ usage }) => {
    record.usage = usage;
    record.status = record.error ? "error" : "done";
    record.finishedAt = Date.now();
    notifyDone(record.id);
  }).catch((err: unknown) => {
    record.error = err instanceof Error ? err.message : String(err);
    record.status = "error";
    record.finishedAt = Date.now();
    notifyDone(record.id);
  });

  return record;
}

export async function waitForSubagent(id: string, timeoutMs: number, signal?: AbortSignal): Promise<SubagentRecord> {
  const record = subagents.get(id);
  if (!record) throw new Error(`Unknown subagent id '${id}'.`);
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  if (record.status !== "running") return record;

  return new Promise((resolve, reject) => {
    const entry = {
      resolve,
      timer: setTimeout(() => {
        const list = waiters.get(id) ?? [];
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        resolve(subagents.get(id)!);
      }, timeoutMs),
    };
    // Stopping the run rejects the wait instead of waiting out the timeout.
    const onAbort = () => {
      clearTimeout(entry.timer);
      const list = waiters.get(id) ?? [];
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
      reject(signal!.reason ?? new Error("aborted"));
    };
    const list = waiters.get(id) ?? [];
    list.push(entry);
    waiters.set(id, list);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export { statusOf };
