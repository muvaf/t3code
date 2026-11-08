import * as Random from "effect/Random";
import {
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DeviceHostSummary,
  type LimrunDeviceHostConfig,
} from "@t3tools/contracts";
import { deviceHostCatalog, type DeviceHostSession } from "@limrun/api/serve-sim-host";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as FiberMap from "effect/FiberMap";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerConfig from "../config.ts";
import * as AgentDeviceDaemon from "./AgentDeviceDaemon.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as LimrunApi from "./LimrunApi.ts";
import type { AgentDeviceCli } from "./SimlockDeviceHost.ts";

const catalog = deviceHostCatalog.map((target) => ({
  id: `limrun:${target.platform}:${target.model}`,
  platform: target.platform,
  name: target.name,
  version: target.platform === "ios" ? "iOS" : "Android",
  booted: false,
  physical: false,
  target,
}));

interface Running {
  session: DeviceHostSession;
  platform: DeviceHostSession["platform"];
  dir: string;
  cwd: string;
  daemon: Effect.Success<ReturnType<typeof AgentDeviceDaemon.make>>;
  endpoint?: DeviceHost.AgentDeviceBinding;
}

export const make = Effect.fn("LimrunDeviceHost.make")(function* (
  config: LimrunDeviceHostConfig,
  agentCli: AgentDeviceCli,
) {
  const api = yield* LimrunApi.LimrunApi;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const secrets = yield* SecretResolver.SecretResolver;
  const nodeContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof resolveNodeExecutable>>>();
  const daemonContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof AgentDeviceDaemon.make>>>();
  const lock = yield* Semaphore.make(1);
  const renewals = yield* FiberMap.make<string>();
  const live = new Map<string, Running>();
  const directory = path.join(server.stateDir, "device", "limrun", config.id);
  let hub: LimrunApi.Host | undefined;
  let ready: DeviceHost.DeviceHostReady | null = null;
  let cli: { nodePath: string; entryPath: string } | undefined;
  const unavailable = (reason: string, cause?: unknown) =>
    new DeviceHostUnavailableError({
      hostId: config.id,
      hostLabel: config.label,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });
  const failed = (operation: string) => (cause: unknown) =>
    new DeviceOperationError({ operation, reason: "request_failed", cause });
  const initialize = Effect.gen(function* () {
    if (hub) return hub;
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
    const key = config.apiKey
      ? yield* requireSettingsSecret(secrets, config.apiKey)
      : environment.LIMRUN_API_KEY;
    if (!key)
      return yield* unavailable(
        "Add a Limrun API key in Settings or set LIMRUN_API_KEY on the T3 server.",
      );
    hub = yield* api.createHost(key, {
      owner: { label: "t3code-host", value: identity },
      allocationLabel: "t3code-slot",
      displayName: "T3 Code",
      region: config.region,
      hardTimeout: `${config.maxSessionMinutes}m`,
      inactivityTimeout: `${config.idleMinutes}m`,
      maxConcurrentSessions: config.maxConcurrentSessions,
    });
    return hub;
  });
  const agent = Effect.fn("LimrunDeviceHost.agent")(function* (
    item: Running,
    args: ReadonlyArray<string>,
  ) {
    if (!cli) return yield* unavailable("Limrun agent tools are not ready.");
    return yield* item.daemon.run(cli, args);
  });
  const stopDaemon = (item: Running) =>
    Effect.suspend(() => (cli ? item.daemon.stop(cli) : Effect.void)).pipe(
      Effect.tapError(() =>
        Effect.logWarning("Could not stop Limrun agent daemon", {
          deviceId: item.session.id,
        }),
      ),
      Effect.ignore,
      Effect.tap(() =>
        Effect.sync(() => {
          delete item.endpoint;
        }),
      ),
    );
  const startAgent = Effect.fn("LimrunDeviceHost.startAgent")(function* (item: Running) {
    if (!cli) cli = yield* agentCli;
    const daemon = yield* item.daemon.start(cli);
    if (item.endpoint?.baseUrl === daemon.baseUrl && item.endpoint.token === daemon.token)
      return item.endpoint;
    // This instance owns its state directory; replace the persisted binding after a daemon restart.
    yield* agent(item, ["connect", "limrun", "--platform", item.platform, "--force"]);
    yield* agent(item, ["boot", "--platform", item.platform]);
    item.endpoint = {
      baseUrl: daemon.baseUrl,
      token: daemon.token,
      agentDeviceId: null,
      session: `t3-${item.session.slot}`,
      stateDir: item.dir,
      installDirectory: item.cwd,
    };
    return item.endpoint;
  });

  const releaseAgent = Effect.fn("LimrunDeviceHost.releaseAgent")(function* (id: string) {
    yield* FiberMap.remove(renewals, id);
    const item = live.get(id);
    if (item) yield* stopDaemon(item);
    live.delete(id);
  });
  const devices: DeviceHost.DeviceOperations = {
    list: lock
      .withPermit(
        Effect.gen(function* () {
          const host = yield* initialize;
          const sessions = yield* LimrunApi.request("list", () => host.list());
          const ids = new Set(sessions.map((session) => session.id));
          for (const id of live.keys()) if (!ids.has(id)) yield* releaseAgent(id);
          return {
            devices: [
              ...catalog,
              ...sessions.map((session) => ({
                ...catalog.find(
                  (device) => device.id === `limrun:${session.platform}:${session.model}`,
                )!,
                id: session.id,
                booted: true,
              })),
            ],
            detail: undefined,
          };
        }),
      )
      .pipe(Effect.mapError(failed("list"))),
    boot: (device, context) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            if (live.has(device.id)) return device.id;
            const template = catalog.find((candidate) => candidate.id === device.id);
            if (!template)
              return yield* unavailable(
                "This Limrun instance has ended. Open a new device from the list.",
              );
            const host = yield* initialize;
            const session = yield* LimrunApi.request("create", (signal) =>
              host.open(template.target, signal),
            );
            const dir = path.join(directory, session.slot);
            const cwd = context?.workspaceRoot ?? directory;
            const daemon = yield* AgentDeviceDaemon.make({
              hostId: config.id,
              stateDir: dir,
              cwd,
              session: `t3-${session.slot}`,
              environment: {
                ...Object.fromEntries(
                  Object.entries(environment).filter(
                    ([name]) =>
                      !/^(AGENT_DEVICE_|LIM_IOS_|LIM_ANDROID_|LIMRUN_|LIM_API_KEY$)/.test(name),
                  ),
                ),
                ELECTRON_RUN_AS_NODE: "1",
                ...session.agentEnv,
              },
            }).pipe(Effect.provide(daemonContext));
            const item: Running = { session, platform: session.platform, dir, cwd, daemon };
            live.set(session.id, item);
            yield* FiberMap.run(
              renewals,
              session.id,
              Effect.gen(function* () {
                while (true) {
                  yield* Effect.sleep("30 seconds");
                  if (item.endpoint)
                    yield* item.daemon.heartbeat(item.endpoint).pipe(
                      Effect.tapError(() =>
                        Effect.logWarning("Could not renew Limrun automation session", {
                          deviceId: session.id,
                        }),
                      ),
                      Effect.ignore,
                    );
                }
              }),
            );
            return session.id;
          }),
        )
        .pipe(Effect.mapError(failed("boot"))),
    attach: (device) =>
      live.has(device.id) ? Effect.void : Effect.fail(failed("attach")("Instance has ended")),
    shutdown: (device) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            if (hub) yield* LimrunApi.request("delete", () => hub!.remove(device.id));
            yield* releaseAgent(device.id);
          }),
        )
        .pipe(Effect.mapError(failed("shutdown"))),
    screenshot: Effect.fn("LimrunDeviceHost.screenshot")(
      (device) =>
        initialize.pipe(
          Effect.flatMap((host) =>
            LimrunApi.request("screenshot", () => host.screenshot(device.id)),
          ),
        ),
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
        if (!hub) return { stdout: "", stderr: "Limrun host is not ready", code: 1 };
        return yield* LimrunApi.request("device command", () => hub!.run(command, args, options));
      }).pipe(
        Effect.timeout(`${options?.timeoutMs ?? 30000} millis`),
        Effect.orElseSucceed(() => ({ stdout: "", stderr: "Limrun command failed", code: 1 })),
      ),
  );
  const stopAll = lock
    .withPermit(
      Effect.gen(function* () {
        if (!hub) return;
        const remaining = new Set(
          (yield* LimrunApi.request("stop", () => hub!.stop())).map((session) => session.id),
        );
        for (const id of live.keys()) if (!remaining.has(id)) yield* releaseAgent(id);
      }),
    )
    .pipe(Effect.orDie);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* FiberMap.clear(renewals);
      for (const item of live.values()) yield* stopDaemon(item);
      if (hub) yield* Effect.promise(() => hub!.close());
    }),
  );
  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          if (ready) return ready;
          yield* onPhase("starting", "Connecting to Limrun");
          const host = yield* initialize;
          const nodePath = yield* resolveNodeExecutable("Device automation").pipe(
            Effect.provide(nodeContext),
          );
          ready = {
            nodePath,
            hub: { origin: host.origin },
            devices,
            run,
            helpers: { serveSimAxSettings: null, serveSimCli: null },
            upstream: (route, search) =>
              Effect.succeed({
                url: `${host.origin}${route}${search.size ? `?${search}` : ""}`,
                headers: host.headers,
                protocols: [],
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
