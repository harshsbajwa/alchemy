import * as workers from "@distilled.cloud/cloudflare/workers";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Workers.WorkerSettings" as const;
type TypeId = typeof TypeId;
type SettingsProviderRequirements =
  | CloudflareEnvironment
  | Credentials
  | HttpClient.HttpClient;

export interface WorkerSettingsWorker {
  workerId: string;
  workerName: string;
}

export type PersistentWorkerObservability = NonNullable<
  workers.PatchScriptSettingRequest["observability"]
>;
export type PersistentWorkerTailConsumer = NonNullable<
  workers.PatchScriptSettingRequest["tailConsumers"]
>[number];

export interface WorkerSettingsProps {
  /** Existing Worker script whose persistent settings are managed. */
  worker: string | WorkerSettingsWorker;
  /** Whether Worker invocations are sent to Logpush. */
  logpush: boolean;
  /** Persistent logs and traces settings, independent of code versions. */
  observability: PersistentWorkerObservability;
  /** Complete script tag set. */
  tags?: string[];
  /** Complete tail-consumer set. */
  tailConsumers?: PersistentWorkerTailConsumer[];
}

export interface WorkerSettingsAttributes {
  accountId: string;
  workerId: string;
  workerName: string;
  logpush: boolean;
  observability: PersistentWorkerObservability;
  tags: string[];
  tailConsumers: PersistentWorkerTailConsumer[];
}

export type WorkerSettings = Resource<
  TypeId,
  WorkerSettingsProps,
  WorkerSettingsAttributes,
  never,
  Providers
>;

/**
 * Persistent Worker script settings that are deliberately independent from
 * immutable code versions and traffic deployments.
 *
 * Cloudflare's script-settings endpoint changes Logpush, observability, tags,
 * and tail consumers without uploading code. This resource therefore belongs
 * in a slow-moving foundation stack, while {@link WorkerVersion} and
 * {@link WorkersDeployment} own release artifacts and traffic.
 *
 * Existing settings have no Alchemy ownership marker. A first read reports
 * them as unowned and requires explicit adoption. Removing the resource
 * releases ownership without changing production telemetry configuration.
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 * @section Managing persistent Worker settings
 * @example Enable sampled traces without uploading a Worker version
 * ```typescript
 * yield* Cloudflare.Workers.WorkerSettings("WebSettings", {
 *   worker: "web",
 *   logpush: true,
 *   observability: {
 *     enabled: true,
 *     logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
 *     traces: { enabled: true, headSamplingRate: 0.1 },
 *   },
 *   tags: ["service:tally-web"],
 * });
 * ```
 */
export const WorkerSettings = Resource<WorkerSettings>(TypeId);

export const isWorkerSettings = (value: unknown): value is WorkerSettings =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const WorkerSettingsProvider = () =>
  Provider.succeed<
    WorkerSettings,
    SettingsProviderRequirements,
    never,
    never,
    SettingsProviderRequirements
  >(WorkerSettings, {
    stables: ["accountId", "workerId", "workerName"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      const worker = resolveWorker(news.worker);
      if (!worker) return undefined;
      if (
        output &&
        (output.workerId !== worker.workerId ||
          output.workerName !== worker.workerName)
      ) {
        return { action: "replace" } as const;
      }
      if (
        output &&
        !deepEqual(settingsFromProps(news), settingsFromAttributes(output))
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const worker = output ?? resolveWorker(olds.worker);
      if (!worker) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      const observed = yield* workers
        .getScriptSetting({
          accountId,
          scriptName: worker.workerName,
        })
        .pipe(
          Effect.map((settings) =>
            toAttributes(
              accountId,
              worker.workerId,
              worker.workerName,
              settings,
            ),
          ),
          Effect.catchTags({
            WorkerHasNoVersions: () => Effect.succeed(undefined),
            WorkerNotFound: () => Effect.succeed(undefined),
          }),
        );
      if (!observed) return undefined;
      return output ? observed : Unowned(observed);
    }),

    // Script settings are addressed by Worker name. Cloudflare exposes no
    // account-wide collection of settings objects suitable for generic nuke.
    list: Effect.fn(function* () {
      return [];
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const worker = resolveWorker(news.worker);
      if (!worker) {
        return yield* Effect.die(
          new Error("WorkerSettings requires a resolved Worker name"),
        );
      }
      const { accountId } = yield* yield* CloudflareEnvironment;
      const observed = yield* workers.patchScriptSetting({
        accountId,
        scriptName: worker.workerName,
        ...settingsFromProps(news),
      });
      return toAttributes(
        accountId,
        worker.workerId,
        worker.workerName,
        observed,
      );
    }),

    // Removing Alchemy ownership must not disable production telemetry.
    delete: Effect.fn(function* () {
      return yield* Effect.void;
    }),
  });

