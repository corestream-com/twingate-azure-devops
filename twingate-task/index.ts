import { ToolRunner } from "azure-pipelines-task-lib/toolrunner";
import tl = require("azure-pipelines-task-lib/task");
const fs = require('fs');
async function run() {
  let serviceKey: string | undefined;
  try {
    const b64ServiceKey: string | undefined = tl.getInput("serviceKey", true);
    serviceKey = Buffer.from(b64ServiceKey || "", "base64").toString();
    fs.writeFileSync('servicekey.json', serviceKey);
  } catch (err: any) {
    tl.setResult(tl.TaskResult.Failed, err.message);
  }
  console.log("Installing Twingate...");

  let aptUpdate: ToolRunner = tl.tool("sudo").arg(["apt", "update", "-yq"]);
  let aptUpdateResults = aptUpdate.execSync({ silent: true});
  tl.debug(aptUpdateResults.stdout);


  let caInstall = tl.tool("sudo").arg(["apt", "install", "-yq", "ca-certificates"]);
  let caInstallResults = caInstall.execSync({ silent: true});
  tl.debug(caInstallResults.stdout);


  let addTwingateSrc = tl.tool("sudo").arg([
    "sh",
    "-c",
    'echo "deb [trusted=yes] https://packages.twingate.com/apt/ /" | sudo tee /etc/apt/sources.list.d/twingate.list',
  ]);
  let addTwingateSrcResults = addTwingateSrc.execSync({ silent: true});
  tl.debug(addTwingateSrcResults.stdout);

  aptUpdateResults = aptUpdate.execSync({ silent: true});
  tl.debug(aptUpdateResults.stdout);


  let twingateInstall = tl.tool("sudo").arg(["apt", "install", "-yq", "twingate"]);
  let twingateInstallResults = twingateInstall.execSync({ silent: true});
  tl.debug(twingateInstallResults.stdout);

  let twingateSetup = tl.tool("sudo").arg(["twingate", "setup", "--headless" , "servicekey.json"]);
  let twingateSetupResults = twingateSetup.execSync({ silent: true});
  tl.debug(twingateSetupResults.stdout);

  console.log("Twingate successfully installed and configured.");
  
  let start = tl.tool("sudo").arg(["twingate", "start"]);
  let stop = tl.tool("sudo").arg(["twingate", "stop"]);
  let status = tl.tool("sudo").arg(["twingate", "status"]);
  let logs = tl.tool("sudo").arg(["journalctl", "-u", "twingate", "--no-pager"]);
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
      if (result.stdout.trim() === "online") {
        isTwingateRunning = true;
        console.log("Twingate is now running.");
      } else {
        console.log("Failed to start Twingate, retrying...");
        let stopResults = stop.execSync({ silent: true});
        tl.debug(stopResults.stdout);
      }
    } catch (error) {
      let stopResults = stop.execSync({ silent: true});
      tl.debug(stopResults.stdout);
      console.log("An error occurred while starting Twingate, retrying...");
    }
    retries++;
    if (retries === maxRetries) {
      let msg = "Failed to start Twingate after multiple retries.";
      await logs.execAsync();
      tl.setResult(tl.TaskResult.Failed, msg);
      throw new Error("msg");
    }
  } while (!isTwingateRunning);
  
  tl.setResult(tl.TaskResult.Succeeded, "Twingate successfully installed and started.")
}

run();


