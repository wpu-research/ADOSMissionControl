// agent-shim.ts — Minimal HTTP agent API shim for SITL
// Serves the subset of endpoints the ADOS GCS needs to discover and
// connect to a simulated drone via WebSocket.
// SPDX-License-Identifier: GPL-3.0-only

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

export interface AgentShimConfig {
  httpPort: number;
  mavlinkWsPort: number;
  drones: number;
  startedAt: number;
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res: ServerResponse, code: number, body: unknown): void {
  cors(res);
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function buildStatus(config: AgentShimConfig) {
  return {
    version: '0.0.1-sitl',
    uptime_seconds: Math.floor((Date.now() - config.startedAt) / 1000),
    board: {
      name: 'SITL',
      model: 'ArduPilot SITL',
      tier: 1,
      ram_mb: 4096,
      cpu_cores: 4,
      vendor: 'ArduPilot',
      soc: 'x86_64',
      arch: 'x86_64',
      hw_video_codecs: [] as string[],
    },
    health: {
      cpu_percent: 10,
      memory_percent: 20,
      disk_percent: 30,
      temperature: null,
      timestamp: new Date().toISOString(),
    },
    fc_connected: true,
    fc_port: 'tcp:5760',
    fc_baud: 0,
    install_status: 'ok' as const,
  };
}

export class AgentShim extends EventEmitter {
  private readonly config: AgentShimConfig;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(config: AgentShimConfig) {
    super();
    this.config = config;
  }

  start(): void {
    const { httpPort, mavlinkWsPort } = this.config;

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'OPTIONS') {
        cors(res);
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url?.split('?')[0] ?? '/';

      switch (url) {
        case '/api/status':
          json(res, 200, buildStatus(this.config));
          break;

        case '/api/version':
          json(res, 200, {
            api_version: '1.0.0',
            agent_version: '0.0.1-sitl',
            capabilities: ['mavlink.websocket'],
          });
          break;

        case '/api/services':
          json(res, 200, [
            {
              name: 'ados-mavlink',
              status: 'running',
              pid: process.pid,
              cpu_percent: 1,
              memory_mb: 32,
              uptime_seconds: Math.floor((Date.now() - this.config.startedAt) / 1000),
              category: 'core',
            },
          ]);
          break;

        case '/api/telemetry':
          // Return zeros — the GCS will get real data via MAVLink WS
          json(res, 200, {
            lat: 0, lon: 0, alt: 0, relative_alt: 0,
            heading: 0, groundspeed: 0, airspeed: 0,
            roll: 0, pitch: 0, yaw: 0,
            battery_voltage: 0, battery_current: 0, battery_remaining: 100,
            gps_fix: 0, satellites: 0,
            mode: 'STABILIZE', armed: false,
          });
          break;

        case '/api/params':
          json(res, 200, {});
          break;

        case '/api/config':
          json(res, 200, {});
          break;

        default:
          // Return empty 200 for any unknown endpoint so the GCS doesn't bail
          json(res, 200, {});
          break;
      }
    });

    this.server.listen(httpPort, '0.0.0.0', () => {
      this.emit('ready', { httpPort, mavlinkWsPort });
    });

    this.server.on('error', (err) => this.emit('error', err));
  }

  stop(): void {
    this.server?.close();
  }
}
