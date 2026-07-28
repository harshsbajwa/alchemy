import { adopt } from "@/AdoptPolicy.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Cloudflare.providers() });

describe.sequential("Cloudflare.Workers.WorkerSettings", () => {
  test.provider(
    "adopts and reconciles persistent telemetry without uploading code",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const shell = yield* stack.deploy(
          Cloudflare.Worker("SettingsShell", {
            script: `export default { fetch() { return new Response("stable"); } };`,
          }),
        );

        const initialVersion = shell.versionId;
        const configured = yield* stack.deploy(
          Effect.gen(function* () {
            yield* Cloudflare.Worker("SettingsShell", {
              script: `export default { fetch() { return new Response("stable"); } };`,
            });
            return yield* Cloudflare.Workers.WorkerSettings(
              "PersistentSettings",
              {
                worker: shell.workerName,
                logpush: true,
                observability: {
                  enabled: true,
                  logs: {
                    enabled: true,
                    headSamplingRate: 1,
                    invocationLogs: true,
                  },
                  traces: { enabled: true, headSamplingRate: 0.1 },
                },
                tags: ["alchemy:worker-settings-live-test"],
              },
            ).pipe(adopt(true));
          }),
        );

        const { accountId } = yield* yield* CloudflareEnvironment;
        const observed = yield* workers.getScriptSetting({
          accountId,
          scriptName: configured.workerName,
        });
        expect(observed.logpush).toEqual(true);
        expect(observed.observability?.traces?.enabled).toEqual(true);
        expect(observed.tags).toContain("alchemy:worker-settings-live-test");

        const versions = yield* workers.listScriptVersions({
          accountId,
          scriptName: configured.workerName,
        });
        expect(versions.result.items?.[0]?.id).toEqual(initialVersion);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );
});
