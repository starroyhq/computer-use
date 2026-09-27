// Test-only source loader: exercise the real stdio server without requiring dist/ or native binaries.
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const sourceRoot = new URL('../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(sourceRoot)) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText,
    };
    return nextLoad(url, context);
  },
});
const { runStdio } = await import('../mcp.ts');
const { CuError } = await import('../contracts.ts');
await runStdio({ async call(token, method) {
  if (!process.env.TEST_MCP_TOKEN || token !== process.env.TEST_MCP_TOKEN) throw new CuError('unauthorized', 'Fixture client rejected.');
  return { method, state: 'fixture-ready' };
} }, process.env.TEST_MCP_TOKEN ?? '');
