/**
 * Rewrites a program so its top-level bindings persist across runs and its last
 * expression becomes the result. The body is placed inside an async function, so
 * top-level `await` works. @module
 */
import { parse, type Node } from 'acorn';

export interface TransformedProgram {
  /** Function body text. Runs inside `async () => { ... }`. */
  readonly body: string;
  /** True when the last top-level statement is an expression whose value is returned. */
  readonly hasResult: boolean;
  /**
   * Lines the hoisted prefix adds before the user's first line. Each user line
   * keeps its original line number after this offset is removed.
   */
  readonly prefixLines: number;
}

function newlines(text: string): number {
  return text.split('\n').length - 1;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Thrown for code that is not valid in Code Mode. The message is shown to the model. */
export class ProgramError extends SyntaxError {
  constructor(message: string) {
    super(message);
    this.name = 'SyntaxError';
  }
}

type AnyNode = Node & { start: number; end: number; type: string; [key: string]: unknown };

/** Node types whose bodies are their own scope: a `var` inside does not reach the program. */
const SCOPE_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassDeclaration',
  'ClassExpression',
  'PropertyDefinition',
  'MethodDefinition',
]);

function isNode(value: unknown): value is AnyNode {
  return typeof value === 'object' && value !== null
    && typeof (value as AnyNode).type === 'string'
    && typeof (value as AnyNode).start === 'number';
}

/** Visits every node outside function and class scopes, with its parent. */
function walkNodes(node: AnyNode, visit: (node: AnyNode, parent: AnyNode | undefined) => void, parent?: AnyNode): void {
  visit(node, parent);
  if (SCOPE_NODES.has(node.type)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walkNodes(child, visit, node);
    } else if (isNode(value)) {
      walkNodes(value, visit, node);
    }
  }
}

/** Every identifier bound by a declaration pattern. */
function patternNames(node: AnyNode): string[] {
  switch (node.type) {
    case 'Identifier':
      return [node.name as string];
    case 'AssignmentPattern':
      return patternNames(node.left as AnyNode);
    case 'RestElement':
      return patternNames(node.argument as AnyNode);
    case 'ArrayPattern':
      return (node.elements as Array<AnyNode | null>).flatMap((element) => (element === null ? [] : patternNames(element)));
    case 'ObjectPattern':
      return (node.properties as AnyNode[]).flatMap((property) =>
        patternNames(property.type === 'RestElement' ? property : property.value as AnyNode));
    default:
      throw new ProgramError(`unsupported declaration pattern: ${node.type}`);
  }
}

/** Rewrites a `var` declaration inside a block so its bindings reach `globalThis`. */
function nestedVarEdit(node: AnyNode, parent: AnyNode, source: (node: AnyNode) => string): Edit {
  const declarations = node.declarations as AnyNode[];
  const forInOrOf = parent.type === 'ForInStatement' || parent.type === 'ForOfStatement';
  if (forInOrOf) {
    // A for-in/of head takes the assignment pattern directly. Parenthesizing it (needed when a
    // pattern starts a statement) makes the left-hand side invalid: `for (({ a }) of xs)` is a
    // SyntaxError, so an object pattern must stay unparenthesized here.
    const id = (declarations[0] as AnyNode).id as AnyNode;
    return { start: node.start, end: node.end, text: patternText(id, source) };
  }
  if (parent.type === 'ForStatement' && parent.init === node) {
    const parts = declarations.map((declarator) => {
      const init = declarator.init as AnyNode | null;
      const target = patternText(declarator.id as AnyNode, source);
      return init === null ? `${target} = undefined` : `${target} = (${source(init)})`;
    });
    return { start: node.start, end: node.end, text: parts.join(', ') };
  }
  const parts = declarations.map((declarator) => {
    const init = declarator.init as AnyNode | null;
    if (init === null) {
      return patternNames(declarator.id as AnyNode)
        .map((name) => `if (!(${JSON.stringify(name)} in globalThis)) globalThis.${name} = undefined;`)
        .join(' ');
    }
    return `${patternText(declarator.id as AnyNode, source)} = (${source(init)});`;
  });
  return { start: node.start, end: node.end, text: parts.join(' ') };
}

