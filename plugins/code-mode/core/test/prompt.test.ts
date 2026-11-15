import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RETURN_CHARS, renderInstructions } from '../src/prompt.ts';

const tools = [
  { name: 'Read', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'bad-name', description: 'Odd name.', inputSchema: { type: 'object' } },
];

test('instructions list every visible tool and how to reach each one', () => {
  const text = renderInstructions(tools);
  assert.match(text, /run_code/);
  assert.match(text, /Read\(\{ path \}\)/);
  assert.match(text, /tools\["bad-name"\]/);
  assert.match(text, /self\.log/);
  assert.match(text, /console\.tail/);
  assert.match(text, /preview\(/);
  assert.match(text, /require|process|import/);
});

test('instructions with no tools say so', () => {
  assert.match(renderInstructions([]), /no tools/i);
});

test('the prompt example calls only tools that are bound', () => {
  const bound = [
    { name: 'read', description: 'Return file contents.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    { name: 'shell_run', description: 'Run a command.', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  ];
  const text = renderInstructions(bound);
  const boundNames = bound.map((tool) => tool.name);
  const called = [...text.matchAll(/await ([A-Za-z_$][\w$]*)\(/g)].map((match) => match[1] ?? '');
  for (const name of called) assert.ok(boundNames.includes(name), `example calls unbound tool ${name}`);
  assert.doesNotMatch(text, /\bRead\(/);
});

test('with no tools the prompt example calls no tool', () => {
  assert.doesNotMatch(renderInstructions([]), /await [A-Za-z_$][\w$]*\(/);
});

const readWithReturn = {
  name: 'read',
  description: 'Read a file.',
  inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'integer' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: { number: { type: 'integer' }, text: { type: 'string' } },
          required: ['number', 'text'],
        },
      },
      totalLines: { type: 'integer' },
    },
    required: ['path', 'offset', 'lines', 'totalLines'],
  },
};

test('a tool with an output schema shows its return fields and one nested level', () => {
  const text = renderInstructions([readWithReturn]);
  assert.match(
    text,
    /read\(\{ file_path \}\) -> \{ path: string, offset: integer, lines: \{ number: integer, text: string \}\[\], totalLines: integer \}: Read a file\./,
  );
});

test('a tool without an output schema shows no return type', () => {
  const text = renderInstructions([{ name: 'read', description: 'Read a file.', inputSchema: readWithReturn.inputSchema }]);
  assert.match(text, /read\(\{ file_path \}\): Read a file\./);
});

test('a plain value output shows its type', () => {
  const text = renderInstructions([{ ...readWithReturn, outputSchema: { type: 'string' } }]);
  assert.match(text, /read\(\{ file_path \}\) -> string: Read a file\./);
});

test('fields below the first nested level are shown as {...}', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' } }, required: ['c'] } }, required: ['b'] },
    },
    required: ['a'],
  };
  const text = renderInstructions([{ ...readWithReturn, outputSchema: schema }]);
  assert.match(text, /-> \{ a: \{ b: \{\.\.\.\} \} \}: Read a file\./);
});

function returnTextOf(text: string): string {
  const match = /read\(\{ file_path \}\) -> (.*): Read a file\./.exec(text);
  assert.ok(match !== null, 'return type is rendered');
  return match[1] ?? '';
}

test('a return type longer than MAX_RETURN_CHARS is cut and ends with an ellipsis', () => {
  const properties = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`a_very_long_field_name_that_keeps_going_${i}`, { type: 'string' }]));
  const schema = { type: 'object', properties, required: Object.keys(properties) };
  const ret = returnTextOf(renderInstructions([{ ...readWithReturn, outputSchema: schema }]));
  assert.ok(ret.length <= MAX_RETURN_CHARS, `return type is ${ret.length} characters`);
  assert.ok(ret.endsWith('…'), 'truncated return type ends with an ellipsis');
  assert.match(ret, /^\{ a_very_long_field_name_that_keeps_going_0: string, /);
});

test('an object with more than 12 fields shows the first 12 and a marker', () => {
  const properties = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, { type: 'string' }]));
  const schema = { type: 'object', properties, required: Object.keys(properties) };
  const ret = returnTextOf(renderInstructions([{ ...readWithReturn, outputSchema: schema }]));
  assert.match(ret, /^\{ f0: string, .*f11: string, \.\.\. \}$/);
  assert.doesNotMatch(ret, /f12/);
});

test('the example does not imply a tool returns a string', () => {
  const text = renderInstructions(tools);
  assert.doesNotMatch(text, /const text = await/);
  assert.match(text, /const result = await <tool>/);
  assert.match(text, /Results are usually objects/);
});

test('the no-import, no-require, no-process rule is in the first lines', () => {
  const head = renderInstructions(tools).split('\n').slice(0, 3).join('\n');
  assert.match(head, /import/);
  assert.match(head, /require/);
  assert.match(head, /process/);
  assert.match(head, /listed tools/);
});

const bashLike = {
  name: 'bash',
  description: 'Run a shell command.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  outputSchema: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'background' },
          jobId: { type: 'string' },
        },
        required: ['kind', 'jobId'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'foreground' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          stdout: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
        required: ['kind', 'exitCode', 'stdout'],
      },
    ],
  },
};

test('a oneOf return type lists each branch with its const kind', () => {
  const text = renderInstructions([bashLike]);
  assert.doesNotMatch(text, /-> unknown/);
  assert.match(text, /bash\(\{ command \}\) -> \{ kind: "background", jobId: string \} \| \{ kind: "foreground", exitCode: integer \| null, stdout: \{ text: string \} \}: Run a shell command\./);
});
