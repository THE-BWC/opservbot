import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	prettier,
	{
		languageOptions: { globals: globals.node },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			'no-undef': 'off',
			// The bot reads OpServ only through the read API (SPEC-discord D6); its own state is node:sqlite.
			'no-restricted-imports': [
				'error',
				{
					paths: [
						'mysql2',
						'mysql2/promise',
						'mysql',
						'mariadb',
						'pg',
						'postgres',
						'sequelize'
					].map((name) => ({ name, message: 'Read OpServ through src/opserv.ts.' }))
				}
			]
		}
	}
);
