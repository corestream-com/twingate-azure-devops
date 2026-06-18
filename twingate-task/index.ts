import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import tl = require('azure-pipelines-task-lib/task');
import * as fs from 'fs';
import * as path from 'path';

type LinuxPackageManager = 'apt-get' | 'apt' | 'dnf' | 'yum';

interface ExecOptions {
  failOnNonZero?: boolean;
  silent?: boolean;
  windowsVerbatimArguments?: boolean;
}

const maxRetries = 5;

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getTempDirectory(): string {
  return tl.getVariable('Agent.TempDirectory') || process.env.AGENT_TEMPDIRECTORY || process.cwd();
}

function commandExists(command: string): boolean {
  try {
    return Boolean(tl.which(command, false));
  } catch {
    return false;
  }
}

function trimOutput(output: string): string {
  const trimmed = output.trim();

  if (trimmed.length <= 1000) {
    return trimmed;
  }

  return `${trimmed.slice(0, 1000)}...`;
}

function execute(command: string, args: string[], failureMessage: string, options: ExecOptions = {}): void {
  const failOnNonZero = options.failOnNonZero ?? true;
  const silent = options.silent ?? true;
  const runner: ToolRunner = tl.tool(command).arg(args);
  const result = runner.execSync({ silent, windowsVerbatimArguments: options.windowsVerbatimArguments });

  tl.debug(`Executed: ${[command, ...args].join(' ')}`);

  if (result.stdout) {
    tl.debug(result.stdout);
  }

  if (result.stderr) {
    tl.debug(result.stderr);
  }

  if (failOnNonZero && result.code !== 0) {
    const details = trimOutput(result.stderr || result.stdout);
    throw new Error(`${failureMessage}. Exit code: ${result.code}${details ? `. Output: ${details}` : ''}`);
  }
}

function executeOptional(command: string, args: string[], debugMessage: string, options: ExecOptions = {}): void {
  try {
    execute(command, args, debugMessage, { ...options, failOnNonZero: false });
  } catch (error: unknown) {
    tl.debug(`${debugMessage}: ${getErrorMessage(error)}`);
  }
}

function executePrivileged(args: string[], failureMessage: string, options: ExecOptions = {}): void {
  if (commandExists('sudo')) {
    execute('sudo', args, failureMessage, options);
    return;
  }

  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const [command, ...commandArgs] = args;
    execute(command, commandArgs, failureMessage, options);
    return;
  }

  throw new Error('This Linux agent must have sudo available, or the task must run as root.');
}

function executePrivilegedOptional(args: string[], debugMessage: string, options: ExecOptions = {}): void {
  try {
    executePrivileged(args, debugMessage, { ...options, failOnNonZero: false });
  } catch (error: unknown) {
    tl.debug(`${debugMessage}: ${getErrorMessage(error)}`);
  }
}

function writeServiceKey(): string {
  const encodedServiceKey = tl.getInput('serviceKey', true);

  if (!encodedServiceKey) {
    throw new Error('The serviceKey input is required.');
  }

  tl.setSecret(encodedServiceKey);

  const serviceKey = Buffer.from(encodedServiceKey, 'base64').toString('utf8');

  try {
    JSON.parse(serviceKey);
  } catch {
    throw new Error('The serviceKey input must be a base64-encoded Twingate service key JSON document.');
  }

  tl.setSecret(serviceKey);

  const serviceKeyPath = path.join(getTempDirectory(), `twingate-servicekey-${process.pid}.json`);
  fs.writeFileSync(serviceKeyPath, serviceKey, { encoding: 'utf8', mode: 0o600 });

  return serviceKeyPath;
}

function removeFile(filePath: string | undefined): void {
  if (!filePath) {
    return;
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      tl.debug(`Removed temporary file: ${filePath}`);
    }
  } catch (error: unknown) {
    tl.debug(`Failed to remove temporary file ${filePath}: ${getErrorMessage(error)}`);
  }
}

function detectLinuxPackageManager(): LinuxPackageManager {
  if (commandExists('apt-get')) {
    return 'apt-get';
  }

  if (commandExists('apt')) {
    return 'apt';
  }

  if (commandExists('dnf')) {
    return 'dnf';
  }

  if (commandExists('yum')) {
    return 'yum';
  }

  throw new Error('Unsupported Linux agent. Twingate installation requires apt/apt-get for Ubuntu or Debian, or dnf/yum for RPM-based distributions.');
}

