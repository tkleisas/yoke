// create-user.ts
// Creates a Yoke user directly in the database. This is the only way to
// create accounts — the web UI only supports logging in.
//
// Usage:
//   deno run --allow-env --allow-read --allow-write create-user.ts <username> <password>
import { createUser } from "./auth.ts";

const [username, password] = Deno.args;

if (!username || !password) {
  console.error(
    "Usage: deno run --allow-env --allow-read --allow-write create-user.ts <username> <password>",
  );
  Deno.exit(1);
}

try {
  const user = await createUser(username, password);
  console.log(`Created user '${user.username}' (id ${user.id}).`);
} catch (err) {
  console.error(`Failed to create user: ${err instanceof Error ? err.message : String(err)}`);
  Deno.exit(1);
}
