import { createDeviceStreamClient } from "@t3tools/client-runtime/device/stream";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@t3tools/client-runtime/device/stream", async (original) => {
  const { createDeviceStreamClient } =
    await original<typeof import("@t3tools/client-runtime/device/stream")>();
  return { createDeviceStreamClient: vi.fn(createDeviceStreamClient) };
});

import { start, stop } from "./device-stream.browser";

const envelope = (tag: number, payload: number[]) => {
  const length = 1 + payload.length;
  return [
    length >>> 24,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    tag,
    ...payload,
  ];
};

function viewerFixture(supported: boolean) {
  vi.useFakeTimers();
  const configured: string[] = [];
  vi.stubGlobal(
    "VideoDecoder",
    class {
      static isConfigSupported = async () => ({ supported });
      state = "unconfigured";
      decodeQueueSize = 0;
      configure(config: VideoDecoderConfig) {
        configured.push(config.codec);
        this.state = "configured";
      }
      decode() {}
      close() {
        this.state = "closed";
      }
    },
  );
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      send() {}
      close() {}
    },
  );
  const videoBodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requested: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    requested.push(new URL(url).pathname);
    if (!url.includes("stream.avcc")) return Promise.resolve(new Response(null));
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(body) {
            videoBodies.push(body);
            init.signal?.addEventListener("abort", () => body.error(new Error("aborted")));
          },
        }),
      ),
    );
  });
  vi.stubGlobal("ReactNativeWebView", { postMessage() {} });
  start({
    platform: "ios",
    deviceId: "sim",
    access: {
      httpBase: "https://environment.test/api/device-hub",
      wsBase: "wss://environment.test/api/device-hub",
      credentials: false,
      query: {},
    },
    colors: {
      background: "black",
      foreground: "white",
      muted: "gray",
      buttonBackground: "black",
      buttonForeground: "white",
      buttonBorder: "gray",
    },
  });
  return { configured, requested, videoBodies };
}

describe("native iOS simulator viewer", () => {
  it.each([
    { supported: true, image: "" },
    { supported: false, image: "/api/device-hub/vendor/serve-sim/helper/sim/stream.mjpeg" },
  ])(
    "streams H.264 when WebCodecs decodes it, else MJPEG (supported: $supported)",
    async ({ supported, image }) => {
      try {
        const { configured, requested, videoBodies } = viewerFixture(supported);
        await vi.advanceTimersByTimeAsync(0);
        expect(requested).toContain("/api/device-hub/vendor/serve-sim/helper/sim/stream.avcc");
        videoBodies[0]!.enqueue(new Uint8Array(envelope(1, [1, 0x64, 0x00, 0x33])));
        await vi.advanceTimersByTimeAsync(0);
        expect(configured).toEqual(supported ? ["avc1.640033"] : []);
        const img = document.querySelector("img")!;
        expect(img.src && new URL(img.src).pathname).toBe(image);
        expect(img.style.display).toBe(supported ? "none" : "block");
      } finally {
        stop();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
});

it("folds a Limrun Duo in the mobile viewer and reports rejected commands", () => {
  const client = { start: vi.fn(), stop: vi.fn(), setMjpegImage: vi.fn(), controlDuo: vi.fn() };
  vi.mocked(createDeviceStreamClient)
    .mockClear()
    .mockReturnValueOnce(client as unknown as ReturnType<typeof createDeviceStreamClient>);
  vi.stubGlobal("ReactNativeWebView", { postMessage() {} });
  try {
    start({
      platform: "ios",
      deviceId: "ios_duo",
      access: {
        httpBase: "https://t3.test/device",
        wsBase: "wss://t3.test/device",
        query: {},
        credentials: false,
      },
      colors: {
        background: "black",
        foreground: "white",
        muted: "gray",
        buttonBackground: "black",
        buttonForeground: "white",
        buttonBorder: "gray",
      },
    });
    const events = vi.mocked(createDeviceStreamClient).mock.calls[0]![2];
    events.onInputConnected(true);
    events.onScreen({
      width: 669,
      height: 951,
      orientation: "landscape_left",
      supportsHingeAngle: true,
      hingeAngle: 180,
    });
    const controls = document.querySelector<HTMLElement>('[aria-label="Duo hinge"]')!;
    expect(controls.style.display).toBe("flex");
    const fold = controls.querySelector("button")!;
    expect(fold.disabled).toBe(false);
    fold.click();
    expect(client.controlDuo).toHaveBeenCalledWith({ control: "angle", value: 0 });
    events.onDuoControl?.({
      pending: true,
      requested: { control: "angle", value: 0 },
      error: null,
    });
    expect(fold.disabled).toBe(true);
    events.onDuoControl?.({ pending: false, requested: null, error: "Could not update the Duo" });
    expect(fold.disabled).toBe(false);
    expect(document.body.textContent).toContain("Could not update the Duo");
    events.onInputConnected(false);
    expect(fold.disabled).toBe(true);
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});
