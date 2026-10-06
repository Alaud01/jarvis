import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Codex Switcher selects an account by rewriting ~/.codex/auth.json and keeps
 * that file's tokens fresh. Jarvis only ever reads it: the access token is
 * handed to the private app-server as external (in-memory) auth, so Jarvis
 * never writes, refreshes, or revokes the Switcher-managed credentials.
 */

export const SHARED_AUTH_MISSING_MESSAGE = 'Jarvis uses the account selected in Codex Switcher, but no ChatGPT account is active there. Pick an account in Codex Switcher, then try again.';
export const SHARED_AUTH_EXPIRED_MESSAGE = 'The ChatGPT login selected in Codex Switcher has expired. Open Codex Switcher or the Codex app so it can refresh the login, then try again.';
export const SHARED_AUTH_MANAGED_MESSAGE = 'Jarvis uses the account selected in Codex Switcher. Switch or sign out there instead.';

/** The Codex Switcher login is missing or expired; the user must fix it there. */
export class SharedCodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharedCodexAuthError';
  }
}

export interface SharedCodexCredential {
  accessToken: string;
  /** ChatGPT workspace id; shared by every user of a team workspace. */
  accountId: string;
  /** ChatGPT user id within the workspace, when the token carries it. */
  userId: string | null;
  planType: string | null;
  /** Access-token expiry in epoch milliseconds, when the token carries it. */
  expiresAt: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Follows Codex Switcher when it is installed. Set
 * JARVIS_CODEX_PRIVATE_AUTH=1 to keep Jarvis's own private login instead.
 */
export function resolveCodexSwitcherAuthPath(
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (environment.JARVIS_CODEX_PRIVATE_AUTH === '1') return undefined;
  if (!existsSync(path.join(homeDirectory, '.codex-switcher', 'accounts.json'))) return undefined;
  return path.join(homeDirectory, '.codex', 'auth.json');
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

export async function readSharedCodexCredential(authPath: string): Promise<SharedCodexCredential | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(authPath, 'utf8'));
  } catch (error) {
    // Missing, or caught mid-rewrite by Codex Switcher.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isRecord(parsed) || !isRecord(parsed.tokens)) return null;

  const accessToken = stringOrNull(parsed.tokens.access_token);
  if (!accessToken) return null;
  const claims = decodeJwtClaims(accessToken) ?? {};
  const authClaims = isRecord(claims['https://api.openai.com/auth']) ? claims['https://api.openai.com/auth'] : {};
  const accountId = stringOrNull(parsed.tokens.account_id) ?? stringOrNull(authClaims.chatgpt_account_id);
  if (!accountId) return null;

  return {
    accessToken,
    accountId,
    userId: stringOrNull(authClaims.chatgpt_account_user_id)
      ?? stringOrNull(authClaims.chatgpt_user_id)
      ?? stringOrNull(authClaims.user_id)
      ?? stringOrNull(claims.sub),
    planType: stringOrNull(authClaims.chatgpt_plan_type),
    expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : null,
  };
}

/** Distinguishes accounts; stable across token refreshes of the same account. */
export function sharedCredentialIdentity(credential: SharedCodexCredential): string {
  return `${credential.accountId}\n${credential.userId ?? ''}`;
}

export function isSharedCredentialExpired(credential: SharedCodexCredential, now = Date.now()): boolean {
  return credential.expiresAt !== null && credential.expiresAt <= now;
}
