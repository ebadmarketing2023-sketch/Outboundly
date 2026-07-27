import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { PublicClientApplication } from "@azure/msal-node";
import type { ICachePlugin, TokenCacheContext } from "@azure/msal-node";

/**
 * Microsoft OAuth Architecture (Section 13.2, Microsoft variant): Authorization Code flow with
 * PKCE, loopback redirect — the same shape as the Google flow. Unlike Google, MSAL Node manages
 * its own internal token cache and exposes no raw refresh token (verified against
 * @azure/msal-common's AuthenticationResult, which has no refreshToken field, and its
 * ICachePlugin/TokenCacheContext/ISerializableTokenCache types, which expose only
 * serialize()/deserialize() on an opaque blob). So instead of reading tokens out of the result,
 * this flow captures MSAL's serialized cache via a cache plugin and hands that opaque string to
 * the caller, which stores it in the generic TokenVault under the account's id.
 */

export interface MicrosoftOAuthConfig {
  clientId: string;
  /** Defaults to the multi-tenant + personal-account "common" authority. */
  authority?: string;
  scopes: string[];
}

export interface MicrosoftAuthorizationResult {
  /** MSAL's own serialized token cache — opaque to us, handed to TokenVault unchanged. */
  serializedCache: string;
  emailAddress: string;
  /** The Microsoft account's profile name, used as the From header's display name (Section 6). */
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
 * to open in the system browser, and resolves once Microsoft redirects back with an
 * authorization code. `openUrl` is injected so this module has no UI/shell dependency of its own
 * — the Electron main process is what actually opens the system browser (mirrors
 * runGoogleOAuthFlow's shape in ../google/oauth-flow.ts).
 */
export function runMicrosoftOAuthFlow(
  config: MicrosoftOAuthConfig,
  openUrl: (url: string) => void
): Promise<MicrosoftAuthorizationResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeFor(codeVerifier);

  let capturedCache: string | undefined;
  const cachePlugin: ICachePlugin = {
    beforeCacheAccess: async () => {
      // Nothing persisted yet for this brand-new PublicClientApplication instance — this flow
      // only ever writes a cache, it never needs to load one back in.
    },
    afterCacheAccess: async (context: TokenCacheContext) => {
      if (context.cacheHasChanged) {
        capturedCache = context.tokenCache.serialize();
      }
    }
  };

  const pca = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: config.authority ?? "https://login.microsoftonline.com/common"
    },
    cache: { cachePlugin }
  });

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
            reject(new Error(`Microsoft OAuth error: ${error}`));
            return;
          }
          if (!code) {
            res.writeHead(400).end("Missing authorization code.");
            return;
          }

          const { port } = server.address() as AddressInfo;
          const redirectUri = `http://127.0.0.1:${port}/callback`;

          const result = await pca.acquireTokenByCode({
            scopes: config.scopes,
            redirectUri,
            code,
            codeVerifier
          });

          res.end("Authorization complete. You can close this window and return to Outboundly.");
          server.close();

          if (!result.account || !capturedCache) {
            reject(new Error("Microsoft did not return the expected account/token cache"));
            return;
          }

          resolve({
            serializedCache: capturedCache,
            emailAddress: result.account.username,
            displayName: result.account.name
          });
        } catch (err) {
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });

    server.listen(0, "127.0.0.1", () => {
      void (async () => {
        try {
          const { port } = server.address() as AddressInfo;
          const redirectUri = `http://127.0.0.1:${port}/callback`;
          const authUrl = await pca.getAuthCodeUrl({
            scopes: config.scopes,
            redirectUri,
            codeChallenge,
            codeChallengeMethod: "S256"
          });
          openUrl(authUrl);
        } catch (err) {
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  });
}
