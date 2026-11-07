import Limrun from "@limrun/api";
import { createInstanceClient as createIosClient } from "@limrun/api/ios-client";
import { createInstanceClient as createAndroidClient } from "@limrun/api/instance-client";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { DevicePlatform } from "@t3tools/contracts";

export class LimrunRequestError extends Schema.TaggedError<LimrunRequestError>()(
  "LimrunRequestError",
  {
    operation: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Limrun ${this.operation} failed${this.status === undefined ? "" : ` (HTTP ${this.status})`}.`;
  }
}

export type Instance = Limrun.IosInstance | Limrun.AndroidInstance;
export type Runtime =
  | { platform: "ios"; client: Awaited<ReturnType<typeof createIosClient>> }
  | { platform: "android"; client: Awaited<ReturnType<typeof createAndroidClient>> };

export const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new LimrunRequestError({
        operation,
        ...(cause instanceof Limrun.APIError && cause.status !== undefined
          ? { status: cause.status }
          : {}),
        cause,
      }),
  });

export class LimrunApi extends Context.Service<
  LimrunApi,
  {
    readonly create: (
      key: string,
      platform: DevicePlatform,
      input: {
        owner: string;
        slot: string;
        region: string;
        model: string;
        hardMinutes: number;
        idleMinutes: number;
      },
    ) => Effect.Effect<Instance, LimrunRequestError>;
    readonly get: (
      key: string,
      platform: DevicePlatform,
      id: string,
    ) => Effect.Effect<Instance, LimrunRequestError>;
    readonly list: (
      key: string,
      platform: DevicePlatform,
      owner: string,
    ) => Effect.Effect<ReadonlyArray<Instance>, LimrunRequestError>;
    readonly remove: (
      key: string,
      platform: DevicePlatform,
      id: string,
    ) => Effect.Effect<void, LimrunRequestError>;
    readonly connect: (
      instance: Instance,
      platform: DevicePlatform,
    ) => Effect.Effect<Runtime, LimrunRequestError>;
  }
>()("t3/device/LimrunApi") {}

const client = (apiKey: string) =>
  new Limrun({ apiKey, maxRetries: 0, defaultHeaders: { "User-Agent": "t3code/limrun" } });
export const layer = Layer.succeed(
  LimrunApi,
  LimrunApi.of({
    create: Effect.fn("LimrunApi.create")((key, platform, input) =>
      request("create", async (signal) => {
        const params = {
          wait: false,
          reuseIfExists: true,
          metadata: {
            displayName: "T3 Code",
            labels: { "t3code-host": input.owner, "t3code-slot": input.slot },
          },
          spec: {
            ...(input.region ? { region: input.region } : {}),
            hardTimeout: `${input.hardMinutes}m`,
            inactivityTimeout: `${input.idleMinutes}m`,
          },
        };
        return platform === "ios"
          ? client(key).iosInstances.create(
              { ...params, spec: { ...params.spec, model: input.model as "iphone" | "ipad" } },
              { signal },
            )
          : client(key).androidInstances.create(
              { ...params, spec: { ...params.spec, model: input.model as "phone" | "tablet" } },
              { signal },
            );
      }),
    ),
    get: Effect.fn("LimrunApi.get")((key, platform, id) =>
      request("get", (signal) =>
        platform === "ios"
          ? client(key).iosInstances.get(id, { signal })
          : client(key).androidInstances.get(id, { signal }),
      ),
    ),
    list: Effect.fn("LimrunApi.list")((key, platform, owner) =>
      request("list", async (signal) => {
        const params = { labelSelector: `t3code-host=${owner}`, state: "creating,assigned,ready" };
        const items: Instance[] = [];
        const pages =
          platform === "ios"
            ? client(key).iosInstances.list(params, { signal })
            : client(key).androidInstances.list(params, { signal });
        for await (const item of pages) items.push(item);
        return items;
      }),
    ),
    remove: Effect.fn("LimrunApi.remove")((key, platform, id) =>
      request("delete", (signal) =>
        platform === "ios"
          ? client(key).iosInstances.delete(id, { signal })
          : client(key).androidInstances.delete(id, { signal }),
      ).pipe(
        Effect.catchTags({
          LimrunRequestError: (error) => (error.status === 404 ? Effect.void : Effect.fail(error)),
        }),
      ),
    ),
    connect: Effect.fn("LimrunApi.connect")((instance, platform) =>
      request("connect", async () => {
        const options = {
          apiUrl: instance.status.apiUrl!,
          token: instance.status.token!,
          logLevel: "none" as const,
        };
        return platform === "ios"
          ? { platform, client: await createIosClient(options) }
          : {
              platform,
              client: await createAndroidClient({
                ...options,
                ...((instance as Limrun.AndroidInstance).status.adbWebSocketUrl
                  ? { adbUrl: (instance as Limrun.AndroidInstance).status.adbWebSocketUrl! }
                  : {}),
              }),
            };
      }),
    ),
  }),
);
