// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './LoginScreen';

describe('safeReturnPath', () => {
  it('keeps a same-origin path with query and hash', () => {
    expect(safeReturnPath('/share/t1?as=guest#h')).toBe('/share/t1?as=guest#h');
  });

  it.each([
    ['//evil.example/x'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['/\\evil.example'],
    ['https://evil.example/'],
    ['javascript:alert(1)'],
    ['/login'],
    ['/api/me'],
    [''],
    [null],
  ])('rejects %j', (value) => {
    expect(safeReturnPath(value)).toBeUndefined();
  });
});
