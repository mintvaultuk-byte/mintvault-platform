#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_PARTS = new Set(["node_modules", "dist", "coverage", ".git", ".graphify", "generated", "test", "tests"]);
const PROVIDER_MODULES = new Set([
  "stripe",
  "openai",
  "resend",
  "@anthropic-ai/sdk",
  "@aws-sdk/client-s3",
  "@google/generative-ai",
]);
const OBJECT_CALLS = new Map([
  ["uploadToR2", "direct-put-r2"],
  ["deleteFromR2", "direct-delete-r2"],
  ["uploadToB2", "direct-put-b2"],
  ["deleteFromB2", "direct-delete-b2"],
  ["registerObjectWriteFinalizer", "lifecycle-finalizer"],
]);
const OBJECT_COMMANDS = new Map([
  ["PutObjectCommand", "direct-put-s3"],
  ["DeleteObjectCommand", "direct-delete-s3"],
  ["CopyObjectCommand", "direct-copy-s3"],
  ["DeleteObjectsCommand", "bulk-delete-s3"],
  ["PutObjectRetentionCommand", "retention-put-s3"],
  ["ObjectWriteCoordinator", "coordinated-write"],
]);
const STRICT_COMPONENT_KEYS = [
  "id",
  "owner",
  "releaseMode",
  "requirements",
  "runtimeState",
  "schemaVersion",
  "sourceRoots",
];
const REQUIREMENT_KEYS = ["environment", "migrations", "relations", "runtimeSignals", "triggers"];
const MIGRATION_FILE_RE = /^(\d{4,})_.+\.sql$/;

function portable(path) {
  return path.split(sep).join("/");
}

function walk(root, relativeRoot) {
  const absolute = join(root, relativeRoot);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [portable(relativeRoot)];
  const files = [];
  for (const name of readdirSync(absolute).sort()) {
    if (IGNORED_PARTS.has(name)) continue;
    const child = join(relativeRoot, name);
    if (statSync(join(root, child)).isDirectory()) files.push(...walk(root, child));
    else files.push(portable(child));
  }
  return files;
}

function architectureFiles(root, scanRoots) {
  // Synthetic fixtures/source archives have no Git metadata. Enrolled checkouts
  // must use the same source boundary locally and in CI, including new WIP files
  // but never ignored workstation scripts. Tracked ignored files still count.
  if (!existsSync(join(root, ".git"))) return [...new Set(scanRoots.flatMap((part) => walk(root, part)))].sort();
  const result = spawnSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...scanRoots],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  if (result.status !== 0)
    throw new Error(`architecture Git inventory failed: ${result.error?.message || result.stderr || result.status}`);
  return [...new Set(result.stdout.split("\0").filter(Boolean))]
    .filter((file) => !file.split("/").some((part) => IGNORED_PARTS.has(part)) && existsSync(join(root, file)))
    .sort();
}

function sourceKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function memberOwner(node) {
  const container = node.parent;
  if (ts.isObjectLiteralExpression(container) && ts.isVariableDeclaration(container.parent)) {
    return ts.isIdentifier(container.parent.name) ? container.parent.name.text : null;
  }
  if (ts.isClassDeclaration(container) || ts.isClassExpression(container)) return container.name?.text ?? null;
  return null;
}

function functionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
    if (ts.isPropertyAssignment(node.parent)) {
      const owner = memberOwner(node.parent);
      if (owner) return `${owner}.${node.parent.name.getText()}`;
    }
  }
  if (ts.isMethodDeclaration(node) && node.name) {
    const owner = memberOwner(node);
    if (owner) return `${owner}.${node.name.getText()}`;
  }
  if (ts.isMethodSignature(node) && node.name) return node.name.getText();
  return null;
}

function runtimeImport(declaration) {
  if (!declaration.importClause) return true;
  if (declaration.importClause.isTypeOnly) return false;
  if (declaration.importClause.name) return true;
  const bindings = declaration.importClause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) return bindings.elements.some((element) => !element.isTypeOnly);
  return true;
}

function runtimeExport(declaration) {
  if (declaration.isTypeOnly) return false;
  return (
    !declaration.exportClause ||
    !ts.isNamedExports(declaration.exportClause) ||
    declaration.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

function dynamicImportSpecifier(node) {
  while (
    node &&
    (ts.isAwaitExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node))
  ) {
    node = node.expression;
  }
  return node &&
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    ts.isStringLiteralLike(node.arguments[0])
    ? node.arguments[0].text
    : null;
}

function importTarget(root, files, file, specifier) {
  if (specifier.startsWith("@shared/")) specifier = `shared/${specifier.slice(8)}`;
  else if (specifier.startsWith("@/")) specifier = `client/src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) {
    const absolute = portable(resolve(root, dirname(file), specifier));
    const prefix = `${portable(resolve(root))}/`;
    if (!absolute.startsWith(prefix)) return null;
    specifier = absolute.slice(prefix.length);
  } else return null;
  for (const candidate of [
    specifier,
    ...[...SOURCE_EXTENSIONS].map((extension) => `${specifier}${extension}`),
    ...[...SOURCE_EXTENSIONS].map((extension) => `${specifier}/index${extension}`),
  ]) {
    if (files.has(candidate)) return candidate;
  }
  return specifier;
}

function lexicalScope(node) {
  let current = node.parent;
  while (current && !ts.isBlock(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function lexicalEntry(model, entries, name, useNode) {
  const position = useNode?.getStart(model.source) ?? Number.MAX_SAFE_INTEGER;
  return entries
    .filter(
      (entry) =>
        entry.name === name &&
        entry.position <= position &&
        entry.scope &&
        entry.scope.getStart(model.source) <= position &&
        position <= entry.scope.getEnd()
    )
    .sort((left, right) => right.position - left.position)[0];
}

function lexicalInitializer(model, name, useNode) {
  return lexicalEntry(model, model.lexicalConstants, name, useNode)?.initializer ?? null;
}

function importBindingFor(model, name, useNode) {
  return lexicalEntry(model, model.dynamicImports, name, useNode) ?? model.imports.get(name);
}

function makeModels(root, files, policy) {
  const approvedApplicationRoots = new Set(
    (policy.applicationRoots ?? []).map((item) => `${item.file}#${item.context}:${item.receiver}`)
  );
  const models = new Map();
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(extname(file)) || file.endsWith(".min.js")) continue;
    const text = readFileSync(join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, sourceKind(file));
    const model = {
      file,
      text,
      source,
      imports: new Map(),
      dynamicImports: [],
      constants: new Map(),
      lexicalConstants: [],
      functions: new Map(),
      functionContexts: new Map(),
      contextParents: new Map(),
      routerVariables: new Map(),
      expressReceivers: new Map(),
      expressParameterIndexes: new Map(),
      databaseHelperSqlParameterIndexes: new Map(),
      rootReceivers: new Map(),
      unapprovedRootReceivers: new Map(),
      exportedRegistrars: new Map(),
      defaultExportIdentifier: null,
      functionReturnReceivers: new Map(),
      classInstances: new Map(),
      lazyImports: new Map(),
    };
    function visit(node, context = "<module>") {
      const named = functionName(node);
      const nextContext = named ?? context;
      if (named && named !== context && !model.contextParents.has(named)) model.contextParents.set(named, context);
      if (ts.isFunctionDeclaration(node) && node.name) {
        model.functions.set(node.name.text, node);
        model.functionContexts.set(node.name.text, node.name.text);
        if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
          model.functions.set("default", node);
          model.functionContexts.set("default", node.name.text);
        }
      }
      if (
        named &&
        (ts.isMethodDeclaration(node) ||
          ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isPropertyAssignment(node.parent)))
      ) {
        model.functions.set(named, node);
        model.functionContexts.set(named, named);
      }
      if (named && "parameters" in node) {
        for (const [index, parameter] of [...(node.parameters ?? [])].entries()) {
          if (!ts.isIdentifier(parameter.name)) continue;
          const type = parameter.type?.getText(source) ?? "";
          if (
            /\b(?:Express|Application|Router)\b/.test(type) ||
            (/^(?:app|router|r)$/.test(parameter.name.text) &&
              /^(?:register|mount|create|build|partner).*(?:Routes|Router)?$/i.test(named))
          ) {
            if (!model.expressReceivers.has(nextContext)) model.expressReceivers.set(nextContext, new Set());
            model.expressReceivers.get(nextContext).add(parameter.name.text);
            if (!model.expressParameterIndexes.has(nextContext)) {
              model.expressParameterIndexes.set(nextContext, new Map());
            }
            model.expressParameterIndexes.get(nextContext).set(parameter.name.text, index);
          }
        }
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = importTarget(root, files, file, node.moduleSpecifier.text);
        const clause = node.importClause;
        if (clause?.name)
          model.imports.set(clause.name.text, { target, imported: "default", runtime: !clause.isTypeOnly });
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            model.imports.set(element.name.text, {
              target,
              imported: element.propertyName?.text ?? element.name.text,
              runtime: !clause.isTypeOnly && !element.isTypeOnly,
            });
          }
        } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          model.imports.set(clause.namedBindings.name.text, {
            target,
            imported: "*",
            runtime: !clause.isTypeOnly,
          });
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        model.constants.set(`${nextContext}:${node.name.text}`, node.initializer);
        if (nextContext === "<module>") model.constants.set(node.name.text, node.initializer);
        model.lexicalConstants.push({
          name: node.name.text,
          initializer: node.initializer,
          position: node.getStart(source),
          scope: lexicalScope(node),
        });
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          model.functions.set(node.name.text, node.initializer);
          model.functionContexts.set(node.name.text, node.name.text);
        }
        if (ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "Router") {
          if (!model.routerVariables.has(nextContext)) model.routerVariables.set(nextContext, new Set());
          model.routerVariables.get(nextContext).add(node.name.text);
          const statement = node.parent?.parent;
          if (
            ts.isVariableStatement(statement) &&
            statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
          ) {
            model.exportedRegistrars.set(node.name.text, node.name.text);
          }
        }
        if (ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "express") {
          const rootId = `${file}#${nextContext}:${node.name.text}`;
          const receiverMap = approvedApplicationRoots.has(rootId)
            ? model.rootReceivers
            : model.unapprovedRootReceivers;
          if (!receiverMap.has(nextContext)) receiverMap.set(nextContext, new Set());
          receiverMap.get(nextContext).add(node.name.text);
        }
        if (ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "lazy") {
          const match = node.initializer.getText(source).match(/import\(["']([^"']+)["']\)/);
          if (match) model.lazyImports.set(node.name.text, match[1]);
        }
        if (ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
          model.classInstances.set(node.name.text, node.initializer.expression.text);
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const specifier = dynamicImportSpecifier(node.initializer);
        const target = specifier ? importTarget(root, files, file, specifier) : null;
        if (target && ts.isIdentifier(node.name)) {
          model.dynamicImports.push({
            name: node.name.text,
            target,
            imported: "*",
            runtime: true,
            dynamic: true,
            position: node.getStart(source),
            scope: lexicalScope(node),
          });
        } else if (target && ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported =
              element.propertyName &&
              (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))
                ? element.propertyName.text
                : element.name.text;
            model.dynamicImports.push({
              name: element.name.text,
              target,
              imported,
              runtime: true,
              dynamic: true,
              position: node.getStart(source),
              scope: lexicalScope(node),
            });
          }
        }
      }
      if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isIdentifier(node.expression)) {
        model.exportedRegistrars.set("default", node.expression.text);
        model.defaultExportIdentifier = node.expression.text;
      }
      ts.forEachChild(node, (child) => visit(child, nextContext));
    }
    visit(source);
    for (const [exportedName, fn] of model.functions) {
      if (!fn.body) continue;
      const context = model.functionContexts.get(exportedName) ?? exportedName;
      let returnedRouter = null;
      function findReturnedRouter(node) {
        if (node !== fn && ts.isFunctionLike(node)) return;
        if (
          ts.isReturnStatement(node) &&
          node.expression &&
          ts.isIdentifier(node.expression) &&
          model.routerVariables.get(context)?.has(node.expression.text)
        ) {
          returnedRouter = node.expression.text;
          return;
        }
        ts.forEachChild(node, findReturnedRouter);
      }
      if (ts.isBlock(fn.body)) findReturnedRouter(fn.body);
      else if (ts.isIdentifier(fn.body) && model.routerVariables.get(context)?.has(fn.body.text)) {
        returnedRouter = fn.body.text;
      }
      if (returnedRouter) model.functionReturnReceivers.set(context, returnedRouter);
      if (model.databaseHelperSqlParameterIndexes.has(context)) continue;
      const parameters = new Map();
      fn.parameters.forEach((parameter, index) => {
        if (ts.isIdentifier(parameter.name)) parameters.set(parameter.name.text, index);
      });
      const sqlIndexes = new Set();
      function findDatabaseSink(node) {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["query", "execute"].includes(node.expression.name.text) &&
          ts.isIdentifier(node.arguments[0]) &&
          parameters.has(node.arguments[0].text)
        ) {
          sqlIndexes.add(parameters.get(node.arguments[0].text));
        }
        ts.forEachChild(node, findDatabaseSink);
      }
      findDatabaseSink(fn.body);
      if (sqlIndexes.size) model.databaseHelperSqlParameterIndexes.set(context, sqlIndexes);
    }
    models.set(file, model);
  }
  return models;
}

function unwrap(node) {
  while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)))
    node = node.expression;
  return node;
}

