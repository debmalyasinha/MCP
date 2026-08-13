[CmdletBinding()]
param(
    [switch]$Lan,

    [switch]$SecureCookie,

    [ValidateRange(1, 65535)]
    [int]$Port = 4173
)

$ErrorActionPreference = "Stop"

try {
    Import-Module Microsoft.PowerShell.SecretManagement -ErrorAction Stop
} catch {
    throw "PowerShell SecretManagement is unavailable. Install Microsoft.PowerShell.SecretManagement and Microsoft.PowerShell.SecretStore for the current user. $($_.Exception.Message)"
}

try {
    $secureKey = Get-Secret -Name "careview" -Vault "CareviewVault" -ErrorAction Stop
} catch {
    throw "Could not read secret 'careview' from vault 'CareviewVault'. Make sure the vault and secret were created. $($_.Exception.Message)"
}

if ($secureKey -isnot [System.Security.SecureString]) {
    throw "Vault secret 'careview' must be stored as a SecureString."
}

$bindAddress = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
$serverPath = (Resolve-Path (Join-Path $PSScriptRoot "..\server.py")).Path
$serverArguments = @($serverPath, "--bind", $bindAddress, "--port", $Port)

if ($SecureCookie) {
    $serverArguments += "--secure-cookie"
}

if ($Lan) {
    Write-Warning "Careview LAN mode uses plain HTTP. Use only synthetic test users, patients, and media; credentials and records are not protected in transit."
}

try {
    $env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
    & python @serverArguments
} finally {
    Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
    Remove-Variable secureKey -ErrorAction SilentlyContinue
}
