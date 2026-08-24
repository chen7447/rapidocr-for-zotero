param(
  [ValidateSet('success', 'failure', 'cancel', 'crash')]
  [string]$Scenario = 'success'
)

$ErrorActionPreference = 'Stop'
$inputLine = [Console]::In.ReadLine()
if (-not $inputLine) {
  [Console]::Error.WriteLine('Mock Worker did not receive a request.')
  exit 2
}
$request = $inputLine | ConvertFrom-Json
$requestId = [string]$request.requestId
$jobId = '00000000-0000-4000-8000-000000000010'

function Send-Event([hashtable]$Event) {
  [Console]::Out.WriteLine(($Event | ConvertTo-Json -Compress -Depth 8))
}

if ($Scenario -eq 'crash') {
  [Console]::Error.WriteLine('Simulated Worker crash before protocol completion.')
  exit 23
}

Send-Event @{
  type = 'helloResult'
  requestId = $requestId
  protocol = @{ major = 1; minor = 0 }
  worker = @{ version = '0.1.0'; build = 'mock' }
  engines = @{ ocrmypdf = 'mock'; tesseract = 'mock' }
  providers = @('tesseract')
  languages = @('eng', 'chi_sim', 'osd')
  capabilities = @('ocr', 'cancel', 'selfCheck', 'sidecar')
}

if ($Scenario -eq 'failure') {
  Send-Event @{
    type = 'jobFailed'
    jobId = $jobId
    code = 'OCR_ENGINE_FAILED'
    message = 'Simulated OCR engine failure.'
    retryable = $true
  }
  [Console]::Error.WriteLine('Simulated OCR engine stderr.')
  exit 7
}

if ($Scenario -eq 'cancel') {
  Send-Event @{
    type = 'cancelAccepted'
    requestId = $requestId
    jobId = $jobId
  }
  Send-Event @{
    type = 'jobFailed'
    jobId = $jobId
    code = 'CANCELLED'
    message = 'Simulated user cancellation.'
    retryable = $false
  }
  exit 0
}

Send-Event @{ type = 'jobAccepted'; requestId = $requestId; jobId = $jobId }
Send-Event @{ type = 'progress'; jobId = $jobId; stage = 'preflight'; percent = 0 }
[Console]::Out.WriteLine('this is intentionally malformed JSON')
Send-Event @{ type = 'progress'; jobId = $jobId; stage = 'finalize'; percent = 100 }
Send-Event @{
  type = 'jobCompleted'
  jobId = $jobId
  outputPath = 'C:\mock-job\output.partial.pdf'
  sidecarPath = 'C:\mock-job\recognized.txt'
  reportPath = 'C:\mock-job\report.json'
}
exit 0
