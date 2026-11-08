import * as Random from "effect/Random";
import * as DateTime from "effect/DateTime";
import {
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DeviceHostSummary,
  type DevicePlatform,
  type LimrunDeviceHostConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as FiberMap from "effect/FiberMap";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as LimrunApi from "./LimrunApi.ts";
import type { AgentDeviceCli } from "./SimlockDeviceHost.ts";

const catalog: ReadonlyArray<DeviceHost.HostDevice> = [
  {
    id: "limrun:ios:iphone",
    platform: "ios",
    name: "iPhone",
    version: "iOS",
    booted: false,
    physical: false,
  },
  {
    id: "limrun:ios:ipad",
    platform: "ios",
    name: "iPad",
    version: "iOS",
    booted: false,
    physical: false,
  },
  {
    id: "limrun:android:phone",
    platform: "android",
    name: "Android phone",
    version: "Android",
    booted: false,
    physical: false,
  },
  {
    id: "limrun:android:tablet",
    platform: "android",
    name: "Android tablet",
    version: "Android",
    booted: false,
    physical: false,
  },
  {
    id: "limrun:ios:iphone-duo",
    platform: "ios",
    name: "iPhone Duo",
    version: "iOS",
    booted: false,
    physical: false,
  },
];
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeDaemon = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ httpPort: Schema.Int, token: Schema.String })),
);
interface Running {
  instance: LimrunApi.Instance;
  platform: DevicePlatform;
  device: DeviceHost.HostDevice;
  key: string;
  dir: string;
  session: string;
  cwd: string;
  runtime?: LimrunApi.Runtime;
  endpoint?: DeviceHost.AgentDeviceBinding;
  events?: Array<{ id: number; timestamp: string; kind: string; summary: string }>;
  stopEvents?: () => void;
}

