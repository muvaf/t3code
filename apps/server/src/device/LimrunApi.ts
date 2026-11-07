import Limrun from "@limrun/api";
import { createServeSimHost, type ServeSimHostOptions } from "@limrun/api/serve-sim-host";
import * as Logger from "effect/Logger";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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
export type Host = Awaited<ReturnType<typeof createServeSimHost>>;
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
    readonly createHost: (
      key: string,
      options: Omit<ServeSimHostOptions, "client" | "onError">,
    ) => Effect.Effect<Host, LimrunRequestError>;
  }
>()("t3/device/LimrunApi") {}

export const layer = Layer.succeed(
  LimrunApi,
  LimrunApi.of({
    createHost: Effect.fn("LimrunApi.createHost")(function* (apiKey, options) {
      const loggers = yield* Logger.CurrentLoggers;
      const clock = yield* Clock.Clock;
      const fiber = yield* Effect.withFiber(Effect.succeed);
      return yield* request("create host", () =>
        createServeSimHost({
          ...options,
          client: new Limrun({
            apiKey,
            maxRetries: 0,
            defaultHeaders: { "User-Agent": "t3code/limrun" },
          }),
          onError: (operation, deviceId) => {
            for (const logger of loggers)
              logger.log({
                message: ["Limrun cleanup failed", { operation, deviceId }],
                logLevel: "Warn",
                cause: Cause.empty,
                fiber,
                date: DateTime.toDateUtc(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())),
              });
          },
        }),
      );
    }),
  }),
);