function installTwingateWithApt(packageManager: 'apt-get' | 'apt'): void {
  console.log(`Installing Twingate with ${packageManager}...`);

  executePrivileged([packageManager, 'update', '-yq'], 'Failed to update apt package indexes');
  executePrivileged(
    [packageManager, 'install', '-yq', 'curl', 'gpg', 'ca-certificates'],
    'Failed to install apt prerequisites',
  );
  executePrivileged(
    [
      'sh',
      '-c',
      'rm -f /usr/share/keyrings/twingate-client-keyring.gpg && curl -fsSL https://packages.twingate.com/apt/gpg.key | gpg --dearmor -o /usr/share/keyrings/twingate-client-keyring.gpg',
    ],
    'Failed to install the Twingate apt signing key',
  );
  executePrivileged(
    [
      'sh',
      '-c',
      'printf "%s\\n" "deb [signed-by=/usr/share/keyrings/twingate-client-keyring.gpg] https://packages.twingate.com/apt/ * *" > /etc/apt/sources.list.d/twingate.list',
    ],
    'Failed to add the Twingate apt repository',
  );
  executePrivileged([packageManager, 'update', '-yq'], 'Failed to update apt package indexes after adding the Twingate repository');
  executePrivileged([packageManager, 'install', '-yq', 'twingate'], 'Failed to install the Twingate package');
}

function installTwingateWithRpm(packageManager: 'dnf' | 'yum'): void {
  console.log(`Installing Twingate with ${packageManager}...`);

  executePrivileged(
    [
      'sh',
      '-c',
      'mkdir -p /etc/yum.repos.d && printf "%s\\n" "[twingate]" "name=Twingate" "baseurl=https://packages.twingate.com/rpm/" "enabled=1" "gpgcheck=0" > /etc/yum.repos.d/twingate.repo',
    ],
    'Failed to add the Twingate RPM repository',
  );
  executePrivileged([packageManager, 'install', '-y', 'twingate'], 'Failed to install the Twingate package');
}

function installTwingateForLinux(): void {
  const packageManager = detectLinuxPackageManager();

  switch (packageManager) {
    case 'apt-get':
    case 'apt':
      installTwingateWithApt(packageManager);
      return;
    case 'dnf':
    case 'yum':
      installTwingateWithRpm(packageManager);
      return;
    default:
      throw new Error(`Unsupported Linux package manager: ${packageManager}`);
  }
}

function configureTwingateForLinux(serviceKeyPath: string): void {
  executePrivileged(['twingate', 'setup', '--headless', serviceKeyPath], 'Failed to configure the Twingate client');
  console.log('Twingate successfully installed and configured.');
}

function dumpLinuxLogs(): void {
  if (commandExists('journalctl')) {
    executePrivilegedOptional(['journalctl', '-u', 'twingate', '--no-pager', '-n', '200'], 'Failed to read Twingate journal logs', { silent: false });
    return;
  }

  if (fs.existsSync('/var/log/twingated.log')) {
    executePrivilegedOptional(['tail', '-n', '200', '/var/log/twingated.log'], 'Failed to read Twingate log file', { silent: false });
  }
}

async function startTwingateForLinux(): Promise<void> {
  const waitTime = 5000;
  let isTwingateRunning = false;

  for (let retries = 0; retries < maxRetries; retries++) {
    try {
      executePrivileged(['twingate', 'start'], 'Failed to start Twingate', { failOnNonZero: false });
      console.log(`Waiting ${waitTime / 1000} seconds for Twingate to start...`);
      await delay(waitTime);

      const status: ToolRunner = commandExists('sudo')
        ? tl.tool('sudo').arg(['twingate', 'status'])
        : tl.tool('twingate').arg(['status']);
      const result = status.execSync({ silent: true });

      if (result.stdout) {
        tl.debug(result.stdout);
      }

      if (result.stderr) {
        tl.debug(result.stderr);
      }

      if (result.code === 0 && result.stdout.trim() === 'online') {
        isTwingateRunning = true;
        console.log('Twingate is now running.');
        break;
      }

      console.log('Failed to start Twingate, retrying...');
      executePrivilegedOptional(['twingate', 'stop'], 'Failed to stop Twingate before retrying');
    } catch (error: unknown) {
      tl.debug(getErrorMessage(error));
      console.log('An error occurred while starting Twingate, retrying...');
    }
  }

  if (!isTwingateRunning) {
    dumpLinuxLogs();
    throw new Error('Failed to start Twingate after multiple retries.');
  }
}