const resolveWorker = (
  worker: WorkerSettingsProps["worker"],
): { workerId: string; workerName: string } | undefined => {
  if (typeof worker === "string") {
    return { workerId: worker, workerName: worker };
  }
  const workerId = (worker as { workerId?: unknown }).workerId;
  const workerName = (worker as { workerName?: unknown }).workerName;
  if (typeof workerId !== "string" && typeof workerName !== "string") {
    return undefined;
  }
  return {
    workerId: typeof workerId === "string" ? workerId : (workerName as string),
    workerName:
      typeof workerName === "string" ? workerName : (workerId as string),
  };
};

const settingsFromProps = (props: WorkerSettingsProps) => ({
  logpush: props.logpush,
  observability: props.observability,
  tags: [...(props.tags ?? [])].sort(),
  tailConsumers: [...(props.tailConsumers ?? [])].sort(tailConsumerOrder),
});

const settingsFromAttributes = (attributes: WorkerSettingsAttributes) => ({
  logpush: attributes.logpush,
  observability: attributes.observability,
  tags: [...attributes.tags].sort(),
  tailConsumers: [...attributes.tailConsumers].sort(tailConsumerOrder),
});

const tailConsumerOrder = (
  left: PersistentWorkerTailConsumer,
  right: PersistentWorkerTailConsumer,
) =>
  `${left.service}:${left.environment ?? ""}:${left.namespace ?? ""}`.localeCompare(
    `${right.service}:${right.environment ?? ""}:${right.namespace ?? ""}`,
  );

const toAttributes = (
  accountId: string,
  workerId: string,
  workerName: string,
  settings:
    | workers.GetScriptSettingResponse
    | workers.PatchScriptSettingResponse,
): WorkerSettingsAttributes => ({
  accountId,
  workerId,
  workerName,
  logpush: settings.logpush ?? false,
  observability: normalizeObservability(settings.observability),
  tags: [...(settings.tags ?? [])].sort(),
  tailConsumers: (settings.tailConsumers ?? [])
    .map((consumer) => ({
      service: consumer.service,
      ...(consumer.environment === null || consumer.environment === undefined
        ? {}
        : { environment: consumer.environment }),
      ...(consumer.namespace === null || consumer.namespace === undefined
        ? {}
        : { namespace: consumer.namespace }),
    }))
    .sort(tailConsumerOrder),
});

const normalizeObservability = (
  observed:
    | workers.GetScriptSettingResponse["observability"]
    | workers.PatchScriptSettingResponse["observability"],
): PersistentWorkerObservability => ({
  enabled: observed?.enabled ?? false,
  ...(observed?.headSamplingRate === undefined
    ? {}
    : { headSamplingRate: observed.headSamplingRate }),
  ...(observed?.logs === undefined || observed.logs === null
    ? {}
    : {
        logs: {
          enabled: observed.logs.enabled,
          invocationLogs: observed.logs.invocationLogs,
          ...(observed.logs.destinations === null ||
          observed.logs.destinations === undefined
            ? {}
            : { destinations: observed.logs.destinations }),
          ...(observed.logs.headSamplingRate === undefined
            ? {}
            : { headSamplingRate: observed.logs.headSamplingRate }),
          ...(observed.logs.persist === null ||
          observed.logs.persist === undefined
            ? {}
            : { persist: observed.logs.persist }),
        },
      }),
  ...(observed?.traces === undefined || observed.traces === null
    ? {}
    : {
        traces: {
          ...(observed.traces.destinations === null ||
          observed.traces.destinations === undefined
            ? {}
            : { destinations: observed.traces.destinations }),
          ...(observed.traces.enabled === null ||
          observed.traces.enabled === undefined
            ? {}
            : { enabled: observed.traces.enabled }),
          ...(observed.traces.headSamplingRate === undefined
            ? {}
            : { headSamplingRate: observed.traces.headSamplingRate }),
          ...(observed.traces.persist === null ||
          observed.traces.persist === undefined
            ? {}
            : { persist: observed.traces.persist }),
          ...(observed.traces.propagationPolicy === null ||
          observed.traces.propagationPolicy === undefined
            ? {}
            : { propagationPolicy: observed.traces.propagationPolicy }),
        },
      }),
});
