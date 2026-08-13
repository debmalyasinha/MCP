[CmdletBinding()]
param(
    [switch]$Lan,

    [switch]$SecureCookie,

    [string]$DataRoot = "",

    [switch]$RetainEvidence,

    [Alias("AllowUnencryptedEvidenceTesting")]
    [switch]$AllowUnencryptedDataTesting,

    [ValidateRange(1, 65535)]
    [int]$Port = 4173
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Assert-LocalAbsolutePath([string]$Path, [string]$Label) {
    if (-not [System.IO.Path]::IsPathRooted($Path) -or
        $Path.StartsWith("\\") -or
        $Path -notmatch '^[A-Za-z]:[\\/]') {
        throw "$Label must be an absolute path on a local drive."
    }
}

function Assert-NoReparsePoints([string]$Path, [string]$Label) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $cursor = [System.IO.DirectoryInfo]::new($fullPath)
    while ($null -ne $cursor) {
        if ($cursor.Exists) {
            $item = Get-Item -LiteralPath $cursor.FullName -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Label cannot be at or below a symbolic link, junction, mount point, or other reparse point: $($item.FullName)"
            }
        }
        $cursor = $cursor.Parent
    }
    if (Test-Path -LiteralPath $fullPath -PathType Container) {
        $pending = [System.Collections.Generic.Stack[string]]::new()
        $pending.Push($fullPath)
        while ($pending.Count -gt 0) {
            $directory = $pending.Pop()
            foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($directory)) {
                $attributes = [System.IO.File]::GetAttributes($entry)
                if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "$Label cannot contain a symbolic link, junction, mount point, or other reparse point: $entry"
                }
                if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
                    $pending.Push($entry)
                }
            }
        }
    }
}

function Test-LiveBitLockerProtection([string]$Path) {
    $driveRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
    try {
        $volume = Get-BitLockerVolume -MountPoint $driveRoot -ErrorAction Stop
        return [string]$volume.ProtectionStatus -eq "On"
    } catch {
        return $false
    }
}

function Assert-RestrictedRootDacl([string]$Path, [string]$OwnerSid) {
    if ($OwnerSid -notmatch '^S-1-\d+(?:-\d+)+$') {
        throw "DataRoot initialization metadata contains an invalid owner SID."
    }
    $required = @{}
    foreach ($sid in @($OwnerSid, "S-1-5-18", "S-1-5-32-544")) {
        $required[$sid] = $false
    }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) {
        throw "DataRoot no longer has its required protected DACL."
    }
    $rules = @($acl.Access)
    if ($rules.Count -ne $required.Count) {
        throw "DataRoot DACL contains unexpected access rules. Reinitialize a new empty storage root."
    }
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        $hasFullControl = ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
            [System.Security.AccessControl.FileSystemRights]::FullControl
        $hasContainerInheritance = ($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0
        $hasObjectInheritance = ($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0
        if (-not $required.ContainsKey($sid) -or
            $required[$sid] -or
            $rule.IsInherited -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            -not $hasFullControl -or
            -not $hasContainerInheritance -or
            -not $hasObjectInheritance -or
            $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
            throw "DataRoot DACL verification failed for identity $sid."
        }
        $required[$sid] = $true
    }
    if ($required.Values -contains $false) {
        throw "DataRoot DACL is missing a required protected identity."
    }
}

if ($RetainEvidence -and $Lan) {
    throw "Retained patient evidence cannot use direct plain-HTTP LAN mode. Put an HTTPS reverse proxy in front of loopback Careview instead."
}
if ($Lan -and $SecureCookie) {
    throw "-SecureCookie cannot be used with direct plain-HTTP -Lan mode."
}
if ($Lan -and -not [string]::IsNullOrWhiteSpace($DataRoot)) {
    throw "A durable DataRoot cannot use direct plain-HTTP LAN mode. Use an HTTPS reverse proxy to loopback Careview."
}
if ($RetainEvidence -and -not $SecureCookie) {
    throw "Retained patient evidence requires -SecureCookie and an HTTPS reverse proxy."
}
if ($RetainEvidence -and [string]::IsNullOrWhiteSpace($DataRoot)) {
    throw "Retained evidence requires an initialized, absolute -DataRoot."
}
if ([string]::IsNullOrWhiteSpace($DataRoot) -and -not $AllowUnencryptedDataTesting) {
    throw "The default repository database is unencrypted synthetic storage. For synthetic data only, rerun with -AllowUnencryptedDataTesting. For durable records, initialize and pass a BitLocker-protected -DataRoot."
}

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

