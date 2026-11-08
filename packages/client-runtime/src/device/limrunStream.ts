// @effect-diagnostics globalFetch:off globalTimers:off - Browser adapter without an Effect runtime.
import {
  createDeviceStream,
  DuoTouchController,
  getDuoDisplay,
  duoDisplayTurns,
  type DuoState,
} from "@limrun/ui/core";
import { createDuoControl, type DuoCommand } from "./duoControl.ts";
import { createCanvasFrameSink, type DeviceFrameSink } from "./frame.ts";
import { withDeviceHubQuery } from "./hubAccess.ts";
import type {
  DeviceScreenSize,
  DeviceStreamClient,
  DeviceStreamEvents,
  DeviceStreamTarget,
  DuoPanelSinks,
} from "./stream.ts";

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
  let duo: DuoState | null = null;
  let panels: DuoPanelSinks | null = null;
  let lastScreen: DeviceScreenSize | null = null;
  const duoTouch = new DuoTouchController((...args) => stream?.sendDisplayTouch(...args));
  const frames = new Map<"primary" | "inner", HTMLCanvasElement>();
  const orientations = {
    portrait: "portrait",
    portrait_upside_down: "pud",
    landscape_left: "landscape-left",
    landscape_right: "landscape-right",
  } as const;
  const duoControl = createDuoControl({
    send: ({ requestId, command }) => {
      if (!stream || !duo || !inputConnected) return false;
      const epoch = generation;
      const request =
        command.control === "angle"
          ? stream.sendDuoControl("setHingeAngle", { angleDegrees: command.value })
          : command.control === "orientation"
            ? stream.sendDuoControl("setDuoOrientation", {
                orientation: orientations[command.value],
              })
            : null;
      if (!request) return false;
      void request.then(
        () => {
          if (!stopped && epoch === generation) duoControl.receive({ requestId, ok: true });
        },
        () => {
          if (!stopped && epoch === generation)
            duoControl.receive({
              requestId,
              ok: false,
              error: "Could not update the Duo. Retry the control.",
            });
        },
      );
      return true;
    },
    onChange: (state) => events.onDuoControl?.(state),
  });
  const controlDuo = (command: DuoCommand) => {
    if (command.control === "angle" || command.control === "orientation")
      duoControl.enqueue(command);
    else
      events.onDuoControl?.({
        pending: false,
        requested: null,
        error: "This Limrun device does not support that physical pose.",
      });
  };
  const releaseTouch = () => duoTouch.release();
  const selectedDisplay = () => getDuoDisplay(duo);
  const route = `/limrun/${encodeURIComponent(target.deviceId)}`;
  const screen = (w: number, h: number) => {
    if (w === width && h === height) return;
    width = w;
    height = h;
    events.onScreen({ width, height, orientation: width > height ? "landscape_left" : "portrait" });
  };
  const input = (connected: boolean) => {
    if (connected === inputConnected) return;
    if (!connected) releaseTouch();
    inputConnected = connected;
    events.onInputConnected(connected);
  };
  const stop = () => {
    stopped = true;
    generation++;
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
    releaseTouch();
    duoControl.clear();
    stream?.dispose();
    duo = null;
    duoTouch.setDisplay(undefined);
    lastScreen = null;
    frames.clear();
    panels = null;
    width = height = 0;
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
  const publishDuo = (redraw = true) => {
    const display = selectedDisplay();
    if (!duo || !display) return;
    const frame = frames.get(display.id === "inner" ? "inner" : "primary");
    const orientation = (
      ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"] as const
    )[duoDisplayTurns(display.orientation)];
    duoTouch.setDisplay(display);
    const next: DeviceScreenSize = {
      width: frame?.width ?? display.width,
      height: frame?.height ?? display.height,
      orientation,
      // T3's model addresses its meshes as 1/3; HID uses the server's screenId below.
      screenId: display.id === "outer" ? 1 : 3,
      supportsHingeAngle: true,
      supportsPhysicalOrientation: false,
      hingeAngle: duo.angleDegrees,
      tableModeAvailable: false,
    };
    if (
      !lastScreen ||
      lastScreen.screenId !== next.screenId ||
      lastScreen.orientation !== orientation ||
      lastScreen.width !== next.width ||
      lastScreen.height !== next.height ||
      lastScreen.hingeAngle !== next.hingeAngle
    ) {
      // Cancel captured viewer input before publishing a different display to React.
      panels?.onScreen?.(next);
      lastScreen = next;
      width = next.width;
      height = next.height;
      events.onScreen(next);
    }
    if (frame && redraw) present(frame, frame.width, frame.height);
  };
  const displayTouch = (phase: "begin" | "move" | "end", x: number, y: number, raw: boolean) => {
    if (!inputConnected || !duo) return;
    const display = selectedDisplay();
    if (phase === "begin") {
      releaseTouch();
      if (!display || !frames.has(display.id === "inner" ? "inner" : "primary")) return;
    }
    duoTouch.touch(phase, x, y, raw);
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
    let innerAttached = false;
    const receiveFrame = (
      source: CanvasImageSource,
      w: number,
      h: number,
      display: "primary" | "inner",
    ) => {
      if (!active()) return;
      if (!duo) {
        if (display === "primary") present(source, w, h);
        return;
      }
      let frame = frames.get(display);
      if (!frame) {
        frame = document.createElement("canvas");
        frames.set(display, frame);
      }
      if (!createCanvasFrameSink(frame).present(source, w, h)) return;
      publishDuo(display === (selectedDisplay()?.id === "inner" ? "inner" : "primary"));
      const panel = display === "primary" ? panels?.cover : panels?.inner;
      panel?.present(frame, w, h);
    };
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
        if (!state.videoReady) {
          streaming = false;
          frames.clear();
        }
        if (state.duoState) {
          duo = state.duoState;
          if (!innerAttached) {
            innerAttached = true;
            client.attachFrameSink({ present: receiveFrame }, "inner");
          }
          publishDuo();
        }
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
    client.attachFrameSink({ present: receiveFrame });
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
  const rotate = () => {
    if (!duo) {
      stream?.rotate();
      return;
    }
    const cycle = [
      "portrait",
      "landscape_left",
      "portrait_upside_down",
      "landscape_right",
    ] as const;
    const orientation = duo.orientation;
    const index = cycle.findIndex((value) => orientations[value] === orientation);
    controlDuo({ control: "orientation", value: cycle[(index + 1) % cycle.length]! });
  };
  return {
    start,
    stop,
    setMjpegImage: () => {},
    sendTouch: (phase, x, y) =>
      duo ? displayTouch(phase, x, y, false) : touch(phase, x * width, y * height),
    sendRawTouch: (phase, x, y) => (duo ? displayTouch(phase, x, y, true) : touch(phase, x, y)),
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
      if (duo) controlDuo({ control: "orientation", value: orientation });
      else if (orientation.startsWith("landscape") !== width > height) rotate();
    },
    controlDuo,
    setDuoPanels: (next) => {
      panels = next;
      if (!panels || !duo) return;
      if (lastScreen) panels.onScreen?.(lastScreen);
      for (const [display, frame] of frames) {
        (display === "primary" ? panels.cover : panels.inner).present(
          frame,
          frame.width,
          frame.height,
        );
      }
    },
  };
}
