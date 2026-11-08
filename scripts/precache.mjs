import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";

const files = (await readdir(".next/static", { recursive: true, withFileTypes: true }))
  .filter((file) => file.isFile() && !file.name.endsWith(".map"))
  .map((file) => "/" + (file.parentPath + "/" + file.name).replace(/^\.next\//, "_next/"))
  .sort();
const sw = await readFile("public/sw.js");
const version = createHash("sha256").update(sw).update(await readFile(".next/BUILD_ID")).update(files.join("\n")).digest("hex").slice(0, 16);
await Promise.all([
  writeFile("public/precache.generated.js", `self.PHARMACY_ASSETS = ${JSON.stringify({ version, files })};\n`),
  ...[192, 512].map((size) => sharp("public/brand.svg").resize(size).png().toFile(`public/icon-${size}.png`)),
]);
