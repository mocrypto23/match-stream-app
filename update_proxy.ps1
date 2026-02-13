$path = "app/api/embed-proxy/route.ts"
$content = Get-Content $path -Raw

# 1. Update rewriteAttributeUrls (VAST/VMAP blocking)
# We look for the distinct block:
#       if (isBlockedAbsoluteUrl(absolute)) {
#         return attr === "href"
#           ? `${prefix}javascript:void(0)${suffix}`
#           : `${prefix}about:blank${suffix}`;
#       }
# And append our new logic.

# Regex to find the block (handling whitespace generically)
$blockRegex = 'if \(isBlockedAbsoluteUrl\(absolute\)\) \{\s*return attr === "href"\s*\? `\$\{prefix\}javascript:void\(0\)\$\{suffix\}`\s*: `\$\{prefix\}about:blank\$\{suffix\}`; \s*\}'

$newBlock = 'if (isBlockedAbsoluteUrl(absolute)) {
        return attr === "href"
          ? `${prefix}javascript:void(0)${suffix}`
          : `${prefix}about:blank${suffix}`;
      }

      // VAST/VMAP blocking
      if (
        absolute.includes("vast.xml") || 
        absolute.includes("vmap.xml") || 
        absolute.includes("ad_tag") ||
        absolute.includes("ima3.js")
      ) {
         return `${prefix}about:blank${suffix}`;
      }'

if ($content -match $blockRegex) {
    $content = $content -replace $blockRegex, $newBlock
    Write-Host "Updated rewriteAttributeUrls"
} else {
    Write-Host "Could not find rewriteAttributeUrls block"
}

# 2. Update rewriteM3u8Manifest
# We replace the entire function.

$manifestFuncRegex = '(?s)function rewriteM3u8Manifest\(.+?\.join\("\\n"\);\s*\}'

$newManifestFunc = 'function rewriteM3u8Manifest(
  manifest: string,
  baseUrl: string,
  depth: number,
  referrerForChildren?: string | null
) {
  const nextDepth = Math.min(MAX_PROXY_DEPTH, depth + 1);
  const childReferrer = referrerForChildren || baseUrl;

  const toProxyUri = (raw: string) => {
    const absolute = toAbsoluteUrl(raw, baseUrl);
    if (!absolute) return raw;
    if (isBlockedAbsoluteUrl(absolute)) return raw;
    return buildProxyUrl(absolute, nextDepth, childReferrer);
  };

  const lines = String(manifest || "").split(/\r?\n/);
  const outLines: string[] = [];
  let isInsideAdBlock = false;

  const AD_SEGMENT_PATTERNS = [
    /ad_/i,
    /_ad\./i,
    /google_/i,
    /doubleclick/i,
    /segment_ad/i,
    /advert/i,
    /sponsored/i,
    /promo_/i,
    /stitched/i,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      // SCTE-35 or custom ad markers
      if (
        line.startsWith("#EXT-X-CUE-OUT") ||
        line.startsWith("#EXT-X-SCTE35") ||
        line.startsWith("#EXT-X-DATERANGE:ID=\"ad")
      ) {
        isInsideAdBlock = true;
        continue;
      }
      if (line.startsWith("#EXT-X-CUE-IN")) {
        isInsideAdBlock = false;
        continue;
      }

      // Handle tags like: #EXT-X-KEY:METHOD=AES-128,URI="key.key"
      if (line.includes("URI=")) {
        outLines.push(
          line.replace(/URI=(["'\''])([^"'\''"]+)\1/gi, (_full, quote, rawUri) => {
            const rewritten = toProxyUri(rawUri);
            return `URI=${quote}${rewritten}${quote}`;
          })
        );
      } else {
        outLines.push(line);
      }
      continue;
    }

    // It is a segment URI
    if (isInsideAdBlock || AD_SEGMENT_PATTERNS.some((p) => p.test(line))) {
      // Skip this segment
      if (outLines.length > 0 && outLines[outLines.length - 1].startsWith("#EXTINF")) {
        outLines.pop();
      }
      continue;
    }

    outLines.push(toProxyUri(line));
  }

  return outLines.join("\n");
}'

if ($content -match $manifestFuncRegex) {
    $content = $content -replace $manifestFuncRegex, $newManifestFunc
    Write-Host "Updated rewriteM3u8Manifest"
} else {
    Write-Host "Could not find rewriteM3u8Manifest block"
}

Set-Content $path $content -Encoding UTF8
Write-Host "Done"
