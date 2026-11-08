import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";
import * as DeviceHost from "./DeviceHost.ts";

const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_POLL_MS = 100;

const AgentDeviceDaemonFile = Schema.Struct({
  httpPort: Schema.Int,
  token: Schema.String,
  pid: Schema.optional(Schema.Int),
  version: Schema.optional(Schema.String),
});
const decodeDaemonFile = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentDeviceDaemonFile));

const decodeAgentDeviceFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        details: Schema.Struct({
          reason: Schema.String,
          inspection: Schema.optional(Schema.Struct({ reason: Schema.String })),
        }),
      }),
    }),
  ),
);

interface Tool {
  readonly nodePath: string;
  readonly entryPath: string;
}

export const make = Effect.fn("AgentDeviceDaemon.make")(function* (options: {
  readonly hostId: string;
  readonly stateDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly session?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const { hostId, stateDir } = options;
  const daemonFile = path.join(stateDir, "daemon.json");
  const environment = {
    ...options.environment,
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
    // The host owns shutdown, so the daemon must not expire between agent turns.
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  const read = Effect.fn("AgentDeviceDaemon.read")(function* () {
    return yield* fs.readFileString(daemonFile).pipe(Effect.flatMap(decodeDaemonFile));
  });
  const invoke = Effect.fn("AgentDeviceDaemon.invoke")(
    (tool: Tool, args: ReadonlyArray<string>, timeoutMs: number) =>
      runner.run({
        command: tool.nodePath,
        args: [tool.entryPath, ...args],
        cwd: options.cwd,
        env: environment,
        timeout: Duration.millis(timeoutMs),
        timeoutBehavior: "timedOutResult",
      }),
  );
  const run = Effect.fn("AgentDeviceDaemon.run")(function* (
    tool: Tool,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* invoke(
      tool,
      [...args, ...(options.session ? ["--session", options.session] : []), "--json"],
      120_000,
    );
    if (result.timedOut)
      return yield* new DeviceHost.DeviceHostTimeoutError({ hostId, timeoutMs: 120_000 });
    if (result.code !== 0)
      return yield* new DeviceHost.DeviceHostError({
        hostId,
        step: "running agent-device",
        cause: result,
      });
    return result;
  });
  const start = Effect.fn("AgentDeviceDaemon.start")(function* (
    tool: Tool,
  ): Effect.fn.Return<
    DeviceHost.AgentDeviceEndpoint,
    | DeviceHost.DeviceHostError
    | DeviceHost.DeviceHostTimeoutError
    | DeviceHost.AgentDeviceStartError
  > {
    yield* fs.makeDirectory(stateDir, { recursive: true }).pipe(Effect.ignore);
    const existing = yield* read().pipe(Effect.option);
    const toEndpoint = (
      file: typeof AgentDeviceDaemonFile.Type,
    ): DeviceHost.AgentDeviceEndpoint => ({
      baseUrl: `http://127.0.0.1:${file.httpPort}`,
      token: file.token,
      entryPath: tool.entryPath,
    });
    if (existing._tag === "Some") {
      const alive = yield* HttpClient.withScope(httpClient)
        .get(`http://127.0.0.1:${existing.value.httpPort}/health`)
        .pipe(
          Effect.timeout(Duration.seconds(2)),
          Effect.flatMap((response) =>
            response.arrayBuffer.pipe(Effect.as(response.status === 200)),
          ),
          Effect.scoped,
          Effect.orElseSucceed(() => false),
        );
      if (alive) return toEndpoint(existing.value);
      yield* fs.remove(daemonFile, { force: true }).pipe(Effect.ignore);
    }
    // No `daemon start` exists; `devices` is the cheapest command that starts and awaits it.
    const runResult = yield* invoke(tool, ["devices", "--json"], DAEMON_READY_TIMEOUT_MS).pipe(
      Effect.result,
    );
    // Discovery may fail after startup; accept a published endpoint or preserve the CLI failure.
    const started = yield* read().pipe(Effect.option);
    if (started._tag === "Some") return toEndpoint(started.value);
    if (runResult._tag === "Failure") {
      return yield* new DeviceHost.DeviceHostError({
        hostId,
        step: "starting agent tools",
        cause: runResult.failure,
      });
    }
    const result = runResult.success;
    if (result.timedOut) {
      return yield* new DeviceHost.DeviceHostTimeoutError({
        hostId,
        timeoutMs: DAEMON_READY_TIMEOUT_MS,
      });
    }
    if (result.code !== 0) {
      const failure = decodeAgentDeviceFailure(result.stdout);
      const details = Option.isSome(failure) ? failure.value.error.details : undefined;
      const reason =
        details?.reason === "daemon_registration_unproven"
          ? details.inspection?.reason === "non-directory"
            ? "daemon_lock_not_directory"
            : "daemon_registration_unproven"
          : details?.reason === "daemon_retirement_unconfirmed"
            ? "daemon_retirement_unconfirmed"
            : "command_failed";
      return yield* new DeviceHost.AgentDeviceStartError({
        hostId,
        stateDir,
        exitCode: result.code === null ? null : Number(result.code),
        reason,
        cause: result,
      });
    }
    const deadline = (yield* Clock.currentTimeMillis) + DAEMON_READY_TIMEOUT_MS;
    while (true) {
      const file = yield* read().pipe(Effect.option);
      if (file._tag === "Some") return toEndpoint(file.value);
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new DeviceHost.DeviceHostTimeoutError({
          hostId,
          timeoutMs: DAEMON_READY_TIMEOUT_MS,
        });
      }
      yield* Effect.sleep(Duration.millis(DAEMON_POLL_MS));
    }
  });

  const stop = Effect.fn("AgentDeviceDaemon.stop")(function* (tool: Tool) {
    const result = yield* invoke(tool, ["daemon", "stop", "--state-dir", stateDir], 10_000);
    if (result.timedOut)
      return yield* new DeviceHost.DeviceHostTimeoutError({ hostId, timeoutMs: 10_000 });
    if (result.code !== 0)
      return yield* new DeviceHost.DeviceHostError({
        hostId,
        step: "stopping agent tools",
        cause: result,
      });
  });
  return { read, start, run, stop };
});
