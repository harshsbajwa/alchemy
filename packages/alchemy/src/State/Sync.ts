import * as Effect from "effect/Effect";
import type { PersistedState, StateService } from "./State.ts";
import { encodeState, reviveStateRecursive } from "./StateEncoding.ts";

export const STATE_SNAPSHOT_VERSION = 1 as const;

export interface StateSnapshotResource {
  fqn: string;
  /** JSON-safe state encoded with Alchemy's redacted/duration markers. */
  value: unknown;
}

export interface StateSnapshotStage {
  name: string;
  resources: StateSnapshotResource[];
  output?: unknown;
  hasOutput: boolean;
}

export interface StateSnapshotStack {
  name: string;
  stages: StateSnapshotStage[];
}

/**
 * Portable, provider-independent backup of Alchemy state.
 *
 * The snapshot contains resources and stack outputs, not state-store
 * credentials. Callers can encrypt/sign the serialized document according to
 * their own backup policy.
 */
export interface StateSnapshot {
  version: typeof STATE_SNAPSHOT_VERSION;
  source: {
    id: string;
    version: number;
  };
  createdAt: string;
  stacks: StateSnapshotStack[];
}

/** Export a complete or stack-filtered state snapshot. */
export const exportStateSnapshot = Effect.fn(function* (
  source: StateService,
  options?: {
    stacks?: string[];
    concurrency?: number | "unbounded";
    now?: () => Date;
  },
) {
  const concurrency = options?.concurrency ?? "unbounded";
  const selected = options?.stacks ? new Set(options.stacks) : undefined;
  const stackNames = (yield* source.listStacks())
    .filter((stack) => selected?.has(stack) ?? true)
    .sort();
  const stacks = yield* Effect.forEach(
    stackNames,
    Effect.fn(function* (stack) {
      const stageNames = [...(yield* source.listStages(stack))].sort();
      const stages = yield* Effect.forEach(
        stageNames,
        Effect.fn(function* (stage) {
          const fqns = [...(yield* source.list({ stack, stage }))].sort();
          const resources = yield* Effect.forEach(
            fqns,
            Effect.fn(function* (fqn) {
              const value = yield* source.get({ stack, stage, fqn });
              return value === undefined
                ? undefined
                : { fqn, value: encodeState(value) };
            }),
            { concurrency },
          );
          const output = yield* source.getOutput({ stack, stage });
          return {
            name: stage,
            resources: resources.filter(
              (resource): resource is StateSnapshotResource =>
                resource !== undefined,
            ),
            output: encodeState(output),
            hasOutput: output !== undefined,
          } satisfies StateSnapshotStage;
        }),
        { concurrency: 1 },
      );
      return { name: stack, stages } satisfies StateSnapshotStack;
    }),
    { concurrency: 1 },
  );
  return {
    version: STATE_SNAPSHOT_VERSION,
    source: {
      id: source.id,
      version: yield* source.getVersion(),
    },
    createdAt: (options?.now?.() ?? new Date()).toISOString(),
    stacks,
  } satisfies StateSnapshot;
});

/**
 * Restore a validated state snapshot.
 *
 * `replace` clears only stacks represented by the snapshot before restoring
 * them. Unrelated destination stacks are never removed.
 */
export const restoreStateSnapshot = Effect.fn(function* (
  snapshot: StateSnapshot,
  destination: StateService,
  options?: {
    replace?: boolean;
    concurrency?: number | "unbounded";
  },
) {
  if (snapshot.version !== STATE_SNAPSHOT_VERSION) {
    return yield* Effect.die(
      new Error(`Unsupported state snapshot version '${snapshot.version}'.`),
    );
  }
  const concurrency = options?.concurrency ?? "unbounded";
  if (options?.replace) {
    yield* Effect.forEach(
      snapshot.stacks,
      ({ name }) => destination.deleteStack({ stack: name }),
      { concurrency: 1 },
    );
  }
  yield* Effect.forEach(
    snapshot.stacks,
    Effect.fn(function* (stack) {
      yield* Effect.forEach(
        stack.stages,
        Effect.fn(function* (stage) {
          yield* Effect.forEach(
            stage.resources,
            ({ fqn, value }) => {
              const revived = reviveStateRecursive(value);
              return destination.set({
                stack: stack.name,
                stage: stage.name,
                fqn,
                value: revived as PersistedState,
              });
            },
            { concurrency },
          );
          if (stage.hasOutput) {
            yield* destination.setOutput({
              stack: stack.name,
              stage: stage.name,
              value: reviveStateRecursive(stage.output),
            });
          }
        }),
        { concurrency: 1 },
      );
    }),
    { concurrency: 1 },
  );
});

/**
 * Synchronize all state (every stack/stage/resource) from `source` into
 * `destination` so that `destination` becomes a mirror of `source`.
 *
 * For each `{ stack, stage, fqn }` present in `source`, the resource is
 * written into `destination`, overwriting any existing entry under the same
 * key. Any keys present in `destination` but absent from `source` are
 * deleted, ensuring the two stores end up structurally identical.
 *
 * Stacks are walked sequentially; stages within a stack and resources
 * within a stage are processed concurrently for throughput.
 */
export const syncState = Effect.fn(function* (
  source: StateService,
  destination: StateService,
  options?: {
    stacks?: string[];
    /**
     * Maximum number of resources to copy in parallel within a single stage.
     * @default "unbounded".
     */
    concurrency?: number | "unbounded";
  },
) {
  const concurrency = options?.concurrency ?? "unbounded";
  const [sourceStacks, destStacks] = yield* Effect.all([
    source.listStacks(),
    destination.listStacks(),
  ]);
  const selectedSourceStacks = sourceStacks.filter(
    (stack) => options?.stacks?.includes(stack) ?? true,
  );
  const sourceStackSet = new Set(selectedSourceStacks);

  yield* Effect.forEach(
    selectedSourceStacks,
    Effect.fn(function* (stack) {
      const [sourceStages, destStages] = yield* Effect.all([
        source.listStages(stack),
        destination.listStages(stack),
      ]);
      const stages = union(sourceStages, destStages);

      yield* Effect.forEach(
        stages,
        Effect.fn(function* (stage) {
          const sourceFqns = yield* source.list({ stack, stage });
          const destFqns = yield* destination.list({ stack, stage });

          const sourceSet = new Set(sourceFqns);
          const toDelete = destFqns.filter((fqn) => !sourceSet.has(fqn));

          yield* Effect.all(
            [
              Effect.forEach(
                sourceFqns,
                Effect.fn(function* (fqn) {
                  const value = yield* source.get({ stack, stage, fqn });
                  if (value) {
                    yield* destination.set({ stack, stage, fqn, value });
                  }
                }),
                { concurrency },
              ),
              Effect.forEach(
                toDelete,
                (fqn) => destination.delete({ stack, stage, fqn }),
                { concurrency },
              ),
            ],
            { concurrency: "unbounded" },
          );
        }),
        { concurrency: "unbounded" },
      );
    }),
  );

  if (!options?.stacks) {
    yield* Effect.forEach(
      destStacks.filter((stack) => !sourceStackSet.has(stack)),
      (stack) => destination.deleteStack({ stack }),
    );
  }
});

const union = <T>(left: Iterable<T>, right: Iterable<T>) => [
  ...new Set([...left, ...right]),
];
