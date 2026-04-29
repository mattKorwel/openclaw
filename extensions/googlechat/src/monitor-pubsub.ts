import util from "node:util";
import { PubSub, type Message } from "@google-cloud/pubsub";
import type { OpenClawConfig } from "../runtime-api.js";
import { type ResolvedGoogleChatAccount } from "./accounts.js";
import { processMessageWithPipeline, logVerbose } from "./monitor-shared.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

export async function monitorGoogleChatPubSub(params: {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  mediaMaxMb: number;
  abortSignal: AbortSignal;
}): Promise<void> {
  const { account, config, runtime, core, statusSink, mediaMaxMb, abortSignal } = params;

  const projectId = account.config.pubsub?.projectId || (process.env.GCHAT_PROJECT as string);
  const subscriptionName =
    account.config.pubsub?.subscriptionId || (process.env.GCHAT_SUB as string);

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

  // Test connection/existence
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
        await processMessageWithPipeline({
          event,
          account,
          config,
          runtime,
          core,
          statusSink,
          mediaMaxMb,
        });
      }

      message.ack();
      statusSink?.({ lastInboundAt: Date.now() });
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
    abortSignal.addEventListener(
      "abort",
      () => {
        logVerbose(core, runtime, `Pub/Sub monitor aborting...`);
        subscription.removeListener("message", messageHandler);
        subscription.removeListener("error", errorHandler);
        subscription.close().catch(() => {});
        resolve();
      },
      { once: true },
    );

    if (abortSignal.aborted) {
      resolve();
    }
  });
}
