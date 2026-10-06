/** Generate the Host boundary schema from the frozen SDK types. No network access. */
import ts from "typescript";
import { fileURLToPath } from "node:url";
const base = fileURLToPath(new URL("../", import.meta.url));
const file = `${base}src/v1/developer-workflow.ts`;
const program = ts.createProgram([file], {
  strictNullChecks: true,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(file)!;
function schema(type: ts.Type, field = "", response = false): unknown {
  if (
    response &&
    ["status", "reviewStatus", "billingStatus", "fundingType"].includes(field)
  )
    return { type: "string" };
  if (type.isUnion())
    return { anyOf: type.types.map((t) => schema(t, field, response)) };
  if (type.flags & ts.TypeFlags.StringLiteral)
    return { const: (type as ts.StringLiteralType).value };
  if (type.flags & ts.TypeFlags.NumberLiteral)
    return { const: (type as ts.NumberLiteralType).value };
  if (type.flags & ts.TypeFlags.BooleanLiteral)
    return { const: checker.typeToString(type) === "true" };
  if (type.flags & ts.TypeFlags.String) return { type: "string" };
  if (type.flags & ts.TypeFlags.Number) return { type: "number" };
  if (type.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
  if (type.flags & ts.TypeFlags.Null) return { type: "null" };
  if (type.flags & ts.TypeFlags.Undefined) return { type: "undefined" };
  if (checker.isArrayType(type))
    return {
      type: "array",
      items: schema(
        checker.getTypeArguments(type as ts.TypeReference)[0]!,
        "",
        response,
      ),
    };
  if (type.flags & ts.TypeFlags.Object || type.isIntersection()) {
    return {
      type: "object",
      fields: Object.fromEntries(
        checker.getPropertiesOfType(type).map((p) => [
          p.name,
          {
            optional: !!(p.flags & ts.SymbolFlags.Optional),
            schema: schema(
              checker.getTypeOfSymbolAtLocation(
                p,
                p.valueDeclaration ?? source,
              ),
              p.name,
              response,
            ),
          },
        ]),
      ),
    };
  }
  throw new Error(`Unsupported type ${checker.typeToString(type)}`);
}
const output: Record<string, unknown> = {};
for (const statement of source.statements) {
  if (
    !ts.isInterfaceDeclaration(statement) ||
    !["DeveloperWorkflowRequests", "DeveloperWorkflowResults"].includes(
      statement.name.text,
    )
  )
    continue;
  const response = statement.name.text === "DeveloperWorkflowResults";
  const type = checker.getTypeAtLocation(statement);
  output[response ? "responses" : "requests"] = Object.fromEntries(
    checker
      .getPropertiesOfType(type)
      .map((p) => [
        p.name,
        schema(
          checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? source),
          "",
          response,
        ),
      ]),
  );
}
await Bun.write(
  `${base}src/v1/developer-platform-contract/workflow-schema.json`,
  JSON.stringify(output, null, 2) + "\n",
);
