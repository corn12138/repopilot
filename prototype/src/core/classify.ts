/**
 * 展示层分类可折叠生成代码与锁文件，但不能据此丢弃交付内容。
 * 交付只把约定输出目录作为候选，还需由工作区核对导入和 mutation 来源。
 */

/** 构建产物 / 缓存目录段（前后各一个 `/`，整段匹配，任意深度）。刻意不含 vendored 目录。 */
export const GENERATED_DIR_SEGMENTS: readonly string[] = [
    '/dist/',
    '/build/',
    '/out/',
    '/output/',
    '/coverage/',
    '/.next/',
    '/.nuxt/',
    '/.svelte-kit/',
    '/.vite/',
    '/.turbo/',
    '/node_modules/',
    '/__pycache__/',
    '/.tox/',
    '/target/release/',
    '/target/debug/',
    '/.generated/',
];

/** 展示分类使用的 lockfile / shrinkwrap 文件名；它们仍是可交付的依赖输入。 */
export const GENERATED_FILENAMES: ReadonlySet<string> = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'bun.lock',
    'composer.lock',
    'gemfile.lock',
    'cargo.lock',
    'poetry.lock',
    'pipfile.lock',
    'shrinkwrap.json',
    'npm-shrinkwrap.json',
]);

/**
 * 压缩 / 打包 / 锁文件的扩展名（小写）。**不含 `.d.ts`**（可能是手写声明）。
 * `.snap` 也不在这里 —— 它归测试（`isTestFile`），不做硬排除。
 */
export const GENERATED_SUFFIXES: readonly string[] = [
    '.lock',
    '.min.js',
    '.min.css',
    '.min.html',
    '.bundle.js',
    '.bundle.css',
];

/** 生成代码的文件名形状（对 basename 做正则）：minified / bundled / codegen / protobuf。 */
export const GENERATED_FILENAME_PATTERNS: readonly RegExp[] = Object.freeze([
    /\.min\.[a-z]+$/i,
    /\.bundle\.[a-z]+$/i,
    /\.generated\.[a-z]+$/i,
    /\.gen\.[a-z]+$/i,
    /_generated\.[a-z]+$/i,
    /\.pb\.(?:go|js|ts|py|rb)$/i,
    /_pb2?\.py$/i,
]);

/** 测试 / spec / 夹具 / 快照目录段（前后各一个 `/`，整段匹配，任意深度）。 */
export const TEST_DIR_SEGMENTS: readonly string[] = [
    '/test/',
    '/tests/',
    '/spec/',
    '/specs/',
    '/__tests__/',
    '/__mocks__/',
    '/__snapshots__/',
    '/__fixtures__/',
    '/fixtures/',
    '/testdata/',
];

/** 测试文件名形状（对 basename 做正则）。 */
export const TEST_FILENAME_PATTERNS: readonly RegExp[] = Object.freeze([
    /\.test\.[a-z]+$/i,
    /\.spec\.[a-z]+$/i,
    /_test\.[a-z]+$/i,
    /_spec\.[a-z]+$/i,
    /\.snap$/i,
]);

/** `/`-分隔路径的最后一段（文件名）。 */
function baseNameOf(path: string): string {
    return path.split('/').at(-1) ?? path;
}

/** 前后各补一个 `/`，让 `/dist/` 这样的目录段能命中裸目录 `dist` 与任意深度嵌套。 */
function rootedWithSlashes(path: string): string {
    return `/${path.replace(/^\/+/, '')}/`;
}

/** 约定输出目录的整段匹配；文件名和后缀不足以证明文件可再生。 */
export function isBuildOutputPath(relPath: string): boolean {
    const rooted = rootedWithSlashes(relPath);
    return GENERATED_DIR_SEGMENTS.some((segment) => rooted.includes(segment));
}

/** 仅用于展示折叠；不得用于 mutation、交付或文件可见性的过滤。 */
export function isGeneratedFile(relPath: string): boolean {
    const name = baseNameOf(relPath).toLowerCase();
    if (isBuildOutputPath(relPath)) return true;
    if (GENERATED_FILENAMES.has(name)) return true;
    if (GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
    return GENERATED_FILENAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * 是否为测试 / spec / 夹具 / 快照。
 *
 * **本轮不接入硬排除路径**：测试文件的修改是合法的 authored 改动，把它排除出补丁等于丢用户代码；
 * "补丁改了测试导致验证被放宽" 的 false-green 维度由 `coverage.ts` 的 `VERIFICATION_INPUT_PATTERNS`
 * 单独负责。这里提供分类只供后续 review 展示层折叠 noise 用（对照 Claude 的 isNoiseFile）。
 *
 * @param relPath 仓库相对路径，`/`-分隔
 */
export function isTestFile(relPath: string): boolean {
    const name = baseNameOf(relPath);
    const rooted = rootedWithSlashes(relPath);
    return (
        TEST_DIR_SEGMENTS.some((segment) => rooted.includes(segment)) ||
        TEST_FILENAME_PATTERNS.some((pattern) => pattern.test(name))
    );
}

/** 测试或生成物 —— review 展示层可折叠的"噪声"（对照 Claude 的 isNoiseFile；不用于硬排除）。 */
export function isNoiseFile(relPath: string): boolean {
    return isTestFile(relPath) || isGeneratedFile(relPath);
}
