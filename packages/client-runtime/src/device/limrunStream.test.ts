import {
  createDeviceStream,
  type DeviceFrameSink,
  type DeviceStreamState,
  type StreamDisplay,
} from "@limrun/ui/core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createLimrunDeviceStreamClient } from "./limrunStream.ts";

vi.mock("@limrun/ui/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@limrun/ui/core")>()),
  createDeviceStream: vi.fn(),
}));
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
  onDuoControl: vi.fn(),
});
function sdkClient() {
  const sdk = {
    start: vi.fn(),
    dispose: vi.fn(),
    attachFrameSink: vi.fn<(sink: DeviceFrameSink, display?: StreamDisplay) => () => void>(
      () => () => {},
    ),
    sendTouch: vi.fn(),
    sendDisplayTouch: vi.fn(),
    sendDuoControl: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
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

const duoState: NonNullable<DeviceStreamState["duoState"]> = {
  angleDegrees: 180,
  minAngleDegrees: 0,
  maxAngleDegrees: 180,
  orientation: "portrait",
  displays: [
    {
      id: "outer",
      screenId: 1,
      trackId: "video0",
      width: 1398,
      height: 2034,
      scale: 3,
      orientation: 1,
    },
    {
      id: "inner",
      screenId: 2,
      trackId: "duo-inner",
      width: 2007,
      height: 2853,
      scale: 3,
      orientation: 3,
    },
  ],
};
function duoFixture() {
  const canvases: HTMLCanvasElement[] = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
      } as unknown as HTMLCanvasElement;
      canvases.push(canvas);
      return canvas;
    },
  });
  const sdk = sdkClient();
  const observed = events();
  const output = { present: vi.fn(() => true) };
  const client = createLimrunDeviceStreamClient(
    { access, platform: "ios", deviceId: "ios_duo" },
    output,
    observed,
  );
  client.start();
  const update = (state = duoState) =>
    vi
      .mocked(createDeviceStream)
      .mock.calls[0]![0].onStateChange?.({ ...connected, duo: true, duoState: state });
  update();
  const primary = sdk.attachFrameSink.mock.calls.find(([, display]) => display === undefined)![0];
  const inner = sdk.attachFrameSink.mock.calls.find(([, display]) => display === "inner")![0];
  return { client, sdk, observed, output, update, primary, inner, canvases };
}
it("switches Duo frames and releases input on the server display before a fold handoff", () => {
  const f = duoFixture();
  const image = {} as CanvasImageSource;
  f.primary.present(image, 466, 678, "primary");
  expect(f.output.present).not.toHaveBeenCalled();
  f.inner.present(image, 669, 951, "inner");
  expect(f.observed.onScreen).toHaveBeenLastCalledWith(
    expect.objectContaining({
      screenId: 3,
      width: 669,
      height: 951,
      orientation: "landscape_left",
      supportsPhysicalOrientation: false,
    }),
  );
  expect(f.output.present).toHaveBeenLastCalledWith(f.canvases[1], 669, 951);
  const panels = {
    cover: { present: vi.fn(() => true) },
    inner: { present: vi.fn(() => true) },
    onScreen: vi.fn(),
  };
  f.client.setDuoPanels(panels);
  expect(panels.cover.present).toHaveBeenCalledWith(f.canvases[0], 466, 678);
  expect(panels.inner.present).toHaveBeenCalledWith(f.canvases[1], 669, 951);
  f.client.sendTouch("begin", 0.25, 0.5);
  expect(f.sdk.sendDisplayTouch).toHaveBeenLastCalledWith(0, 2, 0.5, 0.75);
  f.update({ ...duoState, angleDegrees: 0 });
  expect(f.sdk.sendDisplayTouch).toHaveBeenLastCalledWith(1, 2, 0.5, 0.75);
  expect(f.output.present).toHaveBeenLastCalledWith(f.canvases[0], 466, 678);
  expect(panels.onScreen).toHaveBeenLastCalledWith(
    expect.objectContaining({ screenId: 1, hingeAngle: 0 }),
  );
  f.client.sendTouch("move", 0.8, 0.8);
  expect(f.sdk.sendDisplayTouch).toHaveBeenCalledTimes(2);
  f.client.sendRawTouch("begin", 0.2, 0.3);
  expect(f.sdk.sendDisplayTouch).toHaveBeenLastCalledWith(0, 1, 0.2, 0.3);
  vi.mocked(createDeviceStream).mock.calls[0]![0].onStateChange?.({
    ...connected,
    connection: "reconnecting",
    videoReady: false,
    controlReady: false,
    duo: true,
    duoState: { ...duoState, angleDegrees: 0 },
  });
  expect(f.sdk.sendDisplayTouch).toHaveBeenLastCalledWith(1, 1, 0.2, 0.3);
  f.update({ ...duoState, angleDegrees: 0 });
  const touches = f.sdk.sendDisplayTouch.mock.calls.length;
  f.client.sendRawTouch("begin", 0.2, 0.3);
  expect(f.sdk.sendDisplayTouch).toHaveBeenCalledTimes(touches);
  f.client.stop();
  const count = f.output.present.mock.calls.length;
  f.inner.present(image, 669, 951, "inner");
  expect(f.output.present).toHaveBeenCalledTimes(count);
});
it("serializes Duo hinge commands and discards replies from a stopped session", async () => {
  vi.useFakeTimers();
  const f = duoFixture();
  const first = Promise.withResolvers<void>();
  f.sdk.sendDuoControl.mockReturnValueOnce(first.promise);
  f.client.controlDuo({ control: "angle", value: 80 });
  f.client.controlDuo({ control: "angle", value: 90 });
  f.client.controlDuo({ control: "angle", value: 110 });
  expect(f.sdk.sendDuoControl.mock.calls).toEqual([["setHingeAngle", { angleDegrees: 80 }]]);
  first.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sdk.sendDuoControl.mock.calls).toEqual([
    ["setHingeAngle", { angleDegrees: 80 }],
    ["setHingeAngle", { angleDegrees: 110 }],
  ]);
  f.client.rotate();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.sdk.sendDuoControl).toHaveBeenLastCalledWith("setDuoOrientation", {
    orientation: "landscape-left",
  });
  const pending = Promise.withResolvers<void>();
  f.sdk.sendDuoControl.mockReturnValueOnce(pending.promise);
  f.client.controlDuo({ control: "angle", value: 0 });
  f.client.stop();
  const count = f.observed.onDuoControl.mock.calls.length;
  pending.reject(new Error("disconnected"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.observed.onDuoControl).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});
