import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { sha256, sha256Object } from "../../Util/index.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import {
  readAssets,
  uploadAssets,
  type AssetReadResult,
  type AssetsProps,
} from "./Assets.ts";
import type { WorkerCache, WorkerLimits, WorkerPlacement } from "./Worker.ts";

const TypeId = "Cloudflare.Workers.WorkerVersion" as const;
type TypeId = typeof TypeId;

type CreateVersionRequest = workers.CreateBetaWorkerVersionRequest;
type ObservedVersion =
  | workers.GetBetaWorkerVersionResponse
  | workers.CreateBetaWorkerVersionResponse;

/**
 * A native Worker-version binding. The discriminator and binding-specific
 * fields are passed through to Cloudflare after schema validation.
 */
export interface WorkerVersionBinding {
  name: string;
  type: string;
  [field: string]: unknown;
}

export interface WorkerVersionArtifact {
  /**
   * Directory containing the final, already-built Worker modules. Files are
   * uploaded byte-for-byte; Alchemy does not bundle or rewrite this directory.
   */
  directory: string;
  /** Module path, relative to {@link directory}, that exports the Worker. */
  mainModule: string;
  /**
   * Expected digest from the signed build manifest. Alchemy calculates its own
   * digest and rejects the artifact when they differ.
   */
  digest?: string;
}

export interface WorkerVersionAdoption {
  /** Adopt this exact immutable version. */
  versionId?: string;
  /** Adopt the unique version carrying this `workers/tag` annotation. */
  tag?: string;
}

export interface WorkerVersionWorker {
  workerId: string;
  workerName: string;
}

export interface WorkerVersionProps {
  /** Persistent Worker shell that owns this immutable version. */
  worker: string | WorkerVersionWorker;
  /** Final, prebuilt Worker artifact. */
  artifact: WorkerVersionArtifact;
  /** Optional static assets uploaded into the same immutable version. */
  assets?: AssetsProps;
  /** Native Cloudflare bindings included in this immutable version. */
  bindings?: WorkerVersionBinding[];
  /** Secret-text bindings included atomically in this immutable version. */
  secrets?: Record<string, Redacted.Redacted<string>>;
  compatibility?: {
    date?: string;
    flags?: string[];
  };
  cache?: WorkerCache;
  limits?: WorkerLimits;
  placement?: WorkerPlacement;
  annotations?: {
    message?: string;
    tag?: string;
  };
  /**
   * Explicit recovery selector used when Alchemy state was lost. The observed
   * version is reported as unowned, so normal adoption policy still applies.
   */
  adopt?: WorkerVersionAdoption;
}

export interface WorkerVersionAttributes {
  accountId: string;
  workerId: string;
  workerName: string;
  versionId: string;
  number: number;
  urls: string[];
  createdOn: string;
  source: string | undefined;
  annotations:
    | {
        message: string | undefined;
        tag: string | undefined;
        triggeredBy: string | undefined;
      }
    | undefined;
  /** Digest of modules, assets, bindings, compatibility, cache and placement. */
  artifactDigest: string;
  /** Digest of the static-asset manifest, when assets are present. */
  assetManifestHash: string | undefined;
}

export type WorkerVersion = Resource<
  TypeId,
  WorkerVersionProps,
  WorkerVersionAttributes,
  never,
  Providers
>;

/**
 * An immutable Cloudflare Worker version.
 *
 * The resource uploads one prebuilt artifact and never changes traffic. Use
 * {@link WorkersDeployment} to assign traffic to the resulting `versionId`.
 * Destroy releases Alchemy ownership but deliberately does not delete the
 * remote version because Cloudflare controls version retention and a version
 * can remain rollback-eligible after it leaves a stack.
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 * @section Releasing immutable Worker versions
 * @example Upload a signed, prebuilt release without changing traffic
 * ```typescript
 * const version = yield* Cloudflare.Workers.WorkerVersion("WebCandidate", {
 *   worker: webWorker,
 *   artifact: {
 *     directory: "dist/server",
 *     mainModule: "index.js",
 *     digest: releaseManifest.workerDigests.web,
 *   },
 *   assets: { directory: "dist/client" },
 *   compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
 *   annotations: { tag: releaseManifest.release },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/workers/versions-and-deployments/
 */
export const WorkerVersion = Resource<WorkerVersion>(TypeId);

export const isWorkerVersion = (value: unknown): value is WorkerVersion =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export class ImmutableWorkerVersionConfigError extends Data.TaggedError(
  "ImmutableWorkerVersionConfigError",
)<{
  message: string;
}> {}

export interface PreparedWorkerVersion {
  artifactDigest: string;
  assetManifestHash: string | undefined;
  modules: NonNullable<CreateVersionRequest["modules"]>;
  assets: AssetReadResult | undefined;
  bindings: WorkerVersionBinding[];
}

