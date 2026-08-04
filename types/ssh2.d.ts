// Minimal ambient type declarations for the ssh2 API surface Yoke uses.
// This replaces npm:@types/ssh2, which pulls @types/node@18 into the type
// graph and breaks Deno's native node:* type resolution (node:sqlite,
// setTimeout return types) on Deno 2.9+.

declare module "npm:ssh2@1.16.0" {
  export interface ConnectConfig {
    host: string;
    port: number;
    username: string;
    readyTimeout?: number;
    keepaliveInterval?: number;
    password?: string;
    privateKey?: string;
    algorithms?: {
      cipher?: string[];
    };
  }

  export interface ClientChannel {
    write(data: string | Uint8Array): boolean;
    on(event: "data", listener: (data: string | Uint8Array) => void): this;
    on(event: "close", listener: (code: number | undefined) => void): this;
    stderr: {
      on(event: "data", listener: (data: string | Uint8Array) => void): void;
    };
    exit(code?: number): void;
    end(): void;
  }

  export interface SFTPWrapper {
    readFile(
      path: string,
      options: string | { encoding?: string },
      callback: (err: Error | undefined, data: string | Uint8Array) => void,
    ): void;
    fastPut(localPath: string, remotePath: string, callback: (err: Error | undefined) => void): void;
    mkdir(path: string, callback: (err: Error | undefined) => void): void;
  }

  export class Client {
    on(event: "ready", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: () => void): this;
    connect(config: ConnectConfig): void;
    end(): void;
    exec(command: string, callback: (err: Error | undefined, stream: ClientChannel) => void): void;
    sftp(callback: (err: Error | undefined, sftp: SFTPWrapper) => void): void;
  }

  export interface AuthContext {
    method: string;
    username: string;
    password?: string;
    accept(): void;
    reject(methods?: string[]): void;
  }

  export interface Session {
    on(
      event: "exec",
      listener: (accept: () => ClientChannel, reject: () => void, info: { command: string }) => void,
    ): this;
    on(event: "sftp", listener: (accept: () => import("npm:ssh2@1.16.0/lib/protocol/SFTP.js").default) => void): this;
  }

  export interface Connection {
    on(event: "authentication", listener: (ctx: AuthContext) => void): this;
    on(event: "ready", listener: () => void): this;
    on(event: "session", listener: (accept: () => Session) => void): this;
    end(): void;
  }

  export class Server {
    constructor(options: { hostKeys: string[] }, listener: (client: Connection) => void);
    on(event: "error", listener: (err: Error) => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    listen(port: number, host: string, callback?: () => void): void;
    address(): { port: number } | string | null;
    close(callback?: (err?: Error) => void): void;
  }
}

declare module "npm:ssh2@1.16.0/lib/protocol/SFTP.js" {
  export default class SFTPStream {
    static STATUS_CODE: Record<string, number>;
    on(event: string, listener: (...args: any[]) => void): this;
    handle(reqid: number, handle: Uint8Array): void;
    data(reqid: number, data: Uint8Array): void;
    status(reqid: number, code: number): void;
    realpath(reqid: number, path: string): void;
    attrs(reqid: number, attrs: Record<string, unknown>): void;
  }
}
