import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Workers.WorkersDeployment" as const;
type TypeId = typeof TypeId;

export interface WorkersDeploymentWorker {
  workerId: string;
  workerName: string;
}

export interface WorkersDeploymentVersionReference {
  versionId: string;
}

export interface WorkersDeploymentVersion {
  version: string | WorkersDeploymentVersionReference;
  percentage: number;
}

export interface WorkersDeploymentProps {
  /** Persistent Worker shell whose active traffic deployment is reconciled. */
  worker: string | WorkersDeploymentWorker;
  /**
   * Exact desired traffic state. Cloudflare supports one or two active
   * versions; percentages must sum to 100 and may include a zero-percent
   * version for candidate verification through version overrides.
   */
  versions: WorkersDeploymentVersion[];
  /** Human-readable Cloudflare deployment annotation. */
  message?: string;
  /**
   * Known current traffic state used only for first adoption or state
   * recovery. Alchemy refuses to mutate an unknown live baseline.
   */
  baseline?: WorkersDeploymentVersion[];
  /**
   * Select a particular deployment during recovery. When omitted, the active
   * (latest) deployment is observed.
   */
  adoptDeploymentId?: string;
  /**
   * Allow Cloudflare to roll back across a version whose secrets changed.
   * This should normally remain false and be enabled only by explicit policy.
   */
  force?: boolean;
}

export interface WorkersDeploymentVersionAttributes {
  versionId: string;
  percentage: number;
}

export interface WorkersDeploymentAttributes {
  accountId: string;
  workerId: string;
  workerName: string;
  deploymentId: string;
  versions: WorkersDeploymentVersionAttributes[];
  /** Traffic state observed before this logical deployment first reconciled. */
  initialVersions: WorkersDeploymentVersionAttributes[];
  createdOn: string | undefined;
  source: string | undefined;
  authorEmail: string | undefined;
  message: string | undefined;
}

export type WorkersDeployment = Resource<
  TypeId,
  WorkersDeploymentProps,
  WorkersDeploymentAttributes,
  never,
  Providers
>;

/**
 * A mutable Cloudflare Worker traffic deployment.
 *
 * This resource changes percentages only. It never uploads code and it never
 * creates another immutable version, so the same candidate can move through
 * zero, canary, full, and rollback phases without rebuilding.
 *
 * Removing the resource releases ownership without changing traffic. Rollback
 * is represented by reconciling this same resource to the preceding version
 * at 100 percent.
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 * @section Gradual Worker deployments
 * @example Promote one candidate version to five percent
 * ```typescript
 * yield* Cloudflare.Workers.WorkersDeployment("WebTraffic", {
 *   worker: webWorker,
 *   baseline: [{ version: stableVersionId, percentage: 100 }],
 *   versions: [
 *     { version: stableVersionId, percentage: 95 },
 *     { version: candidate, percentage: 5 },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/
 */
export const WorkersDeployment = Resource<WorkersDeployment>(TypeId);

export const isWorkersDeployment = (
  value: unknown,
): value is WorkersDeployment =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export class WorkersDeploymentConfigError extends Data.TaggedError(
  "WorkersDeploymentConfigError",
)<{
  message: string;
}> {}

type ObservedDeployment =
  workers.ListScriptDeploymentsResponse["deployments"][number];

