param (
    [string]$task = "build"
)

function CleanPkg {
    Remove-Item *.vsix -ErrorAction SilentlyContinue
    Remove-Item twingate-task/index.js -ErrorAction SilentlyContinue
}

function Lint {
    Push-Location twingate-task
    npm install -f
    npm run lint
    Pop-Location
}

function Build-Task {
    CleanPkg
    Push-Location twingate-task
    npm install -f
    tsc -b
    Pop-Location
}
function Package {
    Build-Task
    Push-Location twingate-task
    npm prune --production
    Pop-Location
    tfx extension create --manifest-globs vss-extension.json
}

switch ($task) {
    "clean" { CleanPkg }
    "lint" { Lint }
    "build" { Build-Task }
    "package" { Package }
    default { Write-Host "Unknown task. Running 'build' by default."; Build-Task }
}
