import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import {
  createWebhookInFlightLimiter,
  registerWebhookTargetWithPluginRoute,
  resolveWebhookPath,
} from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { type GoogleChatAudienceType } from "./auth.js";
import { isSenderAllowed } from "./monitor-access.js";
import { processMessageWithPipeline, computeGoogleChatMediaMaxMb } from "./monitor-shared.js";
import type {
  GoogleChatMonitorOptions,
  GoogleChatRuntimeEnv,
  WebhookTarget,
} from "./monitor-types.js";
import { createGoogleChatWebhookRequestHandler } from "./monitor-webhook.js";
import { getGoogleChatRuntime } from "./runtime.js";

export type { GoogleChatMonitorOptions, GoogleChatRuntimeEnv } from "./monitor-types.js";
export { isSenderAllowed };

const webhookTargets = new Map<string, WebhookTarget[]>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const googleChatWebhookRequestHandler = createGoogleChatWebhookRequestHandler({
  webhookTargets,
  webhookInFlightLimiter,
  processEvent: async (event, target) => {
    await processMessageWithPipeline({
      event,
      account: target.account,
      config: target.config,
      runtime: target.runtime,
      core: target.core,
      statusSink: target.statusSink,
      mediaMaxMb: target.mediaMaxMb,
    });
  },
});

export function registerGoogleChatWebhookTarget(target: WebhookTarget): () => void {
  return registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "googlechat",
      source: "googlechat-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleGoogleChatWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  }).unregister;
}

function normalizeAudienceType(value?: string | null): GoogleChatAudienceType | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "app-url" || normalized === "app_url" || normalized === "app") {
    return "app-url";
  }
  if (
    normalized === "project-number" ||
    normalized === "project_number" ||
    normalized === "project"
  ) {
    return "project-number";
  }
  return undefined;
}

export async function handleGoogleChatWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  return await googleChatWebhookRequestHandler(req, res);
}

export function monitorGoogleChatProvider(options: GoogleChatMonitorOptions): () => void {
  const core = getGoogleChatRuntime();

  const ingestionMode = options.account.config.ingestionMode ?? "webhook";

  if (ingestionMode === "pubsub") {
    const abortController = new AbortController();
    const abortSignal = options.abortSignal ?? abortController.signal;

    // We'll implement this in Task 3
    void import("./monitor-pubsub.js").then((mod) => {
      mod
        .monitorGoogleChatPubSub({
          account: options.account,
          config: options.config,
          runtime: options.runtime,
          core,
          statusSink: options.statusSink,
          mediaMaxMb: computeGoogleChatMediaMaxMb({ account: options.account }),
          abortSignal,
        })
        .catch((err) => {
          options.runtime.error?.(
            `[${options.account.accountId}] Pub/Sub monitor failed: ${String(err)}`,
          );
        });
    });

    return () => {
      abortController.abort();
    };
  }

  const webhookPath = resolveWebhookPath({
    webhookPath: options.webhookPath,
    webhookUrl: options.webhookUrl,
    defaultPath: "/googlechat",
  });
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return () => {};
  }

  const audienceType = normalizeAudienceType(options.account.config.audienceType);
  const audience = options.account.config.audience?.trim();
  const mediaMaxMb = computeGoogleChatMediaMaxMb({ account: options.account });

  const unregisterTarget = registerGoogleChatWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    audienceType,
    audience,
    statusSink: options.statusSink,
    mediaMaxMb,
  });

  return () => {
    unregisterTarget();
  };
}

export async function startGoogleChatMonitor(
  params: GoogleChatMonitorOptions,
): Promise<() => void> {
  return monitorGoogleChatProvider(params);
}

export function resolveGoogleChatWebhookPath(params: {
  account: ResolvedGoogleChatAccount;
}): string {
  return (
    resolveWebhookPath({
      webhookPath: params.account.config.webhookPath,
      webhookUrl: params.account.config.webhookUrl,
      defaultPath: "/googlechat",
    }) ?? "/googlechat"
  );
}
