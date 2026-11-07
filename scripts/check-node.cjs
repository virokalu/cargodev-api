// Fails early and clearly on a Node that is too old. Plain CommonJS and old syntax on purpose: it must run (and explain itself) even
// on a Node that cannot parse the rest of this project. The supported version is the major in .nvmrc, which is also the Dockerfile's
// and CI's major (docs/deployment.md).
"use strict";

var fs = require("fs");
var path = require("path");

function requiredMajor() {
  var text = fs.readFileSync(path.join(__dirname, "..", ".nvmrc"), "utf8");
  return parseInt(text.trim().replace(/^v/, ""), 10);
}

/** null when the version is fine, otherwise a message that says what to do. */
function problemWith(version, required) {
  var major = parseInt(String(version).replace(/^v/, "").split(".")[0], 10);
  if (isNaN(major) || major < required) {
    return (
      "CargoDev API needs Node " + required + " or newer; this shell has Node " + String(version).replace(/^v/, "") + ".\n" +
      "Switch with `nvm use` (the .nvmrc says " + required + ") or install it from nodejs.org, open a new terminal, and run this again."
    );
  }
  return null;
}

module.exports = { problemWith: problemWith, requiredMajor: requiredMajor };

if (require.main === module) {
  var problem = problemWith(process.versions.node, requiredMajor());
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
