[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$DataRoot,

    [ValidateSet("Data", "Backup")]
    [string]$Purpose = "Data",

    [switch]$AllowUnencryptedForTesting
)

$ErrorActionPreference = "Stop"

function Assert-LocalAbsolutePath([string]$Path, [string]$Label) {
    if (-not [System.IO.Path]::IsPathRooted($Path) -or
        $Path.StartsWith("\\") -or
        $Path -notmatch '^[A-Za-z]:[\\/]') {
        throw "$Label must be an absolute path on a local drive."
    }
}

function Assert-NoReparseAncestors([string]$Path) {
    $current = [System.IO.DirectoryInfo]::new([System.IO.Path]::GetFullPath($Path))
    while ($null -ne $current) {
        if ($current.Exists) {
            $item = Get-Item -LiteralPath $current.FullName -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Careview storage cannot be at or below a symbolic link, junction, mount point, or other reparse point: $($item.FullName)"
            }
        }
        $current = $current.Parent
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

function Set-AndVerifyRestrictedDacl([string]$Path) {
    $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = $currentIdentity.User
    $systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
    $administratorsSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
    $requiredSids = @($currentSid, $systemSid, $administratorsSid)

    # Work from the existing security descriptor so the mandatory integrity
    # label (a SACL entry) is not confused with, or treated as, a DACL grant.
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        try {
            $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])
            $acl.PurgeAccessRules($sid)
        } catch {
            throw "Windows could not normalize an existing Careview access rule. $($_.Exception.Message)"
        }
    }
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($sid in $requiredSids) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    $acl.SetOwner($currentSid)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop

    $verified = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not $verified.AreAccessRulesProtected) {
        throw "Careview storage DACL inheritance was not disabled."
    }
    $allowed = @{}
    foreach ($sid in $requiredSids) {
        $allowed[$sid.Value] = $false
    }
    $accessRules = @($verified.Access)
    if ($accessRules.Count -ne $requiredSids.Count) {
        throw "Careview storage DACL contains an unexpected number of access rules."
    }
    foreach ($rule in $accessRules) {
        $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        $hasFullControl = ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
            [System.Security.AccessControl.FileSystemRights]::FullControl
        $hasContainerInheritance = ($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0
        $hasObjectInheritance = ($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0
        if (-not $allowed.ContainsKey($sid) -or
            $rule.IsInherited -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            -not $hasFullControl -or
            -not $hasContainerInheritance -or
            -not $hasObjectInheritance -or
            $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
            throw "Careview storage DACL verification failed for identity $sid."
        }
        if ($allowed[$sid]) {
            throw "Careview storage DACL contains duplicate access rules for identity $sid."
        }
        $allowed[$sid] = $true
    }
    if ($allowed.Values -contains $false) {
        throw "Careview storage DACL is missing a required protected identity."
    }
    return $currentSid.Value
}

Assert-LocalAbsolutePath $DataRoot "DataRoot"
$dataRootPath = [System.IO.Path]::GetFullPath($DataRoot)
if ($dataRootPath -eq [System.IO.Path]::GetPathRoot($dataRootPath)) {
    throw "DataRoot cannot be a drive root. Choose a dedicated directory."
}
$oneDrivePath = [string]$env:OneDrive
if ($oneDrivePath) {
    $oneDriveRoot = [System.IO.Path]::GetFullPath($oneDrivePath).TrimEnd('\')
    $oneDrivePrefix = $oneDriveRoot + '\'
    if ($dataRootPath.Equals($oneDriveRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $dataRootPath.StartsWith($oneDrivePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "DataRoot cannot be inside OneDrive or another synchronized user folder."
    }
}

Assert-NoReparseAncestors $dataRootPath
$rootAlreadyExists = Test-Path -LiteralPath $dataRootPath
if ($rootAlreadyExists) {
    $dataRootItem = Get-Item -LiteralPath $dataRootPath -Force -ErrorAction Stop
    if (-not $dataRootItem.PSIsContainer) {
        throw "DataRoot must be a directory."
    }
    if (@(Get-ChildItem -LiteralPath $dataRootPath -Force -ErrorAction Stop).Count -ne 0) {
        throw "DataRoot must be new or completely empty. Refusing to change permissions on existing data."
    }
}

$driveRoot = [System.IO.Path]::GetPathRoot($dataRootPath)
$encryptionVerified = Test-LiveBitLockerProtection $dataRootPath
if (-not $encryptionVerified -and -not $AllowUnencryptedForTesting) {
    throw "BitLocker protection could not be verified as on for $driveRoot. Enable BitLocker or rerun with -AllowUnencryptedForTesting for synthetic data only."
}

if (-not $PSCmdlet.ShouldProcess($dataRootPath, "Create and ACL-harden the Careview data directory")) {
    return
}
if (-not $rootAlreadyExists) {
    New-Item -ItemType Directory -Path $dataRootPath | Out-Null
}
Assert-NoReparseAncestors $dataRootPath
$currentSid = Set-AndVerifyRestrictedDacl $dataRootPath

$configuration = [ordered]@{
    version = 1
    purpose = $Purpose
    dataRoot = $dataRootPath
    initializedAt = [DateTime]::UtcNow.ToString("o")
    ownerSid = $currentSid
    encryptionVerified = $encryptionVerified
}
$configuration | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataRootPath ".careview-storage.json") -Encoding UTF8
if ($Purpose -eq "Data") {
    New-Item -ItemType Directory -Path (Join-Path $dataRootPath "media") -Force | Out-Null
}

Write-Host "Careview $($Purpose.ToLowerInvariant()) storage initialized: $dataRootPath"
Write-Host "BitLocker verified: $encryptionVerified"
if (-not $encryptionVerified) {
    Write-Warning "This storage root is approved only for synthetic evidence testing."
}
