"use client";

/**
 * Keyboard flight control panel — WASD + QE + Space for manual drone control.
 * Sends MANUAL_CONTROL at 20 Hz while keys are held.
 *
 * Key mapping (ArduPilot MANUAL_CONTROL axes, -1000..1000):
 *   W/S  → pitch forward/back (x)
 *   A/D  → roll left/right (y)
 *   ↑/↓  → throttle up/down (z, 0..1000)
 *   Q/E  → yaw left/right (r)
 *   Space → arm/disarm toggle (confirmation required)
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { Gamepad2, ChevronDown, ChevronRight } from "lucide-react";
import { useDroneManager } from "@/stores/drone-manager";

const SEND_HZ = 20;
const STEP = 400;       // axis increment per tick
const THROTTLE_STEP = 30;
const THROTTLE_IDLE = 500;  // mid throttle when no key pressed

const KEY_MAP: Record<string, string> = {
  KeyW: "pitchFwd",
  KeyS: "pitchBack",
  KeyA: "rollLeft",
  KeyD: "rollRight",
  ArrowUp: "throttleUp",
  ArrowDown: "throttleDown",
  KeyQ: "yawLeft",
  KeyE: "yawRight",
};

export function KeyboardFlightControl({ droneId }: { droneId: string }) {
  const getProtocol = useDroneManager((s) => s.getSelectedProtocol);

  const [enabled, setEnabled] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [axes, setAxes] = useState({ x: 0, y: 0, z: THROTTLE_IDLE, r: 0 });

  const heldKeys = useRef<Set<string>>(new Set());
  const throttleRef = useRef(THROTTLE_IDLE);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const enabledRef = useRef(false);
  enabledRef.current = enabled;

  const sendTick = useCallback(() => {
    if (!enabledRef.current) return;
    const adapter = getProtocol(droneId);
    if (!adapter) return;

    const keys = heldKeys.current;
    let x = 0, y = 0, r = 0;

    if (keys.has("pitchFwd"))   x =  STEP;
    if (keys.has("pitchBack"))  x = -STEP;
    if (keys.has("rollRight"))  y =  STEP;
    if (keys.has("rollLeft"))   y = -STEP;
    if (keys.has("yawRight"))   r =  STEP;
    if (keys.has("yawLeft"))    r = -STEP;

    if (keys.has("throttleUp"))   throttleRef.current = Math.min(1000, throttleRef.current + THROTTLE_STEP);
    if (keys.has("throttleDown")) throttleRef.current = Math.max(0,    throttleRef.current - THROTTLE_STEP);

    const z = throttleRef.current;
    setAxes({ x, y, z, r });

    // sendManualControl(roll, pitch, throttle, yaw, buttons)
    adapter.sendManualControl(y, x, z, r, 0);
  }, [droneId, getProtocol]);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }

    intervalRef.current = setInterval(sendTick, 1000 / SEND_HZ);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled, sendTick]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      // Don't capture when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const action = KEY_MAP[e.code];
      if (action) { e.preventDefault(); heldKeys.current.add(action); }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const action = KEY_MAP[e.code];
      if (action) heldKeys.current.delete(action);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const pct = (v: number, lo = -1000, hi = 1000) =>
    Math.round(((v - lo) / (hi - lo)) * 100);

  return (
    <div className="border border-border-default bg-bg-secondary">
      <button
        onClick={() => setExpanded((p) => !p)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-mono text-text-tertiary uppercase tracking-wider hover:text-text-secondary cursor-pointer"
      >
        <Gamepad2 size={12} />
        Keyboard Control
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Enable toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <div
              onClick={() => setEnabled((p) => !p)}
              className={`w-8 h-4 rounded-full transition-colors relative ${enabled ? "bg-accent-primary" : "bg-bg-tertiary border border-border-default"}`}
            >
              <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? "translate-x-4" : "translate-x-0.5"}`} />
            </div>
            <span className={`text-xs font-mono ${enabled ? "text-accent-primary" : "text-text-tertiary"}`}>
              {enabled ? "ACTIVE" : "INACTIVE"}
            </span>
          </label>

          {/* Key map reference */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {[
              ["W / S", "Pitch fwd / back"],
              ["A / D", "Roll left / right"],
              ["↑ / ↓", "Throttle up / down"],
              ["Q / E", "Yaw left / right"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center gap-1.5 col-span-1">
                <kbd className="px-1.5 py-0.5 bg-bg-tertiary rounded text-[10px] font-mono text-text-secondary whitespace-nowrap">{k}</kbd>
                <span className="text-[10px] text-text-tertiary truncate">{v}</span>
              </div>
            ))}
          </div>

          {/* Live axis bars */}
          {enabled && (
            <div className="space-y-1.5 pt-1 border-t border-border-default">
              {[
                { label: "Pitch", value: axes.x, lo: -1000, hi: 1000 },
                { label: "Roll",  value: axes.y, lo: -1000, hi: 1000 },
                { label: "Thr",   value: axes.z, lo: 0,     hi: 1000 },
                { label: "Yaw",   value: axes.r, lo: -1000, hi: 1000 },
              ].map(({ label, value, lo, hi }) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-text-tertiary w-8">{label}</span>
                  <div className="flex-1 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent-primary rounded-full transition-all"
                      style={{ width: `${pct(value, lo, hi)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-text-tertiary w-10 text-right">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
