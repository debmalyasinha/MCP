[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$DataRoot,

    [Parameter(Mandatory)]
    [string]$BackupRoot,

    [Alias("AllowUnencryptedBackupTesting")]
    [switch]$AllowUnencryptedStorageTesting
)

$ErrorActionPreference = "Stop"

function Assert-NoReparsePoints([string]$Path, [string]$Label) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $cursor = [System.IO.DirectoryInfo]::new($fullPath)
    while ($null -ne $cursor) {
        if ($cursor.Exists -and
            (([System.IO.File]::GetAttributes($cursor.FullName) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "$Label cannot be at or below a symbolic link, junction, mount point, or other reparse point: $($cursor.FullName)"
        }
        $cursor = $cursor.Parent
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        return
    }
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

function Test-LiveBitLockerProtection([string]$Path) {
    $driveRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path))
    try {
        $volume = Get-BitLockerVolume -MountPoint $driveRoot -ErrorAction Stop
        return [string]$volume.ProtectionStatus -eq "On"
    } catch {
        return $false
    }
}

function Assert-RestrictedRootDacl([string]$Path, [string]$OwnerSid, [string]$Label) {
    if ($OwnerSid -notmatch '^S-1-\d+(?:-\d+)+$') {
        throw "$Label initialization metadata contains an invalid owner SID."
    }
    $required = @{}
    foreach ($sid in @($OwnerSid, "S-1-5-18", "S-1-5-32-544")) {
        $required[$sid] = $false
    }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) {
        throw "$Label no longer has its required protected DACL."
    }
    $rules = @($acl.Access)
    if ($rules.Count -ne $required.Count) {
        throw "$Label DACL contains unexpected access rules."
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
            throw "$Label DACL verification failed for identity $sid."
        }
        $required[$sid] = $true
    }
    if ($required.Values -contains $false) {
        throw "$Label DACL is missing a required protected identity."
    }
}

function Get-InitializedRoot([string]$Path, [string]$ExpectedPurpose) {
    if (-not [System.IO.Path]::IsPathRooted($Path) -or
        $Path.StartsWith("\\") -or
        $Path -notmatch '^[A-Za-z]:[\\/]') {
        throw "$ExpectedPurpose root must be an absolute path on a local drive."
    }
    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "$ExpectedPurpose root does not exist."
    }
    Assert-NoReparsePoints $resolved "$ExpectedPurpose root"
    $markerPath = Join-Path $resolved ".careview-storage.json"
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw "$ExpectedPurpose root is not initialized with initialize-careview-storage.ps1."
    }
    $configuration = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($configuration.version -ne 1 -or $configuration.purpose -ne $ExpectedPurpose -or
        -not ([string]$configuration.dataRoot).Equals($resolved, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$ExpectedPurpose root initialization metadata is invalid."
    }
    Assert-RestrictedRootDacl $resolved ([string]$configuration.ownerSid) "$ExpectedPurpose root"
    return [PSCustomObject]@{ Path = $resolved; Configuration = $configuration }
}

$data = Get-InitializedRoot $DataRoot "Data"
$backup = Get-InitializedRoot $BackupRoot "Backup"
$unencryptedRoots = @()
if (-not (Test-LiveBitLockerProtection $data.Path)) {
    $unencryptedRoots += "DataRoot"
}
if (-not (Test-LiveBitLockerProtection $backup.Path)) {
    $unencryptedRoots += "BackupRoot"
}
if ($unencryptedRoots.Count -gt 0 -and -not $AllowUnencryptedStorageTesting) {
    throw "Live BitLocker protection is not on or could not be verified for: $($unencryptedRoots -join ', '). Use -AllowUnencryptedStorageTesting only with synthetic data."
}
if ($unencryptedRoots.Count -gt 0) {
    Write-Warning "Live BitLocker protection is not on or could not be verified for $($unencryptedRoots -join ', '). This backup override is approved only for synthetic test data."
}

$backupScript = (Resolve-Path (Join-Path $PSScriptRoot "backup_careview.py")).Path
& python $backupScript --data-root $data.Path --backup-root $backup.Path
if ($LASTEXITCODE -ne 0) {
    throw "Careview backup failed with code $LASTEXITCODE."
}