export function transformProgram(code: string): TransformedProgram {
  let program: AnyNode;
  try {
    program = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      // The program runs inside an async function, so a top-level `return` is legal and natural
      // for a model to write. Its value becomes the result (see `hasResult` below).
      allowReturnOutsideFunction: true,
    }) as unknown as AnyNode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/import/.test(message)) {
      throw new ProgramError(`import is not available in Code Mode; use the listed tools (${message})`);
    }
    throw new ProgramError(message);
  }

  if (containsNodeType(program, 'ImportExpression')) {
    throw new ProgramError('import is not available in Code Mode; use the listed tools');
  }
  const source = (node: AnyNode): string => code.slice(node.start, node.end);
  const statements = (program.body as AnyNode[]) ?? [];
  const hoisted: string[] = [];
  const edits: Edit[] = [];
  const lastIndex = statements.length - 1;
  let hasResult = false;

  // A `var` inside a block is function-scoped in plain JavaScript, so it must still reach `globalThis`
  // to persist across runs. Only declarations outside functions and classes qualify.
  // A top-level `return` with a value also makes the run produce a result.
  const declaredAtTop = new Set<AnyNode>(statements);
  const blockVars = new Set<string>();
  walkNodes(program, (node, parent) => {
    if (node.type === 'ReturnStatement' && node.argument !== null) {
      hasResult = true;
      return;
    }
    if (node.type !== 'VariableDeclaration' || (node.kind as string) !== 'var' || declaredAtTop.has(node)) return;
    for (const declarator of node.declarations as AnyNode[]) {
      for (const name of patternNames(declarator.id as AnyNode)) blockVars.add(name);
    }
    if (parent !== undefined) edits.push(nestedVarEdit(node, parent, source));
  });

  /** Replacement text for a statement, padded with newlines so the lines after it keep their numbers. */
  const replaceWith = (statement: AnyNode, text: string): Edit => {
    const missing = newlines(source(statement)) - newlines(text);
    return { start: statement.start, end: statement.end, text: missing > 0 ? text + '\n'.repeat(missing) : text };
  };

  statements.forEach((statement, index) => {
    switch (statement.type) {
      case 'VariableDeclaration': {
        const kind = statement.kind as string;
        const declarations = statement.declarations as AnyNode[];
        const parts = declarations.map((declarator) => {
          const id = declarator.id as AnyNode;
          const init = declarator.init as AnyNode | null;
          if (init === null) {
            if (id.type === 'Identifier') {
              const name = id.name as string;
              return kind === 'var'
                ? `if (!(${JSON.stringify(name)} in globalThis)) globalThis.${name} = undefined;`
                : `globalThis.${name} = undefined;`;
            }
            throw new ProgramError('destructuring declaration needs an initializer');
          }
          const target = patternText(id, source);
          // Parenthesize the initializer so a sequence expression keeps its meaning: `const a = (1, 2)` must stay 2.
          // A pattern target also needs the outer parentheses to stay a statement, not a block.
          return id.type === 'Identifier'
            ? `${target} = (${source(init)});`
            : `(${target} = (${source(init)}));`;
        });
        edits.push(replaceWith(statement, parts.join(' ')));
        return;
      }
      case 'FunctionDeclaration': {
        const name = (statement.id as AnyNode).name as string;
        hoisted.push(`${source(statement)}\nglobalThis.${name} = ${name};`);
        edits.push(replaceWith(statement, ''));
        return;
      }
      case 'ClassDeclaration': {
        const name = (statement.id as AnyNode).name as string;
        edits.push(replaceWith(statement, `globalThis.${name} = ${source(statement)};`));
        return;
      }
      case 'ExpressionStatement': {
        if (index === lastIndex) {
          hasResult = true;
          edits.push(replaceWith(statement, `return (${source(statement.expression as AnyNode)});`));
        }
        return;
      }
      default:
        return;
    }
  });

  let userBody = '';
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    userBody += code.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  userBody += code.slice(cursor);
  // A block-level `var` is function-scoped in plain JavaScript, so a block that never runs still
  // declares its names as `undefined`. Declaring them once at the top keeps that meaning; the
  // declaration preserves a value left by an earlier run, like `var x;` at the top level.
  for (const name of [...blockVars].sort()) {
    hoisted.push(`if (!(${JSON.stringify(name)} in globalThis)) globalThis.${name} = undefined;`);
  }
  // Hoisted declarations go first, each on its own line, followed by a line break before the user's code.
  const prefix = hoisted.length === 0 ? '' : `${hoisted.join('\n')}\n`;
  // A leading `'use strict'` must stay in the directive prologue, so it moves ahead of the hoisted prefix.
  const directive = /^(?:'use strict'|"use strict");?[ \t]*/.exec(userBody);
  if (directive !== null && prefix !== '') {
    const head = directive[0];
    const body = head + prefix + userBody.slice(head.length);
    return { body, hasResult, prefixLines: newlines(head + prefix) };
  }
  return { body: prefix + userBody, hasResult, prefixLines: newlines(prefix) };
}

/** True when any node in the tree has the given ESTree type. */
function containsNodeType(node: unknown, type: string): boolean {
  if (Array.isArray(node)) return node.some((child) => containsNodeType(child, type));
  if (typeof node !== 'object' || node === null) return false;
  if ((node as { type?: unknown }).type === type) return true;
  return Object.values(node).some((child) => containsNodeType(child, type));
}

/** Writes a binding pattern as an assignment target whose identifiers are globalThis members. */
function patternText(node: AnyNode, source: (node: AnyNode) => string): string {
  switch (node.type) {
    case 'Identifier':
      return `globalThis.${node.name as string}`;
    case 'AssignmentPattern':
      // The source text of a sequence expression loses the parentheses that made it one value.
      return `${patternText(node.left as AnyNode, source)} = (${source(node.right as AnyNode)})`;
    case 'RestElement':
      return `...${patternText(node.argument as AnyNode, source)}`;
    case 'ArrayPattern': {
      const elements = (node.elements as Array<AnyNode | null>).map((element) =>
        element === null ? '' : patternText(element, source));
      return `[${elements.join(', ')}]`;
    }
    case 'ObjectPattern': {
      const props = (node.properties as AnyNode[]).map((prop) => {
        if (prop.type === 'RestElement') return patternText(prop, source);
        const key = prop.computed === true ? `[${source(prop.key as AnyNode)}]` : source(prop.key as AnyNode);
        return `${key}: ${patternText(prop.value as AnyNode, source)}`;
      });
      return `{ ${props.join(', ')} }`;
    }
    default:
      throw new ProgramError(`unsupported declaration pattern: ${node.type}`);
  }
}
