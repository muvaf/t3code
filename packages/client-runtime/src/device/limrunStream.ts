// @effect-diagnostics globalFetch:off globalTimers:off globalJsonInEffect:off cryptoRandomUUID:off globalDate:off - Browser transport without an Effect runtime.
import { createCanvasFrameSink, type DeviceFrameSink } from "./frame.ts";
import { withDeviceHubQuery } from "./hubAccess.ts";
import type { DeviceStreamClient, DeviceStreamEvents, DeviceStreamTarget } from "./stream.ts";

/** Limrun's control channel uses scrcpy's binary messages on both platforms. */
export function limrunTouch(
  phase: "begin" | "move" | "end",
  x: number,
  y: number,
  width: number,
  height: number,
): ArrayBuffer {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  view.setUint8(0, 2);
  view.setUint8(1, phase === "begin" ? 0 : phase === "end" ? 1 : 2);
  view.setBigInt64(2, 0n, true);
  view.setInt32(10, Math.round(Math.max(0, Math.min(width - 1, x))), true);
  view.setInt32(14, Math.round(Math.max(0, Math.min(height - 1, y))), true);
  view.setUint16(18, width, true);
  view.setUint16(20, height, true);
  view.setUint16(22, phase === "end" ? 0 : 0xffff, true);
  return buffer;
}