export const make = Effect.fn("LimrunDeviceHost.make")(function* (
  config: LimrunDeviceHostConfig,
  agentCli: AgentDeviceCli,
) {
  const api = yield* LimrunApi.LimrunApi;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const server = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const secrets = yield* SecretResolver.SecretResolver;
  const nodeContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof resolveNodeExecutable>>>();
  const lock = yield* Semaphore.make(1);
  const renewals = yield* FiberMap.make<string>();
  const live = new Map<string, Running>();
  const directory = path.join(server.stateDir, "device", "limrun", config.id);
  let owner: string | undefined;
  let ready: DeviceHost.DeviceHostReady | null = null;
  let cli: { nodePath: string; entryPath: string } | undefined;
  // A lost create response must reuse the same allocation, not rent a second device on retry.
  let pending: { templateId: string; slot: string } | undefined;
  const unavailable = (reason: string, cause?: unknown) =>
    new DeviceHostUnavailableError({
      hostId: config.id,
      hostLabel: config.label,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });
  const failed = (operation: string) => (cause: unknown) =>
    new DeviceOperationError({ operation, reason: "request_failed", cause });
  const credential = Effect.gen(function* () {
    const key = config.apiKey
      ? yield* requireSettingsSecret(secrets, config.apiKey)
      : environment.LIMRUN_API_KEY;
    if (!key)
      return yield* unavailable(
        "Add a Limrun API key in Settings or set LIMRUN_API_KEY on the T3 server.",
      );
    return key;
  });
  const agentEnv = (item: Running): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) => !/^(AGENT_DEVICE_|LIM_IOS_|LIM_ANDROID_|LIMRUN_|LIM_API_KEY$)/.test(name),
      ),
    ),
    ELECTRON_RUN_AS_NODE: "1",
    AGENT_DEVICE_STATE_DIR: item.dir,
    AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
    ...(item.platform === "ios"
      ? {
          LIM_IOS_INSTANCE_URL: item.instance.status.apiUrl!,
          LIM_IOS_INSTANCE_TOKEN: item.instance.status.token!,
        }
      : {
          LIM_ANDROID_INSTANCE_URL: item.instance.status.apiUrl!,
          LIM_ANDROID_INSTANCE_TOKEN: item.instance.status.token!,
          LIM_ANDROID_INSTANCE_ADB_URL:
            "adbWebSocketUrl" in item.instance.status
              ? item.instance.status.adbWebSocketUrl
              : undefined,
        }),
  });
  const agent = Effect.fn("LimrunDeviceHost.agent")(function* (
    item: Running,
    args: ReadonlyArray<string>,
  ) {
    if (!cli) return yield* unavailable("Limrun agent tools are not ready.");
    const result = yield* runner.run({
      command: cli.nodePath,
      args: [
        cli.entryPath,
        ...args,
        ...(args[0] === "daemon" ? [] : ["--session", item.session]),
        "--json",
      ],
      cwd: item.cwd,
      env: agentEnv(item),
      timeout: "2 minutes",
    });
    if (result.code !== 0)
      return yield* unavailable(
        `agent-device ${args[0]} failed (exit ${result.code}). Check the Limrun runner and daemon logs in ${item.dir}.`,
      );
    return result;
  });
  const stopDaemon = (item: Running) =>
    Effect.suspend(() =>
      cli ? agent(item, ["daemon", "stop"]).pipe(Effect.asVoid) : Effect.void,
    ).pipe(
      Effect.tapError(() =>
        Effect.logWarning("Could not stop Limrun agent daemon", {
          deviceId: item.instance.metadata.id,
        }),
      ),
      Effect.ignore,
      Effect.tap(() =>
        Effect.sync(() => {
          delete item.endpoint;
        }),
      ),
    );
  const remove = Effect.fn("LimrunDeviceHost.remove")(function* (item: Running) {
    // Keep failed deletions tracked: a retry must not silently exceed the host's instance limit.
    yield* api.remove(item.key, item.platform, item.instance.metadata.id);
    yield* stopDaemon(item);
    item.stopEvents?.();
    item.runtime?.client.disconnect();
    live.delete(item.instance.metadata.id);
  });
  const runtime = Effect.fn("LimrunDeviceHost.runtime")(function* (item: Running) {
    if (!item.runtime) {
      item.runtime = yield* api.connect(item.instance, item.platform);
      if (item.runtime.platform === "ios") {
        const client = item.runtime.client;
        const started = yield* LimrunApi.request("start event capture", () =>
          client.startEventCapture(),
        ).pipe(Effect.result);
        if (started._tag === "Success") {
          item.events = [];
          let sequence = 0;
          item.stopEvents = client.streamEventCapture({
            onEvent: (event) => {
              item.events!.push({
                id: ++sequence,
                timestamp: DateTime.formatIso(DateTime.makeUnsafe(event.ts)),
                kind: event.type,
                summary: event.summary ?? event.type,
              });
              if (item.events!.length > 100) item.events!.shift();
            },
          });
        } else
          yield* Effect.logWarning("Limrun event capture unavailable", {
            deviceId: item.instance.metadata.id,
          });
      }
    }
    return item.runtime;
  });
  const startAgent = Effect.fn("LimrunDeviceHost.startAgent")(function* (item: Running) {
    if (item.endpoint) return item.endpoint;
    if (!cli) cli = yield* agentCli;
    yield* fs.makeDirectory(item.dir, { recursive: true });
    yield* agent(item, ["connect", "limrun", "--platform", item.platform]);
    yield* agent(item, ["boot", "--platform", item.platform]);
    const daemon = yield* fs
      .readFileString(path.join(item.dir, "daemon.json"))
      .pipe(Effect.flatMap(decodeDaemon));
    item.endpoint = {
      baseUrl: `http://127.0.0.1:${daemon.httpPort}`,
      token: daemon.token,
      agentDeviceId: null,
      session: item.session,
      stateDir: item.dir,
      installDirectory: item.cwd,
    };
    return item.endpoint;
  });
  const initialize = Effect.gen(function* () {
    if (owner) return;
    yield* fs.makeDirectory(directory, { recursive: true });
    const file = path.join(directory, "owner");
    const saved = yield* fs.readFileString(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(""),
      ),
    );
    const identity =
      saved.trim() ||
      `${yield* Random.nextIntBetween(0, 0x7fffffff)}-${yield* Random.nextIntBetween(0, 0x7fffffff)}`;
    if (!saved) yield* fs.writeFileString(file, identity, { mode: 0o600 });
    const key = yield* credential;
    // Recover only this T3 installation's instances. An API key can belong to many installations.
    for (const platform of ["ios", "android"] as const) {
      for (const instance of yield* api.list(key, platform, identity))
        yield* api.remove(key, platform, instance.metadata.id);
    }
    owner = identity;
  });
  const open = Effect.fn("LimrunDeviceHost.open")(function* (
    device: DeviceHost.HostDevice,
    context?: DeviceHost.DeviceOpenContext,
  ) {
    if (live.has(device.id)) return device.id;
    if (!catalog.some((candidate) => candidate.id === device.id))
      return yield* unavailable("This Limrun instance has ended. Open a new device from the list.");
    yield* initialize;
    if (pending && pending.templateId !== device.id)
      return yield* unavailable(
        "Retry the previous Limrun device first; its allocation could not be confirmed.",
      );
    if (live.size >= config.maxConcurrentSessions)
      return yield* unavailable(
        `Close a Limrun device first; ${config.label} allows ${config.maxConcurrentSessions} at once.`,
      );
    const key = yield* credential;
    const slot =
      pending?.slot ??
      `${yield* Random.nextIntBetween(0, 0x7fffffff)}-${yield* Random.nextIntBetween(0, 0x7fffffff)}`;
    pending = { templateId: device.id, slot };
    const item = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const instance = yield* api
          .create(key, device.platform, {
            owner: owner!,
            slot,
            region: config.region,
            model: device.id.split(":")[2]!,
            hardMinutes: config.maxSessionMinutes,
            idleMinutes: config.idleMinutes,
          })
          .pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (
                  error.status !== undefined &&
                  error.status >= 400 &&
                  error.status < 500 &&
                  error.status !== 408
                )
                  pending = undefined;
              }),
            ),
          );
        const id = instance.metadata.id;
        const dir = path.join(directory, slot);
        const item: Running = {
          instance,
          platform: device.platform,
          key,
          device: { ...device, id, booted: true },
          dir,
          session: `t3-${slot}`,
          cwd: context?.workspaceRoot ?? directory,
        };
        live.set(id, item);
        pending = undefined;
        return item;
      }),
    );
    return yield* Effect.gen(function* () {
      while (item.instance.status.state !== "ready") {
        if (item.instance.status.state === "terminated")
          return yield* unavailable("Limrun could not start this device.");
        yield* Effect.sleep("1 second");
        item.instance = yield* api.get(key, item.platform, item.instance.metadata.id);
      }
      if (
        !item.instance.status.token ||
        !item.instance.status.apiUrl ||
        !item.instance.status.endpointWebSocketUrl
      )
        return yield* unavailable("The Limrun API key needs full control of devices.");
      const connected = yield* runtime(item);
      yield* FiberMap.run(
        renewals,
        item.instance.metadata.id,
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("30 seconds");
            connected.client.keepAlive();
            if (item.endpoint)
              yield* agent(item, ["boot", "--platform", item.platform]).pipe(
                Effect.tapError(() =>
                  Effect.logWarning("Could not renew Limrun automation session", {
                    deviceId: item.instance.metadata.id,
                  }),
                ),
                Effect.ignore,
              );
          }
        }),
      );
      return item.instance.metadata.id;
    }).pipe(
      Effect.timeout("5 minutes"),
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? Effect.void
          : remove(item).pipe(
              Effect.tapError(() =>
                Effect.logWarning("Could not clean up failed Limrun device", {
                  deviceId: item.instance.metadata.id,
                }),
              ),
              Effect.ignore,
            ),
      ),
    );
  });
  const devices: DeviceHost.DeviceOperations = {
    list: lock
      .withPermit(
        Effect.gen(function* () {
          yield* initialize;
          for (const item of live.values()) {
            const state = yield* api.get(item.key, item.platform, item.instance.metadata.id).pipe(
              Effect.catchTags({
                LimrunRequestError: (error) =>
                  error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
              }),
            );
            if (state === null || state.status.state === "terminated") {
              yield* FiberMap.remove(renewals, item.instance.metadata.id);
              yield* stopDaemon(item);
              item.stopEvents?.();
              item.runtime?.client.disconnect();
              live.delete(item.instance.metadata.id);
            }
          }
          return {
            devices: [...catalog, ...[...live.values()].map((item) => item.device)],
            detail: undefined,
          };
        }),
      )
      .pipe(Effect.mapError(failed("list"))),
    boot: (device, context) =>
      lock.withPermit(open(device, context)).pipe(Effect.mapError(failed("boot"))),
    attach: (device) =>
      live.has(device.id) ? Effect.void : Effect.fail(failed("attach")("Instance has ended")),
    shutdown: (device) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const item = live.get(device.id);
            if (!item) return;
            yield* FiberMap.remove(renewals, device.id);
            yield* remove(item);
          }),
        )
        .pipe(Effect.mapError(failed("shutdown"))),
    screenshot: Effect.fn("LimrunDeviceHost.screenshot")(
      function* (device) {
        const item = live.get(device.id);
        if (!item) return yield* unavailable("Instance has ended.");
        const connected = yield* runtime(item);
        const shot = yield* LimrunApi.request("screenshot", async () => {
          if (connected.platform === "android")
            return (await connected.client.screenshot()).dataUri.split(",")[1]!;
          if ("model" in item.instance.spec && item.instance.spec.model === "iphone-duo") {
            const fold = await connected.client.getFoldState();
            const active = fold?.displays.filter((display) => display.active) ?? [];
            // Folding can activate both panels; the primary stream shows the outer display.
            const display = active.length === 1 ? active[0]!.id : "outer";
            return (await connected.client.screenshotDisplay(display, { format: "png" })).base64;
          }
          return (await connected.client.screenshot({ format: "png" })).base64;
        });
        return new Uint8Array(Buffer.from(shot, "base64"));
      },
      Effect.mapError(failed("screenshot")),
    ),
    agentEndpoint: (deviceId) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const item = live.get(deviceId);
            if (!item) return yield* unavailable("Instance has ended.");
            return yield* startAgent(item);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            unavailable("Could not attach agent-device to Limrun.", cause),
          ),
        ),
    endsDevices: true,
  };
  const run: DeviceHost.DeviceHostReady["run"] = Effect.fn("LimrunDeviceHost.run")(
    (command, args, options) =>
      Effect.gen(function* () {
        const id = command === "xcrun" ? args[2] : args[1];
        const item = id ? live.get(id) : undefined;
        if (!item) return { stdout: "", stderr: "Limrun instance not found", code: 1 };
        const connected = yield* runtime(item);
        return yield* LimrunApi.request("device command", async () => {
          if (command === "xcrun" && args[0] === "simctl" && connected.platform === "ios") {
            const execution = connected.client.simctl(
              [args[1]!, "booted", ...args.slice(3)],
              options?.stdin === undefined ? {} : { stdin: options.stdin },
            );
            const result = await execution.wait();
            return {
              stdout: result.stdout.toString(),
              stderr: result.stderr.toString(),
              code: result.code,
            };
          }
          if (
            command === "adb" &&
            args[0] === "-s" &&
            args[2] === "shell" &&
            connected.platform === "android"
          ) {
            const result = await connected.client.adbShell("sh", ["-c", args.slice(3).join(" ")]);
            return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
          }
          return { stdout: "", stderr: "This command is unavailable on Limrun.", code: 127 };
        });
      }).pipe(
        Effect.timeout(`${options?.timeoutMs ?? 30000} millis`),
        Effect.orElseSucceed(() => ({ stdout: "", stderr: "Limrun command failed", code: 1 })),
      ),
  );
  const stopAll = lock.withPermit(
    Effect.gen(function* () {
      yield* FiberMap.clear(renewals);
      for (const item of live.values())
        yield* remove(item).pipe(
          Effect.tapError(() =>
            Effect.logWarning(
              "Could not terminate Limrun instance; its hard timeout remains active",
              { deviceId: item.instance.metadata.id },
            ),
          ),
          Effect.ignore,
        );
    }),
  );
  yield* Effect.addFinalizer(() => stopAll);
  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          if (ready) return ready;
          yield* onPhase("starting", "Connecting to Limrun");
          const nodePath = yield* resolveNodeExecutable("Device automation").pipe(
            Effect.provide(nodeContext),
          );
          ready = {
            nodePath,
            hub: { origin: "http://127.0.0.1" },
            devices,
            run,
            readResponse: Effect.fn("LimrunDeviceHost.readResponse")(
              function* (route, search) {
                const helper = /^\/vendor\/serve-sim\/helper\/([^/]+)\/(ax|foreground)$/.exec(
                  route,
                );
                const id = helper?.[1] ?? search.get("device");
                const item = id ? live.get(id) : undefined;
                if (!item) return null;
                if (route.endsWith("/api/screenshot"))
                  return { body: yield* devices.screenshot(item.device), contentType: "image/png" };
                const connected = yield* runtime(item);
                const json = (value: unknown) =>
                  encodeJson(value).pipe(
                    Effect.map((text) => ({
                      body: new TextEncoder().encode(text),
                      contentType: "application/json",
                    })),
                  );
                if (helper?.[2] === "ax" && connected.platform === "ios")
                  return yield* json(
                    yield* LimrunApi.request("accessibility", () => connected.client.elementTree()),
                  );
                if (
                  route === "/vendor/serve-emu/api/accessibility" &&
                  connected.platform === "android"
                )
                  return yield* json(
                    yield* LimrunApi.request("accessibility", () =>
                      connected.client.getElementTree(),
                    ),
                  );
                if (route === "/vendor/serve-sim/api/event-log/events" && item.events)
                  return {
                    body: new TextEncoder().encode(
                      `retry: 1000\ndata: ${yield* encodeJson({ events: item.events })}\n\n`,
                    ),
                    contentType: "text/event-stream",
                  };
                return null;
              },
              Effect.mapError(failed("read device")),
            ),
            helpers: { serveSimAxSettings: null, serveSimCli: null },
            upstream: Effect.fn("LimrunDeviceHost.upstream")(function* (route) {
              const match = /^\/limrun\/([^/]+)\/(ws|watch)$/.exec(route);
              const item = match ? live.get(match[1]!) : undefined;
              if (!item?.instance.status.endpointWebSocketUrl || !item.instance.status.token)
                return null;
              const token =
                match![2] === "watch"
                  ? yield* api.watchToken(item.key, item.platform, item.instance.metadata.id).pipe(
                      Effect.catch(() =>
                        Effect.logWarning("Could not authorize Limrun preview", {
                          deviceId: item.instance.metadata.id,
                        }).pipe(Effect.as(null)),
                      ),
                    )
                  : item.instance.status.token;
              if (!token) return null;
              return {
                url: item.instance.status.endpointWebSocketUrl,
                headers: { authorization: `Bearer ${token}` },
                protocols: [],
              };
            }),
          };
          return ready;
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeviceHost.DeviceHostError({ hostId: config.id, step: "preparing Limrun", cause }),
        ),
      );
  const platforms = (["ios", "android"] as const).map((platform) => ({
    platform,
    available: true,
  }));
  return DeviceHost.DeviceHost.of({
    id: config.id,
    label: config.label,
    summary: Effect.sync((): DeviceHostSummary => ({
      id: config.id,
      kind: "limrun",
      label: config.label,
      platforms,
      hubInstalled: true,
      agentDeviceInstalled: cli !== undefined,
    })),
    platformAvailability: Effect.fn("LimrunDeviceHost.platformAvailability")((platform) =>
      Effect.succeed({ platform, available: true }),
    ),
    ensureReady,
    ensureAgentReady: Effect.fn("LimrunDeviceHost.ensureAgentReady")((onPhase) =>
      ensureReady(onPhase).pipe(Effect.map((value) => ({ ...value, agentDevice: null }))),
    ),
    current: Effect.sync(() => ready),
    stopAgent: lock.withPermit(
      Effect.suspend(() => Effect.forEach([...live.values()], stopDaemon, { discard: true })),
    ),
    stop: stopAll,
  });
});
