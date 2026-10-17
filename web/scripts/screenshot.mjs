// Open the viewer on a file, optionally zoom to a point, print the HUD and save a screenshot.
// Usage: node scripts/screenshot.mjs <src-url> <out.png> [zoom cx cy]
//   zoom: image pixels per screen pixel = 1/zoom-ish (OSD viewport zoom; 1 = fit width)
//   cx, cy: point to centre on, as fractions of image width/height
import { chromium } from "playwright";

const [src, out, zoom, cx = "0.5", cy = "0.5"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://localhost:5173/?src=${encodeURIComponent(src)}`);
await page.waitForFunction(() => /decoded: [1-9]/.test(document.querySelector("#hud")?.textContent ?? ""), null, { timeout: 60000 });
if (zoom) {
  await page.evaluate(
    ([z, x, y]) => {
      const v = window.viewer;
      const size = v.world.getItemAt(0).getContentSize();
      const pt = v.viewport.imageToViewportCoordinates(size.x * x, size.y * y);
      v.viewport.zoomTo(z, pt, true);
      v.viewport.panTo(pt, true);
    },
    [Number(zoom), Number(cx), Number(cy)],
  );
  await page.waitForFunction(() => window.viewer.world.getItemAt(0).getFullyLoaded(), null, { timeout: 120000 }).catch(() => console.log("(timed out waiting for full load)"));
}
await page.waitForTimeout(1000);
console.log(await page.locator("#hud").textContent());
await page.screenshot({ path: out });
await browser.close();
