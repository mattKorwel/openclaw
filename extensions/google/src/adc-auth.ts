import { GoogleAuth } from "google-auth-library";
import { fetchWithTimeout } from "openclaw/plugin-sdk/provider-http";

export const GCP_METADATA_API_KEY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/gemini-api-key";

let cachedMetadataApiKey: string | null | undefined = undefined;

/**
 * Resolves an ADC token.
 * This is async but can be called from prepareRuntimeAuth.
 */
export async function resolveGoogleAdcToken(): Promise<string | null> {
  try {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    return (typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token) ?? null;
  } catch {
    // Not on GCP or no ADC configured
    return null;
  }
}

/**
 * Resolves the Gemini API Key from GCP Metadata (Managed OpenClaw).
 */
export async function resolveGoogleMetadataApiKey(): Promise<string | null> {
  if (cachedMetadataApiKey !== undefined) {
    return cachedMetadataApiKey;
  }

  try {
    const response = await fetchWithTimeout(
      GCP_METADATA_API_KEY_URL,
      { headers: { "Metadata-Flavor": "Google" } },
      2000,
    );
    if (response.ok) {
      const key = (await response.text()).trim();
      cachedMetadataApiKey = key || null;
      return cachedMetadataApiKey;
    }
  } catch {
    // Not on Managed OpenClaw or metadata server unreachable
  }
  cachedMetadataApiKey = null;
  return null;
}

export const __testing = {
  resetCache: () => {
    cachedMetadataApiKey = undefined;
  },
};
