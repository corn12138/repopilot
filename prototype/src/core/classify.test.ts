import { describe, expect, it } from 'vitest';
import { isGeneratedFile, isNoiseFile, isTestFile } from './classify';

// 展示分类可以折叠文件，交付完整性由 workspace/patch 的来源与字节断言守住。
describe('isGeneratedFile', () => {
    it.each([
        // 顶层与 monorepo 嵌套的构建产物目录段（任意深度）
        ['dist/bundle.js', true],
        ['dist', true],
        ['packages/foo/dist/bundle.js', true],
        ['apps/web/build/main.js', true],
        ['services/api/target/release/server', true],
        ['__pycache__/mod.cpython-312.pyc', true],
        ['.vite/deps/x.js', true],
        ['coverage/lcov.info', true],
        ['node_modules/react/index.js', true],
        // lockfile：精确文件名，任意深度
        ['pnpm-lock.yaml', true],
        ['package-lock.json', true],
        ['frontend/package-lock.json', true],
        ['yarn.lock', true],
        ['Cargo.lock', true],
        // minified / bundled / codegen / protobuf
        ['assets/app.min.js', true],
        ['static/site.min.css', true],
        ['web/bundle.js', false], // `bundle.js` 不是 `*.bundle.js`，是普通文件名
        ['dist-assets/main.bundle.js', true],
        ['gen.pb.go', true],
        ['mod_pb2.py', true],
        ['api/types.generated.ts', true],
        ['cfg.config.gen.js', true],
    ])('%s → %s', (path, expected) => {
        expect(isGeneratedFile(path)).toBe(expected);
    });

    it.each([
        // 前缀相似但目录段不同 —— 吞掉它们等于丢用户代码
        ['distribution/plan.ts', false],
        ['distance.ts', false],
        ['outbound/mail.ts', false],
        ['builder/config.ts', false],
        ['src/dist-helper.ts', false],
        ['src/app.ts', false],
        ['src/output-format.ts', false],
        // 偏离 Claude 之一：vendored 目录不折叠（可能手工维护）
        ['vendor/lib/handwritten.ts', false],
        ['third_party/foo/bar.cc', false],
        ['src/external/foo.ts', false],
        ['venv/lib/x.py', false],
        // 偏离 Claude 之二：.d.ts 是源码（TS-first，手写 ambient 声明）
        ['types/global.d.ts', false],
        ['src/vite-env.d.ts', false],
        // 偏离 Claude 之三：.snap 归测试，不做 generated 分类
        ['src/__snapshots__/a.snap', false],
        ['', false],
    ])('护栏 %s → %s（不作生成物折叠）', (path, expected) => {
        expect(isGeneratedFile(path)).toBe(expected);
    });
});

describe('isTestFile', () => {
    it.each([
        ['src/a.test.ts', true],
        ['src/a.spec.tsx', true],
        ['pkg/foo_test.go', true],
        ['tests/unit/x.spec.ts', true],
        ['__tests__/y.ts', true],
        ['src/__snapshots__/a.snap', true],
        ['testdata/golden.json', true],
    ])('%s → %s', (path, expected) => {
        expect(isTestFile(path)).toBe(expected);
    });

    it.each([
        // 形状相似但不是测试
        ['src/atest.ts', false],
        ['src/contestant.ts', false],
        ['src/latest.ts', false],
        ['src/app.ts', false],
        ['protest/notes.md', false],
    ])('负例 %s → %s', (path, expected) => {
        expect(isTestFile(path)).toBe(false);
    });
});

describe('isNoiseFile', () => {
    it('是 test 或 generated 的并集', () => {
        expect(isNoiseFile('src/a.test.ts')).toBe(true);
        expect(isNoiseFile('dist/bundle.js')).toBe(true);
        expect(isNoiseFile('pnpm-lock.yaml')).toBe(true);
        expect(isNoiseFile('src/app.ts')).toBe(false);
        // .d.ts 既不是 test 也不是 generated —— 不算 noise（偏离 Claude）
        expect(isNoiseFile('types/global.d.ts')).toBe(false);
    });
});
