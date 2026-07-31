// approvals.ts
// Human-in-the-loop approvals for shell commands. When a user runs
// "!command" in the UI, the request waits here until the user approves or
// denies it from the web UI (instead of Deno prompting on the terminal).

export type PendingApproval = {
  id: string;
  command: string;
  requester: string;
  created_at: number;
};

type Entry = PendingApproval & {
  timer: number;
  resolve: (approved: boolean) => void;
};

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const pending = new Map<string, Entry>();
const alwaysApproved = new Set<string>();
let nextId = 1;

export function isAlwaysApproved(command: string): boolean {
  return alwaysApproved.has(command);
}

export function listPendingApprovals(): PendingApproval[] {
  return [...pending.values()].map(({ id, command, requester, created_at }) => ({
    id,
    command,
    requester,
    created_at,
  }));
}

export function createApproval(command: string, requester: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `appr-${nextId++}`;
    const entry: Entry = {
      id,
      command,
      requester,
      created_at: Date.now(),
      timer: 0,
      resolve: (approved) => {
        pending.delete(id);
        resolve(approved);
      },
    };
    entry.timer = setTimeout(() => entry.resolve(false), APPROVAL_TIMEOUT_MS);
    pending.set(id, entry);
  });
}

export function respondApproval(id: string, approved: boolean, always: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  if (approved && always) alwaysApproved.add(entry.command);
  entry.resolve(approved);
  return true;
}