function evaluate(node, model, context, models, bindings = new Map(), seen = new Set()) {
  node = unwrap(node);
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((element) => evaluate(element, model, context, models, bindings, seen));
    return values.some((value) => value === null) ? null : values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return null;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
      const item = evaluate(property.initializer, model, context, models, bindings, seen);
      if (!key || item === null) return null;
      value[key] = item;
    }
    return value;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = evaluate(span.expression, model, context, models, bindings, seen);
      if (typeof expression !== "string" && typeof expression !== "number") return null;
      value += `${expression}${span.literal.text}`;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(node.left, model, context, models, bindings, seen);
    const right = evaluate(node.right, model, context, models, bindings, seen);
    return (typeof left === "string" || typeof left === "number") &&
      (typeof right === "string" || typeof right === "number")
      ? `${left}${right}`
      : null;
  }
  if (ts.isIdentifier(node)) {
    if (bindings.has(node.text)) return bindings.get(node.text);
    const marker = `${model.file}#${context}#${node.text}`;
    if (seen.has(marker)) return null;
    const nextSeen = new Set(seen).add(marker);
    const local =
      lexicalInitializer(model, node.text, node) ??
      model.constants.get(`${context}:${node.text}`) ??
      model.constants.get(node.text);
    if (local) return evaluate(local, model, context, models, bindings, nextSeen);
    const imported = importBindingFor(model, node.text, node);
    const target = imported?.target ? models.get(imported.target) : null;
    if (target)
      return evaluate(target.constants.get(imported.imported), target, "<module>", models, bindings, nextSeen);
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const object = evaluate(node.expression, model, context, models, bindings, seen);
    return object && typeof object === "object" && !Array.isArray(object) ? (object[node.name.text] ?? null) : null;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const fn = model.functions.get(node.expression.text);
    if (!fn?.body) return null;
    const returned = ts.isBlock(fn.body) ? fn.body.statements.find(ts.isReturnStatement)?.expression : fn.body;
    if (!returned) return null;
    const nextBindings = new Map(bindings);
    fn.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name))
        nextBindings.set(parameter.name.text, evaluate(node.arguments[index], model, context, models, bindings, seen));
    });
    const fnContext = ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text : context;
    return evaluate(returned, model, fnContext, models, nextBindings, seen);
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ["toLowerCase", "toUpperCase"].includes(node.expression.name.text)
  ) {
    const value = evaluate(node.expression.expression, model, context, models, bindings, seen);
    if (typeof value !== "string") return null;
    return node.expression.name.text === "toLowerCase" ? value.toLowerCase() : value.toUpperCase();
  }
  return null;
}

function immutableTupleValues(
  node,
  model,
  context,
  models,
  bindings = new Map(),
  seen = new Set(),
  allowDirect = true
) {
  if (!node) return null;
  if (ts.isArrayLiteralExpression(node))
    return allowDirect ? evaluate(node, model, context, models, bindings, seen) : null;
  if (
    ts.isAsExpression(node) &&
    /^(?:const|readonly\b)/.test(node.type.getText(model.source)) &&
    ts.isArrayLiteralExpression(unwrap(node.expression))
  ) {
    return evaluate(node.expression, model, context, models, bindings, seen);
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(model.source) === "Object" &&
    node.expression.name.text === "freeze" &&
    ts.isArrayLiteralExpression(unwrap(node.arguments[0]))
  ) {
    return evaluate(node.arguments[0], model, context, models, bindings, seen);
  }
  if (ts.isIdentifier(node)) {
    const marker = `${model.file}#${context}#tuple#${node.text}`;
    if (seen.has(marker)) return null;
    const initializer = model.constants.get(`${context}:${node.text}`) ?? model.constants.get(node.text);
    return initializer
      ? immutableTupleValues(initializer, model, context, models, bindings, new Set(seen).add(marker), false)
      : null;
  }
  return null;
}

function immutableTupleElements(node, model, context, seen = new Set(), allowDirect = true) {
  if (!node) return null;
  if (ts.isArrayLiteralExpression(node)) return allowDirect ? [...node.elements] : null;
  if (
    ts.isAsExpression(node) &&
    /^(?:const|readonly\b)/.test(node.type.getText(model.source)) &&
    ts.isArrayLiteralExpression(unwrap(node.expression))
  ) {
    return [...unwrap(node.expression).elements];
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText(model.source) === "Object" &&
    node.expression.name.text === "freeze" &&
    ts.isArrayLiteralExpression(unwrap(node.arguments[0]))
  ) {
    return [...unwrap(node.arguments[0]).elements];
  }
  if (ts.isIdentifier(node)) {
    const marker = `${model.file}#${context}#middleware-tuple#${node.text}`;
    if (seen.has(marker)) return null;
    const initializer = model.constants.get(`${context}:${node.text}`) ?? model.constants.get(node.text);
    return initializer ? immutableTupleElements(initializer, model, context, new Set(seen).add(marker), false) : null;
  }
  return null;
}

function expressionText(node, source) {
  if (!node) return "<none>";
  const text = node.getText(source).replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function resolvedExpressionNode(node, model, context, seen = new Set()) {
  node = unwrap(node);
  if (!node || !ts.isIdentifier(node)) return node;
  const marker = `${model.file}#${context}#expression#${node.text}`;
  if (seen.has(marker)) return node;
  const initializer =
    lexicalInitializer(model, node.text, node) ??
    model.constants.get(`${context}:${node.text}`) ??
    model.constants.get(node.text);
  return initializer ? resolvedExpressionNode(initializer, model, context, new Set(seen).add(marker)) : node;
}

function objectPropertyNode(node, name, model, context) {
  const object = resolvedExpressionNode(node, model, context);
  if (!object || !ts.isObjectLiteralExpression(object)) return { object, property: null, complete: false };
  let property = null;
  let complete = true;
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      // A later spread can replace an earlier property. Keep the property only
      // when a subsequent explicit member re-establishes its authority.
      property = null;
      complete = false;
      continue;
    }
    if (
      ts.isPropertyAssignment(member) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
      member.name.text === name
    ) {
      property = member.initializer;
      complete = true;
    } else if (ts.isShorthandPropertyAssignment(member) && member.name.text === name) {
      property = member.name;
      complete = true;
    }
  }
  return { object, property, complete };
}

function objectHeaderAuthority(node, model, context) {
  const object = resolvedExpressionNode(node, model, context);
  if (!object || !ts.isObjectLiteralExpression(object)) return "unclassified";
  let evidence = "not-declared";
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      evidence = "unclassified";
      continue;
    }
    const name =
      (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))
        ? member.name.text
        : null;
    if (name && /idempotency[-_ ]?key/i.test(name)) evidence = "declared-header";
  }
  return evidence;
}

function symbolicAuthority(node, model, context, models, bindings = new Map(), seen = new Set()) {
  node = unwrap(node);
  if (!node) return "<missing>";
  const evaluated = evaluate(node, model, context, models, bindings);
  if (["string", "number", "boolean"].includes(typeof evaluated)) return String(evaluated);
  if (ts.isIdentifier(node)) {
    const marker = `${model.file}#${context}#symbolic#${node.text}`;
    if (seen.has(marker)) return `<dynamic:${node.text}>`;
    const initializer =
      lexicalInitializer(model, node.text, node) ??
      model.constants.get(`${context}:${node.text}`) ??
      model.constants.get(node.text);
    if (initializer) {
      return symbolicAuthority(initializer, model, context, models, bindings, new Set(seen).add(marker));
    }
    return `<dynamic:${node.text}>`;
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map(
          (span) => `${symbolicAuthority(span.expression, model, context, models, bindings, seen)}${span.literal.text}`
        )
        .join("")
    );
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return `${symbolicAuthority(node.left, model, context, models, bindings, seen)}${symbolicAuthority(
      node.right,
      model,
      context,
      models,
      bindings,
      seen
    )}`;
  }
  return `<dynamic:${expressionText(node, model.source)}>`;
}

function fetchOptionFacts(options, model, context, models, bindings = new Map()) {
  const method = objectPropertyNode(options, "method", model, context);
  const signal = objectPropertyNode(options, "signal", model, context);
  const headers = objectPropertyNode(options, "headers", model, context);
  const methodValue = method.property ? evaluate(method.property, model, context, models, bindings) : null;
  return {
    httpMethod:
      typeof methodValue === "string"
        ? methodValue.toUpperCase()
        : !options || (method.complete && ts.isObjectLiteralExpression(method.object) && !method.property)
          ? "GET"
          : "unclassified",
    timeoutSignal: signal.property
      ? expressionText(resolvedExpressionNode(signal.property, model, context), model.source)
      : !options || signal.complete
        ? "not-declared"
        : "unclassified",
    idempotencyEvidence: headers.property
      ? objectHeaderAuthority(headers.property, model, context)
      : !options || headers.complete
        ? "not-declared"
        : "unclassified",
    optionsAuthority: options ? symbolicAuthority(options, model, context, models, bindings) : "default-fetch-options",
  };
}

function staticSql(node, source) {
  node = unwrap(node);
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => ` __EXPR__ ${span.literal.text}`).join("");
  }
  if (ts.isTaggedTemplateExpression(node)) return staticSql(node.template, source);
  return null;
}

function resolvedSql(node, model, context, models, bindings = new Map(), seen = new Set()) {
  node = unwrap(node);
  if (!node) return null;
  const evaluated = evaluate(node, model, context, models, bindings);
  if (typeof evaluated === "string") return evaluated;
  const direct = staticSql(node, model.source);
  if (direct !== null) return direct;
  if (ts.isIdentifier(node)) {
    const marker = `${model.file}#${context}#sql#${node.text}`;
    if (seen.has(marker)) return null;
    const nextSeen = new Set(seen).add(marker);
    const bound = bindings.get(node.text);
    if (typeof bound === "string") return bound;
    const initializer = model.constants.get(`${context}:${node.text}`) ?? model.constants.get(node.text);
    if (initializer) return resolvedSql(initializer, model, context, models, bindings, nextSeen);
  }
  return null;
}

function sqlEffects(sql) {
  if (typeof sql !== "string") return [];
  const cteAliases = new Set(
    [
      ...sql.matchAll(
        /(?:\bWITH(?:\s+RECURSIVE)?|,)\s*([a-z_][a-z0-9_]*)\s*(?:\([^)]*\)\s*)?AS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?\(/gi
      ),
    ].map((match) => match[1].toLowerCase())
  );
  const effects = [];
  for (const match of sql.matchAll(
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN)\s+(?:["']?([a-z_][a-z0-9_]*)["']?\s*\.\s*)?["']?([a-z_][a-z0-9_]*)/gi
  )) {
    const before = sql.slice(Math.max(0, match.index - 40), match.index);
    if (match[1].toUpperCase() === "FROM" && /\bIS\s+(?:NOT\s+)?DISTINCT\s*$/i.test(before)) {
      continue;
    }
    if (match[1].toUpperCase() === "UPDATE" && /\bDO\s*$/i.test(before)) continue;
    const schema = match[2]?.toLowerCase() ?? null;
    const name = match[3].toLowerCase();
    if (
      name === "lateral" ||
      (["FROM", "JOIN"].includes(match[1].toUpperCase()) && /^\s*\(/.test(sql.slice(match.index + match[0].length)))
    )
      continue;
    if (!schema && cteAliases.has(name)) continue;
    const table = `${schema ?? "public"}.${name}`;
    effects.push({
      effect: /^(?:INSERT|UPDATE|DELETE)/i.test(match[1]) ? "write" : "read",
      table,
    });
  }
  return effects;
}

function providerOperation(expressionTextValue) {
  const patterns = [
    [
      /(?:^|\.)(?:accounts|accountLinks|paymentIntents|setupIntents|checkout\.sessions|billingPortal\.sessions|coupons|refunds|charges|disputes|prices|products|subscriptions|customers|invoices|paymentMethods|balanceTransactions|transfers|payouts)\.(?:create|retrieve|update|list|del|cancel|expire|finalizeInvoice)$/,
      "stripe",
    ],
    [/(?:^|\.)emails\.send$/, "resend"],
    [/(?:^|\.)messages\.create$/, "anthropic"],
    [/(?:^|\.)(?:chat\.completions|responses)\.create$/, "openai"],
    [/(?:^|\.)embeddings\.create$/, "openai"],
    [/(?:^|\.)images\.(?:generate|edit)$/, "openai"],
    [/(?:^|\.)generateContent$/, "google-generative-ai"],
  ];
  return patterns.find(([pattern]) => pattern.test(expressionTextValue))?.[1] ?? null;
}

function normalizePath(prefix, path) {
  if (path === "<dynamic>" || prefix === "<dynamic>") return "<dynamic>";
  const joined = `${prefix ?? ""}/${path ?? ""}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

function functionTarget(expression, model, models, context = "<module>") {
  if (ts.isIdentifier(expression)) {
    const imported = importBindingFor(model, expression.text, expression);
    if (imported?.target) {
      const importedModel = models.get(imported.target);
      return `${imported.target}#${importedModel?.functionContexts.get(imported.imported) ?? imported.imported}`;
    }
    if (!model.functions.has(expression.text)) return null;
    return `${model.file}#${model.functionContexts.get(expression.text) ?? expression.text}`;
  }
  if (!ts.isPropertyAccessExpression(expression)) return null;
  const parts = [];
  let cursor = expression;
  while (ts.isPropertyAccessExpression(cursor)) {
    parts.unshift(cursor.name.text);
    cursor = cursor.expression;
  }
  if (cursor.kind === ts.SyntaxKind.ThisKeyword) {
    const owner = context.includes(".") ? context.slice(0, context.lastIndexOf(".")) : null;
    const memberKey = owner ? `${owner}.${parts.join(".")}` : null;
    if (memberKey && model.functions.has(memberKey))
      return `${model.file}#${model.functionContexts.get(memberKey) ?? memberKey}`;
    return null;
  }
  if (!ts.isIdentifier(cursor)) return null;
  parts.unshift(cursor.text);
  const localKey = parts.join(".");
  if (model.functions.has(localKey)) return `${model.file}#${model.functionContexts.get(localKey) ?? localKey}`;
  if (parts.length === 2) {
    const className = model.classInstances.get(parts[0]);
    const classKey = className ? `${className}.${parts[1]}` : null;
    if (classKey && model.functions.has(classKey))
      return `${model.file}#${model.functionContexts.get(classKey) ?? classKey}`;
  }
  const imported = importBindingFor(model, parts[0], cursor);
  if (!imported?.target) return null;
  const importedModel = models.get(imported.target);
  const importedBase =
    imported.imported === "default" ? (importedModel?.defaultExportIdentifier ?? "default") : imported.imported;
  const importedKey = importedBase === "*" ? parts.slice(1).join(".") : [importedBase, ...parts.slice(1)].join(".");
  if (importedModel?.functions.has(importedKey))
    return `${imported.target}#${importedModel.functionContexts.get(importedKey) ?? importedKey}`;
  if (parts.length === 2) {
    const importedClass = importedModel?.classInstances.get(importedBase);
    const importedClassKey = importedClass ? `${importedClass}.${parts[1]}` : null;
    if (importedClassKey && importedModel.functions.has(importedClassKey)) {
      return `${imported.target}#${importedModel.functionContexts.get(importedClassKey) ?? importedClassKey}`;
    }
  }
  return null;
}

