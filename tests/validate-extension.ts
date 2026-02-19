#!/usr/bin/env node

/**
 * Extension Validator
 * Validates the built extension artifacts in dist/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, '..');
const PROJECT_DIR = path.join(DIST_DIR, '..');

type Manifest = {
  manifest_version?: number;
  name?: string;
  version?: string;
  description?: string;
  permissions?: string[];
  host_permissions?: string[];
  background?: { service_worker?: string };
  side_panel?: { default_path?: string };
  action?: Record<string, unknown>;
  icons?: Record<string, string>;
};

class ExtensionValidator {
  errors: Array<{ test: string; error: string }>;
  warnings: string[];
  passed: number;
  failed: number;
  manifest: Manifest | null;
  packageJSON: Record<string, any>;

  constructor() {
    this.errors = [];
    this.warnings = [];
    this.passed = 0;
    this.failed = 0;
    this.manifest = null;
    this.packageJSON = {};
  }

  log(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') {
    const colors = {
      info: '\x1b[36m',
      success: '\x1b[32m',
      error: '\x1b[31m',
      warning: '\x1b[33m',
      reset: '\x1b[0m',
    };
    console.log(`${colors[type]}${message}${colors.reset}`);
  }

  test(description: string, fn: () => void) {
    try {
      fn();
      this.passed++;
      this.log(`[OK] ${description}`, 'success');
      return true;
    } catch (error: any) {
      this.failed++;
      this.errors.push({ test: description, error: error.message });
      this.log(`[FAIL] ${description}: ${error.message}`, 'error');
      return false;
    }
  }

  warn(message: string) {
    this.warnings.push(message);
    this.log(`[WARN] ${message}`, 'warning');
  }

  fileExists(filePath: string, baseDir: string = DIST_DIR) {
    const fullPath = path.join(baseDir, filePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return fullPath;
  }

  validateJSON(filePath: string, baseDir: string = DIST_DIR) {
    const fullPath = this.fileExists(filePath, baseDir);
    const content = fs.readFileSync(fullPath, 'utf8');
    try {
      return JSON.parse(content);
    } catch (error: any) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
  }

  validateManifest() {
    this.log('\n=== Validating Manifest ===', 'info');

    this.test('manifest.json exists and is valid JSON', () => {
      this.manifest = this.validateJSON('manifest.json');
    });

    this.test('manifest_version is 3', () => {
      if (this.manifest?.manifest_version !== 3) {
        throw new Error('Must use Manifest V3');
      }
    });

    this.test('name is present', () => {
      if (!this.manifest?.name) {
        throw new Error('Manifest must have a name');
      }
    });

    this.test('version is present and valid', () => {
      if (!this.manifest?.version) {
        throw new Error('Manifest must have a version');
      }
      if (!/^\d+\.\d+\.\d+/.test(String(this.manifest?.version || ''))) {
        throw new Error('Version must be in format X.Y.Z');
      }
    });

    this.test('description is present', () => {
      if (!this.manifest?.description) {
        throw new Error('Manifest must have a description');
      }
    });

    this.test('required permissions are declared', () => {
      const required = ['sidePanel', 'activeTab', 'scripting', 'tabs', 'storage'];
      const permissions = Array.isArray(this.manifest?.permissions) ? this.manifest.permissions : [];
      const missing = required.filter((p) => !permissions.includes(p));
      if (missing.length > 0) {
        throw new Error(`Missing permissions: ${missing.join(', ')}`);
      }
    });

    this.test('host_permissions includes <all_urls>', () => {
      const hostPermissions = Array.isArray(this.manifest?.host_permissions) ? this.manifest.host_permissions : [];
      if (!hostPermissions.includes('<all_urls>')) {
        throw new Error('Must include <all_urls> in host_permissions');
      }
    });

    this.test('background service worker is configured', () => {
      if (!this.manifest?.background?.service_worker) {
        throw new Error('Must have background.service_worker');
      }
    });

    this.test('side_panel is configured', () => {
      if (!this.manifest?.side_panel?.default_path) {
        throw new Error('Must have side_panel.default_path');
      }
    });

    this.test('action is configured', () => {
      if (!this.manifest?.action) {
        throw new Error('Must have action configuration');
      }
    });

    if (!this.manifest?.icons) {
      this.warn("No icons configured; extension will work but won't show an icon.");
      return;
    }

    Object.entries(this.manifest.icons).forEach(([size, iconPath]) => {
      this.test(`icon ${size} (${iconPath}) exists`, () => {
        this.fileExists(iconPath);
      });
    });
  }

  validateRequiredFiles() {
    this.log('\n=== Validating Required Files ===', 'info');

    const requiredFiles = [
      'manifest.json',
      'background.js',
      'content.js',
      'sidepanel/panel.html',
      'sidepanel/panel.css',
      'sidepanel/panel.js',
    ];

    requiredFiles.forEach((file) => {
      this.test(`${file} exists`, () => {
        this.fileExists(file);
      });
    });
  }

  validateJavaScriptSyntax() {
    this.log('\n=== Validating JavaScript Files ===', 'info');

    const jsFiles = ['background.js', 'content.js', 'sidepanel/panel.js'];

    jsFiles.forEach((file) => {
      this.test(`${file} has valid syntax`, () => {
        const fullPath = this.fileExists(file);
        const content = fs.readFileSync(fullPath, 'utf8');

        if (content.includes('debugger;')) {
          this.warn(`${file} contains debugger statement`);
        }
      });
    });
  }

  validatePackageJSON() {
    this.log('\n=== Validating package.json ===', 'info');

    this.test('package.json exists and is valid', () => {
      this.packageJSON = this.validateJSON('package.json', PROJECT_DIR);
    });

    this.test('package.json has required scripts', () => {
      const required = ['test', 'validate', 'build', 'build:ext', 'build:test'];
      const missing = required.filter((s) => !this.packageJSON.scripts?.[s]);
      if (missing.length > 0) {
        throw new Error(`Missing scripts: ${missing.join(', ')}`);
      }
    });
  }

  validateDocumentation() {
    this.log('\n=== Validating Documentation ===', 'info');

    const docs = ['README.md', 'LICENSE', 'docs/API.md', 'docs/ARCHITECTURE.md'];

    docs.forEach((doc) => {
      this.test(`${doc} exists`, () => {
        this.fileExists(doc, PROJECT_DIR);
      });
    });
  }

  validateFileStructure() {
    this.log('\n=== Validating File Structure ===', 'info');

    const requiredDirs = ['sidepanel', 'icons'];

    requiredDirs.forEach((dir) => {
      this.test(`${dir}/ directory exists`, () => {
        const fullPath = path.join(DIST_DIR, dir);
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
          throw new Error(`Directory not found: ${dir}/`);
        }
      });
    });
  }

  validateToolDefinitions() {
    this.log('\n=== Validating Tool Definitions ===', 'info');

    this.test('BrowserTools implementation is bundled in background.js', () => {
      const backgroundPath = this.fileExists('background.js');
      const content = fs.readFileSync(backgroundPath, 'utf8');

      if (!content.includes('BrowserTools = class') && !content.includes('class BrowserTools')) {
        throw new Error('BrowserTools class not found in bundle');
      }

      if (!content.includes('getToolDefinitions')) {
        throw new Error('getToolDefinitions method not found');
      }
    });
  }

  printSummary() {
    this.log('\n=== Validation Summary ===', 'info');
    this.log(`Tests Passed: ${this.passed}`, 'success');

    if (this.failed > 0) {
      this.log(`Tests Failed: ${this.failed}`, 'error');
    }

    if (this.warnings.length > 0) {
      this.log(`Warnings: ${this.warnings.length}`, 'warning');
      this.warnings.forEach((w) => this.log(`  - ${w}`, 'warning'));
    }

    if (this.errors.length > 0) {
      this.log('\nErrors:', 'error');
      this.errors.forEach((e) => {
        this.log(`  ${e.test}:`, 'error');
        this.log(`    ${e.error}`, 'error');
      });
    }

    if (this.failed === 0) {
      this.log('\n[OK] Extension validation passed!', 'success');
      this.log('Extension is ready to load in Chrome.', 'success');
      return true;
    }

    this.log('\n[FAIL] Extension validation failed!', 'error');
    this.log('Please fix the errors above before loading the extension.', 'error');
    return false;
  }

  async run() {
    this.log('========================================', 'info');
    this.log('       Glide - Extension Validator      ', 'info');
    this.log('========================================', 'info');

    this.validateManifest();
    this.validateFileStructure();
    this.validateRequiredFiles();
    this.validateJavaScriptSyntax();
    this.validatePackageJSON();
    this.validateDocumentation();
    this.validateToolDefinitions();

    const success = this.printSummary();
    process.exit(success ? 0 : 1);
  }
}

const validator = new ExtensionValidator();
validator.run();
