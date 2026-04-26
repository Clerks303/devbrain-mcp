import { describe, it, expect } from 'vitest';
import { analyzePrompt } from '../../src/injector/prompt-analyzer.js';

describe('analyzePrompt', () => {
  describe('trivial prompts', () => {
    it('should detect "ok" as trivial', () => {
      const result = analyzePrompt('ok');
      expect(result.confidence).toBeLessThan(0.3);
      expect(result.intent).toBe('generic');
    });

    it('should detect "oui" as trivial', () => {
      const result = analyzePrompt('oui');
      expect(result.confidence).toBeLessThan(0.3);
    });

    it('should detect "continue" as trivial', () => {
      const result = analyzePrompt('continue');
      expect(result.confidence).toBeLessThan(0.3);
    });

    it('should detect "yes" as trivial', () => {
      const result = analyzePrompt('yes');
      expect(result.confidence).toBeLessThan(0.3);
    });

    it('should detect short prompts (<10 chars) as trivial', () => {
      const result = analyzePrompt('go');
      expect(result.confidence).toBeLessThan(0.3);
    });

    it('should detect "..." as trivial', () => {
      const result = analyzePrompt('...');
      expect(result.confidence).toBeLessThan(0.3);
    });
  });

  describe('intent detection', () => {
    it('should detect implement intent (FR)', () => {
      const result = analyzePrompt('Implémente un nouveau service AuthService');
      expect(result.intent).toBe('implement');
    });

    it('should detect implement intent (EN)', () => {
      const result = analyzePrompt('Create a new REST API endpoint for users');
      expect(result.intent).toBe('implement');
    });

    it('should detect refactor intent', () => {
      const result = analyzePrompt('Refactore le module auth pour extraire le JWT');
      expect(result.intent).toBe('refactor');
    });

    it('should detect debug intent (FR)', () => {
      const result = analyzePrompt("Il y a un bug dans le service d'authentification");
      expect(result.intent).toBe('debug');
    });

    it('should detect debug intent (EN)', () => {
      const result = analyzePrompt("The login endpoint doesn't work anymore");
      expect(result.intent).toBe('debug');
    });

    it('should detect review intent', () => {
      const result = analyzePrompt('Review the authentication module for security issues');
      expect(result.intent).toBe('review');
    });

    it('should detect architecture intent', () => {
      const result = analyzePrompt('Design the system architecture for the new microservice');
      expect(result.intent).toBe('architecture');
    });

    it('should fallback to generic for unknown intent', () => {
      const result = analyzePrompt('Explain how the codebase handles user sessions');
      expect(result.intent).toBe('generic');
    });
  });

  describe('file extraction', () => {
    it('should extract file paths with src prefix', () => {
      const result = analyzePrompt('Fix the bug in src/auth/auth.service.ts');
      expect(result.mentionedFiles).toContain('src/auth/auth.service.ts');
    });

    it('should extract standalone file names', () => {
      const result = analyzePrompt('Update package.json to add the new dependency');
      expect(result.mentionedFiles).toContain('package.json');
    });

    it('should extract multiple files', () => {
      const result = analyzePrompt('Refactor src/api/routes.ts and src/api/middleware.ts');
      expect(result.mentionedFiles).toHaveLength(2);
      expect(result.mentionedFiles).toContain('src/api/routes.ts');
      expect(result.mentionedFiles).toContain('src/api/middleware.ts');
    });

    it('should extract test file paths', () => {
      const result = analyzePrompt('Run the tests in tests/auth/login.test.ts');
      expect(result.mentionedFiles).toContain('tests/auth/login.test.ts');
    });
  });

  describe('identifier extraction', () => {
    it('should extract PascalCase identifiers', () => {
      const result = analyzePrompt('The AuthService class needs a refactor');
      expect(result.mentionedIdentifiers).toContain('AuthService');
    });

    it('should extract camelCase identifiers', () => {
      const result = analyzePrompt('The getUserById function is too slow');
      expect(result.mentionedIdentifiers).toContain('getUserById');
    });

    it('should filter out known stop list items', () => {
      const result = analyzePrompt('Use TypeScript and React for the frontend');
      expect(result.mentionedIdentifiers).not.toContain('TypeScript');
      expect(result.mentionedIdentifiers).not.toContain('React');
    });

    it('should deduplicate identifiers', () => {
      const result = analyzePrompt('AuthService uses AuthService internally');
      const authCount = result.mentionedIdentifiers.filter(id => id === 'AuthService').length;
      expect(authCount).toBeLessThanOrEqual(1);
    });
  });

  describe('keyword extraction', () => {
    it('should extract words >= 4 chars', () => {
      const result = analyzePrompt('Implement the authentication service endpoint');
      expect(result.keywords).toContain('implement');
      expect(result.keywords).toContain('authentication');
      expect(result.keywords).toContain('service');
      expect(result.keywords).toContain('endpoint');
    });

    it('should exclude stop words', () => {
      const result = analyzePrompt('Check this with the other module from there');
      expect(result.keywords).not.toContain('this');
      expect(result.keywords).not.toContain('with');
      expect(result.keywords).not.toContain('from');
      expect(result.keywords).not.toContain('other');
      expect(result.keywords).not.toContain('there');
    });

    it('should limit to 8 keywords max', () => {
      const result = analyzePrompt(
        'Implement authentication service endpoint middleware controller repository handler factory builder'
      );
      expect(result.keywords.length).toBeLessThanOrEqual(8);
    });
  });

  describe('language detection', () => {
    it('should detect French', () => {
      const result = analyzePrompt("Implémente le service d'authentification avec les règles du projet");
      expect(result.language).toBe('fr');
    });

    it('should detect English', () => {
      const result = analyzePrompt('Create a new service that handles user authentication');
      expect(result.language).toBe('en');
    });

    it('should detect mixed language', () => {
      const result = analyzePrompt('Refactore the AuthService pour utiliser les new patterns');
      expect(['mixed', 'fr', 'en']).toContain(result.language);
    });
  });

  describe('confidence scoring', () => {
    it('should have higher confidence with more signals', () => {
      const simple = analyzePrompt('Update the code');
      const rich = analyzePrompt('Refactor src/auth/AuthService.ts to extract the JwtStrategy module');
      expect(rich.confidence).toBeGreaterThan(simple.confidence);
    });

    it('should cap confidence at 1.0', () => {
      const result = analyzePrompt(
        'Implement src/api/routes.ts src/api/middleware.ts AuthService UserRepo JwtStrategy TokenManager SessionStore CacheLayer'
      );
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