function callableTarget(expression, model, context, models) {
  if (ts.isIdentifier(expression) && model.routerVariables.get(context)?.has(expression.text))
    return `${model.file}#${context}:router:${expression.text}`;
  const target = ts.isCallExpression(expression) ? expression.expression : expression;
  if (!ts.isIdentifier(target)) return null;
  const imported = importBindingFor(model, target.text, target);
  if (imported?.target) {
    const importedModel = models.get(imported.target);
    const exported = importedModel?.exportedRegistrars.get(imported.imported);
    if (exported) {
      if (importedModel.routerVariables.get("<module>")?.has(exported))
        return `${imported.target}#<module>:router:${exported}`;
    }
    const importedContext = importedModel?.functionContexts.get(imported.imported) ?? imported.imported;
    const returned = importedModel?.functionReturnReceivers.get(importedContext);
    return returned ? `${imported.target}#${importedContext}:router:${returned}` : null;
  }
  const localContext = model.functionContexts.get(target.text) ?? target.text;
  const returned = model.functionReturnReceivers.get(localContext);
  return returned ? `${model.file}#${localContext}:router:${returned}` : null;
}

function registrarFor(receiver, model, context) {
  if (!ts.isIdentifier(receiver)) return null;
  const seen = new Set();
  function resolveName(name, startContext) {
    const marker = `${startContext}:${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    let declaringContext = startContext;
    while (declaringContext) {
      if (model.rootReceivers.get(declaringContext)?.has(name))
        return `<root:${model.file}#${declaringContext}:${name}>`;
      if (model.unapprovedRootReceivers.get(declaringContext)?.has(name))
        return `<unapproved-root:${model.file}#${declaringContext}:${name}>`;
      if (model.routerVariables.get(declaringContext)?.has(name))
        return `${model.file}#${declaringContext}:router:${name}`;
      if (model.expressReceivers.get(declaringContext)?.has(name))
        return `${model.file}#${declaringContext}:param:${name}`;
      declaringContext = model.contextParents.get(declaringContext);
    }
    const initializer = lexicalInitializer(model, name, receiver);
    return initializer && ts.isIdentifier(unwrap(initializer))
      ? resolveName(unwrap(initializer).text, startContext)
      : null;
  }
  return resolveName(receiver.text, context);
}

function propagateExpressReceivers(models) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const model of models.values()) {
      function visit(node, context = "<module>") {
        const named = functionName(node);
        const nextContext = named ?? context;
        if (ts.isCallExpression(node)) {
          const target = functionTarget(node.expression, model, models, nextContext);
          const separator = target?.lastIndexOf("#") ?? -1;
          const targetFile = separator >= 0 ? target.slice(0, separator) : "";
          const targetContext = separator >= 0 ? target.slice(separator + 1) : "";
          const targetModel = models.get(targetFile);
          const targetFunction = targetModel?.functions.get(targetContext);
          if (targetFunction) {
            for (const [index, argument] of [...node.arguments].entries()) {
              if (!registrarFor(argument, model, nextContext)) continue;
              const parameter = targetFunction.parameters[index];
              if (!parameter || !ts.isIdentifier(parameter.name)) continue;
              if (!targetModel.expressReceivers.has(targetContext)) {
                targetModel.expressReceivers.set(targetContext, new Set());
              }
              if (!targetModel.expressParameterIndexes.has(targetContext)) {
                targetModel.expressParameterIndexes.set(targetContext, new Map());
              }
              const receiverCount = targetModel.expressReceivers.get(targetContext).size;
              targetModel.expressReceivers.get(targetContext).add(parameter.name.text);
              targetModel.expressParameterIndexes.get(targetContext).set(parameter.name.text, index);
              if (targetModel.expressReceivers.get(targetContext).size !== receiverCount) changed = true;
            }
          }
        }
        ts.forEachChild(node, (child) => visit(child, nextContext));
      }
      visit(model.source);
    }
  }
}

function middlewareFacts(argumentsAfterPath, source) {
  const text = argumentsAfterPath.map((argument) => expressionText(argument, source)).join(" ");
  const capabilities = [...new Set(text.match(/\b(?:require|assert|enforce)[A-Z][A-Za-z0-9_]*/g) ?? [])].sort();
  let actor = "public-or-handler-enforced";
  if (/requireSuperAdmin/.test(text)) actor = "super-admin";
  else if (/requireAdmin/.test(text)) actor = "admin";
  else if (/requirePartnerAuth|partnerSession/.test(text)) actor = "partner";
  else if (/requireCustomer/.test(text)) actor = "customer";
  else if (/requireStaff/.test(text)) actor = "staff";
  const schemas = [
    ...new Set([...text.matchAll(/\b([A-Za-z][A-Za-z0-9_]*Schema)\.(?:parse|safeParse)\b/g)].map((match) => match[1])),
  ].sort();
  return { actor, capabilities, requestSchemas: schemas.length ? schemas : ["inline-or-unclassified"] };
}