const resolveWorker = (
  worker: WorkerVersionProps["worker"],
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

const moduleContentType = (name: string): string => {
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".map")) return "application/source-map";
  if (name.endsWith(".py")) return "text/x-python";
  if (name.endsWith(".cjs")) return "application/javascript";
  if (name.endsWith(".js") || name.endsWith(".mjs")) {
    return "application/javascript+module";
  }
  if (
    name.endsWith(".txt") ||
    name.endsWith(".html") ||
    name.endsWith(".sql") ||
    name === "_headers" ||
    name === "_redirects"
  ) {
    return "text/plain";
  }
  return "application/octet-stream";
};

export const prepareWorkerVersionArtifact = Effect.fn(function* (
  news: WorkerVersionProps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(news.artifact.directory);
  const entries = yield* fs.readDirectory(root, { recursive: true });
  const modules: NonNullable<CreateVersionRequest["modules"]> = [];
  const moduleDigests: Record<string, string> = {};

  yield* Effect.forEach(
    entries.sort(),
    Effect.fn(function* (entry) {
      const absolute = path.join(root, entry);
      const stat = yield* fs.stat(absolute);
      if (stat.type !== "File") return;
      const name = path.relative(root, absolute).replaceAll("\\", "/");
      const bytes = yield* fs.readFile(absolute);
      moduleDigests[name] = yield* sha256(bytes);
      modules.push({
        name,
        contentType: moduleContentType(name),
        contentBase64: Buffer.from(bytes).toString("base64"),
      });
    }),
  );

  if (!Object.hasOwn(moduleDigests, news.artifact.mainModule)) {
    return yield* new ImmutableWorkerVersionConfigError({
      message: `Worker main module '${news.artifact.mainModule}' was not found under '${news.artifact.directory}'.`,
    });
  }

  const assets = news.assets ? yield* readAssets(news.assets) : undefined;
  if (assets?._headers !== undefined) {
    const bytes = new TextEncoder().encode(assets._headers);
    modules.push({
      name: "_headers",
      contentType: "text/plain",
      contentBase64: Buffer.from(bytes).toString("base64"),
    });
    moduleDigests._headers = yield* sha256(bytes);
  }
  if (assets?._redirects !== undefined) {
    const bytes = new TextEncoder().encode(assets._redirects);
    modules.push({
      name: "_redirects",
      contentType: "text/plain",
      contentBase64: Buffer.from(bytes).toString("base64"),
    });
    moduleDigests._redirects = yield* sha256(bytes);
  }

  const secretBindings: WorkerVersionBinding[] = [];
  const secretDigests: Record<string, string> = {};
  for (const [name, secret] of Object.entries(news.secrets ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const text = Redacted.value(secret);
    secretDigests[name] = yield* sha256(text);
    secretBindings.push({ name, type: "secret_text", text });
  }
  const bindings = [...(news.bindings ?? []), ...secretBindings];
  const artifactDigest = yield* sha256Object({
    modules: moduleDigests,
    assets: assets?.hash,
    bindings: news.bindings ?? [],
    secrets: secretDigests,
    compatibility: news.compatibility,
    cache: news.cache,
    limits: news.limits,
    placement: news.placement,
  });

  if (
    news.artifact.digest !== undefined &&
    news.artifact.digest !== artifactDigest
  ) {
    return yield* new ImmutableWorkerVersionConfigError({
      message:
        `Worker artifact digest mismatch for '${news.artifact.directory}': ` +
        `expected ${news.artifact.digest}, calculated ${artifactDigest}.`,
    });
  }

  return {
    artifactDigest,
    assetManifestHash: assets?.hash,
    modules,
    assets,
    bindings,
  } satisfies PreparedWorkerVersion;
});

const toAttributes = (
  observed: ObservedVersion,
  accountId: string,
  worker: { workerId: string; workerName: string },
  artifactDigest: string,
  assetManifestHash: string | undefined,
): WorkerVersionAttributes => ({
  accountId,
  workerId: worker.workerId,
  workerName: worker.workerName,
  versionId: observed.id,
  number: observed.number,
  urls: observed.urls,
  createdOn: observed.createdOn,
  source: observed.source ?? undefined,
  annotations: observed.annotations
    ? {
        message: observed.annotations.workersMessage ?? undefined,
        tag: observed.annotations.workersTag ?? undefined,
        triggeredBy: observed.annotations.workersTriggeredBy ?? undefined,
      }
    : undefined,
  artifactDigest,
  assetManifestHash,
});

const getVersion = (accountId: string, workerId: string, versionId: string) =>
  workers.getBetaWorkerVersion({ accountId, workerId, versionId }).pipe(
    Effect.map((version) => version as ObservedVersion),
    Effect.catchTags({
      WorkerNotFound: () => Effect.succeed(undefined),
      WorkerVersionNotFound: () => Effect.succeed(undefined),
    }),
  );

export const WorkerVersionProvider = () =>
  Provider.succeed(WorkerVersion, {
    nuke: { skip: true },
    stables: [
      "accountId",
      "workerId",
      "workerName",
      "versionId",
      "createdOn",
      "artifactDigest",
      "assetManifestHash",
    ],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return;
      const worker = resolveWorker(news.worker);
      if (output && worker && output.workerId !== worker.workerId) {
        return { action: "replace" } as const;
      }
      if (!output) return;
      const prepared = yield* prepareWorkerVersionArtifact(news);
      if (prepared.artifactDigest !== output.artifactDigest) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const worker = resolveWorker(olds.worker);
      if (!worker) return undefined;

      if (output?.versionId) {
        const observed = yield* getVersion(
          accountId,
          worker.workerId,
          output.versionId,
        );
        return observed
          ? toAttributes(
              observed,
              accountId,
              worker,
              output.artifactDigest,
              output.assetManifestHash,
            )
          : undefined;
      }

      let observed: ObservedVersion | undefined;
      if (olds.adopt?.versionId) {
        observed = yield* getVersion(
          accountId,
          worker.workerId,
          olds.adopt.versionId,
        );
      } else if (olds.adopt?.tag) {
        const response = yield* workers.listBetaWorkerVersions({
          accountId,
          workerId: worker.workerId,
          perPage: 100,
        });
        const matches = response.result.filter(
          (version) =>
            version.annotations?.workersTag === olds.adopt?.tag &&
            version.id !== undefined,
        );
        if (matches.length > 1) {
          return yield* new ImmutableWorkerVersionConfigError({
            message: `More than one version of '${worker.workerName}' has tag '${olds.adopt.tag}'. Adopt by versionId instead.`,
          });
        }
        observed = matches[0] as ObservedVersion | undefined;
      }
      if (!observed) return undefined;

      const prepared = yield* prepareWorkerVersionArtifact(olds);
      return Unowned(
        toAttributes(
          observed,
          accountId,
          worker,
          prepared.artifactDigest,
          prepared.assetManifestHash,
        ),
      );
    }),

    list: Effect.fn(function* () {
      return [];
    }),

    reconcile: Effect.fn(function* ({ news, output, session }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const worker = resolveWorker(news.worker);
      if (!worker) {
        return yield* new ImmutableWorkerVersionConfigError({
          message:
            "worker did not resolve to a Cloudflare Worker ID or script name.",
        });
      }
      const prepared = yield* prepareWorkerVersionArtifact(news);

      if (
        output?.versionId &&
        output.workerId === worker.workerId &&
        output.artifactDigest === prepared.artifactDigest
      ) {
        const observed = yield* getVersion(
          accountId,
          worker.workerId,
          output.versionId,
        );
        if (observed) {
          return toAttributes(
            observed,
            accountId,
            worker,
            prepared.artifactDigest,
            prepared.assetManifestHash,
          );
        }
      }

      const assetUpload = prepared.assets
        ? yield* uploadAssets(
            accountId,
            worker.workerName,
            prepared.assets,
            session,
          )
        : undefined;
      yield* session.note(
        `Uploading immutable version of ${worker.workerName} ...`,
      );
      const created = yield* workers.createBetaWorkerVersion({
        accountId,
        workerId: worker.workerId,
        deploy: false,
        mainModule: news.artifact.mainModule,
        modules: prepared.modules,
        assets: prepared.assets
          ? {
              jwt: assetUpload?.jwt,
              config: {
                htmlHandling: prepared.assets.config?.htmlHandling,
                notFoundHandling: prepared.assets.config?.notFoundHandling,
                runWorkerFirst: prepared.assets.config?.runWorkerFirst,
              },
            }
          : undefined,
        bindings: prepared.bindings as NonNullable<
          CreateVersionRequest["bindings"]
        >,
        compatibilityDate: news.compatibility?.date,
        compatibilityFlags: news.compatibility?.flags,
        cache: news.cache,
        limits: news.limits,
        placement: news.placement,
        annotations: news.annotations
          ? {
              workersMessage: news.annotations.message,
              workersTag: news.annotations.tag,
            }
          : undefined,
      });
      return toAttributes(
        created,
        accountId,
        worker,
        prepared.artifactDigest,
        prepared.assetManifestHash,
      );
    }),

    // Cloudflare owns immutable-version retention. Releasing Alchemy
    // ownership must never mutate an active deployment or destroy rollback
    // history.
    delete: Effect.fn(function* () {
      return;
    }),
  });
