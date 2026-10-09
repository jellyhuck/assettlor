#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const messagePath = process.argv[2];
if (!messagePath) {
  console.error('Usage: check-commit-message <message-file>');
  process.exitCode = 2;
} else {
  try {
    const lines = readFileSync(messagePath, 'utf8')
      .replace(/\r\n?/gu, '\n')
      .split('\n')
      // Git removes editor comments from the final message.
      .filter((line) => !line.startsWith('#'));
    while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();

    const errors = [];
    const warnings = [];
    const subject = lines[0] || '';
    const charCount = (value) => Array.from(value).length;

    if (!subject.trim()) {
      errors.push('The subject must not be empty.');
    } else {
      const length = charCount(subject);
      if (length > 72) {
        errors.push(`The subject is ${length} characters; maximum 72.`);
      } else if (length > 50) {
        warnings.push(`The subject is ${length} characters; aim for 50 or fewer.`);
      }
      if (!/^\p{Lu}/u.test(subject)) {
        errors.push('The subject must start with a capital letter.');
      }
      if (subject.endsWith('.')) {
        errors.push('The subject must not end with a period.');
      }
    }

    if (lines.length > 1 && lines.slice(1).some((line) => line.trim())) {
      if (lines[1]?.trim() !== '') {
        errors.push('Separate the subject and body with one blank line.');
      } else if (lines[2]?.trim() === '') {
        errors.push('Use exactly one blank line after the subject.');
      }
    }

    for (let index = 1; index < lines.length; index++) {
      const length = charCount(lines[index]);
      if (length > 72) {
        errors.push(`Body line ${index + 1} is ${length} characters; maximum 72.`);
      }
    }

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/co-authored-by\s*:/iu.test(line)) {
        errors.push(`Line ${index + 1} contains Co-Authored-By:.`);
      }
      if (/^\s*(?:🤖\s*)?(?:generated|written)\s+(?:by|with)\s+(?:(?:openai|github)\s+)?(?:codex|chatgpt|claude(?: code)?|copilot)\b/iu.test(line) ||
          /^\s*ai-assisted-by\s*:/iu.test(line)) {
        errors.push(`Line ${index + 1} contains a tool signature.`);
      }
    }

    for (const warning of warnings) console.error(`commit-msg warning: ${warning}`);
    for (const error of errors) console.error(`commit-msg error: ${error}`);
    if (errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`commit-msg error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