function scanModel(root, model, models, policy) {
  const { file, source } = model;
  const records = [];
  const routes = [];
  const mounts = [];
  const middlewares = [];
  const calls = [];
  const runtimeDependencies = [];
  const violations = [];
  const routeOrders = new Map();
  function nextOrder(registrar) {
    const order = routeOrders.get(registrar) ?? 0;
    routeOrders.set(registrar, order + 1);
    return order;
  }
  function add(category, id, node, fields = {}) {
    records.push({ category, id, file, line: lineOf(source, node), ...fields });
  }
  function expandMiddlewareArguments(argumentsAfterPath, context) {
    const expanded = [];
    for (const argument of argumentsAfterPath) {
      if (!ts.isSpreadElement(argument)) {
        expanded.push(argument);
        continue;
      }
      const elements = immutableTupleElements(argument.expression, model, context);
      if (!elements) {
        violations.push({
          code: "DYNAMIC_MIDDLEWARE_SPREAD",
          source: `${file}:${lineOf(source, argument)}`,
          target: expressionText(argument, source),
        });
        expanded.push(argument);
        continue;
      }
      expanded.push(...elements);
    }
    return expanded;
  }
  function registerRouteCall(node, property, callName, context, activeBindings, suppressDynamicTemplate = false) {
    const first = node.arguments[0];
    let routeNode = first;
    let receiver = property.expression;
    if (
      ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === "route"
    ) {
      routeNode = receiver.arguments[0];
      receiver = receiver.expression.expression;
    }
    const path = routeNode ? evaluate(routeNode, model, context, models, activeBindings) : null;
    const registrar = registrarFor(receiver, model, context);
    if (!registrar || (suppressDynamicTemplate && typeof path !== "string")) return;
    if (typeof path !== "string") {
      violations.push({
        code: "DYNAMIC_SERVER_ROUTE",
        source: `${file}:${lineOf(source, node)}`,
        target: expressionText(routeNode, source),
      });
    }
    const registrationOrder = nextOrder(registrar);
    const handlerArguments = expandMiddlewareArguments([...node.arguments].slice(routeNode === first ? 1 : 0), context);
    const facts = middlewareFacts(handlerArguments, source);
    routes.push({
      method: callName.toUpperCase(),
      declaredPath: typeof path === "string" ? path : "<dynamic>",
      registrar,
      registrationOrder,
      file,
      line: lineOf(source, node),
      handlerContext: `${file}#${context}`,
      handlerRanges: handlerArguments.map((argument) => [argument.getStart(source), argument.getEnd()]),
      routeLocalMiddleware: handlerArguments.map((argument) => expressionText(argument, source)),
      delegatedHandlerContexts: handlerArguments
        .map((argument) => functionTarget(argument, model, models, context))
        .filter(Boolean),
      ...facts,
      responseSchemas: ["inline-or-unclassified"],
      retirementState: /\.status\(410\)/.test(node.getText(source)) ? "retired" : "active",
    });
  }
  function routePathNode(node, property) {
    const receiver = property.expression;
    return ts.isCallExpression(receiver) &&
      ts.isPropertyAccessExpression(receiver.expression) &&
      receiver.expression.name.text === "route"
      ? receiver.arguments[0]
      : node.arguments[0];
  }
  function routePathUsesFunctionParameter(node, targetFunction) {
    const parameters = new Set(
      [...(targetFunction?.parameters ?? [])]
        .filter((parameter) => ts.isIdentifier(parameter.name))
        .map((parameter) => parameter.name.text)
    );
    let found = false;
    function find(current) {
      if (ts.isIdentifier(current) && parameters.has(current.text)) found = true;
      if (!found) ts.forEachChild(current, find);
    }
    if (node) find(node);
    return found;
  }
  const locallyInvokedContexts = new Set();
  function collectLocalInvocations(node, context = "<module>") {
    const named = functionName(node);
    const nextContext = named ?? context;
    if (ts.isCallExpression(node)) {
      const target = functionTarget(node.expression, model, models, nextContext);
      if (target?.startsWith(`${file}#`)) locallyInvokedContexts.add(target.slice(file.length + 1));
    }
    ts.forEachChild(node, (child) => collectLocalInvocations(child, nextContext));
  }
  collectLocalInvocations(source);
  function expandLocalRouteTemplates(targetContext, targetFunction, callNode, callerContext, callerBindings) {
    const targetBindings = new Map();
    targetFunction.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        targetBindings.set(
          parameter.name.text,
          evaluate(callNode.arguments[index], model, callerContext, models, callerBindings)
        );
      }
    });
    function find(node) {
      if (
        node !== targetFunction.body &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node))
      ) {
        return;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callName = node.expression.name.text;
        if (ROUTE_METHODS.has(callName)) {
          const first = node.arguments[0];
          const routeNode =
            ts.isCallExpression(node.expression.expression) &&
            ts.isPropertyAccessExpression(node.expression.expression.expression) &&
            node.expression.expression.expression.name.text === "route"
              ? node.expression.expression.arguments[0]
              : first;
          if (
            typeof evaluate(routeNode, model, targetContext, models, new Map()) !== "string" &&
            routePathUsesFunctionParameter(routeNode, targetFunction)
          ) {
            registerRouteCall(node, node.expression, callName, targetContext, targetBindings);
          }
        }
      }
      ts.forEachChild(node, find);
    }
    find(targetFunction.body);
  }
  function dependency(specifier, node, kind) {
    const target = importTarget(root, new Set(models.keys()), file, specifier);
    if (PROVIDER_MODULES.has(specifier)) add("provider-adapter", `module:${specifier}`, node, { effect: "sdk-import" });
    if (!target) return;
    runtimeDependencies.push({ source: file, target, kind, line: lineOf(source, node) });
    for (const rule of policy.forbiddenRuntimeImports ?? []) {
      const fromMatches = file.startsWith(rule.fromPrefix);
      const toMatches = rule.toExact
        ? target.replace(/[.][^./]+$/, "") === rule.toExact
        : target.startsWith(rule.toPrefix);
      if (!fromMatches || !toMatches) continue;
      const exception = (policy.runtimeImportExceptions ?? []).find(
        (item) => item.source === file && item.target === target.replace(/[.][^./]+$/, "") && item.kind === kind
      );
      if (exception)
        add("layer-exception", `${kind}:${target}`, node, {
          target,
          finding: exception.finding,
          explicitDisposition: "known-legacy",
        });
      else
        violations.push({ code: "FORBIDDEN_RUNTIME_IMPORT", source: `${file}:${lineOf(source, node)}`, target, kind });
    }
  }
  function visit(node, context = "<module>", ancestors = [], bindings = new Map()) {
    const named = functionName(node);
    const nextContext = named ?? context;
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const declaration = node.initializer.declarations[0];
      const values = immutableTupleValues(node.expression, model, nextContext, models, bindings);
      if (declaration && ts.isIdentifier(declaration.name) && Array.isArray(values)) {
        for (const value of values) {
          const nextBindings = new Map(bindings).set(declaration.name.text, value);
          visit(node.statement, nextContext, [...ancestors, node], nextBindings);
        }
        return;
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && runtimeImport(node)) {
      dependency(node.moduleSpecifier.text, node, "import");
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      runtimeExport(node)
    ) {
      dependency(node.moduleSpecifier.text, node, "export");
    }
    if (ts.isCallExpression(node)) {
      const property = ts.isPropertyAccessExpression(node.expression) ? node.expression : null;
      const callName = property ? property.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
      const invokedFunction = functionTarget(node.expression, model, models, nextContext);
      if (invokedFunction) {
        calls.push({
          sourceContext: `${file}#${nextContext}`,
          targetContext: invokedFunction,
          file,
          line: lineOf(source, node),
          position: node.getStart(source),
          callerContext: nextContext,
          arguments: [...node.arguments],
          bindings: new Map(bindings),
        });
        const separator = invokedFunction.lastIndexOf("#");
        const targetFile = invokedFunction.slice(0, separator);
        const targetContext = invokedFunction.slice(separator + 1);
        const targetFunction = targetFile === file ? model.functions.get(targetContext) : null;
        if (targetFunction && locallyInvokedContexts.has(targetContext)) {
          expandLocalRouteTemplates(targetContext, targetFunction, node, nextContext, bindings);
        }
      }
      const first = node.arguments[0];
      const evaluated = first ? evaluate(first, model, nextContext, models, bindings) : null;
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || callName === "require") &&
        typeof evaluated === "string"
      ) {
        dependency(evaluated, node, callName === "require" ? "require" : "dynamic-import");
      }
      if (file.startsWith("server/") && ts.isIdentifier(node.expression)) {
        const target = functionTarget(node.expression, model, models, nextContext);
        const separator = target?.lastIndexOf("#") ?? -1;
        const targetFile = separator >= 0 ? target.slice(0, separator) : "";
        const targetContext = separator >= 0 ? target.slice(separator + 1) : "";
        const targetModel = models.get(targetFile);
        const parameters = targetModel?.expressParameterIndexes.get(targetContext);
        if (target && parameters?.size) {
          for (const [parameterName, index] of parameters) {
            const parent = node.arguments[index] ? registrarFor(node.arguments[index], model, nextContext) : null;
            if (!parent) continue;
            const targetRegistrar = `${target}:param:${parameterName}`;
            const order = nextOrder(parent);
            mounts.push({ parent, target: targetRegistrar, prefix: "", order, file, line: lineOf(source, node) });
            add("route-mount", `${parent}->${targetRegistrar}@/`, node, {
              parent,
              target: targetRegistrar,
              prefix: "/",
              registrationOrder: order,
              compositionKind: "registrar-call",
            });
            break;
          }
        }
      }
      if (file.startsWith("server/") && property && ROUTE_METHODS.has(callName)) {
        registerRouteCall(
          node,
          property,
          callName,
          nextContext,
          bindings,
          locallyInvokedContexts.has(nextContext) &&
            routePathUsesFunctionParameter(routePathNode(node, property), model.functions.get(nextContext))
        );
      }
      if (file.startsWith("server/") && property && callName === "use") {
        const receiver = property.expression;
        const parent = registrarFor(receiver, model, nextContext);
        if (parent) {
          const prefix = typeof evaluated === "string" && evaluated.startsWith("/") ? evaluated : "";
          const candidates = [...node.arguments].slice(prefix ? 1 : 0);
          for (const candidate of candidates) {
            const target = callableTarget(candidate, model, nextContext, models);
            const order = nextOrder(parent);
            if (target) {
              mounts.push({ parent, target, prefix, order, file, line: lineOf(source, node) });
              add("route-mount", `${parent}->${target}@${prefix || "/"}`, node, {
                parent,
                target,
                prefix: prefix || "/",
                registrationOrder: order,
                compositionKind: "express-use",
              });
            } else {
              const facts = middlewareFacts([candidate], source);
              const middleware = expressionText(candidate, source);
              middlewares.push({ parent, prefix, order, middleware, ...facts });
              add("route-middleware", `${parent}@${prefix || "/"}:${middleware}`, candidate, {
                parent,
                prefix: prefix || "/",
                registrationOrder: order,
                middleware,
                actor: facts.actor,
                capabilities: facts.capabilities,
              });
            }
          }
        }
      }
      if ((file.startsWith("server/") || file.startsWith("scripts/")) && /^fetch$/.test(callName)) {
        const urlAuthority = symbolicAuthority(first, model, nextContext, models, bindings);
        let provider = "dynamic-fetch";
        const match = urlAuthority.match(/https?:\/\/[^/'"`$<>}\s]+/);
        if (match) provider = match[0];
        const options = node.arguments[1];
        add("provider-adapter", `fetch:${provider}`, node, {
          effect: "http-fetch",
          urlAuthority,
          ...fetchOptionFacts(options, model, nextContext, models, bindings),
          _position: node.getStart(source),
          _context: `${file}#${nextContext}`,
          _fetchUrlNode: first,
          _fetchOptionsNode: options,
        });
      }
      const objectEffect =
        OBJECT_CALLS.get(callName) ??
        (/^upload.*ToR2$/.test(callName)
          ? "direct-put-r2"
          : /^upload.*ToB2$/.test(callName)
            ? "direct-put-b2"
            : /^delete.*FromR2$/.test(callName)
              ? "direct-delete-r2"
              : /^delete.*FromB2$/.test(callName)
                ? "direct-delete-b2"
                : null);
      if ((file.startsWith("server/") || file.startsWith("scripts/")) && objectEffect) {
        add("object-writer", `${callName}:${expressionText(first, source)}`, node, {
          effect: objectEffect,
          _position: node.getStart(source),
          _context: `${file}#${nextContext}`,
        });
      }
      const provider = providerOperation(expressionText(node.expression, source));
      if ((file.startsWith("server/") || file.startsWith("scripts/")) && provider) {
        add("provider-adapter", `${provider}:${expressionText(node.expression, source)}`, node, {
          effect: "sdk-operation",
          _position: node.getStart(source),
          _context: `${file}#${nextContext}`,
        });
      }
      if (
        (file.startsWith("server/") || file.startsWith("scripts/")) &&
        (/^(?:set|track)Interval$/.test(callName) ||
          callName === "scheduleJob" ||
          /^(?:start|install)[A-Z].*(?:Job|Worker|Reconciler|Scheduler)$/.test(callName))
      ) {
        const cadenceNode = /Interval/.test(callName) ? node.arguments[1] : node.arguments[0];
        add("job", `${callName}:${expressionText(first, source)}`, node, {
          installer: callName,
          cadence: expressionText(cadenceNode, source),
          lifecycle: callName.startsWith("track") ? "tracked" : "unclassified",
          lock: /lock|advisory/i.test(node.getText(source)) ? "declared-in-registration" : "unclassified",
        });
      }
      if ((file.startsWith("server/") || file.startsWith("scripts/")) && /^(?:set|track)Timeout$/.test(callName)) {
        const purposeText = `${expressionText(first, source)} ${ancestors
          .slice(-3)
          .map((ancestor) => expressionText(ancestor, source))
          .join(" ")}`;
        const timerKind = /abort|deadline/i.test(purposeText)
          ? "watchdog"
          : /retry|backoff|sleep|delay/i.test(purposeText)
            ? "retry-or-sleep"
            : /debounce|throttle/i.test(purposeText)
              ? "debounce"
              : "one-shot-unclassified";
        add("timer", `${callName}:${expressionText(first, source)}`, node, {
          timerKind,
          delay: expressionText(node.arguments[1], source),
          lifecycle: callName.startsWith("track") ? "tracked" : "untracked",
        });
      }
      if (callName === "pgTable" && typeof evaluated === "string")
        add("table", `public.${evaluated}`, node, { authority: "drizzle" });
      const receiverText = property ? expressionText(property.expression, source) : "";
      if (
        (file.startsWith("server/") || file.startsWith("scripts/")) &&
        ["insert", "update", "delete", "from"].includes(callName) &&
        first &&
        /\b(?:db|database|drizzle|transaction|tx)\b/i.test(receiverText)
      ) {
        const effect = callName === "from" ? "read" : "write";
        add("table-access", `${effect}:${expressionText(first, source)}`, node, { effect, access: "drizzle" });
      }
      if (["query", "execute"].includes(callName) && first) {
        const parameterIndex =
          ts.isIdentifier(first) && model.functions.get(nextContext)?.parameters
            ? [...model.functions.get(nextContext).parameters].findIndex(
                (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === first.text
              )
            : -1;
        const delegated =
          parameterIndex >= 0 && model.databaseHelperSqlParameterIndexes.get(nextContext)?.has(parameterIndex);
        const sql = resolvedSql(first, model, nextContext, models, bindings);
        const databaseReceiver = /\b(?:db|database|pool|client|tx|executor|exec|queryable)\b/i.test(receiverText);
        if (!delegated && (databaseReceiver || sql !== null)) {
          const effects = sqlEffects(sql);
          if (effects.length === 0) {
            add("table-access", `unclassified:${expressionText(first, source)}`, node, {
              effect: "unclassified",
              access: "sql-unclassified",
            });
          } else {
            for (const access of effects) {
              add("table-access", `${access.effect}:${access.table}`, node, {
                effect: access.effect,
                access: "sql",
              });
            }
          }
        }
      }
      {
        const target = functionTarget(node.expression, model, models, nextContext);
        const separator = target?.lastIndexOf("#") ?? -1;
        const targetFile = separator >= 0 ? target.slice(0, separator) : "";
        const targetContext = separator >= 0 ? target.slice(separator + 1) : "";
        const targetModel = models.get(targetFile);
        for (const index of targetModel?.databaseHelperSqlParameterIndexes.get(targetContext) ?? []) {
          const sql = node.arguments[index]
            ? resolvedSql(node.arguments[index], model, nextContext, models, bindings)
            : null;
          const effects = sqlEffects(sql);
          if (effects.length === 0) {
            add("table-access", `unclassified-helper:${target}`, node, {
              effect: "unclassified",
              access: "sql-helper-unclassified",
            });
          } else {
            for (const access of effects) {
              add("table-access", `${access.effect}:${access.table}`, node, {
                effect: access.effect,
                access: "sql-helper",
              });
            }
          }
        }
      }
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      (file.startsWith("server/") || file.startsWith("scripts/")) &&
      !(ts.isCallExpression(node.parent) && node.parent.arguments[0] === node)
    ) {
      const sql = staticSql(node.template, source);
      for (const access of sqlEffects(sql)) {
        add("table-access", `${access.effect}:${access.table}`, node, {
          effect: access.effect,
          access: "tagged-sql",
        });
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if (OBJECT_COMMANDS.has(node.expression.text))
        add("object-writer", node.expression.text, node, {
          effect: OBJECT_COMMANDS.get(node.expression.text),
          _position: node.getStart(source),
          _context: `${file}#${nextContext}`,
        });
      if (["Stripe", "OpenAI", "Resend", "Anthropic"].includes(node.expression.text)) {
        add("provider-adapter", `client:${node.expression.text.toLowerCase()}`, node, {
          effect: "sdk-client",
          _position: node.getStart(source),
          _context: `${file}#${nextContext}`,
        });
      }
    }
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      file.startsWith("client/src/") &&
      node.tagName.getText(source) === "Route"
    ) {
      const attribute = (element, name) =>
        element.attributes.properties.find((item) => ts.isJsxAttribute(item) && item.name.getText(source) === name);
      const attributeValue = (item) => {
        if (!item || !ts.isJsxAttribute(item) || !item.initializer) return null;
        if (ts.isStringLiteral(item.initializer)) return item.initializer.text;
        return ts.isJsxExpression(item.initializer) && item.initializer.expression
          ? (evaluate(item.initializer.expression, model, nextContext, models, bindings) ??
              expressionText(item.initializer.expression, source))
          : null;
      };
      const path = attributeValue(attribute(node, "path")) ?? "<pathless>";
      const componentAttribute = attributeValue(attribute(node, "component"));
      const descendants = [];
      const routeElement = ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent) ? node.parent : null;
      const wrapperDetails = (opening) => {
        const component = opening.tagName.getText(source);
        return {
          component,
          importTarget: model.imports.get(component)?.target ?? "inline-or-unclassified",
          props: Object.fromEntries(
            opening.attributes.properties
              .filter(ts.isJsxAttribute)
              .map((item) => [item.name.getText(source), String(attributeValue(item) ?? "present")])
          ),
        };
      };
      const outerGuardChain = ancestors
        .filter((ancestor) => ts.isJsxElement(ancestor))
        .map((ancestor) => wrapperDetails(ancestor.openingElement))
        .filter((item) => !["Route", "Switch"].includes(item.component));
      function collectDescendants(current, guardChain = outerGuardChain) {
        if (current === routeElement) {
          for (const child of current.children) collectDescendants(child, guardChain);
          return;
        }
        if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
          const opening = ts.isJsxElement(current) ? current.openingElement : current;
          const details = wrapperDetails(opening);
          if (details.component === "Route") return;
          const childElements = [];
          if (ts.isJsxElement(current)) {
            for (const child of current.children) {
              if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) childElements.push(child);
              else ts.forEachChild(child, (nested) => collectDescendants(nested, guardChain));
            }
          }
          const wrapsJsx = childElements.length > 0;
          descendants.push({
            tag: details.component,
            opening,
            props: details.props,
            importTarget: details.importTarget,
            wrapsJsx,
            guardChain,
          });
          const nextChain = /^[A-Z]/.test(details.component) && wrapsJsx ? [...guardChain, details] : guardChain;
          for (const child of childElements) collectDescendants(child, nextChain);
          return;
        }
        ts.forEachChild(current, (child) => collectDescendants(child, guardChain));
      }
      if (routeElement) collectDescendants(routeElement);
      const attributeComponentName = componentAttribute
        ? String(componentAttribute).replace(/[^A-Za-z0-9_$].*$/, "")
        : null;
      const childComponentEntries = descendants.filter(
        (item) => /^[A-Z]/.test(item.tag) && (!item.wrapsJsx || item.tag === "Redirect")
      );
      const childComponents = childComponentEntries.map((item) => item.tag);
      const renderedComponents = [...new Set([attributeComponentName, ...childComponents].filter(Boolean))];
      const componentImports = renderedComponents.map((componentName) => {
        const imported = model.imports.get(componentName);
        return model.lazyImports.get(componentName) ?? imported?.target ?? "inline-or-unclassified";
      });
      const componentSourcePaths = renderedComponents
        .map((componentName) => {
          const lazySpecifier = model.lazyImports.get(componentName);
          if (lazySpecifier) return importTarget(root, new Set(models.keys()), file, lazySpecifier);
          return model.imports.get(componentName)?.target ?? null;
        })
        .filter(Boolean);
      const componentGuardChains = [
        ...(attributeComponentName ? [{ component: attributeComponentName, guards: outerGuardChain }] : []),
        ...childComponentEntries.map((item) => ({ component: item.tag, guards: item.guardChain })),
      ];
      const ancestorWrappers = outerGuardChain.map((item) => item.component);
      const descendantWrappers = descendants
        .filter((item) => /^[A-Z]/.test(item.tag) && item.wrapsJsx)
        .map((item) => item.tag);
      const wrappers = [...new Set([...ancestorWrappers, ...descendantWrappers])];
      const requiredPermissions = [
        attributeValue(attribute(node, "requiredPermission")),
        ...componentGuardChains.flatMap((item) => item.guards.map((guard) => guard.props.requiredPermission)),
      ].filter(Boolean);
      const guardProps = componentGuardChains.flatMap((item) =>
        item.guards
          .filter((guard) => /(?:Guard|Boundary|Provider|Route)$/.test(guard.component))
          .map((guard) => ({
            component: guard.component,
            importTarget: guard.importTarget,
            props: guard.props,
          }))
      );
      const redirectTargets = descendants
        .filter((item) => item.tag === "Redirect" && item.props.to)
        .map((item) => item.props.to);
      const environmentAncestor = ancestors.find(
        (ancestor) =>
          (ts.isConditionalExpression(ancestor) || ts.isBinaryExpression(ancestor)) &&
          /import\.meta\.env|NODE_ENV/.test(ancestor.getText(source))
      );
      const partnerPublic = new Set([
        "/partner",
        "/partner/*",
        "/partner/login",
        "/partner/invite",
        "/partner/forgot-password",
        "/partner/reset",
      ]);
      if (
        typeof path === "string" &&
        (path === "/partner" || path.startsWith("/partner/")) &&
        renderedComponents.length === 0 &&
        redirectTargets.length === 0
      ) {
        violations.push({
          code: "UNCLASSIFIED_PROTECTED_CLIENT_ROUTE",
          source: `${file}:${lineOf(source, node)}`,
          target: path,
        });
      }
      if (
        typeof path === "string" &&
        (path === "/partner" || path.startsWith("/partner/")) &&
        !partnerPublic.has(path) &&
        componentGuardChains
          .filter((item) => item.component !== "Redirect")
          .some((item) => !item.guards.some((guard) => guard.component === "PartnerRouteGuard"))
      ) {
        violations.push({
          code: "UNGUARDED_PARTNER_CLIENT_ROUTE",
          source: `${file}:${lineOf(source, node)}`,
          target: path,
        });
      }
      add("client-route", String(path), node, {
        component: renderedComponents.join(",") || "redirect-or-unclassified",
        componentImports,
        _componentSourcePaths: componentSourcePaths,
        wrappers,
        componentGuardChains,
        requiredPermissions: [...new Set(requiredPermissions.map(String))],
        guardProps,
        redirectTargets,
        environmentGuard: environmentAncestor ? expressionText(environmentAncestor, source) : "none-declared",
      });
    }
    ts.forEachChild(node, (child) => visit(child, nextContext, [...ancestors, node], bindings));
  }
  visit(source);
  return { records, routes, mounts, middlewares, calls, runtimeDependencies, violations };
}

