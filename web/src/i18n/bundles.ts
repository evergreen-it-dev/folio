/**
 * Which interface languages ship is decided by which bundle files exist, not
 * by a list in the code: a zone hands over everything next to its register
 * module, and a language whose file is absent simply is not there.
 *
 * Dependency-free on purpose. Every zone imports this, including the ones
 * that must not depend on the central i18n bootstrap.
 */

/** What `import.meta.glob('./*.json', { eager: true, import: 'default' })` returns. */
export type BundleModules = Record<string, unknown>;

/** './uk.json' -> 'uk' */
function languageOf(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return name.slice(0, name.lastIndexOf('.'));
}

export function bundlesFrom(modules: BundleModules): Record<string, object> {
  const bundles: Record<string, object> = {};
  for (const [file, bundle] of Object.entries(modules)) {
    if (bundle && typeof bundle === 'object') bundles[languageOf(file)] = bundle as object;
  }
  return bundles;
}
