/**
 * Shared Gemini authentication utilities.
 *
 * Supports traditional API keys, OAuth JSON format, and raw bearer tokens.
 */

/**
 * Parse Gemini API key and return appropriate auth headers.
 *
 * OAuth format: `{"token": "...", "projectId": "..."}`
 * Bearer token: `ya29....`
 *
 * @param apiKey - Either a traditional API key string, OAuth JSON, or raw token
 * @returns Headers object with appropriate authentication
 */
export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  // If it starts with 'ya29.' it's a Google access token
  if (apiKey.startsWith("ya29.")) {
    return {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    };
  }

  // Try parsing as OAuth JSON format
  if (apiKey.startsWith("{")) {
    try {
      const parsed = JSON.parse(apiKey) as { token?: string; projectId?: string };
      if (typeof parsed.token === "string" && parsed.token) {
        return {
          headers: {
            Authorization: `Bearer ${parsed.token}`,
            "Content-Type": "application/json",
          },
        };
      }
    } catch {
      // Parse failed, fallback to API key mode
    }
  }

  // Default: traditional API key
  return {
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
  };
}
