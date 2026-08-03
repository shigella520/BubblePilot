import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parse } from "yaml";

const contractPath = "contracts/openapi.yaml";
const applicationSource = await readFile("app/application.ts", "utf8");
const openApiSource = await readFile(contractPath, "utf8");

/**
 * @param {string} source
 * @returns {unknown}
 */
function parseYaml(source) {
  // The YAML package's legacy overload returns any; keep that boundary typed.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const parsed = parse(source);
  return /** @type {unknown} */ (parsed);
}

const document = parseYaml(openApiSource);
const methods = new Set(["get", "post", "put", "patch", "delete"]);
const errors = [];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} reference
 * @returns {unknown}
 */
function localReference(reference) {
  if (!reference.startsWith("#/")) return undefined;
  let value = document;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(value) || !(segment in value)) return undefined;
    value = value[segment];
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function resolvedParameter(value) {
  if (!isRecord(value)) return undefined;
  if (typeof value.$ref !== "string") return value;
  const resolved = localReference(value.$ref);
  return isRecord(resolved) ? resolved : undefined;
}

/** @type {Set<string>} */
const runtimeRoutes = new Set();
for (const match of applicationSource.matchAll(
  /application\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gu,
)) {
  const method = match[1];
  const path = match[2];
  if (method !== undefined && path !== undefined) {
    const route = `${method} ${path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, "{$1}")}`;
    if (runtimeRoutes.has(route))
      errors.push(`Duplicate runtime route: ${route}`);
    runtimeRoutes.add(route);
  }
}

if (!isRecord(document) || !isRecord(document.paths)) {
  throw new Error("The OpenAPI document does not define a paths object.");
}

/** @type {Set<string>} */
const contractRoutes = new Set();
/** @type {Set<string>} */
const operationIds = new Set();
for (const [path, pathItemValue] of Object.entries(document.paths)) {
  if (!isRecord(pathItemValue)) {
    errors.push(`OpenAPI path item is not an object: ${path}`);
    continue;
  }
  /** @type {unknown[]} */
  const pathParameters = Array.isArray(pathItemValue.parameters)
    ? pathItemValue.parameters
    : [];
  const expectedPathParameters = new Set(
    [...path.matchAll(/\{([^}]+)\}/gu)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );

  for (const [method, operationValue] of Object.entries(pathItemValue)) {
    if (!methods.has(method)) continue;
    const route = `${method} ${path}`;
    contractRoutes.add(route);
    if (!isRecord(operationValue)) {
      errors.push(`OpenAPI operation is not an object: ${route}`);
      continue;
    }

    const operationId = operationValue.operationId;
    if (typeof operationId !== "string" || operationId.length === 0) {
      errors.push(`Missing operationId: ${route}`);
    } else if (operationIds.has(operationId)) {
      errors.push(`Duplicate operationId '${operationId}': ${route}`);
    } else {
      operationIds.add(operationId);
    }

    const responses = operationValue.responses;
    if (
      !isRecord(responses) ||
      !Object.keys(responses).some((status) => /^2\d\d$/u.test(status))
    ) {
      errors.push(`Missing successful response: ${route}`);
    }

    /** @type {unknown[]} */
    const operationParameters = Array.isArray(operationValue.parameters)
      ? operationValue.parameters
      : [];
    /** @type {Array<{name: string, required: unknown}>} */
    const declaredPathParameters = [];
    for (const value of [...pathParameters, ...operationParameters]) {
      const parameter = resolvedParameter(value);
      if (
        parameter !== undefined &&
        parameter.in === "path" &&
        typeof parameter.name === "string"
      ) {
        declaredPathParameters.push({
          name: parameter.name,
          required: parameter.required,
        });
      }
    }
    const declaredNames = new Set(
      declaredPathParameters.map((parameter) => parameter.name),
    );
    for (const parameter of expectedPathParameters) {
      if (!declaredNames.has(parameter)) {
        errors.push(`Missing path parameter '${parameter}': ${route}`);
      }
    }
    for (const parameter of declaredPathParameters) {
      if (!expectedPathParameters.has(parameter.name)) {
        errors.push(`Unexpected path parameter '${parameter.name}': ${route}`);
      }
      if (parameter.required !== true) {
        errors.push(
          `Path parameter '${parameter.name}' is not required: ${route}`,
        );
      }
    }
  }
}

/** @type {Set<string>} */
const externalReferences = new Set();
/** @type {WeakSet<object>} */
const visited = new WeakSet();
/**
 * @param {unknown} value
 * @returns {void}
 */
function inspectReferences(value) {
  if (Array.isArray(value)) {
    for (const item of value) inspectReferences(item);
    return;
  }
  if (!isRecord(value) || visited.has(value)) return;
  visited.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && typeof item === "string") {
      if (item.startsWith("#/")) {
        if (localReference(item) === undefined) {
          errors.push(`Unresolved local OpenAPI reference: ${item}`);
        }
      } else {
        externalReferences.add(item.split("#", 1)[0] ?? item);
      }
    } else {
      inspectReferences(item);
    }
  }
}
inspectReferences(document);
for (const reference of externalReferences) {
  try {
    await access(resolve(dirname(contractPath), reference));
  } catch {
    errors.push(`Unresolved external OpenAPI reference: ${reference}`);
  }
}

for (const route of runtimeRoutes) {
  if (!contractRoutes.has(route)) errors.push(`Missing from OpenAPI: ${route}`);
}
for (const route of contractRoutes) {
  if (!runtimeRoutes.has(route)) errors.push(`Missing from runtime: ${route}`);
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `OpenAPI validates ${runtimeRoutes.size} runtime routes, ${operationIds.size} operation IDs and ${externalReferences.size} external references.\n`,
  );
}
