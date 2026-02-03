import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export async function resolve(specifier, context, defaultResolve) {
  if (specifier.startsWith('.') && !specifier.match(/\.[a-z]+$/)) {
    try {
      return defaultResolve(`${specifier}.ts`, context, defaultResolve);
    } catch {
      return defaultResolve(`${specifier}.tsx`, context, defaultResolve);
    }
  }
  return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: url,
    });
    return {
      format: 'module',
      source: output.outputText,
      shortCircuit: true,
    };
  }

  if (url.endsWith('.json')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    const json = JSON.stringify(JSON.parse(source));
    return {
      format: 'module',
      source: `export default ${json};`,
      shortCircuit: true,
    };
  }

  return defaultLoad(url, context, defaultLoad);
}
