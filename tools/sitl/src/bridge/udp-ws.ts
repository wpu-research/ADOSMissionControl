// udp-ws.ts — UDP↔WebSocket binary relay for PX4 SITL MAVLink streams
// PX4 sends MAVLink datagrams to gcsUdpPort; bridge forwards to WS clients.
// WS client commands are sent back to PX4 via UDP (to PX4's sender address).
// SPDX-License-Identifier: GPL-3.0-only

import { EventEmitter } from 'node:events';
import dgram from 'node:dgram';
import { WebSocketServer, WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UdpInstance {
  sysId: number;
  udpPort: number;  // GCS UDP port that PX4 sends MAVLink to
}

export interface UdpBridgeConfig {
  wsPort: number;        // base WebSocket port (instance i → wsPort + i)
  udpInstances: UdpInstance[];
}

// ---------------------------------------------------------------------------
// UdpWsBridge
// ---------------------------------------------------------------------------

export class UdpWsBridge extends EventEmitter {
  private readonly config: UdpBridgeConfig;
  private readonly wssMap = new Map<number, WebSocketServer>();
  private readonly udpSockets = new Map<number, dgram.Socket>();
  // Last known PX4 address per UDP port (learned from incoming packets)
  private readonly px4Addrs = new Map<number, { address: string; port: number }>();
  private closed = false;

  constructor(config: UdpBridgeConfig) {
    super();
    this.config = config;
  }

  get wsClientCount(): number {
    let count = 0;
    for (const wss of this.wssMap.values()) count += wss.clients.size;
    return count;
  }

  start(): void {
    for (let i = 0; i < this.config.udpInstances.length; i++) {
      const instance = this.config.udpInstances[i];
      const wsPort = this.config.wsPort + i;

      // --- UDP socket ---
      const udpSock = dgram.createSocket('udp4');
      this.udpSockets.set(instance.udpPort, udpSock);

      udpSock.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        // Learn PX4's address on first packet; update if it changes
        const prev = this.px4Addrs.get(instance.udpPort);
        if (!prev || prev.address !== rinfo.address || prev.port !== rinfo.port) {
          this.px4Addrs.set(instance.udpPort, { address: rinfo.address, port: rinfo.port });
          this.emit('px4-address', { sysId: instance.sysId, address: rinfo.address, port: rinfo.port });
        }
        this.broadcastToWs(wsPort, msg);
        this.emit('data', { sysId: instance.sysId, data: msg });
      });

      udpSock.on('error', (err: Error) => this.emit('error', err));

      udpSock.bind(instance.udpPort, () => {
        this.emit('udp-ready', { sysId: instance.sysId, port: instance.udpPort });
      });

      // --- WebSocket server ---
      const wss = new WebSocketServer({ port: wsPort });

      wss.on('connection', (ws: WebSocket, req: { socket: { remoteAddress?: string } }) => {
        const remoteAddress = req.socket.remoteAddress ?? 'unknown';
        this.emit('ws-client-connected', { remoteAddress });

        ws.binaryType = 'nodebuffer';

        ws.on('message', (msg: Buffer) => {
          const px4Addr = this.px4Addrs.get(instance.udpPort);
          if (px4Addr) {
            udpSock.send(msg, px4Addr.port, px4Addr.address);
          }
        });

        ws.on('close', () => this.emit('ws-client-disconnected', { remoteAddress }));
        ws.on('error', (err: Error) => this.emit('error', err));
      });

      wss.on('error', (err: Error) => this.emit('error', err));
      this.wssMap.set(wsPort, wss);
    }
  }

  shutdown(): void {
    this.closed = true;
    for (const udpSock of this.udpSockets.values()) {
      try { udpSock.close(); } catch { /* already closed */ }
    }
    for (const wss of this.wssMap.values()) {
      for (const client of wss.clients) client.close();
      wss.close();
    }
    this.udpSockets.clear();
    this.wssMap.clear();
  }

  private broadcastToWs(wsPort: number, data: Buffer): void {
    const wss = this.wssMap.get(wsPort);
    if (!wss) return;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: wait until PX4 sends its first MAVLink datagram to udpPort
// ---------------------------------------------------------------------------

export function waitForUdpPacket(udpPort: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');

    const timer = setTimeout(() => {
      sock.close();
      reject(new Error(`No UDP MAVLink on port ${udpPort} after ${timeoutMs}ms — is PX4 running?`));
    }, timeoutMs);

    sock.once('message', () => {
      clearTimeout(timer);
      sock.close(() => resolve());
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      reject(err);
    });

    sock.bind(udpPort);
  });
}
