import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { LimrunDeviceHostConfig } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as LimrunApi from "./LimrunApi.ts";
import * as LimrunDeviceHost from "./LimrunDeviceHost.ts";

const config: LimrunDeviceHostConfig = {
  kind: "limrun",
  id: "cloud",
  label: "Limrun",
  apiKey: "organization-key",
  region: "",
  maxConcurrentSessions: 1,
  maxSessionMinutes: 10,
  idleMinutes: 2,
  iosRunnerApp: "/runner.app",
};
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-limrun-host-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const removed: string[] = [];
  const commands: Array<ProcessRunner.ProcessRunInput> = [];
  const records = new Map<string, LimrunApi.Instance>();
  let sequence = 0;
  let refuseDelete = false;
  let loseCreateResponse = false;
  const slots = new Map<string, LimrunApi.Instance>();
  const api = LimrunApi.LimrunApi.of({
    create: (_key, platform, input) =>
      Effect.gen(function* () {
        const existing = slots.get(input.slot);
        if (existing) return existing;
        expect(input.hardMinutes).toBe(10);
        const id = `${platform}_${++sequence}`;
        const instance = {
          metadata: {
            id,
            displayName: "T3",
            createdAt: "2026-11-07T00:00:00Z",
            organizationId: "org_test",
            labels: { "t3code-host": input.owner },
          },
          spec: { model: "iphone", region: "useb", inactivityTimeout: "2m" },
          status: {
            state: "ready",
            apiUrl: `https://region.test/v1/${id}/api`,
            endpointWebSocketUrl: `wss://region.test/v1/${id}/stream`,
            token: `token-${id}`,
            adbWebSocketUrl: `wss://region.test/v1/${id}/adb`,
          },
        } as LimrunApi.Instance;
        records.set(id, instance);
        slots.set(input.slot, instance);
        if (loseCreateResponse)
          return yield* new LimrunApi.LimrunRequestError({
            operation: "create",
            cause: "response lost",
          });
        return instance;
      }),
    list: () => Effect.succeed([]),
    get: (_key, _platform, id) => Effect.succeed(records.get(id)!),
    remove: (_key, _platform, id) =>
      Effect.suspend(() => {
        if (refuseDelete)
          return Effect.fail(
            new LimrunApi.LimrunRequestError({
              operation: "delete",
              status: 503,
              cause: "offline",
            }),
          );
        removed.push(id);
        records.delete(id);
        return Effect.void;
      }),
    connect: (_instance, platform) =>
      Effect.succeed({
        platform,
        client: {
          disconnect() {},
          keepAlive() {},
          screenshot: async () => ({
            base64: "aW1hZ2U=",
            dataUri: "data:image/png;base64,aW1hZ2U=",
          }),
          startEventCapture: async () => {},
          streamEventCapture: () => () => {},
        },
      } as unknown as LimrunApi.Runtime),
  });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(input);
        const directory = input.env!.AGENT_DEVICE_STATE_DIR!;
        if (input.args[1] === "boot")
          yield* fs.writeFileString(
            `${directory}/daemon.json`,
            JSON.stringify({ httpPort: 4500 + commands.length, token: "daemon-token" }),
          );
        return {
          stdout: "{}",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }).pipe(Effect.orDie),
  });
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const host = yield* LimrunDeviceHost.make(
    config,
    Effect.succeed({ nodePath: "node", entryPath: "/agent/main.mjs" }),
  ).pipe(
    Effect.provideService(LimrunApi.LimrunApi, api),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(Scope.Scope, scope),
    Effect.provideService(HostProcess.Environment, {
      LIMRUN_API_KEY: "wrong-inherited-key",
      LIM_IOS_INSTANCE_TOKEN: "unrelated",
      AGENT_DEVICE_DAEMON_BASE_URL: "https://unrelated.test",
    }),
    Effect.provideService(SecretResolver.SecretResolver, {
      read: () => Effect.succeed([]),
      invalidate: () => Effect.void,
      label: (id) => Effect.succeed(id),
    }),
  );
  const ready = yield* host.ensureReady(() => Effect.void);
  return {
    host,
    ready,
    removed,
    commands,
    records,
    loseCreateResponse: () => {
      loseCreateResponse = true;
    },
    setRefuseDelete: (value: boolean) => {
      refuseDelete = value;
    },
  };
});

describe("Limrun device ownership", () => {
  it.effect("isolates attached agent credentials and proxies only owned instances", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const devices = (yield* f.ready.devices.list).devices;
      const id = yield* f.ready.devices.boot(devices.find((d) => d.platform === "android")!);
      const endpoint = yield* f.ready.devices.agentEndpoint!(id);
      expect(endpoint.agentDeviceId).toBeNull();
      expect(endpoint.stateDir).toContain("/limrun/cloud/");
      const env = f.commands[0]!.env!;
      expect(env.LIMRUN_API_KEY).toBeUndefined();
      expect(env.LIM_IOS_INSTANCE_TOKEN).toBeUndefined();
      expect(env.AGENT_DEVICE_DAEMON_BASE_URL).toBeUndefined();
      expect(env.LIM_ANDROID_INSTANCE_TOKEN).toBe(`token-${id}`);
      expect(env.LIM_ANDROID_INSTANCE_ADB_URL).toContain(id);
      expect(yield* f.ready.upstream!(`/limrun/${id}/ws`, new URLSearchParams())).toEqual({
        url: `wss://region.test/v1/${id}/stream`,
        headers: { authorization: `Bearer token-${id}` },
        protocols: [],
      });
      expect(
        yield* f.ready.upstream!("/limrun/someone-elses-device/ws", new URLSearchParams()),
      ).toBeNull();
      yield* f.host.stopAgent;
      expect(f.removed).toEqual([]);
      expect(f.commands.at(-1)!.args.slice(1, 3)).toEqual(["daemon", "stop"]);
      yield* f.ready.devices.shutdown({ id, platform: "android" });
      expect(f.removed).toEqual([id]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reuses an uncertain allocation instead of renting another device", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const catalog = (yield* f.ready.devices.list).devices;
      f.loseCreateResponse();
      expect((yield* f.ready.devices.boot(catalog[0]!).pipe(Effect.result))._tag).toBe("Failure");
      expect(f.records.size).toBe(1);
      expect((yield* f.ready.devices.boot(catalog[2]!).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* f.ready.devices.boot(catalog[0]!)).toBe([...f.records.keys()][0]);
      expect(f.records.size).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps failed deletions inside the concurrency limit and allows retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const device = (yield* f.ready.devices.list).devices[0]!;
      const id = yield* f.ready.devices.boot(device);
      f.setRefuseDelete(true);
      expect(
        (yield* f.ready.devices.shutdown({ id, platform: "ios" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* f.ready.devices.boot(device).pipe(Effect.result))._tag).toBe("Failure");
      f.setRefuseDelete(false);
      yield* f.ready.devices.shutdown({ id, platform: "ios" });
      expect(yield* f.ready.devices.boot(device)).not.toBe(id);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
