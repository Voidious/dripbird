/**
 * Output formatting gate (0.3.3).
 *
 * dripbird rewrites files with generated code, and generated code can be
 * off-format even when it parses and type-checks. When the target repo
 * uses `deno fmt` (or nothing else — the formatter is config-gated via
 * `format_output`), dripbird formats WHAT IT WROTE:
 *
 * - newly created files are always formatted (they are entirely ours);
 * - rewritten files are formatted only when they were fmt-clean BEFORE
 *   the change (`deno fmt --check` on the original), so a repo that does
 *   not use deno fmt never gets unrelated churn inside a refactor diff.
 *
 * Formatting runs `deno fmt` as a subprocess in the target directory, so
 * the repo's own `deno.json` fmt settings (line width, quotes, ...) apply.
 * This requires run access to the `deno` binary — the `install` task grants
 * `--allow-run=deno` for exactly this; without it every call degrades to
 * "skip formatting" (verified live: NotCapable at e0ce873).
 * Every failure mode — non-zero exit (syntax error, excluded path, no
 * formatter for the extension), unspawnable binary, non-formattable
 * extension — degrades to "skip formatting", never to losing output.
 */

/** Extensions `deno fmt` may rewrite without reflowing docs/config. */
const FORMATTABLE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);

/**
 * A file's extension when `deno fmt` is allowed to touch it, else null
 * (e.g. `.md`/`.json` would be reformatted by other formatters, and `.py`
 * has none at all).
 */
export function formattableExt(path: string): string | null {
    const dot = path.lastIndexOf(".");
    if (dot <= 0) return null; // no extension, or a dotfile like ".ts"
    const ext = path.slice(dot + 1);
    return FORMATTABLE_EXTENSIONS.has(ext) ? ext : null;
}

/** Result of one finished subprocess run. */
interface CommandOutput {
    code: number;
}

/** Runs a command; injectable so tests can fake failures. */
export type CommandRunner = (
    name: string,
    options: Deno.CommandOptions,
) => Promise<CommandOutput>;

/** Real runner: captures only the exit code. */
export const denoCommandRunner: CommandRunner = async (name, options) => {
    const { code } = await new Deno.Command(name, options).output();
    return { code };
};

/** Formats files dripbird wrote, in place, using `deno fmt`. */
export interface OutputFormatter {
    /**
     * Whether `path` is already fmt-clean. False for non-formattable
     * paths and for any formatter failure (treated as "not clean", so
     * rewrites of such files are left as generated).
     */
    isClean(path: string): Promise<boolean>;
    /**
     * Format `path` in place. False when nothing was formatted
     * (non-formattable path or a failed run); the file is then left
     * exactly as dripbird wrote it.
     */
    format(path: string): Promise<boolean>;
}

/**
 * Build an OutputFormatter running `deno fmt <args>` with `cwd` as the
 * working directory, so the target repo's fmt config is discovered.
 */
export function createOutputFormatter(
    cwd: string,
    run: CommandRunner = denoCommandRunner,
): OutputFormatter {
    const fmtExit = async (args: string[]): Promise<number> => {
        try {
            const { code } = await run("deno", {
                args: ["fmt", ...args],
                cwd,
                stdout: "null",
                stderr: "null",
            });
            return code;
        } catch {
            return 1; // unspawnable binary: behave like a failed run
        }
    };
    return {
        async isClean(path) {
            if (formattableExt(path) === null) return false;
            return await fmtExit(["--check", path]) === 0;
        },
        async format(path) {
            if (formattableExt(path) === null) return false;
            return await fmtExit([path]) === 0;
        },
    };
}
