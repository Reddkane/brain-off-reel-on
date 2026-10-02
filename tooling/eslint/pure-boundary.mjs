import path from "node:path";
import { fileURLToPath } from "node:url";

// Both the rule and production config derive their root from this repository.
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** @param {string} value */
function posixFilename(value) {
  return value.replaceAll("\\", "/").replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
}

/** @param {string[]} segments @param {string[]} root */
function inside(segments, root) {
  return root.every((segment, index) => segments[index] === segment);
}

/** @type {import("eslint").Rule.RuleModule} */
const pureBoundary = {
  meta: {
    type: "problem",
    schema: [],
    messages: { forbidden: "Pure source cannot import or re-export outside its permitted areas: {{source}}." },
  },
  create(context) {
    const filename = path.posix.relative(
      posixFilename(repositoryRoot),
      posixFilename(context.filename),
    );
    const owner = filename.split("/")[1];
    const permitted = owner === "domain"
      ? [["src", "domain"]]
      : [["src", "domain"], ["src", "recommendation"]];

    /** @param {import("estree").ImportDeclaration | import("estree").ExportNamedDeclaration | import("estree").ExportAllDeclaration} node */
    function check(node) {
      const source = node.source?.value;
      if (typeof source !== "string" || !/^\.\.?\//.test(source)) return;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), source));
      if (!permitted.some((root) => inside(target.split("/"), root))) {
        context.report({ node, messageId: "forbidden", data: { source } });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

export default pureBoundary;
