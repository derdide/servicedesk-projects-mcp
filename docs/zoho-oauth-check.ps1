<#
  Zoho OAuth feasibility check for the multi-user servicedesk-projects MCP server.
  Simulates what Claude / Copilot will do: authorization code + PKCE (S256) + access_type=offline,
  then token refresh, a ServiceDesk call and a user-info call.
  Prints PASS / FAIL lines only - no tokens or secrets are printed.

  Before running: create a "Server-based Application" in https://api-console.zoho.eu
  (or the console of your data centre) with the redirect URI http://localhost:8765/callback.
#>

$ClientId     = Read-Host "Zoho client ID"
$ClientSecret = Read-Host "Zoho client secret"
$Accounts     = Read-Host "Zoho accounts URL (e.g. https://accounts.zoho.eu)"
$SdpUrl       = Read-Host "ServiceDesk base URL (e.g. https://sdpondemand.manageengine.eu or your custom domain)"
$Portal       = Read-Host "ServiceDesk portal name"
$SdpBase      = "$SdpUrl/app/$Portal/api/v3"
$Redirect     = "http://localhost:8765/callback"
$Scope        = "SDPOnDemand.projects.READ,SDPOnDemand.projects.CREATE,SDPOnDemand.projects.UPDATE,AaaServer.profile.READ"

function B64Url([byte[]]$b) { [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_') }
function Result($name, $ok, $note = "") { "{0,-5} {1} {2}" -f ($(if ($ok) {"PASS"} else {"FAIL"})), $name, $note }

# 1. Discovery document
try {
  $disc = Invoke-RestMethod "$Accounts/.well-known/openid-configuration"
  Result "1 Discovery document exists" $true
  Result "1b PKCE S256 advertised" ($disc.code_challenge_methods_supported -contains "S256") "($($disc.code_challenge_methods_supported -join ','))"
  Result "1c Registration endpoint (DCR)" ([bool]$disc.registration_endpoint) "(optional)"
} catch { Result "1 Discovery document exists" $false $_.Exception.Message }

# 2. Authorization with PKCE + offline access
function New-Pkce {
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $v = B64Url $bytes
  $c = B64Url ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::ASCII.GetBytes($v)))
  @{ Verifier = $v; Challenge = $c }
}
function Get-Code($challenge) {
  $url = "$Accounts/oauth/v2/auth?response_type=code&client_id=$ClientId" +
         "&scope=$Scope&redirect_uri=$([uri]::EscapeDataString($Redirect))" +
         "&access_type=offline&prompt=consent&state=check" +
         "&code_challenge=$challenge&code_challenge_method=S256"
  Start-Process $url
  Write-Host "`nSign in in the browser (you should land on your SSO page, if ServiceDesk uses SSO)."
  Write-Host "The browser then shows an error page on localhost:8765 - that is expected."
  $back = Read-Host "Paste the FULL address from the browser's address bar"
  if ($back -match "[?&]code=([^&]+)") { return [uri]::UnescapeDataString($Matches[1]) }
  throw "No code found in the address"
}
function Get-Token($code, $verifier) {
  Invoke-RestMethod -Method Post -Uri "$Accounts/oauth/v2/token" -Body @{
    grant_type = "authorization_code"; client_id = $ClientId; client_secret = $ClientSecret
    redirect_uri = $Redirect; code = $code; code_verifier = $verifier }
}

$p = New-Pkce
$tok = Get-Token (Get-Code $p.Challenge) $p.Verifier
Result "2 Code exchange with PKCE" ([bool]$tok.access_token) $(if ($tok.error) { "($($tok.error))" })
Result "2b Refresh token issued (access_type=offline)" ([bool]$tok.refresh_token)

# 3. Token works against ServiceDesk ("Zoho-oauthtoken" header)
try {
  $q = [uri]::EscapeDataString('{"list_info":{"row_count":1}}')
  $r = Invoke-RestMethod "$SdpBase/projects?input_data=$q" -Headers @{
    Authorization = "Zoho-oauthtoken $($tok.access_token)"; Accept = "application/vnd.manageengine.sdp.v3+json" }
  Result "3 ServiceDesk call with user token" ($null -ne $r.projects)
} catch { Result "3 ServiceDesk call with user token" $false $_.Exception.Message }

# 3b. Same call with a standard "Bearer" header (nice to have)
try {
  $r = Invoke-RestMethod "$SdpBase/projects?input_data=$q" -Headers @{
    Authorization = "Bearer $($tok.access_token)"; Accept = "application/vnd.manageengine.sdp.v3+json" }
  Result "3b ServiceDesk accepts 'Bearer' header" ($null -ne $r.projects) "(optional)"
} catch { Result "3b ServiceDesk accepts 'Bearer' header" $false "(optional)" }

# 4. User identity for the audit log
try {
  $me = Invoke-RestMethod "$Accounts/oauth/user/info" -Headers @{ Authorization = "Zoho-oauthtoken $($tok.access_token)" }
  Result "4 User info returns an email" ([bool]$me.Email)
} catch { Result "4 User info returns an email" $false $_.Exception.Message }

# 5. Refresh
try {
  $ref = Invoke-RestMethod -Method Post -Uri "$Accounts/oauth/v2/token" -Body @{
    grant_type = "refresh_token"; client_id = $ClientId; client_secret = $ClientSecret; refresh_token = $tok.refresh_token }
  Result "5 Refresh works" ([bool]$ref.access_token) "(new refresh token returned: $([bool]$ref.refresh_token))"
} catch { Result "5 Refresh works" $false $_.Exception.Message }

# 6. Is PKCE actually enforced? (second sign-in, deliberately wrong verifier)
$ans = Read-Host "`nRun the PKCE enforcement test (one more sign-in)? y/n"
if ($ans -eq "y") {
  $p2 = New-Pkce
  $code2 = Get-Code $p2.Challenge
  $bad = Get-Token $code2 "wrong-verifier-wrong-verifier-wrong-verifier-123"
  Result "6 Wrong PKCE verifier is rejected" (-not $bad.access_token) "(FAIL here = Zoho ignores PKCE; still workable)"
}

Write-Host "`nPaste these PASS/FAIL lines into the chat. Do not paste tokens or the client secret."
