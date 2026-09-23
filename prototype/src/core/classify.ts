/**
 * 文件分类（对照 Claude Code `mods/diff/hooks/classify` 的设计，适配 RepoPilot 的用途差异）。
 *
 * ## 关键差异 —— 用途不同，护栏方向相反
 *
 *   - Claude 的分类只用于 diff 面板**折叠展示**（noise 折起来，展开还在，一个字节都不丢），
 *     所以它可以激进：`.d.ts`、`vendor/`、`__snapshots__/` 一律折进 "tests and generated"。
 *   - RepoPilot 的 `isGeneratedFile` 用于**硬排除出补丁**：`changedVsBaseline()` 只把 authored
 *     放进 `PatchArtifact`，generated 进 `excludedGeneratedFiles`。激进分类 = 把用户真实改动
 *     静默挪出补丁正文。所以这里刻意比 Claude **保守**：
 *       1. 目录用**整段匹配**（`/dist/` 这样的路径段），不用子串 —— `src/dist-helper.ts`、
 *          `distribution/plan.ts`、`distance.ts`、`builder/config.ts` 都不命中，只有真正的
 *          `dist` 目录段（**任意深度**，含 monorepo 的 `packages/foo/dist/`）才命中；
 *       2. vendored 目录（`vendor` / `third_party` / `external` / `venv` …）**不纳入**硬排除 ——
 *          它们可能是手工维护的源码，误排就是丢用户代码；
 *       3. `.d.ts` **不算** generated（**偏离 Claude**）—— 本项目 TS-first，手写 ambient 声明是源码；
 *       4. `.snap` **不算** generated（归测试，见 `isTestFile`；false-green 维度由 `coverage.ts` 负责）。
 *
 *   排除仍然**报数**（`PatchArtifact.excludedGeneratedFiles` 逐条列出），不构成静默省略（不变式 8）。
 *
 * ## 与裸目录路径的兼容
 *
 * Claude 只匹配 `/<path>`（前导斜杠）。RepoPilot 的 tree diff 里可能出现**裸目录名**（如 `dist`
 * 本身作为一个条目），所以这里在末尾也补一个 `/` 再匹配 —— `/dist/` 才能命中 `dist`、
 * `dist/bundle.js`、`packages/foo/dist/x.js`，而不误伤 `distribution/`。
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

/** lockfile / shrinkwrap 的精确文件名（小写）—— 从不手写，churn 是噪声。 */
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
 * 压缩 / 打包 / 锁文件的扩展名（小写）。**不含 `.d.ts`**（偏离 Claude，见文件头）。
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

/**
 * 是否为构建产物 / 生成代码 / lockfile —— 这类**硬排除**出补丁正文（进 `excludedGeneratedFiles` 报数）。
 *
 * 判据（任一命中即是）：目录整段匹配 ∪ lockfile 精确文件名 ∪ 压缩/打包后缀 ∪ 生成代码文件名形状。
 * 刻意比 Claude 保守：不含 vendored 目录、不含 `.d.ts`、不含 `.snap`（理由见文件头）。
 *
 * @param relPath 仓库相对路径，`/`-分隔
 */
export function isGeneratedFile(relPath: string): boolean {
    const name = baseNameOf(relPath).toLowerCase();
    const rooted = rootedWithSlashes(relPath);

    if (GENERATED_DIR_SEGMENTS.some((segment) => rooted.includes(segment))) return true;
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
