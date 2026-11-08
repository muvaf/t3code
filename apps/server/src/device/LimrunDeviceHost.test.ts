import type { DeviceHostSession } from "@limrun/api/serve-sim-host";
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
};
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-limrun-host-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const removed: string[] = [];
  const commands: Array<ProcessRunner.ProcessRunInput> = [];
  const sessions = new Map<string, DeviceHostSession>();
  let sequence = 0;
  const api = LimrunApi.LimrunApi.of({
    createHost: (key, options) => {
      expect(key).toBe("organization-key");
      expect(options.owner.label).toBe("t3code-host");
      expect(options.hardTimeout).toBe("10m");
      return Effect.succeed({
        origin: "http://127.0.0.1:12345",
        headers: { authorization: "Bearer hub-secret" },
        list: async () => [...sessions.values()],
        open: async (target) => {
          const id = `${target.platform}_${++sequence}`;
          const session: DeviceHostSession = {
            ...target,
            id,
            slot: `slot-${sequence}`,
            instance: {
              metadata: { id, createdAt: "2026-11-08T00:00:00Z", organizationId: "org_test" },
              spec: { region: "useb", inactivityTimeout: "2m" },
              status: { state: "ready" },
            },
            agentEnv:
              target.platform === "ios"
                ? {
                    LIM_IOS_INSTANCE_URL: `https://instance.test/${id}`,
                    LIM_IOS_INSTANCE_TOKEN: `token-${id}`,
                  }
                : {
                    LIM_ANDROID_INSTANCE_URL: `https://instance.test/${id}`,
                    LIM_ANDROID_INSTANCE_TOKEN: `token-${id}`,
                    LIM_ANDROID_INSTANCE_ADB_URL: `wss://instance.test/${id}/adb`,
                  },
          };
          sessions.set(id, session);
          return session;
        },
        remove: async (id) => {
          removed.push(id);
          sessions.delete(id);
        },
        stop: async () => {
          sessions.clear();
          return [];
        },
        close: async () => {
          sessions.clear();
        },
        screenshot: async () => new Uint8Array(Buffer.from("image")),
        run: async () => ({ stdout: "", stderr: "", code: 0 }),
      });
    },
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
  return { host, ready, removed, commands, sessions };
});

describe("Limrun host binding", () => {
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
      expect(
        yield* f.ready.upstream!(`/vendor/serve-emu/api`, new URLSearchParams({ device: id })),
      ).toEqual({
        url: `http://127.0.0.1:12345/vendor/serve-emu/api?device=${id}`,
        headers: { authorization: "Bearer hub-secret" },
        protocols: [],
      });
      yield* f.host.stopAgent;
      expect(f.removed).toEqual([]);
      expect(f.commands.at(-1)!.args.slice(1, 3)).toEqual(["daemon", "stop"]);
      yield* f.ready.devices.shutdown({ id, platform: "android" });
      expect(f.removed).toEqual([id]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("retains Duo identity and stops automation when an instance ends externally", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const template = (yield* f.ready.devices.list).devices.find(
        (device) => device.id === "limrun:ios:iphone-duo",
      )!;
      const id = yield* f.ready.devices.boot(template);
      expect((yield* f.ready.devices.list).devices.find((device) => device.id === id)?.name).toBe(
        "iPhone Duo",
      );
      yield* f.ready.devices.agentEndpoint!(id);
      expect(f.commands[0]!.env!.LIM_IOS_INSTANCE_TOKEN).toBe(`token-${id}`);
      f.sessions.delete(id);
      expect((yield* f.ready.devices.list).devices.some((device) => device.id === id)).toBe(false);
      expect(f.commands.at(-1)!.args.slice(1, 3)).toEqual(["daemon", "stop"]);
      expect(f.removed).toEqual([]);
      expect((yield* f.ready.devices.agentEndpoint!(id).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
