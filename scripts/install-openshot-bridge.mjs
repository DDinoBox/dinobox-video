import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const openshotDir = process.env.OPENSHOT_DIR || path.join(root, "tools", "openshot");
const appPath = path.join(openshotDir, "classes", "app.py");
const importerDir = path.join(openshotDir, "classes", "importers");
const importerPath = path.join(importerDir, "dinobox.py");
const importerSource = path.join(root, "integrations", "openshot", "dinobox.py");

const marker = "if args[1].endswith(\".dinobox.json\")";
const anchor = `        # Start a new project and auto import any media files\n`;
const bridge = [
  `        # DinoBox edit manifests build a native OpenShot project and timeline.`,
  `        if args[1].endswith(".dinobox.json"):`,
  `            self.project.load("")`,
  `            from classes.importers.dinobox import import_manifest`,
  `            import_manifest(args[1])`,
  `            return True`,
  ``,
].join("\n");

let appSource = await readFile(appPath, "utf8");
if (!appSource.includes(marker)) {
  if (!appSource.includes(anchor)) {
    throw new Error(`OpenShot app.py anchor not found: ${appPath}`);
  }
  appSource = appSource.replace(anchor, `${bridge}${anchor}`);
  await writeFile(appPath, appSource, "utf8");
}

await copyFile(importerSource, importerPath);
console.log(`OpenShot bridge ready: ${openshotDir}`);
