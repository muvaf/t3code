import { afterEach, expect, it, vi } from "vite-plus/test";
import { createLimrunDeviceStreamClient, limrunTouch } from "./limrunStream.ts";

const access = {
  httpBase: "https://t3.test/device",
  wsBase: "wss://t3.test/device",
  query: { hostId: "cloud", wsTicket: "ticket" },
  credentials: false,
};
afterEach(() => {
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

it("normalizes touch coordinates to the actual frame and releases pressure on touch-up", () => {
  const down = new DataView(limrunTouch("begin", 120, 250, 390, 844));
  expect([
    down.getUint8(0),
    down.getUint8(1),
    down.getInt32(10, true),
    down.getInt32(14, true),
    down.getUint16(18, true),
    down.getUint16(20, true),
    down.getUint16(22, true),
  ]).toEqual([2, 0, 120, 250, 390, 844, 65535]);
  const up = new DataView(limrunTouch("end", -20, 9999, 390, 844));
  expect([
    up.getUint8(1),
    up.getInt32(10, true),
    up.getInt32(14, true),
    up.getUint16(22, true),
  ]).toEqual([1, 0, 843, 0]);
});

it("never opens a control socket for a read-only viewer and renews rejected credentials", async () => {
  vi.useFakeTimers();
  const socket = vi.fn();
  const fetch = vi.fn(
    async (_url: string, _options: RequestInit) => new Response(null, { status: 401 }),
  );
  vi.stubGlobal("WebSocket", socket);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const observed = events();
  const client = createLimrunDeviceStreamClient(
    { access, platform: "ios", deviceId: "ios_owned", videoOnly: true },
    { present: () => true },
    observed,
  );
  client.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch.mock.calls[0]?.[0]).toContain("/limrun/ios_owned/screenshot");
  expect(socket).not.toHaveBeenCalled();
  expect(observed.onUnauthorized).toHaveBeenCalledOnce();
  client.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("queues early ICE candidates, isolates signaling sessions, and stops pending reconnects", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    send = vi.fn();
    close = vi.fn();
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    message(value: object) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  const peers: FakePeer[] = [];
  const setCodecPreferences = vi.fn();
  const codecs = ["VP8", "H264", "H265", "VP9", "rtx"].map((name) => ({
    mimeType: `video/${name}`,
    clockRate: 90000,
  }));
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs }) });
  class FakePeer {
    remoteDescription: unknown = null;
    addTransceiver = vi.fn(() => ({ setCodecPreferences }));
    createDataChannel = vi.fn(() => ({ close: vi.fn(), readyState: "open" }));
    createOffer = vi.fn(async () => ({ type: "offer", sdp: "local-sdp" }));
    setLocalDescription = vi.fn(async () => {});
    setRemoteDescription = vi.fn(async (description: unknown) => {
      this.remoteDescription = description;
    });
    addIceCandidate = vi.fn(async () => {});
    close = vi.fn();
    constructor() {
      peers.push(this);
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  const client = createLimrunDeviceStreamClient(
    { access, platform: "android", deviceId: "android_owned" },
    { present: () => true },
    events(),
  );
  client.start();
  const socket = sockets[0]!;
  socket.onopen?.();
  socket.message({ type: "candidate", candidate: "early", sdpMid: "0", sdpMLineIndex: 0 });
  socket.message({ type: "rtcConfiguration", rtcConfiguration: { iceServers: [] } });
  await vi.advanceTimersByTimeAsync(0);
  expect(setCodecPreferences).toHaveBeenCalledWith([
    codecs[3],
    codecs[2],
    codecs[1],
    codecs[0],
    codecs[4],
  ]);
  expect(peers[0]!.createOffer.mock.invocationCallOrder[0]).toBeGreaterThan(
    setCodecPreferences.mock.invocationCallOrder[0]!,
  );
  expect(peers[0]!.addIceCandidate).not.toHaveBeenCalled();
  socket.message({ type: "answer", sdp: "remote-sdp" });
  await vi.advanceTimersByTimeAsync(0);
  expect(peers[0]!.addIceCandidate).toHaveBeenCalledWith({
    candidate: "early",
    sdpMid: "0",
    sdpMLineIndex: 0,
  });
  const sent = socket.send.mock.calls.map(
    ([value]) => JSON.parse(value as string) as { sessionId: string },
  );
  expect(new Set(sent.map((value) => value.sessionId)).size).toBe(1);
  expect(peers[0]!.createDataChannel).toHaveBeenCalledWith("control", {
    negotiated: true,
    ordered: true,
    id: 1,
  });
  socket.onclose?.();
  client.stop();
  await vi.advanceTimersByTimeAsync(30000);
  expect(sockets).toHaveLength(1);
  expect(peers[0]!.close).toHaveBeenCalledOnce();
});
