import {
  ImmutableWorkerVersionConfigError,
  prepareWorkerVersionArtifact,
} from "@/Cloudflare/Workers/WorkerVersion.ts";
import {
  canonicalWorkersDeploymentVersions,
  WorkersDeploymentConfigError,
} from "@/Cloudflare/Workers/WorkersDeployment.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

const artifactDirectory =
  "test/Cloudflare/Workers/fixtures/immutable-version/server";
const assetDirectory =
  "test/Cloudflare/Workers/fixtures/immutable-version/client";

describe("Worker release resources", () => {
  it.effect(
    "accepts exact rollout phases, including zero-percent versions",
    () =>
      Effect.gen(function* () {
        for (const [stable, candidate] of [
          [100, 0],
          [95, 5],
          [75, 25],
          [0, 100],
          [100, 0],
        ]) {
          expect(
            yield* canonicalWorkersDeploymentVersions([
              { version: "stable", percentage: stable },
              { version: "candidate", percentage: candidate },
            ]),
          ).toEqual([
            { versionId: "candidate", percentage: candidate },
            { versionId: "stable", percentage: stable },
          ]);
        }
      }),
  );

  it.effect("rejects malformed traffic state", () =>
    Effect.gen(function* () {
      const exit = yield* canonicalWorkersDeploymentVersions([
        { version: "stable", percentage: 90 },
        { version: "candidate", percentage: 5 },
      ]).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(
          WorkersDeploymentConfigError,
        );
      }
    }),
  );

  it.effect(
    "digests the final modules, assets, bindings and configuration",
    () =>
      Effect.gen(function* () {
        const prepared = yield* prepareWorkerVersionArtifact({
          worker: "test-worker",
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
              service: "dependency-worker",
            },
          ],
          cache: { enabled: true, crossVersionCache: false },
          placement: { mode: "smart" },
        });

        expect(prepared.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(prepared.assetManifestHash).toMatch(/^[a-f0-9]{64}$/);
        expect(prepared.modules.map(({ name }) => name).sort()).toEqual([
          "_headers",
          "_redirects",
          "index.mjs",
        ]);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("refuses an artifact whose signed digest does not match", () =>
    Effect.gen(function* () {
      const exit = yield* prepareWorkerVersionArtifact({
        worker: "test-worker",
        artifact: {
          directory: artifactDirectory,
          mainModule: "index.mjs",
          digest: "0".repeat(64),
        },
      }).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(
          ImmutableWorkerVersionConfigError,
        );
      }
    }).pipe(Effect.provide(PlatformServices)),
  );
});
