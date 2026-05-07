import util from "node:util";
import { PubSub, type Message, type Subscription } from "@google-cloud/pubsub";
import { GoogleAuth } from "google-auth-library";
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

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Watchdog tunables. The subscriber loop reconnects on any fatal subscription
 * error (e.g. UNAUTHENTICATED=16 from token expiry, UNAVAILABLE=14 from
 * transient gRPC issues) using exponential backoff, capped at MAX_BACKOFF_MS.
 * Successful runs reset the backoff to BASE_BACKOFF_MS.
 */
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

interface MonitorParams {
  account: ResolvedGoogleChatAccount;
  core: GoogleChatCoreRuntime;
  runtime: GoogleChatRuntimeEnv;
  config: OpenClawConfig;
  statusSink?: GoogleChatMonitorOptions["statusSink"];
  mediaMaxMb: number;
  abortSignal?: AbortSignal;
}

export async function monitorGoogleChatPubSub(params: MonitorParams) {
  const { account, runtime } = params;
  const projectId = account.config.pubsub?.projectId;
  const subscriptionName = account.config.pubsub?.subscriptionId;

  if (!projectId || !subscriptionName) {
    runtime.error?.(
      `[${account.accountId}] Pub/Sub monitor requires pubsub.projectId and pubsub.subscriptionId config.`,
    );
    return;
  }

  // Run the subscriber in a self-healing loop. If the underlying gRPC
  // streaming pull dies (auth expiry, transient gRPC errors, etc.) we tear
  // down the subscription and re-create it from scratch — including a fresh
  // AuthClient — instead of leaving the process silently deaf.
  //
  // We intentionally do NOT block the caller on the loop; the original
  // contract was fire-and-forget after first listener registration.
  void runSubscriberLoop(params, projectId, subscriptionName);
}

async function runSubscriberLoop(
  params: MonitorParams,
  projectId: string,
  subscriptionName: string,
): Promise<void> {
  const { account, core, runtime, abortSignal } = params;
  let attempt = 0;
  let firstStart = true;

  // abortSignal flips during the loop body via the abort listener wired up in
  // waitForFatal/sleep; eslint's loop-condition rule doesn't see that signal
  // mutation through the AbortSignal API.
  // eslint-disable-next-line no-unmodified-loop-condition
  while (!abortSignal?.aborted) {
    let subscription: Subscription | undefined;
    let pubsub: PubSub | undefined;
    let onAbort: (() => void) | undefined;
    try {
      ({ pubsub, subscription } = await openSubscription(params, projectId, subscriptionName));

      // Reset backoff on a successful open.
      attempt = 0;

      if (firstStart) {
        firstStart = false;
        logVerbose(core, runtime, `Pub/Sub listener active on ${subscriptionName}`);
      } else {
        runtime.log?.(
          `[${account.accountId}] Pub/Sub listener re-established on ${subscriptionName}`,
        );
      }

      // Wait for either a fatal subscription error or shutdown.
      const fatalError = await waitForFatal(subscription, abortSignal, (cb) => {
        onAbort = cb;
      });

      if (fatalError) {
        runtime.error?.(
          `[${account.accountId}] Pub/Sub subscription error: ${util.inspect(fatalError)}`,
        );
      }
    } catch (err) {
      runtime.error?.(
        `[${account.accountId}] Pub/Sub subscriber setup failed: ${util.inspect(err)}`,
      );
    } finally {
      if (onAbort && abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      if (subscription) {
        try {
          await subscription.close();
        } catch (closeErr) {
          logVerbose(
            core,
            runtime,
            `[${account.accountId}] Error closing subscription during recreate: ${util.inspect(closeErr)}`,
          );
        }
      }
      if (pubsub) {
        try {
          await pubsub.close();
        } catch {
          // best-effort; pubsub.close() may throw if already closed
        }
      }
    }

    if (abortSignal?.aborted) {
      break;
    }

    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    attempt = Math.min(attempt + 1, 10); // cap exponent so we don't overflow
    runtime.log?.(`[${account.accountId}] recreating Pub/Sub subscriber in ${delay}ms`);
    await sleep(delay, abortSignal);
  }

  logVerbose(core, runtime, `Pub/Sub subscriber loop exiting for ${subscriptionName}`);
}

async function openSubscription(
  params: MonitorParams,
  projectId: string,
  subscriptionName: string,
): Promise<{ pubsub: PubSub; subscription: Subscription }> {
  const { account, core, runtime, config, mediaMaxMb } = params;

  // Two auth paths, picked by config:
  //
  //   (a) clientEmail set → cross-project impersonation. We must inject our
  //       Impersonated AuthClient because pubsub's bundled ADC (its own
  //       nested google-auth-library v9.x) cannot perform impersonation.
  //
  //   (b) clientEmail unset → plain ADC. Defer to pubsub's bundled
  //       google-auth-library v9.x; it'll resolve credentials from the GCE
  //       metadata server and refresh them on its own. We deliberately do
  //       NOT inject our root v10 client here because the major-version
  //       mismatch between root v10 and pubsub-bundled v9 means gax can't
  //       successfully consume our wrapper (request goes out unauthenticated
  //       and the server returns code: 7 / PERMISSION_DENIED "unregistered
  //       callers").
  //
  // Historical note: a previous version snapshotted a single access token at
  // startup via a hand-rolled "auth god object" shim. That made the streaming
  // pull die with code: 16 / UNAUTHENTICATED ~1hr after start when the token
  // expired and was never refreshed. Do not reintroduce that pattern.
  const needsImpersonation = !!account.config.clientEmail;

  let pubsub: PubSub;
  if (needsImpersonation) {
    const authClient = await getGoogleAuthClient(account, [CLOUD_PLATFORM_SCOPE]);
    const auth = new GoogleAuth({
      authClient,
      projectId,
      scopes: [CLOUD_PLATFORM_SCOPE],
    });
    pubsub = new PubSub({
      projectId,
      // Cast: pubsub bundles its own (older) google-auth-library; its
      // ClientConfig.auth references that nested GoogleAuth class which is
      // nominally distinct from our root v10 class. Structurally compatible
      // at runtime for the impersonation flow.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      auth: auth as any,
    });
  } else {
    pubsub = new PubSub({ projectId });
  }

  logVerbose(core, runtime, `Pub/Sub client initialized for project: ${projectId}`);

  const subscription = pubsub.subscription(subscriptionName);
  const [exists] = await subscription.exists();
  if (!exists) {
    throw new Error(`Subscription ${subscriptionName} does not exist in project ${projectId}`);
  }
  logVerbose(core, runtime, `Subscription ${subscriptionName} verified.`);

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

  return { pubsub, subscription };
}

/**
 * Resolves when the subscription emits a fatal error (returning that error)
 * or when the abortSignal fires (returning undefined). Either way, the caller
 * is responsible for closing the subscription.
 */
function waitForFatal(
  subscription: Subscription,
  abortSignal: AbortSignal | undefined,
  registerOnAbort: (cb: () => void) => void,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      subscription.removeListener("error", onError);
      subscription.removeListener("close", onClose);
      resolve(value);
    };
    const onError = (err: unknown) => settle(err);
    const onClose = () => settle(undefined);
    subscription.on("error", onError);
    subscription.on("close", onClose);
    if (abortSignal) {
      const onAbort = () => settle(undefined);
      registerOnAbort(onAbort);
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (abortSignal) {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
