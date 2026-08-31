$k = "sk-sp-H.DLHDEL.Xl9B.MEQCIHbi4N7f90I6QKnGHZbSz09qEURuTSntsIbWBZTlKRDFAiA2M12II_hcc7aO6YY72AbsZVw6f_dR_L8a_lObLzph5w"
$bases = @(
  "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1"
)
$paths = @(
  "/services/aigc/text2image/image-synthesis",
  "/services/aigc/image2image/image-synthesis"
)

foreach ($b in $bases) {
  foreach ($p in $paths) {
    $u = $b + $p
    $body = '{"model":"wan2.7-image","input":{"prompt":"zhuxing poster, star, blue space"},"parameters":{"n":1,"size":"1024*1536","watermark":false}}'
    try {
      $r = Invoke-WebRequest -Uri $u -Method Post -Headers @{Authorization="Bearer $k";"Content-Type"="application/json"} -Body $body -TimeoutSec 120
      Write-Output ("=== OK " + $u + " (" + $r.StatusCode + ") ===")
      Write-Output $r.Content
    } catch {
      $resp = $_.Exception.Response
      $code = if($resp){$resp.StatusCode.value__}else{"?"}
      $ct = ""
      if ($resp) { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $ct = $sr.ReadToEnd() } catch {} }
      Write-Output ("=== FAIL " + $u + " => " + $code + " ===")
      Write-Output $ct
    }
  }
}
