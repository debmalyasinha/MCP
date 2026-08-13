[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
    [Parameter(Mandatory)]
    [string]$BackupDirectory,

    [Parameter(Mandatory)]
    [string]$DataRoot,

    [switch]$AllowUnencryptedStorageTesting
)

$ErrorActionPreference = "Stop"

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

Assert-LocalAbsolutePath $BackupDirectory "BackupDirectory"
$backupPath = [System.IO.Path]::GetFullPath($BackupDirectory)
if (-not (Test-Path -LiteralPath $backupPath -PathType Container)) {
    throw "BackupDirectory does not exist."
}
Assert-NoReparsePoints $backupPath "BackupDirectory"
$backupScript = (Resolve-Path (Join-Path $PSScriptRoot "backup_careview.py")).Path
Assert-LocalAbsolutePath $DataRoot "DataRoot"
$targetPath = [System.IO.Path]::GetFullPath($DataRoot)
if ($targetPath -eq [System.IO.Path]::GetPathRoot($targetPath)) {
    throw "DataRoot cannot be a drive root."
}
if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) {
    throw "DataRoot must already be initialized with initialize-careview-storage.ps1."
}
Assert-NoReparsePoints $targetPath "DataRoot"
$storageMarker = Join-Path $targetPath ".careview-storage.json"
$storageConfiguration = Get-Content -LiteralPath $storageMarker -Raw | ConvertFrom-Json
if ($storageConfiguration.version -ne 1 -or $storageConfiguration.purpose -ne "Data" -or
    -not ([string]$storageConfiguration.dataRoot).Equals($targetPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "DataRoot initialization metadata is invalid."
}
Assert-RestrictedRootDacl $targetPath ([string]$storageConfiguration.ownerSid) "DataRoot"
$backupRoot = [System.IO.Directory]::GetParent($backupPath).FullName
$backupMarker = Join-Path $backupRoot ".careview-storage.json"
if (-not (Test-Path -LiteralPath $backupMarker -PathType Leaf)) {
    throw "BackupDirectory must be directly inside an initialized Careview Backup root."
}
$backupConfiguration = Get-Content -LiteralPath $backupMarker -Raw | ConvertFrom-Json
if ($backupConfiguration.version -ne 1 -or $backupConfiguration.purpose -ne "Backup" -or
    -not ([string]$backupConfiguration.dataRoot).Equals($backupRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Backup root initialization metadata is invalid."
}
Assert-RestrictedRootDacl $backupRoot ([string]$backupConfiguration.ownerSid) "BackupRoot"
$unencryptedRoots = @()
if (-not (Test-LiveBitLockerProtection $targetPath)) {
    $unencryptedRoots += "DataRoot"
}
if (-not (Test-LiveBitLockerProtection $backupRoot)) {
    $unencryptedRoots += "BackupRoot"
}
if ($unencryptedRoots.Count -gt 0 -and -not $AllowUnencryptedStorageTesting) {
    throw "Live BitLocker protection is not on or could not be verified for: $($unencryptedRoots -join ', '). Use -AllowUnencryptedStorageTesting only with synthetic data."
}
if ($unencryptedRoots.Count -gt 0) {
    Write-Warning "Live BitLocker protection is not on or could not be verified for $($unencryptedRoots -join ', '). This restore override is approved only for synthetic test data."
}
$targetPrefix = $targetPath.TrimEnd('\') + '\'
$backupPrefix = $backupPath.TrimEnd('\') + '\'
if ($targetPath.Equals($backupPath, [System.StringComparison]::OrdinalIgnoreCase) -or
    $targetPath.StartsWith($backupPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    $backupPath.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "BackupDirectory and DataRoot must be separate and not nested."
}

if (-not $PSCmdlet.ShouldProcess($targetPath, "Replace the Careview database and evidence media from $backupPath")) {
    return
}

$instanceLockPath = Join-Path $targetPath ".careview-instance.lock"
try {
    $instanceLock = [System.IO.File]::Open(
        $instanceLockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
} catch {
    throw "Careview is running or another restore is using this DataRoot. Stop Careview before restoring. $($_.Exception.Message)"
}

try {
    $stagePath = Join-Path $targetPath (".restore-stage-" + [Guid]::NewGuid().ToString("N"))
    & python $backupScript --prepare-restore $backupPath --destination $stagePath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $stagePath "careview.db") -PathType Leaf)) {
        throw "The backup failed verification or restore staging. Live data was not changed."
    }

    $databaseNames = @("careview.db", "careview.db-wal", "careview.db-shm", "careview.db-journal")
    $existingDatabase = Join-Path $targetPath "careview.db"
    $existingMedia = Join-Path $targetPath "media"
    $stagedMedia = Join-Path $stagePath "media"
    $safetyPath = Join-Path $targetPath ("pre-restore-" + (Get-Date -Format "yyyyMMddTHHmmss") + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    $installedDatabase = $false
    $installedMedia = $false

    try {
        $hasExistingRecord = (Test-Path -LiteralPath $existingMedia) -or
            (@($databaseNames | Where-Object { Test-Path -LiteralPath (Join-Path $targetPath $_) -PathType Leaf }).Count -gt 0)
        if ($hasExistingRecord) {
            New-Item -ItemType Directory -Path $safetyPath -ErrorAction Stop | Out-Null
            foreach ($name in $databaseNames) {
                $liveFile = Join-Path $targetPath $name
                if (Test-Path -LiteralPath $liveFile -PathType Leaf) {
                    Move-Item -LiteralPath $liveFile -Destination (Join-Path $safetyPath $name) -ErrorAction Stop
                }
            }
            if (Test-Path -LiteralPath $existingMedia -PathType Container) {
                Move-Item -LiteralPath $existingMedia -Destination (Join-Path $safetyPath "media") -ErrorAction Stop
            }
        }

        Move-Item -LiteralPath (Join-Path $stagePath "careview.db") -Destination $existingDatabase -ErrorAction Stop
        $installedDatabase = $true
        if (Test-Path -LiteralPath $stagedMedia -PathType Container) {
            Move-Item -LiteralPath $stagedMedia -Destination $existingMedia -ErrorAction Stop
        } else {
            New-Item -ItemType Directory -Path $existingMedia -ErrorAction Stop | Out-Null
        }
        $installedMedia = $true
    } catch {
        $restoreFailure = $_.Exception.Message
        $rollbackErrors = [System.Collections.Generic.List[string]]::new()
        $failedInstallPath = Join-Path $stagePath "failed-install"
        try {
            if (-not (Test-Path -LiteralPath $failedInstallPath -PathType Container)) {
                New-Item -ItemType Directory -Path $failedInstallPath -ErrorAction Stop | Out-Null
            }
        } catch {
            $rollbackErrors.Add("Could not create failed-install staging: $($_.Exception.Message)")
        }
        if ($installedDatabase -and (Test-Path -LiteralPath $existingDatabase -PathType Leaf)) {
            try {
                Move-Item -LiteralPath $existingDatabase -Destination (Join-Path $failedInstallPath "careview.db") -ErrorAction Stop
            } catch {
                $rollbackErrors.Add("Could not quarantine restored database: $($_.Exception.Message)")
            }
        }
        if ($installedMedia -and (Test-Path -LiteralPath $existingMedia -PathType Container)) {
            try {
                Move-Item -LiteralPath $existingMedia -Destination (Join-Path $failedInstallPath "media") -ErrorAction Stop
            } catch {
                $rollbackErrors.Add("Could not quarantine restored media: $($_.Exception.Message)")
            }
        }
        if (Test-Path -LiteralPath $safetyPath -PathType Container) {
            foreach ($name in $databaseNames) {
                $savedFile = Join-Path $safetyPath $name
                $liveFile = Join-Path $targetPath $name
                if (Test-Path -LiteralPath $savedFile -PathType Leaf) {
                    try {
                        if (Test-Path -LiteralPath $liveFile) {
                            throw "Destination still exists: $liveFile"
                        }
                        Move-Item -LiteralPath $savedFile -Destination $liveFile -ErrorAction Stop
                    } catch {
                        $rollbackErrors.Add("Could not restore $name`: $($_.Exception.Message)")
                    }
                }
            }
            $savedMedia = Join-Path $safetyPath "media"
            if (Test-Path -LiteralPath $savedMedia -PathType Container) {
                try {
                    if (Test-Path -LiteralPath $existingMedia) {
                        throw "Destination still exists: $existingMedia"
                    }
                    Move-Item -LiteralPath $savedMedia -Destination $existingMedia -ErrorAction Stop
                } catch {
                    $rollbackErrors.Add("Could not restore previous media: $($_.Exception.Message)")
                }
            }
        }
        $rollbackSummary = if ($rollbackErrors.Count) { " Rollback errors: $($rollbackErrors -join ' | ')" } else { " Previous data was restored." }
        throw "Restore failed. Inspect $stagePath and $safetyPath before restarting Careview. $restoreFailure$rollbackSummary"
    }

    try {
        if (Test-Path -LiteralPath $stagePath -PathType Container) {
            Remove-Item -LiteralPath $stagePath -Recurse -Force -ErrorAction Stop
        }
    } catch {
        Write-Warning "Restore succeeded, but its empty staging directory could not be removed: $stagePath. $($_.Exception.Message)"
    }

    Write-Host "Careview restored to: $targetPath"
    Write-Host "All restored browser sessions were revoked; users must sign in again."
    if (Test-Path -LiteralPath $safetyPath) {
        Write-Host "Previous data was preserved at: $safetyPath"
    }
} finally {
    if ($null -ne $instanceLock) {
        $instanceLock.Dispose()
    }
}
