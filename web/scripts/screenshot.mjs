// Open the viewer on a file, wait for tiles, print HUD and console errors, save a screenshot.
// Usage: node scripts/screenshot.mjs <src-url> <out.png> [zoom]
import { chromium } from "playwright";

const [src, out, zoom = "1"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://localhost:5173/?src=${encodeURIComponent(src)}`);
await page.waitForFunction(() => /decoded: [1-9]/.test(document.querySelector("#hud")?.textContent ?? ""), null, { timeout: 30000 });
if (zoom !== "1") {
  await page.waitForTimeout(1500);
  await page.mouse.move(640, 430);
  for (let i = 0; i < Number(zoom); i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(300);
  }
}
await page.waitForTimeout(3000);
console.log(await page.locator("#hud").textContent());
await page.screenshot({ path: out });
await browser.close();