if (-not [string]::IsNullOrWhiteSpace($DataRoot)) {
    Assert-LocalAbsolutePath $DataRoot "DataRoot"
    $dataRootPath = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd([char[]]@('\', '/'))
    $projectPrefix = $projectRoot.TrimEnd('\') + '\'
    $embeddedDataRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "private-data")).TrimEnd([char[]]@('\', '/'))
    $isInsideProject = $dataRootPath.Equals($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $dataRootPath.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    if ($isInsideProject -and
        -not $dataRootPath.Equals($embeddedDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Inside the Careview repository, DataRoot must be the dedicated private-data directory: $embeddedDataRoot"
    }
    if ($dataRootPath.Equals($embeddedDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Warning "Careview records are stored inside the project tree. The directory is Git-ignored, but deleting or cleaning the project can remove it; keep verified backups elsewhere."
    }
    if (-not (Test-Path -LiteralPath $dataRootPath -PathType Container)) {
        throw "DataRoot does not exist. Initialize it first with scripts\initialize-careview-storage.ps1."
    }
    Assert-NoReparsePoints $dataRootPath "DataRoot"
    $storageMarker = Join-Path $dataRootPath ".careview-storage.json"
    if (-not (Test-Path -LiteralPath $storageMarker -PathType Leaf)) {
        throw "DataRoot is not initialized. Run scripts\initialize-careview-storage.ps1 first."
    }
    $storageConfiguration = Get-Content -LiteralPath $storageMarker -Raw | ConvertFrom-Json
    if ($storageConfiguration.version -ne 1 -or $storageConfiguration.purpose -ne "Data" -or
        -not ([string]$storageConfiguration.dataRoot).Equals($dataRootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "DataRoot initialization metadata is invalid or belongs to another directory."
    }
    Assert-RestrictedRootDacl $dataRootPath ([string]$storageConfiguration.ownerSid)
    $encryptionVerifiedNow = Test-LiveBitLockerProtection $dataRootPath
    if (-not $encryptionVerifiedNow -and -not $AllowUnencryptedDataTesting) {
        throw "Live BitLocker protection could not be verified for DataRoot. Enable BitLocker, or use -AllowUnencryptedDataTesting only with synthetic data."
    }
    if (-not $encryptionVerifiedNow) {
        Write-Warning "Live BitLocker protection is not on or could not be verified. This run is approved only for synthetic test records."
    }
    $databasePath = Join-Path $dataRootPath "careview.db"
    $mediaDirectory = Join-Path $dataRootPath "media"
    $serverArguments += @("--database", $databasePath, "--media-directory", $mediaDirectory)
    Write-Host "Careview data root: $dataRootPath"
} else {
    $dataRootPath = Join-Path $projectRoot "data"
    Assert-NoReparsePoints $dataRootPath "Default synthetic data root"
    Write-Warning "Using unencrypted repository storage under $dataRootPath. This explicit override is for synthetic test records only."
}

if ($RetainEvidence) {
    $serverArguments += "--retain-evidence"
    Write-Warning "Evidence retention is enabled. Prepared JPEG evidence will become part of the patient record. Use an access-controlled, encrypted volume and HTTPS."
}

if ($SecureCookie) {
    $serverArguments += "--secure-cookie"
}

if ($Lan) {
    $serverArguments += "--allow-insecure-lan-testing"
    Write-Warning "Careview LAN mode uses plain HTTP. Use only synthetic test users, patients, and media; credentials and records are not protected in transit."
}

try {
    $env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
    & python @serverArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Careview server exited with code $LASTEXITCODE."
    }
} finally {
    Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
    Remove-Variable secureKey -ErrorAction SilentlyContinue
}
