import {
  exportStateSnapshot,
  InMemoryService,
  restoreStateSnapshot,
  syncState,
  type ResourceState,
  type StateService,
} from "@/State";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

describe("syncState", () => {
  it.effect(
    "copies source resources and overwrites matching destination resources",
    () =>
      Effect.gen(function* () {
        const sourceA = resource("resource-a", { value: "source-a" });
        const sourceB = resource("resource-b", { value: "source-b" });
        const destinationA = resource("resource-a", { value: "destination-a" });

        const source = yield* InMemoryService({
          app: {
            dev: {
              "resource-a": sourceA,
              "resource-b": sourceB,
            },
          },
        });
        const destination = yield* InMemoryService({
          app: {
            dev: {
              "resource-a": destinationA,
            },
          },
        });

        yield* syncState(source, destination);

        yield* expectStage(destination, "app", "dev", {
          "resource-a": sourceA,
          "resource-b": sourceB,
        });
      }),
  );

  it.effect("exports and restores resources and stack outputs", () =>
    Effect.gen(function* () {
      const sourceA = resource("resource-a", { value: "source-a" });
      sourceA.attr = {
        ...sourceA.attr,
        secret: Redacted.make("state-secret"),
      };
      const source = yield* InMemoryService(
        {
          app: {
            prod: {
              "resource-a": sourceA,
            },
          },
        },
        {
          app: {
            prod: { release: "v1" },
          },
        },
      );
      const destination = yield* InMemoryService({
        app: {
          prod: {
            stale: resource("stale", { value: "stale" }),
          },
        },
        unrelated: {
          prod: {
            retained: resource("retained", { value: "retained" }),
          },
        },
      });

      const snapshot = yield* exportStateSnapshot(source, {
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      });
      expect(snapshot).toMatchObject({
        version: 1,
        source: { id: "inmemory" },
        createdAt: "2026-07-28T00:00:00.000Z",
      });

      yield* restoreStateSnapshot(snapshot, destination, { replace: true });

      yield* expectStage(destination, "app", "prod", {
        "resource-a": sourceA,
      });
      yield* expectStage(destination, "unrelated", "prod", {
        retained: resource("retained", { value: "retained" }),
      });
      expect(
        yield* destination.getOutput({ stack: "app", stage: "prod" }),
      ).toEqual({ release: "v1" });
      const restored = yield* destination.get({
        stack: "app",
        stage: "prod",
        fqn: "resource-a",
      });
      expect(
        Redacted.value(
          (restored as ResourceState).attr?.secret as Redacted.Redacted<string>,
        ),
      ).toBe("state-secret");
    }),
  );

  it.effect("limits filtered sync to the selected stacks", () =>
    Effect.gen(function* () {
      const source = yield* InMemoryService({
        app: {
          dev: {
            selected: resource("selected", { value: "source" }),
          },
        },
        ignored: {
          dev: {
            ignored: resource("ignored", { value: "source" }),
          },
        },
      });
      const destination = yield* InMemoryService({
        ignored: {
          dev: {
            retained: resource("retained", { value: "destination" }),
          },
        },
      });

      yield* syncState(source, destination, { stacks: ["app"] });

      yield* expectStage(destination, "app", "dev", {
        selected: resource("selected", { value: "source" }),
      });
      yield* expectStage(destination, "ignored", "dev", {
        retained: resource("retained", { value: "destination" }),
      });
    }),
  );

  it.effect(
    "deletes resources from destination when they are absent from source",
    () =>
      Effect.gen(function* () {
        const source = yield* InMemoryService({
          app: {
            dev: {
              "resource-a": resource("resource-a", { value: "source-a" }),
            },
          },
        });
        const destination = yield* InMemoryService({
          app: {
            dev: {
              "resource-a": resource("resource-a", { value: "destination-a" }),
              "resource-b": resource("resource-b", { value: "destination-b" }),
            },
            prod: {
              "resource-c": resource("resource-c", { value: "destination-c" }),
            },
          },
          oldApp: {
            dev: {
              "resource-d": resource("resource-d", { value: "destination-d" }),
            },
          },
        });

        yield* syncState(source, destination);

        yield* expectStage(destination, "app", "dev", {
          "resource-a": resource("resource-a", { value: "source-a" }),
        });
        yield* expectStage(destination, "app", "prod", {});
        yield* expectStage(destination, "oldApp", "dev", {});
        expect(yield* destination.listStacks()).toEqual(["app"]);
      }),
  );
});

const resource = (
  fqn: string,
  attr: Record<string, unknown>,
): ResourceState => ({
  resourceType: "test:resource",
  namespace: undefined,
  fqn,
  logicalId: fqn,
  instanceId: `instance-${fqn}`,
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: {},
  attr,
});

const listStage = Effect.fn(function* (
  state: StateService,
  stack: string,
  stage: string,
) {
  const fqns = yield* state.list({ stack, stage });
  const entries = yield* Effect.forEach(
    fqns,
    Effect.fn(function* (fqn) {
      return [fqn, yield* state.get({ stack, stage, fqn })] as const;
    }),
  );
  return Object.fromEntries(entries);
});

const expectStage = Effect.fn(function* (
  state: StateService,
  stack: string,
  stage: string,
  expected: Record<string, ResourceState>,
) {
  expect(yield* listStage(state, stack, stage)).toEqual(expected);
});
