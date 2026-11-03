// Verifies that the generated Prisma client was generated from THIS repo's prisma/schema.prisma. `prisma generate` writes into
// node_modules, so running it anywhere that shares node_modules with the repo (a mutation mirror, another checkout) silently
// replaces the client. This compares the schema copy inside the generated client with the real one. No database, no network.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalise = (text) => text.replace(/\r\n/g, "\n").trimEnd();
const real = path.join(root, "prisma", "schema.prisma");
const generated = path.join(root, "node_modules", ".prisma", "client", "schema.prisma");

if (!existsSync(generated)) {
  console.error("The Prisma client has not been generated here. Run: npx prisma generate");
  process.exit(1);
}
if (normalise(readFileSync(real, "utf8")) !== normalise(readFileSync(generated, "utf8"))) {
  console.error("The generated Prisma client does not match prisma/schema.prisma (it was generated from a different schema).");
  console.error("Run: npx prisma generate   (in this folder, never in a mirror that shares node_modules)");
  process.exit(1);
}
console.log("The generated Prisma client matches prisma/schema.prisma.");
