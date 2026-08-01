// yolo.ts
// Per-user "YOLO mode": when enabled, approval prompts are skipped and shell
// commands / remote operations run without human confirmation. Extremely
// dangerous — enabled only explicitly by the user.
import { db } from "./db.ts";

export function isYoloEnabled(userId: number): boolean {
  const row = db.prepare("SELECT yolo FROM users WHERE id = ?").get(userId) as
    | { yolo: number | null }
    | undefined;
  return row?.yolo === 1;
}

export function setYoloEnabled(userId: number, enabled: boolean): void {
  db.prepare("UPDATE users SET yolo = ? WHERE id = ?").run(enabled ? 1 : 0, userId);
}
