param(
  [Parameter(Mandatory = $true)]
  [int]$MatchId,
  [Parameter(Mandatory = $true)]
  [string]$Secret,
  [string]$BaseUrl = "https://tf-player.site",
  [string]$Version = "",
  [string]$Provider = "manual"
)

$ts = [int][double]::Parse((Get-Date -UFormat %s))
$payload = @{
  type = "watch-state-change"
  version = $(if ($Version) { $Version } else { "manual-$ts" })
  updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  provider = $Provider
  payload = @{
    provider = $Provider
    state = "ready"
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
} | ConvertTo-Json -Depth 10 -Compress

$hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
$signatureBytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$ts.$payload"))
$signature = -join ($signatureBytes | ForEach-Object { $_.ToString("x2") })

$headers = @{
  "x-tf-edge-timestamp" = "$ts"
  "x-tf-edge-signature" = $signature
  "content-type" = "application/json"
}

Invoke-RestMethod -Method Post -Uri "$BaseUrl/__edge-watch/publish/$MatchId" -Headers $headers -Body $payload
