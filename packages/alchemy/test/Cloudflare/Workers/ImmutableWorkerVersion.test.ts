import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const artifactDirectory =
  "test/Cloudflare/Workers/fixtures/immutable-version/server";
const assetDirectory =
  "test/Cloudflare/Workers/fixtures/immutable-version/client";

const shellScript = (marker: string) =>
  `export default { fetch() { return new Response("${marker}"); } };`;

const latestDeployment = Effect.fn(function* (scriptName: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const response = yield* workers.listScriptDeployments({
    accountId,
    scriptName,
  });
  return response.deployments[0];
});

describe.concurrent("Cloudflare.Workers immutable release resources", () => {
  test.provider(
    "uploads one asset-bearing candidate and reuses it across rollout and rollback",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployPhase = (
          stablePercentage: number,
          candidatePercentage: number,
        ) =>
          stack.deploy(
            Effect.gen(function* () {
              const dependency = yield* Cloudflare.Worker("VersionDependency", {
                script: shellScript("dependency"),
              });
              const shell = yield* Cloudflare.Worker("VersionShell", {
                script: shellScript("stable"),
                observability: {
                  enabled: true,
                  logs: { enabled: true, invocationLogs: true },
                  traces: { enabled: true },
                },
              });
              const candidate = yield* Cloudflare.Workers.WorkerVersion(
                "Candidate",
                {
                  worker: shell,
                  artifact: {
                    directory: artifactDirectory,
                    mainModule: "index.mjs",
                  },
                  assets: {
                    directory: assetDirectory,
                    runWorkerFirst: ["/api/*"],
                  },
                  bindings: [
                    {
                      name: "DEPENDENCY",
                      type: "service",
                      service: dependency.workerName,
                    },
                  ],
                  cache: {
                    enabled: true,
                    crossVersionCache: false,
                  },
                  placement: { mode: "smart" },
                  compatibility: { date: "2026-07-01" },
                  annotations: {
                    message: "Alchemy immutable WorkerVersion live test",
                    tag: "immutable-version-live-test",
                  },
                },
              );
              const deployment = yield* Cloudflare.Workers.WorkersDeployment(
                "Traffic",
                Effect.gen(function* () {
                  const workerName = yield* yield* shell.workerName;
                  const stableVersion = yield* yield* shell.versionId;
                  const candidateVersion = yield* yield* candidate.versionId;
                  if (!stableVersion) {
                    return yield* Effect.die(
                      new Error(
                        "Worker shell did not produce a stable version",
                      ),
                    );
                  }
                  return {
                    worker: workerName,
                    baseline: [{ version: stableVersion, percentage: 100 }],
                    versions: [
                      {
                        version: stableVersion,
                        percentage: stablePercentage,
                      },
                      {
                        version: candidateVersion,
                        percentage: candidatePercentage,
                      },
                    ],
                    message: `live test ${candidatePercentage}% candidate`,
                  };
                }),
              );
              return { shell, candidate, deployment };
            }),
          );

        const candidate = yield* deployPhase(100, 0);
        expect(candidate.candidate.assetManifestHash).toBeDefined();
        expect(candidate.candidate.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(candidate.deployment.versions).toEqual(
          expect.arrayContaining([
            {
              versionId: candidate.candidate.versionId,
              percentage: 0,
            },
          ]),
        );

        for (const [stable, next] of [
          [95, 5],
          [75, 25],
          [0, 100],
          [100, 0],
        ] as const) {
          const phase = yield* deployPhase(stable, next);
          expect(phase.candidate.versionId).toEqual(
            candidate.candidate.versionId,
          );
          const observed = yield* latestDeployment(phase.shell.workerName);
          expect(
            observed?.versions
              .map(({ versionId, percentage }) => ({
                versionId,
                percentage,
              }))
              .sort((left, right) =>
                left.versionId.localeCompare(right.versionId),
              ),
          ).toEqual(phase.deployment.versions);
        }

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 240_000 },
  );
});
