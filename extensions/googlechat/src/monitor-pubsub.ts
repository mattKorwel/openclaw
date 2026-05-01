import fs from "node:fs";
import util from "node:util";
import { PubSub, type Message } from "@google-cloud/pubsub";
import type { OpenClawConfig } from "../runtime-api.js";
import { type ResolvedGoogleChatAccount } from "./accounts.js";
import { getGoogleAuthClient } from "./auth.js";
import { processMessageWithPipeline, logVerbose } from "./monitor-shared.js";
import {
  type GoogleChatCoreRuntime,
  type GoogleChatRuntimeEnv,
  type GoogleChatMonitorOptions,
} from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

export async function monitorGoogleChatPubSub(params: {
  account: ResolvedGoogleChatAccount;
  core: GoogleChatCoreRuntime;
  runtime: GoogleChatRuntimeEnv;
  config: OpenClawConfig;
  statusSink?: GoogleChatMonitorOptions["statusSink"];
  mediaMaxMb: number;
  abortSignal?: AbortSignal;
}) {
  const { account, core, runtime, config, mediaMaxMb, abortSignal } = params;
  const projectId = account.config.pubsub?.projectId;
  const subscriptionName = account.config.pubsub?.subscriptionId;

  if (!projectId || !subscriptionName) {
    runtime.error?.(
      `[${account.accountId}] Pub/Sub monitor requires pubsub.projectId and pubsub.subscriptionId config.`,
    );
    return;
  }

  const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
  let pubsub: PubSub;
  try {
    const impersonated = await getGoogleAuthClient(account, [CLOUD_PLATFORM_SCOPE]);
    const tokenResponse = await impersonated.getAccessToken();
    const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;

    if (!token) {
      throw new Error("Failed to fetch impersonated access token for Pub/Sub");
    }

    // EXACT MIRROR of Method 5 from diagnostic script.
    // We bypass gRPC internals with a compatible auth object.
    const authGodObject = {
      getUniverseDomain: () => "googleapis.com",
      getAccessToken: async () => ({ token }),
      getRequestHeaders: async () => {
        const h = { Authorization: `Bearer ${token}` };
        Object.defineProperty(h, 'forEach', {
          value: (cb: any) => { for (const [k, v] of Object.entries(h)) cb(v, k, h); },
          enumerable: false
        });
        return h;
      },
      getClient: async () => authGodObject,
    };

    const options = {
      projectId,
      auth: authGodObject,
    };

    // @ts-expect-error - Intentional bypass of gRPC internal type mismatch
    pubsub = new PubSub(options);
    logVerbose(core, runtime, `Pub/Sub client initialized for project: ${projectId || "default"}`);
  } catch (err) {
    runtime.error?.(
      `[${account.accountId}] Failed to initialize Pub/Sub client: ${util.inspect(err)}`,
    );
    return;
  }

  try {
    const subscription = pubsub.subscription(subscriptionName);
    const [exists] = await subscription.exists();
    if (!exists) {
      throw new Error(`Subscription ${subscriptionName} does not exist in project ${projectId}`);
    }
    logVerbose(core, runtime, `Subscription ${subscriptionName} verified.`);
  } catch (err) {
    const detailedError = util.inspect(err, { depth: 10, colors: false });
    runtime.error?.(`[${account.accountId}] Failed to verify Pub/Sub subscription: ${String(err)}`);
    // Write detailed error to a file because logs are truncating/masking it
    fs.writeFileSync("/tmp/openclaw-pubsub-error.txt", detailedError);
    return;
  }

  const subscription = pubsub.subscription(subscriptionName);

  subscription.on("message", (message: Message) => {
    logVerbose(core, runtime, `Received message: ${message.id}`);

    try {
      const data = JSON.parse(message.data.toString()) as GoogleChatEvent;
      if (data.type !== "MESSAGE") {
        message.ack();
        return;
      }

      processMessageWithPipeline({
        account,
        event: data,
        core,
        runtime,
        config,
        statusSink: params.statusSink,
        mediaMaxMb,
      })
        .then(() => {
          message.ack();
        })
        .catch((err) => {
          runtime.error?.(`[${account.accountId}] Pipeline error: ${util.inspect(err)}`);
          message.nack();
        });
    } catch (err) {
      runtime.error?.(
        `[${account.accountId}] Error processing Pub/Sub message: ${util.inspect(err)}`,
      );
      message.ack(); // Ack bad messages to avoid infinite retry loops
    }
  });

  subscription.on("error", (err) => {
    runtime.error?.(`[${account.accountId}] Pub/Sub subscription error: ${util.inspect(err)}`);
  });

  logVerbose(core, runtime, `Pub/Sub listener active on ${subscriptionName}`);

  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      void subscription.close();
    });
  }
}
