import { createDeviceStream, type DeviceFrameSink, type DeviceStreamState } from "@limrun/ui/core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createLimrunDeviceStreamClient } from "./limrunStream.ts";

vi.mock("@limrun/ui/core", () => ({ createDeviceStream: vi.fn() }));
const access = {
  httpBase: "https://t3.test/device",
  wsBase: "wss://t3.test/device",
  query: { hostId: "cloud", wsTicket: "ticket" },
  credentials: false,
};
const connected: DeviceStreamState = {
  connection: "connected",
  videoReady: true,
  controlReady: true,
  duo: false,
  duoState: null,
};
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const events = () => ({
  onStatus: vi.fn(),
  onScreen: vi.fn(),
  onInputConnected: vi.fn(),
  onUnauthorized: vi.fn(),
  onMjpegFallback: vi.fn(),
});
function sdkClient() {
  const sdk = {
    start: vi.fn(),
    dispose: vi.fn(),
    attachFrameSink: vi.fn<(sink: DeviceFrameSink) => () => void>(() => () => {}),
    sendTouch: vi.fn(),
    sendText: vi.fn(),
    sendKeyEvent: vi.fn(),
    pressButton: vi.fn(),
    rotate: vi.fn(),
  };
  vi.mocked(createDeviceStream).mockReturnValueOnce(
    sdk as unknown as ReturnType<typeof createDeviceStream>,
  );
  return sdk;
}

it("maps touches to presented frames and ignores old sessions after a restart", () => {
  const first = sdkClient();
  const second = sdkClient();
  const observed = events();
  const sink = { present: vi.fn(() => true) };
  const client = createLimrunDeviceStreamClient(
    { access, platform: "ios", deviceId: "ios_owned" },
    sink,
    observed,
  );
  client.start();
  client.start();
  client.sendTouch("begin", 0.5, 0.5);
  expect(first.sendTouch).not.toHaveBeenCalled();
  const oldOptions = vi.mocked(createDeviceStream).mock.calls[0]![0];
  const oldFrames = first.attachFrameSink.mock.calls[0]![0];
  oldOptions.onStateChange?.(connected);
  expect(observed.onStatus).not.toHaveBeenCalledWith("streaming");
  const frame = {} as CanvasImageSource;
  oldFrames.present(frame, 390, 844, "primary");
  expect(observed.onStatus).toHaveBeenLastCalledWith("streaming");
  client.sendTouch("begin", 0.5, 0.5);
  client.sendRawTouch("end", -20, 9999);
  expect(first.sendTouch.mock.calls).toEqual([
    ["begin", 195, 422, 390, 844],
    ["end", 0, 843, 390, 844],
  ]);
  client.stop();
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(observed.onInputConnected).toHaveBeenLastCalledWith(false);
  client.start();
  oldFrames.present(frame, 1, 1, "primary");
  oldOptions.onStateChange?.(connected);
  expect(sink.present).toHaveBeenCalledTimes(1);
  expect(observed.onStatus).toHaveBeenLastCalledWith("connecting");
  expect(observed.onInputConnected).toHaveBeenLastCalledWith(false);
  const current = vi.mocked(createDeviceStream).mock.calls[1]![0];
  current.onStateChange?.(connected);
  second.attachFrameSink.mock.calls[0]![0].present(frame, 844, 390, "primary");
  client.sendTouch("move", 0.25, 0.5);
  expect(second.sendTouch).toHaveBeenLastCalledWith("move", 211, 195, 844, 390);
  expect(observed.onScreen).toHaveBeenLastCalledWith({
    width: 844,
    height: 390,
    orientation: "landscape_left",
  });
  expect(vi.mocked(createDeviceStream)).toHaveBeenCalledTimes(2);
  client.stop();
});

