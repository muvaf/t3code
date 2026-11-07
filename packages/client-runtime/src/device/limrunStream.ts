// @effect-diagnostics globalFetch:off globalTimers:off - Browser adapter without an Effect runtime.
import { createDeviceStream } from "@limrun/ui/core";
import { createCanvasFrameSink, type DeviceFrameSink } from "./frame.ts";
import { withDeviceHubQuery } from "./hubAccess.ts";
import type { DeviceStreamClient, DeviceStreamEvents, DeviceStreamTarget } from "./stream.ts";

export function createLimrunDeviceStreamClient(
  target: DeviceStreamTarget,
  output: HTMLCanvasElement | DeviceFrameSink,
  events: DeviceStreamEvents,
): DeviceStreamClient {
  const sink = "present" in output ? output : createCanvasFrameSink(output);
  let stopped = true;
  let generation = 0;
  let stream: ReturnType<typeof createDeviceStream> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let width = 0;
  let height = 0;
  let streaming = false;
  let inputConnected = false;
  const route = `/limrun/${encodeURIComponent(target.deviceId)}`;
  const screen = (w: number, h: number) => {
    if (w === width && h === height) return;
    width = w;
    height = h;
    events.onScreen({ width, height, orientation: width > height ? "landscape_left" : "portrait" });
  };
  const input = (connected: boolean) => {
    if (connected === inputConnected) return;
    inputConnected = connected;
    events.onInputConnected(connected);
  };
  const stop = () => {
    stopped = true;
    generation++;
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
    stream?.dispose();
    stream = undefined;
    streaming = false;
    input(false);
  };
  const unauthorized = () => {
    stop();
    events.onUnauthorized();
  };
  const present = (source: CanvasImageSource, w: number, h: number) => {
    screen(w, h);
    if (sink.present(source, w, h) && !streaming) {
      streaming = true;
      events.onStatus("streaming");
    }
  };
  // The hub only admits control-authorized viewers to the Limrun signaling endpoint.
  const readFrame = async (epoch: number) => {
    const active = () => !stopped && epoch === generation;
    if (!active()) return;
    controller = new AbortController();
    try {
      const response = await fetch(
        withDeviceHubQuery(`${target.access.httpBase}${route}/screenshot`, target.access),
        { credentials: target.access.credentials ? "include" : "omit", signal: controller.signal },
      );
      if (!active()) return;
      if (response.status === 401 || response.status === 403) {
        unauthorized();
        return;
      }
      if (!response.ok) throw new Error("Screenshot unavailable");
      const bitmap = await createImageBitmap(await response.blob());
      try {
        if (active()) present(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch {
      if (!active()) return;
      streaming = false;
      events.onStatus("connecting", "Reconnecting to Limrun…");
    }
    if (active()) timer = setTimeout(() => void readFrame(epoch), 1000);
  };
  const start = () => {
    if (!stopped) return;
    stopped = false;
    const epoch = ++generation;
    const active = () => !stopped && epoch === generation;
    events.onStatus("connecting");
    if (target.videoOnly) {
      void readFrame(epoch);
      return;
    }
    const client = createDeviceStream({
      platform: target.platform,
      autoReconnect: true,
      transport: {
        connect: () => {
          const socket = new WebSocket(
            withDeviceHubQuery(`${target.access.wsBase}${route}/ws`, target.access),
          );
          let opened = false;
          socket.addEventListener(
            "open",
            () => {
              opened = true;
            },
            { once: true },
          );
          socket.addEventListener(
            "close",
            () => {
              if (active() && !opened) unauthorized();
            },
            { once: true },
          );
          return socket;
        },
      },
      onStateChange: (state) => {
        if (!active()) return;
        input(state.controlReady);
        if (!state.videoReady) streaming = false;
        if (state.connection === "connecting" || state.connection === "reconnecting")
          events.onStatus(
            "connecting",
            state.connection === "reconnecting" ? "Reconnecting to Limrun…" : undefined,
          );
        else if (state.connection === "failed")
          events.onStatus("error", "Unable to connect to the Limrun device.");
        else if (state.connection === "terminated")
          events.onStatus("error", "The Limrun device has ended.");
      },
    });
    stream = client;
    client.attachFrameSink({
      present: (source, w, h) => {
        if (active()) present(source, w, h);
      },
    });
    client.start();
  };
  const touch = (phase: "begin" | "move" | "end", x: number, y: number) => {
    if (!width || !height) return;
    stream?.sendTouch(
      phase,
      Math.max(0, Math.min(width - 1, x)),
      Math.max(0, Math.min(height - 1, y)),
      width,
      height,
    );
  };
  const rotate = () => stream?.rotate();
  return {
    start,
    stop,
    setMjpegImage: () => {},
    sendTouch: (phase, x, y) => touch(phase, x * width, y * height),
    sendRawTouch: touch,
    sendText: (text) => stream?.sendText(text),
    sendKey: (event, phase) => {
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        if (phase === "down") stream?.sendText(event.key);
      } else
        stream?.sendKeyEvent({
          type: phase === "down" ? "keydown" : "keyup",
          code: event.code || event.key,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
        });
    },
    pressButton: (button) => stream?.pressButton(button === "appSwitcher" ? "recents" : button),
    rotate,
    setOrientation: (orientation) => {
      if (orientation.startsWith("landscape") !== width > height) rotate();
    },
    controlDuo: () => events.onDuoUnavailable?.("This Limrun device does not expose Duo controls."),
    setDuoPanels: () => {},
  };
}
