import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as LimrunApi from "./LimrunApi.ts";

it.effect.each(["ios", "android"] as const)("mints only short-lived %s watch grants", (platform) =>
  Effect.gen(function* () {
    using fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ token: "watch-token" }));
    const id = `${platform}_useb_01h455vb4pex5vsknk084sn02q`;
    const api = yield* LimrunApi.LimrunApi;
    const token = yield* api.watchToken("organization-key", platform, id);
    expect(token).toBe("watch-token");
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/v1/access_tokens");
    expect(JSON.parse(String(init!.body))).toEqual({
      permissions: [`${platform}:${id}:watch`],
      ttlSeconds: 300,
    });
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer organization-key");
  }).pipe(Effect.provide(LimrunApi.layer)),
);
