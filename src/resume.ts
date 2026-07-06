import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const rendererDir = path.join(projectRoot, 'renderer');

export function getBaseResume(): any {
  const resumePath = path.join(projectRoot, 'input', 'resume.json');
  return JSON.parse(readFileSync(resumePath, 'utf8'));
}

export async function renderResume(resumeJson: any): Promise<string> {
  const id = randomUUID();
  const outputDir = path.join(rendererDir, 'automation', id);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'resume.json'), JSON.stringify(resumeJson));

  await execFileAsync('node', ['index.js', id], { cwd: rendererDir });

  const pdfPath = path.join(outputDir, 'resume.pdf');
  if (!existsSync(pdfPath)) {
    throw new Error(`Expected PDF not found at ${pdfPath}`);
  }
  return pdfPath;
}
