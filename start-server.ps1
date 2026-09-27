Set-Location -LiteralPath $PSScriptRoot
$env:COOKIE_SECURE = "1"

$node = "C:\nvm4w\nodejs\node.exe"
$server = Join-Path $PSScriptRoot "server.js"
$log = Join-Path $PSScriptRoot "data\server-startup.log"

& $node $server >> $log 2>&1
exit $LASTEXITCODE
