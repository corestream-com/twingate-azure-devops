import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import tl = require('azure-pipelines-task-lib/task');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');

async function run() {
  let serviceKey: string | undefined;
  try {
    const b64ServiceKey: string | undefined = tl.getInput('serviceKey', true);
    serviceKey = Buffer.from(b64ServiceKey || '', 'base64').toString();
    fs.writeFileSync('servicekey.json', serviceKey);
  } catch (err: unknown) {
    if (err instanceof Error) {
      tl.setResult(tl.TaskResult.Failed, err.message);
    } else {
      tl.setResult(tl.TaskResult.Failed, err as string);
    }
  }

  let osType = tl.getVariable('Agent.OS');
  console.log('Installing Twingate...');
  console.log(`Operating System: ${osType}`);
  if (osType == 'Windows_NT') {
    let createTemp: ToolRunner = tl.tool('powershell').arg('if (-Not (Test-Path -Path "C:\\temp")) { New-Item -ItemType Directory -Path "C:\\temp" }');
    let createTempResults = createTemp.execSync({ silent: true});
    tl.debug(createTempResults.stdout);

    let copyConfig: ToolRunner = tl.tool('powershell').arg('Copy-Item -Path servicekey.json -Destination C:\\temp\\servicekey.json');
    let copyConfigResults = copyConfig.execSync({ silent: true});
    tl.debug(copyConfigResults.stdout);

    let downloadClient: ToolRunner = tl.tool('powershell').arg(['$ProgressPreference = \'SilentlyContinue\';', 'Invoke-WebRequest -Uri https://api.twingate.com/download/windows?installer=msi -OutFile TwingateWindowsInstaller.msi']);
    let downloadResults = downloadClient.execSync({ silent: true});
    tl.debug(downloadResults.stdout);

    let installClient: ToolRunner = tl.tool('msiexec').arg(['/i', 'TwingateWindowsInstaller.msi', 'service_secret=C:\\temp\\servicekey.json', '/qn']);
    let installResults = installClient.execSync({ silent: true});
    tl.debug(installResults.stdout);

    await new Promise(f => setTimeout(f, 5000));
    let startClient: ToolRunner = tl.tool('sc').arg(['start', 'twingate.service']);
    let startResults = startClient.execSync({ silent: true});
    tl.debug(startResults.stdout);

    let getLogs: ToolRunner = tl.tool('powershell').arg(['Get-content C:\\ProgramData\\Twingate\\logs\\Twingate.Service.log']);

    let status: ToolRunner = tl.tool('sc').arg(['query', 'twingate.service']);
    let isTwingateRunning = false;
    const maxRetries = 5;
    let retries = 0;
    let waitTime = 10000;
    do {
      try {
        await new Promise(f => setTimeout(f, waitTime));
        let logsResults = getLogs.execSync({ silent: true});
        tl.debug(logsResults.stdout);
        const result = status.execSync({ silent: true});
        if (result.stdout.includes('RUNNING')) {
          isTwingateRunning = true;
          console.log('Twingate is now running.');
        } else {
          console.log('Failed to start Twingate, retrying...');
          startClient.execSync({ silent: true});
        }
      } catch (error: unknown) {
        if (error instanceof Error) {
          tl.debug(error.message);
        } else {
          tl.debug(error as string);
        }
        console.log('An error occurred while starting Twingate, retrying...');
      }
      retries++;
      if (retries === maxRetries) {
        tl.setResult(tl.TaskResult.Failed, 'Failed to start Twingate after multiple retries.');
        return;
      }
    } while (!isTwingateRunning);

    tl.setResult(tl.TaskResult.Succeeded, 'Twingate successfully installed and started.');
    return;
  }
  let aptUpdate: ToolRunner = tl.tool('sudo').arg(['apt', 'update', '-yq']);
  let aptUpdateResults = aptUpdate.execSync({ silent: true});
  tl.debug(aptUpdateResults.stdout);

  let caInstall = tl.tool('sudo').arg(['apt', 'install', '-yq', 'ca-certificates']);
  let caInstallResults = caInstall.execSync({ silent: true});
  tl.debug(caInstallResults.stdout);


  let addTwingateSrc = tl.tool('sudo').arg([
    'sh',
    '-c',
    'echo "deb [trusted=yes] https://packages.twingate.com/apt/ /" | sudo tee /etc/apt/sources.list.d/twingate.list',
  ]);
  let addTwingateSrcResults = addTwingateSrc.execSync({ silent: true});
  tl.debug(addTwingateSrcResults.stdout);

  aptUpdateResults = aptUpdate.execSync({ silent: true});
  tl.debug(aptUpdateResults.stdout);


  let twingateInstall = tl.tool('sudo').arg(['apt', 'install', '-yq', 'twingate']);
  let twingateInstallResults = twingateInstall.execSync({ silent: true});
  tl.debug(twingateInstallResults.stdout);

  let twingateSetup = tl.tool('sudo').arg(['twingate', 'setup', '--headless' , 'servicekey.json']);
  let twingateSetupResults = twingateSetup.execSync({ silent: true});
  tl.debug(twingateSetupResults.stdout);

  console.log('Twingate successfully installed and configured.');
  
  let start = tl.tool('sudo').arg(['twingate', 'start']);
  let stop = tl.tool('sudo').arg(['twingate', 'stop']);
  let status = tl.tool('sudo').arg(['twingate', 'status']);
  let logs = tl.tool('sudo').arg(['journalctl', '-u', 'twingate', '--no-pager']);
  let isTwingateRunning = false;
  const maxRetries = 5;
  let retries = 0;
  let waitTime = 5000;
  do {
    try {
      let startResults = start.execSync({ silent: true});
      tl.debug(startResults.stdout);
      console.log(`Waiting ${waitTime / 1000} seconds for Twingate to start...`);
      await new Promise(f => setTimeout(f, waitTime));
      const result = status.execSync({ silent: true});
      if (result.stdout.trim() === 'online') {
        isTwingateRunning = true;
        console.log('Twingate is now running.');
      } else {
        console.log('Failed to start Twingate, retrying...');
        let stopResults = stop.execSync({ silent: true});
        tl.debug(stopResults.stdout);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        tl.debug(error.message);
      } else {
        tl.debug(error as string);
      }
      console.log('An error occurred while starting Twingate, retrying...');
    }
    retries++;
    if (retries === maxRetries) {
      let msg = 'Failed to start Twingate after multiple retries.';
      await logs.execAsync();
      tl.setResult(tl.TaskResult.Failed, msg);
      throw new Error('msg');
    }
  } while (!isTwingateRunning);
  
  tl.setResult(tl.TaskResult.Succeeded, 'Twingate successfully installed and started.');
}

run();