function routeRecords(routes, mounts, middlewares) {
  const incoming = new Map();
  for (const mount of mounts) {
    if (!incoming.has(mount.target)) incoming.set(mount.target, []);
    incoming.get(mount.target).push(mount);
  }
  function prefixes(registrar, seen = new Set()) {
    if (registrar.startsWith("<root:")) return [{ path: "", chain: [registrar], order: [], segments: [] }];
    if (seen.has(registrar)) return [];
    const nextSeen = new Set(seen).add(registrar);
    const result = [];
    for (const mount of incoming.get(registrar) ?? []) {
      for (const parent of prefixes(mount.parent, nextSeen)) {
        result.push({
          path: normalizePath(parent.path, mount.prefix),
          chain: [...parent.chain, `${mount.parent}->${mount.target}`],
          order: [...parent.order, mount.order],
          segments: [...parent.segments, { registrar: mount.parent, limit: mount.order, basePath: parent.path }],
        });
      }
    }
    return result;
  }
  const records = [];
  const violations = [];
  for (const route of routes) {
    const reachable = prefixes(route.registrar);
    if (reachable.length === 0) {
      violations.push({
        code: "UNREACHABLE_SERVER_ROUTE",
        source: `${route.file}:${route.line}`,
        target: `${route.method} ${route.declaredPath} in ${route.registrar}`,
      });
      continue;
    }
    const contexts = reachable;
    for (const context of contexts) {
      const effectivePath =
        context.path === "<unreachable>"
          ? normalizePath("<unreachable>", route.declaredPath)
          : normalizePath(context.path, route.declaredPath);
      const middlewareSegments = [
        ...context.segments,
        { registrar: route.registrar, limit: route.registrationOrder, basePath: context.path },
      ];
      const applicableMiddleware = middlewares.filter((middleware) =>
        middlewareSegments.some(({ registrar, limit, basePath }) => {
          if (middleware.parent !== registrar || middleware.order >= limit) return false;
          const middlewarePath = normalizePath(basePath, middleware.prefix);
          return (
            middlewarePath === "/" || effectivePath === middlewarePath || effectivePath.startsWith(`${middlewarePath}/`)
          );
        })
      );
      const middlewareActors = applicableMiddleware
        .map((middleware) => middleware.actor)
        .filter((actor) => actor !== "public-or-handler-enforced");
      const actorRank = ["public-or-handler-enforced", "customer", "staff", "partner", "admin", "super-admin"];
      const effectiveActor = [route.actor, ...middlewareActors].sort(
        (a, b) => actorRank.indexOf(b) - actorRank.indexOf(a)
      )[0];
      records.push({
        category: "server-route",
        id: `${route.method} ${effectivePath}`,
        file: route.file,
        line: route.line,
        method: route.method,
        declaredPath: route.declaredPath,
        effectivePath,
        registrar: route.registrar,
        registrationOrder: [...context.order, route.registrationOrder],
        mountChain: context.chain,
        handlerContext: route.handlerContext,
        _handlerRanges: route.handlerRanges,
        _delegatedHandlerContexts: route.delegatedHandlerContexts,
        actor: effectiveActor,
        capabilities: [
          ...new Set([...route.capabilities, ...applicableMiddleware.flatMap((middleware) => middleware.capabilities)]),
        ].sort(),
        middleware: applicableMiddleware.map((item) => item.middleware),
        routeLocalMiddleware: route.routeLocalMiddleware,
        requestSchemas: route.requestSchemas,
        responseSchemas: route.responseSchemas,
        retirementState: route.retirementState,
      });
    }
  }
  return { records, violations };
}

