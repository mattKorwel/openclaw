import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  GOOGLE_GEMINI_DEFAULT_MODEL,
  applyGoogleGeminiModelDefault,
  normalizeGoogleProviderConfig,
  normalizeGoogleModelId,
  resolveGoogleGenerativeAiTransport,
} from "./api.js";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";
import { resolveGoogleAdcToken, resolveGoogleMetadataApiKey } from "./src/adc-auth.js";

// Match the canonical marker recognized by isNonSecretApiKeyMarker() in
// src/agents/model-auth-markers.ts. The previous value
// ("google:gcp-adc-virtual-key") was treated as a real secret by the auth
// resolver and propagated as a literal ?key= URL parameter to Vertex,
// triggering API_KEY_SERVICE_BLOCKED on corp projects. Mirroring the
// anthropic-vertex provider lets the runtime route through prepareRuntimeAuth
// for ADC bearer-token resolution.
const GOOGLE_VIRTUAL_ADC_KEY = "gcp-vertex-credentials";

export function registerGoogleProvider(api: OpenClawPluginApi) {
  api.registerProvider({
    id: "google",
    label: "Google AI Studio / Vertex AI",
    docsPath: "/providers/models",
    hookAliases: ["google-antigravity", "google-vertex"],
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: "google",
        methodId: "api-key",
        label: "Google Gemini API key",
        hint: "AI Studio / Gemini API key",
        optionKey: "geminiApiKey",
        flagName: "--gemini-api-key",
        envVar: "GEMINI_API_KEY",
        promptMessage: "Enter Gemini API key",
        defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
        expectedProviders: ["google"],
        applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
        wizard: {
          choiceId: "gemini-api-key",
          choiceLabel: "Google Gemini API key",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Gemini API key + OAuth",
        },
      }),
    ],
    resolveSyntheticAuth: () => {
      // Synchronously return a virtual key to signal that we want to handle
      // ADC. The marker is consumed by `prepareRuntimeAuth` below; for AI
      // Studio it gets swapped for a real token, for Vertex it gets swapped
      // for a bracketed placeholder so pi-ai falls into its ADC code path.
      return {
        apiKey: GOOGLE_VIRTUAL_ADC_KEY,
        mode: "token",
        source: "gcp-adc",
      };
    },
    prepareRuntimeAuth: async (ctx) => {
      if (ctx.apiKey !== GOOGLE_VIRTUAL_ADC_KEY) {
        return undefined;
      }

      // For Vertex AI (api === "google-vertex"), the underlying transport
      // (pi-ai's streamGoogleVertex via @google/genai) does its own ADC
      // bootstrap from GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION + ambient
      // ADC. If we hand it a real bearer token, it (incorrectly) treats the
      // value as a Vertex API key and forwards it as ?key=, which Vertex
      // rejects with API_KEY_SERVICE_BLOCKED / CREDENTIALS_MISSING. Instead,
      // return a bracketed placeholder so pi-ai's isPlaceholderApiKey
      // (regex /^<[^>]+>$/) returns true and the transport falls into the
      // ADC code path. The runtime SA on the host must be able to mint ADC
      // tokens for the configured project, and GOOGLE_CLOUD_PROJECT +
      // GOOGLE_CLOUD_LOCATION must be set in the process env.
      const modelApi = (ctx?.model as { api?: string } | undefined)?.api;
      if (modelApi === "google-vertex") {
        return { apiKey: "<gcp-vertex-adc>" };
      }

      // AI Studio path (api === "google-generative-ai"): fetch a real key
      // or ADC bearer and return it for the standard ?key= /
      // Authorization: Bearer flow.
      const metadataApiKey = await resolveGoogleMetadataApiKey();
      if (metadataApiKey) {
        return { apiKey: metadataApiKey };
      }

      const token = await resolveGoogleAdcToken();
      if (token) {
        return { apiKey: token };
      }

      throw new Error("GCP ADC authentication failed: No metadata API key or ADC token found.");
    },
    normalizeTransport: ({ api, baseUrl }) => resolveGoogleGenerativeAiTransport({ api, baseUrl }),
    normalizeConfig: ({ provider, providerConfig }) =>
      normalizeGoogleProviderConfig(provider, providerConfig),
    normalizeModelId: ({ modelId }) => normalizeGoogleModelId(modelId),
    resolveDynamicModel: (ctx) =>
      resolveGoogleGeminiForwardCompatModel({
        providerId: ctx.provider,
        ctx,
      }),
    ...GOOGLE_GEMINI_PROVIDER_HOOKS,
    isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
  });
}
