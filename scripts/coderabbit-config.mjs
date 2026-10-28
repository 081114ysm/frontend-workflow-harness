import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function codeRabbitConfig(integrationBranch, defaultBranch) {
  const config = JSON.parse(fs.readFileSync(path.join(bundle, 'config/coderabbit.json'), 'utf8'));
  const escaped = integrationBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  config.reviews.auto_review.base_branches = integrationBranch === defaultBranch ? [] : [`^${escaped}$`];
  return config;
}

// JSON flow syntax is valid YAML. This keeps generation and validation dependency-free.
export function codeRabbitYaml(integrationBranch, defaultBranch) {
  return '# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json\n'
    + JSON.stringify(codeRabbitConfig(integrationBranch, defaultBranch), null, 2) + '\n';
}