function astValue(node, source) {
  node = unwrap(node);
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => astValue(element, source));
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
      if (!key) return undefined;
      value[key] = astValue(property.initializer, source);
    }
    return value;
  }
  return undefined;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function componentViolations(component, file) {
  const violations = [];
  const fail = (target) => violations.push({ code: "MALFORMED_COMPONENT_MANIFEST", source: `${file}:1`, target });
  if (!exactKeys(component, STRICT_COMPONENT_KEYS)) fail("manifest keys");
  if (component?.schemaVersion !== 1) fail("schemaVersion");
  if (!/^[a-z][a-z0-9-]*$/.test(component?.id ?? "")) fail("id");
  if (!/^[a-z][a-z0-9-]*$/.test(component?.owner ?? "")) fail("owner");
  if (!["required", "optional-disabled"].includes(component?.releaseMode)) fail("releaseMode");
  if (!["enabled", "disabled"].includes(component?.runtimeState)) fail("runtimeState");
  if (component?.releaseMode === "optional-disabled" && component?.runtimeState !== "disabled")
    fail("optional-disabled runtimeState");
  if (component?.releaseMode === "required" && component?.runtimeState !== "enabled") fail("required runtimeState");
  if (
    !Array.isArray(component?.sourceRoots) ||
    component.sourceRoots.length === 0 ||
    component.sourceRoots.some((root) => typeof root !== "string" || !/^(?:server|client\/src|scripts)\//.test(root))
  )
    fail("sourceRoots");
  if (!exactKeys(component?.requirements, REQUIREMENT_KEYS)) fail("requirements keys");
  for (const key of REQUIREMENT_KEYS) {
    const values = component?.requirements?.[key];
    if (!Array.isArray(values)) {
      fail(`${key} array`);
      continue;
    }
    for (const value of values) {
      const hasEstate = value && Object.hasOwn(value, "estate");
      const expected =
        key === "triggers"
          ? ["name", "order", "relation"]
          : key === "migrations" && hasEstate
            ? ["name", "order", "estate"]
            : ["name", "order"];
      if (
        !exactKeys(value, expected) ||
        typeof value.name !== "string" ||
        !Number.isSafeInteger(value.order) ||
        value.order < 0 ||
        (key === "migrations" && hasEstate && !["main", "vault-quest"].includes(value.estate))
      )
        fail(`${key} entry`);
    }
  }
  return violations;
}

function declarationName(node, source) {
  let current = node;
  while (current) {
    if (
      (ts.isVariableDeclaration(current) ||
        ts.isPropertyAssignment(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isPropertySignature(current) ||
        ts.isParameter(current) ||
        ts.isTypeAliasDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText(source);
    }
    current = current.parent;
  }
  return "<anonymous>";
}

function firstStaticQueryKey(node, model) {
  const resolved = resolvedExpressionNode(node, model, "<module>");
  if (!resolved || !ts.isArrayLiteralExpression(resolved) || resolved.elements.length === 0) return null;
  const first = resolvedExpressionNode(resolved.elements[0], model, "<module>");
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

function readAdminCacheAuthority(models, policy) {
  const declaration = policy.adminCacheAuthority;
  if (!declaration) return { configured: false, publicQueryKeys: new Set(), violations: [] };
  const violations = [];
  const exact = ["classifier", "file", "hash", "principalFields", "publicKeySet"];
  if (
    !exactKeys(declaration, exact) ||
    typeof declaration.file !== "string" ||
    typeof declaration.classifier !== "string" ||
    typeof declaration.hash !== "string" ||
    typeof declaration.publicKeySet !== "string" ||
    !Array.isArray(declaration.principalFields) ||
    declaration.principalFields.length === 0 ||
    declaration.principalFields.some((field) => typeof field !== "string")
  ) {
    return {
      configured: true,
      publicQueryKeys: new Set(),
      violations: [
        {
          code: "MALFORMED_ADMIN_CACHE_AUTHORITY",
          source: "scripts/architecture/authority-policy.json:1",
          target: "adminCacheAuthority",
        },
      ],
    };
  }

  const model = models.get(declaration.file);
  const setNode = model?.constants.get(declaration.publicKeySet);
  const classifier = model?.functions.get(declaration.classifier);
  const hash = model?.functions.get(declaration.hash);
  const publicQueryKeys = new Set();
  if (
    setNode &&
    ts.isNewExpression(setNode) &&
    ts.isIdentifier(setNode.expression) &&
    setNode.expression.text === "Set" &&
    setNode.arguments?.length === 1 &&
    ts.isArrayLiteralExpression(setNode.arguments[0]) &&
    setNode.arguments[0].elements.every(ts.isStringLiteralLike)
  ) {
    for (const element of setNode.arguments[0].elements) publicQueryKeys.add(element.text);
  } else {
    violations.push({
      code: "ADMIN_CACHE_AUTHORITY_DRIFT",
      source: `${declaration.file}:1`,
      target: `${declaration.publicKeySet} must be a static Set of public query-key literals`,
    });
  }

  const classifierStatements = classifier?.body && ts.isBlock(classifier.body) ? [...classifier.body.statements] : [];
  const classifierFalseReturn = (statement) =>
    ts.isIfStatement(statement) &&
    ts.isReturnStatement(statement.thenStatement) &&
    statement.thenStatement.expression?.kind === ts.SyntaxKind.FalseKeyword;
  const classifierShapeValid =
    classifierStatements.length === 4 &&
    ts.isVariableStatement(classifierStatements[0]) &&
    classifierStatements[0].declarationList.declarations.length === 1 &&
    classifierStatements[0].declarationList.declarations[0].name.getText(model.source) === "first" &&
    classifierStatements[0].declarationList.declarations[0].initializer?.getText(model.source) === "queryKey[0]" &&
    classifierFalseReturn(classifierStatements[1]) &&
    classifierStatements[1].expression.getText(model.source) === 'first === "public"' &&
    classifierFalseReturn(classifierStatements[2]) &&
    classifierStatements[2].expression.getText(model.source) ===
      `typeof first === "string" && ${declaration.publicKeySet}.has(first)` &&
    ts.isReturnStatement(classifierStatements[3]) &&
    classifierStatements[3].expression?.kind === ts.SyntaxKind.TrueKeyword;
  if (!classifierShapeValid) {
    violations.push({
      code: "ADMIN_CACHE_AUTHORITY_DRIFT",
      source: `${declaration.file}:1`,
      target: `${declaration.classifier} must control both public exceptions and default protected classification`,
    });
  }

  const hashStatements = hash?.body && ts.isBlock(hash.body) ? [...hash.body.statements] : [];
  const hashDeclaration =
    hashStatements[0] && ts.isVariableStatement(hashStatements[0])
      ? hashStatements[0].declarationList.declarations[0]
      : null;
  const publicHashBranch = hashStatements[1];
  const protectedHashReturn = hashStatements[2];
  const protectedTemplate =
    protectedHashReturn &&
    ts.isReturnStatement(protectedHashReturn) &&
    protectedHashReturn.expression &&
    ts.isTemplateExpression(protectedHashReturn.expression)
      ? protectedHashReturn.expression
      : null;
  const templateExpressions = protectedTemplate?.templateSpans.map((span) => span.expression) ?? [];
  const principalHash = templateExpressions.find(
    (expression) => ts.isCallExpression(expression) && expression.expression.getText(model.source) === "hashKey"
  );
  const principalFields =
    principalHash &&
    ts.isCallExpression(principalHash) &&
    principalHash.arguments.length === 1 &&
    ts.isArrayLiteralExpression(principalHash.arguments[0])
      ? principalHash.arguments[0].elements.map((element) => element.getText(model.source))
      : [];
  const hashShapeValid =
    hashStatements.length === 3 &&
    hashDeclaration?.name.getText(model.source) === "queryHash" &&
    hashDeclaration.initializer?.getText(model.source) === "hashKey(queryKey)" &&
    publicHashBranch &&
    ts.isIfStatement(publicHashBranch) &&
    publicHashBranch.expression.getText(model.source) ===
      `activeAdminPrincipal === null || !${declaration.classifier}(queryKey)` &&
    ts.isReturnStatement(publicHashBranch.thenStatement) &&
    publicHashBranch.thenStatement.expression?.getText(model.source) === "queryHash" &&
    protectedTemplate !== null &&
    templateExpressions.length === 3 &&
    templateExpressions[0].getText(model.source) === "ADMIN_QUERY_HASH_PREFIX" &&
    templateExpressions[2].getText(model.source) === "queryHash" &&
    JSON.stringify(principalFields) ===
      JSON.stringify(declaration.principalFields.map((field) => `activeAdminPrincipal.${field}`));
  if (!hashShapeValid) {
    violations.push({
      code: "ADMIN_CACHE_AUTHORITY_DRIFT",
      source: `${declaration.file}:1`,
      target: `${declaration.hash} must branch on ${declaration.classifier} and hash the complete Admin scope`,
    });
  }

  return { configured: true, declaration, publicQueryKeys, violations };
}

function semanticAuthorityRecords(model, adminCacheAuthority) {
  const { file, source } = model;
  const records = [];
  const add = (category, id, node, fields = {}) =>
    records.push({ category, id, file, line: lineOf(source, node), ...fields });
  const partnerSurface =
    file.includes("partner") || file === "client/src/App.tsx" || file === "shared/partner-schema.ts";
  const roleAuthorityName = (value) =>
    /(?:^|[_-])roles?(?:$|[_-])|(?:Role|Roles|Actor|Actors)$/.test(value) ||
    /^(?:role|roles|actor|actors)$/i.test(value);
  const currencyValues = (value) =>
    [
      ...String(value).matchAll(
        /£\s*\d+(?:[.,]\d+)?(?:\s*[–-]\s*£?\s*\d+(?:[.,]\d+)?)?|(?:^|[\s(])(\$\s*\d+(?:[.,]\d+)?)|\b((?:GBP|USD)\s*\d+(?:[.,]\d+)?)/gi
      ),
    ].map((match) => (match[1] ?? match[2] ?? match[0]).trim());
  function hasPrincipalExpression(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return false;
    if (ts.isIdentifier(node)) {
      if (/^(?:principal|session|user|customer|partnerUser|tenant|organisation|location)(?:Id|ID)$/i.test(node.text)) {
        return true;
      }
      const marker = `${model.file}#principal#${node.text}`;
      if (seen.has(marker)) return false;
      const initializer = lexicalInitializer(model, node.text, node) ?? model.constants.get(node.text);
      return initializer ? hasPrincipalExpression(initializer, new Set(seen).add(marker)) : false;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const text = node.getText(source);
      if (
        /(?:^|\.)(?:principal|session|user|customer|partnerUser|tenant|organisation|location)(?:Id|ID)$/i.test(text) ||
        /\b(?:principal|session|user|customer|partner|tenant|organisation|location)(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*)*\??\.id$/i.test(
          text
        )
      ) {
        return true;
      }
      return hasPrincipalExpression(node.expression, seen);
    }
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.some((span) => hasPrincipalExpression(span.expression, seen));
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some((property) => {
        if (ts.isPropertyAssignment(property)) return hasPrincipalExpression(property.initializer, seen);
        if (ts.isShorthandPropertyAssignment(property)) return hasPrincipalExpression(property.name, seen);
        if (ts.isSpreadAssignment(property)) return hasPrincipalExpression(property.expression, seen);
        return false;
      });
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && hasPrincipalExpression(child, seen)) found = true;
    });
    return found;
  }
  function principalKeyAuthority(node, seen = new Set()) {
    node = unwrap(node);
    if (ts.isIdentifier(node)) {
      const marker = `${model.file}#principal-key#${node.text}`;
      if (!seen.has(marker)) {
        const initializer = lexicalInitializer(model, node.text, node) ?? model.constants.get(node.text);
        if (initializer) return principalKeyAuthority(initializer, new Set(seen).add(marker));
      }
    }
    return expressionText(node, source);
  }
  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      const ownerName = declarationName(node, source);
      const roleContext =
        roleAuthorityName(ownerName) ||
        (ts.isBinaryExpression(node.parent) && /(?:role|actor)/i.test(node.parent.getText(source))) ||
        (ts.isCallExpression(node.parent) && /(?:role|actor)/i.test(node.parent.expression.getText(source)));
      if (/^partner\.[a-z][a-z0-9_.-]+$/.test(value)) {
        add("role-authority", `capability:${value}`, node, { roleKind: "capability-consumer", declaration: ownerName });
      } else if (
        /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) &&
        ((partnerSurface &&
          /^(?:OWNER|ADMIN|GRADER|STAFF|SCANNER_OPERATOR|PARTNER_[A-Z0-9_]+|MVGS_ASSESSMENT_TECHNICIAN)$/.test(
            value
          )) ||
          roleContext)
      ) {
        add("role-authority", `role:${value}`, node, { roleKind: "definition-or-mapping", declaration: ownerName });
      }
      for (const currency of currencyValues(value))
        add("pricing-authority", `literal:${currency}`, node, { pricingKind: "currency-bearing-literal" });
      if (/\/(?:pricing|service-tiers|quote|create-payment-intent)(?:\/|$)/.test(value)) {
        add("pricing-authority", `endpoint:${value}`, node, { pricingKind: "transport" });
      }
    }
    if (ts.isImportSpecifier(node) && /(?:price|pricing|tier|discount|fee|amount|turnaround)/i.test(node.name.text)) {
      add("pricing-authority", `import:${node.name.text}`, node, { pricingKind: "projection-import" });
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
      node.name &&
      /(?:price|pricing|amount|cost|turnaround|discount|fee)/i.test(node.name.getText(source))
    ) {
      const initializer = node.initializer;
      add("pricing-authority", `value:${node.name.getText(source)}`, node, {
        pricingKind: "source-or-projection",
        expression: initializer ? expressionText(initializer, source) : "type-only",
      });
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "queryKey") {
      const key = expressionText(node.initializer, source);
      const firstKey = firstStaticQueryKey(node.initializer, model);
      const explicitPublic =
        adminCacheAuthority.configured && (firstKey === "public" || adminCacheAuthority.publicQueryKeys.has(firstKey));
      add("session-principal", `cache-key:${key}`, node, {
        keyAuthority: principalKeyAuthority(node.initializer),
        principalBinding: hasPrincipalExpression(node.initializer)
          ? "declared-in-key"
          : "principal-not-declared-in-key",
        ...(adminCacheAuthority.configured
          ? {
              adminCacheScope: explicitPublic ? "explicit-public-shared" : "principal-partitioned-when-admin-active",
              cacheClassificationAuthority: `${adminCacheAuthority.declaration.file}#${adminCacheAuthority.declaration.classifier}`,
              cacheHashAuthority: `${adminCacheAuthority.declaration.file}#${adminCacheAuthority.declaration.hash}`,
              runtimePrincipalBinding: explicitPublic
                ? "none-public-shared"
                : adminCacheAuthority.declaration.principalFields.join("+"),
            }
          : {}),
      });
    }
    if (ts.isJsxText(node)) {
      const value = node.text.replace(/\s+/g, " ").trim();
      for (const currency of currencyValues(value))
        add("pricing-authority", `literal:${currency}`, node, { pricingKind: "currency-bearing-jsx" });
    }
    if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
      const siblings = node.parent.children;
      const index = siblings.indexOf(node);
      const previous = index > 0 ? siblings[index - 1] : null;
      const currencyPrefix =
        previous && ts.isJsxText(previous) ? previous.text.match(/(?:£|\$|GBP|USD)\s*$/i)?.[0] : null;
      if (currencyPrefix) {
        const expression = expressionText(node.expression, source);
        add("pricing-authority", `projection:${currencyPrefix.trim()}:${expression}`, node, {
          pricingKind: "currency-bearing-jsx-expression",
          expression,
        });
      }
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      /(?:Session|Auth)(?:Provider|Context|Store|Manager|Authority)$/.test(node.name.getText(source))
    ) {
      add("session-principal", `provider:${node.name.getText(source)}`, node, { principalKind: "provider-definition" });
    }
    if (ts.isJsxOpeningLikeElement(node)) {
      const tag = node.tagName.getText(source);
      if (/(?:Session|Auth)(?:Provider|Context)$/.test(tag)) {
        add("session-principal", `provider-use:${tag}`, node, { principalKind: "provider-consumer" });
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const text = node.getText(source);
      const match = text.match(/(?:req|request)\.session\.([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (match) {
        add("session-principal", `server-session:${match[1]}`, node, { principalKind: "session-field" });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return records;
}

function scanComponents(root, files, policy) {
  const leafFiles = files.filter(
    (file) => file.startsWith("config/components/") && file.endsWith(".ts") && !file.endsWith("/index.ts")
  );
  const indexFile = policy.componentIndex ?? "config/components/index.ts";
  const indexSource = ts.createSourceFile(
    indexFile,
    readFileSync(join(root, indexFile), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const indexImports = new Map();
  for (const statement of indexSource.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith("./")
    ) {
      const target = `config/components/${statement.moduleSpecifier.text.slice(2)}.ts`;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          indexImports.set(element.name.text, {
            imported: element.propertyName?.text ?? element.name.text,
            target,
          });
        }
      }
    }
  }
  const violations = [];
  const discovered = [...leafFiles].sort();
  const indexDeclaration = indexSource.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "COMPONENT_READINESS_MANIFESTS"
    );
  let indexArray = unwrap(indexDeclaration?.initializer);
  if (
    indexArray &&
    ts.isCallExpression(indexArray) &&
    ts.isPropertyAccessExpression(indexArray.expression) &&
    indexArray.expression.getText(indexSource) === "Object.freeze"
  ) {
    indexArray = unwrap(indexArray.arguments[0]);
  }
  const indexMembers = ts.isArrayLiteralExpression(indexArray) ? [...indexArray.elements] : [];
  const listed = indexMembers
    .map((member) => (ts.isIdentifier(member) ? indexImports.get(member.text)?.target : undefined))
    .filter(Boolean)
    .sort();
  if (!indexDeclaration || !ts.isArrayLiteralExpression(indexArray) || listed.length !== indexMembers.length) {
    violations.push({
      code: "COMPONENT_INDEX_DRIFT",
      source: `${indexFile}:1`,
      target: "COMPONENT_READINESS_MANIFESTS must be a literal array of imported component manifests",
    });
  }
  if (new Set(listed).size !== listed.length) {
    violations.push({ code: "COMPONENT_INDEX_DRIFT", source: `${indexFile}:1`, target: "duplicate array member" });
  }
  if (JSON.stringify(discovered) !== JSON.stringify(listed)) {
    violations.push({
      code: "COMPONENT_INDEX_DRIFT",
      source: `${indexFile}:1`,
      target: JSON.stringify({ discovered, arrayMembers: listed }),
    });
  }
  const records = [];
  const requiredMigrations = [];
  const requiredRelations = [];
  const components = [];
  for (const file of discovered) {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const variableStatements = source.statements.filter(ts.isVariableStatement);
    const declaration = variableStatements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((item) => item.initializer);
    const statement = declaration?.parent?.parent;
    const exportName = ts.isIdentifier(declaration?.name) ? declaration.name.text : null;
    const dataOnly =
      source.statements.length === 1 &&
      variableStatements.length === 1 &&
      variableStatements[0].declarationList.declarations.length === 1 &&
      variableStatements[0].declarationList.flags & ts.NodeFlags.Const &&
      statement?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!dataOnly) {
      violations.push({
        code: "COMPONENT_MANIFEST_NOT_DATA_ONLY",
        source: `${file}:1`,
        target: "component files may contain only one exported const object",
      });
    }
    const matchingImport = [...indexImports.values()].find((item) => item.target === file);
    if (!matchingImport || matchingImport.imported !== exportName) {
      violations.push({
        code: "COMPONENT_INDEX_DRIFT",
        source: `${indexFile}:1`,
        target: `${file} export/import binding mismatch`,
      });
    }
    const component = declaration ? astValue(declaration.initializer, source) : undefined;
    violations.push(...componentViolations(component, file));
    for (const sourceRoot of Array.isArray(component?.sourceRoots) ? component.sourceRoots : [])
      if (!files.some((candidate) => matchesSourceRoot(candidate, sourceRoot))) {
        violations.push({
          code: "COMPONENT_SOURCE_ROOT_EMPTY",
          source: `${file}:1`,
          target: sourceRoot,
        });
      }
    const id = typeof component?.id === "string" ? component.id : file.split("/").at(-1).replace(/\.ts$/, "");
    records.push({
      category: "component",
      id,
      file,
      line: 1,
      explicitOwner: typeof component?.owner === "string" ? component.owner : undefined,
      releaseMode: component?.releaseMode ?? "invalid",
      runtimeState: component?.runtimeState ?? "invalid",
      sourceRoots: component?.sourceRoots ?? [],
    });
    components.push(component);
    const authority = (policy.componentAuthorities ?? []).find((item) => item.id === component?.id);
    if (
      !authority ||
      authority.owner !== component?.owner ||
      JSON.stringify(authority.sourceRoots) !== JSON.stringify(component?.sourceRoots)
    ) {
      violations.push({
        code: "COMPONENT_AUTHORITY_DRIFT",
        source: `${file}:1`,
        target: component?.id ?? file,
      });
    }
    if (component?.releaseMode === "required") {
      for (const item of component.requirements?.migrations ?? [])
        if (typeof item?.name === "string") requiredMigrations.push({ name: item.name, estate: item.estate ?? "main" });
      for (const item of component.requirements?.relations ?? [])
        if (typeof item?.name === "string") requiredRelations.push(item.name);
    }
  }
  const ids = records.map((record) => record.id);
  for (const id of new Set(ids))
    if (ids.filter((candidate) => candidate === id).length > 1) {
      violations.push({ code: "DUPLICATE_COMPONENT_ID", source: "config/components", target: id });
    }
  const declaredAuthorities = [...(policy.componentAuthorities ?? [])].map((item) => item.id).sort();
  if (JSON.stringify([...ids].sort()) !== JSON.stringify(declaredAuthorities)) {
    violations.push({
      code: "COMPONENT_AUTHORITY_DRIFT",
      source: "scripts/architecture/authority-policy.json:1",
      target: "component authority IDs differ from component manifests",
    });
  }

  const registryFile = "server/lib/component-readiness-registry.ts";
  const registryText = readFileSync(join(root, registryFile), "utf8");
  const consumesCanonicalIndex =
    /import\s*\{[^}]*\bCOMPONENT_READINESS_MANIFESTS\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/config\/components["']/.test(
      registryText
    ) &&
    /COMPONENT_READINESS_REGISTRY\s*=\s*compileComponentReadinessRegistry\(COMPONENT_READINESS_MANIFESTS\)/.test(
      registryText
    );
  if (!consumesCanonicalIndex) {
    violations.push({
      code: "COMPONENT_RUNTIME_INDEX_DRIFT",
      source: `${registryFile}:1`,
      target: "runtime registry must compile the canonical component index directly",
    });
  }
  const declaredSignals = components
    .flatMap((component) => component?.requirements?.runtimeSignals ?? [])
    .map((item) => item.name)
    .sort();
  const readinessText = readFileSync(join(root, "server/readiness.ts"), "utf8");
  const consumedSignals = [
    ...new Set(
      [...readinessText.matchAll(/COMPONENT_READINESS_REGISTRY\.runtimeSignals\.([a-z_][a-z0-9_]*)/g)].map(
        (match) => match[1]
      )
    ),
  ].sort();
  if (JSON.stringify(declaredSignals) !== JSON.stringify(consumedSignals)) {
    violations.push({
      code: "COMPONENT_RUNTIME_SIGNAL_DRIFT",
      source: "server/readiness.ts:1",
      target: JSON.stringify({ declaredSignals, consumedSignals }),
    });
  }
  return { records, components, requiredMigrations, requiredRelations, violations };
}

function schemaInventoryRecords(root, files) {
  const file = "scripts/db/schema-registry.ts";
  if (!files.includes(file)) return [];
  const source = ts.createSourceFile(
    file,
    readFileSync(join(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const records = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const value = astValue(node, source);
      if (
        typeof value?.name === "string" &&
        typeof value?.objectType === "string" &&
        typeof value?.owningSubsystem === "string"
      ) {
        records.push({
          category: value.objectType === "table" ? "table" : "schema-object",
          id: `${value.schema ?? "public"}.${value.name}`,
          file,
          line: lineOf(source, node),
          explicitOwner: value.owningSubsystem.replace(/[^a-z0-9-]+/gi, "-").toLowerCase(),
          authority: `classified-${value.objectType}`,
          active: value.active,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return records;
}

function parameterIndexForExpression(node, model, context, seen = new Set()) {
  node = unwrap(node);
  if (!node || !ts.isIdentifier(node)) return -1;
  const marker = `${model.file}#${context}#parameter#${node.text}`;
  if (seen.has(marker)) return -1;
  const fn = model.functions.get(context);
  const direct = [...(fn?.parameters ?? [])].findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === node.text
  );
  if (direct >= 0) return direct;
  const initializer = lexicalInitializer(model, node.text, node);
  return initializer ? parameterIndexForExpression(initializer, model, context, new Set(seen).add(marker)) : -1;
}

function optionPropertyParameterIndex(options, propertyName, model, context) {
  const direct = parameterIndexForExpression(options, model, context);
  if (direct >= 0) return direct;
  const object = resolvedExpressionNode(options, model, context);
  if (!object || !ts.isObjectLiteralExpression(object)) return -1;
  let authority = -1;
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      authority = parameterIndexForExpression(member.expression, model, context);
      continue;
    }
    if (
      (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
      member.name.text === propertyName
    ) {
      authority = -1;
    }
  }
  return authority;
}

function enrichHttpProviderCallsites(records, calls, models) {
  for (const record of records.filter((item) => item.effect === "http-fetch" && item._fetchUrlNode)) {
    const separator = record._context.lastIndexOf("#");
    const targetFile = record._context.slice(0, separator);
    const targetContext = record._context.slice(separator + 1);
    const targetModel = models.get(targetFile);
    const targetFunction = targetModel?.functions.get(targetContext);
    if (!targetModel || !targetFunction) continue;
    const optionParameterIndexes = Object.fromEntries(
      ["method", "signal", "headers"].map((name) => [
        name,
        optionPropertyParameterIndex(record._fetchOptionsNode, name, targetModel, targetContext),
      ])
    );
    const callsiteAuthorities = [];
    for (const call of calls.filter((item) => item.targetContext === record._context)) {
      const callerModel = models.get(call.file);
      if (!callerModel) continue;
      const targetBindings = new Map();
      targetFunction.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) return;
        const argument = call.arguments[index];
        const value = argument
          ? evaluate(argument, callerModel, call.callerContext, models, call.bindings)
          : parameter.initializer
            ? evaluate(parameter.initializer, targetModel, targetContext, models, targetBindings)
            : null;
        targetBindings.set(parameter.name.text, value);
      });
      const callsiteOptions = fetchOptionFacts(
        record._fetchOptionsNode,
        targetModel,
        targetContext,
        models,
        targetBindings
      );
      const parameterAuthorities = {};
      const parameterFacts = new Map();
      for (const index of new Set(Object.values(optionParameterIndexes).filter((value) => value >= 0))) {
        const argument = call.arguments[index];
        if (!argument) continue;
        parameterFacts.set(index, fetchOptionFacts(argument, callerModel, call.callerContext, models, call.bindings));
        parameterAuthorities[index] = symbolicAuthority(
          argument,
          callerModel,
          call.callerContext,
          models,
          call.bindings
        );
      }
      if (parameterFacts.has(optionParameterIndexes.method)) {
        callsiteOptions.httpMethod = parameterFacts.get(optionParameterIndexes.method).httpMethod;
      }
      if (parameterFacts.has(optionParameterIndexes.signal)) {
        callsiteOptions.timeoutSignal = parameterFacts.get(optionParameterIndexes.signal).timeoutSignal;
      }
      if (parameterFacts.has(optionParameterIndexes.headers)) {
        callsiteOptions.idempotencyEvidence = parameterFacts.get(optionParameterIndexes.headers).idempotencyEvidence;
      }
      if (Object.keys(parameterAuthorities).length) {
        callsiteOptions.parameterOptionsAuthority = parameterAuthorities;
      }
      callsiteAuthorities.push({
        source: `${call.file}:${call.line}`,
        urlAuthority: symbolicAuthority(record._fetchUrlNode, targetModel, targetContext, models, targetBindings),
        ...callsiteOptions,
      });
    }
    if (callsiteAuthorities.length) {
      record.callsiteAuthorities = callsiteAuthorities.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
    }
  }
}

function matchesSourceRoot(file, sourceRoot) {
  return sourceRoot.endsWith("/") ? file.startsWith(sourceRoot) : file === sourceRoot;
}

function componentAuthorityFor(file, policy) {
  return (policy.componentAuthorities ?? []).filter((component) =>
    component.sourceRoots.some((sourceRoot) => matchesSourceRoot(file, sourceRoot))
  );
}

function assignKeysAndOwnership(records, policy, legacyEntries) {
  const ordinals = new Map();
  for (const item of records.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.category.localeCompare(b.category) ||
      a.id.localeCompare(b.id)
  )) {
    const base = `${item.category}|${item.file}|${item.id}`;
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    item.key = `${base}#${ordinal}`;
    item.source = `${item.file}:${item.line}`;
    const rule = policy.ownerRules.find((candidate) => item.file.startsWith(candidate.prefix));
    const componentAuthority = componentAuthorityFor(item.file, policy)[0];
    if (item.explicitOwner) item.owner = item.explicitOwner;
    else if (item.explicitDisposition) item.disposition = item.explicitDisposition;
    else if (componentAuthority) item.owner = componentAuthority.owner;
    else if (rule?.owner) item.owner = rule.owner;
    else if (rule?.disposition) {
      item.disposition = rule.disposition;
      item.finding = rule.finding;
    } else if (legacyEntries.has(item.key)) {
      const legacy = legacyEntries.get(item.key);
      item.disposition = "known-legacy";
      item.finding = legacy.finding;
      item.legacyExpiry = legacy.expiresWith;
    } else item.disposition = "unowned";
    delete item.file;
    delete item.line;
    delete item.explicitOwner;
    delete item.explicitDisposition;
  }
  records.sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
}

function readLegacyAuthority(root, policy) {
  const entries = new Map();
  const violations = [];
  if (!policy.legacyAuthority || !existsSync(join(root, policy.legacyAuthority))) return { entries, violations };
  let document;
  try {
    document = JSON.parse(readFileSync(join(root, policy.legacyAuthority), "utf8"));
  } catch {
    return {
      entries,
      violations: [
        {
          code: "MALFORMED_LEGACY_AUTHORITY",
          source: policy.legacyAuthority,
          target: "invalid JSON",
        },
      ],
    };
  }
  if (
    !exactKeys(document, ["schemaVersion", "records"]) ||
    document.schemaVersion !== 1 ||
    !Array.isArray(document.records)
  ) {
    violations.push({
      code: "MALFORMED_LEGACY_AUTHORITY",
      source: policy.legacyAuthority,
      target: "document must be schemaVersion 1 with an exact records array",
    });
    return { entries, violations };
  }
  for (const [index, entry] of document.records.entries()) {
    const valid =
      exactKeys(entry, ["key", "finding", "expiresWith"]) &&
      typeof entry.key === "string" &&
      entry.key.trim() !== "" &&
      entry.finding === "ARCH-AUTHORITY-001" &&
      typeof entry.expiresWith === "string" &&
      entry.expiresWith.trim() !== "";
    if (!valid || entries.has(entry?.key)) {
      violations.push({
        code: "MALFORMED_LEGACY_AUTHORITY",
        source: policy.legacyAuthority,
        target: `record ${index}`,
      });
      continue;
    }
    entries.set(entry.key, entry);
  }
  return { entries, violations };
}

export function buildArchitectureSnapshot(root, policy) {
  const files = architectureFiles(root, policy.scanRoots);
  const fileSet = new Set(files);
  const models = makeModels(root, fileSet, policy);
  propagateExpressReceivers(models);
  const records = [];
  const routes = [];
  const mounts = [];
  const middlewares = [];
  const calls = [];
  const runtimeDependencies = [];
  const violations = [];
  const configuredRoots = new Set(
    (policy.applicationRoots ?? []).map((item) => `${item.file}#${item.context}:${item.receiver}`)
  );
  const observedRoots = new Set();
  for (const model of models.values())
    for (const [context, receivers] of model.rootReceivers)
      for (const receiver of receivers) observedRoots.add(`${model.file}#${context}:${receiver}`);
  for (const rootId of configuredRoots)
    if (!observedRoots.has(rootId)) {
      violations.push({
        code: "APPLICATION_ROOT_DRIFT",
        source: "scripts/architecture/authority-policy.json:1",
        target: rootId,
      });
    }
  const adminCacheAuthority = readAdminCacheAuthority(models, policy);
  violations.push(...adminCacheAuthority.violations);
  for (const model of models.values()) {
    if (model.file.startsWith("config/components/")) continue;
    const result = scanModel(root, model, models, policy);
    records.push(...result.records);
    records.push(...semanticAuthorityRecords(model, adminCacheAuthority));
    routes.push(...result.routes);
    mounts.push(...result.mounts);
    middlewares.push(...result.middlewares);
    calls.push(...result.calls);
    runtimeDependencies.push(...result.runtimeDependencies);
    violations.push(...result.violations);
  }
  enrichHttpProviderCallsites(records, calls, models);
  const issueFiles = [
    "engineering/ISSUE_REGISTER.md",
    ".claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/issue-register.md",
  ].filter((file) => existsSync(join(root, file)));
  const issueEntries = issueFiles.flatMap((file) =>
    readFileSync(join(root, file), "utf8")
      .split(/\r?\n/)
      .filter((line) => /^\s*\|/.test(line))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim().replace(/^`|`$/g, ""))
      )
      .filter((cells) => cells.length >= 3)
      .map((cells) => ({ id: cells[0], status: cells[2], file }))
  );
  const terminalIssueStatus = (status) => /\b(?:CLOSED|PROVEN|REJECTED)\b/.test(status);
  function activeIssueFinding(id) {
    const entries = issueEntries.filter((entry) => entry.id === id);
    if (entries.length === 0) return false;
    const canonical = entries.filter((entry) => entry.file === "engineering/ISSUE_REGISTER.md");
    if (new Set(entries.map((entry) => terminalIssueStatus(entry.status))).size > 1) return false;
    return (canonical.length ? canonical : entries).every((entry) => !terminalIssueStatus(entry.status));
  }
  for (const exception of policy.runtimeImportExceptions ?? []) {
    const matches = records.filter(
      (record) =>
        record.category === "layer-exception" &&
        record.file === exception.source &&
        record.finding === exception.finding &&
        record.target.replace(/[.][^./]+$/, "") === exception.target
    );
    if (matches.length !== 1) {
      violations.push({
        code: "STALE_OR_DUPLICATE_LAYER_EXCEPTION",
        source: "scripts/architecture/authority-policy.json:1",
        target: `${exception.source}->${exception.target}:${matches.length}`,
      });
    }
    if (!activeIssueFinding(exception.finding)) {
      violations.push({
        code: "INVALID_LAYER_EXCEPTION_FINDING",
        source: "scripts/architecture/authority-policy.json:1",
        target: exception.finding,
      });
    }
  }
  const composedRoutes = routeRecords(routes, mounts, middlewares);
  records.push(...composedRoutes.records);
  violations.push(...composedRoutes.violations);
  records.push(...schemaInventoryRecords(root, files));

  const components = scanComponents(root, files, policy);
  records.push(...components.records);
  violations.push(...components.violations);

  for (const file of files) {
    const componentMatches = componentAuthorityFor(file, policy);
    if (componentMatches.length > 1) {
      violations.push({
        code: "OVERLAPPING_COMPONENT_SOURCE_ROOT",
        source: file,
        target: componentMatches
          .map((component) => component.id)
          .sort()
          .join(","),
      });
    }
    const rule = policy.ownerRules.find((candidate) => file.startsWith(candidate.prefix));
    if (componentMatches.length === 1 && rule?.owner && rule.owner !== componentMatches[0].owner) {
      violations.push({
        code: "COMPONENT_OWNER_POLICY_MISMATCH",
        source: file,
        target: `${componentMatches[0].owner} != ${rule.owner}`,
      });
    }
  }

  const shippedMigrations = new Set();
  const migrationNumbers = new Map();
  for (const file of files.filter(
    (item) => (item.startsWith("migrations/") || item.startsWith("migrations-vq/")) && item.endsWith(".sql")
  )) {
    const name = file.split("/").at(-1);
    const sqlSource = readFileSync(join(root, file), "utf8");
    const match = name.match(MIGRATION_FILE_RE);
    let shippingDisposition = "legacy-forward-unshipped";
    let lineage = "excluded-from-numbered-runner";
    if (file.startsWith("migrations-vq/")) {
      shippingDisposition = "unshipped-owner-decision-required";
      lineage = "hand-applied-raw-sql-owner-decision";
    } else if (match) {
      shippingDisposition = "shipped-numbered";
      lineage = "main-numbered-runner";
      shippedMigrations.add(`main:${name}`);
      const normalizedNumber = BigInt(match[1]).toString();
      if (!migrationNumbers.has(normalizedNumber)) migrationNumbers.set(normalizedNumber, []);
      migrationNumbers.get(normalizedNumber).push(name);
    } else if (/^(?:_?rollback[-_])/.test(name)) shippingDisposition = "rollback-only";
    records.push({
      category: "migration",
      id: name,
      file,
      line: 1,
      shippingDisposition,
      lineage,
      migrationNumber: match ? BigInt(match[1]).toString() : null,
      sha256: createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex"),
    });
    for (const table of sqlSource.matchAll(
      /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z_][a-z0-9_]*)/gi
    )) {
      records.push({
        category: "table",
        id: `public.${table[1].toLowerCase()}`,
        file,
        line: sqlSource.slice(0, table.index).split(/\r?\n/).length,
        authority: "migration-ddl",
      });
    }
  }
  for (const [number, names] of migrationNumbers)
    if (names.length > 1) {
      violations.push({
        code: "DUPLICATE_MIGRATION_NUMBER",
        source: "migrations",
        target: `${number}:${names.sort().join(",")}`,
      });
    }
  const lineageFile = "migrations/lineage-exclusions.json";
  if (files.includes(lineageFile)) {
    const lineageText = readFileSync(join(root, lineageFile), "utf8");
    let declarations;
    try {
      declarations = JSON.parse(lineageText);
    } catch {
      declarations = null;
    }
    records.push({
      category: "migration-lineage",
      id: "lineage-exclusions",
      file: lineageFile,
      line: 1,
      sha256: createHash("sha256").update(lineageText).digest("hex"),
      declarationCount: Array.isArray(declarations) ? declarations.length : null,
    });
    const seenPairs = new Set();
    if (!Array.isArray(declarations)) {
      violations.push({
        code: "MALFORMED_MIGRATION_LINEAGE",
        source: `${lineageFile}:1`,
        target: "JSON array required",
      });
    } else {
      for (const [index, declaration] of declarations.entries()) {
        const exact = exactKeys(declaration, ["incoming", "occupant", "supersededBy", "reason"]);
        const incoming =
          typeof declaration?.incoming === "string" ? declaration.incoming.match(MIGRATION_FILE_RE) : null;
        const occupant =
          typeof declaration?.occupant === "string" ? declaration.occupant.match(MIGRATION_FILE_RE) : null;
        const supersededBy = typeof declaration?.supersededBy === "string" ? declaration.supersededBy : "";
        const pair = `${declaration?.incoming ?? "?"}|${declaration?.occupant ?? "?"}`;
        if (
          !exact ||
          !incoming ||
          !occupant ||
          incoming[1] !== occupant[1] ||
          declaration.incoming === declaration.occupant ||
          typeof declaration.reason !== "string" ||
          declaration.reason.trim() === "" ||
          !shippedMigrations.has(`main:${declaration.incoming}`) ||
          !shippedMigrations.has(`main:${supersededBy}`) ||
          seenPairs.has(pair)
        ) {
          violations.push({
            code: "MALFORMED_MIGRATION_LINEAGE",
            source: `${lineageFile}:${index + 1}`,
            target: pair,
          });
        }
        seenPairs.add(pair);
        records.push({
          category: "migration-lineage",
          id: pair,
          file: lineageFile,
          line: index + 1,
          incoming: declaration?.incoming ?? null,
          occupant: declaration?.occupant ?? null,
          supersededBy: declaration?.supersededBy ?? null,
        });
      }
    }
  }
  const requiredMigrationKeys = new Set();
  for (const migration of components.requiredMigrations) {
    const key = `${migration.estate}:${migration.name}`;
    const target = migration.estate === "main" ? migration.name : key;
    if (requiredMigrationKeys.has(key)) {
      violations.push({ code: "DUPLICATE_REQUIRED_MIGRATION", source: "config/components", target });
    }
    requiredMigrationKeys.add(key);
    if (!shippedMigrations.has(key)) {
      violations.push({ code: "MISSING_REQUIRED_MIGRATION", source: "config/components", target });
    }
  }

  const authorityTables = new Set(records.filter((item) => item.category === "table").map((item) => item.id));
  for (const relation of new Set(components.requiredRelations))
    if (!authorityTables.has(relation)) {
      violations.push({ code: "MISSING_REQUIRED_RELATION_AUTHORITY", source: "config/components", target: relation });
    }

  const legacyAuthority = readLegacyAuthority(root, policy);
  violations.push(...legacyAuthority.violations);
  const exactLegacyEntries = legacyAuthority.entries;
  if (exactLegacyEntries.size > 0 && !activeIssueFinding("ARCH-AUTHORITY-001")) {
    violations.push({
      code: "INVALID_LEGACY_AUTHORITY_FINDING",
      source: policy.legacyAuthority,
      target: "ARCH-AUTHORITY-001",
    });
  }
  assignKeysAndOwnership(records, policy, exactLegacyEntries);
  const activeLegacyKeys = new Set(
    records.filter((entry) => entry.disposition === "known-legacy").map((entry) => entry.key)
  );
  for (const key of exactLegacyEntries.keys())
    if (!activeLegacyKeys.has(key)) {
      violations.push({
        code: "OBSOLETE_LEGACY_AUTHORITY",
        source: policy.legacyAuthority,
        target: key,
      });
    }
  for (const entry of records.filter((item) => item.disposition === "unowned")) {
    violations.push({ code: "UNOWNED_TOPOLOGY", source: entry.source, target: entry.key });
  }
  for (const component of components.components.filter((item) => item?.runtimeState === "disabled")) {
    for (const entry of records)
      if (
        [
          "server-route",
          "client-route",
          "route-mount",
          "job",
          "timer",
          "object-writer",
          "provider-adapter",
          "table-access",
        ].includes(entry.category) &&
        component.sourceRoots.some(
          (sourceRoot) =>
            matchesSourceRoot(entry.source.replace(/:\d+$/, ""), sourceRoot) ||
            (entry._componentSourcePaths ?? []).some((componentPath) => matchesSourceRoot(componentPath, sourceRoot))
        )
      ) {
        violations.push({
          code: "DISABLED_COMPONENT_TOPOLOGY",
          source: entry.source,
          target: `${component.id}:${entry.key}`,
        });
      }
    const disabledTargets = (target) =>
      component.sourceRoots.some((sourceRoot) => matchesSourceRoot(target, sourceRoot));
    const sourceIsDisabled = (source) =>
      components.components
        .filter((item) => item?.runtimeState === "disabled")
        .some((item) => item.sourceRoots.some((sourceRoot) => matchesSourceRoot(source, sourceRoot)));
    const seenEdges = new Set();
    for (const edge of [
      ...runtimeDependencies,
      ...calls.map((call) => ({
        source: call.file,
        target: call.targetContext.slice(0, call.targetContext.lastIndexOf("#")),
        kind: "call",
        line: call.line,
      })),
    ]) {
      if (!disabledTargets(edge.target) || sourceIsDisabled(edge.source)) continue;
      const edgeKey = `${edge.source}:${edge.line}->${edge.target}:${edge.kind}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      violations.push({
        code: "DISABLED_COMPONENT_RUNTIME_EDGE",
        source: `${edge.source}:${edge.line}`,
        target: `${component.id}:${edge.kind}:${edge.target}`,
      });
    }
  }
  const effects = records.filter(
    (item) => ["provider-adapter", "object-writer"].includes(item.category) && Number.isSafeInteger(item._position)
  );
  for (const route of records.filter((item) => item.category === "server-route")) {
    const routeFile = route.source.replace(/:\d+$/, "");
    route.commandOwner = route.handlerContext;
    const directEffects = effects.filter(
      (effect) =>
        effect.source.replace(/:\d+$/, "") === routeFile &&
        route._handlerRanges.some(([start, end]) => effect._position >= start && effect._position <= end)
    );
    const delegatedContexts = new Set(route._delegatedHandlerContexts ?? []);
    for (const call of calls) {
      if (
        call.file === routeFile &&
        route._handlerRanges.some(([start, end]) => call.position >= start && call.position <= end)
      ) {
        delegatedContexts.add(call.targetContext);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const call of calls)
        if (delegatedContexts.has(call.sourceContext) && !delegatedContexts.has(call.targetContext)) {
          delegatedContexts.add(call.targetContext);
          changed = true;
        }
    }
    const delegatedEffects = effects.filter((effect) => delegatedContexts.has(effect._context));
    route.delegatedCommands = [...delegatedContexts].sort();
    route.providerEffects = [
      ...new Set([...directEffects, ...delegatedEffects].map((effect) => `${effect.category}:${effect.id}`)),
    ].sort();
    if (route.providerEffects.length === 0) route.providerEffects = ["delegated-or-none"];
  }
  for (const entry of records) {
    delete entry._position;
    delete entry._context;
    delete entry._handlerRanges;
    delete entry._delegatedHandlerContexts;
    delete entry._componentSourcePaths;
    delete entry._fetchUrlNode;
    delete entry._fetchOptionsNode;
  }
  violations.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.code.localeCompare(b.code) ||
      String(a.target).localeCompare(String(b.target))
  );
  const categories = [...new Set(records.map((entry) => entry.category))].sort();
  const counts = Object.fromEntries(
    categories.map((category) => [category, records.filter((entry) => entry.category === category).length])
  );
  return { schemaVersion: 2, counts, records, violations };
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function structural(record) {
  const copy = { ...record };
  delete copy.source;
  return copy;
}

export function compareSnapshot(expected, actual) {
  if (actual.violations.length) return { ok: false, reason: "violations", details: actual.violations };
  const before = new Map(expected.records.map((item) => [item.key, structural(item)]));
  const after = new Map(actual.records.map((item) => [item.key, structural(item)]));
  const added = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort();
  const changed = [...after.keys()]
    .filter((key) => before.has(key) && stableJson(before.get(key)) !== stableJson(after.get(key)))
    .sort();
  const countsChanged = stableJson(expected.counts) !== stableJson(actual.counts);
  return {
    ok: added.length === 0 && removed.length === 0 && changed.length === 0 && !countsChanged,
    reason: "topology-drift",
    details: { added, removed, changed, countsChanged },
  };
}

function printDetails(details) {
  if (Array.isArray(details)) {
    for (const item of details.slice(0, 40)) console.error(`${item.code} ${item.source} ${item.target}`);
    return;
  }
  for (const key of ["added", "removed", "changed"]) {
    if (details[key]?.length)
      console.error(
        `${key}:\n${details[key]
          .slice(0, 40)
          .map((item) => `  ${item}`)
          .join("\n")}`
      );
  }
  if (details.countsChanged) console.error("category counts changed");
}

function runCli() {
  const root = resolve(process.cwd());
  const policy = JSON.parse(readFileSync(join(root, "scripts/architecture/authority-policy.json"), "utf8"));
  let snapshot = buildArchitectureSnapshot(root, policy);
  if (process.argv.includes("--adopt-unowned")) {
    const current = existsSync(join(root, policy.legacyAuthority))
      ? JSON.parse(readFileSync(join(root, policy.legacyAuthority), "utf8"))
      : { schemaVersion: 1, records: [] };
    const exercisedLegacyKeys = new Set(
      snapshot.records.filter((item) => item.disposition === "known-legacy").map((item) => item.key)
    );
    const existing = new Map(
      current.records.filter((item) => exercisedLegacyKeys.has(item.key)).map((item) => [item.key, item])
    );
    for (const entry of snapshot.records.filter((item) => item.disposition === "unowned")) {
      existing.set(entry.key, {
        key: entry.key,
        finding: "ARCH-AUTHORITY-001",
        expiresWith: "the bounded-context repair that assigns explicit authority",
      });
    }
    mkdirSync(dirname(join(root, policy.legacyAuthority)), { recursive: true });
    writeFileSync(
      join(root, policy.legacyAuthority),
      stableJson({ schemaVersion: 1, records: [...existing.values()].sort((a, b) => a.key.localeCompare(b.key)) })
    );
    console.log(`adopted ${existing.size} exact legacy topology keys after explicit review`);
    snapshot = buildArchitectureSnapshot(root, policy);
  }
  if (snapshot.violations.length) {
    console.error("architecture authority violations:");
    printDetails(snapshot.violations);
    process.exitCode = 1;
    return;
  }
  const snapshotPath = join(root, policy.snapshot);
  if (process.argv.includes("--write")) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, stableJson(snapshot));
    console.log(`architecture authority snapshot updated: ${policy.snapshot}`);
    console.log(JSON.stringify(snapshot.counts));
    return;
  }
  if (!existsSync(snapshotPath)) {
    console.error(`architecture authority snapshot missing: ${policy.snapshot}`);
    process.exitCode = 1;
    return;
  }
  const comparison = compareSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")), snapshot);
  if (!comparison.ok) {
    console.error(`architecture authority check failed: ${comparison.reason}`);
    printDetails(comparison.details);
    process.exitCode = 1;
    return;
  }
  console.log(`architecture authority check passed: ${snapshot.records.length} topology records`);
  console.log(JSON.stringify(snapshot.counts));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
