// certs.ts
import { createSelfSignedCertificate } from "jsr:@kjanat/micro509@0.14.0";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

export type TlsConfig = { cert: string; key: string };

function envEnabled(name: string): boolean {
  const value = (Deno.env.get(name) || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function tlsPaths(): { certPath: string; keyPath: string } {
  const certDir = resolve("certs");
  return {
    certPath: resolve(Deno.env.get("TLS_CERT_PATH") || resolve(certDir, "cert.pem")),
    keyPath: resolve(Deno.env.get("TLS_KEY_PATH") || resolve(certDir, "key.pem")),
  };
}

function fileExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

async function generateSelfSigned(certPath: string, keyPath: string): Promise<void> {
  const { certificate, keyPair } = await createSelfSignedCertificate({
    subject: { commonName: "Yoke Self-Signed", organization: "Yoke" },
    validity: { days: 825 },
    extensions: {
      extendedKeyUsage: ["serverAuth"],
      subjectAltNames: [
        { type: "dns", value: "localhost" },
        { type: "ip", value: "127.0.0.1" },
        { type: "ip", value: "0.0.0.0" },
      ],
    },
  });

  const key = await keyPair.exportPkcs8Pem();
  await Deno.mkdir(resolve(certPath, ".."), { recursive: true });
  await Deno.writeTextFile(certPath, certificate.pem);
  await Deno.writeTextFile(keyPath, key);
  console.warn(`Generated self-signed certificate: ${certPath} / ${keyPath}`);
}

/**
 * Loads TLS key/cert PEM contents, generating a self-signed certificate
 * automatically when HTTPS is enabled but no certificate exists yet.
 *
 * Returns null (plain HTTP) unless:
 *  - ENABLE_HTTPS=1 is set, or
 *  - certificate files already exist at TLS_CERT_PATH / TLS_KEY_PATH
 *    (defaulting to ./certs/cert.pem and ./certs/key.pem).
 */
export async function loadOrCreateTls(): Promise<TlsConfig | null> {
  const { certPath, keyPath } = tlsPaths();
  let hasCerts = fileExists(certPath) && fileExists(keyPath);

  if (!hasCerts && envEnabled("ENABLE_HTTPS")) {
    await generateSelfSigned(certPath, keyPath);
    hasCerts = true;
  }

  if (!hasCerts) return null;

  const cert = await Deno.readTextFile(certPath);
  const key = await Deno.readTextFile(keyPath);
  return { cert, key };
}
