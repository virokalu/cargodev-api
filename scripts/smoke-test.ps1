# Smoke test for a running CargoDev API (staging or a local run). Works in PowerShell 7 and Windows PowerShell 5.1.
#
#   $env:SMOKE_ADMIN_EMAIL = "..."; $env:SMOKE_ADMIN_PASSWORD = "..."     # a test account, never a real person's
#   ./scripts/smoke-test.ps1 -BaseUrl https://your-api.example.test
#
# Optional accounts (a check is SKIPPED, not passed, when its variables are missing):
#   SMOKE_MANAGER_*, SMOKE_OPERATOR_*, SMOKE_VIEWER_*  (EMAIL and PASSWORD each)
#
# It prints one PASS / FAIL / SKIP line per check and nothing else: never a token, a password or a signed address.
# It changes no data: every request is a read, a refused request, or a bad login. The last check makes bad logins until the
# server answers 429, so run it last and expect login to be blocked for about a minute from this address afterwards.
# Exit code: 0 when nothing failed, 1 otherwise.

param(
  [string]$BaseUrl = $env:BASE_URL
)

$ErrorActionPreference = "Stop"
if (-not $BaseUrl) { Write-Host "FAIL  no base address (pass -BaseUrl or set BASE_URL)"; exit 1 }
$BaseUrl = $BaseUrl.TrimEnd("/")
if ($BaseUrl -notmatch "^https?://") { Write-Host "FAIL  the base address must start with http:// or https://"; exit 1 }

Add-Type -AssemblyName System.Net.Http
$script:failed = 0
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(20)

function Report([string]$name, [bool]$ok, [string]$note = "") {
  if ($ok) { Write-Host ("PASS  " + $name) }
  else { Write-Host ("FAIL  " + $name + $(if ($note) { " (" + $note + ")" } else { "" })); $script:failed++ }
}
function Skip([string]$name, [string]$why) { Write-Host ("SKIP  " + $name + " (" + $why + ")") }

# One request. Returns the status code, the headers (flattened to one lowercase-keyed table) and the body text. Never throws on a status.
function Send([string]$method, [string]$path, [string]$token = "", [string]$json = "") {
  $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::new($method)), ($BaseUrl + $path)
  if ($token) { $request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + $token) | Out-Null }
  if ($json) { $request.Content = New-Object System.Net.Http.StringContent ($json, [System.Text.Encoding]::UTF8, "application/json") }
  try {
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $headers = @{}
    foreach ($h in $response.Headers) { $headers[$h.Key.ToLower()] = ($h.Value -join ",") }
    foreach ($h in $response.Content.Headers) { $headers[$h.Key.ToLower()] = ($h.Value -join ",") }
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return @{ Status = [int]$response.StatusCode; Headers = $headers; Body = $body }
  } catch {
    return @{ Status = 0; Headers = @{}; Body = "" }
  }
}

function Login([string]$prefix) {
  $email = [Environment]::GetEnvironmentVariable("SMOKE_" + $prefix + "_EMAIL")
  $password = [Environment]::GetEnvironmentVariable("SMOKE_" + $prefix + "_PASSWORD")
  if (-not $email -or -not $password) { return $null }
  $body = (@{ email = $email; password = $password } | ConvertTo-Json -Compress)
  $r = Send "POST" "/api/v1/auth/login" "" $body
  if ($r.Status -ne 200) { return "" }
  try { return ($r.Body | ConvertFrom-Json).data.accessToken } catch { return "" }
}

# 1. Health, and the headers every response must carry.
$health = Send "GET" "/health"
Report "health answers 200" ($health.Status -eq 200) ("status " + $health.Status)
Report "health body is { data: { status: ok } }" ($health.Body -match '"status"\s*:\s*"ok"')
Report "Cache-Control: no-store" ($health.Headers["cache-control"] -match "no-store")
Report "X-Content-Type-Options: nosniff" ($health.Headers["x-content-type-options"] -eq "nosniff")
Report "no X-Powered-By header" (-not $health.Headers.ContainsKey("x-powered-by"))
if ($BaseUrl -like "https://*") { Report "Strict-Transport-Security on https" ($health.Headers.ContainsKey("strict-transport-security")) }
else { Skip "Strict-Transport-Security" "plain http" }

