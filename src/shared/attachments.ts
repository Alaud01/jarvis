export interface FileAttachment {
  name: string;
  extension: string;
  size: number;
  content: string;
  truncated: boolean;
  kind?: 'text' | 'image';
  mimeType?: string;
  base64?: string;
}

export interface AttachmentSelectionResult {
  attachments: FileAttachment[];
  errors: string[];
}
