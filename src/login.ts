/**
 * Devin OAuth PKCE login flow plus the local callback-server CLI.
 *
 * 1. Generate PKCE pair + state.
 * 2. User visits https://app.devin.ai/auth/cli/continue?...
 * 3. Browser redirects to http://127.0.0.1:59653/callback with `code`+`state`.
 * 4. Exchange code + verifier for a session token at
 *    https://api.devin.ai/auth/cli/token.
 * 5. Save the token to <configDir>/token (unless --print).
 */

import { exec } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import type { ProxyConfig } from "./config.js";
import { tokenFilePath, tokenFingerprint, writeTokenFile } from "./token.js";

const DEVIN_WEBAPP_URL = "https://app.devin.ai";
const DEVIN_API_URL = "https://api.devin.ai";
const TOKEN_PATH = "/auth/cli/token";
const CALLBACK_PORT = 59653;
const CALLBACK_PATH = "/callback";
const TIMEOUT_MS = 5 * 60 * 1000;

export interface LoginSession {
  state: string;
  verifier: string;
  challenge: string;
  authUrl: string;
  redirectUri: string;
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = base64UrlEncode(challengeBytes);
  return { verifier, challenge };
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function startLoginFlow(redirectUri: string): Promise<LoginSession> {
  const state = crypto.randomUUID();
  const { verifier, challenge } = await generatePKCE();
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    prompt: "select_account",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authUrl = `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`;
  return { state, verifier, challenge, authUrl, redirectUri };
}

export async function completeLoginWithUrl(session: LoginSession, redirectUrl: string): Promise<string> {
  // Parse the redirect URL to extract code
  const url = new URL(redirectUrl, "http://localhost");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("No code in redirect URL");

  return exchangeToken(code, session.verifier);
}

export async function exchangeToken(code: string, verifier: string): Promise<string> {
  const res = await fetch(`${DEVIN_API_URL}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("Token exchange returned empty token");
  return data.token;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export async function runLogin(config: ProxyConfig, argv: string[]): Promise<void> {
  const pasteMode = argv.includes("--paste");
  const printOnly = argv.includes("--print");

  const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const session = await startLoginFlow(redirectUri);

  console.log("");
  console.log("  devin-proxy — Login");
  console.log("  ─────────────────────────────────────────────────────");
  console.log("");
  console.log("  Open this URL in your browser to sign in to Devin:");
  console.log("");
  console.log(`  ${session.authUrl}`);
  console.log("");

  if (pasteMode) {
    // Manual paste mode: no local server, user pastes the redirect URL
    console.log("  After signing in, you'll be redirected to a URL like:");
    console.log(`  http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}?code=...&state=...`);
    console.log("  Paste that full URL here:");
    console.log("");

    const input = await prompt("  > ");
    if (!input) {
      console.error("No URL provided.");
      process.exit(1);
    }

    try {
      const token = await completeLoginWithUrl(session, input.trim());
      await finishLogin(config, token, printOnly);
    } catch (err) {
      console.error(`Login failed: ${String((err as Error).message ?? err)}`);
      process.exit(1);
    }
  } else {
    // Auto mode: start local callback server, wait for it to be listening, then
    // open the browser — so the callback URL is reachable the instant it loads.
    const { ready, token } = startCallbackServer(session);

    try {
      await ready; // throws on EADDRINUSE / other listen failures
    } catch (err) {
      console.error(`Login failed: ${String((err as Error).message ?? err)}`);
      process.exit(1);
    }

    // Try to open the browser automatically
    try {
      const cmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? `cmd /c start ""`
            : "xdg-open";
      execAsync(`${cmd} "${session.authUrl}"`);
      console.log("  (Attempting to open browser automatically...)");
    } catch {
      console.log("  (Could not open browser automatically — please open the URL manually)");
    }
    console.log("");
    console.log(`  Waiting for callback on http://127.0.0.1:${CALLBACK_PORT}...`);
    console.log(`  (Timeout: ${TIMEOUT_MS / 1000}s — press Ctrl+C to cancel)`);
    console.log("");

    try {
      const t = await token;
      await finishLogin(config, t, printOnly);
    } catch (err) {
      console.error(`Login failed: ${String((err as Error).message ?? err)}`);
      process.exit(1);
    }
  }
}

async function finishLogin(config: ProxyConfig, token: string, printOnly: boolean): Promise<void> {
  if (printOnly) {
    console.log(token);
    return;
  }
  await writeTokenFile(config, token);
  console.log("  Login successful!");
  console.log("");
  console.log(`  Token saved to: ${tokenFilePath(config)}`);
  console.log(`  Token:          ${tokenFingerprint(token)}`);
  console.log("");
  console.log("  Start the proxy: bun run start");
  console.log("");
}

function startCallbackServer(session: {
  state: string;
  verifier: string;
}): { ready: Promise<void>; token: Promise<string> } {
  let resolveToken!: (v: string) => void;
  let rejectToken!: (e: unknown) => void;
  const token = new Promise<string>((res, rej) => {
    resolveToken = res;
    rejectToken = rej;
  });

  let resolveReady!: () => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let settled = false;
  let server: Server;

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      server.close();
      rejectToken(new Error("Login timed out"));
    }
  }, TIMEOUT_MS);

  const fail = (err: unknown): void => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      server.close();
      rejectToken(err);
    }
  };

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "", `http://127.0.0.1:${CALLBACK_PORT}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    const sendHtml = (message: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(htmlBody(message));
    };

    if (error) {
      const desc = url.searchParams.get("error_description") ?? error;
      fail(new Error(`Authorization failed: ${desc}`));
      sendHtml(`Login failed: ${desc}`);
      return;
    }

    if (!code || state !== session.state) {
      fail(new Error("Invalid callback: missing code or state mismatch"));
      sendHtml("Invalid callback");
      return;
    }

    // Exchange token
    exchangeToken(code, session.verifier)
      .then((t) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          resolveToken(t);
        }
      })
      .catch(fail);

    sendHtml("Login successful! You can close this tab.");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      rejectReady(
        new Error(
          `Port ${CALLBACK_PORT} is already in use (another login in progress?). Free it and retry.`,
        ),
      );
    } else {
      rejectReady(err);
    }
    fail(err);
  });

  server.once("listening", () => resolveReady());
  server.listen(CALLBACK_PORT, "127.0.0.1");

  return { ready, token };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlBody(message: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb"><div style="text-align:center;padding:2em;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1)"><h1 style="font-size:1.5em;margin-bottom:0.5em">${escapeHtml(message)}</h1><p style="color:#666">You can close this tab.</p></div></body></html>`;
}

async function prompt(message: string): Promise<string> {
  process.stdout.write(message);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question("", resolve));
    return answer.trim();
  } finally {
    rl.close();
  }
}

function execAsync(cmd: string): void {
  exec(cmd, () => {});
}
