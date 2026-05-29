// cli/commands/sitl.ts — Launch ArduPilot SITL simulator
// SPDX-License-Identifier: GPL-3.0-only

import { type Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { checkArdupilot, checkSitlDeps, checkDepsInstalled } from '../lib/checks.js';
import { spawnForwarded, spawnGroup } from '../lib/process.js';
import { PROJECT_ROOT, SITL_TOOL, SITL_INDEX } from '../lib/paths.js';
import { printBanner } from '../banner.js';

// Preset data hardcoded to avoid importing from tools/sitl (different tsconfig)
const PRESETS = [
  { id: '5in-fpv-freestyle', name: '5" FPV Freestyle', desc: 'Aggressive freestyle quad — no GPS, acro mode' },
  { id: '7in-long-range', name: '7" Long Range', desc: 'GPS-equipped, Li-Ion, 30+ min flight' },
  { id: '10in-heavy-lifter', name: '10" Heavy Lift Hexa', desc: '6-motor heavy lifter with rangefinder' },
  { id: '3in-cinewhoop', name: '3" Cinewhoop', desc: 'Ducted indoor-safe cinema quad' },
  { id: 'xclass-racer', name: 'X-Class Racer', desc: '13" prop high speed racing quad' },
  { id: 'tiny-whoop', name: 'Tiny Whoop', desc: 'Sub-100g micro whoop, 65mm, indoor only' },
  { id: '7in-ados-reference', name: '7" ADOS Reference', desc: 'Reference platform — full sensor suite + companion compute' },
  { id: 'velox-interceptor', name: 'VELOX Interceptor', desc: 'Counter-drone interceptor — GPS, Gazebo-ready, ARMING_CHECK=0' },
] as const;

interface SitlOptions {
  drones?: number;
  preset?: string;
  wsPort?: number;
  lat?: number;
  lon?: number;
  speedup?: number;
  wind?: string;
  vehicle?: string;
  withGcs?: boolean;
  listPresets?: boolean;
  noDashboard?: boolean;
  withGazebo?: boolean;
  gazeboWorld?: string;
  gazeboHeadless?: boolean;
  scenario?: string;
  listScenarios?: boolean;
}

function printPresetTable(): void {
  console.log();
  console.log(pc.bold('Available SITL presets:'));
  console.log();
  console.log(
    `  ${pc.dim('ID'.padEnd(24))}${pc.dim('Name'.padEnd(24))}${pc.dim('Description')}`
  );
  console.log(`  ${'─'.repeat(72)}`);
  for (const preset of PRESETS) {
    console.log(
      `  ${pc.cyan(preset.id.padEnd(24))}${preset.name.padEnd(24)}${pc.dim(preset.desc)}`
    );
  }
  console.log();
}

export async function sitlCommand(opts: SitlOptions): Promise<void> {
  // List presets and exit
  if (opts.listPresets) {
    printPresetTable();
    process.exit(0);
  }

  // List scenarios and exit (pass-through to SITL tool)
  if (opts.listScenarios) {
    const { spawnForwarded } = await import('../lib/process.js');
    const code = await spawnForwarded({
      command: 'npx',
      args: ['tsx', SITL_INDEX, '--list-scenarios'],
      cwd: SITL_TOOL,
    });
    process.exit(code);
  }

  printBanner();

  // 1. Check ArduPilot installed
  const ardupilotCheck = checkArdupilot();
  if (!ardupilotCheck.ok) {
    p.log.warn('ArduPilot SITL not found at ~/.ardupilot');
    const install = await p.confirm({
      message: 'Would you like to set up ArduPilot SITL now?',
    });
    if (p.isCancel(install) || !install) {
      p.log.info(`Run ${pc.cyan('npm run cli sitl-setup')} to install ArduPilot SITL`);
      process.exit(1);
    }
    // Dynamic import to avoid circular dependency
    const { sitlSetupCommand } = await import('./sitl-setup.js');
    await sitlSetupCommand();
    // Re-check
    const recheck = checkArdupilot();
    if (!recheck.ok) {
      p.log.error('ArduPilot SITL setup did not complete successfully');
      process.exit(1);
    }
  }

  // 2. Check SITL tool dependencies
  const sitlDeps = checkSitlDeps();
  if (!sitlDeps.ok) {
    p.log.info('Installing SITL tool dependencies...');
    const code = await spawnForwarded({
      command: 'npm',
      args: ['install'],
      cwd: SITL_TOOL,
    });
    if (code !== 0) {
      p.log.error('Failed to install SITL dependencies');
      process.exit(1);
    }
  }

  // 3. Preset selection (if not provided via CLI flag)
  let preset = opts.preset;
  if (!preset) {
    const selected = await p.select({
      message: 'Select a drone preset:',
      options: PRESETS.map((pr) => ({
        value: pr.id,
        label: pr.name,
        hint: pr.desc,
      })),
      initialValue: '7in-ados-reference',
    });
    if (p.isCancel(selected)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    preset = selected;
  }

  // 4. Drone count (if not provided)
  let drones = opts.drones;
  if (!drones) {
    const selected = await p.select({
      message: 'How many drones to simulate?',
      options: [
        { value: 1, label: '1 drone', hint: 'single vehicle' },
        { value: 2, label: '2 drones' },
        { value: 3, label: '3 drones' },
        { value: 5, label: '5 drones', hint: 'swarm test' },
      ],
      initialValue: 1,
    });
    if (p.isCancel(selected)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    drones = selected;
  }

  // 5. Simulation speed (if not provided)
  let speedup = opts.speedup;
  if (!speedup) {
    const selected = await p.select({
      message: 'Simulation speed:',
      options: [
        { value: 1, label: '1x', hint: 'real-time' },
        { value: 2, label: '2x' },
        { value: 5, label: '5x' },
        { value: 10, label: '10x', hint: 'fast testing' },
      ],
      initialValue: 1,
    });
    if (p.isCancel(selected)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    speedup = selected;
  }

  // 6. Also start GCS dev server?
  let withGcs = opts.withGcs ?? false;
  if (!opts.withGcs) {
    const gcs = await p.confirm({
      message: 'Also start GCS dev server?',
      initialValue: true,
    });
    if (p.isCancel(gcs)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    withGcs = gcs;
  }

  // Build SITL args
  const wsPort = opts.wsPort ?? 5760;
  const sitlArgs: string[] = [SITL_INDEX];
  sitlArgs.push('--drones', String(drones));
  sitlArgs.push('--ws-port', String(wsPort));
  sitlArgs.push('--preset', preset);
  sitlArgs.push('--speedup', String(speedup));

  if (opts.lat !== undefined) sitlArgs.push('--lat', String(opts.lat));
  if (opts.lon !== undefined) sitlArgs.push('--lon', String(opts.lon));
  if (opts.wind) sitlArgs.push('--wind', opts.wind);
  if (opts.vehicle) sitlArgs.push('--vehicle', opts.vehicle);
  if (opts.noDashboard) sitlArgs.push('--no-dashboard');
  if (opts.withGazebo) sitlArgs.push('--with-gazebo');
  if (opts.gazeboWorld) sitlArgs.push('--gazebo-world', opts.gazeboWorld);
  if (opts.gazeboHeadless) sitlArgs.push('--gazebo-headless');
  if (opts.scenario) sitlArgs.push('--scenario', opts.scenario);

  const presetInfo = PRESETS.find((pr) => pr.id === preset);
  console.log();
  p.log.info(`Preset: ${pc.cyan(presetInfo?.name ?? preset)}`);
  p.log.info(`Drones: ${pc.cyan(String(drones))} | Speed: ${pc.cyan(`${speedup}x`)} | WS Port: ${pc.cyan(String(wsPort))}`);
  if (opts.withGazebo) {
    p.log.info(`Gazebo: ${pc.cyan(opts.gazeboWorld ?? 'multi-copter')}${opts.gazeboHeadless ? pc.dim(' (headless)') : ''}`);
  }
  if (withGcs) {
    p.log.info(`GCS dev server on port ${pc.cyan('4000')}`);
  }
  p.log.info(pc.dim('Press Ctrl+C to stop all processes'));
  console.log();

  // 7. Launch
  if (withGcs) {
    // Check GCS deps
    const gcsCheck = checkDepsInstalled();
    if (!gcsCheck.ok) {
      p.log.info('Installing GCS dependencies...');
      await spawnForwarded({ command: 'npm', args: ['install'], cwd: PROJECT_ROOT });
    }

    const group = spawnGroup([
      {
        command: 'npx',
        args: ['tsx', ...sitlArgs],
        cwd: SITL_TOOL,
        label: 'SITL',
      },
      {
        command: 'npx',
        args: ['next', 'dev', '--port', '4000'],
        cwd: PROJECT_ROOT,
        label: 'GCS',
      },
    ]);

    await group.waitForExit();
  } else {
    const code = await spawnForwarded({
      command: 'npx',
      args: ['tsx', ...sitlArgs],
      cwd: SITL_TOOL,
    });
    process.exit(code);
  }
}

export function registerSitl(program: Command): void {
  program
    .command('sitl')
    .description('Launch ArduPilot SITL simulator')
    .option('--drones <N>', 'Number of simulated drones')
    .option('--preset <id>', 'Drone build preset')
    .option('--ws-port <port>', 'WebSocket port', '5760')
    .option('--lat <degrees>', 'Home latitude')
    .option('--lon <degrees>', 'Home longitude')
    .option('--speedup <N>', 'Simulation speed multiplier')
    .option('--wind <speed,dir>', 'Wind speed and direction')
    .option('--vehicle <type>', 'Vehicle type (ArduCopter, ArduPlane, ArduRover)')
    .option('--with-gcs', 'Also start GCS dev server')
    .option('--list-presets', 'List available presets and exit')
    .option('--no-dashboard', 'Disable SITL terminal dashboard')
    .option('--with-gazebo', 'Launch with Gazebo 3D visualization')
    .option('--gazebo-world <name>', 'Gazebo world file (without .sdf)', 'multi-copter')
    .option('--gazebo-headless', 'Run Gazebo without GUI (server only)')
    .option('--scenario <id>', 'Use a named test scenario')
    .option('--list-scenarios', 'List available test scenarios and exit')
    .action(async (opts) => {
      await sitlCommand({
        drones: opts.drones ? parseInt(opts.drones, 10) : undefined,
        preset: opts.preset,
        wsPort: parseInt(opts.wsPort, 10),
        lat: opts.lat ? parseFloat(opts.lat) : undefined,
        lon: opts.lon ? parseFloat(opts.lon) : undefined,
        speedup: opts.speedup ? parseFloat(opts.speedup) : undefined,
        wind: opts.wind,
        vehicle: opts.vehicle,
        withGcs: opts.withGcs,
        listPresets: opts.listPresets,
        noDashboard: opts.dashboard === false, // commander negates --no- flags
        withGazebo: opts.withGazebo,
        gazeboWorld: opts.gazeboWorld,
        gazeboHeadless: opts.gazeboHeadless,
        scenario: opts.scenario,
        listScenarios: opts.listScenarios,
      });
    });
}
