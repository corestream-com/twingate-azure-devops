param (
    [ValidateSet("clean", "lint", "build", "package")]
    [string]$task = "build"
)

function Start-CleanPkg {
    Remove-Item *.vsix -ErrorAction SilentlyContinue
    Remove-Item twingate-task/index.js -ErrorAction SilentlyContinue
}

function Start-Lint {
    Push-Location twingate-task
    npm install -f
    npm run lint
    Pop-Location
}

function Build-Task {
    Start-CleanPkg
    Push-Location twingate-task
    npm install -f
    npm run build
    Pop-Location
}
function New-Package {
    Build-Task
    Push-Location twingate-task
    npm prune --production
    Pop-Location
    tfx extension create --manifest-globs vss-extension.json
}

switch ($task) {
    "clean" { Start-CleanPkg }
    "lint" { Start-Lint }
    "build" { Build-Task }
    "package" { New-Package }
    default { Write-Host "Unknown task. Running 'build' by default."; Build-Task }
}
