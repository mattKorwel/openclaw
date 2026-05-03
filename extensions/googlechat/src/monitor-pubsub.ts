import util from "node:util";
import { PubSub, type Message } from "@google-cloud/pubsub";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

function logVerbose(core: GoogleChatCoreRuntime, runtime: GoogleChatRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[googlechat] ${message}`);
  }
}

function resolvePubSubProjectId(account: ResolvedGoogleChatAccount): string | undefined {
  return (
    normalizeOptionalString(account.config.pubsub?.projectId) ??
    normalizeOptionalString(process.env.GCHAT_PROJECT)
  );
}

function resolvePubSubSubscriptionId(account: ResolvedGoogleChatAccount): string | undefined {
  return (
    normalizeOptionalString(account.config.pubsub?.subscriptionId) ??
    normalizeOptionalString(process.env.GCHAT_SUB)
  );
}

export async function monitorGoogleChatPubSub(params: {
  account: ResolvedGoogleChatAccount;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  abortSignal: AbortSignal;
  processEvent: (event: GoogleChatEvent) => Promise<void>;
}): Promise<void> {
  const { account, runtime, core, abortSignal, processEvent } = params;
  const projectId = resolvePubSubProjectId(account);
  const subscriptionName = resolvePubSubSubscriptionId(account);

  if (!subscriptionName) {
    runtime.error?.(
      `[${account.accountId}] Pub/Sub subscription name is missing (config.pubsub.subscriptionId or GCHAT_SUB)`,
    );
    return;
  }

  let pubsub: PubSub;
  try {
    pubsub = new PubSub({ projectId });
    logVerbose(core, runtime, `Pub/Sub client initialized for project: ${projectId || "default"}`);
  } catch (err) {
    runtime.error?.(
      `[${account.accountId}] Failed to initialize Pub/Sub client: ${util.inspect(err)}`,
    );
    return;
  }

  const subscription = pubsub.subscription(subscriptionName);
  logVerbose(core, runtime, `Accessing subscription: ${subscriptionName}`);

  try {
    const [exists] = await subscription.exists();
    if (!exists) {
      runtime.error?.(
        `[${account.accountId}] Pub/Sub subscription does not exist: ${subscriptionName}`,
      );
      return;
    }
    logVerbose(core, runtime, `Subscription ${subscriptionName} verified.`);
  } catch (err) {
    runtime.error?.(
      `[${account.accountId}] Failed to verify Pub/Sub subscription: ${util.inspect(err)}`,
    );
    return;
  }

  const messageHandler = async (message: Message) => {
    logVerbose(core, runtime, `Pub/Sub message received: ${message.id}`);
    try {
      const event = JSON.parse(message.data.toString()) as GoogleChatEvent;
      const eventType = event.type ?? (event as unknown as { eventType?: string }).eventType;
      if (eventType === "MESSAGE") {
        await processEvent(event);
      }
      message.ack();
    } catch (err) {
      runtime.error?.(
        `[${account.accountId}] Error processing Pub/Sub message: ${util.inspect(err)}`,
      );
      message.ack();
    }
  };

  const errorHandler = (err: unknown) => {
    runtime.error?.(`[${account.accountId}] Pub/Sub subscription error: ${util.inspect(err)}`);
  };

  subscription.on("message", messageHandler);
  subscription.on("error", errorHandler);
  logVerbose(core, runtime, `Pub/Sub listener active on ${subscriptionName}`);

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      logVerbose(core, runtime, "Pub/Sub monitor aborting...");
      subscription.removeListener("message", messageHandler);
      subscription.removeListener("error", errorHandler);
      subscription.close().catch(() => {});
      resolve();
    };
    abortSignal.addEventListener("abort", cleanup, { once: true });
    if (abortSignal.aborted) {
      cleanup();
    }
  });
}