const resolveWorker = (
  worker: WorkersDeploymentProps["worker"],
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

const resolveVersion = (
  version: WorkersDeploymentVersion["version"],
): string | undefined => {
  if (typeof version === "string") return version;
  const versionId = (version as { versionId?: unknown }).versionId;
  return typeof versionId === "string" ? versionId : undefined;
};

export const canonicalWorkersDeploymentVersions = Effect.fn(function* (
  versions: WorkersDeploymentVersion[],
) {
  if (versions.length < 1 || versions.length > 2) {
    return yield* new WorkersDeploymentConfigError({
      message: `Worker deployments require one or two versions; received ${versions.length}.`,
    });
  }
  const resolved: WorkersDeploymentVersionAttributes[] = [];
  for (const item of versions) {
    const versionId = resolveVersion(item.version);
    if (!versionId) {
      return yield* new WorkersDeploymentConfigError({
        message: "A deployment version did not resolve to a versionId.",
      });
    }
    if (
      !Number.isFinite(item.percentage) ||
      item.percentage < 0 ||
      item.percentage > 100
    ) {
      return yield* new WorkersDeploymentConfigError({
        message: `Traffic percentage for version '${versionId}' must be between 0 and 100; received ${item.percentage}.`,
      });
    }
    resolved.push({ versionId, percentage: item.percentage });
  }
  if (
    new Set(resolved.map((item) => item.versionId)).size !== resolved.length
  ) {
    return yield* new WorkersDeploymentConfigError({
      message: "A Worker deployment cannot contain the same version twice.",
    });
  }
  const total = resolved.reduce((sum, item) => sum + item.percentage, 0);
  if (Math.abs(total - 100) > Number.EPSILON * 100) {
    return yield* new WorkersDeploymentConfigError({
      message: `Worker deployment percentages must sum to 100; received ${total}.`,
    });
  }
  return resolved.sort((left, right) =>
    left.versionId.localeCompare(right.versionId),
  );
});

const canonicalObserved = (
  versions: ObservedDeployment["versions"],
): WorkersDeploymentVersionAttributes[] =>
  versions
    .map(({ versionId, percentage }) => ({ versionId, percentage }))
    .sort((left, right) => left.versionId.localeCompare(right.versionId));

const versionsEqual = (
  left: WorkersDeploymentVersionAttributes[],
  right: WorkersDeploymentVersionAttributes[],
): boolean =>
  left.length === right.length &&
  left.every(
    (version, index) =>
      version.versionId === right[index]?.versionId &&
      version.percentage === right[index]?.percentage,
  );

const latestDeployment = Effect.fn(function* (
  accountId: string,
  workerName: string,
) {
  return yield* workers
    .listScriptDeployments({ accountId, scriptName: workerName })
    .pipe(
      Effect.map((response) => response.deployments[0]),
      Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
    );
});

const deploymentById = Effect.fn(function* (
  accountId: string,
  workerName: string,
  deploymentId: string,
) {
  return yield* workers
    .getScriptDeployment({
      accountId,
      scriptName: workerName,
      deploymentId,
    })
    .pipe(
      Effect.map(
        (deployment): ObservedDeployment => ({
          id: deployment.id,
          createdOn: deployment.createdOn ?? "",
          source: deployment.source ?? "",
          strategy: "percentage",
          versions: deployment.versions ?? [],
          annotations: deployment.annotations,
          authorEmail: deployment.authorEmail,
        }),
      ),
      Effect.catchTags({
        WorkerNotFound: () => Effect.succeed(undefined),
        DeploymentNotFound: () => Effect.succeed(undefined),
      }),
    );
});

const toAttributes = (
  deployment: ObservedDeployment,
  accountId: string,
  worker: { workerId: string; workerName: string },
  initialVersions: WorkersDeploymentVersionAttributes[],
): WorkersDeploymentAttributes => ({
  accountId,
  workerId: worker.workerId,
  workerName: worker.workerName,
  deploymentId: deployment.id,
  versions: canonicalObserved(deployment.versions),
  initialVersions,
  createdOn: deployment.createdOn || undefined,
  source: deployment.source || undefined,
  authorEmail: deployment.authorEmail ?? undefined,
  message: deployment.annotations?.workersMessage ?? undefined,
});

export const WorkersDeploymentProvider = () =>
  Provider.succeed(WorkersDeployment, {
    nuke: { skip: true },
    stables: ["accountId", "workerId", "workerName", "initialVersions"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return;
      const worker = resolveWorker(news.worker);
      if (output && worker && output.workerId !== worker.workerId) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const worker = resolveWorker(olds.worker);
      if (!worker) return undefined;

      if (output) {
        const observed = yield* latestDeployment(accountId, worker.workerName);
        return observed
          ? toAttributes(observed, accountId, worker, output.initialVersions)
          : undefined;
      }

      // A Worker already has an active deployment after its first upload.
      // Never infer that unknown traffic is safe to replace: recovery needs
      // an explicit baseline and remains gated by normal adoption policy.
      if (!olds.baseline) return undefined;
      const observed = olds.adoptDeploymentId
        ? yield* deploymentById(
            accountId,
            worker.workerName,
            olds.adoptDeploymentId,
          )
        : yield* latestDeployment(accountId, worker.workerName);
      if (!observed) return undefined;
      const expected = yield* canonicalWorkersDeploymentVersions(olds.baseline);
      const actual = canonicalObserved(observed.versions);
      if (!versionsEqual(expected, actual)) {
        return yield* new WorkersDeploymentConfigError({
          message:
            `Refusing to adopt deployment '${observed.id}' for '${worker.workerName}': ` +
            `expected baseline ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}.`,
        });
      }
      return Unowned(toAttributes(observed, accountId, worker, actual));
    }),

    list: Effect.fn(function* () {
      return [];
    }),

    reconcile: Effect.fn(function* ({ news, output, session }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const worker = resolveWorker(news.worker);
      if (!worker) {
        return yield* new WorkersDeploymentConfigError({
          message:
            "worker did not resolve to a Cloudflare Worker ID or script name.",
        });
      }
      const desired = yield* canonicalWorkersDeploymentVersions(news.versions);
      const observed = yield* latestDeployment(accountId, worker.workerName);
      const initialVersions =
        output?.initialVersions ??
        (observed ? canonicalObserved(observed.versions) : []);

      if (
        observed &&
        versionsEqual(canonicalObserved(observed.versions), desired)
      ) {
        return toAttributes(observed, accountId, worker, initialVersions);
      }

      if (!output && observed) {
        if (!news.baseline) {
          return yield* new WorkersDeploymentConfigError({
            message:
              `Refusing to replace unknown live deployment '${observed.id}' for ` +
              `'${worker.workerName}'. Provide the exact baseline and adopt it first.`,
          });
        }
        const expected = yield* canonicalWorkersDeploymentVersions(
          news.baseline,
        );
        const actual = canonicalObserved(observed.versions);
        if (!versionsEqual(expected, actual)) {
          return yield* new WorkersDeploymentConfigError({
            message:
              `Refusing to replace deployment '${observed.id}' for '${worker.workerName}': ` +
              `expected baseline ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}.`,
          });
        }
      }

      yield* session.note(
        `Deploying ${worker.workerName} traffic ${desired
          .map(({ versionId, percentage }) => `${versionId}=${percentage}%`)
          .join(", ")} ...`,
      );
      const created = yield* workers.createScriptDeployment({
        accountId,
        scriptName: worker.workerName,
        force: news.force,
        strategy: "percentage",
        versions: desired,
        annotations: news.message
          ? { workersMessage: news.message }
          : undefined,
      });
      return {
        accountId,
        workerId: worker.workerId,
        workerName: worker.workerName,
        deploymentId: created.id,
        versions: (created.versions
          ? [...created.versions].sort((left, right) =>
              left.versionId.localeCompare(right.versionId),
            )
          : desired) as WorkersDeploymentVersionAttributes[],
        initialVersions,
        createdOn: created.createdOn ?? undefined,
        source: created.source ?? undefined,
        authorEmail: created.authorEmail ?? undefined,
        message:
          created.annotations?.workersMessage ?? news.message ?? undefined,
      };
    }),

    // Removing ownership must not silently change production traffic.
    // Rollback is another desired state of this same resource.
    delete: Effect.fn(function* () {
      return;
    }),
  });
