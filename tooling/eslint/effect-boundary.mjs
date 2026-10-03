import path from "node:path";

/** Prevent privileged effects entering app and test/tooling imports entering production. */
/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    schema: [],

    messages: {
      forbidden: "Import crosses an effect ownership boundary."
    }
  },

  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const file = context.filename.replaceAll("\\", "/");

    /** @param {import('estree').Node & {value?:unknown}} node */
    function check(node) {
      if (typeof node.value !== "string")
        return;

      const spec = node.value.replaceAll("\\", "/");
      const target = spec.startsWith("@/") ? `/src/${spec.slice(2)}` : spec.startsWith(".") ? path.posix.normalize(`${path.posix.dirname(file)}/${spec}`) : spec;
      const production = /\/(src|scripts)\//.test(file);

      const client = /\/src\/(app|components)\//.test(file) || context.sourceCode.ast.body.some(
        n => n.type === "ExpressionStatement" &&
          n.expression.type === "Literal" &&
          n.expression.value === "use client"
      );

      if ((production &&
        /(^|\/)(tests|tooling)(\/|$)/.test(target)) ||
        (client &&
          (/\/src\/server\//.test(target) ||
            /^(pg(?:\/|$)|pg-|(?:node:)?(?:fs|child_process)(?:\/|$))/.test(target)))) context.report({
              node,
              messageId: "forbidden"
            });
    }

    return {
      ImportDeclaration(n) {
        check(n.source);
      },

      ExportNamedDeclaration(n) {
        if (n.source)
          check(n.source);
      },

      ExportAllDeclaration(n) {
        check(n.source);
      },

      ImportExpression(n) {
        check(n.source);
      },

      /** @param {import('estree').Node & {source: import('estree').Node}} n */
      TSImportType(n) {
        check(n.source);
      },

      CallExpression(n) {
        if (n.callee.type === "Identifier" && n.callee.name === "require" && n.arguments[0])
          check(n.arguments[0]);
      }
    };
  }
};

export default rule;
