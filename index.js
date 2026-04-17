import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const url = process.argv[2];

if (!url) {
  console.error("Usage: node index.js <url>");
  process.exit(1);
}

async function crawl(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const results = [];

  // Intercept all script responses to capture external script contents
  const externalScripts = new Map();
  page.on("response", async (response) => {
    const reqUrl = response.url();
    const contentType = response.headers()["content-type"] || "";
    if (
      contentType.includes("javascript") ||
      reqUrl.endsWith(".js") ||
      contentType.includes("ecmascript")
    ) {
      try {
        const body = await response.text();
        if (body.includes("dataLayer.push")) {
          externalScripts.set(reqUrl, body);
        }
      } catch {}
    }
  });

  console.log(`Navigating to ${url} ...`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Give extra time for late-firing scripts / GTM to load
  await page.waitForTimeout(5000);

  // 1. Inline <script> tags containing dataLayer.push
  const inlineScripts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("script:not([src])"))
      .map((s) => s.textContent)
      .filter((text) => text.includes("dataLayer.push"));
  });

  for (const script of inlineScripts) {
    results.push({ type: "inline", source: "inline", script });
  }

  // 2. External scripts that contained dataLayer.push (captured via response interception)
  for (const [srcUrl, body] of externalScripts) {
    results.push({ type: "external", source: srcUrl, script: body });
  }

  await browser.close();

  // Extract dataLayer.push(...) arguments from all scripts
  const pushObjects = [];
  const pushPattern = /dataLayer\.push\s*\(/g;
  for (const r of results) {
    let match;
    while ((match = pushPattern.exec(r.script)) !== null) {
      const start = match.index + match[0].length;
      // Walk forward to extract the balanced argument
      let depth = 1;
      let i = start;
      while (i < r.script.length && depth > 0) {
        const ch = r.script[i];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") depth--;
        i++;
      }
      const raw = r.script.slice(start, i - 1).trim();
      // Try to parse as JSON (won't work for dynamic expressions, but catches object literals)
      let parsed = null;
      try {
        // Convert JS object literal to JSON-ish: wrap unquoted keys
        const jsonish = raw
          .replace(/'/g, '"')
          .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
          .replace(/,\s*([}\]])/g, "$1"); // trailing commas
        parsed = JSON.parse(jsonish);
      } catch {
        // Keep raw string if it can't be parsed
        parsed = raw;
      }
      pushObjects.push({ source: r.source, type: r.type, argument: parsed });
    }
  }

  // Filter to only pushes whose raw argument contains "event"
  // Then attempt to format string arguments into objects
  const eventPushes = pushObjects
    .filter((p) => {
      const str = typeof p.argument === "string" ? p.argument : JSON.stringify(p.argument);
      return str.includes("event");
    })
    .map((p) => {
      if (typeof p.argument !== "string") return p;
      // Unescape all JS escape sequences in one pass
      const escapeMap = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "'": "'", '"': '"', "\\": "\\" };
      let cleaned = p.argument
        .replace(/\\(x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]+)\}|([nrtbf'"\\]))/g,
          (_, full, hex2, hex4, hexN, ch) => {
            if (hex2) return String.fromCharCode(parseInt(hex2, 16));
            if (hex4) return String.fromCharCode(parseInt(hex4, 16));
            if (hexN) return String.fromCodePoint(parseInt(hexN, 16));
            if (ch) return escapeMap[ch];
            return full;
          });

      // First try a straight JSON parse after basic transforms
      try {
        const jsonish = cleaned
          .replace(/'/g, '"')
          .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
          .replace(/,\s*([}\]])/g, "$1");
        return { ...p, argument: JSON.parse(jsonish) };
      } catch {}

      // If that fails, replace dynamic (non-string) values with "<dynamic>"
      // so we can still capture the keys and any string-literal values
      try {
        const safed = cleaned
          .replace(/'/g, '"')
          .replace(/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":')
          // Replace values that aren't strings/numbers/booleans/null with "<dynamic>"
          .replace(/:\s*(?!"|-?\d|true|false|null|{|\[)([^,}]+)/g, ':"<dynamic>"')
          .replace(/,\s*([}\]])/g, "$1");
        return { ...p, argument: JSON.parse(safed) };
      } catch {
        return p;
      }
    });

  // Output
  const timestamp = Date.now();
  fs.mkdirSync(path.join(process.cwd(), `./output/${timestamp}`), { recursive: true });
  const outFile = path.join(process.cwd(), `./output/${timestamp}/datalayer-results.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

  // Combined JS file
  const jsFile = path.join(process.cwd(), `./output/${timestamp}/datalayer-scripts.js`);
  const combined = results
    .map((r) => `// === [${r.type}] ${r.source} ===\n${r.script}`)
    .join("\n\n");
  fs.writeFileSync(jsFile, combined);

  // dataLayer.push arguments (only those with an "event" key)
  const pushFile = path.join(process.cwd(), `./output/${timestamp}/datalayer-pushes.json`);
  fs.writeFileSync(pushFile, JSON.stringify(eventPushes, null, 2));

  // CSV export of pushes
  const csvFile = path.join(process.cwd(), `./output/${timestamp}/datalayer-pushes.csv`);
  // Collect all unique keys from arguments
  const allKeys = [...new Set(eventPushes.flatMap((p) =>
    typeof p.argument === "object" && p.argument !== null ? Object.keys(p.argument) : []
  ))];
  const csvHeaders = ["source", "type", ...allKeys];
  const escapeCsv = (val) => {
    const str = val == null ? "" : String(val);
    return str.includes(",") || str.includes('"') || str.includes("\n")
      ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const csvRows = eventPushes.map((p) => {
    const arg = typeof p.argument === "object" && p.argument !== null ? p.argument : {};
    return [p.source, p.type, ...allKeys.map((k) => escapeCsv(arg[k] ?? ""))].join(",");
  });
  fs.writeFileSync(csvFile, [csvHeaders.join(","), ...csvRows].join("\n"));

  console.log(`\nFound ${results.length} script(s) containing dataLayer.push`);
  console.log(`Found ${pushObjects.length} dataLayer.push() call(s), ${eventPushes.length} with an "event" property`);
  console.log(`Results saved to:\n  ${outFile}\n  ${jsFile}\n  ${pushFile}\n  ${csvFile}\n`);

  for (const r of results) {
    console.log(`--- [${r.type}] ${r.source} ---`);
    console.log(r.script.slice(0, 300) + (r.script.length > 300 ? "\n..." : ""));
    console.log();
  }
}

crawl(url).catch((err) => {
  console.error(err);
  process.exit(1);
});
