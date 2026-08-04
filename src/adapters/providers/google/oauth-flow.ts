import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { AccountReauthRequiredError } from "../../../ports/mail-provider.port.js";
import type { StoredTokens } from "../../../ports/token-vault.port.js";

/**
 * Google OAuth Architecture (Section 13.2): Authorization Code flow with PKCE, loopback
 * redirect. No client secret is required to be kept secret — the PKCE code verifier is the real
 * security boundary (Section 13.4) — but Google's token endpoint for the "Desktop app" client
 * type still expects the client_secret field to be present, so it's accepted here as
 * non-sensitive configuration, not as something requiring the token-exchange relay in 13.4.
 */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret?: string;
  scopes: string[];
}

export interface GoogleAuthorizationResult {
  tokens: StoredTokens;
  emailAddress: string;
  /** The Google account's profile name, used as the From header's display name (Section 6). */
  displayName?: string;
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Runs the full PKCE flow: starts a short-lived loopback HTTP listener, hands the caller a URL
 * to open in the system browser, and resolves once Google redirects back with an authorization
 * code. `openUrl` is injected so this module has no UI/shell dependency of its own — the
 * Electron main process (Section 1.3) is what actually opens the system browser.
 */
export function runGoogleOAuthFlow(
  config: GoogleOAuthConfig,
  openUrl: (url: string) => void
): Promise<GoogleAuthorizationResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeFor(codeVerifier);

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? "", "http://127.0.0.1");
          if (url.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }

          const error = url.searchParams.get("error");
          const code = url.searchParams.get("code");

          if (error) {
            res.end("Authorization failed. You can close this window and return to Outboundly.");
            server.close();
            reject(new Error(`Google OAuth error: ${error}`));
            return;
          }
          if (!code) {
            res.writeHead(400).end("Missing authorization code.");
            return;
          }

          const { port } = server.address() as AddressInfo;
          const redirectUri = `http://127.0.0.1:${port}/callback`;
          const client = new OAuth2Client({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri
          });

          const { tokens } = await client.getToken({ code, codeVerifier });
          res.end("Authorization complete. You can close this window and return to Outboundly.");
          server.close();

          if (!tokens.access_token || !tokens.refresh_token) {
            reject(new Error("Google did not return the expected access/refresh tokens"));
            return;
          }

          client.setCredentials(tokens);
          const userinfo = await client.request<{ email: string; name?: string }>({
            url: "https://www.googleapis.com/oauth2/v3/userinfo"
          });

          resolve({
            tokens: {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000)
            },
            emailAddress: userinfo.data.email,
            displayName: userinfo.data.name
          });
        } catch (err) {
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const client = new OAuth2Client({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri
      });
      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        scope: config.scopes,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        prompt: "consent"
      });
      openUrl(authUrl);
    });
  });
}

/** Google's token endpoint answers a permanently dead refresh token (revoked, expired from
 * disuse, or from an app in "Testing" publishing status hitting its 7-day limit) with HTTP 400 and
 * body `{ error: "invalid_grant", ... }` -- this is the one error shape that unambiguously means
 * "only a fresh sign-in fixes this," distinct from a transient network error or one of Google's own
 * 5xx/429s, which carry a different (or no) response body and must not be treated the same way. */
function isInvalidGrantError(err: unknown): boolean {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === "string" && data.error === "invalid_grant";
}

/** Refreshes an access token using the stored refresh token (Section 13.3). */
export async function refreshGoogleAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string
): Promise<StoredTokens> {
  const client = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret });
  client.setCredentials({ refresh_token: refreshToken });

  let credentials;
  try {
    ({ credentials } = await client.refreshAccessToken());
  } catch (err) {
    if (isInvalidGrantError(err)) {
      throw new AccountReauthRequiredError("Google refresh token is no longer valid -- reconnect required", { cause: err });
    }
    throw err;
  }

  if (!credentials.access_token) throw new Error("Google did not return a refreshed access token");
  return {
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token ?? refreshToken,
    expiresAt: new Date(credentials.expiry_date ?? Date.now() + 3600_000)
  };
}
