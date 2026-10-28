param(
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archivePath = [System.IO.Path]::GetFullPath($ArchivePath)
$destinationPath = [System.IO.Path]::GetFullPath($DestinationPath)
New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null
$rootPrefix = $destinationPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
  [System.IO.Path]::DirectorySeparatorChar
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($entry in $archive.Entries) {
    $relativePath = $entry.FullName.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    if ([System.IO.Path]::IsPathRooted($relativePath)) {
      throw "AI pack contains an absolute path: $($entry.FullName)"
    }
    $targetPath = [System.IO.Path]::GetFullPath(
      [System.IO.Path]::Combine($destinationPath, $relativePath)
    )
    if (-not $targetPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "AI pack path escapes its install directory: $($entry.FullName)"
    }
    $unixFileType = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($unixFileType -eq 0xA000) {
      throw "AI pack contains a symbolic link: $($entry.FullName)"
    }
  }
} finally {
  $archive.Dispose()
}

[System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $destinationPath)
