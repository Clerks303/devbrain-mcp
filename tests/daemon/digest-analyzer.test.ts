import { describe, it, expect } from 'vitest';
import { analyzeFileContent, detectLanguage, computeHash } from '../../src/daemon/digest-analyzer.js';

describe('DigestAnalyzer', () => {
  describe('detectLanguage', () => {
    it('should detect TypeScript', () => {
      expect(detectLanguage('.ts')).toBe('typescript');
      expect(detectLanguage('.tsx')).toBe('typescript');
    });

    it('should detect JavaScript', () => {
      expect(detectLanguage('.js')).toBe('javascript');
      expect(detectLanguage('.mjs')).toBe('javascript');
    });

    it('should detect Python', () => {
      expect(detectLanguage('.py')).toBe('python');
    });

    it('should return null for unknown extensions', () => {
      expect(detectLanguage('.xyz')).toBeNull();
      expect(detectLanguage('.bin')).toBeNull();
    });

    it('should be case-insensitive', () => {
      expect(detectLanguage('.TS')).toBe('typescript');
      expect(detectLanguage('.PY')).toBe('python');
    });
  });

  describe('computeHash', () => {
    it('should produce consistent SHA-256 hash', () => {
      const hash1 = computeHash('hello');
      const hash2 = computeHash('hello');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it('should produce different hashes for different content', () => {
      expect(computeHash('a')).not.toBe(computeHash('b'));
    });
  });

  describe('analyzeFileContent', () => {
    it('should extract ES module imports', () => {
      const content = `
import { Foo } from './foo.js';
import Bar from 'bar-package';
import './side-effect';
`;
      const result = analyzeFileContent(content, '.ts');
      expect(result.imports).toContain('./foo.js');
      expect(result.imports).toContain('bar-package');
      expect(result.imports).toContain('./side-effect');
    });

    it('should extract CJS requires', () => {
      const content = `
const fs = require('fs');
const path = require('path');
`;
      const result = analyzeFileContent(content, '.js');
      expect(result.imports).toContain('fs');
      expect(result.imports).toContain('path');
    });

    it('should extract Python imports', () => {
      const content = `
from os import path
from sys import argv
`;
      const result = analyzeFileContent(content, '.py');
      expect(result.imports).toContain('os');
      expect(result.imports).toContain('sys');
    });

    it('should extract named exports', () => {
      const content = `
export function myFunc() {}
export class MyClass {}
export const MY_CONST = 42;
export type MyType = string;
export interface MyInterface {}
`;
      const result = analyzeFileContent(content, '.ts');
      expect(result.exports).toContain('myFunc');
      expect(result.exports).toContain('MyClass');
      expect(result.exports).toContain('MY_CONST');
      expect(result.exports).toContain('MyType');
      expect(result.exports).toContain('MyInterface');
    });

    it('should extract re-exports', () => {
      const content = `export { Foo, Bar as Baz }`;
      const result = analyzeFileContent(content, '.ts');
      expect(result.exports).toContain('Foo');
      expect(result.exports).toContain('Baz');
    });

    it('should count lines of code', () => {
      const content = 'line1\nline2\nline3\n';
      const result = analyzeFileContent(content, '.ts');
      expect(result.loc).toBe(4); // 3 lines + trailing empty
    });

    it('should compute stable content hash', () => {
      const content = 'const x = 1;';
      const r1 = analyzeFileContent(content, '.ts');
      const r2 = analyzeFileContent(content, '.ts');
      expect(r1.contentHash).toBe(r2.contentHash);
      expect(r1.contentHash).toHaveLength(64);
    });

    it('should detect language from extension', () => {
      expect(analyzeFileContent('', '.ts').language).toBe('typescript');
      expect(analyzeFileContent('', '.py').language).toBe('python');
      expect(analyzeFileContent('', '.unknown').language).toBeNull();
    });
  });
});