it("keeps the T3 ticket on the hub transport and renews only failed opening handshakes", () => {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    readonly url: string;
    constructor(url: string) {
      super();
      this.url = url;
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  sdkClient();
  const observed = events();
  const client = createLimrunDeviceStreamClient(
    { access, platform: "android", deviceId: "android_owned" },
    { present: () => true },
    observed,
  );
  client.start();
  const options = vi.mocked(createDeviceStream).mock.calls[0]![0];
  expect(options.platform).toBe("android");
  options.transport!.connect();
  const first = sockets[0]!;
  const url = new URL(first.url);
  expect(url.origin + url.pathname).toBe("wss://t3.test/device/limrun/android_owned/ws");
  expect(Object.fromEntries(url.searchParams)).toEqual({ hostId: "cloud", wsTicket: "ticket" });
  first.dispatchEvent(new Event("open"));
  first.dispatchEvent(new Event("close"));
  expect(observed.onUnauthorized).not.toHaveBeenCalled();
  options.transport!.connect();
  sockets[1]!.dispatchEvent(new Event("close"));
  sockets[1]!.dispatchEvent(new Event("close"));
  expect(observed.onUnauthorized).toHaveBeenCalledOnce();
  client.stop();
});

it("preserves typed text, keyboard modifiers, and the app switcher command", () => {
  const sdk = sdkClient();
  const client = createLimrunDeviceStreamClient(
    { access, platform: "android", deviceId: "android_owned" },
    { present: () => true },
    events(),
  );
  client.start();
  const key = {
    key: "é",
    code: "KeyE",
    shiftKey: false,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
  } as KeyboardEvent;
  client.sendKey(key, "down");
  client.sendKey(key, "up");
  expect(sdk.sendText.mock.calls).toEqual([["é"]]);
  client.sendKey(
    { ...key, key: "c", code: "KeyC", altKey: false, ctrlKey: true } as KeyboardEvent,
    "down",
  );
  expect(sdk.sendKeyEvent).toHaveBeenLastCalledWith({
    type: "keydown",
    code: "KeyC",
    shiftKey: false,
    altKey: false,
    ctrlKey: true,
    metaKey: false,
  });
  client.pressButton("appSwitcher");
  expect(sdk.pressButton).toHaveBeenLastCalledWith("recents");
  client.stop();
  client.sendText("after stop");
  expect(sdk.sendText).toHaveBeenCalledTimes(1);
});

it("never opens a control socket for a read-only viewer and renews rejected credentials", async () => {
  vi.useFakeTimers();
  const socket = vi.fn();
  const fetch = vi.fn(
    async (_url: string, _options: RequestInit) => new Response(null, { status: 401 }),
  );
  vi.stubGlobal("WebSocket", socket);
  vi.stubGlobal("fetch", fetch);
  const observed = events();
  const client = createLimrunDeviceStreamClient(
    { access, platform: "ios", deviceId: "ios_owned", videoOnly: true },
    { present: () => true },
    observed,
  );
  client.start();
  client.sendText("forbidden");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch.mock.calls[0]?.[0]).toContain("/limrun/ios_owned/screenshot");
  expect(socket).not.toHaveBeenCalled();
  expect(createDeviceStream).not.toHaveBeenCalled();
  expect(observed.onUnauthorized).toHaveBeenCalledOnce();
  client.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("closes a read-only frame that finishes decoding after stop", async () => {
  vi.useFakeTimers();
  const decoded = Promise.withResolvers<ImageBitmap>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob())),
  );
  const decode = vi.fn(() => decoded.promise);
  vi.stubGlobal("createImageBitmap", decode);
  const sink = { present: vi.fn(() => true) };
  const client = createLimrunDeviceStreamClient(
    { access, platform: "ios", deviceId: "ios_owned", videoOnly: true },
    sink,
    events(),
  );
  client.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(decode).toHaveBeenCalledOnce();
  client.stop();
  const close = vi.fn();
  decoded.resolve({ width: 390, height: 844, close } as unknown as ImageBitmap);
  await vi.advanceTimersByTimeAsync(0);
  expect(close).toHaveBeenCalledOnce();
  expect(sink.present).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
