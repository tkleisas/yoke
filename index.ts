// index.ts
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { db } from "./db.ts";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "coverage",
  ".deno", "vendor", ".cache", "__pycache__", ".next",
]);
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar", ".exe", ".dll", ".so",
  ".dylib", ".class", ".jar", ".war", ".wasm", ".pyc", ".sqlite", ".db",
  ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".wav",
]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 20_000;

type SymbolPattern = { kind: string; re: RegExp };
type LanguageRule = { exts: string[]; language: string; patterns: SymbolPattern[] };

const LANGUAGES: LanguageRule[] = [
  {
    exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    language: "typescript",
    patterns: [
      { kind: "function", re: /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g },
      { kind: "class", re: /\bclass\s+([A-Za-z_$][\w$]*)/g },
      { kind: "interface", re: /\binterface\s+([A-Za-z_$][\w$]*)/g },
      { kind: "type", re: /\btype\s+([A-Za-z_$][\w$]*)\s*=/g },
      { kind: "enum", re: /\benum\s+([A-Za-z_$][\w$]*)/g },
      { kind: "const", re: /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$]|\()/g },
    ],
  },
  {
    exts: [".py"],
    language: "python",
    patterns: [
      { kind: "function", re: /^[ \t]*def\s+([A-Za-z_]\w*)\s*\(/gm },
      { kind: "class", re: /^[ \t]*class\s+([A-Za-z_]\w*)/gm },
    ],
  },
  {
    exts: [".go"],
    language: "go",
    patterns: [
      { kind: "function", re: /\bfunc\s+([A-Za-z_]\w*)\s*\(/g },
      { kind: "type", re: /\btype\s+([A-Za-z_]\w*)\s*(struct|interface|map|\[\])/g },
    ],
  },
  {
    exts: [".rs"],
    language: "rust",
    patterns: [
      { kind: "function", re: /\bfn\s+([A-Za-z_]\w*)\s*\(/g },
      { kind: "struct", re: /\bstruct\s+([A-Za-z_]\w*)/g },
      { kind: "enum", re: /\benum\s+([A-Za-z_]\w*)/g },
      { kind: "trait", re: /\btrait\s+([A-Za-z_]\w*)/g },
    ],
  },
  {
    exts: [".java", ".kt"],
    language: "java",
    patterns: [
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
      { kind: "interface", re: /\binterface\s+([A-Za-z_]\w*)/g },
      { kind: "enum", re: /\benum\s+([A-Za-z_]\w*)/g },
      { kind: "method", re: /^\s*(public|private|protected|static|\w+\s+)*[\w<>\[\]]+\s+([a-z]\w*)\s*\(/gm },
    ],
  },
  {
    exts: [".c", ".h", ".cpp", ".hpp", ".cc", ".cxx"],
    language: "c",
    patterns: [
      { kind: "function", re: /\b([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/g },
      { kind: "struct", re: /\bstruct\s+([A-Za-z_]\w*)/g },
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
    ],
  },
  {
    exts: [".rb"],
    language: "ruby",
    patterns: [
      { kind: "method", re: /^[ \t]*def\s+([A-Za-z_]\w*[!?=]?)/gm },
      { kind: "class", re: /^[ \t]*class\s+([A-Za-z_]\w*)/gm },
    ],
  },
  {
    exts: [".php"],
    language: "php",
    patterns: [
      { kind: "function", re: /\bfunction\s+([A-Za-z_]\w*)\s*\(/g },
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
    ],
  },
  {
    exts: [".cs"],
    language: "csharp",
    patterns: [
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
      { kind: "interface", re: /\binterface\s+([A-Za-z_]\w*)/g },
      { kind: "enum", re: /\benum\s+([A-Za-z_]\w*)/g },
      { kind: "method", re: /^\s*(public|private|protected|internal|static|\w+\s+)*[\w<>\[\]]+\s+([A-Za-z_]\w*)\s*\(/gm },
    ],
  },
  {
    exts: [".swift"],
    language: "swift",
    patterns: [
      { kind: "function", re: /\bfunc\s+([A-Za-z_]\w*)\s*\(/g },
      { kind: "class", re: /\bclass\s+([A-Za-z_]\w*)/g },
      { kind: "struct", re: /\bstruct\s+([A-Za-z_]\w*)/g },
      { kind: "enum", re: /\benum\s+([A-Za-z_]\w*)/g },
    ],
  },
  {
    exts: [".sh", ".bash"],
    language: "shell",
    patterns: [
      { kind: "function", re: /^[ \t]*([A-Za-z_][\w]*)\s*\(\s*\)\s*\{/gm },
      { kind: "function", re: /^[ \t]*function\s+([A-Za-z_][\w]*)/gm },
    ],
  },
];

function languageFor(path: string): string | null {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  for (const rule of LANGUAGES) {
    if (rule.exts.includes(ext)) return rule.language;
  }
  return null;
}

function extractSymbols(content: string, path: string): Array<{ name: string; kind: string; line: number; signature: string }> {
  const language = languageFor(path);
  if (!language) return [];
  const rule = LANGUAGES.find((r) => r.language === language)!;
  const symbols: Array<{ name: string; kind: string; line: number; signature: string }> = [];
  const lines = content.split("\n");
  for (const pattern of rule.patterns) {
    pattern.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(content)) !== null) {
      const name = match[1];
      if (!name) continue;
      const line = content.slice(0, match.index).split("\n").length;
      symbols.push({
        name,
        kind: pattern.kind,
        line,
        signature: (lines[line - 1] || "").trim().slice(0, 200),
      });
    }
  }
  return symbols;
}

async function sha256Hex(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type FileInfo = { path: string; size: number; mtime: number };

async function walkFiles(workspace: string): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  const stack = [workspace];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile) {
        const ext = full.slice(full.lastIndexOf(".")).toLowerCase();
        if (SKIP_EXT.has(ext)) continue;
        try {
          const stat = Deno.statSync(full);
          if (stat.size <= MAX_FILE_BYTES) {
            files.push({ path: full, size: stat.size, mtime: stat.mtime?.getTime() ?? 0 });
          }
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  return files;
}

export type IndexResult = {
  files_seen: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  total_files: number;
  total_symbols: number;
};

export async function indexWorkspace(workspace: string): Promise<IndexResult> {
  const ws = resolve(workspace);
  const files = await walkFiles(ws);
  const seen = new Set<string>();
  let indexed = 0;
  let updated = 0;
  let unchanged = 0;

  for (const file of files) {
    const key = resolve(file.path);
    seen.add(key);

    const existing = db.prepare(
      "SELECT id, mtime, size, content_hash FROM indexed_files WHERE path = ?",
    ).get(key) as { id: number; mtime: number; size: number; content_hash: string } | undefined;

    if (existing && existing.mtime === file.mtime && existing.size === file.size) {
      unchanged++;
      continue;
    }

    let content: string;
    try {
      content = await Deno.readTextFile(file.path);
    } catch {
      unchanged++;
      continue;
    }

    const contentHash = await sha256Hex(content);
    const language = languageFor(file.path);
    const now = Date.now();

    if (existing && existing.content_hash === contentHash) {
      db.prepare(
        "UPDATE indexed_files SET mtime = ?, size = ?, last_indexed_at = ? WHERE id = ?",
      ).run(file.mtime, file.size, now, existing.id);
      updated++;
      continue;
    }

    let fileId: number;
    if (existing) {
      fileId = existing.id;
      db.prepare(
        `UPDATE indexed_files SET workspace = ?, language = ?, size = ?, mtime = ?, content_hash = ?, last_indexed_at = ?
         WHERE id = ?`,
      ).run(ws, language, file.size, file.mtime, contentHash, now, fileId);
      db.prepare("DELETE FROM code_symbols WHERE file_id = ?").run(fileId);
    } else {
      const info = db.prepare(
        `INSERT INTO indexed_files (path, workspace, language, size, mtime, content_hash, last_indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(key, ws, language, file.size, file.mtime, contentHash, now);
      fileId = Number(info.lastInsertRowid);
      indexed++;
    }

    const symbols = extractSymbols(content, file.path);
    const insert = db.prepare(
      "INSERT INTO code_symbols (file_id, name, kind, line, signature) VALUES (?, ?, ?, ?, ?)",
    );
    for (const sym of symbols) {
      insert.run(fileId, sym.name, sym.kind, sym.line, sym.signature);
    }
  }

  // Remove files no longer present in this workspace.
  const allStored = db.prepare(
    "SELECT id, path FROM indexed_files WHERE workspace = ?",
  ).all(ws) as Array<{ id: number; path: string }>;
  let removed = 0;
  for (const row of allStored) {
    if (!seen.has(row.path)) {
      db.prepare("DELETE FROM indexed_files WHERE id = ?").run(row.id);
      removed++;
    }
  }

  const totalFiles = db.prepare(
    "SELECT COUNT(*) AS c FROM indexed_files WHERE workspace = ?",
  ).get(ws) as { c: number };
  const totalSymbols = db.prepare(
    `SELECT COUNT(*) AS c FROM code_symbols s JOIN indexed_files f ON f.id = s.file_id
     WHERE f.workspace = ?`,
  ).get(ws) as { c: number };

  return {
    files_seen: files.length,
    indexed,
    updated,
    unchanged,
    removed,
    total_files: totalFiles.c,
    total_symbols: totalSymbols.c,
  };
}

export function indexStats(workspace: string): { files: number; symbols: number } {
  const ws = resolve(workspace);
  const files = db.prepare("SELECT COUNT(*) AS c FROM indexed_files WHERE workspace = ?").get(ws) as { c: number };
  const symbols = db.prepare(
    `SELECT COUNT(*) AS c FROM code_symbols s JOIN indexed_files f ON f.id = s.file_id
     WHERE f.workspace = ?`,
  ).get(ws) as { c: number };
  return { files: files.c, symbols: symbols.c };
}

export function searchSymbols(workspace: string, query: string, limit = 50): Array<Record<string, unknown>> {
  const ws = resolve(workspace);
  const pattern = `%${query}%`;
  return db.prepare(
    `SELECT s.name, s.kind, s.line, s.signature, f.path
     FROM code_symbols s JOIN indexed_files f ON f.id = s.file_id
     WHERE f.workspace = ? AND (s.name LIKE ? OR s.signature LIKE ?)
     ORDER BY s.name
     LIMIT ?`,
  ).all(ws, pattern, pattern, limit) as Array<Record<string, unknown>>;
}

export function searchFiles(workspace: string, query: string, limit = 50): Array<Record<string, unknown>> {
  const ws = resolve(workspace);
  const pattern = `%${query}%`;
  return db.prepare(
    `SELECT path, language, size, mtime
     FROM indexed_files
     WHERE workspace = ? AND path LIKE ?
     ORDER BY path
     LIMIT ?`,
  ).all(ws, pattern, limit) as Array<Record<string, unknown>>;
}

export function searchCode(query: string, workspace: string): string {
  const q = query.trim();
  if (!q) return "No search query provided.";
  const symbols = searchSymbols(workspace, q, 50);
  const files = searchFiles(workspace, q, 50);
  const parts: string[] = [];
  if (symbols.length === 0 && files.length === 0) {
    return `No indexed symbols or files match '${q}'.`;
  }
  if (symbols.length > 0) {
    parts.push(`Symbols (${symbols.length}):`);
    for (const s of symbols) {
      parts.push(`  ${s.kind} ${s.name} — ${s.path}:${s.line}`);
    }
  }
  if (files.length > 0) {
    parts.push(`Files (${files.length}):`);
    for (const f of files) {
      parts.push(`  ${f.path}`);
    }
  }
  return parts.join("\n");
}