export function createLimrunDeviceStreamClient(
  target: DeviceStreamTarget,
  output: HTMLCanvasElement | DeviceFrameSink,
  events: DeviceStreamEvents,
): DeviceStreamClient {
  const sink = "present" in output ? output : createCanvasFrameSink(output);
  let stopped = true;
  let generation = 0;
  let socket: WebSocket | undefined;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let video: HTMLVideoElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let paint = 0;
  let controller: AbortController | undefined;
  let width = 0;
  let height = 0;
  let lastFrame = 0;
  const route = `/limrun/${encodeURIComponent(target.deviceId)}`;
  const screen = (w: number, h: number) => {
    if (w === width && h === height) return;
    width = w;
    height = h;
    events.onScreen({ width, height, orientation: width > height ? "landscape_left" : "portrait" });
  };
  const disconnect = () => {
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
    clearInterval(watchdog);
    cancelAnimationFrame(paint);
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close();
      socket = undefined;
    }
    if (peer) {
      peer.ontrack = null;
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.close();
      peer = undefined;
    }
    channel?.close();
    channel = undefined;
    if (video) {
      video.pause();
      video.srcObject = null;
      video.remove();
      video = undefined;
    }
    events.onInputConnected(false);
  };
  const retry = (epoch: number) => {
    if (stopped || epoch !== generation) return;
    generation++;
    disconnect();
    events.onStatus("connecting", "Reconnecting to Limrun…");
    timer = setTimeout(startAttempt, 1000);
  };
  // Read-only viewers never receive a peer with a control channel.
  const readFrame = async (epoch: number) => {
    controller = new AbortController();
    try {
      const response = await fetch(
        withDeviceHubQuery(`${target.access.httpBase}${route}/screenshot`, target.access),
        { credentials: target.access.credentials ? "include" : "omit", signal: controller.signal },
      );
      if (response.status === 401 || response.status === 403) {
        events.onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error("Screenshot unavailable");
      const bitmap = await createImageBitmap(await response.blob());
      if (!stopped && epoch === generation) {
        screen(bitmap.width, bitmap.height);
        sink.present(bitmap, bitmap.width, bitmap.height);
        events.onStatus("streaming");
      }
      bitmap.close();
      if (!stopped && epoch === generation) timer = setTimeout(() => void readFrame(epoch), 1000);
    } catch {
      retry(epoch);
    }
  };
  const startAttempt = () => {
    if (stopped) return;
    const epoch = ++generation;
    events.onStatus("connecting");
    if (target.videoOnly) {
      void readFrame(epoch);
      return;
    }
    const active = () => !stopped && epoch === generation;
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 15) | 64;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    const sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    let streaming = false;
    const ws = new WebSocket(
      withDeviceHubQuery(`${target.access.wsBase}${route}/ws`, target.access),
    );
    socket = ws;
    const send = (value: object) => {
      if (active() && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ ...value, sessionId }));
    };
    let opened = false;
    ws.onopen = () => {
      opened = true;
      send({ type: "requestRtcConfiguration" });
    };
    ws.onclose = () => {
      if (!active()) return;
      if (!opened) {
        generation++;
        disconnect();
        events.onUnauthorized();
      } else retry(epoch);
    };
    ws.onerror = () => {
      if (opened) retry(epoch);
    };
    const candidates: RTCIceCandidateInit[] = [];
    let messages = Promise.resolve();
    const onMessage = async (data: unknown) => {
      if (!active() || typeof data !== "string") return;
      const message = JSON.parse(data) as {
        type?: string;
        rtcConfiguration?: RTCConfiguration;
        sdp?: string;
        candidate?: string;
        sdpMid?: string;
        sdpMLineIndex?: number;
      };
      if (message.type === "rtcConfiguration" && !peer) {
        const pc = new RTCPeerConnection(message.rtcConfiguration);
        peer = pc;
        const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
        const codecs = globalThis.RTCRtpReceiver?.getCapabilities?.("video")?.codecs;
        if (codecs && videoTransceiver.setCodecPreferences) {
          // Match Limrun UI's encoder preferences instead of the browser's default order.
          const priority = (codec: RTCRtpCodec) => {
            const mimeType = codec.mimeType.toLowerCase();
            if (mimeType.includes("vp9")) return 1;
            if (mimeType.includes("h265") || mimeType.includes("hevc")) return 2;
            if (mimeType.includes("h264") || mimeType.includes("avc")) return 3;
            return 4;
          };
          videoTransceiver.setCodecPreferences(
            [...codecs].sort((a, b) => priority(a) - priority(b)),
          );
        }
        pc.addTransceiver("audio", { direction: "recvonly" });
        const control = pc.createDataChannel("control", { negotiated: true, ordered: true, id: 1 });
        channel = control;
        control.onopen = () => {
          if (active()) {
            events.onInputConnected(true);
            send({ type: "requestFrame" });
          }
        };
        control.onclose = () => {
          if (active()) events.onInputConnected(false);
        };
        pc.onicecandidate = (event) => {
          if (event.candidate) send({ type: "candidate", ...event.candidate.toJSON() });
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed") retry(epoch);
        };
        pc.ontrack = (event) => {
          if (!active() || event.track.kind !== "video") return;
          const element = document.createElement("video");
          video = element;
          element.autoplay = true;
          element.muted = true;
          element.playsInline = true;
          element.srcObject = new MediaStream([event.track]);
          const draw = () => {
            if (!active() || video !== element) return;
            if (element.readyState >= 2 && element.videoWidth > 0) {
              screen(element.videoWidth, element.videoHeight);
              if (sink.present(element, width, height)) {
                lastFrame = Date.now();
                if (!streaming) {
                  streaming = true;
                  events.onStatus("streaming");
                }
              }
            }
            if (element.requestVideoFrameCallback) element.requestVideoFrameCallback(draw);
            else paint = requestAnimationFrame(draw);
          };
          void element
            .play()
            .then(draw)
            .catch(() => retry(epoch));
        };
        const offer = await pc.createOffer();
        if (!active()) return;
        await pc.setLocalDescription(offer);
        send({ type: "offer", sdp: offer.sdp });
      } else if (message.type === "answer" && peer && message.sdp) {
        await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
        for (const candidate of candidates.splice(0)) {
          if (!active() || !peer) return;
          await peer.addIceCandidate(candidate);
        }
      } else if (message.type === "candidate" && message.candidate) {
        const candidate = {
          candidate: message.candidate,
          sdpMid: message.sdpMid ?? null,
          sdpMLineIndex: message.sdpMLineIndex ?? null,
        };
        if (peer?.remoteDescription) await peer.addIceCandidate(candidate);
        else candidates.push(candidate);
      } else if (message.type === "error") retry(epoch);
    };
    ws.onmessage = (event) => {
      messages = messages.then(() => onMessage(event.data)).catch(() => retry(epoch));
    };
    lastFrame = Date.now();
    watchdog = setInterval(() => {
      if (Date.now() - lastFrame > 15000) retry(epoch);
      else send({ type: "requestFrame" });
    }, 5000);
  };
  const send = (buffer: ArrayBuffer) => {
    if (!stopped && !target.videoOnly && channel?.readyState === "open") channel.send(buffer);
  };
  const key = (code: number, up = false) => {
    const buffer = new ArrayBuffer(14);
    const view = new DataView(buffer);
    view.setUint8(1, up ? 1 : 0);
    view.setInt32(2, code, true);
    send(buffer);
  };
  const text = (value: string) => {
    const encoded = new TextEncoder().encode(value);
    const buffer = new ArrayBuffer(14 + encoded.length);
    const view = new DataView(buffer);
    view.setUint8(0, 9);
    view.setUint8(9, 1);
    view.setUint32(10, encoded.length);
    new Uint8Array(buffer).set(encoded, 14);
    send(buffer);
  };
  const touch = (phase: "begin" | "move" | "end", x: number, y: number) => {
    if (width && height) send(limrunTouch(phase, x, y, width, height));
  };
  const rotate = () => send(new Uint8Array([11]).buffer);
  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      startAttempt();
    },
    stop: () => {
      stopped = true;
      generation++;
      disconnect();
    },
    setMjpegImage: () => {},
    sendTouch: (phase, x, y) => touch(phase, x * width, y * height),
    sendRawTouch: touch,
    sendText: text,
    sendKey: (event, phase) => {
      const code = (
        {
          Enter: 66,
          Backspace: 67,
          Tab: 61,
          Escape: 111,
          ArrowUp: 19,
          ArrowDown: 20,
          ArrowLeft: 21,
          ArrowRight: 22,
          Delete: 112,
        } as Record<string, number>
      )[event.key];
      if (code !== undefined) key(code, phase === "up");
      else if (phase === "down" && event.key.length === 1 && !event.metaKey && !event.ctrlKey)
        text(event.key);
    },
    pressButton: (button) => {
      const code = { home: 3, back: 4, recents: 187, appSwitcher: 187, power: 26 }[button];
      key(code);
      key(code, true);
    },
    rotate,
    setOrientation: (orientation) => {
      if (orientation.startsWith("landscape") !== width > height) rotate();
    },
    controlDuo: () => events.onDuoUnavailable?.("This Limrun device does not expose Duo controls."),
    setDuoPanels: () => {},
  };
}
