// px4-sitl.ts — PX4 SITL + Gazebo process launcher and lifecycle manager
// SPDX-License-Identifier: GPL-3.0-only

import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { waitForUdpPacket } from '../bridge/udp-ws.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Px4SitlConfig {
  px4Home: string;        // PX4-Autopilot source root (default ~/PX4-Autopilot)
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  speedup: number;
  gcsUdpPort: number;     // GCS listens on this UDP port; PX4 sends MAVLink here
}

export interface Px4SitlInstance {
  sysId: number;
  udpPort: number;        // GCS UDP port (same as gcsUdpPort in config)
  pid: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: Px4SitlConfig = {
  px4Home: join(homedir(), 'PX4-Autopilot'),
  lat: 12.9716,
  lon: 77.5946,
  alt: 0,
  heading: 0,
  speedup: 1,
  gcsUdpPort: 14550,
};

const UDP_READY_TIMEOUT_MS = 90_000;
const SIGKILL_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Px4SitlLauncher
// ---------------------------------------------------------------------------

export class Px4SitlLauncher extends EventEmitter {
  private readonly config: Px4SitlConfig;
  private readonly children: ChildProcess[] = [];
  private instances: Px4SitlInstance[] = [];

  constructor(config: Partial<Px4SitlConfig> & Pick<Px4SitlConfig, 'lat' | 'lon'>) {
    super();
    this.config = { ...DEFAULTS, ...config };
  }

  async launch(): Promise<Px4SitlInstance[]> {
    const { px4Home, lat, lon, alt, heading, gcsUdpPort } = this.config;
    const buildPath = join(px4Home, 'build', 'px4_sitl_default');
    const binaryPath = join(buildPath, 'bin', 'px4');

    await access(binaryPath, constants.F_OK).catch(() => {
      throw new Error(
        `PX4 binary not found at ${binaryPath}.\n` +
        `Run: cd ${px4Home} && make px4_sitl_default`,
      );
    });

    // PX4 SITL: binary takes buildPath as rootfs arg, runs rcS
    const args = [buildPath, '-s', 'etc/init.d-posix/rcS'];

    const env: Record<string, string> = {
      // Spread process env but override ArduPilot/conflicting paths
      ...(process.env as Record<string, string>),
      PX4_SYS_AUTOSTART: '4001',
      PX4_GZ_WORLD: 'default',
      PX4_GZ_WORLDS: join(px4Home, 'Tools/simulation/gz/worlds'),
      PX4_GZ_MODELS: join(px4Home, 'Tools/simulation/gz/models'),
      GZ_SIM_SYSTEM_PLUGIN_PATH: join(buildPath, 'src/modules/simulation/gz_plugins'),
      GZ_SIM_RESOURCE_PATH: [
        join(px4Home, 'Tools/simulation/gz/models'),
        join(homedir(), '.simulation-gazebo'),
      ].join(':'),
      PX4_HOME_LAT: String(lat),
      PX4_HOME_LON: String(lon),
      PX4_HOME_ALT: String(alt),
    };

    const proc = spawn(binaryPath, args, {
      cwd: buildPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    this.children.push(proc);

    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line: string) => this.emit('stdout', `[px4] ${line}`));
    }
    if (proc.stderr) {
      const rl = createInterface({ input: proc.stderr });
      rl.on('line', (line: string) => this.emit('stderr', `[px4] ${line}`));
    }

    proc.on('exit', (code) => this.emit('exit', code ?? 1));

    // Wait for PX4 to send its first MAVLink heartbeat to gcsUdpPort
    this.emit('stdout', `[px4] Waiting for MAVLink on UDP:${gcsUdpPort} (up to ${UDP_READY_TIMEOUT_MS / 1000}s)...`);
    await waitForUdpPacket(gcsUdpPort, UDP_READY_TIMEOUT_MS);

    this.instances = [{
      sysId: 1,
      udpPort: gcsUdpPort,
      pid: proc.pid ?? -1,
    }];

    this.emit('ready', { instances: this.instances });
    return this.instances;
  }

  async shutdown(): Promise<void> {
    const killPromises = this.children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (!child.pid || child.killed) { resolve(); return; }

          const forceKill = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
          }, SIGKILL_TIMEOUT_MS);

          child.once('exit', () => {
            clearTimeout(forceKill);
            resolve();
          });

          child.kill('SIGTERM');
        }),
    );

    await Promise.all(killPromises);
    this.children.length = 0;
    this.instances = [];
  }
}
