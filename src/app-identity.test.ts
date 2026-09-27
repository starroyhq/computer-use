import { describe, expect, it } from 'vitest';
import { canonicalAppId, windowsAppId } from './app-identity.js';

describe('application authorization identity', () => {
  it('keeps the existing macOS bundle ID contract', () => {
    expect(canonicalAppId('com.example.Editor', 'darwin')).toBe('com.example.Editor');
    expect(() => canonicalAppId('C:\\Apps\\Editor.exe', 'darwin')).toThrow();
  });

  it('normalizes only absolute local Windows executable paths', () => {
    expect(canonicalAppId('C:\\Apps\\Editor.exe', 'win32')).toBe('win32:c:\\apps\\editor.exe');
    expect(windowsAppId('c:\\apps\\EDITOR.EXE')).toBe('win32:c:\\apps\\editor.exe');
    for (const value of ['Editor.exe', '\\\\server\\share\\Editor.exe', 'C:\\Apps\\..\\Other.exe', 'C:\\Apps\\Notes.txt']) {
      expect(() => canonicalAppId(value, 'win32')).toThrow();
    }
    expect(windowsAppId(undefined)).toBeUndefined();
  });
});
