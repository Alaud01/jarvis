import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OfficeParser } from 'officeparser';
import type { AttachmentSelectionResult, FileAttachment } from '../shared/attachments';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 120_000;
const MAX_ATTACHMENTS_PER_PICK = 10;
const EXTRACTION_TIMEOUT_MS = 60_000;

const TEXT_EXTRACTION_PARSER_CONFIG = {
  extractAttachments: false,
  ocr: false,
} as const;

const OFFICE_EXTENSIONS = new Set([
  '.docx',
  '.xlsx',
  '.pptx',
  '.pdf',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml',
  '.html', '.css', '.scss', '.less', '.yaml', '.yml', '.toml', '.ini',
  '.env', '.log', '.sql', '.graphql', '.gql', '.sh', '.bash', '.zsh',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.php', '.vue', '.svelte', '.dockerfile', '.makefile',
]);

const TEXT_FILE_NAMES = new Set([
  'dockerfile',
  'makefile',
  '.env',
  '.gitignore',
  '.npmrc',
  '.editorconfig',
]);

export const ATTACHMENT_DIALOG_FILTERS = [
  {
    name: 'Supported files',
    extensions: [
      'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf',
      'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'css',
      'yaml', 'yml', 'toml', 'sql', 'js', 'jsx', 'ts', 'tsx', 'py',
      'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'sh',
    ],
  },
  { name: 'All files', extensions: ['*'] },
];

function truncateContent(content: string): Pick<FileAttachment, 'content' | 'truncated'> {
  if (content.length <= MAX_EXTRACTED_CHARS) {
    return { content, truncated: false };
  }

  return {
    content: `${content.slice(0, MAX_EXTRACTED_CHARS)}\n\n[Content truncated after ${MAX_EXTRACTED_CHARS.toLocaleString()} characters.]`,
    truncated: true,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function extractText(filePath: string, extension: string): Promise<string> {
  if (TEXT_EXTENSIONS.has(extension) || TEXT_FILE_NAMES.has(path.basename(filePath).toLowerCase())) {
    return fs.readFile(filePath, 'utf8');
  }

  if (OFFICE_EXTENSIONS.has(extension)) {
    const ast = await withTimeout(
      OfficeParser.parseOffice(filePath, TEXT_EXTRACTION_PARSER_CONFIG),
      EXTRACTION_TIMEOUT_MS,
      `Reading ${path.basename(filePath)} timed out. The file may be too large or complex.`,
    );
    return ast.toText();
  }

  throw new Error(`Unsupported file type: ${extension || 'unknown'}`);
}

async function readAttachment(filePath: string): Promise<FileAttachment> {
  const extension = path.extname(filePath).toLowerCase();
  const stat = await fs.stat(filePath);
  const name = path.basename(filePath);

  if (!stat.isFile()) {
    throw new Error('The selected item is not a file.');
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File is larger than the ${MAX_FILE_BYTES / (1024 * 1024)} MB upload limit.`);
  }

  const extracted = await extractText(filePath, extension);
  const { content, truncated } = truncateContent(extracted.trim());
  if (!content) {
    throw new Error('No readable text was extracted.');
  }

  return {
    name,
    extension,
    size: stat.size,
    content,
    truncated,
  };
}

export async function readAttachments(filePaths: string[]): Promise<AttachmentSelectionResult> {
  const selectedPaths = filePaths.slice(0, MAX_ATTACHMENTS_PER_PICK);
  const settled = await Promise.allSettled(selectedPaths.map(readAttachment));
  const attachments: FileAttachment[] = [];
  const errors: string[] = [];

  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      attachments.push(result.value);
      return;
    }

    const reason = result.reason instanceof Error ? result.reason.message : 'Unable to read file.';
    errors.push(`${path.basename(selectedPaths[index])}: ${reason}`);
  });

  if (filePaths.length > MAX_ATTACHMENTS_PER_PICK) {
    errors.push(`Only the first ${MAX_ATTACHMENTS_PER_PICK} selected files were attached.`);
  }

  return { attachments, errors };
}
