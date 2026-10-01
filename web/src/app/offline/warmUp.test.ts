import { describe, expect, it } from 'vitest';
import { boardEditorFiles, type BuildManifest } from './warmUp';

const manifest: BuildManifest = {
  'index.html': { file: 'assets/index-AAAAAAAA.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/diagrams/BoardCanvas.tsx', 'src/tables/TableGrid.tsx'], css: ['assets/index-BBBBBBBB.css'] },
  '_shared.js': { file: 'assets/shared-CCCCCCCC.js' },
  'src/tables/TableGrid.tsx': { file: 'assets/TableGrid-DDDDDDDD.js', imports: ['index.html'] },
  'src/diagrams/BoardCanvas.tsx': {
    file: 'assets/BoardCanvas-EEEEEEEE.js',
    imports: ['index.html', '_shared.js', '_core.js'],
    dynamicImports: ['_roundRect.js', '_uk.js', '_de.js', '_en.js'],
    css: ['assets/BoardCanvas-FFFFFFFF.css'],
  },
  '_core.js': { file: 'assets/chunk-EIO257PC-GGGGGGGG.js', assets: ['assets/Assistant-Bold-HHHHHHHH.woff2'] },
  '_roundRect.js': { file: 'assets/roundRect-IIIIIIII.js' },
  '_uk.js': { file: 'assets/uk-UA-QMV73CPH-JJJJJJJJ.js' },
  '_de.js': { file: 'assets/de-DE-XR44H4JA-KKKKKKKK.js' },
  '_en.js': { file: 'assets/en-B4ZKOASM-LLLLLLLL.js' },
};

describe('boardEditorFiles', () => {
  const files = boardEditorFiles(manifest);

  it('takes the editor, what it imports, what it loads on demand, its styles and fonts', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'assets/BoardCanvas-EEEEEEEE.js',
        'assets/BoardCanvas-FFFFFFFF.css',
        'assets/chunk-EIO257PC-GGGGGGGG.js',
        'assets/Assistant-Bold-HHHHHHHH.woff2',
        'assets/roundRect-IIIIIIII.js',
      ]),
    );
  });

  it('leaves out what the application has already loaded for itself', () => {
    expect(files).not.toContain('assets/index-AAAAAAAA.js');
    expect(files).not.toContain('assets/shared-CCCCCCCC.js');
  });

  it('does not wander off into the rest of the application through the entry chunk', () => {
    expect(files).not.toContain('assets/TableGrid-DDDDDDDD.js');
  });

  it('keeps the three interface languages Folio speaks and drops the others', () => {
    expect(files).toContain('assets/uk-UA-QMV73CPH-JJJJJJJJ.js');
    expect(files).toContain('assets/en-B4ZKOASM-LLLLLLLL.js');
    expect(files).not.toContain('assets/de-DE-XR44H4JA-KKKKKKKK.js');
  });

  it('is empty, not an error, when the build has no board editor in it', () => {
    expect(boardEditorFiles({ 'index.html': { file: 'assets/index-AAAAAAAA.js', isEntry: true } })).toEqual([]);
  });
});