# 2. No token, no entry. An unknown path is the standard 404 envelope.
Report "a protected route without a token is 401" ((Send "GET" "/api/v1/vehicles").Status -eq 401)
$missing = Send "GET" "/api/v1/this-route-does-not-exist"
Report "an unknown path is 404 with the error envelope" (($missing.Status -eq 404) -and ($missing.Body -match '"error"'))
$link = Send "GET" "/f/v1/photo/none/full?o=a&u=b&a=staff&exp=1&sig=x"
Report "a forged file link is the plain 404" (($link.Status -eq 404) -and ($link.Headers["cache-control"] -match "no-store"))

# 3. Staff login, and the cross-token refusals.
$admin = Login "ADMIN"
if ($null -eq $admin) { Skip "staff login" "SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD not set" }
else {
  Report "staff login gives a token" ([bool]$admin)
  if ($admin) {
    Report "the staff token opens a staff route" ((Send "GET" "/api/v1/vehicles" $admin).Status -eq 200)
    $customerSide = (Send "GET" "/api/customer/v1/me" $admin).Status
    Report "the staff token is refused by the customer zone" (($customerSide -eq 401) -or ($customerSide -eq 404)) ("status " + $customerSide)
  }
}
$customerEmail = $env:SMOKE_CUSTOMER_EMAIL
$customerPassword = $env:SMOKE_CUSTOMER_PASSWORD
if ($customerEmail -and $customerPassword) {
  $cr = Send "POST" "/api/customer/v1/auth/login" "" (@{ email = $customerEmail; password = $customerPassword } | ConvertTo-Json -Compress)
  $ct = ""
  if ($cr.Status -eq 200) { try { $ct = ($cr.Body | ConvertFrom-Json).data.accessToken } catch { $ct = "" } }
  if ($ct) {
    Report "a customer token is refused by the staff API" ((Send "GET" "/api/v1/vehicles" $ct).Status -eq 401)
  } else { Report "customer login gives a token" $false ("status " + $cr.Status) }
} else { Skip "customer token on the staff API" "SMOKE_CUSTOMER_EMAIL / SMOKE_CUSTOMER_PASSWORD not set" }

# 4. One 403 per role that is not allowed.
$manager = Login "MANAGER"
if ($null -eq $manager) { Skip "MANAGER is refused an administrator job" "SMOKE_MANAGER_* not set" }
else { Report "MANAGER gets 403 on an administrator-only route" ((Send "POST" "/api/v1/admin/jobs/daily-checks" $manager).Status -eq 403) }
$operator = Login "OPERATOR"
if ($null -eq $operator) { Skip "OPERATOR is refused the staff list" "SMOKE_OPERATOR_* not set" }
else { Report "OPERATOR gets 403 on the staff list" ((Send "GET" "/api/v1/staff" $operator).Status -eq 403) }
$viewer = Login "VIEWER"
if ($null -eq $viewer) { Skip "VIEWER is refused a write" "SMOKE_VIEWER_* not set" }
else { Report "VIEWER gets 403 on creating a vehicle" ((Send "POST" "/api/v1/vehicles" $viewer "{}").Status -eq 403) }

# 5. The event stream opens and says so (the 25-second heartbeat is covered by the unit tests; this proves the proxy does not buffer it).
if ($admin) {
  $request = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::Get), ($BaseUrl + "/api/v1/notifications/stream")
  $request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + $admin) | Out-Null
  $streamOk = $false
  $note = ""
  try {
    $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $type = [string]$response.Content.Headers.ContentType
    if ($response.StatusCode -eq 200 -and $type -like "text/event-stream*") {
      $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      $buffer = New-Object byte[] 256
      $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
      if ($read.Wait(5000)) { $streamOk = ([System.Text.Encoding]::UTF8.GetString($buffer, 0, $read.Result) -match "connected") } else { $note = "nothing within 5 s" }
      $response.Dispose()
    } else { $note = "status " + [int]$response.StatusCode }
  } catch { $note = "no connection" }
  Report "the notification stream opens and sends its first line" $streamOk $note
} else { Skip "notification stream" "no staff token" }

# 6. Bad logins are slowed down (last, because it blocks login from this address for a while).
$tripped = $false
for ($i = 0; $i -lt 15; $i++) {
  $r = Send "POST" "/api/v1/auth/login" "" '{"email":"nobody@example.test","password":"wrong-password-example"}'
  if ($r.Status -eq 429) { $tripped = $true; break }
}
Report "repeated bad logins end in 429" $tripped

$client.Dispose()
if ($script:failed -gt 0) { Write-Host ("" + $script:failed + " check(s) failed"); exit 1 }
Write-Host "all checks passed"
exit 0