async function installAndStartTwingateForLinux(serviceKeyPath: string): Promise<void> {
  installTwingateForLinux();
  configureTwingateForLinux(serviceKeyPath);
  await startTwingateForLinux();
}

// Quote a Windows argument value only if it contains whitespace. Combined with
// windowsVerbatimArguments this gives msiexec `PROPERTY="value with space"` (value-only
// quoting); Node's default whole-token quoting would produce `"PROPERTY=value"`, which
// msiexec does not parse as a public property.
function quoteWindowsArg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

async function installAndStartTwingateForWindows(serviceKeyPath: string): Promise<void> {
  const installerPath = path.join(getTempDirectory(), `TwingateWindowsInstaller-${process.pid}.msi`);

  try {
    execute(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // installerPath is doubled-single-quote escaped for the PowerShell single-quoted string.
        `$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri 'https://api.twingate.com/download/windows?installer=msi' -OutFile '${installerPath.split('\'').join('\'\'')}'`,
      ],
      'Failed to download the Twingate Windows installer',
    );
    execute(
      'msiexec',
      ['/i', quoteWindowsArg(installerPath), `service_secret=${quoteWindowsArg(serviceKeyPath)}`, '/qn'],
      'Failed to install the Twingate Windows client',
      { windowsVerbatimArguments: true },
    );

    await delay(5000);
    executeOptional('sc', ['start', 'twingate.service'], 'Failed to start the Twingate Windows service');

    const waitTime = 10000;
    let isTwingateRunning = false;

    for (let retries = 0; retries < maxRetries; retries++) {
      try {
        await delay(waitTime);
        executeOptional('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Content C:\\ProgramData\\Twingate\\logs\\Twingate.Service.log'], 'Failed to read Twingate Windows service logs');

        const status: ToolRunner = tl.tool('sc').arg(['query', 'twingate.service']);
        const result = status.execSync({ silent: true });

        if (result.stdout) {
          tl.debug(result.stdout);
        }

        if (result.stderr) {
          tl.debug(result.stderr);
        }

        if (result.code === 0 && result.stdout.includes('RUNNING')) {
          isTwingateRunning = true;
          console.log('Twingate is now running.');
          break;
        }

        console.log('Failed to start Twingate, retrying...');
        executeOptional('sc', ['start', 'twingate.service'], 'Failed to start the Twingate Windows service');
      } catch (error: unknown) {
        tl.debug(getErrorMessage(error));
        console.log('An error occurred while starting Twingate, retrying...');
      }
    }

    if (!isTwingateRunning) {
      throw new Error('Failed to start Twingate after multiple retries.');
    }
  } finally {
    removeFile(installerPath);
  }
}

async function run(): Promise<void> {
  let serviceKeyPath: string | undefined;

  try {
    serviceKeyPath = writeServiceKey();

    const osType = tl.getVariable('Agent.OS');
    console.log('Installing Twingate...');
    console.log(`Operating System: ${osType || 'unknown'}`);

    switch (osType) {
      case 'Windows_NT':
        await installAndStartTwingateForWindows(serviceKeyPath);
        break;
      case 'Linux':
        await installAndStartTwingateForLinux(serviceKeyPath);
        break;
      default:
        throw new Error(`Unsupported operating system: ${osType || 'unknown'}. This task supports Windows and Linux agents.`);
    }

    tl.setResult(tl.TaskResult.Succeeded, 'Twingate successfully installed and started.');
  } catch (error: unknown) {
    tl.setResult(tl.TaskResult.Failed, getErrorMessage(error));
  } finally {
    removeFile(serviceKeyPath);
  }
}

run();
